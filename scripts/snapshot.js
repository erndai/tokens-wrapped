#!/usr/bin/env node
// Renders the card with sample numbers under forced truecolor and turns the ANSI output into an SVG
// that looks like a dark terminal window: docs/card.svg. Zero dependencies, no network.
//
//   node scripts/snapshot.js [out.svg] [-- tokens-wrapped flags...]
//
// Also writes a PNG next to the SVG with the first converter that works on this machine:
// rsvg-convert, then macOS Quick Look (qlmanage, cropped with sips), then sips. If none works, it says so.

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.js';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = ['--openai', '10000', '--anthropic', '2000', '--wafer', '2000', '--other', '20000'];

const FONT = 15;
const CELL_W = FONT * 0.6; // monospace advance
const LINE_H = Math.round(FONT * 1.55);
const PAD_X = 30;
const PAD_TOP = 52; // room for the window dots
const PAD_BOTTOM = 26;
const FG = '#e6e7ea';
const BG = '#111318'; // the window
const BACKDROP = '#08090b'; // around the window, so the PNG has no transparent corners
const MARGIN = 28;

const EIGHTHS = { '▏': 1, '▎': 2, '▍': 3, '▌': 4, '▋': 5, '▊': 6, '▉': 7, '█': 8 };
const BOX = new Set(['─', '│', '╭', '╮', '╰', '╯']);

async function card(argv, columns = 80) {
  let text = '';
  const stdout = { isTTY: true, columns, write: (s) => ((text += s), true) };
  const stderr = { isTTY: false, write: () => true };
  const env = { COLORTERM: 'truecolor', FORCE_COLOR: '3', TERM: 'xterm-256color' };
  const fetch = () => {
    throw new Error('no network in snapshots');
  };
  const code = await main({ argv, env, stdout, stderr, stdin: { isTTY: false }, fetch });
  if (code !== 0) throw new Error(`tokens-wrapped exited ${code}`);
  return text;
}

const XTERM16 = {
  30: '#1d1f24', 31: '#e06c75', 32: '#7ec699', 33: '#e5c07b', 34: '#61afef', 35: '#c678dd', 36: '#56b6c2', 37: '#c8ccd4',
  90: '#7f848e', 91: '#ff7b86', 92: '#98e3a9', 93: '#f0d58f', 94: '#82c1ff', 95: '#d99cf0', 96: '#7fd3dd', 97: '#ffffff',
};

function xterm256(n) {
  if (n < 16) return XTERM16[n < 8 ? 30 + n : 82 + n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return hex([v, v, v]);
  }
  const steps = [0, 95, 135, 175, 215, 255];
  const i = n - 16;
  return hex([steps[Math.floor(i / 36)], steps[Math.floor(i / 6) % 6], steps[i % 6]]);
}

const hex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');

// ANSI text -> rows of cells { ch, fg, bold, dim, ul }.
export function parseAnsi(text) {
  const rows = [];
  let row = [];
  const st = { fg: null, bold: false, dim: false, ul: false };
  const parts = String(text).split(/\x1b\[([0-9;]*)m/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const codes = part === '' ? [0] : part.split(';').map(Number);
      for (let k = 0; k < codes.length; k++) {
        const c = codes[k];
        if (c === 0) Object.assign(st, { fg: null, bold: false, dim: false, ul: false });
        else if (c === 1) st.bold = true;
        else if (c === 2) st.dim = true;
        else if (c === 22) st.bold = st.dim = false;
        else if (c === 4) st.ul = true;
        else if (c === 24) st.ul = false;
        else if (c === 39) st.fg = null;
        else if (XTERM16[c]) st.fg = XTERM16[c];
        else if (c === 38 && codes[k + 1] === 2) {
          st.fg = hex(codes.slice(k + 2, k + 5));
          k += 4;
        } else if (c === 38 && codes[k + 1] === 5) {
          st.fg = xterm256(codes[k + 2]);
          k += 2;
        }
      }
      return;
    }
    for (const ch of part) {
      if (ch === '\n') {
        rows.push(row);
        row = [];
      } else row.push({ ch, ...st });
    }
  });
  rows.push(row);
  return rows;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const r1 = (n) => Math.round(n * 100) / 100;

