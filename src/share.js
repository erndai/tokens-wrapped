// "Your year in AI": story cards in the style of a year-in-review recap, in ernd's sky colors, written as one
// self-contained HTML page. The page loads nothing from the network. It plays the cards like a story and turns
// each one into a PNG in the browser (SVG -> canvas). It's a recap, not an ad: ernd shows up as branding only
// (wordmark, sky colors, ernd.ai), with no card pitch or rates on the cards or in the post text.
//
// Layout system (the v2 design, Paper file "tokens-wrapped — card QA"): 1080x1920, content from x 90 to 990, data
// text only between y 240 and 1640. Title baseline 400 (a second line at 490), display numeral under it, lead 90
// below the display, one caption at 1600. Only two motifs: the sun (peach circle, thin white ring) and clouds.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { usd } from './format.js';
import { SKY, wordmark, wordmarkWidth } from './brand.js';
import { personality, TYPING_WPM } from './local/persona.js';

export const STORY = { w: 1080, h: 1920 };
export const WIDE = { w: 1600, h: 900 };

// ernd's typeface first (ABC Diatype, when installed), then Helvetica-metric fallbacks, which the measure table
// below covers. No web fonts.
const FONT = "'ABC Diatype', 'Helvetica Neue', Helvetica, Arial, sans-serif";

// ernd's sky, pushed a little brighter for the recap, plus a sunset peach.
export const PALETTE = {
  ink: '#0a0a0a',
  night: '#141133',
  white: '#ffffff',
  blue: SKY.blue,
  violet: SKY.violet,
  purple: SKY.purple,
  pink: '#ee6fb2',
  peach: '#ffb48a',
  mist: '#dfe5ff',
};
const P = PALETTE;
const PAD = 90;
const RIGHT = STORY.w - PAD; // 990: nothing may pass it
const CAPTION_Y = 1600;

// ---------- data ----------

// usage: the summary from the local readers (local/index.js). value: the API-price estimate (local/value.js).
export function recapData({ usage, value = null, now = new Date() } = {}) {
  // Different raw ids can share a display name ("claude-opus-4" and "claude-opus-4-20250514"): merge them.
  const merged = new Map();
  for (const m of usage?.models || []) {
    const name = prettyModel(m.name);
    merged.set(name, (merged.get(name) || 0) + (Number(m.tokens) || 0));
  }
  const models = [...merged.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, tokens]) => ({ name, tokens, value: compact(tokens) + ' tokens' }));
  return {
    year: usage?.year || now.getFullYear(),
    value,
    models,
    usage,
    persona: personality(usage),
  };
}

// ---------- formatting ----------

