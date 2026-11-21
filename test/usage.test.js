import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  yearWindow,
  emptyTally,
  emptyCode,
  addOpenaiPage,
  addAnthropicPage,
  addCodePage,
  merge,
  summarize,
  yearUsage,
  personality,
  novels,
  openaiUsageUrl,
  anthropicUsageUrl,
  claudeCodeUrl,
  getWithRetry,
  dataChecks,
} from '../src/usage.js';
import { AiBillError } from '../src/http.js';
import { computeBill } from '../src/math.js';
import { recapData, cards, postText, compact, shortDate } from '../src/share.js';
import { fakeFetch, FAKE_OPENAI_KEY, FAKE_ANTHROPIC_KEY } from './_helpers.js';

const NOW = new Date('2026-01-04T15:00:00Z'); // window: Jan 1, 2, 3

// Shapes as in the API references (OpenAI usage/completions, Anthropic usage_report/messages and claude_code).
const openaiPage = {
  object: 'page',
  has_more: false,
  next_page: null,
  data: [
    { object: 'bucket', start_time: 1767225600, end_time: 1767312000, results: [
      { object: 'organization.usage.completions.result', model: 'gpt-5.1', input_tokens: 1000, input_cached_tokens: 400, output_tokens: 200, num_model_requests: 5 },
    ] },
    { object: 'bucket', start_time: 1767312000, end_time: 1767398400, results: [
      { object: 'organization.usage.completions.result', model: 'gpt-5.1-mini', input_tokens: 3000, input_cached_tokens: 0, output_tokens: 100, num_model_requests: 9 },
    ] },
    { object: 'bucket', start_time: 1767398400, end_time: 1767484800, results: [] },
  ],
};
const anthropicPage = {
  has_more: false,
  next_page: null,
  data: [
    { starting_at: '2026-01-01T00:00:00Z', ending_at: '2026-01-02T00:00:00Z', results: [] },
    { starting_at: '2026-01-02T00:00:00Z', ending_at: '2026-01-03T00:00:00Z', results: [
      { model: 'claude-opus-5-5', uncached_input_tokens: 100, cache_read_input_tokens: 800, cache_creation: { ephemeral_1h_input_tokens: 50, ephemeral_5m_input_tokens: 50 }, output_tokens: 300, server_tool_use: { web_search_requests: 2 } },
    ] },
    { starting_at: '2026-01-03T00:00:00Z', ending_at: '2026-01-04T00:00:00Z', results: [] },
  ],
};
const codeRecord = (email, added) => ({
  date: '2026-01-02T00:00:00Z',
  actor: { type: 'user_actor', email_address: email },
  core_metrics: { num_sessions: 3, lines_of_code: { added, removed: 10 }, commits_by_claude_code: 2, pull_requests_by_claude_code: 1 },
  tool_actions: { edit_tool: { accepted: 8, rejected: 2 }, write_tool: { accepted: 2, rejected: 0 } },
  model_breakdown: [],
});