export function toSvg(text) {
  let rows = parseAnsi(text);
  const blank = (r) => r.every((c) => c.ch === ' ');
  while (rows.length && blank(rows[0])) rows.shift();
  while (rows.length && blank(rows[rows.length - 1])) rows.pop();
  const lead = Math.min(...rows.filter((r) => !blank(r)).map((r) => r.findIndex((c) => c.ch !== ' ')));
  rows = rows.map((r) => r.slice(lead));
  const cols = Math.max(...rows.map((r) => r.length));

  const winW = Math.ceil(PAD_X * 2 + cols * CELL_W);
  const winH = Math.ceil(PAD_TOP + rows.length * LINE_H + PAD_BOTTOM);
  const W = winW + MARGIN * 2;
  const H = winH + MARGIN * 2;
  const defs = [];
  const shapes = [];
  const texts = [];
  let gid = 0;

  rows.forEach((row, y) => {
    const top = PAD_TOP + y * LINE_H;
    const mid = top + LINE_H / 2;
    const base = top + LINE_H * 0.7;
    const cx = (x) => PAD_X + x * CELL_W;
    let x = 0;
    while (x < row.length) {
      const c = row[x];
      const color = c.fg || FG;

      // Bars: one rounded rect per run of block cells, its gradient taken from the cell colors.
      if (EIGHTHS[c.ch]) {
        let end = x;
        let eighths = 0;
        while (end < row.length && EIGHTHS[row[end].ch]) eighths += EIGHTHS[row[end++].ch];
        const w = (eighths / 8) * CELL_W;
        const h = LINE_H * 0.62;
        const id = `g${gid++}`;
        const from = row[x].fg || FG;
        const to = row[end - 1].fg || FG;
        defs.push(`<linearGradient id="${id}" x1="0" x2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient>`);
        shapes.push(`<rect x="${r1(cx(x))}" y="${r1(mid - h / 2)}" width="${r1(w)}" height="${r1(h)}" rx="3" fill="url(#${id})"/>`);
        x = end;
        continue;
      }

      // Box lines as geometry, so they join cleanly whatever font is installed.
      if (BOX.has(c.ch)) {
        const stroke = `stroke="${color}" stroke-width="1.2" stroke-linecap="square" fill="none"`;
        if (c.ch === '─') {
          let end = x;
          while (end < row.length && row[end].ch === '─' && (row[end].fg || FG) === color) end++;
          shapes.push(`<line x1="${r1(cx(x))}" y1="${r1(mid)}" x2="${r1(cx(end))}" y2="${r1(mid)}" ${stroke}/>`);
          x = end;
          continue;
        }
        const ccx = cx(x) + CELL_W / 2;
        const r = CELL_W / 2;
        const d = {
          '│': `M${r1(ccx)} ${r1(top)}V${r1(top + LINE_H)}`,
          '╭': `M${r1(cx(x + 1))} ${r1(mid)}H${r1(ccx + r)}A${r1(r)} ${r1(r)} 0 0 0 ${r1(ccx)} ${r1(mid + r)}V${r1(top + LINE_H)}`,
          '╮': `M${r1(cx(x))} ${r1(mid)}H${r1(ccx - r)}A${r1(r)} ${r1(r)} 0 0 1 ${r1(ccx)} ${r1(mid + r)}V${r1(top + LINE_H)}`,
          '╰': `M${r1(ccx)} ${r1(top)}V${r1(mid - r)}A${r1(r)} ${r1(r)} 0 0 0 ${r1(ccx + r)} ${r1(mid)}H${r1(cx(x + 1))}`,
          '╯': `M${r1(ccx)} ${r1(top)}V${r1(mid - r)}A${r1(r)} ${r1(r)} 0 0 1 ${r1(ccx - r)} ${r1(mid)}H${r1(cx(x))}`,
        }[c.ch];
        shapes.push(`<path d="${d}" ${stroke}/>`);
        x++;
        continue;
      }

      if (c.ch === ' ') {
        x++;
        continue;
      }

      // Text: a run of cells with the same style, every glyph pinned to its grid column.
      let end = x;
      const same = (a, b) => a.fg === b.fg && a.bold === b.bold && a.dim === b.dim && a.ul === b.ul;
      while (end < row.length && same(row[end], c) && !EIGHTHS[row[end].ch] && !BOX.has(row[end].ch)) end++;
      while (end > x + 1 && row[end - 1].ch === ' ') end--;
      // One <text> per word: renderers collapse runs of spaces, which would shift the columns.
      const style = [`y="${r1(base)}"`, `fill="${color}"`];
      if (c.bold) style.push('font-weight="600"');
      if (c.dim) style.push('opacity="0.55"');
      for (let i = x; i < end; ) {
        if (row[i].ch === ' ') {
          i++;
          continue;
        }
        let j = i;
        while (j < end && row[j].ch !== ' ') j++;
        const xs = row.slice(i, j).map((_, k) => r1(cx(i + k))).join(' ');
        texts.push(`<text x="${xs}" ${style.join(' ')}>${esc(row.slice(i, j).map((k) => k.ch).join(''))}</text>`);
        i = j;
      }
      if (c.ul) {
        const uy = r1(base + 3);
        shapes.push(`<line x1="${r1(cx(x))}" y1="${uy}" x2="${r1(cx(end))}" y2="${uy}" stroke="${color}" stroke-width="1"/>`);
      }
      x = end;
    }
  });

  const dots = ['#3a3d44', '#3a3d44', '#3a3d44']
    .map((f, i) => `<circle cx="${22 + i * 20}" cy="24" r="6" fill="${f}"/>`)
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xml:space="preserve">
<defs>${defs.join('')}</defs>
<rect width="${W}" height="${H}" fill="${BACKDROP}"/>
<g transform="translate(${MARGIN} ${MARGIN})">
<rect x="0.5" y="0.5" width="${winW - 1}" height="${winH - 1}" rx="12" fill="${BG}" stroke="#ffffff17"/>
${dots}
<g font-family="ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Monaco, Consolas, monospace" font-size="${FONT}" style="white-space: pre">
${shapes.join('\n')}
${texts.join('\n')}
</g>
</g>
</svg>
`;
}

async function run() {
  const args = process.argv.slice(2);
  const dash = args.indexOf('--');
  const out = args[0] && dash !== 0 ? resolve(args[0]) : resolve(here, '../docs/card.svg');
  const flags = dash >= 0 ? args.slice(dash + 1) : SAMPLE;
  const svg = toSvg(await card(flags));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, svg);
  process.stdout.write(`${out}\n`);
  const [w, h] = /width="(\d+)" height="(\d+)"/.exec(svg).slice(1).map(Number);
  const png = out.replace(/\.svg$/, '') + '.png';
  const how = toPng(out, png, w, h);
  process.stdout.write(how ? `${png} (${how})\n` : 'no SVG to PNG converter worked here (tried rsvg-convert, qlmanage, sips)\n');
}

const WIDTH = 1600;

function ok(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'ignore' });
  return r.status === 0;
}

function toPng(svg, png, w, h) {
  const fitW = Math.round((WIDTH * w) / Math.max(w, h));
  const fitH = Math.round((WIDTH * h) / Math.max(w, h));
  rmSync(png, { force: true });
  if (ok('rsvg-convert', ['-w', String(WIDTH), '-o', png, svg]) && existsSync(png)) return 'rsvg-convert';
  // Quick Look draws a square thumbnail scaled to the image width and cuts off anything taller.
  // So draw the card on a square canvas, then crop the square back to the card.
  const dir = mkdtempSync(resolve(tmpdir(), 'tokens-wrapped-'));
  const side = Math.max(w, h);
  const square = resolve(dir, 'card.svg');
  writeFileSync(
    square,
    readFileSync(svg, 'utf8').replace(
      /width="\d+" height="\d+" viewBox="[^"]*"/,
      `width="${side}" height="${side}" viewBox="0 0 ${side} ${side}"`,
    ),
  );
  const thumb = square + '.png';
  if (ok('qlmanage', ['-t', '-s', String(WIDTH), '-o', dir, square]) && existsSync(thumb)) {
    // sips reads a 0 0 offset as "center", so start at 1 1.
    if (ok('sips', ['-c', String(fitH), String(fitW), '--cropOffset', '1', '1', thumb])) {
      renameSync(thumb, png);
      rmSync(dir, { recursive: true, force: true });
      return 'qlmanage + sips';
    }
  }
  rmSync(dir, { recursive: true, force: true });
  if (ok('sips', ['-s', 'format', 'png', svg, '--out', png]) && existsSync(png)) return 'sips';
  return '';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
