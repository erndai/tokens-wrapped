// Goose (block/goose): SQLite at <data dir>/sessions/sessions.db. Data dir: $GOOSE_PATH_ROOT/data, else
// $XDG_DATA_HOME/goose or ~/.local/share/goose (macOS and Linux), %APPDATA%/Block/goose/data (Windows); older macOS
// installs used ~/Library/Application Support/goose.
// Schema 15+ keeps one usage_ledger row per model call: created_timestamp (s), model, input_tokens, output_tokens,
// cache_read_tokens, cache_write_tokens, cost, cost_source, is_compaction. Checked upstream (oi-kit anthropic and
// bedrock usage tests): input_tokens already includes cache reads and writes (7 fresh + 5000 read + 10000 written
// is stored as 15007). Rows that are smaller than their own cache counts are treated as excluding them.
// A 'carried_forward' row holds usage from before the ledger existed; it is dated at the session's start.
// Sessions with no ledger rows (older Goose) fall back to their accumulated_* totals, dated at created_at.
// Messages: only roles, dates and tool names are pulled, in SQL; message text is never selected.

import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { emptyTally, addReply, addTool, toDate, inWindow, num } from './tally.js';
import { openReadOnly } from './sqlite.js';

export const id = 'goose';
export const NAME = 'Goose';

export function dbPaths({ home, env = {}, platform = process.platform }) {
  const dirs = [];
  if (env.GOOSE_PATH_ROOT) dirs.push(join(env.GOOSE_PATH_ROOT, 'data'));
  if (platform === 'win32') {
    dirs.push(join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Block', 'goose', 'data'));
  } else {
    if (env.XDG_DATA_HOME) dirs.push(join(env.XDG_DATA_HOME, 'goose'));
    dirs.push(join(home, '.local', 'share', 'goose'));
    if (platform === 'darwin') dirs.push(join(home, 'Library', 'Application Support', 'goose'));
  }
  const seen = new Set();
  const out = [];
  for (const d of dirs) {
    const p = join(d, 'sessions', 'sessions.db');
    if (!existsSync(p)) continue;
    let real = p;
    try {
      real = realpathSync(p);
    } catch {
      /* keep p */
    }
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(p);
  }
  return out;
}

// SQLite CURRENT_TIMESTAMP text ("2026-03-01 12:00:00") is UTC; JavaScript would read it as local time.
export function sqlTime(v) {
  if (typeof v === 'string' && /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(v)) return toDate(v.replace(' ', 'T') + 'Z');
  return toDate(v);
}

// Goose input already includes cache; a row smaller than its own cache counts clearly does not.
export function normalize({ input_tokens, output_tokens, cache_read_tokens, cache_write_tokens }) {
  const cached = num(cache_read_tokens);
  const cacheWrite = num(cache_write_tokens);
  let input = num(input_tokens);
  if (input < cached + cacheWrite) input += cached + cacheWrite;
  return { input, cached, cacheWrite, output: num(output_tokens) };
}

function columns(db, table) {
  try {
    return new Set(db.prepare(`select name from pragma_table_info('${table}')`).all().map((r) => r.name));
  } catch {
    return new Set();
  }
}

export function readDb(t, db, win) {
  const sc = columns(db, 'sessions');
  if (!sc.size) return;
  const col = (c, as = c) => (sc.has(c) ? `s.${c} ${as}` : `null ${as}`);
  const sessionCols = [
    's.id id',
    col('parent_session_id', 'parent'),
    col('working_dir', 'cwd'),
    col('created_at', 'created'),
    sc.has('model_config_json') ? "json_extract(s.model_config_json, '$.model_name') model" : 'null model',
  ].join(', ');
  const sessions = new Map();
  for (const r of db.prepare(`select ${sessionCols} from sessions s`).iterate()) {
    sessions.set(r.id, { root: r.parent || r.id, cwd: r.cwd, created: sqlTime(r.created), model: r.model || null });
  }
  const withLedger = new Set();
  if (columns(db, 'usage_ledger').size) {
    const sql = `select session_id, created_timestamp, model, input_tokens, output_tokens, cache_read_tokens,
      cache_write_tokens, cost, cost_source from usage_ledger`;
    for (const r of db.prepare(sql).iterate()) {
      withLedger.add(r.session_id);
      const s = sessions.get(r.session_id);
      const when = r.cost_source === 'carried_forward' && s?.created ? s.created : toDate(r.created_timestamp);
      if (!inWindow(when, win)) continue;
      addReply(t, { when, model: r.model || s?.model || null, ...normalize(r), session: s?.root || r.session_id });
      t.cost += num(r.cost);
      if (s?.cwd) t.projects.add(s.cwd);
    }
  }
  // Sessions the ledger never saw: one reply's worth of their running totals.
  const acc = (c) => (sc.has(`accumulated_${c}`) ? `coalesce(accumulated_${c}, ${sc.has(c) ? c : 0})` : sc.has(c) ? c : '0');
  const totals = `select id, ${acc('input_tokens')} input_tokens, ${acc('output_tokens')} output_tokens,
    ${acc('cache_read_tokens')} cache_read_tokens, ${acc('cache_write_tokens')} cache_write_tokens,
    ${sc.has('accumulated_cost') ? 'accumulated_cost' : '0'} cost from sessions`;
  for (const r of db.prepare(totals).iterate()) {
    if (withLedger.has(r.id)) continue;
    const s = sessions.get(r.id);
    if (!inWindow(s?.created, win)) continue;
    const u = normalize(r);
    if (!u.input && !u.output) continue;
    addReply(t, { when: s.created, model: s.model, ...u, session: s.root });
    t.cost += num(r.cost);
    if (s.cwd) t.projects.add(s.cwd);
  }
  readMessages(t, db, win);
}

// Prompts are user messages with a text block and no tool result; tools are assistant toolRequest blocks.
function readMessages(t, db, win) {
  const mc = columns(db, 'messages');
  if (!mc.has('content_json') || !mc.has('created_timestamp')) return;
  const since = Math.floor(win.start.getTime() / 1000);
  const prompts = `select m.created_timestamp ts from messages m where m.role = 'user' and m.created_timestamp >= ?
    and exists (select 1 from json_each(m.content_json) j where json_extract(j.value, '$.type') = 'text')
    and not exists (select 1 from json_each(m.content_json) j where json_extract(j.value, '$.type') = 'toolResponse')`;
  const tools = `select m.created_timestamp ts, json_extract(j.value, '$.toolCall.value.name') name
    from messages m, json_each(m.content_json) j
    where m.role = 'assistant' and m.created_timestamp >= ? and json_extract(j.value, '$.type') = 'toolRequest'`;
  try {
    for (const r of db.prepare(prompts).iterate(since)) if (inWindow(toDate(r.ts), win)) t.prompts++;
    for (const r of db.prepare(tools).iterate(since)) if (inWindow(toDate(r.ts), win)) addTool(t, r.name);
  } catch {
    /* content that isn't JSON: prompts and tools are extras */
  }
}

export async function read({ home, env = {}, win, platform = process.platform }) {
  const paths = dbPaths({ home, env, platform });
  if (!paths.length) return null;
  const t = emptyTally(id, NAME);
  for (const p of paths) {
    const db = await openReadOnly(p);
    if (!db) {
      t.notes.push('Goose needs Node 22 or newer to read its database');
      break;
    }
    try {
      readDb(t, db, win);
    } catch {
      t.notes.push('Goose database could not be read');
    } finally {
      db.close();
    }
  }
  return t.replies || t.prompts ? t : null;
}
