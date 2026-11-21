// Made-up numbers in the shape summarizeLocal() returns: the website's sample recap and the tests use it.

export function sampleSummary() {
  const year = 2026;
  const days = [];
  let seed = 11;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  for (let d = new Date('2026-06-02T12:00:00'); d < new Date('2026-11-21T00:00:00'); d.setDate(d.getDate() + 1)) {
    const wk = d.getDay();
    const iso = d.toISOString().slice(0, 10);
    const off = (wk === 0 && rnd() < 0.6) || rnd() < 0.08;
    let tokens = off ? 0 : (12e6 + (d - new Date('2026-06-02')) / 864e5 * 3e5) * (wk === 6 ? 0.4 : 1) * (0.6 + rnd() * 0.8);
    if (iso === '2026-09-17') tokens *= 4.5;
    days.push({ date: iso, tokens: Math.round(tokens), replies: off ? 0 : Math.round(tokens / 3e5) });
  }
  const total = days.reduce((a, d) => a + d.tokens, 0);
  const hours = [2, 1, 0, 0, 0, 0, 1, 3, 9, 18, 26, 30, 24, 28, 33, 36, 38, 31, 22, 19, 21, 17, 10, 5];
  return {
    source: 'local',
    year,
    since: days[0].date,
    until: days[days.length - 1].date,
    sources: ['Claude Code', 'Codex', 'Cursor'],
    harnesses: [
      { id: 'claude-code', name: 'Claude Code', tokens: Math.round(total * 0.78), replies: 41230, days: 131, tokensKnown: true },
      { id: 'codex', name: 'Codex', tokens: Math.round(total * 0.22), replies: 9120, days: 44, tokensKnown: true },
      { id: 'cursor', name: 'Cursor', tokens: 0, replies: 3810, days: 37, tokensKnown: false },
    ],
    tokens: { total, input: Math.round(total * 0.985), cached: Math.round(total * 0.94), cacheWrite: Math.round(total * 0.02), output: Math.round(total * 0.015), reasoning: 0 },
    cacheHit: 0.954,
    models: [
      { name: 'claude-opus-5-5', tokens: total * 0.52 },
      { name: 'gpt-6.1-sol', tokens: total * 0.17 },
      { name: 'claude-sonnet-5-5', tokens: total * 0.16 },
      { name: 'claude-fable-5-1', tokens: total * 0.1 },
      { name: 'gpt-6-astra', tokens: total * 0.05 },
    ],
    days,
    peak: days.reduce((a, b) => (b.tokens > a.tokens ? b : a)),
    activeDays: days.filter((d) => d.replies).length,
    streak: 34,
    busiestHour: 16,
    hours,
    replies: 54160,
    prompts: 8420,
    sessions: 912,
    projects: 64,
    tools: [{ name: 'Bash', calls: 30120 }, { name: 'Edit', calls: 9050 }],
    built: { lines: 284310, files: 2140, languages: [{ ext: 'ts', edits: 4100 }, { ext: 'py', edits: 1900 }] },
    together: { agents: 14, date: '2026-10-08', hour: 23 },
    leash: { actions: 412, date: '2026-09-17' },
    longestSession: { hours: 9.4, date: '2026-10-21', harness: 'Claude Code' },
    typing: { words: 9.4e6, hours: 9.4e6 / 40 / 60 },
    storedCost: null,
    webSearches: null,
    code: null,
  };
}

export const SAMPLE_VALUE = { api: 9840, months: 6, unpricedShare: 0, byHarness: [] };
