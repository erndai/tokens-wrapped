// This year's usage, for the share cards: tokens, cache hits, busiest day, top models, and what Claude Code built.
// Read-only GETs to the same two hosts as the cost report, with the same admin keys:
//   OpenAI     GET /v1/organization/usage/completions         (tokens, cached tokens, requests; daily, by model)
//   Anthropic  GET /v1/organizations/usage_report/messages    (uncached, cache read, cache write, output tokens)
//   Anthropic  GET /v1/organizations/usage_report/claude_code (one day per call: lines, commits, PRs, sessions)
// Field names are from the providers' API references, read 2026-11-20. Not yet checked against a live org.

import { getJson, AiBillError } from './http.js';
import { MAX_PAGES } from './period.js';
import { VERSION } from './version.js';
import * as anthropicCosts from './providers/anthropic.js';
import * as openaiCosts from './providers/openai.js';

const ANTHROPIC_VERSION = anthropicCosts.API_VERSION;

const DAY = 86400 * 1000;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Jan 1 of this year (UTC) up to the start of today (UTC): full days only.
export function yearWindow(now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  return { start, end, year: now.getUTCFullYear() };
}

export function isoDay(d) {
  return d.toISOString().slice(0, 10);
}

// A blank tally that each provider adds into.
export function emptyTally() {
  // buckets: every day the provider returned a bucket for (empty or not), to check coverage. pages, truncated: paging.
  return { input: 0, cached: 0, cacheWrite: 0, output: 0, requests: 0, webSearches: 0, days: new Map(), models: new Map(), buckets: new Set(), pages: 0, truncated: false };
}

function add(t, day, model, { input = 0, cached = 0, cacheWrite = 0, output = 0, requests = 0, webSearches = 0 }) {
  t.input += input;
  t.cached += cached;
  t.cacheWrite += cacheWrite;
  t.output += output;
  t.requests += requests;
  t.webSearches += webSearches;
  const tokens = input + output;
  if (day) t.days.set(day, (t.days.get(day) || 0) + tokens);
  if (model) t.models.set(model, (t.models.get(model) || 0) + tokens);
}

const RETRY = new Set(['rate_limit', 'server', 'timeout', 'network']);
const realSleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// One GET, retried on 429, 5xx, timeouts and network errors: up to 5 tries, waiting Retry-After or 1, 2, 4, 8s.
export async function getWithRetry(url, opts, { tries = 5, sleep = realSleep } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await getJson(url, opts);
    } catch (e) {
      if (!(e instanceof AiBillError) || !RETRY.has(e.code) || i >= tries) throw e;
      await sleep(Math.min(30000, e.retryAfter ? e.retryAfter * 1000 : 1000 * 2 ** (i - 1)));
    }
  }
}

// Every page of a paged report. Returns { bodies, truncated } (truncated: stopped at MAX_PAGES with more left).
async function pages(firstUrl, nextUrl, opts, retry) {
  const bodies = [];
  let url = firstUrl;
  const seen = new Set();
  for (let i = 0; i < MAX_PAGES; i++) {
    const body = await getWithRetry(url, opts, retry);
    if (!Array.isArray(body?.data)) {
      throw new AiBillError(`${opts.provider}: unexpected usage response`, { code: 'parse', provider: opts.provider });
    }
    bodies.push(body);
    const next = body?.next_page;
    if (!body?.has_more || !next || seen.has(next)) return { bodies, truncated: false };
    seen.add(next);
    url = nextUrl(next);
  }
  return { bodies, truncated: true };
}

// ---------- OpenAI ----------

export function openaiUsageUrl({ start, end, page }) {
  const q = new URLSearchParams();
  q.set('start_time', String(Math.floor(start.getTime() / 1000)));
  q.set('end_time', String(Math.floor(end.getTime() / 1000)));
  q.set('bucket_width', '1d');
  q.set('limit', '31');
  q.append('group_by[]', 'model');
  if (page) q.set('page', page);
  return `https://api.openai.com/v1/organization/usage/completions?${q}`;
}

// input_tokens already includes cached and cache-write tokens.
export function addOpenaiPage(body, t) {
  for (const b of body.data) {
    const day = Number.isFinite(Number(b?.start_time)) ? isoDay(new Date(Number(b.start_time) * 1000)) : null;
    if (day) t.buckets.add(day);
    for (const r of b?.results || []) {
      add(t, day, r?.model || null, {
        input: num(r?.input_tokens),
        cached: num(r?.input_cached_tokens),
        cacheWrite: num(r?.input_cache_write_tokens),
        output: num(r?.output_tokens),
        requests: num(r?.num_model_requests),
      });
    }
  }
}

