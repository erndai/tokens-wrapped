// OpenCode: SQLite at $XDG_DATA_HOME/opencode/opencode.db (~/.local/share/opencode), table message(id, session_id,
// time_created, data JSON). Older versions keep the same JSON as files in storage/message/<session>/<id>.json.
// Assistant message data: modelID, providerID, cost (USD, stored by OpenCode), time.created (ms),
// tokens { input, output, reasoning, cache { read, write } }. Checked on a real database: total = input + output +
// reasoning + cache.read + cache.write, so input excludes cached tokens and reasoning is separate from output.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyTally, addReply, safeJson, toDate, inWindow, num, touchedSince } from './tally.js';
import { openReadOnly } from './sqlite.js';

export const id = 'opencode';
export const NAME = 'OpenCode';

export function dataDir({ home, env = {} }) {
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode');
}

export function addMessage(t, m, win, sessionId) {
  if (!m || m.role !== 'assistant' || !m.tokens) return;
  const when = toDate(m.time?.created);
  if (!inWindow(when, win)) return;
  const tk = m.tokens;
  const read = num(tk.cache?.read);
  const write = num(tk.cache?.write);
  addReply(t, {
    when,
    model: m.modelID || null,
    input: num(tk.input) + read + write,
    cached: read,
    cacheWrite: write,
    output: num(tk.output) + num(tk.reasoning),
    reasoning: num(tk.reasoning),
    session: sessionId || m.sessionID,
  });
  t.cost += num(m.cost);
  if (m.path?.cwd) t.projects.add(m.path.cwd);
}

export function addUser(t, m, win) {
  if (m?.role === 'user' && inWindow(toDate(m.time?.created), win)) t.prompts++;
}

export async function read({ home, env, win }) {
  const dir = dataDir({ home, env });
  if (!existsSync(dir)) return null;
  const t = emptyTally(id, NAME);
  const db = existsSync(join(dir, 'opencode.db')) ? await openReadOnly(join(dir, 'opencode.db')) : null;
  if (db) {
    try {
      const since = win.start.getTime();
      for (const row of db.prepare('select session_id, data from message where time_created >= ?').iterate(since)) {
        const m = safeJson(row.data);
        addMessage(t, m, win, row.session_id);
        addUser(t, m, win);
      }
    } catch {
      t.notes.push('OpenCode database could not be read');
    } finally {
      db.close();
    }
  } else if (existsSync(join(dir, 'opencode.db'))) {
    t.notes.push('OpenCode needs Node 22 or newer to read its database');
  }
  // Older file storage.
  const msgRoot = join(dir, 'storage', 'message');
  if (existsSync(msgRoot)) {
    for (const s of safeDir(msgRoot)) {
      for (const f of safeDir(join(msgRoot, s))) {
        const p = join(msgRoot, s, f);
        if (!f.endsWith('.json') || !touchedSince(p, win.start)) continue;
        const m = safeJson(safeRead(p));
        addMessage(t, m, win, s);
        addUser(t, m, win);
      }
    }
  }
  return t.replies || t.prompts ? t : null;
}

function safeDir(d) {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
}
function safeRead(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}
