// Small read-only file helpers shared by the local readers. Nothing here writes.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { touchedSince } from './tally.js';

export function safeDir(dir, opts) {
  try {
    return readdirSync(dir, opts);
  } catch {
    return [];
  }
}

export function safeRead(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

export function mtimeOf(file) {
  try {
    return statSync(file).mtime;
  } catch {
    return null;
  }
}

export function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// "~/x" in an environment variable means the home folder passed in, never os.homedir().
export function expandHome(p, home) {
  const s = String(p);
  if (s === '~') return home;
  if (s.startsWith('~/')) return join(home, s.slice(2));
  return s;
}

// Every file below dir whose name passes want(name, path), changed since `since` (when given).
// skipDir(name) prunes a folder; depth bounds how far down it goes.
export function walk(dir, want, { since, skipDir = () => false, depth = 12 } = {}, out = []) {
  if (depth < 0) return out;
  for (const e of safeDir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!skipDir(e.name)) walk(p, want, { since, skipDir, depth: depth - 1 }, out);
    } else if (e.isFile() && want(e.name, p) && (!since || touchedSince(p, since))) out.push(p);
  }
  return out;
}
