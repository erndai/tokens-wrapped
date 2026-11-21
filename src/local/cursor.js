// Cursor: chats live in <Cursor user dir>/globalStorage/state.vscdb, table cursorDiskKV(key, value JSON).
// Fast path: one composerData:<chatId> row per chat lists every message in fullConversationHeadersOnly as
// { type, createdAt? } (type 1 = typed by the person, 2 = assistant), plus the chat's model in modelConfig.modelName.
// That is about 1/40th of the data of the per-bubble rows (bubbleId:<chatId>:<id>), which can run to gigabytes.
// Each typed message counts as one prompt and one unit of activity. Assistant bubbles aren't counted as replies:
// newer Cursor splits one turn into dozens of bubbles, so that number would mostly measure Cursor's internals.
// Chats without headers (older Cursor) fall back to reading their bubbles.
// Cursor keeps no usable token counts locally (tokenCount is always zero), so tokens stay 0 and tokensKnown is
// false: the price estimate leaves Cursor out. AI-written lines come from ~/.cursor/ai-tracking/ai-code-tracking.db,
// table scored_commits (composerLinesAdded + tabLinesAdded per commit, scoredAt in ms).
// No message text is ever selected: SQL pulls only types, dates, model and tool names.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { emptyTally, addReply, addTool, toDate, inWindow, num, safeJson } from './tally.js';
import { openReadOnly } from './sqlite.js';
import { editorUserDir } from './vscode-agents.js';

export const id = 'cursor';
export const NAME = 'Cursor';

export function stateDb({ home, env = {}, platform = process.platform }) {
  return join(editorUserDir('Cursor', { home, env, platform }), 'globalStorage', 'state.vscdb');
}

export function trackingDb({ home }) {
  return join(home, '.cursor', 'ai-tracking', 'ai-code-tracking.db');
}

// Key ranges, not LIKE: LIKE can't use the key index, so it walks the whole (often multi-GB) table.
const COMPOSERS = `select substr(key, 14) id,
  json_extract(value, '$.modelConfig.modelName', '$.createdAt', '$.fullConversationHeadersOnly') j
  from cursorDiskKV where key >= 'composerData:' and key < 'composerData;'`;
const bubblesOf = `select key,
  json_extract(value, '$.createdAt', '$.type', '$.modelInfo.modelName', '$.toolFormerData.name') j,
  instr(value, '"toolFormerData":{') > 0 isTool,
  (instr(value, '"text":"') > 0 and instr(value, '"text":""') = 0) hasText
  from cursorDiskKV where key >= ? and key < ?`;

function tables(db) {
  try {
    return new Set(db.prepare("select name from sqlite_master where type = 'table'").all().map((r) => r.name));
  } catch {
    return new Set();
  }
}

// One typed message: a prompt, and one unit of activity on its day and hour.
function addPrompt(t, when, model, chatId) {
  t.prompts++;
  addReply(t, { when, model, input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, session: chatId });
}

export function readChats(t, db, win) {
  if (!tables(db).has('cursorDiskKV')) return;
  const noHeaders = [];
  const models = new Map();
  for (const r of db.prepare(COMPOSERS).iterate()) {
    const [model, created, headersJson] = safeJson(r.j) || [];
    models.set(r.id, model || null);
    const headers = typeof headersJson === 'string' ? safeJson(headersJson) : headersJson;
    if (!Array.isArray(headers) || !headers.length) {
      noHeaders.push(r.id);
      continue;
    }
    const chatStart = toDate(created);
    let last = chatStart;
    for (const h of headers) {
      // Most headers carry a time; the rest inherit the one before them in the chat.
      const when = toDate(h?.createdAt ?? h?.startedAtMs) || last;
      last = when;
      if (num(h?.type) === 1 && inWindow(when, win)) addPrompt(t, when, model || null, r.id);
    }
  }
  // Older chats without headers: read their bubbles (slower), one chat at a time.
  const stmt = db.prepare(bubblesOf);
  for (const chatId of noHeaders) {
    let model = models.get(chatId) || null;
    const list = [];
    for (const r of stmt.iterate(`bubbleId:${chatId}:`, `bubbleId:${chatId};`)) {
      const [c, type, m, tool] = safeJson(r.j) || [];
      const when = toDate(c === '' ? null : c);
      if (when) list.push({ when, type: num(type), model: m || null, tool: tool || null, isTool: !!r.isTool });
    }
    list.sort((a, b) => a.when - b.when);
    for (const b of list) {
      if (b.type === 1 && b.model) model = b.model;
      if (!inWindow(b.when, win)) continue;
      if (b.type === 1) addPrompt(t, b.when, model, chatId);
      else if (b.isTool) addTool(t, b.tool);
    }
  }
}

export function readLines(t, db, win) {
  if (!tables(db).has('scored_commits')) return;
  // One commit can be scored on several branches; count it once.
  const sql = `select commitHash, max(coalesce(composerLinesAdded, 0) + coalesce(tabLinesAdded, 0)) n
    from scored_commits where scoredAt >= ? and scoredAt < ? group by commitHash`;
  for (const r of db.prepare(sql).iterate(win.start.getTime(), win.end.getTime())) t.lines += num(r.n);
}

export async function read({ home, env = {}, win, platform = process.platform }) {
  const state = stateDb({ home, env, platform });
  const tracking = trackingDb({ home });
  const hasState = existsSync(state);
  const hasTracking = existsSync(tracking);
  if (!hasState && !hasTracking) return null;
  const t = emptyTally(id, NAME);
  t.tokensKnown = false;
  for (const [path, fn, what] of [
    [hasState && state, readChats, 'chats'],
    [hasTracking && tracking, readLines, 'AI line counts'],
  ]) {
    if (!path) continue;
    const db = await openReadOnly(path);
    if (!db) {
      const note = 'Cursor needs Node 22 or newer to read its database';
      if (!t.notes.includes(note)) t.notes.push(note);
      continue;
    }
    try {
      fn(t, db, win);
    } catch {
      t.notes.push(`Cursor ${what} could not be read`);
    } finally {
      db.close();
    }
  }
  return t.prompts || t.lines ? t : null;
}
