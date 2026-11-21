import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBill, backPerYear, floorHundreds } from '../src/math.js';
import { LINES, findLine } from '../src/rates.js';

const line = (bill, id) => bill.lines.find((l) => l.id === id);

test('per year = monthly x 12 x rate', () => {
  assert.equal(backPerYear(10000, 4), 4800);
  assert.equal(backPerYear(20000, 1.5), 3600);
  assert.equal(backPerYear(2000, 10), 2400);
});

test('OpenAI and Anthropic are vendors at 4%', () => {
  const b = computeBill([{ id: 'openai', monthly_usd: 1000 }, { id: 'anthropic', monthly_usd: 1000 }]);
  for (const id of ['openai', 'anthropic']) {
    assert.equal(line(b, id).kind, 'vendor');
    assert.equal(line(b, id).rate_pct, 4);
    assert.equal(line(b, id).back_per_year_usd, 480);
  }
});

test('a partner rate replaces the 4%, never stacks', () => {
  const cases = { wafer: 10, hopper: 8, conifer: 6, superserve: 5, agentphone: 5, agent37: 4 };
  for (const [id, rate] of Object.entries(cases)) {
    const b = computeBill([{ id, monthly_usd: 1000 }]);
    assert.equal(line(b, id).rate_pct, rate, id);
    assert.equal(line(b, id).back_per_year_usd, (1000 * 12 * rate) / 100, id);
  }
  const w = computeBill([{ id: 'wafer', monthly_usd: 2000 }]);
  assert.equal(w.back_per_year_exact_usd, 2400); // not 2400 + 960
});

test('non-AI card spend earns 1.5%', () => {
  const b = computeBill([{ id: 'other', monthly_usd: 20000 }]);
  assert.equal(line(b, 'other').back_per_year_usd, 3600);
  assert.equal(b.ai_monthly_usd, 0);
  assert.equal(b.other_monthly_usd, 20000);
});

test('unknown AI vendor counts at 4%', () => {
  const b = computeBill([{ id: 'custom:cursor', name: 'Cursor', monthly_usd: 500 }]);
  assert.equal(line(b, 'custom:cursor').rate_pct, 4);
  assert.equal(line(b, 'custom:cursor').back_per_year_usd, 240);
  assert.equal(line(b, 'custom:cursor').name, 'Cursor');
});

test('yearly total rounds DOWN to the nearest $100', () => {
  assert.equal(floorHundreds(11760), 11700);
  assert.equal(floorHundreds(11799.99), 11700);
  assert.equal(floorHundreds(11800), 11800);
  assert.equal(floorHundreds(99), 0);
  const b = computeBill([
    { id: 'openai', monthly_usd: 10000 },
    { id: 'anthropic', monthly_usd: 2000 },
    { id: 'wafer', monthly_usd: 2000 },
    { id: 'other', monthly_usd: 20000 },
  ]);
  assert.equal(b.back_per_year_exact_usd, 11760);
  assert.equal(b.back_per_year_usd, 11700);
  assert.equal(b.ai_yearly_usd, 168000);
});

test('per-line numbers are whole dollars rounded down', () => {
  const b = computeBill([{ id: 'openai', monthly_usd: 123.45 }]);
  assert.equal(line(b, 'openai').back_per_year_usd, 59); // 59.256
});

test('Nodus Compute and Trace show perk text and add nothing', () => {
  const b = computeBill([{ id: 'nodus', monthly_usd: 5000 }, { id: 'trace', monthly_usd: 1500 }]);
  assert.equal(line(b, 'nodus').back_per_year_usd, 0);
  assert.equal(line(b, 'trace').back_per_year_usd, 0);
  assert.equal(b.back_per_year_exact_usd, 0);
  assert.equal(line(b, 'nodus').perk, '7.5% off spot and on-demand GPU rentals');
  assert.equal(line(b, 'trace').perk, '62% off the Startup plan, $1,500 instead of $4,000');
  const withOpenai = computeBill([{ id: 'openai', monthly_usd: 10000 }, { id: 'nodus', monthly_usd: 5000 }]);
  assert.equal(withOpenai.back_per_year_exact_usd, 4800);
});

test('Firecrawl spend earns 1.5% and shows its perk', () => {
  const b = computeBill([{ id: 'firecrawl', monthly_usd: 1000 }]);
  assert.equal(line(b, 'firecrawl').rate_pct, 1.5);
  assert.equal(line(b, 'firecrawl').back_per_year_usd, 180);
  assert.equal(line(b, 'firecrawl').perk, '2x usage limits');
});

test('aliases resolve', () => {
  assert.equal(findLine('agent-37').id, 'agent37');
  assert.equal(findLine('Agent 37').id, 'agent37');
  assert.equal(findLine('nodus-compute').id, 'nodus');
  assert.equal(findLine('Nodus Compute').id, 'nodus');
  assert.equal(findLine('nope'), undefined);
});

test('rates file: no banned words in any string', () => {
  const text = JSON.stringify(LINES);
  assert.doesNotMatch(text, /sav(e|ing)|apply|—/i);
});

test('negative spend (credits, refunds) gives nothing back, never negative', () => {
  const b = computeBill([{ id: 'anthropic', monthly_usd: -50 }, { id: 'openai', monthly_usd: 100 }]);
  assert.equal(line(b, 'anthropic').monthly_usd, 0);
  assert.equal(line(b, 'anthropic').back_per_year_usd, 0);
  assert.ok(b.back_per_year_exact_usd >= 0);
  assert.equal(b.ai_monthly_usd, 100);
});

test('perk-only kind name', () => {
  assert.equal(findLine('nodus').kind, 'perk_only');
  assert.equal(findLine('trace').kind, 'perk_only');
  assert.doesNotMatch(JSON.stringify(LINES), /discount/i);
});
