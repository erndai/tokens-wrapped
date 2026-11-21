// Shared shape for every local reader. Read-only: readers open files and databases for reading and never write.
// Privacy: a reader keeps numbers, model names, tool names and file extensions. It never keeps prompt or reply
// text, and keeps paths only as opaque counts (a Set of project folders is counted, never shown).

import { createReadStream, statSync } from 'node:fs';

export function emptyTally(id, name) {
  return {
    id,
    name,
    tokens: { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 }, // input includes cached and cache writes
    cost: 0, // only what the harness itself stored (for example OpenCode); estimates are made later
    replies: 0, // model replies
    prompts: 0, // messages the person typed
    sessions: new Set(),
    projects: new Set(),
    days: new Map(), // local date -> tokens
    dayActivity: new Map(), // local date -> replies (for harnesses that keep no token counts)
    hours: new Array(24).fill(0), // replies by local hour
    models: new Map(), // model -> tokens
    byModel: new Map(), // model -> { input, cached, cacheWrite, cacheWrite1h, output }, for the price estimate
    tools: new Map(), // tool name -> calls
    lines: 0, // lines the agent wrote with its edit/write tools
    files: new Set(),
    exts: new Map(), // file extension -> edits
    webSearches: 0,
    tokensKnown: true, // false for harnesses that keep no local token counts (Cursor)
    notes: [],
  };
}

const pad = (n) => String(n).padStart(2, '0');
// Local calendar day, the day the person lived it.
export function localDay(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function toDate(v) {
  if (v == null) return null;
  const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function inWindow(d, win) {
  return d && d >= win.start && d < win.end;
}

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
export { n as num };

// One model reply's usage. input must already include cached and cache-write tokens.
export function addReply(t, { when, model, input = 0, cached = 0, cacheWrite = 0, cacheWrite1h = 0, output = 0, reasoning = 0, session }) {
  t.tokens.input += input;
  t.tokens.cached += cached;
  t.tokens.cacheWrite += cacheWrite;
  t.tokens.output += output;
  t.tokens.reasoning += reasoning;
  t.replies++;
  const tokens = input + output;
  if (when) {
    const day = localDay(when);
    t.days.set(day, (t.days.get(day) || 0) + tokens);
    t.dayActivity.set(day, (t.dayActivity.get(day) || 0) + 1);
    t.hours[when.getHours()]++;
  }
  if (model) {
    t.models.set(model, (t.models.get(model) || 0) + tokens);
    const b = t.byModel.get(model) || { input: 0, cached: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0 };
    b.input += input;
    b.cached += cached;
    b.cacheWrite += cacheWrite;
    b.cacheWrite1h += cacheWrite1h;
    b.output += output;
    t.byModel.set(model, b);
  }
  if (session) t.sessions.add(session);
}

export function addTool(t, name) {
  if (!name) return;
  const k = String(name).startsWith('mcp__') ? 'MCP tools' : String(name);
  t.tools.set(k, (t.tools.get(k) || 0) + 1);
}

// Lines and files from an edit or write. Only the count of lines and the extension are kept.
export function addEdit(t, filePath, text) {
  if (typeof text === 'string' && text.length) t.lines += text.split('\n').length;
  if (filePath) {
    t.files.add(String(filePath));
    const m = /\.([A-Za-z0-9]{1,10})$/.exec(String(filePath));
    const ext = m ? m[1].toLowerCase() : '';
    if (ext) t.exts.set(ext, (t.exts.get(ext) || 0) + 1);
  }
}

// Streams a text file line by line without loading it whole (some session logs are hundreds of MB).
export async function eachLine(file, fn) {
  const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
  let rest = '';
  for await (const chunk of stream) {
    const parts = (rest + chunk).split('\n');
    rest = parts.pop();
    for (const line of parts) if (line) fn(line);
  }
  if (rest) fn(rest);
}

// Files changed before the window started can't hold this year's lines: skip them without opening.
export function touchedSince(file, since) {
  try {
    return statSync(file).mtime >= since;
  } catch {
    return false;
  }
}

export function safeJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
