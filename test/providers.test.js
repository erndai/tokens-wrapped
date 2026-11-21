import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as openai from '../src/providers/openai.js';
import * as anthropic from '../src/providers/anthropic.js';
import { fakeFetch, fixture, NOW, FAKE_OPENAI_KEY, FAKE_ANTHROPIC_KEY, providerRouter } from './_helpers.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('openai: sums amount.value as dollars across pages', async () => {
  const f = fakeFetch(providerRouter());
  const r = await openai.monthlyCosts({ key: FAKE_OPENAI_KEY, fetch: f, now: NOW });
  assert.equal(r.provider, 'OpenAI');
  assert.equal(r.months, 1);
  close(r.monthly_usd, 1.2345 + 3.06 + 0.06 + 10 + 0.6455); // 15.00
  assert.equal(f.calls.length, 2);
  const by = Object.fromEntries(r.by_item.map((i) => [i.name, i.usd]));
  close(by['gpt-6.2-astra'], 4.3545);
  close(by['gpt-5-mini'], 10);
  close(by['web_search_calls'], 0.6455);
  assert.equal(r.by_item[0].name, 'gpt-5-mini'); // sorted, biggest first
});

test('openai: request shape (GET, bearer, 30 full UTC days, line_item, cursor)', async () => {
  const f = fakeFetch(providerRouter());
  await openai.monthlyCosts({ key: FAKE_OPENAI_KEY, fetch: f, now: NOW });
  const [first, second] = f.calls.map((c) => ({ u: new URL(c.url), init: c.init }));
  assert.equal(first.u.origin + first.u.pathname, 'https://api.openai.com/v1/organization/costs');
  assert.equal(first.init.method, 'GET');
  assert.equal(first.init.headers.Authorization, `Bearer ${FAKE_OPENAI_KEY}`);
  assert.equal(first.u.searchParams.get('start_time'), String(Date.parse('2026-10-21T00:00:00Z') / 1000));
  assert.equal(first.u.searchParams.get('end_time'), String(Date.parse('2026-11-20T00:00:00Z') / 1000));
  assert.equal(first.u.searchParams.get('bucket_width'), '1d');
  assert.equal(first.u.searchParams.get('limit'), '30');
  assert.deepEqual(first.u.searchParams.getAll('group_by[]'), ['line_item']);
  assert.equal(first.u.searchParams.get('page'), null);
  assert.equal(second.u.searchParams.get('page'), 'page_FAKEcursor000000000000=');
  assert.ok(!first.u.toString().includes(FAKE_OPENAI_KEY), 'key must never be in the URL');
});

test('openai: --months averages over full calendar months, limit capped at 180', async () => {
  const f = fakeFetch(providerRouter());
  const r = await openai.monthlyCosts({ key: FAKE_OPENAI_KEY, fetch: f, now: NOW, months: 12 });
  close(r.monthly_usd, 15 / 12);
  const u = new URL(f.calls[0].url);
  assert.equal(u.searchParams.get('start_time'), String(Date.parse('2025-11-01T00:00:00Z') / 1000));
  assert.equal(u.searchParams.get('end_time'), String(Date.parse('2026-11-01T00:00:00Z') / 1000));
  assert.equal(u.searchParams.get('limit'), '180');
});

test('openai: modelOf splits on the last ", "', () => {
  assert.equal(openai.modelOf('gpt-6.2-astra, input_tokens'), 'gpt-6.2-astra');
  assert.equal(openai.modelOf('ft-gpt-4o-2024-08-06, input'), 'ft-gpt-4o-2024-08-06');
  assert.equal(openai.modelOf('web_search_calls'), 'web_search_calls');
  assert.equal(openai.modelOf(null), 'other');
});

test('openai: missing fields, empty days and a stuck cursor do not break it', async () => {
  const page = { object: 'page', data: [{ results: [] }, { results: [{ object: 'organization.costs.result' }] }], has_more: true, next_page: 'same' };
  const f = fakeFetch(() => ({ body: page }));
  const r = await openai.monthlyCosts({ key: FAKE_OPENAI_KEY, fetch: f, now: NOW });
  assert.equal(r.monthly_usd, 0);
  assert.equal(f.calls.length, 2); // stops when the cursor repeats
});

