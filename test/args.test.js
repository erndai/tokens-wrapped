import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, parseMoney, UsageError } from '../src/args.js';
import { parseSpendAnswer } from '../src/interactive.js';

test('manual spend flags', () => {
  const a = parse(['--openai', '8000', '--anthropic', '4000', '--wafer=2000', '--other', '20000']);
  assert.deepEqual([...a.spend.entries()], [
    ['openai', 8000],
    ['anthropic', 4000],
    ['wafer', 2000],
    ['other', 20000],
  ]);
  assert.equal(a.months, null);
  assert.equal(a.json, false);
});

test('every provider in the rates table is a flag, aliases included', () => {
  const a = parse(['--agent-37', '100', '--nodus-compute', '1k', '--hopper', '$2,500', '--ai', '300', '--firecrawl', '50']);
  assert.equal(a.spend.get('agent37'), 100);
  assert.equal(a.spend.get('nodus'), 1000);
  assert.equal(a.spend.get('hopper'), 2500);
  assert.equal(a.spend.get('ai'), 300);
  assert.equal(a.spend.get('firecrawl'), 50);
});

test('options', () => {
  const a = parse(['--json', '--by-model', '--no-color', '--months', '3', '--offline']);
  assert.equal(a.json, true);
  assert.equal(a.byModel, true);
  assert.equal(a.noColor, true);
  assert.equal(a.months, 3);
  assert.equal(a.offline, true);
  assert.equal(parse(['-h']).help, true);
  assert.equal(parse(['-v']).version, true);
});

test('bad input is a usage error', () => {
  for (const argv of [['--months', '0'], ['--months', '13'], ['--months', '2.5'], ['--openai', 'lots'], ['--openai', '-5'], ['--bogus', '1'], ['12000']]) {
    assert.throws(() => parse(argv), UsageError, argv.join(' '));
  }
});

test('parseMoney', () => {
  assert.equal(parseMoney('8000'), 8000);
  assert.equal(parseMoney('8k'), 8000);
  assert.equal(parseMoney('$8,000'), 8000);
  assert.equal(parseMoney('1.5m'), 1500000);
  assert.equal(parseMoney('2,500.50'), 2500.5);
  assert.ok(Number.isNaN(parseMoney('abc')));
  assert.ok(Number.isNaN(parseMoney('')));
});

test('interactive answer parsing', () => {
  const { entries } = parseSpendAnswer('openai 8k, anthropic 4000 and wafer $2,000 agent 37 500 cursor 300');
  const m = Object.fromEntries(entries.map((e) => [e.id, e.monthly_usd]));
  assert.deepEqual(m, { openai: 8000, anthropic: 4000, wafer: 2000, agent37: 500, 'custom:cursor': 300 });
  assert.equal(entries.find((e) => e.id === 'custom:cursor').name, 'Cursor');
  assert.deepEqual(parseSpendAnswer('12000').entries, [{ id: 'ai', name: 'Other AI vendors', monthly_usd: 12000 }]);
  assert.deepEqual(parseSpendAnswer('').entries, []);
});

test('interactive parsing: number first, filler, suffixes, aliases', () => {
  const m = (t) => Object.fromEntries(parseSpendAnswer(t).entries.map((e) => [e.id, e.monthly_usd]));
  assert.deepEqual(m('2000 wafer'), { wafer: 2000 });
  assert.deepEqual(m('openai 8000, 2000 wafer'), { openai: 8000, wafer: 2000 });
  assert.deepEqual(m('8000 openai 4000 anthropic'), { openai: 8000, anthropic: 4000 });
  assert.deepEqual(m('about 5k on openai'), { openai: 5000 });
  assert.deepEqual(m('about 15k total'), { ai: 15000 });
  assert.deepEqual(m('12000/mo'), { ai: 12000 });
  assert.deepEqual(m('openai 8k/mo'), { openai: 8000 });
  assert.deepEqual(m('claude 3000 gpt 2000 chatgpt 100'), { anthropic: 3000, openai: 2100 });
  assert.deepEqual(m('500 agent 37'), { agent37: 500 });
  assert.equal(parseSpendAnswer('openai 8000 lots').leftover, 'lots');
});

test('interactive parsing: cloud platforms are card spend, some vendors are never named', () => {
  const { entries } = parseSpendAnswer('azure 3000 bedrock 2000 glm 500 z.ai 100 zhipu 50 openai 8k');
  const m = Object.fromEntries(entries.map((e) => [e.id, e.monthly_usd]));
  assert.deepEqual(m, { other: 5000, ai: 650, openai: 8000 });
  const names = entries.map((e) => e.name).join(' ');
  assert.doesNotMatch(names, /azure|bedrock|glm|z\.ai|zhipu/i);
  for (const t of ['aws 100', 'gcp 100', 'vertex 100', 'google cloud 100']) {
    assert.deepEqual(parseSpendAnswer(t).entries.map((e) => e.id), ['other'], t);
  }
});
