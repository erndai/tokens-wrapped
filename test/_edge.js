// Made-up recaps at the edges of what the cards must handle: one of everything, many of everything, unknown and
// tiny numbers. The share tests render every card for each one; scripts can render them to look at.
import { sampleSummary } from '../scripts/sample.js';

const days = (from, n, tokens = () => 0, replies = () => 0) => {
  const out = [];
  const d = new Date(`${from}T12:00:00`);
  for (let i = 0; i < n; i++, d.setDate(d.getDate() + 1)) out.push({ date: d.toISOString().slice(0, 10), tokens: tokens(i), replies: replies(i) });
  return out;
};

// One agent, one model, one active day, unknown output, cache 2%, a short session, a short solo run.
function solo() {
  const u = sampleSummary();
  const cal = days('2026-11-20', 2, (i) => (i === 0 ? 4_200_000 : 0), (i) => (i === 0 ? 30 : 0));
  return {
    usage: {
      ...u,
      since: cal[0].date,
      until: cal[1].date,
      sources: ['GitHub Copilot CLI Agent'],
      harnesses: [{ id: 'copilot', name: 'GitHub Copilot CLI Agent', tokens: 4_200_000, replies: 30, days: 1, tokensKnown: true }],
      tokens: { total: 4_200_000, input: 4_200_000, cached: 84_000, cacheWrite: 0, output: 0, reasoning: 0 },
      cacheHit: 0.02,
      models: [{ name: 'deepseek-v4.1-flash-reasoner-1017', tokens: 4_200_000 }],
      days: cal,
      peak: cal[0],
      activeDays: 1,
      streak: 1,
      busiestHour: 0,
      hours: [30, ...Array(23).fill(0)],
      together: { agents: 2, date: cal[0].date, hour: 0 },
      leash: { actions: 12, date: cal[0].date },
      longestSession: { hours: 0.5, date: cal[0].date, harness: 'GitHub Copilot CLI Agent' },
      typing: { words: 50_000, hours: 50_000 / 40 / 60 },
      built: { lines: 312, files: 1, languages: [] },
      sessions: 1,
      prompts: 1,
      tools: [{ name: 'mcp__a_very_long_server_name__and_an_even_longer_tool_name', calls: 1 }],
    },
    value: { api: 6.2, months: 1, unpricedShare: 0, byHarness: [{ name: 'GitHub Copilot CLI Agent', api: 6.2 }] },
  };
}

// Seven agents with long names (one with unknown tokens), five long model names, cache 100%, a 50-hour session,
// 500 agents at once, 9,000 actions, 120 years of typing, thirteen agents in the price split, huge numbers.
function many() {
  const u = sampleSummary();
  const names = ['Claude Code Enterprise X', 'OpenAI Codex CLI Preview', 'GitHub Copilot CLI Agent', 'Gemini CLI Experimental', 'Cursor Background Agent', 'Factory Droid Exec Mode', 'Kilo Code Orchestrator'];
  const harnesses = names.map((name, i) => ({ id: `h${i}`, name, tokens: i === 2 ? 0 : Math.round(3.4e12 / 2 ** (i + 1)), replies: 9000 - i * 1000, days: 300 - i * 40, tokensKnown: i !== 2 }));
  const cal = days('2026-01-01', 324, (i) => (i % 9 === 3 ? 0 : 1e10 + i * 3e7), (i) => (i % 9 === 3 ? 0 : 200));
  cal[300].tokens = 9e10;
  return {
    usage: {
      ...u,
      since: cal[0].date,
      until: cal[cal.length - 1].date,
      sources: names,
      harnesses,
      tokens: { total: 3.4e12, input: 3.39e12, cached: 3.39e12, cacheWrite: 0, output: 1e10, reasoning: 0 },
      cacheHit: 1,
      models: [
        { name: 'claude-opus-5-5', tokens: 1.2e12 },
        { name: 'gemini-3.8-flash-lite-preview-thinking', tokens: 9e11 },
        { name: 'deepseek-v4.1-flash-reasoner-1017', tokens: 6e11 },
        { name: 'qwen3-coder-480b-a35b-instruct-turbo', tokens: 4e11 },
        { name: 'gpt-6.1-sol-codex-max-high', tokens: 3e11 },
        { name: 'kimi-k3', tokens: 1e9 },
      ],
      days: cal,
      peak: cal[300],
      activeDays: 288,
      streak: 8,
      busiestHour: 12,
      together: { agents: 500, date: cal[200].date, hour: 12 },
      leash: { actions: 9000, date: cal[100].date },
      longestSession: { hours: 50, date: cal[50].date, harness: 'Claude Code Enterprise X' },
      typing: { words: 120 * 2000 * 60 * 40, hours: 120 * 2000 },
      built: {
        lines: 123_456_789,
        files: 987_654,
        languages: [
          { ext: 'ts', edits: 210 }, { ext: 'tsx', edits: 50 }, { ext: 'js', edits: 240 }, { ext: 'py', edits: 230 },
          { ext: 'go', edits: 220 }, { ext: 'rs', edits: 200 }, { ext: 'md', edits: 190 },
        ],
      },
      sessions: 123_456,
      prompts: 9_876_543,
      tools: [{ name: 'Bash', calls: 12_345_678 }],
    },
    value: {
      api: 1_234_568,
      months: 11,
      unpricedShare: 0,
      byHarness: [
        { name: 'Claude Code Enterprise X', api: 700_000 },
        ...['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'].map((x, i) => ({ name: `Agent ${x} with a long name`, api: 534_568 / 12 + (i < 2 ? 40_000 : -6_700) })),
      ],
    },
  };
}

