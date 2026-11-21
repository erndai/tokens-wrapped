// Qwen Code: chats at <base>/projects/<project>/chats/*.jsonl, and chats/archive/*.jsonl for archived sessions.
// <base> is $QWEN_RUNTIME_DIR, else $QWEN_HOME, else ~/.qwen (packages/core/src/config/storage.ts); both the
// runtime base and the home base are scanned. Records (chatRecordingService.ts): {uuid, sessionId, timestamp,
// type:'user'|'assistant'|'tool_result'|'system', subtype?, cwd, model, message:{parts}, usageMetadata}.
// usageMetadata: promptTokenCount includes cachedContentTokenCount; output including thinking is
// totalTokenCount - promptTokenCount (thoughts are not added again), else candidates + thoughts.
// A record archived and still live counts once: dedupe on uuid across every file.

import { join, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { emptyTally, addReply, addTool, addEdit, eachLine, safeJson, toDate, inWindow, num, touchedSince } from './tally.js';
import { safeDir, expandHome, isDir } from './walk.js';

export const id = 'qwen-code';
export const NAME = 'Qwen Code';

export function bases({ home, env = {} }) {
  const list = [];
  if (env.QWEN_RUNTIME_DIR) list.push(expandHome(env.QWEN_RUNTIME_DIR, home));
  list.push(env.QWEN_HOME ? expandHome(env.QWEN_HOME, home) : join(home, '.qwen'));
  return [...new Set(list)].filter((p) => existsSync(join(p, 'projects')));
}

export function files({ home, env, since }) {
  const out = [];
  for (const base of bases({ home, env })) {
    const projects = join(base, 'projects');
    for (const proj of safeDir(projects)) {
      for (const dir of [join(projects, proj, 'chats'), join(projects, proj, 'chats', 'archive')]) {
        if (!isDir(dir)) continue;
        for (const f of safeDir(dir)) {
          const p = join(dir, f);
          if (f.endsWith('.jsonl') && touchedSince(p, since)) out.push(p);
        }
      }
    }
  }
  return [...new Set(out)];
}

export function tokensOf(u) {
  const prompt = num(u.promptTokenCount);
  const cached = Math.min(num(u.cachedContentTokenCount), prompt);
  const thoughts = num(u.thoughtsTokenCount);
  const total = num(u.totalTokenCount);
  const output = total > 0 ? Math.max(0, total - prompt) : num(u.candidatesTokenCount) + thoughts;
  return { input: prompt, cached, output, reasoning: Math.min(thoughts, output) };
}

const WANT = /"type":"(user|assistant)"/;

export function addLine(t, line, win, seen, fallbackSession) {
  if (!WANT.test(line)) return;
  const o = safeJson(line);
  if (!o || (o.type !== 'user' && o.type !== 'assistant')) return;
  const when = toDate(o.timestamp);
  if (!inWindow(when, win)) return;
  if (o.uuid) {
    if (seen.has(o.uuid)) return;
    seen.add(o.uuid);
  }
  const session = o.sessionId || fallbackSession;
  if (o.type === 'user') {
    // Typed prompts carry no subtype; notifications, slash commands and agent messages do.
    if (o.subtype === undefined) t.prompts++;
    return;
  }
  for (const p of Array.isArray(o.message?.parts) ? o.message.parts : []) {
    const fc = p?.functionCall;
    if (!fc) continue;
    addTool(t, fc.name);
    const a = fc.args && typeof fc.args === 'object' ? fc.args : {};
    if (fc.name === 'write_file') addEdit(t, a.file_path, a.content);
    else if (fc.name === 'edit' || fc.name === 'replace') addEdit(t, a.file_path, a.new_string);
  }
  const u = o.usageMetadata;
  if (!u || typeof u !== 'object') return;
  const tk = tokensOf(u);
  if (!tk.input && !tk.output) return;
  addReply(t, { when, model: o.model || o.executionContext?.modelId || null, ...tk, session });
  if (o.cwd) t.projects.add(o.cwd);
}

export async function read({ home, env, win, progress = () => {} }) {
  const list = files({ home, env, since: win.start });
  if (!list.length) return null;
  const t = emptyTally(id, NAME);
  const seen = new Set();
  let i = 0;
  for (const f of list) {
    if (++i % 10 === 0) {
      progress(`${NAME}: ${i} of ${list.length} chats`, { i, n: list.length, t });
      await new Promise((r) => setImmediate(r)); // let the loading screen draw
    }
    const fallback = basename(f, '.jsonl');
    try {
      await eachLine(f, (line) => addLine(t, line, win, seen, fallback));
    } catch {
      /* unreadable file: skip */
    }
  }
  return t.replies || t.prompts ? t : null;
}
