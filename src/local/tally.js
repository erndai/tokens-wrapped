// Shared shape for every local reader. Read-only: readers open files and databases for reading and never write.
// Privacy: a reader keeps numbers, model names, tool names and file extensions. It never keeps prompt or reply
// text, and keeps paths only as opaque counts (a Set of project folders is counted, never shown).

import { createReadStream, statSync } from 'node:fs';
import * as zlib from 'node:zlib';

// zstd-compressed logs (Codex writes .jsonl.zst) need Node 22.15+; older Node can't open them.
export const canZstd = typeof zlib.createZstdDecompress === 'function';

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
    lanes: new Map(), // agent (session, or subagent within one) -> reply times in ms, for "agents at once" and "longest session"
    runs: new Map(), // session -> actions the agent has taken since your last message
    leash: null, // { actions, when }: the most actions an agent took between two of your messages
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
export function addReply(t, { when, model, input = 0, cached = 0, cacheWrite = 0, cacheWrite1h = 0, output = 0, reasoning = 0, session, lane = session }) {
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
  if (when && lane) {
    const ts = t.lanes.get(lane);
    if (ts) ts.push(when.getTime());
    else t.lanes.set(lane, [when.getTime()]);
  }
}

// More output for a reply already counted (Claude Code writes a reply over several lines; only the last carries
// its final output count).
export function addOutput(t, { when, model, output = 0, reasoning = 0 }) {
  if (!(output > 0)) return;
  t.tokens.output += output;
  t.tokens.reasoning += reasoning;
  if (when) {
    const day = localDay(when);
    t.days.set(day, (t.days.get(day) || 0) + output);
  }
  if (model) {
    t.models.set(model, (t.models.get(model) || 0) + output);
    const b = t.byModel.get(model);
    if (b) b.output += output;
  }
}

// A message the person typed. Starts a new run of agent actions in that session.
export function addPrompt(t, session, when) {
  t.prompts++;
  if (session != null) t.runs.set(session, { n: 0, when });
}

// One tool call. With a session, it also counts toward the run of actions since the person's last message there.
export function addTool(t, name, session) {
  if (!name) return;
  const k = String(name).startsWith('mcp__') ? 'MCP tools' : String(name);
  t.tools.set(k, (t.tools.get(k) || 0) + 1);
  if (session == null) return;
  const r = t.runs.get(session);
  if (!r) return; // actions before any message we saw in this window: no run to count
  r.n++;
  if (!t.leash || r.n > t.leash.actions) t.leash = { actions: r.n, when: r.when };
}

// Files that hold prose or data, not code: their lines don't count toward "lines of code".
export const NOT_CODE = new Set(['md', 'mdx', 'markdown', 'txt', 'rst', 'json', 'jsonl', 'ndjson', 'csv', 'tsv', 'log', 'svg', 'lock', 'xml', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ipynb']);

export function extOf(filePath) {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(String(filePath || ''));
  return m ? m[1].toLowerCase() : '';
}

export const isCode = (filePath) => !NOT_CODE.has(extOf(filePath));

// Lines and files from an edit or write. Only the count of lines and the extension are kept.
export function addEdit(t, filePath, text) {
  if (typeof text === 'string' && text.length && isCode(filePath)) t.lines += text.split('\n').length;
  if (filePath) {
    t.files.add(String(filePath));
    const ext = extOf(filePath);
    if (ext) t.exts.set(ext, (t.exts.get(ext) || 0) + 1);
  }
}

// Streams a text file line by line without loading it whole (some session logs are hundreds of MB, and Codex's
// add up to many GB). A .zst file is decompressed on the way in. With `match`, only lines containing one of those
// strings are decoded and passed on: the search runs on raw bytes, which is far faster than decoding every line.
// Splitting on the newline byte is safe in UTF-8: it never occurs inside a multi-byte character.
export async function eachLine(file, fn, { match } = {}) {
  let stream = createReadStream(file, { highWaterMark: 1 << 20 });
  if (String(file).endsWith('.zst')) {
    if (!canZstd) throw new Error('zstd needs Node 22.15 or newer');
    stream = stream.pipe(zlib.createZstdDecompress());
  }
  const needles = match ? match.map((m) => Buffer.from(m)) : null;
  const lines = (buf, from, to) => (needles ? matching(buf, from, to, needles, fn) : every(buf, from, to, fn));
  let pending = [];
  for await (const chunk of stream) {
    const first = chunk.indexOf(10);
    if (first === -1) {
      pending.push(chunk);
      continue;
    }
    const head = pending.length ? Buffer.concat([...pending, chunk.subarray(0, first)]) : chunk.subarray(0, first);
    lines(head, 0, head.length);
    const last = chunk.lastIndexOf(10);
    if (last > first) lines(chunk, first + 1, last);
    pending = last + 1 < chunk.length ? [chunk.subarray(last + 1)] : [];
  }
  if (pending.length) {
    const tail = Buffer.concat(pending);
    lines(tail, 0, tail.length);
  }
}

function every(buf, from, to, fn) {
  let a = from;
  while (a < to) {
    let b = buf.indexOf(10, a);
    if (b === -1 || b > to) b = to;
    if (b > a) fn(buf.toString('utf8', a, b));
    a = b + 1;
  }
}

// The lines in buf[from, to) that contain a needle, in file order.
function matching(buf, from, to, needles, fn) {
  const starts = new Map();
  for (const n of needles) {
    let p = from;
    while ((p = buf.indexOf(n, p)) !== -1 && p < to) {
      const s = Math.max(from, buf.lastIndexOf(10, p) + 1);
      let e = buf.indexOf(10, p);
      if (e === -1 || e > to) e = to;
      starts.set(s, e);
      p = e + 1;
    }
  }
  for (const s of [...starts.keys()].sort((x, y) => x - y)) fn(buf.toString('utf8', s, starts.get(s)));
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

// Adds tally b into a (the same harness read in parts, or found twice).
export function mergeInto(a, b) {
  for (const k of Object.keys(a.tokens)) a.tokens[k] += b.tokens[k];
  for (const k of ['cost', 'replies', 'prompts', 'lines', 'webSearches']) a[k] += b[k];
  for (const k of ['sessions', 'projects', 'files']) for (const v of b[k]) a[k].add(v);
  for (const k of ['days', 'dayActivity', 'models', 'tools', 'exts']) for (const [x, v] of b[k]) a[k].set(x, (a[k].get(x) || 0) + v);
  for (const [m, v] of b.byModel) {
    const t = a.byModel.get(m) || { input: 0, cached: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0 };
    for (const k of Object.keys(t)) t[k] += v[k] || 0;
    a.byModel.set(m, t);
  }
  b.hours.forEach((v, i) => (a.hours[i] += v));
  for (const [k, ts] of b.lanes) a.lanes.set(k, (a.lanes.get(k) || []).concat(ts));
  if (b.leash && (!a.leash || b.leash.actions > a.leash.actions)) a.leash = b.leash;
  a.tokensKnown = a.tokensKnown || b.tokensKnown;
  a.notes.push(...b.notes);
  return a;
}
