// Pi (badlogic/pi-mono coding agent): one JSONL file per session at
// ${PI_CODING_AGENT_DIR:-~/.pi/agent}/sessions/<cwd-slug>/<timestamp>_<id>.jsonl, or under
// $PI_CODING_AGENT_SESSION_DIR when set. The first line is a header {type:"session", id, cwd}; then entries
// {type:"message", id, timestamp, message:{role, model, responseId, usage, content}}.
// Usage (packages/ai/src/types.ts): input EXCLUDES cacheRead/cacheWrite; reasoning is a subset of output;
// cost.total is Pi's own figure. Forks and branches copy entries verbatim (same id and timestamp) into a new
// file, so a reply is counted once per responseId, else once per entry id + timestamp, across all files.
// pi-subagents writes duplicate debug transcripts under subagent-artifacts/; those are skipped.

import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { emptyTally, addReply, addPrompt, addTool, addEdit, eachLine, safeJson, toDate, inWindow, num } from './tally.js';
import { walk, expandHome } from './walk.js';

export const id = 'pi';
export const NAME = 'Pi';

export function roots({ home, env = {} }) {
  const list = [];
  if (env.PI_CODING_AGENT_SESSION_DIR) list.push(expandHome(env.PI_CODING_AGENT_SESSION_DIR, home));
  const agentDir = env.PI_CODING_AGENT_DIR ? expandHome(env.PI_CODING_AGENT_DIR, home) : join(home, '.pi', 'agent');
  list.push(join(agentDir, 'sessions'));
  return [...new Set(list)].filter((p) => existsSync(p));
}

export function files({ home, env, since }) {
  const out = [];
  for (const r of roots({ home, env })) walk(r, (n) => n.endsWith('.jsonl'), { since, skipDir: (n) => n === 'subagent-artifacts' }, out);
  return [...new Set(out)];
}

function editTexts(args) {
  let edits = args.edits;
  if (typeof edits === 'string') edits = safeJson(edits); // some models send the array as a JSON string
  if (edits && !Array.isArray(edits) && typeof edits === 'object') edits = [edits];
  if (!Array.isArray(edits)) edits = typeof args.newText === 'string' ? [{ newText: args.newText }] : [];
  return edits.map((e) => e?.newText).filter((s) => typeof s === 'string');
}

const WANT = /"type":"(session|message)"/;

// Per-file reader: header first, then entries. `seen` is shared across files for fork dedupe.
export function sessionReader(t, win, file, seen) {
  let session = basename(file, '.jsonl');
  let cwd = null;
  const step = (line) => {
    if (!WANT.test(line)) return;
    const o = safeJson(line);
    if (!o) return;
    if (o.type === 'session') {
      if (o.id) session = String(o.id);
      if (typeof o.cwd === 'string') cwd = o.cwd;
      return;
    }
    if (o.type !== 'message' || !o.message || typeof o.message !== 'object') return;
    const m = o.message;
    const when = toDate(o.timestamp) || toDate(m.timestamp);
    if (!inWindow(when, win)) return;
    const entryKey = o.id ? `e:${o.id}|${o.timestamp}` : null;
    if (entryKey && seen.has(entryKey)) return; // a fork's copy of an entry already counted
    if (m.role === 'user') {
      if (entryKey) seen.add(entryKey);
      addPrompt(t, session, when);
      if (cwd) t.projects.add(cwd);
      return;
    }
    if (m.role !== 'assistant') return;
    const replyKey = m.responseId ? `r:${m.responseId}` : null;
    if (replyKey && seen.has(replyKey)) return;
    if (entryKey) seen.add(entryKey);
    if (replyKey) seen.add(replyKey);
    for (const c of Array.isArray(m.content) ? m.content : []) {
      if (c?.type !== 'toolCall') continue;
      addTool(t, c.name, session);
      const a = c.arguments && typeof c.arguments === 'object' ? c.arguments : null;
      if (!a) continue;
      if (c.name === 'write') addEdit(t, a.path, a.content);
      else if (c.name === 'edit') {
        const texts = editTexts(a);
        if (!texts.length) addEdit(t, a.path, '');
        for (const s of texts) addEdit(t, a.path, s);
      }
    }
    const u = m.usage;
    if (!u || typeof u !== 'object') return;
    const read = num(u.cacheRead);
    const write = num(u.cacheWrite);
    const input = num(u.input) + read + write;
    let output = num(u.output);
    const total = num(u.totalTokens);
    if (!output && total > input) output = total - input; // providers that only report a total
    if (!input && !output) return; // errored or aborted calls carry all-zero usage
    addReply(t, {
      when,
      model: m.model || null,
      input,
      cached: read,
      cacheWrite: write,
      cacheWrite1h: num(u.cacheWrite1h),
      output,
      reasoning: Math.min(num(u.reasoning), output),
      session,
    });
    t.cost += num(u.cost?.total);
    if (cwd) t.projects.add(cwd);
  };
  return step;
}

export async function read({ home, env, win, progress = () => {} }) {
  // Names start with the creation time, so oldest first: the original session keeps the reply, not its fork.
  const list = files({ home, env, since: win.start }).sort((a, b) => (basename(a) < basename(b) ? -1 : basename(a) > basename(b) ? 1 : 0));
  if (!list.length) return null;
  const t = emptyTally(id, NAME);
  const seen = new Set();
  let i = 0;
  for (const f of list) {
    if (++i % 10 === 0) {
      progress(`${NAME}: ${i} of ${list.length} sessions`, { i, n: list.length, t });
      await new Promise((r) => setImmediate(r)); // let the loading screen draw
    }
    try {
      await eachLine(f, sessionReader(t, win, f, seen), { match: ['"type":"session"', '"type":"message"'] });
    } catch {
      /* unreadable file: skip */
    }
  }
  return t.replies || t.prompts ? t : null;
}
