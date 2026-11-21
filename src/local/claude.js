// Claude Code: one JSONL transcript per session under <config>/projects/<project>/<session>.jsonl.
// Config dir: $CLAUDE_CONFIG_DIR (comma-separated list allowed), else ~/.claude and ~/.config/claude.
// Each assistant reply can span several lines (one per content block) that repeat the same usage, so usage is
// counted once per message.id + requestId. Tool calls are one per content block, so each block is counted.
// Claude Code deletes transcripts older than cleanupPeriodDays (30 by default), so older days may be missing.

import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { emptyTally, addReply, addTool, addEdit, eachLine, touchedSince, safeJson, toDate, inWindow, num } from './tally.js';

export const id = 'claude-code';
export const NAME = 'Claude Code';

export function roots({ home, env = {} }) {
  const list = env.CLAUDE_CONFIG_DIR ? String(env.CLAUDE_CONFIG_DIR).split(',').map((s) => s.trim()).filter(Boolean) : [];
  list.push(join(home, '.claude'), join(home, '.config', 'claude'));
  return [...new Set(list)].map((r) => join(r, 'projects')).filter((p) => existsSync(p));
}

export function files({ home, env, since }) {
  const out = [];
  for (const root of roots({ home, env })) {
    for (const proj of safeDir(root)) {
      const dir = join(root, proj);
      for (const f of safeDir(dir)) if (f.endsWith('.jsonl') && touchedSince(join(dir, f), since)) out.push(join(dir, f));
    }
  }
  return out;
}

function safeDir(d) {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
}

// Lines that can't matter are skipped before parsing: most of a transcript is text and tool output.
const WANT = /"type":"(assistant|user)"/;

export function addLine(t, line, win, seen) {
  if (!WANT.test(line)) return;
  const o = safeJson(line);
  if (!o) return;
  const when = toDate(o.timestamp);
  if (!inWindow(when, win)) return;
  const m = o.message && typeof o.message === 'object' ? o.message : null;
  if (o.type === 'user') {
    // A typed prompt has string content; tool results come back as user lines with array content.
    if (m && typeof m.content === 'string' && !o.isSidechain && !o.isMeta) t.prompts++;
    return;
  }
  if (o.type !== 'assistant' || !m) return;
  for (const c of Array.isArray(m.content) ? m.content : []) {
    if (c?.type !== 'tool_use') continue;
    addTool(t, c.name);
    const inp = c.input || {};
    if (c.name === 'Write') addEdit(t, inp.file_path, inp.content);
    else if (c.name === 'Edit') addEdit(t, inp.file_path, inp.new_string);
    else if (c.name === 'MultiEdit') for (const e of inp.edits || []) addEdit(t, inp.file_path, e?.new_string);
    else if (c.name === 'NotebookEdit') addEdit(t, inp.notebook_path, inp.new_source);
  }
  const u = m.usage;
  if (!u || typeof u !== 'object' || m.model === '<synthetic>') return;
  const key = `${m.id}:${o.requestId}`;
  if (seen.has(key)) return;
  seen.add(key);
  const read = num(u.cache_read_input_tokens);
  const write = num(u.cache_creation_input_tokens);
  addReply(t, {
    when,
    model: m.model,
    input: num(u.input_tokens) + read + write,
    cached: read,
    cacheWrite: write,
    output: num(u.output_tokens),
    cacheWrite1h: num(u.cache_creation?.ephemeral_1h_input_tokens),
    reasoning: num(u.output_tokens_details?.thinking_tokens),
    session: o.sessionId,
  });
  t.webSearches += num(u.server_tool_use?.web_search_requests);
  if (o.cwd) t.projects.add(o.cwd);
}

export async function read({ home, env, win, progress = () => {} }) {
  const list = files({ home, env, since: win.start });
  if (!list.length) return null;
  const t = emptyTally(id, NAME);
  const seen = new Set();
  let i = 0;
  for (const f of list) {
    if (++i % 200 === 0) progress(`${NAME}: ${i} of ${list.length} sessions`);
    try {
      await eachLine(f, (line) => addLine(t, line, win, seen));
    } catch {
      /* unreadable file: skip */
    }
  }
  return t.replies || t.prompts ? t : null;
}