export async function openaiUsage({ key, fetch, start, end, timeoutMs, retry }) {
  const headers = { Authorization: `Bearer ${key}`, 'User-Agent': `tokens-wrapped/${VERSION}` };
  const opts = { fetch, headers, provider: 'OpenAI', secrets: [key], timeoutMs };
  const t = emptyTally();
  const { bodies, truncated } = await pages(openaiUsageUrl({ start, end }), (page) => openaiUsageUrl({ start, end, page }), opts, retry);
  for (const b of bodies) addOpenaiPage(b, t);
  t.pages = bodies.length;
  t.truncated = truncated;
  return t;
}

// ---------- Anthropic ----------

const anthropicHeaders = (key) => ({ 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, 'User-Agent': `tokens-wrapped/${VERSION}` });
const rfc = (d) => d.toISOString().replace('.000Z', 'Z');

export function anthropicUsageUrl({ start, end, page }) {
  const q = new URLSearchParams();
  q.set('starting_at', rfc(start));
  q.set('ending_at', rfc(end));
  q.set('bucket_width', '1d');
  q.set('limit', '31');
  q.append('group_by[]', 'model');
  if (page) q.set('page', page);
  return `https://api.anthropic.com/v1/organizations/usage_report/messages?${q}`;
}

// Total input = uncached + cache read + cache creation. There's no request count in this report.
export function addAnthropicPage(body, t) {
  for (const b of body.data) {
    const day = typeof b?.starting_at === 'string' ? b.starting_at.slice(0, 10) : null;
    if (day) t.buckets.add(day);
    for (const r of b?.results || []) {
      const write = num(r?.cache_creation?.ephemeral_1h_input_tokens) + num(r?.cache_creation?.ephemeral_5m_input_tokens);
      const read = num(r?.cache_read_input_tokens);
      add(t, day, r?.model || null, {
        input: num(r?.uncached_input_tokens) + read + write,
        cached: read,
        cacheWrite: write,
        output: num(r?.output_tokens),
        webSearches: num(r?.server_tool_use?.web_search_requests),
      });
    }
  }
}

export async function anthropicUsage({ key, fetch, start, end, timeoutMs, retry }) {
  const opts = { fetch, headers: anthropicHeaders(key), provider: 'Anthropic', secrets: [key], timeoutMs };
  const t = emptyTally();
  const { bodies, truncated } = await pages(anthropicUsageUrl({ start, end }), (page) => anthropicUsageUrl({ start, end, page }), opts, retry);
  for (const b of bodies) addAnthropicPage(b, t);
  t.pages = bodies.length;
  t.truncated = truncated;
  return t;
}

export function claudeCodeUrl(day, page) {
  const q = new URLSearchParams();
  q.set('starting_at', day);
  q.set('limit', '1000');
  if (page) q.set('page', page);
  return `https://api.anthropic.com/v1/organizations/usage_report/claude_code?${q}`;
}

export function emptyCode() {
  // tokens: Claude Code's own model_breakdown, to cross-check against the messages report. daysRead: coverage.
  return { sessions: 0, added: 0, removed: 0, commits: 0, prs: 0, accepted: 0, rejected: 0, actors: new Set(), tokens: 0, daysRead: 0, truncated: false };
}

// Several records can share an actor and day (one per terminal and plan); they add up.
export function addCodePage(body, c) {
  for (const r of body.data) {
    const m = r?.core_metrics || {};
    c.sessions += num(m.num_sessions);
    c.added += num(m.lines_of_code?.added);
    c.removed += num(m.lines_of_code?.removed);
    c.commits += num(m.commits_by_claude_code);
    c.prs += num(m.pull_requests_by_claude_code);
    for (const a of Object.values(r?.tool_actions || {})) {
      c.accepted += num(a?.accepted);
      c.rejected += num(a?.rejected);
    }
    for (const m of r?.model_breakdown || []) {
      const k = m?.tokens || {};
      c.tokens += num(k.input) + num(k.output) + num(k.cache_read) + num(k.cache_creation);
    }
    const who = r?.actor?.email_address || r?.actor?.api_key_name;
    if (who) c.actors.add(String(who)); // counted only, never shown
  }
}

// One call per day, a few at a time. Any failure drops the whole section rather than show a partial count.
export async function claudeCode({ key, fetch, start, end, timeoutMs, concurrency = 4, retry }) {
  const opts = { fetch, headers: anthropicHeaders(key), provider: 'Anthropic', secrets: [key], timeoutMs };
  const days = [];
  for (let d = start.getTime(); d < end.getTime(); d += DAY) days.push(isoDay(new Date(d)));
  const c = emptyCode();
  let i = 0;
  async function worker() {
    while (i < days.length) {
      const day = days[i++];
      const { bodies, truncated } = await pages(claudeCodeUrl(day), (page) => claudeCodeUrl(day, page), opts, retry);
      for (const b of bodies) addCodePage(b, c);
      c.daysRead++;
      if (truncated) c.truncated = true;
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, days.length) }, worker));
  return c;
}

