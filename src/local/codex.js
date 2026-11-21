// Codex CLI: one JSONL rollout per session under $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl (~/.codex).
// token_count events carry the session's running total (info.total_token_usage). Each event's growth over the
// previous total is that turn's usage, dated at the event. OpenAI counts: input_tokens already includes
// cached_input_tokens; output_tokens already includes reasoning_output_tokens. Model: latest turn_context.

import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { emptyTally, addReply, addTool, addEdit, eachLine, touchedSince, safeJson, toDate, inWindow, num } from './tally.js';

export const id = 'codex';
export const NAME = 'Codex';

export function root({ home, env = {} }) {
  return join(env.CODEX_HOME || join(home, '.codex'), 'sessions');
}

function walk(dir, out, since) {
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out, since);
    else if (e.name.endsWith('.jsonl') && touchedSince(p, since)) out.push(p);
  }
}

// apply_patch input: count added lines and the files named in the patch headers.
export function addPatch(t, patch) {
  if (typeof patch !== 'string') return;
  let file = null;
  for (const l of patch.split('\n')) {
    if (/^\*\*\* End Patch/.test(l)) {
      file = null;
      continue;
    }
    const h = /^\*\*\* (?:Add|Update) File: (.+)$/.exec(l);
    if (h) {
      file = h[1].trim();
      addEdit(t, file, '');
      continue;
    }
    if (file && l.startsWith('+') && !l.startsWith('+++')) t.lines++;
  }
}

// A per-session reader: feed it lines in order. Returns step(line); step.touched says whether it counted anything.
export function sessionReader(t, win, sessionId) {
  let model = null;
  let prev = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
  const step = (line) => {
    if (!/"(token_count|turn_context|user_message|function_call|custom_tool_call)"/.test(line)) return;
    const o = safeJson(line);
    if (!o) return;
    const p = o.payload && typeof o.payload === 'object' ? o.payload : {};
    const when = toDate(o.timestamp);
    if (o.type === 'turn_context') {
      model = p.model || model;
      if (p.cwd && inWindow(when, win)) t.projects.add(p.cwd); // counted, never shown
      return;
    }
    if (!inWindow(when, win)) {
      if (p.type === 'token_count' && p.info?.total_token_usage) prev = p.info.total_token_usage; // keep the running base
      return;
    }
    if (p.type === 'user_message') {
      t.prompts++;
      step.touched = true;
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      addTool(t, p.name);
      // Patches arrive through apply_patch or inside a shell/exec command; either way the text has a patch block.
      const text = typeof p.input === 'string' ? p.input : typeof p.arguments === 'string' ? p.arguments : '';
      // Inside exec the patch is a quoted string in code, so its line breaks are written as \n.
      if (text.includes('*** Begin Patch')) addPatch(t, text.replace(/\\n/g, '\n'));
      step.touched = true;
    } else if (p.type === 'token_count' && p.info?.total_token_usage) {
      const cur = p.info.total_token_usage;
      const d = (k) => Math.max(0, num(cur[k]) - num(prev[k]));
      const delta = {
        input: d('input_tokens'),
        cached: d('cached_input_tokens'),
        cacheWrite: d('cache_write_input_tokens'),
        output: d('output_tokens'),
        reasoning: d('reasoning_output_tokens'),
      };
      prev = cur; // only after every difference is taken
      if (!delta.input && !delta.output) return; // the same total repeated
      addReply(t, { when, model, ...delta, session: sessionId });
      step.touched = true;
    }
  };
  step.touched = false;
  return step;
}

export async function read({ home, env, win, progress = () => {} }) {
  const dir = root({ home, env });
  if (!existsSync(dir)) return null;
  const list = [];
  walk(dir, list, win.start);
  if (!list.length) return null;
  const t = emptyTally(id, NAME);
  let i = 0;
  for (const f of list) {
    if (++i % 10 === 0) {
      progress(`${NAME}: ${i} of ${list.length} sessions`, { i, n: list.length, t });
      await new Promise((r) => setImmediate(r)); // let the loading screen draw
    }
    const step = sessionReader(t, win, f);
    try {
      await eachLine(f, step);
    } catch {
      /* unreadable file: skip */
    }
  }
  return t.replies || t.prompts ? t : null;
}
