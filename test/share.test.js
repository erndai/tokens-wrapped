import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recapData, cards, page, postText, fit, esc, writeShare, prettyModel, compact, shortDate, PLANS, valueCard } from '../src/share.js';
import { sampleSummary, SAMPLE_VALUE } from '../scripts/sample.js';

const sample = () => recapData({ usage: sampleSummary(), value: SAMPLE_VALUE });

test('story: every local card, in order', () => {
  assert.deepEqual(cards(sample()).story.map((c) => c.id), ['intro', 'value', 'tokens', 'harnesses', 'models', 'cache', 'swarm', 'peak', 'marathon', 'rhythm', 'leash', 'built', 'typing', 'persona', 'summary']);
});

test('cards without a price estimate skip the value card', () => {
  const d = recapData({ usage: sampleSummary(), value: null });
  assert.ok(!cards(d).story.some((c) => c.id === 'value'));
});

test('value card: plain, and one version per plan with the multiple', () => {
  const d = sample();
  const words = (svg) => svg.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(words(valueCard(d).svg), /At API prices, your year cost \$9,840/);
  const v200 = words(valueCard(d, 200).svg);
  assert.match(v200, /On a \$200\/month plan you paid \$1,200 for 6 months\./);
  assert.match(v200, /8\.2x what you paid/);
  assert.deepEqual(PLANS, [20, 100, 200]);
});

test('a recap, not an ad: no pitch, no Spotify, no dashes; text escaped', () => {
  const d = sample();
  const c = cards(d);
  const all = [...c.story, c.wide].map((x) => x.svg).join('') + postText(d);
  const words = all.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(words, /ernd\.ai/);
  assert.doesNotMatch(words, /back a year|% back|annual fee|request|credit card|npx/i);
  assert.doesNotMatch(all, /spotify|\bwrapped\b/i);
  assert.doesNotMatch(all, /[—–]/);
  assert.equal(esc(`a<b>&"'`), 'a&lt;b&gt;&amp;&quot;&#39;');
});

test('post text: the numbers and the site', () => {
  assert.equal(postText(sample()), 'my 2026 in AI: 5.1B tokens, $9,840 at API prices, 14 agents at once, 95% cache hits, 412 agent actions without a word from me, 284K lines written\n\ntokenswrapped.com');
});

test('formatting helpers', () => {
  assert.equal(prettyModel('claude-opus-5-5'), 'Claude Opus 5.5');
  assert.equal(prettyModel('gpt-6.1-sol'), 'GPT-6.1 Sol');
  assert.equal(prettyModel('claude-opus-4-20250514'), 'Claude Opus 4');
  assert.equal(compact(4_870_000_000), '4.9B');
  assert.equal(compact(56_300), '56.3K');
  assert.equal(shortDate('2026-09-17'), 'Sep 17');
  assert.equal(fit('$1', 900, 260), 260);
  assert.ok(fit('$1,000,000,000', 900, 260) < 120);
});

test('the page makes one request, only when Post on X is clicked: the card upload', () => {
  const html = page(sample());
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+href=/i);
  assert.equal((html.match(/\bfetch\(/g) || []).length, 1);
  assert.match(html, /xBtn\.onclick=async\(\)=>\{[\s\S]*fetch\(UPLOAD,\{method:'POST',headers:\{'content-type':'image\/png'\},body:card/);
  for (const u of html.match(/https?:\/\/[^\s"'<)]+/g) || []) {
    assert.ok(u.startsWith('http://www.w3.org/') || u.startsWith('https://x.com/intent/post') || u.startsWith('https://tokenswrapped.com'), u);
  }
});

test('writeShare never overwrites', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-share-'));
  try {
    writeShare({ usage: sampleSummary(), value: SAMPLE_VALUE, dir });
    assert.throws(() => writeShare({ usage: sampleSummary(), value: SAMPLE_VALUE, dir }), /EEXIST/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
