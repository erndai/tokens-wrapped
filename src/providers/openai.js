// OpenAI organization Costs API: GET https://api.openai.com/v1/organization/costs
// Needs an organization Admin API key (sk-admin-...). amount.value is in whole dollars.
import { getJson, AiBillError } from '../http.js';
import { periodFor, MAX_PAGES } from '../period.js';
import { VERSION } from '../version.js';
import { result } from './result.js';

export const id = 'openai';
export const NAME = 'OpenAI';
export const ENV = 'OPENAI_ADMIN_KEY';
const BASE = 'https://api.openai.com/v1/organization/costs';

export function buildUrl({ start, end, limit, page }) {
  const q = new URLSearchParams();
  q.set('start_time', String(Math.floor(start.getTime() / 1000)));
  q.set('end_time', String(Math.floor(end.getTime() / 1000)));
  q.set('bucket_width', '1d');
  q.set('limit', String(limit));
  q.append('group_by[]', 'line_item');
  if (page) q.set('page', page);
  return `${BASE}?${q.toString()}`;
}

// "gpt-6.2-astra, input_tokens" -> "gpt-6.2-astra". Strings without ", " are kept whole.
export function modelOf(lineItem) {
  if (!lineItem) return 'other';
  const s = String(lineItem);
  const i = s.lastIndexOf(', ');
  return i > 0 ? s.slice(0, i) : s;
}

// Add one page's buckets into `acc` (Map model -> dollars). Returns the page's dollar total.
// Rows in another currency are left out and counted in `skipped.currency`.
export function addPage(page, acc, skipped = { currency: 0 }) {
  if (!Array.isArray(page?.data)) {
    throw new AiBillError(`${NAME}: unexpected response shape`, { code: 'parse', provider: NAME });
  }
  let total = 0;
  for (const bucket of page.data) {
    for (const r of bucket?.results || []) {
      const v = Number(r?.amount?.value);
      if (!Number.isFinite(v)) continue;
      const cur = r?.amount?.currency;
      if (cur != null && String(cur).toLowerCase() !== 'usd') {
        skipped.currency++;
        continue;
      }
      total += v;
      const k = modelOf(r.line_item);
      acc.set(k, (acc.get(k) || 0) + v);
    }
  }
  return total;
}

// period: optional override (for example this year so far, with months 1 so the total comes back as is).
export async function monthlyCosts({ key, fetch, months, now, timeoutMs, period } = {}) {
  if (!key) throw new AiBillError(`${NAME}: no key set (${ENV})`, { code: 'no_key', provider: NAME });
  const p = period || periodFor({ months, now });
  const limit = Math.min(p.days, 180);
  const headers = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    'User-Agent': `tokens-wrapped/${VERSION}`,
  };
  const items = new Map();
  let total = 0;
  let page = null;
  const seen = new Set();
  const skipped = { currency: 0 };
  for (let i = 0; i < MAX_PAGES; i++) {
    const body = await getJson(buildUrl({ start: p.start, end: p.end, limit, page }), {
      fetch,
      headers,
      provider: NAME,
      secrets: [key],
      timeoutMs,
    });
    total += addPage(body, items, skipped);
    const next = body?.next_page;
    if (!body?.has_more || !next || seen.has(next)) break;
    seen.add(next);
    page = next;
  }
  const warnings = skipped.currency
    ? [`${NAME}: ${skipped.currency} cost rows in another currency were left out`]
    : [];
  return result(NAME, total, p, items, warnings);
}
