// Shared shape for every provider: { provider, monthly_usd, months, period, by_item: [{ name, usd }], warnings }.
// by_item usd is a monthly average, like monthly_usd. warnings are one-line notes for stderr.
export function result(provider, totalUsd, p, items, warnings = []) {
  const by_item = [...items.entries()]
    .map(([name, usd]) => ({ name, usd: usd / p.months }))
    .filter((x) => x.usd !== 0)
    .sort((a, b) => b.usd - a.usd);
  return {
    provider,
    monthly_usd: totalUsd / p.months,
    months: p.months,
    period: { kind: p.kind, start: p.start.toISOString(), end: p.end.toISOString(), label: p.label },
    by_item,
    warnings,
  };
}
