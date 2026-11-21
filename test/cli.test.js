import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.js';
import { stripAnsi, visibleLength } from '../src/format.js';
import { fakeFetch, sink, NOW, FAKE_OPENAI_KEY, FAKE_ANTHROPIC_KEY, providerRouter, EMPTY_HOME } from './_helpers.js';

const BIN = fileURLToPath(new URL('../bin/tokens-wrapped.js', import.meta.url));
const MANUAL = ['--openai', '10000', '--anthropic', '2000', '--wafer', '2000', '--other', '20000'];
const noNet = () => {
  throw new Error('network call in a manual run');
};

async function run(argv, { env = {}, tty = false, columns = 80, fetch = noNet, prompt } = {}) {
  const stdout = sink({ isTTY: tty, columns });
  const stderr = sink({ isTTY: tty });
  const code = await main({ home: EMPTY_HOME, argv, env, stdout, stderr, stdin: { isTTY: tty }, fetch, now: NOW, prompt });
  return { code, out: stdout.text, err: stderr.text };
}

test('manual mode card: numbers, closing lines, no network', async () => {
  const r = await run(MANUAL);
  assert.equal(r.code, 0);
  assert.match(r.out, /\$168,000 a year on AI/);
  assert.match(r.out, /OpenAI .*\$10,000 +\$4,800/);
  assert.match(r.out, /AI total +\$14,000 +│/); // no competing back total
  assert.doesNotMatch(r.out, /per month/);
  assert.match(r.out, /Wafer .*\$2,000 +\$2,400/);
  assert.match(r.out, /Everything else .*\$20,000 +\$3,600/);
  assert.match(r.out, /With the ernd card: about \$11,700 back a year\./);
  assert.match(r.out, /4% at every AI vendor\. 10% at Wafer\./);
  assert.match(r.out, /Request it free at ernd\.ai/);
});

test('wording rules hold in every output', async () => {
  const outs = [
    (await run(MANUAL)).out,
    (await run(['--nodus', '3000', '--trace', '1500', '--firecrawl', '400'])).out,
    (await run(['--openai', '500'])).out,
    (await run(['--nodus', '500'])).out,
    (await run(['--help'])).out,
    (await run(MANUAL.concat('--json'))).out,
  ].join('\n');
  assert.doesNotMatch(outs, /\bsav(e|es|ed|ing|ings)\b/i);
  assert.doesNotMatch(outs, /\bappl(y|ied|ication)\b/i);
  assert.doesNotMatch(outs, /—/); // em dash
  assert.doesNotMatch(outs, /partners? (like|such as) (OpenAI|Anthropic)|OpenAI.{0,20}partner/i);
  assert.doesNotMatch(outs, /guarantee|credit check|approv/i);
  assert.doesNotMatch(outs, /discount/i);
});

test('ernd part is the last 3 lines of the card', async () => {
  const lines = stripAnsi((await run(MANUAL)).out).split('\n').filter((l) => /│/.test(l));
  const content = lines.map((l) => l.replace(/^\s*│\s*/, '').replace(/\s*│\s*$/, '')).filter(Boolean);
  const idx = content.findIndex((l) => /ernd/.test(l));
  assert.equal(content.length - idx, 3);
});

test('perk-only lines: Nodus and Trace show text, add nothing; Firecrawl at 1.5%', async () => {
  const r = await run(['--nodus', '3000', '--trace', '1500', '--firecrawl', '400', '--no-color']);
  assert.match(r.out, /7\.5% off spot and on-demand GPU rentals/);
  assert.match(r.out, /62% off the Startup plan, \$1,500 instead of \$4,000/);
  assert.match(r.out, /2x usage limits/);
  assert.match(r.out, /Firecrawl .*\$400 +\$72/);
  assert.match(r.out, /under \$100 back a year/);
  const j = JSON.parse((await run(['--nodus', '3000', '--json'])).out);
  assert.equal(j.back_per_year_usd, 0);
});

