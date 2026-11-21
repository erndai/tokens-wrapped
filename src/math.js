import { findLine } from './rates.js';

const EPS = 1e-9;

// Yearly amount back for one line: monthly x 12 x rate. Kept unrounded; callers floor for display.
export function backPerYear(monthlyUsd, ratePct) {
  return (monthlyUsd * 12 * ratePct) / 100;
}

export function floorDollars(x) {
  return Math.floor(x + EPS);
}

export function floorHundreds(x) {
  return Math.floor(x / 100 + EPS) * 100;
}

// entries: [{ id, monthly_usd, source?, by_item?, name? }]
// id is a rates.js line id, or anything else for an unnamed AI vendor (counted at 4%).
export function computeBill(entries) {
  const lines = [];
  for (const e of entries) {
    // Credits and refunds can make a provider net negative. Nothing comes back on negative spend.
    const monthly = Math.max(0, Number(e.monthly_usd) || 0);
    const def = findLine(e.id) || {
      id: e.id,
      name: e.name || e.id,
      kind: 'vendor',
      rate: findLine('ai').rate,
    };
    const exact = backPerYear(monthly, def.rate);
    lines.push({
      id: def.id,
      name: e.name || def.name,
      short: e.name ? null : def.short || null,
      kind: def.kind,
      source: e.source || 'manual',
      monthly_usd: monthly,
      yearly_usd: monthly * 12,
      rate_pct: def.rate,
      back_per_year_usd: floorDollars(exact),
      back_exact: exact,
      perk: def.perk || null,
      by_item: e.by_item || [],
    });
  }
  const ai = lines.filter((l) => l.kind !== 'card');
  const card = lines.filter((l) => l.kind === 'card');
  const aiMonthly = sum(ai.map((l) => l.monthly_usd));
  const cardMonthly = sum(card.map((l) => l.monthly_usd));
  const exactTotal = sum(lines.map((l) => l.back_exact));
  return {
    lines,
    ai_monthly_usd: aiMonthly,
    ai_yearly_usd: aiMonthly * 12,
    other_monthly_usd: cardMonthly,
    back_per_year_exact_usd: round2(exactTotal),
    back_per_year_usd: floorHundreds(exactTotal),
  };
}

function sum(xs) {
  return xs.reduce((a, b) => a + b, 0);
}

function round2(x) {
  return Math.round(x * 100) / 100;
}
