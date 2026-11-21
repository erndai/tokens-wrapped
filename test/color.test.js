import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.js';
import { colorLevel, colorEnabled, makeStyle, rgbTo256, hexToRgb, stripAnsi, visibleLength } from '../src/format.js';
import { parseAnsi, toSvg } from '../scripts/snapshot.js';
import { sink, NOW, EMPTY_HOME } from './_helpers.js';

const BIN = fileURLToPath(new URL('../bin/tokens-wrapped.js', import.meta.url));
const MANUAL = ['--openai', '10000', '--anthropic', '2000', '--wafer', '2000', '--other', '20000'];
const EIGHT = [
  '--openai', '10000', '--anthropic', '6000', '--wafer', '2000', '--hopper', '900',
  '--conifer', '700', '--superserve', '400', '--agentphone', '200', '--nodus', '1500', '--other', '20000',
];
const ESC = /\x1b\[/;
const noNet = () => {
  throw new Error('network call');
};

async function run(argv, { env = {}, tty = false, columns = 80 } = {}) {
  const stdout = sink({ isTTY: tty, columns });
  const stderr = sink({ isTTY: tty });
  const code = await main({ home: EMPTY_HOME, argv, env, stdout, stderr, stdin: { isTTY: false }, fetch: noNet, now: NOW });
  return { code, out: stdout.text };
}

test('color level: the fallback chain', () => {
  const tty = (env, extra = {}) => colorLevel({ env, isTTY: true, ...extra });
  assert.equal(tty({ COLORTERM: 'truecolor' }), 3);
  assert.equal(tty({ COLORTERM: '24bit' }), 3);
  assert.equal(tty({ TERM_PROGRAM: 'iTerm.app', TERM: 'xterm-256color' }), 3);
  assert.equal(tty({ TERM: 'xterm-kitty' }), 3);
  assert.equal(tty({ WT_SESSION: 'x' }), 3);
  assert.equal(tty({ TERM: 'xterm-256color' }), 2);
  assert.equal(tty({ TERM_PROGRAM: 'Apple_Terminal', TERM: 'xterm' }), 2);
  assert.equal(tty({ TERM: 'xterm' }), 1);
  assert.equal(tty({}), 1);
});

test('color level: off switches win over everything', () => {
  const rich = { COLORTERM: 'truecolor', TERM: 'xterm-256color' };
  assert.equal(colorLevel({ env: rich, isTTY: true, noColorFlag: true }), 0);
  assert.equal(colorLevel({ env: { ...rich, NO_COLOR: '1' }, isTTY: true }), 0);
  assert.equal(colorLevel({ env: { ...rich, NO_COLOR: '1', FORCE_COLOR: '3' }, isTTY: true }), 0);
  assert.equal(colorLevel({ env: { ...rich, NO_COLOR: '' }, isTTY: true }), 3); // empty NO_COLOR is unset
  assert.equal(colorLevel({ env: { ...rich, FORCE_COLOR: '0' }, isTTY: true }), 0);
  assert.equal(colorLevel({ env: { ...rich, FORCE_COLOR: 'false' }, isTTY: true }), 0);
  assert.equal(colorLevel({ env: { TERM: 'dumb', COLORTERM: 'truecolor' }, isTTY: true }), 0);
  assert.equal(colorLevel({ env: rich, isTTY: false }), 0); // piped
  assert.equal(colorEnabled({ env: rich, isTTY: false }), false);
});

test('color level: FORCE_COLOR turns it on for pipes, at least at its level', () => {
  assert.equal(colorLevel({ env: { FORCE_COLOR: '1' } }), 1);
  assert.equal(colorLevel({ env: { FORCE_COLOR: 'true' } }), 1);
  assert.equal(colorLevel({ env: { FORCE_COLOR: '2' } }), 2);
  assert.equal(colorLevel({ env: { FORCE_COLOR: '3' } }), 3);
  assert.equal(colorLevel({ env: { FORCE_COLOR: '1', COLORTERM: 'truecolor' } }), 3);
});

test('styles emit only the codes their level allows', () => {
  const accent = { hex: '#6ea8fe', basic: 94 };
  const codes = (s) => [...s.matchAll(/\x1b\[([0-9;]*)m/g)].map((m) => m[1]);
  const t = makeStyle(3);
  assert.match(t.fg(accent)('x'), /\x1b\[38;2;110;168;254mx\x1b\[39m/);
  const ramp = t.ramp('████', accent);
  assert.equal(stripAnsi(ramp), '████');
  assert.equal(new Set(codes(ramp)).size, 5); // four shades + reset

  const e = makeStyle(2);
  assert.match(e.fg(accent)('x'), /\x1b\[38;5;\d+m/);
  assert.ok(codes(e.ramp('████', accent) + e.dim('y')).every((c) => !c.startsWith('38;2')));

  const b = makeStyle(1);
  const basic = codes(b.fg(accent)('x') + b.ramp('██', accent) + b.dim('y') + b.bold('z'));
  assert.ok(basic.every((c) => /^(1|2|4|22|24|39|3[0-7]|9[0-7])$/.test(c)), basic.join(' '));

  for (const off of [makeStyle(0), makeStyle(false)]) {
    assert.equal(off.fg(accent)('x') + off.ramp('██', accent) + off.dim('y') + off.bold('z'), 'x██yz');
  }
  assert.equal(makeStyle(true).level, 1);
});

test('rgbTo256 picks the nearest cube or gray', () => {
  assert.equal(rgbTo256([0, 0, 0]), 16);
  assert.equal(rgbTo256([255, 255, 255]), 231);
  assert.equal(rgbTo256([255, 0, 0]), 196);
  assert.equal(rgbTo256([128, 128, 128]), 244);
  assert.deepEqual(hexToRgb('#4cc38a'), [76, 195, 138]);
});

test('every color level draws the same card; only the codes differ', async () => {
  const plain = (await run(MANUAL)).out;
  const levels = {
    3: { COLORTERM: 'truecolor' },
    2: { TERM: 'xterm-256color' },
    1: { TERM: 'xterm' },
  };
  for (const [lv, env] of Object.entries(levels)) {
    const r = await run(MANUAL, { tty: true, env });
    assert.match(r.out, ESC, lv);
    assert.equal(stripAnsi(r.out), plain, `level ${lv}`);
    if (lv === '3') assert.match(r.out, /38;2;/);
    else assert.doesNotMatch(r.out, /38;2;/, lv);
    if (lv === '1') assert.doesNotMatch(r.out, /\x1b\[38;/);
  }
});

test('no ANSI when piped, with NO_COLOR, or with --json, even on a truecolor terminal', async () => {
  const rich = { COLORTERM: 'truecolor', TERM: 'xterm-256color', TERM_PROGRAM: 'iTerm.app' };
  assert.doesNotMatch((await run(MANUAL, { env: rich })).out, ESC);
  assert.doesNotMatch((await run(MANUAL, { tty: true, env: { ...rich, NO_COLOR: '1' } })).out, ESC);
  assert.doesNotMatch((await run(MANUAL.concat('--no-color'), { tty: true, env: rich })).out, ESC);
  assert.doesNotMatch((await run(MANUAL.concat('--json'), { tty: true, env: { ...rich, FORCE_COLOR: '3' } })).out, ESC);

  // The real bin writing into a pipe.
  const p = spawnSync(process.execPath, [BIN, ...MANUAL], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...rich },
  });
  assert.equal(p.status, 0);
  assert.match(p.stdout, /\$168,000 a year on AI/);
  assert.doesNotMatch(p.stdout, ESC);
});

test('truecolor card fits 80 columns with 8 providers, --by-model and big numbers', async () => {
  const env = { COLORTERM: 'truecolor' };
  for (const argv of [EIGHT, EIGHT.concat('--by-model'), ['--openai', '2500000', '--anthropic', '2500000'], ['--wafer', '50']]) {
    for (const columns of [80, 60]) {
      const r = await run(argv, { tty: true, env, columns });
      assert.equal(r.code, 0);
      const lines = r.out.split('\n');
      for (const line of lines) assert.ok(visibleLength(line) <= columns, `${columns}: ${stripAnsi(line)}`);
      const widths = new Set(lines.filter((l) => /[│╭╰]/.test(stripAnsi(l))).map(visibleLength));
      assert.equal(widths.size, 1, argv.join(' '));
    }
  }
});

test('snapshot: ANSI to SVG keeps colors and drops escape codes', async () => {
  const r = await run(MANUAL, { tty: true, env: { COLORTERM: 'truecolor' } });
  const rows = parseAnsi(r.out);
  const openai = rows.find((row) => row.map((c) => c.ch).join('').includes('OpenAI'));
  assert.ok(openai.some((c) => c.ch === '█' && /^#[0-9a-f]{6}$/.test(c.fg)));
  const svg = toSvg(r.out);
  assert.match(svg, /^<svg /);
  assert.match(svg, /linearGradient/);
  assert.match(svg, />\$168,000</);
  assert.doesNotMatch(svg, /\x1b/);
});
