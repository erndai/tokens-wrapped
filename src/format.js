const ANSI = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s) {
  return String(s).replace(ANSI, '');
}

export function visibleLength(s) {
  return [...stripAnsi(s)].length;
}

// Color levels: 0 plain, 1 basic 16 colors, 2 xterm 256, 3 truecolor (24-bit).
export const PLAIN = 0;
export const BASIC = 1;
export const ANSI256 = 2;
export const TRUECOLOR = 3;

// Which color level a terminal gets, best first:
// --no-color, NO_COLOR (any non-empty value) -> plain.
// FORCE_COLOR=0|false -> plain. FORCE_COLOR=1|2|3 (or true) -> that level at least, even when piped.
// Not a TTY, or TERM=dumb -> plain.
// COLORTERM=truecolor|24bit, or a terminal known for 24-bit -> truecolor. TERM *256color -> 256. Else 16.
export function colorLevel({ env = {}, isTTY = false, noColorFlag = false } = {}) {
  if (noColorFlag) return PLAIN;
  if (env.NO_COLOR != null && env.NO_COLOR !== '') return PLAIN;
  const force = env.FORCE_COLOR;
  let forced = 0;
  if (force != null && force !== '') {
    if (force === '0' || force === 'false') return PLAIN;
    forced = /^[123]$/.test(force) ? Number(force) : BASIC;
  }
  if (!forced && (env.TERM === 'dumb' || !isTTY)) return PLAIN;
  return Math.max(forced, detected(env));
}

function detected(env) {
  const ct = String(env.COLORTERM || '').toLowerCase();
  const term = String(env.TERM || '').toLowerCase();
  const prog = String(env.TERM_PROGRAM || '');
  if (ct === 'truecolor' || ct === '24bit') return TRUECOLOR;
  if (/-direct$|truecolor|kitty|ghostty|wezterm|alacritty/.test(term)) return TRUECOLOR;
  if (['iTerm.app', 'WezTerm', 'vscode', 'ghostty', 'Hyper', 'WarpTerminal'].includes(prog)) return TRUECOLOR;
  if (env.WT_SESSION) return TRUECOLOR; // Windows Terminal
  if (/256/.test(term) || prog === 'Apple_Terminal') return ANSI256;
  return BASIC;
}

// Color on when writing to a TTY, unless --no-color or NO_COLOR (any non-empty value) is set.
// FORCE_COLOR=1 turns it on for pipes.
export function colorEnabled(opts) {
  return colorLevel(opts) > PLAIN;
}

export function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

// Nearest xterm-256 color: the 6x6x6 cube or the 24-step gray ramp, whichever is closer.
export function rgbTo256([r, g, b]) {
  const steps = [0, 95, 135, 175, 215, 255];
  const near = (v) => steps.reduce((best, s, i) => (Math.abs(s - v) < Math.abs(steps[best] - v) ? i : best), 0);
  const [qr, qg, qb] = [near(r), near(g), near(b)];
  const cube = [steps[qr], steps[qg], steps[qb]];
  const avg = (r + g + b) / 3;
  const gi = Math.max(0, Math.min(23, Math.round((avg - 8) / 10)));
  const gv = 8 + gi * 10;
  const d = (c) => (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
  return d([gv, gv, gv]) < d(cube) ? 232 + gi : 16 + 36 * qr + 6 * qg + qb;
}

export function mix(a, b, t) {
  return a.map((v, i) => Math.round(v + (b[i] - v) * t));
}

// A color is { hex, basic } where basic is a 16-color SGR code (30-37, 90-97).
function fgOpen(color, level, rgb = hexToRgb(color.hex)) {
  if (level >= TRUECOLOR) return `38;2;${rgb[0]};${rgb[1]};${rgb[2]}`;
  if (level === ANSI256) return `38;5;${rgbTo256(rgb)}`;
  return String(color.basic);
}

// level: 0-3, or a boolean (true = basic 16 colors).
export function makeStyle(level) {
  const lv = level === true ? BASIC : Number(level) || PLAIN;
  const enabled = lv > PLAIN;
  const wrap = (open, close) => (s) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
  const fg = (color) => (enabled ? wrap(fgOpen(color, lv), 39) : (s) => String(s));
  // Secondary text: an explicit gray where the terminal can show one, SGR dim otherwise.
  const gray = { hex: '#8a8f98', basic: 90 };
  return {
    enabled,
    level: lv,
    bold: wrap(1, 22),
    dim: lv >= ANSI256 ? fg(gray) : wrap(2, 22),
    green: wrap(32, 39),
    cyan: wrap(36, 39),
    underline: wrap(4, 24),
    fg,
    // A run of bar cells that fades from `fade` of the way to black up to the full color.
    // Truecolor only; other levels paint it solid.
    ramp(text, color, fade = 0.4) {
      if (!enabled) return String(text);
      const chars = [...String(text)];
      if (lv < TRUECOLOR || chars.length < 2) return fg(color)(text);
      const end = hexToRgb(color.hex);
      const start = mix(end, [0, 0, 0], fade);
      const n = chars.length;
      return (
        chars.map((c, i) => `\x1b[${fgOpen(color, lv, mix(start, end, i / (n - 1)))}m${c}`).join('') + '\x1b[39m'
      );
    },
  };
}

const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Spend: nearest dollar, cents only under $10.
export function usd(x) {
  const v = Number(x) || 0;
  if (Math.abs(v) < 10 && Math.round(v) !== v) {
    if (Math.abs(v) < 0.005) return '$0';
    return '$' + nf2.format(v);
  }
  return '$' + nf.format(Math.round(v));
}

// Money back: always whole dollars, already floored by the caller.
export function usdWhole(x) {
  return '$' + nf.format(Math.floor(Number(x) || 0));
}

export function padEnd(s, n) {
  const len = visibleLength(s);
  return len >= n ? s : s + ' '.repeat(n - len);
}

export function padStart(s, n) {
  const len = visibleLength(s);
  return len >= n ? s : ' '.repeat(n - len) + s;
}

export function truncate(s, n) {
  const chars = [...String(s)];
  if (chars.length <= n) return String(s);
  if (n <= 1) return chars.slice(0, n).join('');
  return chars.slice(0, n - 1).join('') + '.';
}

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

export function bar(fraction, width) {
  if (width <= 0 || !(fraction > 0)) return '';
  const units = Math.max(1, Math.round(Math.min(1, fraction) * width * 8));
  const full = Math.floor(units / 8);
  return '█'.repeat(full) + EIGHTHS[units % 8];
}
