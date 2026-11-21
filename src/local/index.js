// Your year in AI from what coding agents already keep on this computer. No keys, no network.
// Each reader returns a tally (tally.js) or null when that agent isn't installed or has nothing this year.

import * as claude from './claude.js';
import * as codex from './codex.js';
import * as opencode from './opencode.js';
import { localDay } from './tally.js';

export const READERS = [claude, codex, opencode];

// Jan 1 this year (local time) to now.
export function localYear(now = new Date()) {
  return { start: new Date(now.getFullYear(), 0, 1), end: now, year: now.getFullYear() };
}

export async function scanLocal({ home, env = {}, now = new Date(), progress = () => {}, readers = READERS } = {}) {
  const win = localYear(now);
  const tallies = [];
  const notes = [];
  for (const r of readers) {
    progress(`Reading ${r.NAME}...`);
    try {
      const t = await r.read({ home, env, win, progress });
      if (t) tallies.push(t);
      if (t?.notes?.length) notes.push(...t.notes);
    } catch {
      notes.push(`${r.NAME} could not be read`);
    }
  }
  return { tallies, notes, summary: summarizeLocal(tallies, win) };
}

const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v);

// One summary across every harness, in the shape the cards read (see usage.js summarize), plus local extras.
export function summarizeLocal(tallies, win) {
  if (!tallies.length) return null;
  const tokens = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  const days = new Map();
  const activity = new Map();
  const models = new Map();
  const tools = new Map();
  const exts = new Map();
  const hours = new Array(24).fill(0);
  let replies = 0, prompts = 0, sessions = 0, projects = 0, lines = 0, files = 0, storedCost = 0, webSearches = 0;
  for (const t of tallies) {
    for (const k of Object.keys(tokens)) tokens[k] += t.tokens[k];
    for (const [d, v] of t.days) add(days, d, v);
    for (const [d, v] of t.dayActivity) add(activity, d, v);
    for (const [m, v] of t.models) add(models, m, v);
    for (const [m, v] of t.tools) add(tools, m, v);
    for (const [m, v] of t.exts) add(exts, m, v);
    t.hours.forEach((v, i) => (hours[i] += v));
    replies += t.replies;
    prompts += t.prompts;
    sessions += t.sessions.size;
    projects += t.projects.size;
    lines += t.lines;
    files += t.files.size;
    storedCost += t.cost;
    webSearches += t.webSearches;
  }
  const total = tokens.input + tokens.output;
  // The calendar runs from the first day any harness has data, since older logs may have been cleaned up.
  const active = [...activity.keys()].sort();
  const first = active[0];
  const calendar = [];
  if (first) {
    for (let d = new Date(`${first}T12:00:00`); d < win.end; d.setDate(d.getDate() + 1)) {
      const k = localDay(d);
      calendar.push({ date: k, tokens: days.get(k) || 0, replies: activity.get(k) || 0 });
    }
  }
  const peak = calendar.reduce((a, b) => (b.tokens > (a?.tokens || 0) ? b : a), null);
  let streak = 0, run = 0;
  for (const d of calendar) {
    run = d.replies ? run + 1 : 0;
    streak = Math.max(streak, run);
  }
  const sorted = (m) => [...m.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const harnesses = tallies
    .map((t) => ({
      id: t.id,
      name: t.name,
      tokens: t.tokens.input + t.tokens.output,
      replies: t.replies,
      days: [...t.dayActivity.values()].filter(Boolean).length,
      tokensKnown: t.tokensKnown,
    }))
    .sort((a, b) => b.tokens - a.tokens || b.replies - a.replies);
  return {
    source: 'local',
    year: win.year,
    since: first || localDay(win.start),
    until: localDay(new Date(win.end.getTime() - 1)),
    sources: harnesses.map((h) => h.name),
    harnesses,
    tokens: { total, ...tokens },
    cacheHit: tokens.input ? tokens.cached / tokens.input : null,
    models: sorted(models).map(([name, t]) => ({ name, tokens: t })),
    days: calendar,
    peak: peak && peak.tokens > 0 ? peak : null,
    activeDays: calendar.filter((d) => d.replies > 0).length,
    streak,
    busiestHour: hours.some(Boolean) ? hours.indexOf(Math.max(...hours)) : null,
    hours,
    replies,
    prompts,
    sessions,
    projects,
    tools: sorted(tools).map(([name, calls]) => ({ name, calls })),
    built: lines || files ? { lines, files, languages: sorted(exts).slice(0, 5).map(([ext, edits]) => ({ ext, edits })) } : null,
    storedCost: storedCost || null,
    webSearches: webSearches || null,
    code: null, // the admin-key Claude Code report fills this in team mode
  };
}
