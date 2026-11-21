#!/usr/bin/env node
// Repo branding (not shipped in the npm package): README banner and GitHub social preview, as SVG.
// Render to PNG with headless Chrome:  node scripts/brand-assets.js docs && see docs/*.svg
//   node scripts/brand-assets.js <outdir> [command]
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKY, wordmark } from '../src/brand.js';

const out = process.argv[2] || 'docs';
const CMD = process.argv[3] || 'npx -y tokens-wrapped';
const FONT = "'ABC Diatype', 'Avenir Next', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// A story card, scaled and tilted, as a nested svg.
function thumb(card, x, y, h, rot) {
  const s = h / card.h;
  const inner = card.svg.replace(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="\d+" height="\d+"/, `<svg width="${card.w}" height="${card.h}"`);
  return `<g transform="translate(${x} ${y}) rotate(${rot}) scale(${s})"><rect x="-6" y="-6" width="${card.w + 12}" height="${card.h + 12}" rx="46" fill="#000" opacity="0.18"/><clipPath id="r-${card.id}"><rect width="${card.w}" height="${card.h}" rx="40"/></clipPath><g clip-path="url(#r-${card.id})">${inner}</g></g>`;
}

function sky(id, w, h) {
  return (
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${SKY.blue}"/><stop offset="0.5" stop-color="${SKY.violet}"/><stop offset="0.8" stop-color="${SKY.purple}"/><stop offset="1" stop-color="${SKY.pink}"/></linearGradient>` +
    `<filter id="${id}-blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="30"/></filter></defs>` +
    `<rect width="${w}" height="${h}" fill="url(#${id})"/>` +
    `<g filter="url(#${id}-blur)" fill="#fff"><ellipse cx="${w * 0.18}" cy="${h * 0.82}" rx="${w * 0.22}" ry="${h * 0.08}" opacity="0.45"/><ellipse cx="${w * 0.55}" cy="${h * 0.2}" rx="${w * 0.2}" ry="${h * 0.06}" opacity="0.35"/><ellipse cx="${w * 0.9}" cy="${h * 0.9}" rx="${w * 0.2}" ry="${h * 0.07}" opacity="0.4"/></g>`
  );
}

function t(x, y, s, size, { weight = 600, fill = '#fff', op = 1, ls = -0.03, family = FONT } = {}) {
  return `<text x="${x}" y="${y}" font-family="${esc(family)}" font-size="${size}" font-weight="${weight}" fill="${fill}" letter-spacing="${(size * ls).toFixed(1)}"${op < 1 ? ` opacity="${op}"` : ''}>${esc(s)}</text>`;
}

function pill(x, y, label, size) {
  const w = label.length * size * 0.62 + size * 1.6;
  return (
    `<rect x="${x}" y="${y}" width="${w.toFixed(0)}" height="${(size * 2.1).toFixed(0)}" rx="${size * 1.05}" fill="#0a0a0a" opacity="0.88"/>` +
    t(x + size * 0.8, y + size * 1.42, label, size, { family: "'Fragment Mono', 'SF Mono', Menlo, monospace", weight: 500, ls: 0 })
  );
}

function compose(w, h, { title, sub, cmd, cardsH, scale }) {
  // The website's sample cards (node scripts/site-assets.js makes them): API prices, harnesses, summary.
  const pick = ['value', 'harnesses', 'summary'].map((id) => ({ id, w: 1080, h: 1920, svg: readFileSync(join(out === 'docs' ? 'site' : out, 'cards', `${id}.svg`), 'utf8') }));
  const k = scale;
  let body = sky('sky', w, h) + wordmark(70 * k, 64 * k, 34 * k, '#fff');
  body += t(70 * k, h * 0.47, title, 92 * k, { weight: 700, ls: -0.04 });
  sub.forEach((line, i) => (body += t(70 * k, h * 0.47 + 62 * k + i * 40 * k, line, 30 * k, { weight: 500, op: 0.95, ls: -0.01 })));
  body += pill(70 * k, h * 0.47 + 62 * k + sub.length * 40 * k + 24 * k, cmd, 30 * k);
  const cx = w - 600 * k;
  body += thumb(pick[0], cx, h * 0.16, cardsH, -8) + thumb(pick[1], cx + 165 * k, h * 0.1, cardsH, 2) + thumb(pick[2], cx + 320 * k, h * 0.13, cardsH, 7);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
}

const sub = ['Tokens, API cost, cache hits, streaks', 'and what your coding agents built.', 'No keys. Everything stays on your computer.'];
writeFileSync(join(out, 'banner.svg'), compose(1600, 600, { title: 'Your year in AI', sub, cmd: CMD, cardsH: 470, scale: 1 }));
writeFileSync(join(out, 'social-preview.svg'), compose(1280, 640, { title: 'Your year in AI', sub, cmd: CMD, cardsH: 470, scale: 0.86 }));
console.log('wrote banner.svg, social-preview.svg');