test('window: Jan 1 to the start of today, UTC', () => {
  const w = yearWindow(NOW);
  assert.equal(w.start.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(w.end.toISOString(), '2026-01-04T00:00:00.000Z');
  assert.equal(w.year, 2026);
});

test('urls: daily buckets, by model, hosts are the provider APIs', () => {
  const { start, end } = yearWindow(NOW);
  const o = new URL(openaiUsageUrl({ start, end }));
  assert.equal(o.hostname, 'api.openai.com');
  assert.equal(o.pathname, '/v1/organization/usage/completions');
  assert.equal(o.searchParams.get('bucket_width'), '1d');
  assert.equal(o.searchParams.get('group_by[]'), 'model');
  assert.equal(o.searchParams.get('start_time'), '1767225600');
  const a = new URL(anthropicUsageUrl({ start, end, page: 'p2' }));
  assert.equal(a.pathname, '/v1/organizations/usage_report/messages');
  assert.equal(a.searchParams.get('starting_at'), '2026-01-01T00:00:00Z');
  assert.equal(a.searchParams.get('page'), 'p2');
  const c = new URL(claudeCodeUrl('2026-01-02'));
  assert.equal(c.pathname, '/v1/organizations/usage_report/claude_code');
  assert.equal(c.searchParams.get('starting_at'), '2026-01-02');
});

test('OpenAI: input includes cached; tokens per day and model', () => {
  const t = emptyTally();
  addOpenaiPage(openaiPage, t);
  assert.equal(t.input, 4000);
  assert.equal(t.cached, 400);
  assert.equal(t.output, 300);
  assert.equal(t.requests, 14);
  assert.equal(t.days.get('2026-01-01'), 1200);
  assert.equal(t.models.get('gpt-5.1-mini'), 3100);
});

test('Anthropic: input = uncached + cache read + cache write', () => {
  const t = emptyTally();
  addAnthropicPage(anthropicPage, t);
  assert.equal(t.input, 1000);
  assert.equal(t.cached, 800);
  assert.equal(t.cacheWrite, 100);
  assert.equal(t.output, 300);
  assert.equal(t.webSearches, 2);
  assert.equal(t.days.get('2026-01-02'), 1300);
});

test('Claude Code: records add up; people are counted, never kept by name in output', () => {
  const c = emptyCode();
  addCodePage({ data: [codeRecord('a@x.com', 100), codeRecord('a@x.com', 50), codeRecord('b@x.com', 10)] }, c);
  assert.equal(c.added, 160);
  assert.equal(c.commits, 6);
  assert.equal(c.accepted, 30);
  assert.equal(c.rejected, 6);
  const { start, end, year } = yearWindow(NOW);
  const u = summarize(emptyTally(), c, { start, end, year, sources: [] });
  assert.equal(u.code.builders, 2);
  assert.equal(Math.round(u.code.acceptRate * 100), 83);
  assert.doesNotMatch(JSON.stringify(u), /@x\.com/);
});

test('summary: cache hit, peak day, active days, models by tokens', () => {
  const a = emptyTally();
  addOpenaiPage(openaiPage, a);
  const b = emptyTally();
  addAnthropicPage(anthropicPage, b);
  const { start, end, year } = yearWindow(NOW);
  const u = summarize(merge([a, b]), null, { start, end, year, sources: ['Anthropic', 'OpenAI'] });
  assert.equal(u.tokens.total, 5600);
  assert.equal(u.cacheHit, 1200 / 5000);
  assert.deepEqual(u.peak, { date: '2026-01-02', tokens: 4400 });
  assert.equal(u.activeDays, 2);
  assert.equal(u.days.length, 3);
  assert.equal(u.models[0].name, 'gpt-5.1-mini');
  assert.equal(u.code, null);
});

function router({ fail, openaiUsd = 0.002, anthropicCents = '0.50' } = {}) {
  return fakeFetch((url) => {
    if (fail && url.pathname.includes(fail)) return { status: 403, body: { error: { type: 'permission_error' } } };
    if (url.pathname === '/v1/organization/usage/completions') return { body: openaiPage };
    if (url.pathname === '/v1/organization/costs') {
      return { body: { data: [{ start_time: 1767225600, results: [{ amount: { value: openaiUsd, currency: 'usd' }, line_item: 'gpt-5.1, input' }] }], has_more: false, next_page: null } };
    }
    if (url.pathname === '/v1/organizations/cost_report') {
      return { body: { data: [{ starting_at: '2026-01-02T00:00:00Z', results: [{ amount: anthropicCents, currency: 'USD', model: 'claude-opus-5-5' }] }], has_more: false, next_page: null } };
    }
    if (url.pathname === '/v1/organizations/usage_report/messages') return { body: anthropicPage };
    if (url.pathname === '/v1/organizations/usage_report/claude_code') {
      const day = url.searchParams.get('starting_at');
      return { body: { data: day === '2026-01-02' ? [codeRecord('a@x.com', 100)] : [], has_more: false, next_page: null } };
    }
    return { status: 404 };
  });
}

test('yearUsage: both providers and Claude Code, one call per day for Claude Code', async () => {
  const fetch = router();
  const env = { OPENAI_ADMIN_KEY: FAKE_OPENAI_KEY, ANTHROPIC_ADMIN_KEY: FAKE_ANTHROPIC_KEY };
  const { usage, warnings } = await yearUsage({ env, fetch, now: NOW });
  assert.deepEqual(warnings, []);
  assert.deepEqual(usage.sources, ['Anthropic', 'OpenAI']);
  assert.equal(usage.spendThisYear, 0.002 + 0.005);
  assert.deepEqual(usage.spendByProvider, { OpenAI: 0.002, Anthropic: 0.005 });
  assert.equal(usage.code.added, 100);
  const costs = fetch.calls.filter((c) => /costs|cost_report/.test(c.url)).map((c) => new URL(c.url));
  assert.equal(costs.length, 2);
  for (const u of costs) assert.ok(['1767225600', '2026-01-01T00:00:00Z'].includes(u.searchParams.get('start_time') || u.searchParams.get('starting_at')));
  const code = fetch.calls.filter((c) => c.url.includes('claude_code'));
  assert.equal(code.length, 3);
  for (const c of fetch.calls) {
    assert.equal(c.init.method, 'GET');
    assert.equal(c.init.redirect, 'error');
  }
});

test('yearUsage: a failing part becomes a warning and is left out', async () => {
  const env = { ANTHROPIC_ADMIN_KEY: FAKE_ANTHROPIC_KEY };
  const { usage, warnings } = await yearUsage({ env, fetch: router({ fail: 'claude_code' }), now: NOW });
  assert.equal(usage.code, null);
  assert.equal(usage.tokens.total, 1300);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Claude Code card left out/);
  assert.ok(!warnings[0].includes(FAKE_ANTHROPIC_KEY));
});

