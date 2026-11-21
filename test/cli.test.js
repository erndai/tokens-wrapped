import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { stripAnsi } from '../src/format.js';
import { sink, NOW, EMPTY_HOME, claudeHome } from './_helpers.js';

const BIN = fileURLToPath(new URL('../bin/tokens-wrapped.js', import.meta.url));

async function run(argv = [], { home = EMPTY_HOME, tty = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tw-out-'));
  const stdout = sink({ isTTY: tty, columns: 80 });
  const stderr = sink({ isTTY: false });
  const opened = [];
  // The default run must never touch the network.
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('network call');
  };
  try {
    const code = await main({ argv, env: {}, stdout, stderr, now: NOW, home, openFile: (f) => opened.push(f), shareDir: dir });
    return { code, out: stdout.text, err: stderr.text, opened, dir };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('reads local Claude Code logs, prints a summary, writes the recap, opens it on a terminal', async () => {
  const r = await run([], { home: claudeHome(), tty: true });
  try {
    assert.equal(r.code, 0, r.err);
    const out = stripAnsi(r.out);
    assert.match(out, /Your 2026 in AI {2}Mar 2 to Nov 20, from Claude Code/);
    assert.match(out, /10\.1K tokens/); // (100+9000+400+500) once, the repeated line deduped, + (50+50)
    assert.match(out, /at API prices/);
    assert.match(out, /Built {6}3 lines across 1 files, mostly Python/);
    assert.deepEqual(readdirSync(r.dir), ['year-in-ai.html']);
    assert.equal(r.opened.length, 1);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test('no prompt or reply text reaches the output or the recap page', async () => {
  const secret = 'TOP-SECRET-PROMPT-1234';
  const r = await run([], { home: claudeHome(secret) });
  try {
    const html = readFileSync(join(r.dir, 'year-in-ai.html'), 'utf8');
    for (const s of [r.out, r.err, html]) assert.ok(!s.includes(secret));
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test('piped: path on stderr, browser not opened; --json prints numbers', async () => {
  const r = await run(['--json'], { home: claudeHome() });
  try {
    assert.equal(r.code, 0);
    const j = JSON.parse(r.out);
    assert.equal(j.tokens.total, 10100);
    assert.deepEqual(j.sources, ['Claude Code']);
    assert.ok(j.apiValue.api > 0);
    assert.match(r.err, /Your year in AI: file:\/\//);
    assert.equal(r.opened.length, 0);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test('no agent logs: says so and exits 1', async () => {
  const r = await run([]);
  assert.equal(r.code, 1);
  assert.match(r.err, /no coding agent logs from this year found/);
  assert.equal(r.out, '');
});

test('help, version, bad options, and the real bin', async () => {
  const h = await run(['--help']);
  assert.equal(h.code, 0);
  assert.match(h.out, /No keys, no network, no telemetry/);
  assert.match(h.out, /github\.com\/erndai\/tokens-wrapped/);
  assert.match((await run(['-v'])).out, /^\d+\.\d+\.\d+\n$/);
  const bad = await run(['--keys']);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /unknown option --keys/);
  const v = spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(v.status, 0);
  // An empty home: nothing to read, so it exits 1 without touching this machine's real logs.
  const none = spawnSync(process.execPath, [BIN, '--no-open'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: EMPTY_HOME, USERPROFILE: EMPTY_HOME } });
  assert.equal(none.status, 1);
});