// ---------- together ----------

export function merge(tallies) {
  const t = emptyTally();
  for (const x of tallies) {
    for (const k of ['input', 'cached', 'cacheWrite', 'output', 'requests', 'webSearches']) t[k] += x[k];
    for (const [d, v] of x.days) t.days.set(d, (t.days.get(d) || 0) + v);
    for (const [m, v] of x.models) t.models.set(m, (t.models.get(m) || 0) + v);
  }
  return t;
}

// The shape the cards read. Returns null when there's nothing to show.
export function summarize(t, code, { start, end, year, sources }) {
  const total = t.input + t.output;
  if (!total && !code) return null;
  const days = [];
  for (let d = start.getTime(); d < end.getTime(); d += DAY) {
    const k = isoDay(new Date(d));
    days.push({ date: k, tokens: t.days.get(k) || 0 });
  }
  const peak = days.reduce((a, b) => (b.tokens > (a?.tokens || 0) ? b : a), null);
  const codeOut =
    code && (code.sessions || code.added || code.commits)
      ? {
          sessions: code.sessions,
          added: code.added,
          removed: code.removed,
          commits: code.commits,
          prs: code.prs,
          acceptRate: code.accepted + code.rejected ? code.accepted / (code.accepted + code.rejected) : null,
          builders: code.actors.size,
        }
      : null;
  return {
    year,
    since: isoDay(start),
    until: isoDay(new Date(end.getTime() - DAY)),
    sources,
    tokens: { total, input: t.input, output: t.output, cached: t.cached, cacheWrite: t.cacheWrite },
    cacheHit: t.input ? t.cached / t.input : null,
    requests: t.requests || null,
    webSearches: t.webSearches || null,
    models: [...t.models.entries()]
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([name, tokens]) => ({ name, tokens })),
    days,
    peak: peak && peak.tokens > 0 ? peak : null,
    activeDays: days.filter((d) => d.tokens > 0).length,
    code: codeOut,
  };
}

const big = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.round(n).toLocaleString('en-US'));
const money = (n) => '$' + Math.round(n).toLocaleString('en-US');

// Sanity checks on what came back, as plain lines for stderr. `notes` are the ones that look wrong.
export function dataChecks({ days, perProvider, code, anthropicTokens }) {
  const checks = [];
  const notes = [];
  for (const p of perProvider) {
    const t = p.tally;
    if (t) {
      const covered = [...t.buckets].filter(Boolean).length;
      checks.push(`${p.name} usage: ${covered} of ${days} days returned, ${big(t.input + t.output)} tokens, ${t.pages} page${t.pages === 1 ? '' : 's'}`);
      if (t.truncated) notes.push(`${p.name} usage stopped at the page limit, so totals are low`);
      if (covered && covered < days) notes.push(`${p.name} usage returned ${covered} of ${days} days`);
    }
    if (p.spend != null) {
      const tokens = t ? t.input + t.output : 0;
      const perM = tokens ? p.spend / (tokens / 1e6) : null;
      checks.push(`${p.name} spend this year: ${money(p.spend)}${perM != null ? ` (${'$' + perM.toFixed(2)} per 1M tokens)` : ''}`);
      if (perM != null && (perM < 0.01 || perM > 200)) notes.push(`${p.name}: ${'$' + perM.toFixed(2)} per 1M tokens looks off; costs and usage may be from different orgs`);
      if (p.spend > 100 && t && !tokens) notes.push(`${p.name}: spend but no tokens; the usage report may not cover this key`);
    }
  }
  if (code) {
    checks.push(`Claude Code: ${code.daysRead} of ${days} days read, ${code.actors.size} people, ${big(code.tokens)} tokens`);
    if (code.truncated) notes.push('Claude Code stopped at the page limit on some days, so totals are low');
    if (anthropicTokens && code.tokens > anthropicTokens * 1.05) {
      notes.push('Claude Code reports more tokens than the Anthropic usage report; some of it may be billed elsewhere');
    }
  }
  return { checks, notes };
}

// This year so far, for the cost report: months 1 so the total comes back as monthly_usd.
export function yearCostPeriod(now) {
  const { start, end } = yearWindow(now);
  const days = Math.round((end - start) / DAY);
  return { kind: 'year', months: 1, days, start, end, label: 'this year' };
}