test('--json shape', async () => {
  const r = await run(MANUAL.concat('--json'));
  assert.equal(r.code, 0);
  const j = JSON.parse(r.out);
  assert.deepEqual(Object.keys(j), [
    'version', 'period', 'lines', 'ai_monthly_usd', 'ai_yearly_usd', 'other_monthly_usd',
    'back_per_year_exact_usd', 'back_per_year_usd', 'errors', 'warnings', 'ernd',
  ]);
  assert.equal(j.ai_monthly_usd, 14000);
  assert.equal(j.ai_yearly_usd, 168000);
  assert.equal(j.other_monthly_usd, 20000);
  assert.equal(j.back_per_year_exact_usd, 11760);
  assert.equal(j.back_per_year_usd, 11700);
  assert.deepEqual(j.errors, []);
  assert.equal(j.ernd.url, 'https://ernd.ai');
  for (const l of j.lines) {
    assert.deepEqual(Object.keys(l), ['id', 'name', 'kind', 'source', 'monthly_usd', 'yearly_usd', 'rate_pct', 'back_per_year_usd', 'perk', 'by_item']);
  }
  assert.doesNotMatch(r.out, /\x1b\[/);
});

test('NO_COLOR and --no-color turn off ANSI; TTY turns it on', async () => {
  assert.match((await run(MANUAL, { tty: true })).out, /\x1b\[/);
  assert.doesNotMatch((await run(MANUAL, { tty: true, env: { NO_COLOR: '1' } })).out, /\x1b\[/);
  assert.doesNotMatch((await run(MANUAL.concat('--no-color'), { tty: true })).out, /\x1b\[/);
  assert.doesNotMatch((await run(MANUAL)).out, /\x1b\[/); // pipe
});

test('fits in 80 columns (and narrower)', async () => {
  for (const columns of [80, 60, 48]) {
    for (const tty of [false, true]) {
      const r = await run(MANUAL.concat('--by-model'), { columns, tty, env: { OPENAI_ADMIN_KEY: 'sk-FAKE-x' }, fetch: fakeFetch(providerRouter()) });
      for (const line of r.out.split('\n')) assert.ok(visibleLength(line) <= columns, `${columns}: ${line}`);
    }
  }
  const help = (await run(['--help'])).out;
  for (const line of help.split('\n')) assert.ok(line.length <= 80, line);
});

test('keys from env: card from both cost APIs, --by-model lists models', async () => {
  const f = fakeFetch(providerRouter());
  const r = await run(['--by-model', '--no-color'], { env: { OPENAI_ADMIN_KEY: FAKE_OPENAI_KEY, ANTHROPIC_ADMIN_KEY: FAKE_ANTHROPIC_KEY }, fetch: f });
  assert.equal(r.code, 0, r.err);
  assert.equal(f.calls.length, 4);
  assert.match(r.out, /last 30 days/);
  assert.match(r.out, /OpenAI .*\$15/);
  assert.match(r.out, /Anthropic .*\$1,721/);
  assert.match(r.out, /claude-opus-5-5/);
  assert.match(r.out, /gpt-6\.2-astra/);
  for (const u of f.calls.map((c) => new URL(c.url).hostname)) assert.ok(['api.openai.com', 'api.anthropic.com'].includes(u));
});

test('a manual flag beats the key for that provider; --offline makes no calls', async () => {
  const f = fakeFetch(providerRouter());
  const env = { OPENAI_ADMIN_KEY: FAKE_OPENAI_KEY, ANTHROPIC_ADMIN_KEY: FAKE_ANTHROPIC_KEY };
  const j = JSON.parse((await run(['--openai', '9000', '--json'], { env, fetch: f })).out);
  assert.equal(f.calls.every((c) => new URL(c.url).hostname === 'api.anthropic.com'), true);
  assert.equal(j.lines.find((l) => l.id === 'openai').monthly_usd, 9000);
  assert.equal(j.lines.find((l) => l.id === 'anthropic').source, 'api');
  const r = await run(['--offline', '--wafer', '100'], { env, fetch: noNet });
  assert.equal(r.code, 0);
});

test('non-TTY with nothing given and no agent logs: says so and exits 1', async () => {
  const r = await run([]);
  assert.equal(r.code, 1);
  assert.match(r.err, /no coding agent logs from this year found/);
  assert.match(r.err, /--keys/);
  assert.equal(r.out, '');
});

test('interactive: two questions on a TTY', async () => {
  const answers = ['openai 8000 anthropic 4000 wafer 2000', '20000'];
  const asked = [];
  const prompt = async (q) => {
    asked.push(q);
    return answers.shift();
  };
  const r = await run(['--no-color'], { tty: true, prompt });
  assert.equal(r.code, 0);
  assert.equal(asked.length, 2);
  assert.match(r.out, /With the ernd card: about \$11,700 back a year\./); // 3840 + 1920 + 2400 + 3600
});

test('--help, --version and the real bin', () => {
  const v = spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(v.status, 0);
  assert.match(v.stdout, /^\d+\.\d+\.\d+\n$/);
  const h = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.match(h.stdout, /api\.openai\.com and api\.anthropic\.com/);
  assert.match(h.stdout, /no telemetry/);
  // An empty home: no agent logs to read, so it exits 1 without reading this machine's real logs.
  const none = spawnSync(process.execPath, [BIN], { encoding: 'utf8', input: '', env: { PATH: process.env.PATH, HOME: EMPTY_HOME, USERPROFILE: EMPTY_HOME } });
  assert.equal(none.status, 1);
});

const cardWidths = (out) => [...new Set(stripAnsi(out).split('\n').filter((l) => /[│╭╰]/.test(l)).map(visibleLength))];

test('big amounts keep every card line the same width', async () => {
  for (const argv of [['--openai', '5000000', '--other', '5000000'], ['--openai', '1000000000', '--wafer', '999999999', '--other', '1000000000']]) {
    for (const columns of [80, 60, 48]) {
      for (const tty of [false, true]) {
        const r = await run(argv, { columns, tty });
        assert.equal(r.code, 0);
        assert.equal(cardWidths(r.out).length, 1, `${argv.join(' ')} @${columns}`);
        for (const line of r.out.split('\n')) assert.ok(visibleLength(line) <= columns);
      }
    }
  }
  const r = await run(['--openai', '1000000001']);
  assert.equal(r.code, 2);
  assert.match(r.err, /up to \$1,000,000,000/);
});

test('narrow terminals: no box, still fits', async () => {
  const r = await run(MANUAL, { columns: 40 });
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /[│╭]/);
  for (const line of r.out.split('\n')) assert.ok(visibleLength(line) <= 40, line);
});

test('row names are never cut off at 80 and 60 columns', async () => {
  for (const columns of [80, 60]) {
    const a = await run(['--ai', '12000', '--other', '1'], { columns });
    assert.match(a.out, /Other AI vendors|Other AI /, `${columns}`);
    assert.match(a.out, /Everything else/, `${columns}`);
    assert.doesNotMatch(a.out, /\w\.\s+(?:[█▏▎▍▌▋▊▉]|\$)/, `${columns}: cut name`);
  }
  const a = await run(['--ai', '12000'], { columns: 80 });
  assert.match(a.out, /Other AI vendors/);
  const n = await run(['--superserve', '100', '--nodus', '100'], { columns: 48 });
  assert.match(n.out, /Superserve/);
});

test('closing line: Hopper keeps its API credits qualifier', async () => {
  const r = await run(['--hopper', '1000', '--no-color']);
  assert.match(r.out, /8% on Hopper API credits/);
  assert.doesNotMatch(r.out, /8% at Hopper/);
});

test('perks closing line only when a perk row is on the card', async () => {
  const p = await run(['--nodus', '500']);
  assert.match(p.out, /you get the perks above/);
  const z = await run(['--openai', '0']);
  assert.equal(z.code, 1);
  assert.match(z.err, /no spend given/);
  assert.equal(z.out, '');
});

test('--months: strict number, and a note when no key is used', async () => {
  for (const m of ['0x5', '1e1', '5.0', ' ']) {
    const r = await run(['--months', m, '--openai', '5']);
    assert.equal(r.code, 2, m);
  }
  const r = await run(['--months', '3', '--openai', '5']);
  assert.equal(r.code, 0);
  assert.match(r.err, /--months only applies to costs read with admin keys/);
});

test('parseArgs errors become one short line', async () => {
  for (const [argv, re] of [
    [['--foo', '3'], /^tokens-wrapped: unknown flag --foo\n/],
    [['--openai', '-5'], /^tokens-wrapped: --openai takes a monthly amount in USD, like --openai 8000\n/],
    [['--openai', '--no-color'], /^tokens-wrapped: --openai takes a monthly amount/],
    [['--json=1'], /^tokens-wrapped: --json doesn't take a value\n/],
  ]) {
    const r = await run(argv);
    assert.equal(r.code, 2);
    assert.match(r.err, re);
    assert.equal(r.err.trim().split('\n').length, 2, r.err);
  }
});

test('key on argv error has the prefix once', async () => {
  const r = await run(['--key', 'x']);
  assert.match(r.err, /^tokens-wrapped: keys never go in flags/);
  assert.doesNotMatch(r.err, /tokens-wrapped: tokens-wrapped/);
});

test('interactive: prompts go to stderr when stdout is a file', async () => {
  const answers = ['openai 8000', ''];
  const stdout = sink({ isTTY: false });
  const stderr = sink({ isTTY: true });
  const code = await main({ home: EMPTY_HOME, argv: ['--no-color'], env: {}, stdout, stderr, stdin: { isTTY: true }, fetch: noNet, now: NOW, prompt: async () => answers.shift() });
  assert.equal(code, 0);
  assert.match(stdout.text, /OpenAI/);
  const none = await main({ home: EMPTY_HOME, argv: [], env: {}, stdout: sink(), stderr: sink(), stdin: { isTTY: true }, fetch: noNet, now: NOW });
  assert.equal(none, 1); // neither stdout nor stderr is a terminal: help, exit 1
});

test('interactive: Ctrl+C exits 130 quietly; two unreadable answers stop early', async () => {
  const { PromptCancelled } = await import('../src/interactive.js');
  const c = await run([], { tty: true, prompt: async () => { throw new PromptCancelled(); } });
  assert.equal(c.code, 130);
  assert.doesNotMatch(c.err, /error/);
  const asked = [];
  const r = await run([], { tty: true, prompt: async (q) => { asked.push(q); return 'lots'; } });
  assert.equal(r.code, 1);
  assert.equal(asked.length, 2);
});

test('interactive: skipped text is reported', async () => {
  const answers = ['openai 8000 lots of stuff', ''];
  const r = await run(['--no-color'], { tty: true, prompt: async () => answers.shift() });
  assert.match(r.out, /Skipped "lots stuff"/);
});