test('anthropic: amount is cents as a decimal string, summed across pages', async () => {
  const f = fakeFetch(providerRouter());
  const r = await anthropic.monthlyCosts({ key: FAKE_ANTHROPIC_KEY, fetch: f, now: NOW });
  assert.equal(r.provider, 'Anthropic');
  const cents = 1000 + 48213.25 + 120407.5 + 2150.78912 + 315.0;
  close(r.monthly_usd, cents / 100); // $1,720.87, not $172,086
  assert.equal(f.calls.length, 2);
  const by = Object.fromEntries(r.by_item.map((i) => [i.name, i.usd]));
  close(by['claude-opus-5-5'], (48213.25 + 120407.5 + 2150.78912) / 100);
  close(by['claude-haiku-5'], 10);
  close(by['code_execution'], 3.15);
});

test('anthropic: request shape (x-api-key, version, RFC 3339, group_by[]=description, limit 31)', async () => {
  const f = fakeFetch(providerRouter());
  await anthropic.monthlyCosts({ key: FAKE_ANTHROPIC_KEY, fetch: f, now: NOW, months: 3 });
  const u = new URL(f.calls[0].url);
  const h = f.calls[0].init.headers;
  assert.equal(u.origin + u.pathname, 'https://api.anthropic.com/v1/organizations/cost_report');
  assert.equal(f.calls[0].init.method, 'GET');
  assert.equal(h['x-api-key'], FAKE_ANTHROPIC_KEY);
  assert.equal(h['anthropic-version'], anthropic.API_VERSION);
  assert.equal(h.Authorization, undefined);
  assert.equal(u.searchParams.get('starting_at'), '2026-08-01T00:00:00Z');
  assert.equal(u.searchParams.get('ending_at'), '2026-11-01T00:00:00Z');
  assert.equal(u.searchParams.get('limit'), '31');
  assert.deepEqual(u.searchParams.getAll('group_by[]'), ['description']);
  assert.equal(new URL(f.calls[1].url).searchParams.get('page'), 'page_MjAyNi0xMS0xOFQwMDowMDowMFo=');
});

test('anthropic: --months 3 divides by 3', async () => {
  const f = fakeFetch(() => ({ body: fixture('anthropic-cost-page2.json') }));
  const r = await anthropic.monthlyCosts({ key: FAKE_ANTHROPIC_KEY, fetch: f, now: NOW, months: 3 });
  close(r.monthly_usd, (48213.25 + 120407.5 + 2150.78912 + 315) / 100 / 3);
  assert.equal(r.months, 3);
});

test('both providers share one interface', async () => {
  for (const p of [openai, anthropic]) {
    const r = await p.monthlyCosts({ key: 'sk-FAKE-x', fetch: fakeFetch(providerRouter()), now: NOW });
    assert.deepEqual(Object.keys(r).sort(), ['by_item', 'monthly_usd', 'months', 'period', 'provider', 'warnings']);
    for (const it of r.by_item) assert.deepEqual(Object.keys(it).sort(), ['name', 'usd']);
  }
});

test('no key: refuses before any request', async () => {
  const f = fakeFetch(() => ({ body: {} }));
  await assert.rejects(openai.monthlyCosts({ fetch: f, now: NOW }), /no key set/);
  assert.equal(f.calls.length, 0);
});

test('anthropic: default version is the documented one', () => {
  assert.equal(anthropic.API_VERSION, '2026-10-21');
});

test('unexpected response shape is an error, not $0', async () => {
  for (const p of [openai, anthropic]) {
    for (const body of [{ data: 'x' }, {}, { object: 'page' }]) {
      const e = await p.monthlyCosts({ key: 'sk-FAKE-x', fetch: fakeFetch(() => ({ body })), now: NOW }).catch((x) => x);
      assert.equal(e.code, 'parse', `${p.NAME} ${JSON.stringify(body)}`);
      assert.match(e.message, /unexpected response shape/);
    }
  }
});

test('rows in another currency are left out with a warning', async () => {
  const page = {
    data: [{ results: [
      { amount: { value: 10, currency: 'usd' }, line_item: 'gpt-x, input' },
      { amount: { value: 99, currency: 'eur' }, line_item: 'gpt-x, input' },
    ] }],
    has_more: false,
  };
  const r = await openai.monthlyCosts({ key: 'sk-FAKE-x', fetch: fakeFetch(() => ({ body: page })), now: NOW });
  close(r.monthly_usd, 10);
  assert.deepEqual(r.warnings, ['OpenAI: 1 cost rows in another currency were left out']);
});