// Reads everything it can with the keys given. Each failure becomes a warning and leaves that part out.
// Returns { usage, warnings, checks }: checks is a short data report for stderr.
export async function yearUsage({ env = {}, fetch, now = new Date(), timeoutMs, progress = () => {}, retry }) {
  const { start, end, year } = yearWindow(now);
  if (end <= start) return { usage: null, warnings: [], checks: [] };
  const days = Math.round((end - start) / DAY);
  const warnings = [];
  const why = (e, what) => (e instanceof AiBillError ? e.message : what);
  const providers = [
    { name: 'OpenAI', env: 'OPENAI_ADMIN_KEY', usage: openaiUsage, costs: openaiCosts },
    { name: 'Anthropic', env: 'ANTHROPIC_ADMIN_KEY', usage: anthropicUsage, costs: anthropicCosts },
  ].filter((p) => env[p.env]);
  const period = yearCostPeriod(now);
  const perProvider = await Promise.all(
    providers.map(async (p) => {
      const key = env[p.env];
      const [tally, spend] = await Promise.all([
        p.usage({ key, fetch, start, end, timeoutMs, retry }).catch((e) => (warnings.push(`usage cards: ${why(e, `${p.name} usage failed`)}`), null)),
        p.costs
          .monthlyCosts({ key, fetch, now, timeoutMs, period })
          .then((r) => r.monthly_usd)
          .catch((e) => (warnings.push(`spend this year: ${why(e, `${p.name} costs failed`)}`), null)),
      ]);
      return { name: p.name, tally, spend };
    }),
  );
  let code = null;
  if (env.ANTHROPIC_ADMIN_KEY) {
    progress(`Reading Claude Code stats for ${days} days...`);
    code = await claudeCode({ key: env.ANTHROPIC_ADMIN_KEY, fetch, start, end, timeoutMs, retry }).catch((e) => {
      warnings.push(`Claude Code card left out: ${why(e, 'Claude Code stats failed')}`);
      return null;
    });
  }
  const tallies = perProvider.filter((p) => p.tally);
  const usage = summarize(merge(tallies.map((p) => p.tally)), code, { start, end, year, sources: tallies.map((p) => p.name).sort() });
  const spends = perProvider.filter((p) => p.spend != null);
  if (usage && spends.length === providers.length) {
    usage.spendThisYear = spends.reduce((a, p) => a + p.spend, 0);
    usage.spendByProvider = Object.fromEntries(spends.map((p) => [p.name, p.spend]));
  }
  const anthropicTokens = perProvider.find((p) => p.name === 'Anthropic')?.tally;
  const { checks, notes } = dataChecks({
    days,
    perProvider,
    code,
    anthropicTokens: anthropicTokens ? anthropicTokens.input + anthropicTokens.output : 0,
  });
  return { usage, warnings: [...warnings, ...notes], checks };
}

// ---------- the fun bits ----------

// Tokens to "novels": about 0.75 words a token, 90,000 words a novel.
export const WORDS_PER_TOKEN = 0.75;
export const WORDS_PER_NOVEL = 90000;
export function novels(tokens) {
  return Math.round((tokens * WORDS_PER_TOKEN) / WORDS_PER_NOVEL);
}

// One personality from the numbers, checked in this order.
export function personality(u) {
  if (!u) return null;
  const modelCount = u.models.length;
  const outRatio = u.tokens.input ? u.tokens.output / u.tokens.input : 0;
  const late = u.busiestHour != null && (u.busiestHour >= 22 || u.busiestHour < 4);
  if (u.built?.lines >= 100000) {
    return { name: 'The Shipper', line: `Your agents wrote ${u.built.lines.toLocaleString('en-US')} lines of code this year.` };
  }
  if (late) return { name: 'The Night Owl', line: 'Your agents worked hardest after 10pm.' };
  if (u.harnesses?.length >= 3) return { name: 'The Harness Hopper', line: `You ran ${u.harnesses.length} different coding agents this year.` };
  if (u.streak >= 30) return { name: 'The Marathoner', line: `${u.streak} days in a row with AI.` };
  if (u.code && u.code.commits >= 100) {
    return { name: 'The Shipper', line: `Claude Code made ${u.code.commits.toLocaleString('en-US')} commits for you this year.` };
  }
  if (u.cacheHit != null && u.cacheHit >= 0.6) {
    return { name: 'The Cache Whisperer', line: `${Math.round(u.cacheHit * 100)}% of your input came straight from cache.` };
  }
  if (modelCount >= 6) return { name: 'The Explorer', line: `You ran ${modelCount} different models this year.` };
  if (outRatio >= 0.5) return { name: 'The Author', line: 'Your models wrote a lot more than most.' };
  if (u.peak && u.tokens.total && u.peak.tokens / u.tokens.total >= 0.1) {
    return { name: 'The Sprinter', line: 'One day carried a tenth of your whole year.' };
  }
  return { name: 'The Builder', line: `AI ran on ${u.activeDays} days of your year.` };
}
