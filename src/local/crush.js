// Crush (charmbracelet/crush): an index of projects at <global data>/projects.json, where <global data> is
// $CRUSH_GLOBAL_DATA, else $XDG_DATA_HOME/crush, else %LOCALAPPDATA%/crush (Windows) or ~/.local/share/crush.
// projects[].{path, data_dir}; each project keeps <data_dir or path/.crush>/crush.db.
// Checked upstream (internal/agent/agent.go updateSessionTokenCounters): sessions.prompt_tokens and
// completion_tokens are overwritten on every step with that step's context size and output, so they are NOT
// running totals and can't be summed into a year. Only sessions.cost is a running total (USD, from Crush's own
// price table or the provider), and a sub-agent's cost is added into its parent's, so cost is summed over root
// sessions only. Tokens therefore stay 0 and tokensKnown is false; replies, models and days come from the messages
// table (role, model, created_at in seconds), and tools and edits from tool_call parts.
// Message text is never selected; edit inputs are parsed only to count lines and note the file.

import { existsSync, readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { emptyTally, addReply, addTool, addEdit, safeJson, toDate, inWindow, num } from './tally.js';
import { openReadOnly } from './sqlite.js';

export const id = 'crush';
export const NAME = 'Crush';

export function globalDataDir({ home, env = {}, platform = process.platform }) {
  if (env.CRUSH_GLOBAL_DATA) return env.CRUSH_GLOBAL_DATA;
  if (env.XDG_DATA_HOME) return join(env.XDG_DATA_HOME, 'crush');
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'crush');
  return join(home, '.local', 'share', 'crush');
}

export function databases({ home, env = {}, platform = process.platform }) {
  const index = safeJson(safeRead(join(globalDataDir({ home, env, platform }), 'projects.json')));
  const out = [];
  for (const p of Array.isArray(index?.projects) ? index.projects : []) {
    if (!p || typeof p.path !== 'string') continue;
    const dir = p.data_dir ? (isAbsolute(p.data_dir) ? p.data_dir : join(p.path, p.data_dir)) : join(p.path, '.crush');
    const db = join(dir, 'crush.db');
    if (existsSync(db) && !out.some((o) => o.db === db)) out.push({ project: p.path, db });
  }
  return out;
}

function safeRead(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

function columns(db, table) {
  try {
    return new Set(db.prepare(`select name from pragma_table_info('${table}')`).all().map((r) => r.name));
  } catch {
    return new Set();
  }
}

export function readDb(t, db, win, project) {
  const since = Math.floor(win.start.getTime() / 1000);
  const sc = columns(db, 'sessions');
  if (!sc.has('id')) return;
  const rootOf = new Map();
  for (const r of db.prepare(`select id, ${sc.has('parent_session_id') ? 'parent_session_id' : 'null'} parent from sessions`).iterate()) {
    rootOf.set(r.id, r.parent || null);
  }
  const root = (sid) => {
    let cur = sid;
    for (let i = 0; i < 20 && rootOf.get(cur); i++) cur = rootOf.get(cur);
    return cur;
  };
  // Cost: running total on root sessions, dated at their last update.
  if (sc.has('cost')) {
    const parentFilter = sc.has('parent_session_id') ? "and (parent_session_id is null or parent_session_id = '')" : '';
    for (const r of db.prepare(`select id, cost, updated_at from sessions where updated_at >= ? ${parentFilter}`).iterate(since)) {
      if (!inWindow(toDate(r.updated_at), win)) continue;
      t.cost += num(r.cost);
      t.sessions.add(`${project}:${r.id}`);
    }
  }
  const mc = columns(db, 'messages');
  if (!mc.has('role') || !mc.has('created_at')) return;
  const model = mc.has('model') ? 'model' : 'null';
  let touched = false;
  for (const r of db.prepare(`select session_id, role, ${model} model, created_at from messages where created_at >= ? and role in ('user', 'assistant')`).iterate(since)) {
    const when = toDate(r.created_at);
    if (!inWindow(when, win)) continue;
    const session = `${project}:${root(r.session_id)}`;
    if (r.role === 'user') {
      if (!rootOf.get(r.session_id)) t.prompts++; // a sub-agent's task is written by the agent, not the person
    } else {
      addReply(t, { when, model: r.model || null, session });
    }
    touched = true;
  }
  if (touched) t.projects.add(project);
  if (!mc.has('parts')) return;
  const tools = `select json_extract(j.value, '$.data.name') name, json_extract(j.value, '$.data.input') input, m.created_at ts
    from messages m, json_each(m.parts) j
    where m.role = 'assistant' and m.created_at >= ? and json_extract(j.value, '$.type') = 'tool_call'`;
  try {
    for (const r of db.prepare(tools).iterate(since)) {
      if (!inWindow(toDate(r.ts), win)) continue;
      addTool(t, r.name);
      if (r.name !== 'edit' && r.name !== 'write' && r.name !== 'multiedit') continue;
      const inp = safeJson(r.input);
      if (!inp || typeof inp !== 'object') continue;
      if (r.name === 'write') addEdit(t, inp.file_path, inp.content);
      else if (r.name === 'edit') addEdit(t, inp.file_path, inp.new_string);
      else for (const e of Array.isArray(inp.edits) ? inp.edits : []) addEdit(t, inp.file_path, e?.new_string);
    }
  } catch {
    /* parts that aren't JSON: tools are extras */
  }
}

export async function read({ home, env = {}, win, platform = process.platform }) {
  const list = databases({ home, env, platform });
  if (!list.length) return null;
  const t = emptyTally(id, NAME);
  t.tokensKnown = false;
  for (const { project, db: path } of list) {
    const db = await openReadOnly(path);
    if (!db) {
      t.notes.push('Crush needs Node 22 or newer to read its databases');
      break;
    }
    try {
      readDb(t, db, win, project);
    } catch {
      t.notes.push('A Crush database could not be read');
    } finally {
      db.close();
    }
  }
  return t.replies || t.prompts ? t : null;
}
