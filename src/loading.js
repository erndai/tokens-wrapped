// The loading screen while your agents' logs are read: a big live token counter in the sky colors, your year
// drawing itself week by week, and each agent ticking off as it's read. Written to stderr on a terminal only;
// small or colorless terminals get a one-line spinner, and pipes get nothing.

import { SKY } from './brand.js';
import { hexToRgb, rgbTo256, mix, visibleLength, TRUECOLOR, ANSI256, PLAIN } from './format.js';
import { compact } from './share.js';

const STOPS = [SKY.blue, SKY.violet, SKY.purple, SKY.pink].map(hexToRgb);

// The sky gradient at t (0..1).
export function sky(t) {
  const x = Math.max(0, Math.min(1, t)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(x));
  return mix(STOPS[i], STOPS[i + 1], x - i);
}

function paint(s, rgb, level) {
  if (level >= TRUECOLOR) return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${s}\x1b[39m`;
  if (level === ANSI256) return `\x1b[38;5;${rgbTo256(rgb)}m${s}\x1b[39m`;
  if (level > PLAIN) return `\x1b[35m${s}\x1b[39m`;
  return s;
}
const gray = (s, level) => (level >= ANSI256 ? paint(s, [110, 114, 122], level) : level > PLAIN ? `\x1b[2m${s}\x1b[22m` : s);
const bold = (s, level) => (level > PLAIN ? `\x1b[1m${s}\x1b[22m` : s);

// Back and forth across the gradient, so a moving shimmer never jumps from pink to blue.
const wave = (u) => 1 - Math.abs((((u % 2) + 2) % 2) - 1);

// Each character colored by where it sits, the gradient sliding with `phase`.
function gradient(text, level, phase = 0, span = text.length) {
  return [...text].map((c, x) => (c === ' ' ? c : paint(c, sky(wave(x / Math.max(1, span) + phase)), level))).join('');
}

// Big three-row digits.
const BIG = {
  0: ['█▀█', '█ █', '▀▀▀'],
  1: ['▀█ ', ' █ ', '▀▀▀'],
  2: ['▀▀█', '█▀▀', '▀▀▀'],
  3: ['▀▀█', ' ▀█', '▀▀▀'],
  4: ['█ █', '▀▀█', '  ▀'],
  5: ['█▀▀', '▀▀█', '▀▀▀'],
  6: ['█▀▀', '█▀█', '▀▀▀'],
  7: ['▀▀█', '  █', '  ▀'],
  8: ['█▀█', '█▀█', '▀▀▀'],
  9: ['█▀█', '▀▀█', '▀▀▀'],
  ',': [' ', ' ', '▄'],
};
export function bigDigits(n) {
  const s = Math.round(n).toLocaleString('en-US');
  const rows = ['', '', ''];
  for (const c of s) for (let r = 0; r < 3; r++) rows[r] += (BIG[c] || ['   ', '   ', '   '])[r] + ' ';
  return rows.map((r) => r.trimEnd());
}

const QUIPS = [
  'counting your cache hits',
  'finding your 3am sessions',
  'looking for your biggest day',
  'adding it up at API prices',
  'measuring your streak',
  'tallying the lines your agents wrote',
  'ranking your models',
  'all on this computer, nothing leaves it',
];

const LEVELS = ' ▁▂▃▄▅▆▇█';
const MONTHS = 'JFMAMJJASOND';
const DAY = 86400000;

// Tokens (or, for agents with no token counts, replies) per week of the year so far.
function weeks(tallies, now) {
  const start = new Date(now.getFullYear(), 0, 1);
  const n = Math.max(1, Math.ceil((now - start) / (7 * DAY)));
  const out = new Array(n).fill(0);
  for (const t of tallies) {
    const src = t.tokensKnown && t.days.size ? t.days : t.dayActivity;
    for (const [d, v] of src) {
      const w = Math.floor((new Date(`${d}T12:00:00`) - start) / (7 * DAY));
      if (w >= 0 && w < n) out[w] += v;
    }
  }
  return { out, start };
}

const totalTokens = (t) => (t.tokensKnown ? t.tokens.input + t.tokens.output : 0);

// One frame, as lines. Pure, so it can be tested: state is what the scan has reported so far.
export function frame(state, { level, columns = 80, now = new Date(), tick = 0 }) {
  const lines = [];
  const phase = tick * 0.035;
  const pad = '  ';
  lines.push('');
  lines.push(pad + bold(gradient('tokens-wrapped', level, phase), level) + gray(`   your ${now.getFullYear()} in AI`, level));
  lines.push('');

  const shown = Math.round(state.shown);
  const big = bigDigits(shown);
  const label = shown === 0 && !state.done.length ? 'warming up' : 'tokens';
  if (visibleLength(big[0]) + 12 <= columns) {
    big.forEach((row, r) => lines.push(pad + gradient(row, level, phase, big[0].length) + (r === 2 ? gray(`  ${label}`, level) : '')));
  } else {
    lines.push(pad + bold(gradient(shown.toLocaleString('en-US'), level, phase), level) + gray(` ${label}`, level));
  }
  lines.push('');

  // The year, drawing itself.
  const all = [...state.done.map((d) => d.t), ...(state.live ? [state.live] : [])];
  const { out, start } = weeks(all, now);
  const max = Math.max(...out);
  const width = Math.min(out.length, columns - 6);
  const cols = out.slice(out.length - width);
  const spark = cols
    .map((v, x) => {
      if (!v || !max) return gray('▁', level);
      const h = Math.max(1, Math.round((v / max) * 8));
      return paint(LEVELS[h], sky(wave(x / width + phase)), level);
    })
    .join('');
  lines.push(pad + spark);
  let months = '';
  for (let x = 0; x < width; x++) {
    const d = new Date(start.getTime() + (out.length - width + x) * 7 * DAY);
    const prev = new Date(d.getTime() - 7 * DAY);
    months += x === 0 || d.getMonth() !== prev.getMonth() ? MONTHS[d.getMonth()] : ' ';
  }
  lines.push(pad + gray(months, level));
  lines.push('');

  // Agents read so far, then the one being read.
  for (const d of state.done) {
    const what = d.t.tokensKnown ? `${compact(totalTokens(d.t))} tokens` : `${d.t.replies.toLocaleString('en-US')} messages`;
    lines.push(`${pad}${paint('✓', sky(0.9), level)} ${d.name.padEnd(16)}${gray(what, level)}`);
  }
  if (state.current) {
    const bw = 22;
    let barText;
    if (state.n) {
      const filled = Math.round((state.i / state.n) * bw);
      barText = paint('━'.repeat(filled), sky(state.i / state.n), level) + gray('━'.repeat(bw - filled), level);
    } else {
      const at = tick % (bw + 6);
      barText = [...'━'.repeat(bw)].map((c, x) => (Math.abs(x - at + 3) < 3 ? paint(c, sky(x / bw), level) : gray(c, level))).join('');
    }
    const count = state.n ? gray(`  ${state.i.toLocaleString('en-US')} of ${state.n.toLocaleString('en-US')}`, level) : '';
    lines.push(`${pad}${paint('⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[tick % 10], sky(0.2), level)} ${state.current.padEnd(16)}${barText}${count}`);
  }
  lines.push('');
  const quip = QUIPS[Math.floor(tick / 22) % QUIPS.length];
  lines.push(`${pad}${paint(tick % 8 < 4 ? '✦' : '✧', sky(0.75), level)} ${gray(quip + '.'.repeat(1 + (Math.floor(tick / 5) % 3)), level)}`);
  return lines;
}

// The one-line spinner for small or colorless terminals.
function simple(stream) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  let msg = 'Reading your coding agents...';
  const draw = () => stream.write(`\r\x1b[2K${frames[i++ % frames.length]} ${msg}`);
  const timer = setInterval(draw, 90);
  draw();
  return {
    update(m) {
      if (m) msg = m;
    },
    async done() {
      clearInterval(timer);
      stream.write('\r\x1b[2K');
    },
  };
}

export function loadingScreen(stream, { level, now = new Date() } = {}) {
  if (!stream?.isTTY) return { update() {}, async done() {} };
  const columns = stream.columns || 80;
  const rows = stream.rows || 24;
  if (level <= PLAIN || columns < 50 || rows < 18) return simple(stream);

  const state = { shown: 0, done: [], current: null, live: null, i: 0, n: 0 };
  let tick = 0;
  let height = 0;
  const maxAgents = rows - 16;
  const target = () => state.done.reduce((s, d) => s + totalTokens(d.t), 0) + (state.live ? totalTokens(state.live) : 0);
  const draw = () => {
    const goal = target();
    state.shown += Math.max(Math.min(goal - state.shown, Math.ceil((goal - state.shown) * 0.16)), 0);
    if (goal - state.shown < 1) state.shown = goal;
    const view = { ...state, done: state.done.slice(-maxAgents) };
    const lines = frame(view, { level, columns, now, tick: tick++ });
    const up = height > 1 ? `\x1b[${height - 1}A` : '';
    stream.write(`\r${up}\x1b[J${lines.join('\n')}`);
    height = lines.length;
  };
  const showCursor = () => stream.write('\x1b[?25h');
  const onInt = () => {
    showCursor();
    stream.write('\n');
    process.exit(130);
  };
  process.once('SIGINT', onInt);
  process.once('exit', showCursor);
  stream.write('\x1b[?25l');
  const timer = setInterval(draw, 60);
  draw();
  return {
    update(_msg, info = {}) {
      if (info.done) {
        state.done.push({ name: info.name, t: info.t });
        state.current = null;
        state.live = null;
      } else if (info.name) {
        if (info.name !== state.current) Object.assign(state, { current: info.name, live: null, i: 0, n: 0 });
        if (info.t) Object.assign(state, { live: info.t, i: info.i, n: info.n });
      }
    },
    // Let the counter land on the final number, hold it a beat, then clear the screen for the summary.
    async done() {
      clearInterval(timer);
      state.current = null;
      state.live = null;
      if (state.done.length) {
        for (let k = 0; k < 14 && state.shown < target(); k++) {
          draw();
          await new Promise((r) => setTimeout(r, 40));
        }
        state.shown = target();
        draw();
        await new Promise((r) => setTimeout(r, 450));
      }
      const up = height > 1 ? `\x1b[${height - 1}A` : '';
      stream.write(`\r${up}\x1b[J`);
      showCursor();
      process.removeListener('SIGINT', onInt);
      process.removeListener('exit', showCursor);
    },
  };
}
