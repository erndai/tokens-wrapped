// GitHub Copilot CLI: one event log per session at ${COPILOT_HOME:-~/.copilot}/session-state/<session>/events.jsonl,
// lines {type, id, timestamp, data}. Usage comes from two kinds of event:
//  - session.usage_record: one receipt per model call, data.usage {model, inputTokens, outputTokens,
//    cacheReadTokens, cacheWriteTokens, reasoningTokens, accounting:{sourceSessionId, sequence}} (some builds nest
//    the counts under usage.tokens). inputTokens already includes cache reads and writes; outputTokens already
//    includes reasoning. A receipt can be copied into several session files: each (sourceSessionId, sequence)
//    counts once.
//  - session.shutdown / session.usage_checkpoint: data.modelMetrics[model].usage, CUMULATIVE for the session.
//    Each snapshot's growth over the previous one is that interval's usage. They also total every receipted call,
//    so once a file has a receipt (or a snapshot whose usageAccountingWatermarks say receipts are inside it),
//    later snapshots are ignored. A session with no receipts is read from its snapshots alone.
// Prompts are user.message events; tools are tool.execution_start (data.toolName, data.arguments).

import { join, basename, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { emptyTally, addReply, addTool, addEdit, eachLine, safeJson, toDate, inWindow, num, touchedSince, localDay } from './tally.js';
import { safeDir, expandHome } from './walk.js';

export const id = 'copilot-cli';
export const NAME = 'Copilot CLI';

export function root({ home, env = {} }) {
  return join(env.COPILOT_HOME ? expandHome(env.COPILOT_HOME, home) : join(home, '.copilot'), 'session-state');
}

export function files({ home, env, since }) {
  const dir = root({ home, env });
  if (!existsSync(dir)) return [];
  const out = [];
  for (const s of safeDir(dir)) {
    const p = join(dir, s, 'events.jsonl');
    if (touchedSince(p, since)) out.push(p);
  }
  return out;
}

// Internal context-window suffixes (claude-sonnet-4.6-1m, -1m-internal) name the same model.
export const cleanModel = (m) => (m ? String(m).replace(/-1m(-internal)?$/, '').replace(/-internal$/, '') : null);

function tokensOf(src) {
  const cached = num(src.cacheReadTokens);
  const cacheWrite = num(src.cacheWriteTokens);
  const output = num(src.outputTokens);
  return {
    input: Math.max(num(src.inputTokens), cached + cacheWrite),
    cached,
    cacheWrite,
    output,
    reasoning: Math.min(num(src.reasoningTokens), output),
  };
}

// One interval stands for `count` calls: addReply counts one, the rest are added to the same day and hour.
function addCalls(t, when, count) {
  const extra = count - 1;
  if (extra <= 0) return;
  t.replies += extra;
  const day = localDay(when);
  t.dayActivity.set(day, (t.dayActivity.get(day) || 0) + extra);
  t.hours[when.getHours()] += extra;
}

const ZERO = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const KEYS = Object.keys(ZERO);

export function sessionReader(t, win, file, receipts) {
  let session = basename(dirname(file));
  let cwd = null;
  let receipted = false;
  const prev = new Map(); // model -> last snapshot { usage, count }
  let touched = false;
  const step = (line) => {
    const o = safeJson(line);
    if (!o || typeof o.type !== 'string') return;
    const d = o.data && typeof o.data === 'object' ? o.data : {};
    const when = toDate(o.timestamp);
    if (o.type === 'session.start') {
      if (d.sessionId) session = String(d.sessionId);
      cwd = d.context?.cwd || d.cwd || cwd;
      return;
    }
    if (o.type === 'session.usage_record') {
      receipted = true;
      const u = d.usage && typeof d.usage === 'object' ? d.usage : null;
      if (!u) return;
      const acc = u.accounting || {};
      const key = acc.sourceSessionId && num(acc.sequence) > 0 ? `${acc.sourceSessionId}#${acc.sequence}` : `${session}@${o.id}`;
      if (receipts.has(key)) return;
      receipts.add(key);
      if (!inWindow(when, win)) return;
      addReply(t, { when, model: cleanModel(u.model), ...tokensOf(u.tokens && typeof u.tokens === 'object' ? u.tokens : u), session });
      touched = true;
      return;
    }
    if (o.type === 'session.shutdown' || o.type === 'session.usage_checkpoint') {
      const marks = d.usageAccountingWatermarks;
      if (marks && typeof marks === 'object' && Object.values(marks).some((v) => num(v) > 0)) receipted = true;
      if (receipted || !d.modelMetrics || typeof d.modelMetrics !== 'object') return;
      for (const [rawModel, mm] of Object.entries(d.modelMetrics)) {
        const cur = mm?.usage && typeof mm.usage === 'object' ? mm.usage : null;
        if (!cur) continue;
        const model = cleanModel(rawModel);
        const count = num(mm.requests?.count);
        const p = prev.get(model) || { usage: ZERO, count: 0 };
        prev.set(model, { usage: cur, count });
        // A snapshot smaller than the last one started over: take it whole.
        const reset = KEYS.some((k) => num(cur[k]) < num(p.usage[k]));
        const base = reset ? ZERO : p.usage;
        const delta = Object.fromEntries(KEYS.map((k) => [k, num(cur[k]) - num(base[k])]));
        const calls = reset ? count : count - p.count;
        if (!inWindow(when, win) || (!delta.inputTokens && !delta.outputTokens)) continue;
        addReply(t, { when, model, ...tokensOf(delta), session });
        addCalls(t, when, calls);
        touched = true;
      }
      return;
    }
    if (!inWindow(when, win)) return;
    if (o.type === 'user.message') {
      t.prompts++;
      touched = true;
    } else if (o.type === 'tool.execution_start') {
      const name = d.toolName || d.name;
      addTool(t, name);
      touched = true;
      let a = d.arguments;
      if (typeof a === 'string') a = safeJson(a);
      if (!a || typeof a !== 'object') return;
      if (name === 'create') addEdit(t, a.path, a.file_text);
      else if (name === 'edit' || name === 'str_replace') addEdit(t, a.path, a.new_str);
      else if (name === 'write') addEdit(t, a.path, a.content);
    }
  };
  step.done = () => {
    if (touched && cwd) t.projects.add(cwd);
  };
  return step;
}

export async function read({ home, env, win, progress = () => {} }) {
  const list = files({ home, env, since: win.start }).sort();
  if (!list.length) return null;
  const t = emptyTally(id, NAME);
  const receipts = new Set();
  let i = 0;
  for (const f of list) {
    if (++i % 200 === 0) progress(`${NAME}: ${i} of ${list.length} sessions`);
    const step = sessionReader(t, win, f, receipts);
    try {
      await eachLine(f, step);
    } catch {
      /* unreadable file: skip */
    }
    step.done();
  }
  return t.replies || t.prompts ? t : null;
}
