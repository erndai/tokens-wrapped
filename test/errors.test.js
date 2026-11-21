import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as openai from '../src/providers/openai.js';
import * as anthropic from '../src/providers/anthropic.js';
import { main } from '../src/cli.js';
import { getJson, redact } from '../src/http.js';
import { fakeFetch, hangingFetch, sink, NOW, FAKE_OPENAI_KEY, FAKE_ANTHROPIC_KEY, EMPTY_HOME } from './_helpers.js';

const KEYS = [FAKE_OPENAI_KEY, FAKE_ANTHROPIC_KEY];

function assertNoKey(text, label = 'output') {
  for (const k of KEYS) {
    assert.ok(!text.includes(k), `${label} contains a key`);
    // no long fragment either
    assert.ok(!text.includes(k.slice(0, 16)), `${label} contains the start of a key`);
    assert.ok(!text.includes(k.slice(-12)), `${label} contains the end of a key`);
  }
  assert.doesNotMatch(text, /FAKEtestKEY/, `${label} contains part of a key`);
}

// Error bodies that echo the key, like a provider might.
const echo = (status, extraHeaders = {}) => () => ({
  status,
  headers: { 'x-request-id': 'req_123', ...extraHeaders },
  body: { error: { message: `Incorrect API key provided: ${FAKE_OPENAI_KEY} / ${FAKE_ANTHROPIC_KEY}`, type: 'x' } },
});

async function runCli(fetch, extra = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await main({
    home: EMPTY_HOME,
    argv: extra.argv || [],
    env: { OPENAI_ADMIN_KEY: FAKE_OPENAI_KEY, ANTHROPIC_ADMIN_KEY: FAKE_ANTHROPIC_KEY, ...extra.env },
    stdout,
    stderr,
    stdin: { isTTY: false },
    fetch,
    now: NOW,
    timeoutMs: extra.timeoutMs,
  });
  return { code, out: stdout.text, err: stderr.text };
}