// Tiny and odd numbers: 812 tokens with more written than read, cache 99.6%, a 26-hour session, 5 agents at
// once, a 21-day span (daily bars), every hour empty but one, a 4,000-hour session.
function tiny() {
  const u = sampleSummary();
  const cal = days('2026-10-31', 21, (i) => (i % 3 ? 0 : 20 + i), (i) => (i % 2 ? 0 : 3));
  return {
    usage: {
      ...u,
      since: cal[0].date,
      until: cal[cal.length - 1].date,
      harnesses: [
        { id: 'a', name: 'Pi', tokens: 600, replies: 9, days: 4, tokensKnown: true },
        { id: 'b', name: 'Cursor', tokens: 0, replies: 1, days: 1, tokensKnown: false },
      ],
      tokens: { total: 812, input: 112, cached: 111.6, cacheWrite: 0, output: 700, reasoning: 0 },
      cacheHit: 0.996,
      models: [{ name: 'kimi-k3', tokens: 600 }, { name: 'o3-mini', tokens: 212 }],
      days: cal,
      peak: cal[18],
      activeDays: 11,
      streak: 1,
      busiestHour: 12,
      hours: Array.from({ length: 24 }, (_, h) => (h === 12 ? 5 : 0)),
      together: { agents: 5, date: cal[3].date, hour: 12 },
      leash: { actions: 2, date: cal[3].date },
      longestSession: { hours: 26, date: cal[3].date, harness: 'Pi' },
      typing: { words: 3 * 40 * 60 * 40, hours: 3 * 40 },
      built: { lines: 1, files: 1, languages: [{ ext: 'py', edits: 1 }] },
      sessions: 1,
      prompts: 1,
      tools: [],
    },
    value: { api: 1.5, months: 1, unpricedShare: 0, byHarness: [] },
  };
}

// A marathon over three days, and nothing optional at all except tokens.
function bare() {
  const u = sampleSummary();
  return {
    usage: {
      ...u,
      harnesses: [{ id: 'x', name: 'Codex', tokens: u.tokens.total, replies: 10, days: 1, tokensKnown: true }],
      models: [],
      cacheHit: null,
      together: null,
      leash: null,
      typing: null,
      built: { lines: 0, files: 0, languages: [] },
      longestSession: { hours: 100, date: u.since, harness: 'Codex' },
    },
    value: null,
  };
}

export function edgeCases() {
  return [['solo', solo()], ['many', many()], ['tiny', tiny()], ['bare', bare()]];
}
