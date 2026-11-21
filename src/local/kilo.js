// Kilo Code CLI (and the newer Kilo extension, which runs the CLI): an OpenCode fork with the same message.data
// JSON, kept at ${XDG_DATA_HOME:-~/.local/share}/kilo/kilo.db (every platform, Windows included). Dev channels use
// kilo-<channel>.db (or a pre-existing opencode-<channel>.db in the same folder); $KILO_DB overrides the file,
// absolute or relative to the data folder. Same id and name as the legacy Kilo extension in vscode-agents.js, so
// the two merge into one Kilo Code row.

import { existsSync, readdirSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { emptyTally, safeJson } from './tally.js';
import { openReadOnly } from './sqlite.js';
import { addMessage, addUser } from './opencode.js';

export const id = 'kilo-code';
export const NAME = 'Kilo Code';

export function dataDir({ home, env = {} }) {
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'kilo');
}

export function dbPaths({ home, env = {} }) {
  const dir = dataDir({ home, env });
  const out = [];
  if (env.KILO_DB && env.KILO_DB !== ':memory:') out.push(isAbsolute(env.KILO_DB) ? env.KILO_DB : join(dir, env.KILO_DB));
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    /* no folder */
  }
  for (const f of names.sort()) if (/^(kilo|opencode)(-[A-Za-z0-9._-]+)?\.db$/.test(f)) out.push(join(dir, f));
  return [...new Set(out)].filter((p) => existsSync(p));
}

export async function read({ home, env = {}, win }) {
  const paths = dbPaths({ home, env });
  if (!paths.length) return null;
  const t = emptyTally(id, NAME);
  const since = win.start.getTime();
  for (const p of paths) {
    const db = await openReadOnly(p);
    if (!db) {
      t.notes.push('Kilo Code needs Node 22 or newer to read its database');
      break;
    }
    try {
      for (const row of db.prepare('select session_id, data from message where time_created >= ?').iterate(since)) {
        const m = safeJson(row.data);
        addMessage(t, m, win, row.session_id);
        addUser(t, m, win);
      }
    } catch {
      t.notes.push('Kilo Code database could not be read');
    } finally {
      db.close();
    }
  }
  return t.replies || t.prompts ? t : null;
}
