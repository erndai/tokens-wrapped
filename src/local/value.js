// What the year would have cost at API list prices, from token counts. An estimate, labeled as one on the card.

import { PRICES } from './prices.js';

// Strip what wraps a model id in different harnesses: "anthropic/…", "models/…", "global.anthropic.…", "…[1m]".
export function normalizeModel(id) {
  return String(id || '')
    .toLowerCase()
    .replace(/^(models\/|[a-z0-9-]+\/)/, '')
    .replace(/^(global\.|us\.|eu\.)?anthropic\./, '')
    .replace(/\[1m\]$/, '')
    .replace(/-v\d+:\d+$/, '')
    .trim();
}

export function priceFor(model) {
  const m = normalizeModel(model);
  let best = null;
  for (const row of PRICES) if (m.startsWith(row[0]) && (!best || row[0].length > best[0].length)) best = row;
  if (!best) return null;
  const [, input, read, write, writeLong, output] = best;
  return { input, read: read ?? input, write: write ?? input, writeLong: writeLong ?? write ?? input, output };
}

// One model's tokens -> dollars. input includes cached and cache-write tokens (see tally.js).
export function costOf(p, b) {
  const uncached = Math.max(0, b.input - b.cached - b.cacheWrite);
  const longWrites = Math.min(b.cacheWrite, b.cacheWrite1h || 0);
  const shortWrites = b.cacheWrite - longWrites;
  return (uncached * p.input + b.cached * p.read + shortWrites * p.write + longWrites * p.writeLong + b.output * p.output) / 1e6;
}

const DAY = 86400000;

// tallies: from the local readers. since/until: ISO days of the recap. Returns null when nothing could be priced.
export function estimate(tallies, { since, until }) {
  let api = 0;
  let priced = 0;
  let unpriced = 0;
  const byHarness = [];
  for (const t of tallies) {
    let h = 0;
    // A harness that stores its own per-message cost (OpenCode) is used as is: it knows its providers' prices.
    if (t.cost > 0) {
      h = t.cost;
      priced += t.tokens.input + t.tokens.output;
    } else {
      for (const [model, b] of t.byModel) {
        const p = priceFor(model);
        if (p) {
          h += costOf(p, b);
          priced += b.input + b.output;
        } else unpriced += b.input + b.output;
      }
    }
    api += h;
    byHarness.push({ name: t.name, api: h });
  }
  if (!priced) return null;
  const days = Math.max(1, Math.round((Date.parse(`${until}T12:00:00`) - Date.parse(`${since}T12:00:00`)) / DAY) + 1);
  return {
    api,
    months: Math.max(1, Math.ceil(days / 30.44)),
    unpricedShare: unpriced / (priced + unpriced),
    byHarness: byHarness.sort((a, b) => b.api - a.api),
  };
}
