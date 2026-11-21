// Claude Code: one JSONL transcript per session under <config>/projects/<project>/<session>.jsonl.
// Config dir: $CLAUDE_CONFIG_DIR (comma-separated list allowed), else ~/.claude and ~/.config/claude.
// Each assistant reply can span several lines (one per content block) that repeat the same usage, so usage is
// counted once per message.id + requestId; the first line carries a partial output count, so a later line's larger
// count adds the difference. Tool calls are one per content block, so each block is counted.
// Claude Code deletes transcripts older than cleanupPeriodDays (30 by default), so older days may be missing.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyTally, addReply, addOutput, addPrompt, addTool, addEdit, eachLine, safeJson, toDate, inWindow, num } from './tally.js';
import { walk } from './walk.js';
import { readSplit, groupBy } from './pool.js';

export const id = 'claude-code';
export const NAME = 'Claude Code';

export function roots({ home, env = {} }) {
  const list = env.CLAUDE_CONFIG_DIR ? String(env.CLAUDE_CONFIG_DIR).split(',').map((s) => s.trim()).filter(Boolean) : [];
  list.push(join(home, '.claude'), join(home, '.config', 'claude'));
  return [...new Set(list)].map((r) => join(r, 'projects')).filter((p) => existsSync(p));
}

// Every transcript, including subagents' (<session>/subagents/agent-*.jsonl, and workflow agents one level down
// in subagents/workflows/<run>/), which hold replies of their own. A workflow's journal.jsonl is not a transcript.
export function files({ home, env, since }) {
  const out = [];
  for (const root of roots({ home, env })) walk(root, (n) => n.endsWith('.jsonl') && n !== 'journal.jsonl', { since, depth: 6 }, out);
  return out;
}

// Lines that can't matter are skipped before parsing: most of a transcript is text and tool output.
const WANT = /"type":"(assistant|user)"/;

// A resumed session's file starts with a copy of the earlier conversation, so a line can appear in several files
// (a quarter of all lines, on one heavy user's machine). Each line is counted once, by its uuid; copies stay within
// one project folder, so `uuids` is kept per project.
export function addLine(t, line, win, seen, uuids = new Set()) {
  if (!WANT.test(line)) return;
  const o = safeJson(line);
  if (!o) return;
  if (o.uuid) {
    if (uuids.has(o.uuid)) return;
    uuids.add(o.uuid);
  }
  const when = toDate(o.timestamp);
  if (!inWindow(when, win)) return;
  const m = o.message && typeof o.message === 'object' ? o.message : null;
  if (o.type === 'user') {
    // A typed prompt has string content; tool results come back as user lines with array content.
    if (m && typeof m.content === 'string' && !o.isSidechain && !o.isMeta) addPrompt(t, o.sessionId, when);
    return;
  }
  if (o.type !== 'assistant' || !m) return;
  for (const c of Array.isArray(m.content) ? m.content : []) {
    if (c?.type !== 'tool_use') continue;
    addTool(t, c.name, o.isSidechain ? null : o.sessionId);
    const inp = c.input || {};
    if (c.name === 'Write') addEdit(t, inp.file_path, inp.content);
    else if (c.name === 'Edit') addEdit(t, inp.file_path, inp.new_string);
    else if (c.name === 'MultiEdit') for (const e of inp.edits || []) addEdit(t, inp.file_path, e?.new_string);
    else if (c.name === 'NotebookEdit') addEdit(t, inp.notebook_path, inp.new_source);
  }
  const u = m.usage;
  if (!u || typeof u !== 'object' || m.model === '<synthetic>') return;
  const key = `${m.id}:${o.requestId}`;
  const out = num(u.output_tokens);
  const think = num(u.output_tokens_details?.thinking_tokens);
  const before = seen.get(key);
  if (before) {
    if (out > before.out) addOutput(t, { when, model: m.model, output: out - before.out, reasoning: Math.max(0, think - before.think) });
    before.out = Math.max(before.out, out);
    before.think = Math.max(before.think, think);
    return;
  }
  seen.set(key, { out, think });
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
    lane: o.agentId ? `${o.sessionId}/${o.agentId}` : o.sessionId, // a subagent is an agent of its own
  });
  t.webSearches += num(u.server_tool_use?.web_search_requests);
  if (o.cwd) t.projects.add(o.cwd);
}

// The project folder a transcript belongs to: copies of a line never leave it.
export function projectOf(file) {
  const parts = String(file).split(/[\\/]projects[\\/]/);
  return parts.length > 1 ? parts[parts.length - 1].split(/[\\/]/)[0] : file;
}

// Reads one batch of whole project folders. tick(i, t) after every few files. Runs inline or on a worker thread.
export async function readList(list, win, tick = () => {}) {
  const t = emptyTally(id, NAME);
  const groups = new Map();
  for (const f of list) {
    const p = projectOf(f);
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p).push(f);
  }
  let i = 0;
  for (const group of groups.values()) {
    const seen = new Map();
    const uuids = new Set();
    for (const f of group) {
      if (++i % 10 === 0) await tick(i, t);
      try {
        await eachLine(f, (line) => addLine(t, line, win, seen, uuids), { match: ['"type":"assistant"', '"type":"user"'] });
      } catch {
        /* unreadable file: skip */
      }
    }
  }
  return t;
}

// Claude Code deletes transcripts older than cleanupPeriodDays (30 unless changed in settings.json). When the
// logs start inside that window, the year is cut short: say so, and how to keep more.
export function keepDays({ home, env = {} }) {
  const dirs = env.CLAUDE_CONFIG_DIR ? String(env.CLAUDE_CONFIG_DIR).split(',').map((s) => s.trim()) : [join(home, '.claude')];
  for (const d of dirs) {
    try {
      const v = JSON.parse(readFileSync(join(d, 'settings.json'), 'utf8')).cleanupPeriodDays;
      if (Number.isFinite(Number(v)) && Number(v) > 0) return Number(v);
    } catch {
      /* no settings: the default */
    }
  }
  return 30;
}

export function trimmedNote(t, { home, env, win }) {
  const first = [...t.dayActivity.keys()].sort()[0];
  if (!first) return null;
  const keep = keepDays({ home, env });
  const start = new Date(`${first}T12:00:00`);
  const cutoff = new Date(win.end.getTime() - (keep + 2) * 86400000);
  if (cutoff <= win.start || start < cutoff) return null; // keeps the whole year, or logs go back further
  return `Claude Code keeps ${keep} days of logs${keep === 30 ? ' by default' : ''}, so its numbers start ${first}. To keep more next time, set "cleanupPeriodDays" in ~/.claude/settings.json.`;
}

export async function read({ home, env, win, progress = () => {} }) {
  const list = files({ home, env, since: win.start });
  if (!list.length) return null;
  const units = groupBy(list, projectOf);
  const t = await readSplit({ reader: import.meta.url, units, win, name: NAME, unit: 'sessions', progress, empty: () => emptyTally(id, NAME) });
  const note = trimmedNote(t, { home, env, win });
  if (note) t.notes.push(note);
  return t.replies || t.prompts ? t : null;
}
