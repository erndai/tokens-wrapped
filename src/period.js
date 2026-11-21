const DAY = 86400 * 1000;

function utcMidnight(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// months null/undefined: the last 30 full UTC days (today excluded). Averages over 1 month.
// months N (1-12): the last N full calendar months in UTC (this month excluded). Averages over N.
export function periodFor({ months, now = new Date() } = {}) {
  const n = now instanceof Date ? now : new Date(now);
  if (months == null) {
    const end = utcMidnight(n);
    const start = new Date(end.getTime() - 30 * DAY);
    return { kind: 'last_30_days', months: 1, days: 30, start, end, label: 'last 30 days' };
  }
  const m = Number(months);
  if (!Number.isInteger(m) || m < 1 || m > 12) throw new RangeError('months must be 1-12');
  const end = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1));
  const start = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - m, 1));
  const days = Math.round((end - start) / DAY);
  const label = m === 1 ? 'last month' : `last ${m} months, monthly average`;
  return { kind: 'months', months: m, days, start, end, label };
}

export const MAX_PAGES = 60;
