// "Your year in AI": story cards in the style of a year-in-review recap, in ernd's sky colors, written as one
// self-contained HTML page. The page loads nothing from the network. It plays the cards like a story and turns
// each one into a PNG in the browser (SVG -> canvas). It's a recap, not an ad: ernd shows up as branding only
// (wordmark, sky colors, ernd.ai), with no card pitch or rates on the cards or in the post text.
// ernd shows up as branding only (wordmark, sky colors, ernd.ai), never as a product pitch.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { usd } from './format.js';
import { SKY, wordmark, wordmarkWidth } from './brand.js';
import { novels, personality } from './local/persona.js';

export const STORY = { w: 1080, h: 1920 };
export const WIDE = { w: 1600, h: 900 };

// ernd's typeface first (ABC Diatype, when installed), then the heaviest common system sans. No web fonts.
const FONT = "'ABC Diatype', 'Avenir Next', 'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const CHAR = 0.6; // rough advance of a bold sans, in em, for fitting text without measuring

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

// ---------- data ----------

// usage: the summary from the local readers (local/index.js). value: the API-price estimate (local/value.js).
export function recapData({ usage, value = null, now = new Date() } = {}) {
  return {
    year: usage?.year || now.getFullYear(),
    value,
    models: (usage?.models || []).slice(0, 5).map((m) => ({ name: prettyModel(m.name), value: compact(m.tokens) + ' tokens' })),
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
const pct = (x) => `${Math.round(x * 100)}%`;
const n0 = (x) => Math.round(x).toLocaleString('en-US');

// ---------- svg helpers ----------

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function clip(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Largest size up to `max` at which `s` fits in `width`.
export function fit(s, width, max) {
  return Math.floor(Math.min(max, width / (Math.max(1, String(s).length) * CHAR)));
}

function text(x, y, s, { size = 48, fill = P.white, anchor = 'start', weight = 700, op = 1, ls = -0.03 } = {}) {
  return `<text x="${x}" y="${y}" font-family="${esc(FONT)}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" letter-spacing="${(size * ls).toFixed(1)}"${op < 1 ? ` opacity="${op}"` : ''}>${esc(s)}</text>`;
}

// Greedy wrap by characters for a given size and width.
export function wrap(s, size, width) {
  const per = Math.max(4, Math.floor(width / (size * CHAR)));
  const out = [];
  let cur = '';
  for (const w of String(s).split(/\s+/)) {
    if (cur && (cur + ' ' + w).length > per) {
      out.push(cur);
      cur = w;
    } else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) out.push(cur);
  return out;
}

function lines(x, y, s, size, width, opts = {}, lh = 1.08) {
  return wrap(s, size, width)
    .map((l, i) => text(x, y + i * size * lh, l, { size, ...opts }))
    .join('');
}

function star(cx, cy, r, n, fill, rot = 0, inner = 0.5) {
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const a = rot + (Math.PI * i) / n;
    const rr = i % 2 ? r * inner : r;
    pts.push(`${(cx + rr * Math.cos(a)).toFixed(1)},${(cy + rr * Math.sin(a)).toFixed(1)}`);
  }
  return `<polygon points="${pts.join(' ')}" fill="${fill}"/>`;
}

function rings(cx, cy, r, n, stroke, w, op = 1) {
  let s = '';
  for (let i = 0; i < n; i++) s += `<circle cx="${cx}" cy="${cy}" r="${r - i * w * 2}" fill="none" stroke="${stroke}" stroke-width="${w}" opacity="${op}"/>`;
  return s;
}

function wave(y, amp, thick, fill, x0, x1, period = 360) {
  let top = `M ${x0 - 40} ${y}`;
  for (let x = x0 - 40; x <= x1 + 40; x += 20) top += ` L ${x} ${(y + amp * Math.sin((x / period) * Math.PI * 2)).toFixed(1)}`;
  let back = '';
  for (let x = x1 + 40; x >= x0 - 40; x -= 20) back += ` L ${x} ${(y + thick + amp * Math.sin((x / period) * Math.PI * 2 + 1)).toFixed(1)}`;
  return `<path d="${top}${back} Z" fill="${fill}"/>`;
}

// A smooth closed blob, the same every time for the same seed.
function blob(cx, cy, r, fill, seed = 1, k = 7) {
  let x = seed * 9301 + 49297;
  const rnd = () => ((x = (x * 9301 + 49297) % 233280) / 233280);
  const pts = [];
  for (let i = 0; i < k; i++) {
    const a = (Math.PI * 2 * i) / k;
    const rr = r * (0.75 + rnd() * 0.45);
    pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
  }
  let d = '';
  for (let i = 0; i < k; i++) {
    const p0 = pts[(i - 1 + k) % k], p1 = pts[i], p2 = pts[(i + 1) % k], p3 = pts[(i + 2) % k];
    if (i === 0) d += `M ${p1[0].toFixed(1)} ${p1[1].toFixed(1)}`;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C ${c1.map((v) => v.toFixed(1)).join(' ')} ${c2.map((v) => v.toFixed(1)).join(' ')} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return `<path d="${d} Z" fill="${fill}"/>`;
}

// Soft clouds, like the sky on ernd.ai.
function clouds(id, list) {
  return (
    `<g filter="url(#cloud-${id})">` +
    list.map(([cx, cy, rx, ry, op]) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="#fff" opacity="${op}"/>`).join('') +
    `</g>`
  );
}

// Every card: its own ids (cards share one page), the sky gradient and a cloud blur. No grain: it read as noise.
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
const corner = (s, fill = P.white, w = STORY.w) => text(w - PAD, 146, s, { size: 40, fill, anchor: 'end', weight: 600, ls: -0.01 });
const small = (x, y, s, fill = P.white, op = 0.8, size = 42) => text(x, y, s, { size, fill, op, weight: 500, ls: -0.01 });

function card(id, label, bg, body, size = STORY) {
  return { id, label, ...size, svg: svg(id, size, bg, body) };
}

// A big number with a line above and below it.
function hero(above, value, below, { fg = P.ink, valueFill = fg, top = 620, max = 260 } = {}) {
  const w = STORY.w;
  const s = fit(value, w - PAD * 2 + 10, max);
  return (
    text(PAD, top, above, { size: 92, fill: fg }) +
    text(PAD - 6, top + s * 0.98, value, { size: s, fill: valueFill, ls: -0.045 }) +
    (below ? text(PAD, top + s * 0.98 + 150, below, { size: 92, fill: fg }) : '')
  );
}

// ---------- the cards ----------

function introCard(d) {
  const id = 'intro';
  const body =
    clouds(id, [[200, 420, 380, 90, 0.5], [860, 760, 420, 110, 0.4], [300, 1500, 460, 120, 0.35], [900, 1760, 360, 90, 0.4]]) +
    `<circle cx="820" cy="420" r="170" fill="${P.peach}" opacity="0.95"/>` +
    rings(820, 420, 260, 2, P.white, 6, 0.6) +
    mark() +
    corner(String(d.year)) +
    text(PAD, 1010, 'Your', { size: 240, fill: P.white, ls: -0.05 }) +
    text(PAD, 1240, String(d.year), { size: 240, fill: P.white, ls: -0.05 }) +
    text(PAD, 1470, 'in AI', { size: 240, fill: P.night, ls: -0.05 });
  return card(id, 'Intro', 'sky', body);
}

function listCard(id, label, title, rows, bg, fg, accent, deco) {
  const { w } = STORY;
  let body = deco + mark(fg);
  const tl = wrap(title, 104, w - PAD * 2);
  body += tl.map((l, i) => text(PAD, 340 + i * 112, l, { size: 104, fill: fg })).join('');
  const top = 340 + tl.length * 112 + 150;
  // Few rows: bigger and spread out, so the card never looks half empty.
  const big = rows.length <= 3;
  const gap = Math.min(big ? 300 : 210, (1700 - top) / Math.max(1, rows.length));
  const [num, name, amt, indent] = big ? [170, 88, 54, 170] : [124, 64, 44, 132];
  rows.forEach((r, i) => {
    const y = top + i * gap;
    body += text(PAD, y + num * 0.15, String(i + 1), { size: num, fill: accent, ls: -0.05 });
    body += text(PAD + indent, y - name * 0.55, clip(r.name, big ? 15 : 21), { size: name, fill: fg });
    body += text(PAD + indent, y + amt * 0.75, r.value, { size: amt, fill: fg, op: 0.75, weight: 500, ls: -0.01 });
  });
  return card(id, label, bg, body);
}

function modelsCard(d) {
  const deco =
    `<rect x="700" y="1600" width="520" height="190" rx="95" fill="${P.pink}"/>` +
    `<rect x="-120" y="1800" width="520" height="190" rx="95" fill="${P.peach}"/>` +
    rings(960, 270, 140, 3, P.mist, 16);
  return listCard('models', 'Top models', 'Your top models', d.models, P.violet, P.white, P.mist, deco);
}

function tokensCard(d) {
  const u = d.usage;
  const id = 'tokens';
  const t = u.tokens;
  const n = novels(t.total);
  const inShare = t.total ? t.input / t.total : 0;
  const bw = STORY.w - PAD * 2;
  let body =
    rings(900, 330, 220, 5, P.violet, 14, 0.7) +
    mark() +
    hero('You used', compact(t.total), 'tokens', { fg: P.white, valueFill: `url(#ink-${id})`, max: 300 });
  body += `<rect x="${PAD}" y="1240" width="${bw}" height="56" rx="28" fill="${P.violet}"/>`;
  body += `<rect x="${PAD}" y="1240" width="${Math.max(56, bw * inShare).toFixed(0)}" height="56" rx="28" fill="${P.mist}"/>`;
  body += small(PAD, 1360, `${compact(t.input)} in`, P.mist, 0.95, 44) + text(STORY.w - PAD, 1360, `${compact(t.output)} out`, { size: 44, fill: P.violet, anchor: 'end', weight: 500, ls: -0.01 });
  if (n >= 1) body += lines(PAD, 1560, `That's about ${n0(n)} novel${n === 1 ? "'s" : "s'"} worth of text.`, 64, STORY.w - PAD * 2, { fill: P.white });
  body += small(PAD, 1810, `${shortDate(u.since)} to ${shortDate(u.until)} · ${u.sources.join(' + ')}`, P.white, 0.55, 36);
  return card(id, 'Tokens', P.ink, body);
}

function cacheCard(d) {
  const u = d.usage;
  const r = 260, cx = STORY.w / 2, cy = 820, c = 2 * Math.PI * r;
  const on = Math.max(0, Math.min(1, u.cacheHit));
  let body = mark(P.ink);
  body += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${P.white}" stroke-width="90"/>`;
  body += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${P.violet}" stroke-width="90" stroke-dasharray="${(c * on).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${cx} ${cy})" stroke-linecap="${on > 0.02 && on < 0.98 ? 'round' : 'butt'}"/>`;
  body += text(cx, cy + 70, pct(on), { size: 200, fill: P.ink, anchor: 'middle', ls: -0.05 });
  body += text(PAD, 1340, 'cache hit rate', { size: 92, fill: P.ink });
  body += lines(PAD, 1470, `${compact(u.tokens.cached)} of your ${compact(u.tokens.input)} input tokens came straight from cache.`, 56, STORY.w - PAD * 2, { fill: P.ink, op: 0.8, weight: 500, ls: -0.01 });
  body += star(940, 1760, 110, 8, P.pink, 0.2, 0.45);
  return card('cache', 'Cache', P.mist, body);
}

function peakCard(d) {
  const u = d.usage;
  const id = 'peak';
  const x0 = PAD, x1 = STORY.w - PAD, base = 1560, hmax = 420;
  const max = Math.max(...u.days.map((x) => x.tokens), 1);
  const bw = (x1 - x0) / u.days.length;
  let bars = '';
  u.days.forEach((day, i) => {
    if (!day.tokens) return;
    const h = Math.max(3, (day.tokens / max) * hmax);
    const isPeak = day.date === u.peak.date;
    bars += `<rect x="${(x0 + i * bw).toFixed(1)}" y="${(base - h).toFixed(1)}" width="${Math.max(1, bw * 0.72).toFixed(1)}" height="${h.toFixed(1)}" fill="${isPeak ? P.peach : P.white}" opacity="${isPeak ? 1 : 0.55}"/>`;
  });
  const pi = u.days.findIndex((x) => x.date === u.peak.date);
  const px = x0 + pi * bw;
  let body = mark() + text(PAD, 420, 'Your biggest day', { size: 92, fill: P.white });
  body += text(PAD - 6, 640, shortDate(u.peak.date), { size: 230, fill: P.white, ls: -0.05 });
  body += text(PAD, 760, `${compact(u.peak.tokens)} tokens in one day`, { size: 60, fill: P.white, op: 0.9, weight: 500, ls: -0.01 });
  body += bars;
  body += `<circle cx="${(px + bw * 0.36).toFixed(1)}" cy="${base - hmax - 50}" r="16" fill="${P.peach}"/>`;
  body += `<rect x="${x0}" y="${base + 8}" width="${x1 - x0}" height="3" fill="${P.white}" opacity="0.5"/>`;
  body += small(x0, base + 70, shortDate(u.days[0].date), P.white, 0.7, 36) + text(x1, base + 70, shortDate(u.days[u.days.length - 1].date), { size: 36, fill: P.white, op: 0.7, anchor: 'end', weight: 500, ls: -0.01 });
  body += small(PAD, 1810, `AI ran on ${u.activeDays} of ${u.days.length} days`, P.white, 0.75, 44);
  return card(id, 'Biggest day', P.blue, body);
}

// ---------- local-log cards ----------

// "claude-opus-5-5" -> "Claude Opus 5.5", "gpt-6.1-sol" -> "GPT-6.1 Sol", "gemini-3.8-flash" -> "Gemini 3.8 Flash".
// Dated snapshots ("-20250514") and provider prefixes are dropped. Anything unknown is shown as is.
export function prettyModel(id) {
  let m = String(id || '').replace(/^[a-z0-9-]+\//i, '').replace(/-\d{8}$/, '').replace(/\[1m\]$/, '');
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(m);
  if (claude) return `Claude ${cap(claude[1])} ${claude[2]}${claude[3] ? '.' + claude[3] : ''}`;
  const gpt = /^gpt-([\d.]+)(?:-(.+))?$/.exec(m);
  if (gpt) return `GPT-${gpt[1]}${gpt[2] ? ' ' + gpt[2].split('-').map(cap).join(' ') : ''}`;
  const gem = /^gemini-([\d.]+)-(.+)$/.exec(m);
  if (gem) return `Gemini ${gem[1]} ${gem[2].split('-').map(cap).join(' ')}`;
  return m;
}
const cap = (w) => (w ? w[0].toUpperCase() + w.slice(1) : w);

const LANG = { py: 'Python', ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', go: 'Go', rs: 'Rust', rb: 'Ruby', java: 'Java', kt: 'Kotlin', swift: 'Swift', c: 'C', cc: 'C++', cpp: 'C++', h: 'C', cs: 'C#', php: 'PHP', sql: 'SQL', sh: 'Shell', md: 'Markdown', html: 'HTML', css: 'CSS', json: 'JSON', yaml: 'YAML', yml: 'YAML', vue: 'Vue', svelte: 'Svelte', ex: 'Elixir', scala: 'Scala', dart: 'Dart', lua: 'Lua', r: 'R', ipynb: 'Notebooks' };
export const langName = (ext) => LANG[ext] || ext.toUpperCase();

function hourLabel(h) {
  if (h === 0) return '12am';
  if (h === 12) return '12pm';
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

const andList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

// "At API prices": what the year would have cost billed per token, next to a plan's price for the same months.
// plan: null for the plain card; dollars a month for the variants the recap page lets people pick.
export function valueCard(d, plan = null) {
  const v = d.value;
  const id = plan == null ? 'value' : `value-${plan}`;
  const { w } = STORY;
  let body = clouds(id, [[200, 300, 360, 90, 0.4], [880, 1700, 420, 110, 0.35]]) + mark();
  body += text(PAD, 560, 'At API prices,', { size: 84, fill: P.white });
  body += text(PAD, 660, 'your year cost', { size: 84, fill: P.white });
  const big = usd(v.api);
  const s = fit(big, w - PAD * 2 + 10, 270);
  body += text(PAD - 6, 660 + s * 1.02, big, { size: s, fill: P.white, ls: -0.045 });
  if (plan) {
    const paid = plan * v.months;
    const x = paid ? v.api / paid : 0;
    body += text(PAD, 1180, `On a $${plan}/month plan you paid`, { size: 56, fill: P.white, op: 0.92, weight: 500, ls: -0.01 });
    body += text(PAD, 1270, `${usd(paid)} for ${v.months} month${v.months === 1 ? '' : 's'}.`, { size: 56, fill: P.white, op: 0.92, weight: 500, ls: -0.01 });
    if (x >= 1.5) {
      const xs = `${x >= 10 ? Math.round(x) : x.toFixed(1)}x`;
      body += `<rect x="${PAD}" y="1380" width="${Math.min(w - PAD * 2, 140 + xs.length * 70)}" height="170" rx="85" fill="${P.night}" opacity="0.88"/>`;
      body += text(PAD + 60, 1500, xs, { size: 120, fill: P.peach, ls: -0.04 });
      body += text(PAD, 1640, 'what you paid', { size: 56, fill: P.white, weight: 500, ls: -0.01 });
    }
  } else {
    body += lines(PAD, 1220, `Every token billed at list price, across ${andList(d.usage.sources)}.`, 54, w - PAD * 2, { fill: P.white, op: 0.92, weight: 500, ls: -0.01 }, 1.2);
  }
  body += small(PAD, 1810, `${shortDate(d.usage.since)} to ${shortDate(d.usage.until)} · estimate from public list prices`, P.white, 0.7, 34);
  return card(id, 'API prices', 'sky', body);
}

function harnessCard(d) {
  const u = d.usage;
  const id = 'harnesses';
  const { w } = STORY;
  const rows = u.harnesses.slice(0, 5);
  const max = Math.max(...rows.map((h) => h.tokens), 1);
  let body = star(940, 300, 120, 6, P.ink, 0.3, 0.5) + mark(P.ink);
  body += text(PAD, 380, 'Your harnesses', { size: 104, fill: P.ink });
  // Few rows: bigger and spread down the card, like the other top lists.
  const big = rows.length <= 3;
  const top = big ? 680 : 580;
  const gap = Math.min(big ? 360 : 250, (1760 - top) / Math.max(1, rows.length));
  const [num, name, sub, ind, bar] = big ? [170, 96, 50, 160, 22] : [120, 72, 42, 120, 14];
  rows.forEach((h, i) => {
    const y = top + i * gap;
    body += text(PAD, y + num * 0.2, String(i + 1), { size: num, fill: P.ink, ls: -0.05 });
    body += text(PAD + ind, y - name * 0.3, h.name, { size: name, fill: P.ink });
    const detail = h.tokensKnown ? `${compact(h.tokens)} tokens · ${h.days} day${h.days === 1 ? '' : 's'}` : `${n0(h.replies)} messages · ${h.days} days`;
    body += text(PAD + ind, y + sub * 0.95, detail, { size: sub, fill: P.ink, op: 0.75, weight: 500, ls: -0.01 });
    const bw = (w - PAD * 2 - ind) * (h.tokensKnown ? Math.max(0.02, h.tokens / max) : 0.02);
    body += `<rect x="${PAD + ind}" y="${y + sub * 1.5}" width="${bw.toFixed(0)}" height="${bar}" rx="${bar / 2}" fill="${P.ink}" opacity="0.85"/>`;
  });
  return card(id, 'Harnesses', P.peach, body);
}

function rhythmCard(d) {
  const u = d.usage;
  const id = 'rhythm';
  const { w } = STORY;
  let body = mark();
  body += text(PAD, 400, 'Your rhythm', { size: 92, fill: P.white });
  if (u.streak > 1) {
    const big = `${u.streak} days`;
    body += text(PAD - 6, 640, big, { size: fit(big, w - PAD * 2, 220), fill: P.peach, ls: -0.05 });
    body += text(PAD, 740, 'in a row with AI', { size: 60, fill: P.white, op: 0.9, weight: 500, ls: -0.01 });
  }
  // 24 bars, one per hour of the day, the busiest one lit.
  const x0 = PAD, x1 = w - PAD, base = 1380, hmax = 380, bw = (x1 - x0) / 24;
  const max = Math.max(...u.hours, 1);
  u.hours.forEach((v, h) => {
    const hh = Math.max(4, (v / max) * hmax);
    const lit = h === u.busiestHour;
    body += `<rect x="${(x0 + h * bw + 3).toFixed(1)}" y="${(base - hh).toFixed(1)}" width="${(bw - 6).toFixed(1)}" height="${hh.toFixed(1)}" rx="6" fill="${lit ? P.peach : P.white}" opacity="${lit ? 1 : 0.5}"/>`;
  });
  for (const [h, label] of [[0, '12am'], [6, '6am'], [12, '12pm'], [18, '6pm']]) body += small(x0 + h * bw + 3, base + 56, label, P.white, 0.65, 32);
  if (u.busiestHour != null) body += text(PAD, 1560, `Busiest at ${hourLabel(u.busiestHour)}`, { size: 72, fill: P.white });
  body += small(PAD, 1660, `AI ran on ${u.activeDays} of ${u.days.length} days since ${shortDate(u.since)}`, P.white, 0.8, 44);
  return card(id, 'Rhythm', 'dusk', body);
}

function builtCard(d) {
  const u = d.usage;
  const b = u.built;
  const id = 'built';
  let body = blob(980, 260, 220, P.purple, 4) + mark() + text(PAD, 420, 'Your agents wrote', { size: 92, fill: P.white });
  const big = n0(b.lines);
  const bs = fit(big, STORY.w - PAD * 2, 240);
  body += text(PAD - 6, 420 + bs * 1.05, big, { size: bs, fill: `url(#ink-${id})`, ls: -0.05 });
  body += text(PAD, 800, 'lines of code', { size: 64, fill: P.white, op: 0.9, weight: 500, ls: -0.01 });
  const cells = [
    [n0(b.files), 'files touched'],
    [n0(u.prompts), 'messages you sent'],
    [n0(u.sessions), 'sessions'],
    b.languages[0] ? [langName(b.languages[0].ext), 'top language'] : [n0(u.projects), 'projects'],
  ];
  cells.forEach(([v, k], i) => {
    const x = PAD + (i % 2) * 460, y = 1100 + Math.floor(i / 2) * 300;
    body += text(x, y, v, { size: fit(v, 420, 120), fill: P.white, ls: -0.04 });
    body += small(x, y + 70, k, P.white, 0.75, 44);
  });
  const tool = u.tools?.[0];
  if (tool) body += small(PAD, 1760, `Most used tool: ${tool.name}, ${n0(tool.calls)} times`, P.white, 0.6, 38);
  return card(id, 'Built', P.ink, body);
}

function personaCard(d) {
  const p = d.persona;
  const id = 'persona';
  let body =
    clouds(id, [[260, 300, 380, 90, 0.35], [820, 1650, 420, 110, 0.3]]) +
    star(STORY.w / 2, 700, 260, 10, P.peach, 0.1, 0.55) +
    mark() +
    text(STORY.w / 2, 1120, 'Your AI personality', { size: 56, fill: P.white, anchor: 'middle', weight: 500, ls: -0.01, op: 0.9 });
  const ls = wrap(p.name, 150, STORY.w - PAD * 2);
  body += ls.map((l, i) => text(STORY.w / 2, 1290 + i * 160, l, { size: 150, fill: P.white, anchor: 'middle', ls: -0.045 })).join('');
  body += wrap(p.line, 54, STORY.w - PAD * 2 - 60)
    .map((l, i) => text(STORY.w / 2, 1290 + ls.length * 160 + 60 + i * 66, l, { size: 54, fill: P.white, anchor: 'middle', weight: 500, ls: -0.01, op: 0.9 }))
    .join('');
  return card(id, 'Personality', 'dusk', body);
}

// The cover on the summary card: ernd's sky, a sun, rings. Colors shift with token count so covers differ.
function cover(id, x, y, s, seed = 0) {
  const suns = [P.peach, P.white, P.pink, P.mist];
  const sun = suns[Math.abs(Math.floor(seed)) % suns.length];
  return (
    `<clipPath id="cover-${id}"><rect x="${x}" y="${y}" width="${s}" height="${s}" rx="10"/></clipPath>` +
    `<g clip-path="url(#cover-${id})"><rect x="${x}" y="${y}" width="${s}" height="${s}" fill="url(#sky-${id})"/>` +
    `<g filter="url(#cloud-${id})"><ellipse cx="${x + s * 0.3}" cy="${y + s * 0.72}" rx="${s * 0.45}" ry="${s * 0.09}" fill="#fff" opacity="0.6"/><ellipse cx="${x + s * 0.8}" cy="${y + s * 0.5}" rx="${s * 0.3}" ry="${s * 0.07}" fill="#fff" opacity="0.5"/></g>` +
    `<circle cx="${x + s * 0.62}" cy="${y + s * 0.36}" r="${s * 0.2}" fill="${sun}"/>` +
    rings(x + s * 0.62, y + s * 0.36, s * 0.32, 2, P.white, s * 0.012, 0.7) +
    wordmark(x + s * 0.08, y + s * 0.82, s * 0.09, P.white) +
    `</g>`
  );
}

// Up to 6 stats for the summary grid, most interesting first.
function stats(d) {
  const u = d.usage;
  const out = [];
  if (d.value?.api >= 1) out.push(['At API prices', usd(d.value.api)]);
  if (u) out.push(['Tokens', compact(u.tokens.total)]);
  if (u?.cacheHit != null) out.push(['Cache hits', pct(u.cacheHit)]);
  if (u?.built?.lines) out.push(['Lines written', compact(u.built.lines)]);
  if (u?.streak > 1) out.push(['Longest streak', `${u.streak} days`]);
  if (u?.peak) out.push(['Biggest day', shortDate(u.peak.date)]);
  if (u?.activeDays) out.push(['Days with AI', String(u.activeDays)]);
  return out.slice(0, 6);
}

function summaryCard(d) {
  const id = 'summary';
  const { w } = STORY;
  const s = 600;
  let body = mark() + corner(`${d.year} in AI`);
  body += cover(id, (w - s) / 2, 180, s, (d.usage?.tokens?.total || 0) / 1e9);
  const left = { title: 'Top harnesses', rows: (d.usage?.harnesses || []).map((h) => h.name) };
  const right = { title: 'Top models', rows: d.models.map((m) => m.name) };
  const cols = [
    { x: PAD, ...left },
    { x: w / 2 + 20, ...right },
  ];
  for (const c of cols) {
    body += small(c.x, 880, c.title, P.white, 0.65, 36);
    c.rows.slice(0, 5).forEach((r, i) => {
      body += text(c.x, 944 + i * 58, `${i + 1}`, { size: 42, fill: P.peach });
      body += text(c.x + 44, 944 + i * 58, clip(r, 16), { size: 42, fill: P.white });
    });
  }
  const st = stats(d);
  st.forEach(([k, v], i) => {
    const x = PAD + (i % 2) * (w / 2 - PAD + 20);
    const y = 1310 + Math.floor(i / 2) * 150;
    body += small(x, y, k, P.white, 0.65, 36);
    body += text(x, y + 74, v, { size: fit(v, w / 2 - PAD - 60, 80), fill: i === 0 ? P.peach : P.white });
  });
  body += `<rect x="${PAD}" y="1740" width="${w - PAD * 2}" height="2" fill="${P.white}" opacity="0.25"/>`;
  body += text(PAD, 1820, 'ernd.ai', { size: 38, fill: P.white, op: 0.8, weight: 500, ls: -0.01 });
  return card(id, 'Summary', 'dusk', body);
}

// The same summary, wide, for an X post.
function wideCard(d) {
  const id = 'wide';
  const { w, h } = WIDE;
  const s = 620;
  let body = cover(id, 120, (h - s) / 2, s, (d.usage?.tokens?.total || 0) / 1e9);
  const x = 120 + s + 90;
  body += wordmark(x, 120, 40, P.white) + text(w - 110, 158, `${d.year} in AI`, { size: 38, fill: P.white, anchor: 'end', weight: 600, ls: -0.01 });
  const st = stats(d).slice(0, 6);
  st.forEach(([k, v], i) => {
    const cx = x + (i % 2) * 380;
    const cy = 290 + Math.floor(i / 2) * 170;
    body += small(cx, cy, k, P.white, 0.65, 32);
    body += text(cx, cy + 74, v, { size: fit(v, 340, 78), fill: i === 0 ? P.peach : P.white });
  });
  body += text(x, h - 80, 'ernd.ai', { size: 30, fill: P.white, op: 0.75, weight: 500, ls: 0 });
  return card(id, 'For X', 'dusk', body, WIDE);
}

export function cards(d) {
  const u = d.usage;
  const story = [introCard(d)];
  if (d.value?.api >= 1) story.push(valueCard(d));
  if (u?.tokens?.total) story.push(tokensCard(d));
  if (u?.harnesses?.length) story.push(harnessCard(d));
  if (d.models.length) story.push(modelsCard(d));
  if (u?.cacheHit != null && u.tokens.cached > 0) story.push(cacheCard(d));
  if (u?.peak) story.push(peakCard(d));
  if (u?.hours?.some(Boolean)) story.push(rhythmCard(d));
  if (u?.built?.lines) story.push(builtCard(d));
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
  if (u?.cacheHit != null && u.tokens.cached > 0) bits.push(`${pct(u.cacheHit)} cache hits`);
  if (u?.built?.lines) bits.push(`${compact(u.built.lines)} lines written`);
  if (u?.peak) bits.push(`biggest day ${shortDate(u.peak.date)}`);
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
