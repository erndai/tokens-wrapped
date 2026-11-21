#!/usr/bin/env node
// Builds the website's sample recap (made-up numbers): site/cards/*.svg for the hero, and site/demo.html.
//   node scripts/site-assets.js
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recapData, cards, page } from '../src/share.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'site');

// A plausible heavy user, invented. Same shape summarizeLocal() returns.
function sampleSummary() {
  const year = 2026;
  const days = [];
  let seed = 11;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  for (let d = new Date('2026-06-02T12:00:00'); d < new Date('2026-11-21T00:00:00'); d.setDate(d.getDate() + 1)) {
    const wk = d.getDay();
    const iso = d.toISOString().slice(0, 10);
    const off = (wk === 0 && rnd() < 0.6) || rnd() < 0.08;
    let tokens = off ? 0 : (12e6 + (d - new Date('2026-06-02')) / 864e5 * 3e5) * (wk === 6 ? 0.4 : 1) * (0.6 + rnd() * 0.8);
    if (iso === '2026-09-17') tokens *= 4.5;
    days.push({ date: iso, tokens: Math.round(tokens), replies: off ? 0 : Math.round(tokens / 3e5) });
  }
  const total = days.reduce((a, d) => a + d.tokens, 0);
  const hours = [2, 1, 0, 0, 0, 0, 1, 3, 9, 18, 26, 30, 24, 28, 33, 36, 38, 31, 22, 19, 21, 17, 10, 5];
  return {
    source: 'local',
    year,
    since: days[0].date,
    until: days[days.length - 1].date,
    sources: ['Claude Code', 'Codex', 'Cursor'],
    harnesses: [
      { id: 'claude-code', name: 'Claude Code', tokens: Math.round(total * 0.78), replies: 41230, days: 131, tokensKnown: true },
      { id: 'codex', name: 'Codex', tokens: Math.round(total * 0.22), replies: 9120, days: 44, tokensKnown: true },
      { id: 'cursor', name: 'Cursor', tokens: 0, replies: 3810, days: 37, tokensKnown: false },
    ],
    tokens: { total, input: Math.round(total * 0.985), cached: Math.round(total * 0.94), cacheWrite: Math.round(total * 0.02), output: Math.round(total * 0.015), reasoning: 0 },
    cacheHit: 0.954,
    models: [
      { name: 'claude-opus-5-5', tokens: total * 0.52 },
      { name: 'gpt-6.1-sol', tokens: total * 0.17 },
      { name: 'claude-sonnet-5-5', tokens: total * 0.16 },
      { name: 'claude-fable-5-1', tokens: total * 0.1 },
      { name: 'gpt-6-astra', tokens: total * 0.05 },
    ],
    days,
    peak: days.reduce((a, b) => (b.tokens > a.tokens ? b : a)),
    activeDays: days.filter((d) => d.replies).length,
    streak: 34,
    busiestHour: 16,
    hours,
    replies: 54160,
    prompts: 8420,
    sessions: 912,
    projects: 64,
    tools: [{ name: 'Bash', calls: 30120 }, { name: 'Edit', calls: 9050 }],
    built: { lines: 284310, files: 2140, languages: [{ ext: 'ts', edits: 4100 }, { ext: 'py', edits: 1900 }] },
    storedCost: null,
    webSearches: null,
    code: null,
  };
}

const usage = sampleSummary();
const value = { api: 9840, months: 6, unpricedShare: 0, byHarness: [] };
const d = recapData(null, { usage, value });
const c = cards(d);
mkdirSync(join(out, 'cards'), { recursive: true });
const ids = [];
for (const x of c.story) {
  writeFileSync(join(out, 'cards', `${x.id}.svg`), x.svg);
  ids.push(x.id);
}
writeFileSync(join(out, 'cards', 'order.json'), JSON.stringify(ids));
let demo = page(d)
  .replace('<title>Your year in AI</title>', '<title>tokens-wrapped sample</title><meta name="robots" content="noindex">')
  .replace(/<p class="note">[^<]*<\/p>/, '<p class="note">A sample with made-up numbers. Run <code>npx tokens-wrapped</code> for yours.</p>');
writeFileSync(join(out, 'demo.html'), demo);
console.log('cards:', ids.join(' '));