const cases = [
  [401, /that key can't read costs \(401\)/],
  [403, /isn't allowed to read costs \(403\)/],
  [404, /404.*provider's side/],
  [500, /server error \(500/],
  [400, /^(OpenAI|Anthropic): request rejected \(400, request id req_123\)(: [a-z_]+)?$/],
];

for (const [status, re] of cases) {
  test(`${status} maps to a clear one-line error, no key anywhere`, async () => {
    for (const p of [openai, anthropic]) {
      const key = p === openai ? FAKE_OPENAI_KEY : FAKE_ANTHROPIC_KEY;
      const err = await p.monthlyCosts({ key, fetch: fakeFetch(echo(status)), now: NOW }).then(
        () => assert.fail('should throw'),
        (e) => e,
      );
      assert.match(err.message, re);
      assert.ok(!err.message.includes('\n'));
      assertNoKey(err.message);
      assertNoKey(String(err.stack), 'stack');
    }
    const r = await runCli(fakeFetch(echo(status)));
    assert.equal(r.code, 1);
    assertNoKey(r.out + r.err);
    const j = await runCli(fakeFetch(echo(status)), { argv: ['--json'] });
    assertNoKey(j.out + j.err, 'json');
  });
}

test('429 reports retry-after', async () => {
  const e = await openai
    .monthlyCosts({ key: FAKE_OPENAI_KEY, fetch: fakeFetch(echo(429, { 'retry-after': '30' })), now: NOW })
    .catch((x) => x);
  assert.match(e.message, /^OpenAI: rate limited \(429\)\. Try again in 30s\.$/);
  const e2 = await anthropic
    .monthlyCosts({ key: FAKE_ANTHROPIC_KEY, fetch: fakeFetch(echo(429)), now: NOW })
    .catch((x) => x);
  assert.match(e2.message, /rate limited \(429\)\. Try again in a minute\./);
  assertNoKey(e.message + e2.message);
});

test('timeout gives up with a clear message', async () => {
  const e = await openai
    .monthlyCosts({ key: FAKE_OPENAI_KEY, fetch: hangingFetch(), now: NOW, timeoutMs: 20 })
    .catch((x) => x);
  assert.equal(e.code, 'timeout');
  assert.match(e.message, /^OpenAI: no answer from api\.openai\.com after/);
  const r = await runCli(hangingFetch(), { timeoutMs: 20, argv: ['--json'] });
  assert.equal(r.code, 1);
  const j = JSON.parse(r.out);
  assert.deepEqual(j.errors.map((x) => x.code).sort(), ['timeout', 'timeout']);
  assertNoKey(r.out + r.err);
});

test('default timeout is 15s', async () => {
  const { TIMEOUT_MS } = await import('../src/http.js');
  assert.equal(TIMEOUT_MS, 15000);
});

test('network failure, even one whose message carries the key', async () => {
  const f = async () => {
    const e = new TypeError(`fetch failed for ${FAKE_OPENAI_KEY}`);
    e.cause = { code: 'ENOTFOUND' };
    throw e;
  };
  const e = await openai.monthlyCosts({ key: FAKE_OPENAI_KEY, fetch: f, now: NOW }).catch((x) => x);
  assert.equal(e.message, "OpenAI: couldn't reach api.openai.com (ENOTFOUND)");
  const r = await runCli(f);
  assertNoKey(r.out + r.err);
});

test('a failing provider still shows the other one, exit code 1', async () => {
  const f = fakeFetch((u) => (u.hostname === 'api.openai.com' ? echo(401)() : { body: { data: [], has_more: false, next_page: null } }));
  const r = await runCli(f, { argv: ['--json'] });
  assert.equal(r.code, 1);
  const j = JSON.parse(r.out);
  assert.equal(j.lines.length, 1);
  assert.equal(j.lines[0].id, 'anthropic');
  assert.equal(j.errors[0].code, 'auth');
  assertNoKey(r.out + r.err);
});

test('refuses any host that is not a provider', async () => {
  const f = fakeFetch(() => ({ body: {} }));
  await assert.rejects(getJson('https://ernd.ai/x', { fetch: f, provider: 'X' }), /refusing to call/);
  await assert.rejects(getJson('http://api.openai.com/x', { fetch: f, provider: 'X' }), /refusing to call/);
  assert.equal(f.calls.length, 0);
});

test('redact strips keys, bearer tokens and fragments', () => {
  const s = redact(`Bearer abc.def x-api-key: zzz ${FAKE_OPENAI_KEY} sk-proj-123456 ${FAKE_ANTHROPIC_KEY.slice(0, 14)}`, [FAKE_ANTHROPIC_KEY]);
  assert.doesNotMatch(s, /abc\.def|zzz|sk-proj-123456|FAKEtestKEY/);
});

test('a key passed as a flag is refused and never echoed', async () => {
  for (const argv of [[`--openai-key=${FAKE_OPENAI_KEY}`], ['--key', FAKE_OPENAI_KEY], ['--openai', FAKE_OPENAI_KEY], [FAKE_OPENAI_KEY]]) {
    const stdout = sink();
    const stderr = sink();
    const code = await main({ home: EMPTY_HOME, argv, env: {}, stdout, stderr, stdin: { isTTY: false }, fetch: () => assert.fail('no fetch') });
    assert.equal(code, 2);
    assert.match(stderr.text, /environment only/);
    assertNoKey(stdout.text + stderr.text);
  }
});

test('redirects are never followed', async () => {
  const f = fakeFetch(() => ({ body: { data: [], has_more: false } }));
  await openai.monthlyCosts({ key: FAKE_OPENAI_KEY, fetch: f, now: NOW });
  await anthropic.monthlyCosts({ key: FAKE_ANTHROPIC_KEY, fetch: f, now: NOW });
  for (const c of f.calls) assert.equal(c.init.redirect, 'error');
  const r3 = fakeFetch(() => ({ status: 302, headers: { location: 'https://evil.example/' } }));
  const e = await anthropic.monthlyCosts({ key: FAKE_ANTHROPIC_KEY, fetch: r3, now: NOW }).catch((x) => x);
  assert.equal(e.message, 'Anthropic: unexpected redirect, not following it');
  const thrower = async () => {
    const x = new TypeError('fetch failed');
    x.cause = new Error('unexpected redirect');
    throw x;
  };
  const e2 = await openai.monthlyCosts({ key: FAKE_OPENAI_KEY, fetch: thrower, now: NOW }).catch((x) => x);
  assert.equal(e2.code, 'redirect');
});

test('4xx bodies are never shown, even fragments of an odd key', async () => {
  const key = 'weird-FAKE-key-no-prefix-0123456789';
  const f = fakeFetch(() => ({ status: 400, body: { error: { message: `bad key rd-FAKE-key-no-prefix- ending in 6789`, type: 'invalid_request_error' } } }));
  const e = await openai.monthlyCosts({ key, fetch: f, now: NOW }).catch((x) => x);
  assert.equal(e.message, 'OpenAI: request rejected (400): invalid_request_error');
});