test('personality: checks in order', () => {
  const base = { models: [{}, {}], tokens: { input: 100, output: 10, total: 110 }, cacheHit: 0.2, peak: null, activeDays: 40, code: null };
  assert.equal(personality(null), null);
  assert.equal(personality({ ...base, code: { commits: 150 } }).name, 'The Shipper');
  assert.equal(personality({ ...base, cacheHit: 0.7 }).name, 'The Cache Whisperer');
  assert.equal(personality({ ...base, models: new Array(7).fill({}) }).name, 'The Explorer');
  assert.equal(personality({ ...base, tokens: { input: 100, output: 60, total: 160 } }).name, 'The Author');
  assert.equal(personality(base).name, 'The Builder');
});

test('formatting helpers', () => {
  assert.equal(compact(4_870_000_000), '4.9B');
  assert.equal(compact(681_000_000), '681M');
  assert.equal(compact(56_300), '56.3K');
  assert.equal(compact(950), '950');
  assert.equal(shortDate('2026-09-17'), 'Sep 17');
  assert.equal(novels(120000), 1);
});

test('deep cards appear with usage, with no pitch', async () => {
  const env = { OPENAI_ADMIN_KEY: FAKE_OPENAI_KEY, ANTHROPIC_ADMIN_KEY: FAKE_ANTHROPIC_KEY };
  const { usage } = await yearUsage({ env, fetch: router(), now: NOW });
  const bill = computeBill([{ id: 'openai', monthly_usd: 10000, source: 'api' }, { id: 'anthropic', monthly_usd: 2000, source: 'api' }]);
  const d = recapData(bill, { now: NOW, usage });
  const { story } = cards(d);
  assert.deepEqual(story.map((c) => c.id), ['intro', 'spend', 'vendors', 'tokens', 'models', 'cache', 'peak', 'code', 'persona', 'summary']);
  const words = story.map((c) => c.svg).join('').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.doesNotMatch(words, /back a year|annual fee/);
  assert.match(words, /\+100 lines of code/);
  assert.equal(postText(d), 'my 2026 in AI: 5,600 tokens, 24% cache hits, +100 lines with Claude Code, biggest day Jan 2\n\ntokenswrapped.com');
  assert.doesNotMatch(words, /@x\.com/);
});