export function compact(n) {
  const v = Number(n) || 0;
  const f = (x, u) => (x >= 100 ? Math.round(x) : Math.round(x * 10) / 10) + u;
  if (v >= 1e12) return f(v / 1e12, 'T');
  if (v >= 1e9) return f(v / 1e9, 'B');
  if (v >= 1e6) return f(v / 1e6, 'M');
  if (v >= 1e4) return f(v / 1e3, 'K');
  return Math.round(v).toLocaleString('en-US');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function shortDate(iso) {
  const [, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}
// 'Feb 24 – Nov 21' (en dash with spaces); one date when both ends are the same day.
export function dateRange(a, b) {
  if (!a) return '';
  return !b || a === b ? shortDate(a) : `${shortDate(a)} – ${shortDate(b)}`;
}
// Percent as people read it: never '100%' unless exact, never '0%' for something that happened.
export function pct(x) {
  const v = Number(x) || 0;
  if (v <= 0) return '0%';
  if (v >= 1) return '100%';
  if (v >= 0.995) return '>99%';
  if (v < 0.005) return '<1%';
  return `${Math.round(v * 100)}%`;
}
const n0 = (x) => Math.round(x).toLocaleString('en-US');
// '1 day', '2 days', '1,234 messages'.
export function plural(n, word, many = word + 's') {
  return `${n0(n)} ${Math.round(n) === 1 ? word : many}`;
}
// Money for labels: '$31.8K', '$5,400', '$7.65'.
function money(v) {
  return v >= 1e4 ? '$' + compact(v) : usd(v);
}

// ---------- measuring text ----------

// Advance widths in hundredths of an em for ASCII 32..126, the widest of ABC Diatype, Helvetica Neue, Helvetica and
// Arial at each weight (measured in Chromium, 2026-11-21), so a line that fits here fits in any of those fonts.
const ADV = {
  700: '28,33,47,65,61,100,72,28,33,33,41,60,28,41,28,43,64,56,59,61,63,59,62,56,61,61,33,33,60,60,60,61,98,72,72,74,74,67,61,78,74,30,56,72,61,95,78,78,67,78,72,67,61,74,70,104,67,67,65,33,43,33,60,61,33,57,61,57,61,57,35,61,61,28,28,57,28,91,61,61,61,61,39,56,38,61,56,81,56,56,52,39,28,39,60'
    .split(',')
    .map(Number),
  500: '28,28,44,63,60,100,67,28,33,33,40,60,28,39,28,42,62,56,58,59,61,58,61,56,61,60,28,28,60,60,60,56,102,69,70,72,73,67,61,78,74,28,55,69,57,95,77,78,67,78,72,67,61,72,67,99,67,67,63,31,42,30,60,58,33,56,61,56,61,56,33,59,57,24,25,54,24,87,57,59,61,61,35,52,35,57,52,79,54,52,50,33,26,33,60'
    .split(',')
    .map(Number),
};
const ADV_X = { '·': 33, '–': 56, '—': 100, '…': 100, '’': 28, '‘': 28, '“': 50, '”': 50 };

// Width in px of `s` at `size`, with letter-spacing `ls` (em) after every character, as SVG text renders it.
export function measure(s, size, { weight = 700, ls = -0.04 } = {}) {
  const t = ADV[weight >= 600 ? 700 : 500];
  let em = 0;
  for (const c of String(s)) {
    const k = c.codePointAt(0);
    em += (k >= 32 && k < 127 ? t[k - 32] : ADV_X[c] ?? 60) / 100 + ls;
  }
  return em * size;
}

// Largest size up to `max` at which `s` fits in `width`.
export function fit(s, width, max, opts = {}) {
  const per = measure(s, 1, opts);
  return Math.floor(Math.min(max, per > 0 ? width / per : max));
}

// Wrap to `width` at `size`, then balance: never a 1-word last line, and no last line under 35% of the measure
// when a word can move down.
export function wrap(s, size, width, opts = {}) {
  const words = String(s).split(/\s+/).filter(Boolean);
  const w = (l) => measure(l.join(' '), size, opts);
  const out = [];
  let cur = [];
  for (const word of words) {
    if (cur.length && w([...cur, word]) > width) {
      out.push(cur);
      cur = [word];
    } else cur.push(word);
  }
  if (cur.length) out.push(cur);
  for (let i = 0; i < 4 && out.length > 1; i++) {
    const last = out[out.length - 1];
    const prev = out[out.length - 2];
    const short = last.length === 1 || w(last) < width * 0.35;
    if (!short || prev.length < 2) break;
    const moved = [prev[prev.length - 1], ...last];
    if (w(moved) > width) break;
    prev.pop();
    out[out.length - 1] = moved;
  }
  return out.map((l) => l.join(' '));
}

// `s` cut at a word boundary (or a character, for one long word) with '…' so it fits in `width`.
export function clipTo(s, width, size, opts = {}) {
  s = String(s);
  if (measure(s, size, opts) <= width) return s;
  const words = s.split(' ');
  while (words.length > 1) {
    words.pop();
    const t = words.join(' ').replace(/[\s,·:-]+$/, '') + '…';
    if (measure(t, size, opts) <= width) return t;
  }
  let t = words[0] || '';
  while (t.length > 1 && measure(t + '…', size, opts) > width) t = t.slice(0, -1);
  return t + '…';
}

// ---------- svg helpers ----------

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const f1 = (v) => +v.toFixed(1);

function text(x, y, s, { size = 48, fill = P.white, anchor = 'start', weight = 700, op = 1, ls = -0.03 } = {}) {
  const parts = Array.isArray(s) ? s : [[s]];
  const body = parts.map(([t, color]) => (color ? `<tspan fill="${color}">${esc(t)}</tspan>` : esc(t))).join('');
  return `<text x="${f1(x)}" y="${f1(y)}" font-family="${esc(FONT)}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" letter-spacing="${(size * ls).toFixed(2)}"${op < 1 ? ` opacity="${op}"` : ''}>${body}</text>`;
}

// Soft clouds, like the sky on ernd.ai: [cx, cy, rx, ry, opacity].
function clouds(id, list, clip = '') {
  return (
    `<g filter="url(#cloud-${id})"${clip}>` +
    list.map(([cx, cy, rx, ry, op]) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="#fff" opacity="${op}"/>`).join('') +
    `</g>`
  );
}

// The sun: a peach circle with one thin white ring.
function sun(cx, cy, r, ring) {
  return (
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${P.peach}" opacity="0.95"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${ring}" fill="none" stroke="${P.white}" stroke-width="6" opacity="0.6"/>`
  );
}

// A bar on a baseline: rx = min(6, w/4), at least 4px tall when the value is above zero, nothing for zero.
function bar(x, base, w, h, fill, op = 1) {
  if (!(h > 0)) return '';
  const hh = Math.max(4, h);
  return `<rect x="${f1(x)}" y="${f1(base - hh)}" width="${f1(w)}" height="${f1(hh)}" rx="${f1(Math.min(6, w / 4))}" fill="${fill}"${op < 1 ? ` opacity="${op}"` : ''}/>`;
}

// How a ring for fraction f is drawn, so the round caps sit inside the true extent and the two ends can never
// meet or leave a notch: a closed ring when the gap would be under 12px (or f >= 0.995), a dot when the arc is
// shorter than its stroke, otherwise a dash of c*f - sw starting sw/2 past 12 o'clock.
export function arcDash(r, sw, f) {
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, Number(f) || 0));
  if (v <= 0) return { kind: 'none', c };
  if (v >= 0.995 || c * (1 - v) < 12) return { kind: 'ring', c };
  if (c * v < sw) return { kind: 'dot', c };
  return { kind: 'arc', c, dash: Math.max(0, c * v - sw), offset: -sw / 2 };
}

function arc(cx, cy, r, sw, f, stroke, op = 1) {
  const a = arcDash(r, sw, f);
  const o = op < 1 ? ` opacity="${op}"` : '';
  if (a.kind === 'none') return '';
  if (a.kind === 'ring') return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${stroke}" stroke-width="${sw}"${o}/>`;
  if (a.kind === 'dot') return `<circle cx="${cx}" cy="${cy - r}" r="${sw / 2}" fill="${stroke}"${o}/>`;
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-dasharray="${a.dash.toFixed(1)} ${a.c.toFixed(1)}" stroke-dashoffset="${a.offset}" transform="rotate(-90 ${cx} ${cy})"${o}/>`;
}

// A row of dots as one path: dasharray "0 step" with round caps. The path runs half a step past the last dot,
// since a path whose length is an exact multiple of the step drops its last dot.
function dotRow(x0, x1, y, step, r, fill) {
  const dir = x1 >= x0 ? 1 : -1;
  return `<path d="M${f1(x0)} ${f1(y)}H${f1(x1 + (dir * step) / 2)}" fill="none" stroke="${fill}" stroke-width="${f1(r * 2)}" stroke-linecap="round" stroke-dasharray="0 ${step.toFixed(2)}"/>`;
}

// Every card: its own ids (cards share one page), the sky and dusk gradients, the ink gradient and a cloud blur.
function svg(id, { w, h }, bg, body) {
  const fill = bg === 'sky' ? `url(#sky-${id})` : bg === 'dusk' ? `url(#dusk-${id})` : bg;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs>` +
    `<linearGradient id="sky-${id}" x1="0" y1="0" x2="0.35" y2="1"><stop offset="0" stop-color="${SKY.blue}"/><stop offset="0.45" stop-color="${SKY.violet}"/><stop offset="0.78" stop-color="${SKY.purple}"/><stop offset="1" stop-color="${SKY.pink}"/></linearGradient>` +
    `<linearGradient id="dusk-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${P.night}"/><stop offset="1" stop-color="#2a2160"/></linearGradient>` +
    `<linearGradient id="ink-${id}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${SKY.blue}"/><stop offset="0.5" stop-color="${SKY.purple}"/><stop offset="1" stop-color="${SKY.pink}"/></linearGradient>` +
    `<filter id="cloud-${id}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="38"/></filter>` +
    `</defs><rect width="${w}" height="${h}" fill="${fill}"/>${body}</svg>`
  );
}

const MARK_H = 44;
const mark = (fill = P.white, x = PAD, y = 104) => wordmark(x, y, MARK_H, fill);

function card(id, label, bg, body, size = STORY) {
  return { id, label, ...size, svg: svg(id, size, bg, body) };
}

// ---------- the type scale ----------

// TITLE: 88/700, one line where possible, a second line at 490. Returns the last baseline.
function title(lines, fg) {
  const ls = Array.isArray(lines) ? lines : wrap(lines, 88, 900, { ls: -0.03 }).slice(0, 2);
  return {
    svg: ls.map((l, i) => text(PAD, 400 + i * 90, clipTo(l, 900, 88, { ls: -0.03 }), { size: 88, fill: fg })).join(''),
    y: 400 + (ls.length - 1) * 90,
  };
}

// DISPLAY: one big numeral at x 84, fitted to 860px. Baseline D = title + 40 + 0.74*size, 24 lower under a '$'
// (its top rises above cap height). The lead sits 90 below, a little lower when the display drops below the line.
function display(s, titleY, fill, { max = 280, width = 860 } = {}) {
  const size = fit(s, width, max);
  const D = Math.round(titleY + 40 + 0.74 * size + (s.includes('$') ? 24 : 0));
  const drop = /[gjpqy,]/.test(s) ? Math.round(0.045 * size) : 0;
  return { svg: text(PAD - 6, D, s, { size, fill, ls: -0.04 }), D, lead: D + 90 + drop, size };
}

// LEAD: 60/500 at 0.9, fitted down to 48 when it is long, then clipped.
function lead(y, s, fg, { x = PAD, anchor = 'start', width = 900 } = {}) {
  const parts = Array.isArray(s) ? s : [[s]];
  const plain = parts.map((p) => p[0]).join('');
  const o = { weight: 500, ls: -0.02 };
  const size = Math.max(48, fit(plain, width, 60, o));
  const body = measure(plain, size, o) <= width ? parts : [[clipTo(plain, width, size, o)]];
  return text(x, y, body, { size, fill: fg, weight: 500, op: 0.9, ls: -0.02, anchor });
}

// CAPTION: one 40px line at 1600. Trailing parts drop off until it fits in 900px; a lone part is clipped.
function caption(parts, fg) {
  const o = { weight: 500, ls: -0.01 };
  let ps = parts.filter(Boolean);
  while (ps.length > 1 && measure(ps.join(' · '), 40, o) > 900) ps = ps.slice(0, -1);
  if (!ps.length) return '';
  return text(PAD, CAPTION_Y, clipTo(ps.join(' · '), 900, 40, o), { size: 40, fill: fg, weight: 500, op: 0.7, ls: -0.01 });
}

const small = (x, y, s, fill, { op = 0.7, anchor = 'start', size = 40 } = {}) =>
  text(x, y, s, { size, fill, op, anchor, weight: 500, ls: -0.01 });

// ---------- names ----------

// "claude-opus-5-5" -> "Claude Opus 5.5", "gpt-6.1-sol" -> "GPT-6.1 Sol", "deepseek-v4.1-flash-1017" ->
// "DeepSeek V4.1 Flash", "kimi-k3" -> "Kimi K3". Dated snapshots and provider prefixes are dropped.
const BRANDS = { deepseek: 'DeepSeek', gpt: 'GPT', glm: 'GLM', qwen: 'Qwen', llama: 'Llama', grok: 'Grok', kimi: 'Kimi', gemma: 'Gemma', mistral: 'Mistral', codestral: 'Codestral', devstral: 'Devstral', minimax: 'MiniMax', ai: 'AI' };
export function prettyModel(id) {
  let m = String(id || '').replace(/^[a-z0-9-]+\//i, '').replace(/-\d{8}$/, '').replace(/\[1m\]$/, '');
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(m);
  if (claude) return `Claude ${cap(claude[1])} ${claude[2]}${claude[3] ? '.' + claude[3] : ''}`;
  const gpt = /^gpt-([\d.]+)(?:-(.+))?$/.exec(m);
  if (gpt) return `GPT-${gpt[1]}${gpt[2] ? ' ' + gpt[2].split('-').map(cap).join(' ') : ''}`;
  const gem = /^gemini-([\d.]+)-(.+)$/.exec(m);
  if (gem) return `Gemini ${gem[1]} ${gem[2].split('-').map(cap).join(' ')}`;
  if (!/^[a-z0-9.-]+$/.test(m) || !m.includes('-')) return BRANDS[m] || m;
  const words = m.replace(/-\d{4}$/, '').split('-').filter(Boolean);
  return words
    .map((w) => BRANDS[w] || (/^o\d/.test(w) ? w : /^v\d/.test(w) ? 'V' + w.slice(1) : cap(w)))
    .join(' ');
}
const cap = (w) => (w ? w[0].toUpperCase() + w.slice(1) : w);

const LANG = { py: 'Python', ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', go: 'Go', rs: 'Rust', rb: 'Ruby', java: 'Java', kt: 'Kotlin', swift: 'Swift', c: 'C', cc: 'C++', cpp: 'C++', h: 'C', cs: 'C#', php: 'PHP', sql: 'SQL', sh: 'Shell', md: 'Markdown', html: 'HTML', css: 'CSS', json: 'JSON', yaml: 'YAML', yml: 'YAML', vue: 'Vue', svelte: 'Svelte', ex: 'Elixir', scala: 'Scala', dart: 'Dart', lua: 'Lua', r: 'R', ipynb: 'Notebooks' };
export const langName = (ext) => LANG[ext] || ext.toUpperCase();

// 'midnight', '1am', 'noon', '6pm'.
export function hourLabel(h) {
  if (h === 0) return 'midnight';
  if (h === 12) return 'noon';
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

// Hours as the person would say them: "20.6 hours", "1 hour", "2.1 days". Never a trailing '.0'.
export function duration(hours) {
  if (hours >= 48) {
    const d = +(hours / 24).toFixed(hours >= 240 ? 0 : 1);
    return `${d.toLocaleString('en-US')} ${d === 1 ? 'day' : 'days'}`;
  }
  const h = +hours.toFixed(1);
  return `${h} ${h === 1 ? 'hour' : 'hours'}`;
}
const shortDuration = (hours) => (hours >= 48 ? duration(hours) : `${+hours.toFixed(1)}h`);

// Your agents' writing as a person typing it, in the biggest unit that reads well (a work year is 2,000 hours).
// `value` is the number in that unit, for the keyboard (1 key = 1 unit).
export function typingTime(hours) {
  const show = (x) => (x >= 10 ? n0(x) : String(+x.toFixed(1)));
  const years = hours / 2000;
  if (years >= 1) return { n: show(years), value: years, unit: years < 1.05 ? 'year' : 'years', one: 'year', of: 'of full-time typing' };
  const weeks = hours / 40;
  if (weeks >= 1) return { n: show(weeks), value: weeks, unit: weeks < 1.05 ? 'week' : 'weeks', one: 'week', of: 'of full-time typing' };
  return { n: show(hours), value: hours, unit: hours < 1.05 ? 'hour' : 'hours', one: 'hour', of: 'of nonstop typing' };
}

// Token totals by week (7-day blocks from the first day in the calendar), or by day for spans of 60 days or less.
// Starts at the first day with any usage, so the axis shows the true start.
export function usageBins(u) {
  const days = u?.days || [];
  const first = days.findIndex((d) => d.tokens > 0 || d.replies > 0);
  if (first < 0) return { daily: true, bins: [] };
  const span = days.slice(first);
  const daily = span.length <= 60;
  const size = daily ? 1 : 7;
  const bins = [];
  for (let i = 0; i < span.length; i += size) {
    const block = span.slice(i, i + size);
    bins.push({
      start: block[0].date,
      tokens: block.reduce((a, d) => a + (d.tokens || 0), 0),
      active: block.some((d) => d.replies > 0 || d.tokens > 0),
      dates: block.map((d) => d.date),
    });
  }
  return { daily, bins };
}

// ---------- the cards ----------

function introCard(d) {
  const id = 'intro';
  const body =
    clouds(id, [[200, 420, 380, 90, 0.5], [860, 760, 420, 110, 0.4], [300, 1500, 340, 120, 0.45], [900, 1760, 360, 90, 0.4]]) +
    sun(740, 560, 160, 240) +
    mark() +
    text(84, 1100, 'Your', { size: 240, fill: P.white, ls: -0.05 }) +
    text(84, 1330, String(d.year), { size: 240, fill: P.white, ls: -0.05 }) +
    text(84, 1560, 'in AI', { size: 240, fill: P.night, ls: -0.05 });
  return card(id, 'Intro', 'sky', body);
}

// You used 79.7B tokens: 313 read for every 1 written, as a grid of dots (mist = read, peach = written).
function tokensCard(d) {
  const u = d.usage;
  const id = 'tokens';
  const t = u.tokens;
  const t0 = title('You used', P.white);
  const h = display(compact(t.total), t0.y, `url(#ink-${id})`);
  let body = mark() + t0.svg + h.svg;
  const input = Number(t.input) || 0;
  const output = Number(t.output) || 0;
  const caps = [dateRange(u.since, u.until)];
  if (input > 0 && output > 0) {
    const readMore = input >= output;
    const big = readMore ? input : output;
    const smallT = readMore ? output : input;
    const N = Math.max(1, Math.round(big / smallT));
    const phrase = readMore ? `${n0(N)} read for every 1 written` : `${n0(N)} written for every 1 read`;
    body += lead(h.lead, [['tokens · '], [phrase, P.peach]], P.white);
    // Each dot is the smaller amount; past 315 dots each one stands for k of them, and the odd dot shrinks to match.
    const MAXD = 315;
    const k = N + 1 > MAXD ? Math.ceil(N / (MAXD - 1)) : 1;
    const many = Math.max(1, Math.round(N / k));
    const total = many + 1;
    let cols = 21;
    for (const c of [5, 7, 10, 14, 21]) {
      const step = 900 / (c - 1 + 0.548);
      if ((Math.ceil(total / c) - 1) * step * 0.98 + step * 0.548 <= 640) {
        cols = c;
        break;
      }
    }
    const step = 900 / (cols - 1 + 0.548);
    const r = step * 0.274;
    const pitch = step * 0.98;
    const y0 = Math.max(880, h.lead + 110) + r;
    const bigFill = readMore ? P.mist : P.peach;
    const oneFill = readMore ? P.peach : P.mist;
    for (let row = 0; row * cols < many; row++) {
      const n = Math.min(cols, many - row * cols);
      body += dotRow(PAD + r, PAD + r + (n - 1) * step, y0 + row * pitch, step, r, bigFill);
    }
    const li = many; // the odd dot follows the last one in reading order
    const ox = PAD + r + (li % cols) * step;
    const oy = y0 + Math.floor(li / cols) * pitch;
    body += `<circle cx="${f1(ox)}" cy="${f1(oy)}" r="${f1(Math.max(4, r / Math.sqrt(k)))}" fill="${oneFill}"/>`;
    caps.push(`1 dot = ${compact(smallT * k)} tokens`);
  } else {
    body += lead(h.lead, 'tokens', P.white);
  }
  body += caption(caps, P.white);
  return card(id, 'Tokens', 'dusk', body);
}

// Where each agent's segment and label go in the value block: segments proportional to dollars with 6px gaps;
// a label inside when the segment is 240px or wider, otherwise under the block, left-aligned and kept off its
// neighbour and inside x 990 (dropped when it can't be).
function blockLayout(segs) {
  const tot = segs.reduce((a, x) => a + x.api, 0) || 1;
  const avail = 900 - 6 * (segs.length - 1);
  let x = PAD;
  let prevEnd = -Infinity;
  let dropped = 0;
  const out = segs.map((s) => {
    const w = segs.length === 1 ? 900 : Math.max(6, (avail * s.api) / tot);
    const amount = money(s.api);
    const o = { ls: -0.02 };
    const seg = { ...s, x, w, amount };
    if (w >= 240) {
      seg.inside = true;
      seg.size = Math.max(40, fit(s.name, w - 72, 48, o));
      seg.name = clipTo(s.name, w - 72, seg.size, o);
    } else {
      seg.below = true;
      seg.name = clipTo(s.name, 420, 40, o);
      const lw = Math.max(measure(seg.name, 40, o), measure(amount, 40, { weight: 500, ls: -0.01 }));
      const lx = Math.max(Math.min(x, RIGHT - lw), prevEnd + 24);
      if (lx + lw <= RIGHT) {
        seg.lx = lx;
        prevEnd = lx + lw;
      } else dropped++;
    }
    x += w + 6;
    return seg;
  });
  return { segs: out, dropped, below: out.some((s) => s.below) };
}

// "At API prices": what the year would have cost billed per token, split by agent, or next to a plan's price.
// plan: null for the plain card; dollars a month for the variants the recap page lets people pick.
export function valueCard(d, plan = null) {
  const v = d.value;
  const u = d.usage;
  const id = plan == null ? 'value' : `value-${plan}`;
  const fg = P.ink;
  const t0 = title(['Your year at', 'API prices'], fg);
  const h = display(usd(v.api), t0.y, fg);
  let body = mark(fg) + t0.svg + h.svg;
  if (plan) {
    const paid = plan * v.months;
    const x = paid ? v.api / paid : 0;
    body += lead(h.lead, `On a $${plan}/month plan you paid`, fg);
    body += lead(h.lead + 70, `${usd(paid)} for ${plural(v.months, 'month')}.`, fg);
    if (x >= 1.5) {
      const xs = `${x >= 10 ? n0(x) : x.toFixed(1)}x`;
      const s = fit(xs, 860, 240);
      const y = h.lead + 70 + 40 + 0.74 * s;
      body += text(PAD - 6, y, xs, { size: s, fill: P.violet, ls: -0.04 });
      body += lead(y + 90, 'what you paid', fg);
      // Two bars: the API price, and what the plan cost, to the same scale.
      const by = y + 170;
      if (by + 150 < 1540) {
        body += `<rect x="${PAD}" y="${f1(by)}" width="900" height="48" rx="12" fill="${P.violet}"/>`;
        body += `<rect x="${PAD}" y="${f1(by + 78)}" width="${f1(Math.max(24, (900 * paid) / v.api))}" height="48" rx="12" fill="${P.ink}" opacity="0.85"/>`;
      }
    }
    body += caption([dateRange(u.since, u.until), 'list-price estimate'], fg);
    return card(id, 'API prices', P.mist, body);
  }
  // A 100% block split by agent: top 3 plus 'Other'; anything under 2% joins Other; Other under 2% isn't drawn.
  const hs = (v.byHarness || []).filter((x) => x.api > 0).sort((a, b) => b.api - a.api);
  const sum = hs.reduce((a, x) => a + x.api, 0);
  let segs;
  if (!sum) {
    segs = [{ name: u.sources?.length === 1 ? u.sources[0] : 'All agents', api: v.api }];
  } else {
    let main = hs.filter((x) => x.api / sum >= 0.02).slice(0, 3);
    const build = () => {
      const rest = sum - main.reduce((a, x) => a + x.api, 0);
      return [...main, ...(rest / sum >= 0.02 ? [{ name: 'Other', api: rest, other: true }] : [])];
    };
    segs = build();
    // Narrow agents get their label under the block (2 at most). One whose label can't be placed joins Other.
    const bad = (ss) => {
      const l = blockLayout(ss);
      return l.segs.filter((x) => x.below).length > 2 || l.dropped > 0;
    };
    while (main.length > 1 && bad(segs)) {
      main = main.slice(0, -1);
      segs = build();
    }
  }
  const L = blockLayout(segs);
  const fills = [P.violet, P.blue, P.purple];
  const top = 860, bottom = L.below ? 1380 : 1440, R = 32;
  L.segs.forEach((s, i) => {
    const { x, w } = s;
    const fill = s.other ? P.pink : fills[i];
    const first = i === 0, last = i === L.segs.length - 1;
    const r = Math.min(R, w);
    const x1 = x + w;
    const d =
      `M${f1(first ? x + r : x)} ${top}H${f1(last ? x1 - r : x1)}` +
      (last ? `A${r} ${r} 0 0 1 ${f1(x1)} ${top + r}V${bottom - r}A${r} ${r} 0 0 1 ${f1(x1 - r)} ${bottom}` : `V${bottom}`) +
      `H${f1(first ? x + r : x)}` +
      (first ? `A${r} ${r} 0 0 1 ${f1(x)} ${bottom - r}V${top + r}A${r} ${r} 0 0 1 ${f1(x + r)} ${top}Z` : `Z`);
    body += `<path d="${d}" fill="${fill}"/>`;
    if (s.inside) {
      body += text(x + 36, 940, s.name, { size: s.size, fill: P.white, ls: -0.02 });
      body += text(x + 36, 996, s.amount, { size: 40, fill: P.white, weight: 500, op: 0.85, ls: -0.01 });
    } else if (s.lx != null) {
      body += text(s.lx, 1440, s.name, { size: 40, fill: fg, ls: -0.02 });
      body += text(s.lx, 1490, s.amount, { size: 40, fill: fg, weight: 500, op: 0.7, ls: -0.01 });
    }
  });
  body += caption([dateRange(u.since, u.until), 'list-price estimate'], fg);
  return card(id, 'API prices', P.mist, body);
}

// Rows for the two list cards (agents and models): rank, name, meta and a bar of share of all tokens.
// spec: { nameTop, nameRest, nameY, metaY, metaY1, barY, barH, track, fill, fg, metaOp, floor }
function listRows(rows, s) {
  let body = '';
  const n = rows.length;
  const pitch = 1000 / Math.max(n, 4);
  rows.forEach((r, i) => {
    const top = 560 + i * pitch;
    if (r.more) {
      body += text(200, top + s.nameY, r.name, { size: 72, fill: s.fg, op: 0.5 });
      return;
    }
    body += text(PAD, top + s.nameY, String(i + 1), { size: 64, fill: s.fg, op: 0.45 });
    const max = i === 0 ? s.nameTop : s.nameRest;
    const ns = Math.max(s.floor, fit(r.name, 790, max, { ls: -0.03 }));
    body += text(200, top + s.nameY, clipTo(r.name, 790, ns, { ls: -0.03 }), { size: ns, fill: s.fg });
    body += text(200, top + (i === 0 ? s.metaY1 : s.metaY), clipTo(r.meta, 790, 40, { weight: 500, ls: -0.01 }), { size: 40, fill: s.fg, weight: 500, op: s.metaOp, ls: -0.01 });
    const by = top + s.barY;
    const rr = s.barH / 2;
    if (r.share == null) {
      body += `<rect x="200" y="${f1(by)}" width="790" height="${s.barH}" rx="${rr}" fill="none" stroke="${s.fg}" stroke-opacity="0.4" stroke-width="2" stroke-dasharray="10 8"/>`;
      return;
    }
    body += `<rect x="200" y="${f1(by)}" width="790" height="${s.barH}" rx="${rr}" fill="${s.track[0]}" opacity="${s.track[1]}"/>`;
    if (r.share > 0) body += `<rect x="200" y="${f1(by)}" width="${f1(Math.max(24, 790 * Math.min(1, r.share)))}" height="${s.barH}" rx="${rr}" fill="${s.fill[0]}"${s.fill[1] < 1 ? ` opacity="${s.fill[1]}"` : ''}/>`;
  });
  return body;
}

// One item: its name big, and its share of all tokens.
function soloRow(name, leadText, meta, fg) {
  const ns = Math.max(56, fit(name, 900, 120, { ls: -0.03 }));
  return (
    text(PAD, 820, clipTo(name, 900, ns, { ls: -0.03 }), { size: ns, fill: fg }) +
    lead(910, leadText, fg) +
    (meta ? small(PAD, 980, clipTo(meta, 900, 40, { weight: 500, ls: -0.01 }), fg) : '')
  );
}

function harnessCard(d) {
  const u = d.usage;
  const id = 'harnesses';
  const fg = P.ink;
  const hs = u.harnesses;
  const known = hs.filter((h) => h.tokensKnown).reduce((a, h) => a + h.tokens, 0);
  const meta = (h) => (h.tokensKnown ? `${compact(h.tokens)} tokens · ${plural(h.days, 'day')}` : `${plural(h.replies, 'message')} · ${plural(h.days, 'day')}`);
  let body = mark(fg) + title('Your coding agents', fg).svg;
  if (hs.length === 1) {
    const h = hs[0];
    body += soloRow(h.name, h.tokensKnown && known ? `${pct(h.tokens / known)} of your tokens` : plural(h.replies, 'message'), meta(h), fg);
    return card(id, 'Agents', P.peach, body);
  }
  const shown = hs.length > 5 ? hs.slice(0, 4) : hs;
  const rows = shown.map((h) => ({ name: h.name, meta: meta(h), share: h.tokensKnown ? (known ? h.tokens / known : 0) : null }));
  if (hs.length > 5) rows.push({ more: true, name: `+${hs.length - 4} more` });
  body += listRows(rows, { nameTop: 96, nameRest: 72, nameY: 80, metaY: 136, metaY1: 136, barY: 164, barH: 24, track: [P.ink, 0.1], fill: [P.ink, 0.85], fg, metaOp: 0.7, floor: 56 });
  return card(id, 'Agents', P.peach, body);
}

function modelsCard(d) {
  const id = 'models';
  const fg = P.white;
  const total = d.usage?.tokens?.total || d.models.reduce((a, m) => a + m.tokens, 0);
  let body = mark(fg) + title('Your top models', fg).svg;
  if (d.models.length === 1) {
    const m = d.models[0];
    body += soloRow(m.name, `${pct(total ? m.tokens / total : 1)} of your tokens`, `${compact(m.tokens)} tokens`, fg);
    return card(id, 'Top models', P.violet, body);
  }
  const rows = d.models.map((m, i) => ({ name: m.name, meta: i === 0 ? `${compact(m.tokens)} tokens` : compact(m.tokens), share: total ? m.tokens / total : 0 }));
  body += listRows(rows, { nameTop: 88, nameRest: 64, nameY: 72, metaY: 124, metaY1: 130, barY: 146, barH: 20, track: [P.white, 0.15], fill: [P.mist, 1], fg, metaOp: 0.8, floor: 48 });
  return card(id, 'Top models', P.violet, body);
}

function cacheCard(d) {
  const u = d.usage;
  const fg = P.ink;
  const cx = 540, cy = 960, r = 300, sw = 96;
  let body = mark(fg) + title('Read from cache', fg).svg;
  body += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${P.violet}" stroke-width="${sw}" opacity="0.18"/>`;
  body += arc(cx, cy, r, sw, u.cacheHit, P.violet);
  const big = pct(u.cacheHit);
  const s = fit(big, 400, 220);
  body += text(cx, cy + 0.37 * s, big, { size: s, fill: fg, anchor: 'middle', ls: -0.04 });
  body += lead(1420, `${compact(u.tokens.cached)} of ${compact(u.tokens.input)} input tokens`, fg);
  return card('cache', 'Cache', P.mist, body);
}

// Most agents at once: the main session as a sun, every other agent a dot on up to 4 evenly filled orbits.
function swarmCard(d) {
  const u = d.usage;
  const g = u.together;
  const id = 'swarm';
  const cx = 540, cy = 760;
  const others = g.agents - 1;
  const k = others > 159 ? Math.ceil(others / 159) : 1;
  const dots = Math.ceil(others / k);
  let rings;
  if (dots <= 7) rings = [{ r: 240, n: dots }];
  else {
    const radii = [150, 230, 310, 390];
    let m = 1;
    while (m < 4 && radii.slice(0, m).reduce((a, r) => a + 2 * Math.PI * r, 0) / dots < 60) m++;
    const use = radii.slice(0, m);
    const circ = use.reduce((a, r) => a + r, 0);
    const raw = use.map((r) => (dots * r) / circ);
    const n = raw.map(Math.floor);
    let left = dots - n.reduce((a, b) => a + b, 0);
    raw.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => left-- > 0 && n[i]++);
    rings = use.map((r, i) => ({ r, n: n[i] }));
  }
  const pitch = rings.reduce((a, x) => a + 2 * Math.PI * x.r, 0) / Math.max(1, dots);
  const dr = dots <= 7 ? 30 : Math.max(8, Math.min(22, Math.round(pitch * 0.24)));
  const colors = [P.white, P.mist, P.peach, P.pink];
  let body = mark();
  for (const ring of rings) body += `<circle cx="${cx}" cy="${cy}" r="${ring.r}" fill="none" stroke="${P.white}" stroke-width="2" opacity="0.15"/>`;
  body += sun(cx, cy, 64, 92);
  rings.forEach((ring, i) => {
    const step = (2 * Math.PI) / Math.max(1, ring.n);
    const start = -Math.PI / 2 + ((i * 0.382) % 1) * step;
    const rr = Math.max(6, dr - 2 * i);
    for (let j = 0; j < ring.n; j++) {
      const a = start + j * step;
      body += `<circle cx="${f1(cx + Math.cos(a) * ring.r)}" cy="${f1(cy + Math.sin(a) * ring.r)}" r="${rr}" fill="${colors[i]}"/>`;
    }
  });
  const big = n0(g.agents);
  body += text(PAD - 6, 1380, big, { size: fit(big, 860, 280), fill: P.white, ls: -0.04 });
  body += lead(1470, g.agents === 1 ? 'agent at once' : 'agents at once', P.white);
  body += caption([`${shortDate(g.date)}, ${hourLabel(g.hour)}`, k > 1 ? `1 dot = ${n0(k)} agents` : '', 'subagents included'], P.white);
  return card(id, 'At once', 'dusk', body);
}

function peakCard(d) {
  const u = d.usage;
  const id = 'peak';
  const fg = P.white;
  const t0 = title('Your biggest day', fg);
  const h = display(shortDate(u.peak.date), t0.y, fg);
  let body = mark() + t0.svg + h.svg + lead(h.lead, `${compact(u.peak.tokens)} tokens`, fg);
  const { bins } = usageBins(u);
  const base = 1440, hmax = 560;
  const max = Math.max(...bins.map((b) => b.tokens), 1);
  const pitchX = 900 / Math.max(1, bins.length);
  const bw = Math.max(2, Math.min(48, pitchX * 0.72));
  bins.forEach((b, i) => {
    const x = PAD + i * pitchX + (pitchX - bw) / 2;
    const isPeak = b.dates.includes(u.peak.date);
    if (b.tokens > 0) body += bar(x, base, bw, (hmax * b.tokens) / max, isPeak ? P.peach : P.white, isPeak ? 1 : 0.55);
    else if (b.active) body += `<circle cx="${f1(x + bw / 2)}" cy="${base - 4}" r="3" fill="${P.white}" opacity="0.35"/>`;
  });
  body += `<rect x="${PAD}" y="${base + 1}" width="900" height="2" fill="${P.white}" opacity="0.35"/>`;
  if (bins.length) {
    const a = shortDate(bins[0].start), z = shortDate(u.until);
    body += small(PAD, 1500, a, fg);
    if (z !== a) body += small(RIGHT, 1500, z, fg, { anchor: 'end' });
  }
  const share = u.tokens.total ? u.peak.tokens / u.tokens.total : 0;
  body += caption([u.activeDays === 1 ? 'Your one active day' : `${pct(share)} of your year in one day`], fg);
  return card(id, 'Biggest day', P.blue, body);
}

// Longest session: a ring where a full lap is 24 hours; longer sessions add inner laps (at most 3).
function marathonCard(d) {
  const M = d.usage.longestSession;
  const id = 'marathon';
  const fg = P.white;
  const cx = 540, cy = 880;
  let body =
    clouds(id, [[860, 1460, 420, 100, 0.3], [220, 1790, 400, 90, 0.3]], ` clip-path="url(#low-${id})"`) +
    `<clipPath id="low-${id}"><rect x="0" y="1300" width="1080" height="620"/></clipPath>` +
    mark() +
    title('Your longest session', fg).svg;
  const laps = [[300, 64], [210, 44], [130, 30]];
  const days = M.hours / 24;
  const used = Math.min(3, Math.max(1, Math.ceil(days - 1e-9)));
  for (let i = 0; i < used; i++) {
    const [r, sw] = laps[i];
    body += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${P.white}" stroke-width="${sw}" opacity="0.25"/>`;
    const f = i < used - 1 ? 1 : Math.min(1, days - i);
    body += arc(cx, cy, r, sw, f, P.peach);
  }
  const [ir, isw] = laps[used - 1];
  const hole = ir - isw / 2;
  const [num, ...unit] = duration(M.hours).split(' ');
  const s = Math.min(200, fit(num, hole * 1.5, 200), Math.floor(hole * 0.9));
  const us = Math.max(40, Math.min(52, Math.round(0.26 * s)));
  const block = 0.72 * s + 0.18 * s + 0.72 * us;
  const ny = cy - block / 2 + 0.72 * s;
  body += text(cx, ny, num, { size: s, fill: fg, anchor: 'middle', ls: -0.04 });
  body += text(cx, ny + 0.18 * s + 0.72 * us, unit.join(' '), { size: us, fill: fg, anchor: 'middle', weight: 500, op: 0.9, ls: -0.02 });
  body += lead(1340, `One ${M.harness} session`, fg);
  body += caption([M.date ? shortDate(M.date) : '', 'no break over 30 min'], fg);
  return card(id, 'Longest session', 'sky', body);
}

function rhythmCard(d) {
  const u = d.usage;
  const id = 'rhythm';
  const fg = P.white;
  const t0 = title('Your busiest hour', fg);
  const h = display(hourLabel(u.busiestHour), t0.y, P.peach);
  let body = mark() + t0.svg + h.svg;
  const base = 1400, hmax = 520, pitchX = 38, bw = 26;
  const max = Math.max(...u.hours, 1);
  u.hours.forEach((v, hr) => {
    const x = PAD + hr * pitchX;
    const lit = hr === u.busiestHour;
    if (v > 0) body += bar(x, base, bw, (hmax * v) / max, lit ? P.peach : P.violet);
    else body += `<circle cx="${x + bw / 2}" cy="${base - 4}" r="4" fill="${P.white}" opacity="0.25"/>`;
  });
  body += `<rect x="${PAD}" y="${base + 1}" width="900" height="2" fill="${P.white}" opacity="0.35"/>`;
  body += small(PAD, 1460, '12am', fg);
  for (const [hr, l] of [[6, '6am'], [12, 'noon'], [18, '6pm']]) body += small(PAD + hr * pitchX + bw / 2, 1460, l, fg, { anchor: 'middle' });
  const days = `${n0(u.activeDays)} of ${plural(u.days.length, 'day')}`;
  body += caption([u.streak > 1 ? `${u.streak}-day streak` : '', days], fg);
  return card(id, 'Rhythm', 'dusk', body);
}

// Longest solo run: the most actions an agent took between two of your messages, as a snaking trail of beads.
function leashCard(d) {
  const L = d.usage.leash;
  const id = 'leash';
  const fg = P.ink;
  const A = L.actions;
  const t0 = title('Longest solo run', fg);
  const h = display(n0(A), t0.y, fg);
  let body = mark(fg) + t0.svg + h.svg + lead(h.lead, A === 1 ? 'action without you' : 'actions without you', fg);
  const per = A > 200 ? Math.ceil(A / 200) : 1;
  const beads = Math.ceil(A / per);
  const cols = A > 200 ? 20 : Math.max(4, Math.min(20, Math.ceil(Math.sqrt(beads * 1.8))));
  const rows = Math.ceil(beads / cols);
  const top = Math.max(880, h.lead + 110);
  const g = Math.min(110, (1480 - top) / Math.max(1, rows - 1));
  const R = g / 2;
  const y0 = (top + 1480) / 2 - ((rows - 1) * g) / 2;
  const xl = PAD + R, xr = RIGHT - R;
  const step = (xr - xl) / (cols - 1);
  const r = Math.max(6, Math.min(30, step * 0.2));
  const at = (i) => {
    const row = Math.floor(i / cols), col = i % cols;
    return [row % 2 ? xr - col * step : xl + col * step, y0 + row * g];
  };
  // The connecting line, with U-turns at the row ends.
  const [fx, fy] = at(0);
  const [lx, ly] = at(beads - 1);
  let path = `M${f1(fx + (beads > 1 ? r * 1.8 : 0))} ${f1(fy)}`;
  for (let row = 0; row < rows; row++) {
    const y = y0 + row * g;
    const last = row === rows - 1;
    const endX = last ? lx : row % 2 ? xl : xr;
    path += `L${f1(endX)} ${f1(y)}`;
    if (!last) path += `A${f1(R)} ${f1(R)} 0 0 ${row % 2 ? 0 : 1} ${f1(endX)} ${f1(y + g)}`;
  }
  if (beads > 1) body += `<path d="${path}" fill="none" stroke="${fg}" stroke-opacity="0.2" stroke-width="4" stroke-linejoin="round"/>`;
  // Beads: one path per row; the first is a hollow ring (your message), the last a pink dot (your next one).
  for (let row = 0; row < rows; row++) {
    const a = Math.max(row * cols, 1);
    const b = Math.min((row + 1) * cols, beads - 1) - 1;
    if (b < a) continue;
    const [x0, y] = at(a);
    const [x1] = at(b);
    body += dotRow(x0, x1, y, step, r, fg);
  }
  body += `<circle cx="${f1(fx)}" cy="${f1(fy)}" r="${f1(r * 1.8)}" fill="none" stroke="${fg}" stroke-width="5"/>`;
  if (beads > 1) body += `<circle cx="${f1(lx)}" cy="${f1(ly)}" r="${f1(r * 2)}" fill="${P.pink}"/>`;
  body += caption([L.date ? shortDate(L.date) : '', per > 1 ? `1 dot = ${n0(per)} actions` : ''], fg);
  return card(id, 'Solo run', P.peach, body);
}

function builtCard(d) {
  const u = d.usage;
  const b = u.built;
  const id = 'built';
  const fg = P.white;
  const t0 = title('Your agents wrote', fg);
  const h = display(n0(b.lines), t0.y, `url(#ink-${id})`);
  let body = mark() + t0.svg + h.svg + lead(h.lead, b.lines === 1 ? 'line of code' : 'lines of code', fg);
  // Languages: top 4 plus Other, by edits, names merged (ts + tsx are both TypeScript).
  const byName = new Map();
  for (const l of b.languages || []) byName.set(langName(l.ext), (byName.get(langName(l.ext)) || 0) + (l.edits || 0));
  const langs = [...byName.entries()].filter(([, e]) => e > 0).sort((a, c) => c[1] - a[1]);
  const hasLangs = langs.length > 0;
  const statsY = hasLangs ? Math.max(900, h.lead + 220) : Math.max(1000, h.lead + 220);
  const cells = [
    [b.files, 'file', 'files'],
    [u.sessions, 'session', 'sessions'],
    [u.prompts, 'message sent', 'messages sent'],
  ].filter(([v]) => v > 0);
  const ss = Math.min(110, ...cells.map(([v]) => fit(n0(v), 280, 110)));
  cells.forEach(([v, one, many], i) => {
    const x = PAD + i * 300;
    body += text(x, statsY, n0(v), { size: ss, fill: fg, ls: -0.04 });
    body += small(x, statsY + 57, clipTo(v === 1 ? one : many, 280, 40, { weight: 500, ls: -0.01 }), fg);
  });
  if (hasLangs) {
    const all = langs.reduce((a, [, e]) => a + e, 0);
    const top = langs.slice(0, 4).map(([name, e]) => ({ name, e }));
    const rest = all - top.reduce((a, x) => a + x.e, 0);
    if (rest > 0) top.push({ name: 'Other', e: rest, other: true });
    const y0 = statsY + 260, hh = 120, R = 28;
    const avail = 900 - 6 * (top.length - 1);
    const ws = top.map((x) => Math.max(12, (avail * x.e) / all));
    const over = ws.reduce((a, w) => a + w, 0) - avail;
    ws[0] -= over; // the biggest absorbs what the 12px minimums added
    const fills = [P.blue, P.violet, P.purple, P.peach];
    let x = PAD;
    let prevEnd = -Infinity;
    top.forEach((s, i) => {
      const w = ws[i];
      const first = i === 0, last = i === top.length - 1;
      const r = Math.min(R, w);
      const x1 = x + w;
      const dd =
        `M${f1(first ? x + r : x)} ${y0}H${f1(last ? x1 - r : x1)}` +
        (last ? `A${r} ${r} 0 0 1 ${f1(x1)} ${y0 + r}V${y0 + hh - r}A${r} ${r} 0 0 1 ${f1(x1 - r)} ${y0 + hh}` : `V${y0 + hh}`) +
        `H${f1(first ? x + r : x)}` +
        (first ? `A${r} ${r} 0 0 1 ${f1(x)} ${y0 + hh - r}V${y0 + r}A${r} ${r} 0 0 1 ${f1(x + r)} ${y0}Z` : `Z`);
      body += `<path d="${dd}" fill="${s.other ? P.white : fills[i]}"${s.other ? ' fill-opacity="0.3"' : ''}/>`;
      const share = s.e / all;
      if (!s.other && share >= 0.1) {
        const p = pct(share);
        const lw = Math.max(measure(s.name, 48, { ls: -0.02 }), measure(p, 40, { weight: 500, ls: -0.01 }));
        const lx = Math.max(Math.min(x, RIGHT - lw), prevEnd + 24);
        if (lx + lw <= RIGHT) {
          body += text(lx, y0 + hh + 69, s.name, { size: 48, fill: fg, ls: -0.02 });
          body += small(lx, y0 + hh + 124, p, fg);
          prevEnd = lx + lw;
        }
      }
      x = x1 + 6;
    });
  }
  const tool = u.tools?.[0];
  if (tool) body += caption([`Top tool: ${clipTo(tool.name, 400, 40, { weight: 500, ls: -0.01 })}`, plural(tool.calls, 'call')], fg);
  return card(id, 'Built', 'dusk', body);
}

// Typing it out: what your models wrote, as a person at a keyboard. 1 key = 1 unit of the display.
function typingCard(d) {
  const T = d.usage.typing;
  const id = 'typing';
  const fg = P.white;
  const tt = typingTime(T.hours);
  const t0 = title('Typed by a person', fg);
  const h = display(`${tt.n} ${tt.unit}`, t0.y, fg);
  let body = clouds(id, [[200, 300, 360, 90, 0.4]]) + mark() + t0.svg + h.svg + lead(h.lead, tt.of, fg);
  const k = tt.value > 40 ? Math.ceil(tt.value / 40) : 1;
  const lit = Math.min(40, Math.max(1, Math.round(tt.value / k)));
  // 40 keys in 4 rows centred on their true widths; the spacebar is one key.
  const rowsK = [[12], [11], [10], [3, 'space', 3]];
  const kw = 64, gap = 12;
  let n = 0;
  rowsK.forEach((row, ri) => {
    const keys = row.flatMap((x) => (x === 'space' ? [368] : Array(x).fill(kw)));
    const width = keys.reduce((a, w) => a + w, 0) + gap * (keys.length - 1);
    let x = PAD + (900 - width) / 2;
    const y = 1020 + ri * (kw + gap);
    for (const w of keys) {
      const on = n++ < lit;
      body += `<rect x="${x}" y="${y}" width="${w}" height="${kw}" rx="12" fill="${on ? P.peach : P.white}"${on ? '' : ' opacity="0.22"'}/>`;
      x += w + gap;
    }
  });
  body += caption([`${compact(T.words)} words`, `${TYPING_WPM} wpm`, `1 key = ${k === 1 ? '1 ' + tt.one : n0(k) + ' ' + tt.one + 's'}`], fg);
  return card(id, 'Typing it out', P.blue, body);
}

function personaCard(d) {
  const p = d.persona;
  const id = 'persona';
  const cx = STORY.w / 2;
  let body = clouds(id, [[140, 1160, 360, 90, 0.35], [980, 1700, 400, 100, 0.35], [200, 1830, 420, 100, 0.35]]) + sun(cx, 700, 190, 280) + mark();
  const o = { ls: -0.04 };
  const one = fit(p.name, 900, 150, o);
  let kickerY;
  if (one >= 120) {
    body += text(cx, 1430, p.name, { size: one, fill: P.white, anchor: 'middle', ls: -0.04 });
    kickerY = 1280;
  } else {
    // Two lines, breaking after the second word so 'The' never sits alone.
    const w = p.name.split(' ');
    const ls = w.length > 2 ? [w.slice(0, 2).join(' '), w.slice(2).join(' ')] : w.length === 2 ? w : [p.name];
    const s = Math.max(110, Math.min(150, ...ls.map((l) => fit(l, 900, 150, o))));
    ls.forEach((l, i) => (body += text(cx, 1300 + i * 150, clipTo(l, 900, s, o), { size: s, fill: P.white, anchor: 'middle', ls: -0.04 })));
    kickerY = ls.length > 1 ? 1150 : 1280;
  }
  body += lead(kickerY, 'Your AI personality', P.white, { x: cx, anchor: 'middle' });
  const lo = { weight: 500, ls: -0.01 };
  body += text(cx, 1560, clipTo(p.line, 900, Math.max(40, fit(p.line, 900, 48, lo)), lo), { size: Math.max(40, fit(p.line, 900, 48, lo)), fill: P.white, anchor: 'middle', weight: 500, op: 0.9, ls: -0.01 });
  return card(id, 'Personality', 'sky', body);
}

// Up to 6 stats for the summary grid, most interesting first; missing ones are replaced by the next in line.
function stats(d) {
  const u = d.usage;
  const out = [];
  if (d.value?.api >= 1) out.push(['At API prices', usd(d.value.api), true]);
  if (u?.tokens?.total) out.push(['Tokens', compact(u.tokens.total)]);
  if (u?.together?.agents > 2) out.push(['Agents at once', n0(u.together.agents)]);
  if (u?.cacheHit != null && u.tokens?.cached > 0) out.push(['From cache', pct(u.cacheHit)]);
  if (u?.longestSession?.hours > 0) out.push(['Longest session', shortDuration(u.longestSession.hours)]);
  if (u?.built?.lines) out.push(['Lines of code', compact(u.built.lines)]);
  if (u?.busiestHour != null) out.push(['Busiest hour', hourLabel(u.busiestHour)]);
  if (u?.streak > 1) out.push(['Streak', `${u.streak} days`]);
  if (u?.peak) out.push(['Biggest day', shortDate(u.peak.date)]);
  if (u?.activeDays) out.push(['Active days', n0(u.activeDays)]);
  return out.slice(0, 6);
}

function summaryCard(d) {
  const id = 'summary';
  const fg = P.white;
  let body = mark() + sun(850, 340, 80, 130) + title(`${d.year} in AI`, fg).svg;
  const cols = [
    { x: PAD, title: 'Top agents', rows: (d.usage?.harnesses || []).map((h) => h.name).slice(0, 5) },
    { x: 560, title: 'Top models', rows: d.models.map((m) => m.name).slice(0, 5) },
  ];
  const few = Math.max(...cols.map((c) => c.rows.length)) <= 2;
  const [size, pitch] = few ? [56, 80] : [44, 62];
  for (const c of cols) {
    if (!c.rows.length) continue;
    body += small(c.x, 540, c.title, fg);
    c.rows.forEach((r, i) => {
      const y = 610 + i * pitch;
      body += text(c.x, y, String(i + 1), { size, fill: fg, op: 0.45, ls: 0 });
      const ns = Math.max(34, fit(r, 352, size, { ls: -0.02 }));
      body += text(c.x + 48, y, clipTo(r, 352, ns, { ls: -0.02 }), { size: ns, fill: fg, ls: -0.02 });
    });
  }
  const st = stats(d);
  const rowsN = Math.ceil(st.length / 2);
  const vs = Math.min(96, ...st.map(([, v]) => fit(v, 400, 96)));
  const y0 = rowsN >= 3 ? 980 : 1160;
  st.forEach(([k, v, hi], i) => {
    const x = i % 2 ? 560 : PAD;
    const y = y0 + Math.floor(i / 2) * 180;
    body += small(x, y, k, fg);
    body += text(x, y + 89, v, { size: vs, fill: hi ? P.peach : fg, ls: -0.04 });
  });
  body += caption(['ernd.ai'], fg);
  return card(id, 'Summary', 'dusk', body);
}

// The same summary, wide, for an X post: dusk, the sun, the title and six stats.
function wideCard(d) {
  const id = 'wide';
  const { w, h } = WIDE;
  const fg = P.white;
  let body = wordmark(110, 96, 40, fg) + sun(330, 560, 110, 170);
  body += text(110, 300, `${d.year} in AI`, { size: 88, fill: fg });
  body += small(110, 820, 'ernd.ai', fg);
  const st = stats(d);
  const vs = Math.min(88, ...st.map(([, v]) => fit(v, 380, 88)));
  st.forEach(([k, v, hi], i) => {
    const x = i % 2 ? 1150 : 740;
    const y = 220 + Math.floor(i / 2) * 230;
    body += small(x, y, k, fg);
    body += text(x, y + 92, v, { size: vs, fill: hi ? P.peach : fg, ls: -0.04 });
  });
  return card(id, 'For X', 'dusk', body, WIDE);
}

export function cards(d) {
  const u = d.usage;
  const story = [introCard(d)];
  if (u?.tokens?.total) story.push(tokensCard(d));
  if (d.value?.api >= 1) story.push(valueCard(d));
  if (u?.harnesses?.length) story.push(harnessCard(d));
  if (d.models.length) story.push(modelsCard(d));
  if (u?.cacheHit != null && u.tokens.cached > 0) story.push(cacheCard(d));
  if (u?.together?.agents > 2) story.push(swarmCard(d));
  if (u?.peak) story.push(peakCard(d));
  if (u?.longestSession?.hours > 0) story.push(marathonCard(d));
  if (u?.hours?.some(Boolean) && u.busiestHour != null) story.push(rhythmCard(d));
  if (u?.leash?.actions > 1) story.push(leashCard(d));
  if (u?.built?.lines) story.push(builtCard(d));
  if (u?.typing?.hours >= 1) story.push(typingCard(d));
  if (d.persona) story.push(personaCard(d));
  story.push(summaryCard(d));
  return { story, wide: wideCard(d) };
}

// ---------- page ----------

// Where "Post on X" uploads the card. The page talks to the network only here, only when that button is clicked.
export const CARD_UPLOAD_URL = 'https://tokenswrapped.com/api/card';

// Monthly plan prices to compare with: $20 (Claude Pro, ChatGPT Plus), $100 (Claude Max, ChatGPT Pro), $200 (Claude
// Ultra, ChatGPT Pro, Cursor Ultra). Official pricing pages, 2026-11-20.
export const PLANS = [20, 100, 200];

export function postText(d) {
  const u = d.usage;
  const bits = [];
  if (u?.tokens?.total) bits.push(`${compact(u.tokens.total)} tokens`);
  if (d.value?.api >= 1) bits.push(`${usd(d.value.api)} at API prices`);
  if (u?.together?.agents >= 3) bits.push(`${n0(u.together.agents)} agents at once`);
  if (u?.cacheHit != null && u.tokens.cached > 0) bits.push(`${pct(u.cacheHit)} cache hits`);
  if (u?.leash) bits.push(`${n0(u.leash.actions)} agent actions without a word from me`);
  if (u?.built?.lines) bits.push(`${compact(u.built.lines)} lines written`);
  if (u?.peak && bits.length < 5) bits.push(`biggest day ${shortDate(u.peak.date)}`);
  return `my ${d.year} in AI: ${bits.join(', ')}\n\ntokenswrapped.com`;
}

export function page(d) {
  const { story, wide } = cards(d);
  // The API-price card comes in one version per plan, so people can compare with what they pay.
  const hasValue = story.some((c) => c.id === 'value');
  const planCards = hasValue ? PLANS.map((p) => valueCard(d, p)) : [];
  const all = [...story, wide, ...planCards];
  const tpl = all.map((c) => `<template id="t-${c.id}" data-w="${c.w}" data-h="${c.h}" data-label="${esc(c.label)}">${c.svg}</template>`).join('\n');
  const intent = 'https://x.com/intent/post?text=' + encodeURIComponent(postText(d));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Your year in AI</title>
<style>
:root{--bg:#0b0a14;--fg:#ffffff;--muted:#a9a6c4;--btn:#ffffff;--btnfg:#0a0a0a}
*{box-sizing:border-box;margin:0}
body{background:radial-gradient(1200px 700px at 50% -10%,#2a2160 0%,var(--bg) 60%);color:var(--fg);font-family:${FONT};min-height:100vh;display:flex;flex-direction:column;align-items:center;gap:20px;padding:20px 16px 48px}
.player{position:relative;height:min(82vh,1000px);aspect-ratio:9/16;max-width:100%;border-radius:18px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.6);user-select:none}
.player svg{width:100%;height:100%;display:block}
.bars{position:absolute;top:12px;left:12px;right:12px;display:flex;gap:6px;z-index:2}
.bars i{flex:1;height:4px;border-radius:2px;background:rgba(255,255,255,.35);overflow:hidden}
.bars i b{display:block;height:100%;width:0;background:#fff}
.tap{position:absolute;inset:0;display:flex;z-index:1}.tap div{flex:1;cursor:pointer}
.row{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
button{font:600 15px/1 ${FONT};border:0;border-radius:999px;padding:13px 20px;cursor:pointer;background:var(--btn);color:var(--btnfg)}
button.ghost{background:transparent;color:var(--fg);box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.3)}
button.ghost:hover{box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.7)}
.share{display:flex;flex-direction:column;align-items:center;gap:12px;width:min(420px,100%)}
.plans{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:center;font-size:14px;color:var(--muted)}
.plans button{padding:9px 13px;font-size:14px;background:transparent;color:var(--fg);box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.25)}
.plans button[aria-pressed=true]{background:#fff;color:#000;box-shadow:none}
button.x{width:100%;display:flex;align-items:center;justify-content:center;gap:10px;font-size:17px;padding:17px 22px;background:#fff;color:#000;box-shadow:0 10px 30px rgba(0,0,0,.35)}
button.x:hover{transform:translateY(-1px)}
button.x svg{width:19px;height:19px}
.hint{color:var(--muted);font-size:13.5px;text-align:center;line-height:1.45}
.sheet{position:fixed;inset:0;background:rgba(6,5,14,.72);backdrop-filter:blur(6px);display:none;align-items:center;justify-content:center;z-index:10;padding:16px}
.sheet.on{display:flex}
.sheet .box{background:#15132b;border:1px solid rgba(255,255,255,.12);border-radius:22px;padding:22px;width:min(460px,100%);display:flex;flex-direction:column;gap:16px;align-items:center;text-align:center}
.sheet img{width:100%;border-radius:12px;display:block}
.sheet h2{font-size:22px;letter-spacing:-.02em}
.sheet p{color:var(--muted);font-size:15px;line-height:1.45}
.sheet kbd{font:600 15px/1 ${FONT};background:#fff;color:#000;border-radius:7px;padding:4px 8px}
.sheet .go{width:100%}
.toast{position:fixed;left:50%;bottom:24px;transform:translate(-50%,20px);opacity:0;transition:.25s;background:#fff;color:#000;font-weight:600;font-size:15px;padding:14px 20px;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.5);max-width:calc(100% - 32px);text-align:center;z-index:9}
.toast.on{opacity:1;transform:translate(-50%,0)}
.wide{width:min(720px,100%);border-radius:14px;overflow:hidden}.wide svg{width:100%;height:auto;display:block}
p.note{color:var(--muted);font-size:13px;text-align:center;max-width:520px;line-height:1.5}
</style></head><body>
<div class="player" id="player"><div class="bars" id="bars"></div><div class="tap"><div id="prev"></div><div id="next"></div></div><div id="stage"></div></div>
${hasValue ? `<div class="plans" id="plans"><span>Your plan:</span><button aria-pressed="true" data-plan="">None</button>${PLANS.map((p) => `<button aria-pressed="false" data-plan="${p}">$${p}/mo</button>`).join('')}</div>` : ''}
<div class="share">
  <button class="x" id="x"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>Post on X</button>
  <p class="hint" id="hint">Opens X with your card and stats in the post.</p>
  <div class="row"><button class="ghost" id="dl">Save this card</button><button class="ghost" id="dlall">Save all</button></div>
</div>
<div class="wide" id="wide"></div>
<div class="row"><button class="ghost" id="dlwide">Save the wide card</button></div>
<p class="note">Made on your computer by tokens-wrapped. Nothing leaves your computer unless you click Post on X, which uploads just that card image (deleted after 90 days).</p>
<div class="toast" id="toast" role="status"></div>
<div class="sheet" id="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-h"><div class="box">
  <img id="sheet-img" alt="Your card">
  <h2 id="sheet-h">Your card is copied</h2>
  <p id="sheet-p">X can't attach images from a link, so paste it yourself: when X opens, click in the post and press <kbd id="sheet-k">⌘V</kbd>.</p>
  <button class="x go" id="sheet-go"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>Open X</button>
  <button class="ghost" id="sheet-x">Cancel</button>
</div></div>
${tpl}
<script>
const story=${JSON.stringify(story.map((c) => c.id))};
const bars=document.getElementById('bars'),stage=document.getElementById('stage');
story.forEach(()=>{const i=document.createElement('i');i.appendChild(document.createElement('b'));bars.appendChild(i)});
let plan='';
const tid=id=>id==='value'&&plan?'value-'+plan:id;
const svgOf=id=>document.getElementById('t-'+tid(id)).content.firstElementChild.cloneNode(true);
document.getElementById('wide').appendChild(svgOf('wide'));
let cur=0,t0=0,paused=false,raf=0;const DUR=4500;
function show(n){cur=Math.max(0,Math.min(story.length-1,n));stage.replaceChildren(svgOf(story[cur]));t0=performance.now();[...bars.children].forEach((b,i)=>b.firstChild.style.width=i<cur?'100%':'0')}
function tick(t){if(!paused){const p=Math.min(1,(t-t0)/DUR);bars.children[cur].firstChild.style.width=(p*100)+'%';if(p>=1&&cur<story.length-1)show(cur+1)}else t0+=16;raf=requestAnimationFrame(tick)}
document.getElementById('prev').onclick=()=>show(cur-1);document.getElementById('next').onclick=()=>show(cur+1);
const pl=document.getElementById('player');pl.onpointerdown=()=>paused=true;pl.onpointerup=pl.onpointerleave=()=>paused=false;
addEventListener('keydown',e=>{if(e.key==='ArrowRight')show(cur+1);if(e.key==='ArrowLeft')show(cur-1)});
async function toPng(id){const tp=document.getElementById('t-'+tid(id)),w=+tp.dataset.w,h=+tp.dataset.h;
const blob=new Blob([new XMLSerializer().serializeToString(svgOf(id))],{type:'image/svg+xml'});const url=URL.createObjectURL(blob);
const img=new Image();await new Promise((ok,no)=>{img.onload=ok;img.onerror=no;img.src=url});
const c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d').drawImage(img,0,0,w,h);URL.revokeObjectURL(url);
return new Promise(r=>c.toBlob(r,'image/png'))}
function save(b,id){const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='year-in-ai-'+id+'.png';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),2000)}
async function png(id){save(await toPng(id),id)}
// Post on X: X's share link can't carry an image, so the card goes on the clipboard (or the share sheet on phones).
const POST=${JSON.stringify(postText(d))},INTENT=${JSON.stringify(intent)};
const mac=/Mac|iPhone|iPad/.test(navigator.platform||navigator.userAgent),touch=matchMedia('(pointer:coarse)').matches;
let card=null;toPng('wide').then(b=>card=b);
const toastEl=document.getElementById('toast');let tt=0;
function toast(m){toastEl.textContent=m;toastEl.classList.add('on');clearTimeout(tt);tt=setTimeout(()=>toastEl.classList.remove('on'),9000)}
if(touch)document.getElementById('hint').textContent='Opens your share sheet with the card attached. Pick X.';
// Step 1 copies the card and says how to attach it; step 2 opens X. X's share link can carry text only.
const sheet=document.getElementById('sheet');
document.getElementById('sheet-k').textContent=mac?'⌘V':'Ctrl+V';
const openSheet=(copied)=>{
  const img=document.getElementById('sheet-img');img.src=URL.createObjectURL(card);
  if(!copied){document.getElementById('sheet-h').textContent='Your card is in Downloads';
    document.getElementById('sheet-p').textContent='When X opens, click the image button in the post and pick year-in-ai-wide.png.'}
  sheet.classList.add('on');document.getElementById('sheet-go').focus()};
document.getElementById('sheet-go').onclick=()=>{window.open(INTENT,'_blank','noopener');sheet.classList.remove('on')};
document.getElementById('sheet-x').onclick=()=>sheet.classList.remove('on');
sheet.addEventListener('click',e=>{if(e.target===sheet)sheet.classList.remove('on')});
// Post on X: upload this one card so X shows it as the post's image (kept 90 days, nothing else is sent).
// The X tab is opened right away (before the upload) so the browser doesn't block it as a popup.
const UPLOAD=${JSON.stringify(CARD_UPLOAD_URL)};
const xBtn=document.getElementById('x');
xBtn.onclick=async()=>{
  if(!card)card=await toPng('wide');
  const file=new File([card],'year-in-ai.png',{type:'image/png'});
  if(touch&&navigator.canShare&&navigator.canShare({files:[file]})){navigator.share({files:[file],text:POST}).catch(()=>{});return}
  const tab=window.open('about:blank','_blank');
  const label=xBtn.lastChild.textContent;xBtn.lastChild.textContent='Uploading your card…';xBtn.disabled=true;
  try{
    const ctl=new AbortController();setTimeout(()=>ctl.abort(),15000);
    const res=await fetch(UPLOAD,{method:'POST',headers:{'content-type':'image/png'},body:card,signal:ctl.signal});
    const j=await res.json();
    if(!res.ok||!j.url)throw new Error('upload');
    const intent='https://x.com/intent/post?text='+encodeURIComponent(POST.replace('tokenswrapped.com',j.url));
    if(tab){tab.opener=null;tab.location.href=intent}else window.open(intent,'_blank','noopener');
    toast('Your card is in the post.');
  }catch(e){
    if(tab)tab.close();
    try{await navigator.clipboard.write([new ClipboardItem({'image/png':card})]);openSheet(true)}
    catch(_){save(card,'wide');openSheet(false)}
  }finally{xBtn.lastChild.textContent=label;xBtn.disabled=false}
};
document.getElementById('dl').onclick=()=>png(story[cur]);
document.getElementById('dlwide').onclick=()=>png('wide');
document.getElementById('dlall').onclick=async()=>{for(const id of [...story,'wide']){await png(id);await new Promise(r=>setTimeout(r,250))}};
const plansEl=document.getElementById('plans');
if(plansEl)plansEl.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;plan=b.dataset.plan;
  for(const x of plansEl.querySelectorAll('button'))x.setAttribute('aria-pressed',String(x===b));
  paused=true;show(story.indexOf('value'))});
show(0);raf=requestAnimationFrame(tick);
</script></body></html>
`;
}

// Writes the page to a new temp folder and returns its path. Never overwrites anything.
export function writeShare({ usage, value = null, now = new Date(), dir } = {}) {
  const d = recapData({ usage, value, now });
  const folder = dir || mkdtempSync(join(tmpdir(), 'tokens-wrapped-'));
  const file = join(folder, 'year-in-ai.html');
  writeFileSync(file, page(d), { flag: 'wx' });
  return file;
}

// Opens a local file in the default browser. Best effort: errors are ignored.
export function openInBrowser(file, platform = process.platform) {
  const url = pathToFileURL(file).href;
  const [cmd, args] =
    platform === 'darwin' ? ['open', [url]] : platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    const p = spawn(cmd, args, { stdio: 'ignore', detached: true });
    p.on('error', () => {});
    p.unref();
  } catch {
    /* no browser: the path is printed anyway */
  }
}

export { wordmarkWidth };
