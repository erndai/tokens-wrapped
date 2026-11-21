// Anthropic Admin API cost report: GET https://api.anthropic.com/v1/organizations/cost_report
// Needs an Admin API key (sk-ant-admin01-...). amount is a decimal STRING in cents: "123.45" = $1.2345.
import { getJson, AiBillError } from '../http.js';
import { periodFor, MAX_PAGES } from '../period.js';
import { VERSION } from '../version.js';
import { result } from './result.js';

export const id = 'anthropic';
export const NAME = 'Anthropic';
export const ENV = 'ANTHROPIC_ADMIN_KEY';
export const API_VERSION = '2026-10-21'; // what Anthropic's SDKs send (checked 2026-11-20)
const BASE = 'https://api.anthropic.com/v1/organizations/cost_report';

export function buildUrl({ start, end, limit, page }) {
  const q = new URLSearchParams();
  q.set('starting_at', start.toISOString().replace('.000Z', 'Z'));
  q.set('ending_at', end.toISOString().replace('.000Z', 'Z'));
  q.set('bucket_width', '1d');
  q.set('limit', String(limit));
  q.append('group_by[]', 'description');
  if (page) q.set('page', page);
  return `${BASE}?${q.toString()}`;
}

export function itemOf(r) {
  if (r?.model) return r.model;
  if (r?.cost_type) return r.cost_type;
  return 'other';
}

// Add one page into `acc` (Map item -> cents). Returns the page total in cents.
// Rows in another currency are left out and counted in `skipped.currency`.
export function addPage(page, acc, skipped = { currency: 0 }) {
  if (!Array.isArray(page?.data)) {
    throw new AiBillError(`${NAME}: unexpected response shape`, { code: 'parse', provider: NAME });
  }
  let cents = 0;
  for (const bucket of page.data) {
    for (const r of bucket?.results || []) {
      const v = Number(r?.amount);
      if (!Number.isFinite(v)) continue;
      if (r?.currency != null && String(r.currency).toLowerCase() !== 'usd') {
        skipped.currency++;
        continue;
      }
      cents += v;
      const k = itemOf(r);
      acc.set(k, (acc.get(k) || 0) + v);
    }
  }
  return cents;
}

// period: optional override (for example this year so far, with months 1 so the total comes back as is).
export async function monthlyCosts({ key, fetch, months, now, timeoutMs, period } = {}) {
  if (!key) throw new AiBillError(`${NAME}: no key set (${ENV})`, { code: 'no_key', provider: NAME });
  const p = period || periodFor({ months, now });
  const headers = {
    'x-api-key': key,
    'anthropic-version': API_VERSION,
    'User-Agent': `tokens-wrapped/${VERSION}`,
  };
  const cents = new Map();
  let totalCents = 0;
  let page = null;
  const seen = new Set();
  const skipped = { currency: 0 };
  for (let i = 0; i < MAX_PAGES; i++) {
    const body = await getJson(buildUrl({ start: p.start, end: p.end, limit: 31, page }), {
      fetch,
      headers,
      provider: NAME,
      secrets: [key],
      timeoutMs,
    });
    totalCents += addPage(body, cents, skipped);
    const next = body?.next_page;
    if (!body?.has_more || !next || seen.has(next)) break;
    seen.add(next);
    page = next;
  }
  const dollars = new Map([...cents.entries()].map(([k, c]) => [k, c / 100]));
  const warnings = skipped.currency
    ? [`${NAME}: ${skipped.currency} cost rows in another currency were left out`]
    : [];
  return result(NAME, totalCents / 100, p, dollars, warnings);
}
