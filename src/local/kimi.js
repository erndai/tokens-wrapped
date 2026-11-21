// Kimi CLI (MoonshotAI/kimi-cli): one wire.jsonl per session at ${KIMI_SHARE_DIR:-~/.kimi}/sessions/<workdir>/<session>/,
// and Kimi Code's ~/.kimi-code/sessions/<workdir>/<session>/agents/<agent>/wire.jsonl. Two record shapes:
//  - newer: {type:"usage.record", usageScope:"turn"|..., model, usage:{inputOther, output, inputCacheRead,
//    inputCacheCreation}, time (ms)}. Only usageScope "turn" counts (other scopes re-total the same calls).
//  - legacy (kimi_cli/wire/file.py): {timestamp (seconds), message:{type, payload}}. StatusUpdate payloads carry the
//    step's token_usage {input_other, output, input_cache_read, input_cache_creation, total?} and message_id;
//    TurnBegin is a typed prompt; ToolCall is a tool call {function:{name}}. The model is not in the record: it comes
//    from the root's config (config.toml default_model, or the older config.json), else Kimi's default.
// input = other + cache read + cache creation. Repeats (same session, message id or time, model and counts) count once.

import { join, relative, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { emptyTally, addReply, addTool, eachLine, safeJson, toDate, inWindow, num } from './tally.js';
import { walk, safeRead, expandHome } from './walk.js';

export const id = 'kimi-cli';
export const NAME = 'Kimi CLI';

const DEFAULT_MODEL = 'kimi-for-coding';

export function roots({ home, env = {} }) {
  const list = [env.KIMI_SHARE_DIR ? expandHome(env.KIMI_SHARE_DIR, home) : join(home, '.kimi'), join(home, '.kimi-code')];
  return [...new Set(list)].filter((p) => existsSync(join(p, 'sessions')));
}

// The default model a root's config names. Only that one value is read from the config.
export function configModel(root) {
  const toml = safeRead(join(root, 'config.toml'));
  const m = /^\s*default_model\s*=\s*["']([^"']+)["']/m.exec(toml);
  if (m) return m[1];
  const json = safeJson(safeRead(join(root, 'config.json')));
  const v = json?.default_model || json?.model;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// <workdir>/<session>/wire.jsonl or <workdir>/<session>/agents/<agent>/wire.jsonl under sessions/.
export function files({ home, env, since }) {
  const out = [];
  for (const root of roots({ home, env })) {
    const sessions = join(root, 'sessions');
    for (const f of walk(sessions, (n) => n === 'wire.jsonl', { since, depth: 4 })) {
      const parts = relative(sessions, f).split(sep);
      if (parts.length === 3 || (parts.length === 5 && parts[2] === 'agents')) {
        out.push({ file: f, root, workdir: parts[0], session: parts[1] });
      }
    }
  }
  return out;
}

const cleanModel = (m) => (typeof m === 'string' && m.trim() ? m.trim().replace(/^kimi-code\//, '') : null);

function addUsage(t, seen, { when, model, session, msgId, u, other, read, creation, out, total }) {
  const input = num(u[other]) + num(u[read]) + num(u[creation]);
  let output = num(u[out]);
  if (!output && total && num(u[total]) > input) output = num(u[total]) - input;
  if (!input && !output) return false;
  const key = [session, msgId || '', when.getTime(), model, input, output, num(u[read]), num(u[creation])].join('|');
  if (seen.has(key)) return false;
  seen.add(key);
  addReply(t, { when, model, input, cached: num(u[read]), cacheWrite: num(u[creation]), output, session });
  return true;
}

export function wireReader(t, win, { session, workdir, model: fallbackModel }, seen) {
  let touched = false;
  const step = (line) => {
    if (!/"(usage\.record|StatusUpdate|TurnBegin|ToolCall)"/.test(line)) return;
    const o = safeJson(line);
    if (!o || typeof o !== 'object') return;
    if (o.type === 'usage.record') {
      if (o.usageScope !== 'turn' || !o.usage || typeof o.usage !== 'object') return;
      const when = toDate(o.time);
      if (!inWindow(when, win)) return;
      const model = cleanModel(o.model) || fallbackModel;
      if (addUsage(t, seen, { when, model, session, u: o.usage, other: 'inputOther', read: 'inputCacheRead', creation: 'inputCacheCreation', out: 'output' })) touched = true;
      return;
    }
    const msg = o.message;
    if (!msg || typeof msg !== 'object') return;
    const when = toDate(o.timestamp);
    if (!inWindow(when, win)) return;
    const p = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
    if (msg.type === 'StatusUpdate') {
      const u = p.token_usage;
      if (!u || typeof u !== 'object') return;
      const model = cleanModel(p.model) || fallbackModel;
      const args = { when, model, session, msgId: p.message_id, u, other: 'input_other', read: 'input_cache_read', creation: 'input_cache_creation', out: 'output', total: 'total' };
      if (addUsage(t, seen, args)) touched = true;
    } else if (msg.type === 'TurnBegin') {
      t.prompts++;
      touched = true;
    } else if (msg.type === 'ToolCall') {
      addTool(t, p.function?.name || p.name);
      touched = true;
    }
  };
  step.done = () => {
    if (touched) t.projects.add(workdir);
  };
  return step;
}

export async function read({ home, env, win, progress = () => {} }) {
  const list = files({ home, env, since: win.start });
  if (!list.length) return null;
  const t = emptyTally(id, NAME);
  const seen = new Set();
  const models = new Map();
  let i = 0;
  for (const w of list) {
    if (++i % 200 === 0) progress(`${NAME}: ${i} of ${list.length} sessions`);
    if (!models.has(w.root)) models.set(w.root, cleanModel(configModel(w.root)) || DEFAULT_MODEL);
    const step = wireReader(t, win, { ...w, model: models.get(w.root) }, seen);
    try {
      await eachLine(w.file, step);
    } catch {
      /* unreadable file: skip */
    }
    step.done();
  }
  return t.replies || t.prompts ? t : null;
}
