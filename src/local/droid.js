// Factory Droid: each session keeps <id>.settings.json next to its <id>.jsonl transcript under
// ~/.factory/sessions/** ($DROID_SESSIONS_DIR, comma-separated, replaces the default). The settings file holds the
// session's CUMULATIVE tokenUsage {inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens,
// thinkingTokens, totalTokens?}. Counts are Anthropic-style: inputTokens excludes cache reads and writes, and
// thinkingTokens is counted on top of outputTokens (ccusage prices it separately) unless totalTokens shows it is
// already inside. Only per-session totals exist, so a session is one entry dated at the file's last change
// (never earlier than providerLockTimestamp, when the session's provider was fixed).

import { join, basename, relative, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { emptyTally, addReply, safeJson, toDate, inWindow, num } from './tally.js';
import { walk, safeRead, mtimeOf, expandHome } from './walk.js';

export const id = 'droid';
export const NAME = 'Droid';

export function roots({ home, env = {} }) {
  const list = env.DROID_SESSIONS_DIR
    ? String(env.DROID_SESSIONS_DIR).split(',').map((s) => s.trim()).filter(Boolean).map((s) => expandHome(s, home))
    : [join(home, '.factory', 'sessions')];
  return [...new Set(list)].filter((p) => existsSync(p));
}

// "custom:Claude-Sonnet-4.5 [Anthropic]" -> "Claude-Sonnet-4.5"
export function cleanModel(m) {
  if (typeof m !== 'string') return null;
  const s = m.replace(/^custom:/, '').replace(/\[[^\]]*\]/g, '').trim();
  return s || null;
}

export function tokensOf(u) {
  const read = num(u.cacheReadTokens);
  const write = num(u.cacheCreationTokens);
  const input = num(u.inputTokens) + read + write;
  const out = num(u.outputTokens);
  const thinking = num(u.thinkingTokens);
  const total = u.totalTokens == null ? null : num(u.totalTokens);
  // thinking already part of output when the total adds up without it (with or without the cache counts)
  const inside = total != null && thinking > 0 && (total === input + out || total === num(u.inputTokens) + out);
  const output = inside ? out : out + thinking;
  return { input, cached: read, cacheWrite: write, output, reasoning: Math.min(thinking, output) };
}

export function addSettings(t, doc, file, win, project) {
  const u = doc?.tokenUsage;
  if (!u || typeof u !== 'object') return false;
  const mtime = mtimeOf(file);
  const lock = toDate(doc.providerLockTimestamp);
  const when = mtime && lock ? (lock > mtime ? lock : mtime) : mtime || lock;
  if (!inWindow(when, win)) return false;
  const tk = tokensOf(u);
  if (!tk.input && !tk.output) return false;
  addReply(t, { when, model: cleanModel(doc.model), ...tk, session: basename(file, '.settings.json') });
  if (project) t.projects.add(project);
  return true;
}

export async function read({ home, env, win, progress = () => {} }) {
  const t = emptyTally(id, NAME);
  let any = false;
  for (const r of roots({ home, env })) {
    const list = walk(r, (n) => n.endsWith('.settings.json'), { since: win.start });
    let i = 0;
    for (const f of list) {
      if (++i % 10 === 0) {
      progress(`${NAME}: ${i} of ${list.length} sessions`, { i, n: list.length, t });
      await new Promise((r) => setImmediate(r)); // let the loading screen draw
    }
      any = true;
      const rel = relative(r, f).split(sep);
      const project = rel.length > 1 ? `${r}${sep}${rel[0]}` : null; // the per-folder slug, counted only
      addSettings(t, safeJson(safeRead(f)), f, win, project);
    }
  }
  if (!any) return null;
  return t.replies ? t : null;
}
