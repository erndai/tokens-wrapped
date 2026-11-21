// Gemini CLI: chats at ${GEMINI_CLI_HOME:-~}/.gemini/tmp/<project>/chats/session-*.jsonl (subagent chats in a
// <parent-session>/ subfolder), and older whole-file session-*.json documents with a messages array.
// The JSONL recorder (packages/core/src/services/chatRecordingService.ts) appends a message again whenever it
// changes (tokens arrive after the text), so the LAST copy per id wins. Control lines: {$set:{...}} updates
// metadata (and with `messages` replaces the whole list), {$patch:{...}} edits content, {$rewindTo:id} drops that
// message and everything after it. Message tokens: {input (prompt, includes cached), output (candidates), cached,
// thoughts, tool (tool-use prompt), total}; output here = output + thoughts. A legacy .json converted to .jsonl
// on resume keeps the same message ids, so each message id counts once per session across files.

import { join, basename, relative, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { emptyTally, addReply, addTool, addEdit, eachLine, safeJson, toDate, inWindow, num } from './tally.js';
import { walk, safeDir, safeRead, isDir } from './walk.js';

export const id = 'gemini-cli';
export const NAME = 'Gemini CLI';

export function root({ home, env = {} }) {
  return join(env.GEMINI_CLI_HOME || home, '.gemini', 'tmp');
}

export function files({ home, env, since }) {
  const dir = root({ home, env });
  if (!existsSync(dir)) return [];
  const out = [];
  for (const proj of safeDir(dir)) {
    const chats = join(dir, proj, 'chats');
    if (isDir(chats)) walk(chats, (n) => n.endsWith('.jsonl') || n.endsWith('.json'), { since, depth: 2 }, out);
  }
  return out;
}

const isMessage = (r) => r && typeof r === 'object' && typeof r.id === 'string' && !('$patch' in r);

// Only what we count is kept from a message: never its text.
function slim(m) {
  const calls = Array.isArray(m.toolCalls)
    ? m.toolCalls.map((c) => {
        const a = c?.args && typeof c.args === 'object' ? c.args : {};
        return { name: c?.name, status: c?.status, file_path: a.file_path, text: c?.name === 'replace' ? a.new_string : c?.name === 'write_file' ? a.content : undefined };
      })
    : [];
  return { id: m.id, type: m.type, timestamp: m.timestamp, model: m.model, tokens: m.tokens, toolCalls: calls };
}

// Replays a JSONL chat line by line into its final message list (insertion order kept, last copy wins).
// Returns step(line); step.result() gives { sessionId, messages }.
export function jsonlReplayer() {
  let sessionId = null;
  const msgs = new Map();
  const step = (line) => {
    const r = safeJson(line);
    if (!r || typeof r !== 'object') return;
    if (typeof r.$rewindTo === 'string') {
      let found = false;
      for (const k of [...msgs.keys()]) {
        if (k === r.$rewindTo) found = true;
        if (found) msgs.delete(k);
      }
      if (!found) msgs.clear(); // same as the recorder: an unknown rewind target clears the chat
    } else if (r.$patch && typeof r.$patch === 'object') {
      // Content and tool results only; nothing we count.
    } else if (isMessage(r)) {
      msgs.set(r.id, slim(r));
    } else if (r.$set && typeof r.$set === 'object') {
      if (Array.isArray(r.$set.messages)) {
        msgs.clear();
        for (const m of r.$set.messages) if (isMessage(m)) msgs.set(m.id, slim(m));
      }
      if (r.$set.sessionId) sessionId = r.$set.sessionId;
    } else {
      if (r.sessionId) sessionId = r.sessionId; // the header line
      if (Array.isArray(r.messages)) for (const m of r.messages) if (isMessage(m)) msgs.set(m.id, slim(m));
    }
  };
  step.result = () => ({ sessionId, messages: [...msgs.values()] });
  return step;
}

export function tokensOf(tk) {
  let input = num(tk.input);
  const cached = num(tk.cached);
  const thoughts = num(tk.thoughts);
  const tool = num(tk.tool);
  const out = num(tk.output);
  const total = tk.total == null ? null : num(tk.total);
  // Gemini's prompt count includes cached tokens. If the stored total only adds up with cached on top, this
  // record kept them apart: fold them in so input still includes cached.
  const inclusive = input + out + thoughts + tool;
  if (cached > 0 && total === inclusive + cached) input += cached;
  input += tool; // tool-use prompt tokens are billed as input
  return { input, cached: Math.min(cached, input), output: out + thoughts, reasoning: thoughts };
}

export function addMessages(t, messages, win, { session, project, seen }) {
  let touched = false;
  for (const m of messages) {
    const when = toDate(m.timestamp);
    if (!inWindow(when, win)) continue;
    const key = `${session}|${m.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (m.type === 'user') {
      t.prompts++;
      touched = true;
      continue;
    }
    if (m.type !== 'gemini') continue;
    for (const c of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
      addTool(t, c?.name);
      touched = true;
      if (c.status === 'error' || c.status === 'cancelled') continue;
      if (c.name === 'replace' || c.name === 'write_file') addEdit(t, c.file_path, c.text);
    }
    if (!m.tokens || typeof m.tokens !== 'object') continue;
    const tk = tokensOf(m.tokens);
    if (!tk.input && !tk.output) continue;
    addReply(t, { when, model: m.model || null, ...tk, session });
    touched = true;
  }
  if (touched && project) t.projects.add(project);
}

export async function read({ home, env, win, progress = () => {} }) {
  const list = files({ home, env, since: win.start });
  if (!list.length) return null;
  const dir = root({ home, env });
  const t = emptyTally(id, NAME);
  const seen = new Set();
  // .jsonl first: when a legacy .json and its converted .jsonl both exist, the .jsonl is the newer copy.
  list.sort((a, b) => (a.endsWith('.jsonl') === b.endsWith('.jsonl') ? 0 : a.endsWith('.jsonl') ? -1 : 1));
  let i = 0;
  for (const f of list) {
    if (++i % 10 === 0) {
      progress(`${NAME}: ${i} of ${list.length} chats`, { i, n: list.length, t });
      await new Promise((r) => setImmediate(r)); // let the loading screen draw
    }
    const project = relative(dir, f).split(sep)[0]; // the project folder name (a hash), counted only
    try {
      let chat;
      if (f.endsWith('.jsonl')) {
        const step = jsonlReplayer();
        await eachLine(f, step);
        chat = step.result();
      } else {
        const doc = safeJson(safeRead(f));
        if (!doc || !Array.isArray(doc.messages)) continue;
        chat = { sessionId: doc.sessionId, messages: doc.messages.filter(isMessage).map(slim) };
      }
      const session = String(chat.sessionId || basename(f).replace(/\.jsonl?$/, ''));
      addMessages(t, chat.messages, win, { session, project, seen });
    } catch {
      /* unreadable file: skip */
    }
  }
  return t.replies || t.prompts ? t : null;
}
