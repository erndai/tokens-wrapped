import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { redact } from '../src/http.js';
import { stripAnsi } from '../src/format.js';
import { hiddenPrompt } from '../src/interactive.js';
import { EventEmitter } from 'node:events';
import { sink, fakeFetch, NOW, FAKE_OPENAI_KEY, EMPTY_HOME } from './_helpers.js';

const costsOnly = () =>
  fakeFetch((url) => {
    if (url.pathname === '/v1/organization/costs') {
      return { body: { data: [{ start_time: 1, results: [{ amount: { value: 300, currency: 'usd' }, line_item: 'gpt-5.1, input' }] }], has_more: false } };
    }
    return { body: { data: [], has_more: false, next_page: null } };
  });

async function run({ argv = [], env = {}, answers = [], fetch = costsOnly(), prompt } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tokens-wrapped-1c-'));
  const stdout = sink({ isTTY: true, columns: 80 });
  const stderr = sink({ isTTY: true });
  const asked = [];
  const opened = [];
  const keyPrompt = async (q) => (asked.push(q), answers.shift() ?? '');
  const code = await main({ home: EMPTY_HOME, argv, env, stdout, stderr, stdin: { isTTY: true }, fetch, now: NOW, keyPrompt, prompt, openFile: (f) => opened.push(f), shareDir: dir });
  return { code, out: stdout.text, err: stderr.text, asked, opened, dir, fetch };
}

test('one command: asks for both keys hidden, says where they go, then opens the recap', async () => {
  const r = await run({ argv: ['--keys'], answers: [FAKE_OPENAI_KEY, ''] });
  try {
    assert.equal(r.code, 0);
    assert.equal(r.asked.length, 2);
    assert.match(r.asked[0], /OpenAI admin key \(hidden, Enter to skip\)/);
    assert.match(r.out, /Keys stay on this computer/);
    assert.match(r.out, /api\.openai\.com and api\.anthropic\.com/);
    assert.match(r.out, /github\.com\/provenanceresearch\/tokens-wrapped/);
    assert.equal(r.opened.length, 1, 'recap opens without --share');
    assert.deepEqual(readdirSync(r.dir), ['year-in-ai.html']);
    // The key went to OpenAI in the header and nowhere else.
    for (const c of r.fetch.calls) {
      assert.equal(new URL(c.url).hostname, 'api.openai.com');
      assert.ok(!c.url.includes(FAKE_OPENAI_KEY));
    }
    assert.ok(!r.out.includes(FAKE_OPENAI_KEY) && !r.err.includes(FAKE_OPENAI_KEY));
    assert.ok(!readFileSync(join(r.dir, 'year-in-ai.html'), 'utf8').includes(FAKE_OPENAI_KEY));
    // Registered: any later redact() removes it, even without being told.
    assert.equal(redact(`boom ${FAKE_OPENAI_KEY}`), 'boom [redacted]');
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test('one command: a key that is not an admin key gets a warning', async () => {
  const r = await run({ argv: ['--keys'], answers: ['sk-proj-notanadminkey1234567890', ''] });
  try {
    assert.match(r.out, /doesn't look like an OpenAI admin key \(sk-admin-\.\.\.\)/);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test('no key prompt when keys are in env, amounts are typed, or --offline', async () => {
  for (const o of [{ env: { OPENAI_ADMIN_KEY: FAKE_OPENAI_KEY } }, { argv: ['--openai', '5000'] }, { argv: ['--offline', '--openai', '5000'] }]) {
    const r = await run(o);
    rmSync(r.dir, { recursive: true, force: true });
    assert.equal(r.asked.length, 0, JSON.stringify(o));
  }
});

test('skipping both keys falls back to typing amounts', async () => {
  const spend = ['openai 5000', ''];
  const r = await run({ argv: ['--keys'], answers: ['', ''], prompt: async () => spend.shift() ?? '' });
  rmSync(r.dir, { recursive: true, force: true });
  assert.equal(r.asked.length, 2);
  assert.equal(r.fetch.calls.length, 0);
  assert.match(stripAnsi(r.out), /\$60,000 a year on AI/);
  assert.equal(r.opened.length, 0);
});

test('--dry-run lists requests, sends nothing, prints no key', async () => {
  const stdout = sink({ isTTY: false });
  const noNet = () => {
    throw new Error('network');
  };
  const code = await main({ home: EMPTY_HOME, argv: ['--dry-run', '--share'], env: { OPENAI_ADMIN_KEY: FAKE_OPENAI_KEY }, stdout, stderr: sink({}), stdin: { isTTY: false }, fetch: noNet, now: NOW });
  assert.equal(code, 0);
  assert.match(stdout.text, /all GET, to api\.openai\.com and api\.anthropic\.com/);
  assert.match(stdout.text, /usage_report\/claude_code {2}\(x\d+\)/);
  assert.match(stdout.text, /headers: Authorization, Content-Type, User-Agent/);
  assert.ok(!stdout.text.includes(FAKE_OPENAI_KEY));
});

test('hidden prompt: echoes nothing, handles paste markers, backspace, Ctrl+C', async () => {
  const mk = () => {
    const input = new EventEmitter();
    Object.assign(input, { isTTY: true, setRawMode() {}, resume() {}, pause() {}, setEncoding() {} });
    let shown = '';
    const output = { write: (s) => (shown += s) };
    return { input, output, shown: () => shown };
  };
  const a = mk();
  const p = hiddenPrompt(a)('key: ');
  a.input.emit('data', '\x1b[200~sk-admin-abcX');
  a.input.emit('data', '\x7f\x1b[201~\r');
  assert.equal(await p, 'sk-admin-abc');
  assert.equal(a.shown(), 'key: \n');
  const b = mk();
  const q = hiddenPrompt(b)('key: ');
  b.input.emit('data', '\u0003');
  await assert.rejects(q, /cancelled/);
});