test('retry: 429 waits Retry-After, then succeeds; other errors are not retried', async () => {
  let n = 0;
  const waits = [];
  const fetch = fakeFetch(() => (++n < 3 ? { status: 429, headers: { 'retry-after': '7' } } : { body: { ok: 1 } }));
  const body = await getWithRetry('https://api.anthropic.com/x', { fetch, headers: {}, provider: 'Anthropic' }, { sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(body, { ok: 1 });
  assert.deepEqual(waits, [7000, 7000]);
  const f403 = fakeFetch(() => ({ status: 403 }));
  await assert.rejects(getWithRetry('https://api.anthropic.com/x', { fetch: f403, headers: {}, provider: 'Anthropic' }, { sleep: async () => {} }), (e) => e instanceof AiBillError && e.code === 'forbidden');
  assert.equal(f403.calls.length, 1);
});

test('retry: gives up after 5 tries on 5xx with growing waits', async () => {
  const waits = [];
  const fetch = fakeFetch(() => ({ status: 503 }));
  await assert.rejects(getWithRetry('https://api.openai.com/x', { fetch, headers: {}, provider: 'OpenAI' }, { sleep: async (ms) => waits.push(ms) }));
  assert.equal(fetch.calls.length, 5);
  assert.deepEqual(waits, [1000, 2000, 4000, 8000]);
});

test('data checks: coverage, page limit, cost per token, Claude Code vs API tokens', () => {
  const t = emptyTally();
  t.input = 900e6;
  t.output = 100e6;
  t.pages = 11;
  ['2026-01-01', '2026-01-02'].forEach((d) => t.buckets.add(d));
  const ok = dataChecks({ days: 2, perProvider: [{ name: 'OpenAI', tally: t, spend: 600 }], code: null, anthropicTokens: 0 });
  assert.match(ok.checks.join('\n'), /OpenAI usage: 2 of 2 days returned, 1\.0B tokens, 11 pages/);
  assert.match(ok.checks.join('\n'), /OpenAI spend this year: \$600 \(\$0\.60 per 1M tokens\)/);
  assert.deepEqual(ok.notes, []);

  const t2 = { ...t, buckets: new Set(['2026-01-01']), truncated: true };
  const bad = dataChecks({ days: 2, perProvider: [{ name: 'OpenAI', tally: t2, spend: 900000 }], code: null, anthropicTokens: 0 });
  assert.equal(bad.notes.length, 3);
  assert.match(bad.notes.join('\n'), /page limit/);
  assert.match(bad.notes.join('\n'), /1 of 2 days/);
  assert.match(bad.notes.join('\n'), /looks off/);

  const c = emptyCode();
  c.tokens = 2e9;
  c.daysRead = 2;
  const cc = dataChecks({ days: 2, perProvider: [], code: c, anthropicTokens: 1e9 });
  assert.match(cc.checks[0], /Claude Code: 2 of 2 days read/);
  assert.match(cc.notes[0], /more tokens than the Anthropic usage report/);
});

test('cards use this year\'s actual spend when every AI line came from the cost reports', async () => {
  const env = { OPENAI_ADMIN_KEY: FAKE_OPENAI_KEY, ANTHROPIC_ADMIN_KEY: FAKE_ANTHROPIC_KEY };
  const { usage, warnings } = await yearUsage({ env, fetch: router({ openaiUsd: 12.5, anthropicCents: '750.00' }), now: NOW });
  assert.equal(warnings.filter((w) => /looks off/.test(w)).length, 2); // fixture tokens are tiny next to $20
  const api = computeBill([{ id: 'openai', monthly_usd: 10000, source: 'api' }, { id: 'anthropic', monthly_usd: 2000, source: 'api' }]);
  const d = recapData(api, { now: NOW, usage });
  assert.equal(d.spendIsYtd, true);
  assert.equal(d.spend, 20);
  const words = cards(d).story.map((c) => c.svg).join('').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(words, /You spent \$20 on AI this year/);
  assert.match(words, /OpenAI \$13 this year/);
  // A typed-in line can't be split by date, so the whole recap falls back to the run rate.
  const mixed = computeBill([{ id: 'openai', monthly_usd: 10000, source: 'api' }, { id: 'wafer', monthly_usd: 2000 }]);
  const m = recapData(mixed, { now: NOW, usage });
  assert.equal(m.spendIsYtd, false);
  assert.equal(m.spend, 144000);
});
