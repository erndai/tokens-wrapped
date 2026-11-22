import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recapData, cards, page, postText, fit, esc, writeShare, prettyModel, compact, shortDate, PLANS, valueCard, arcDash, pct, duration, plural, dateRange, wrap, measure, usageBins, hourLabel } from '../src/share.js';
import { sampleSummary, SAMPLE_VALUE } from '../scripts/sample.js';
import { edgeCases } from './_edge.js';

const sample = () => recapData({ usage: sampleSummary(), value: SAMPLE_VALUE });

test('story: every local card, in order', () => {
  assert.deepEqual(cards(sample()).story.map((c) => c.id), ['intro', 'tokens', 'value', 'harnesses', 'models', 'cache', 'swarm', 'peak', 'marathon', 'rhythm', 'leash', 'built', 'typing', 'persona', 'summary']);
});

test('cards without a price estimate skip the value card', () => {
  const d = recapData({ usage: sampleSummary(), value: null });
  assert.ok(!cards(d).story.some((c) => c.id === 'value'));
});

test('value card: plain, and one version per plan with the multiple', () => {
  const d = sample();
  const words = (svg) => svg.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(words(valueCard(d).svg), /Your year at API prices \$9,840 Claude Code \$7,420 Codex \$2,420/);
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
  assert.doesNotMatch(all, /—/);
  // The only dash is the en dash in a date range.
  for (const m of words.matchAll(/ – /g)) assert.match(words.slice(m.index - 7, m.index + 9), /[A-Z][a-z]{2} \d{1,2} – [A-Z][a-z]{2} \d/);
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
  assert.ok(fit('$1,000,000,000', 900, 260) < 130);
  assert.equal(prettyModel('deepseek-v4.1-flash-1017'), 'DeepSeek V4.1 Flash');
  assert.equal(prettyModel('kimi-k3'), 'Kimi K3');
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

test('arcs never leave a notch: closed ring near full, a dot when shorter than the stroke, caps inside the extent', () => {
  const r = 300, sw = 96, c = 2 * Math.PI * r;
  for (const f of [0.98, 0.9767, 0.9, 0.5, 0.1, 0.06]) {
    const a = arcDash(r, sw, f);
    assert.equal(a.kind, 'arc', `f=${f}`);
    assert.ok(Math.abs(a.dash - (c * f - sw)) < 1e-9);
    assert.equal(a.offset, -sw / 2);
    // Visible extent, caps included, is exactly c*f; the gap left on the track is at least 12px.
    assert.ok(Math.abs(a.dash + sw - c * f) < 1e-9);
    assert.ok(c - (a.dash + sw) >= 12, `f=${f} leaves a gap under 12px`);
  }
  assert.equal(arcDash(r, sw, 0.995).kind, 'ring');
  assert.equal(arcDash(r, sw, 0.996).kind, 'ring');
  assert.equal(arcDash(r, sw, 0.994).kind, 'ring'); // a 11px gap would read as a notch
  assert.equal(arcDash(r, sw, 1).kind, 'ring');
  assert.equal(arcDash(r, sw, 1.4).kind, 'ring');
  assert.equal(arcDash(r, sw, 0.02).kind, 'dot');
  assert.equal(arcDash(r, sw, 0.0001).kind, 'dot');
  assert.equal(arcDash(r, sw, 0).kind, 'none');
  assert.equal(arcDash(r, 64, 20.56 / 24).kind, 'arc');
  assert.ok(Math.abs(arcDash(r, 64, 20.56 / 24).dash - (c * (20.56 / 24) - 64)) < 1e-9);
});

test('number rules: pct, durations, plurals, date ranges, hours', () => {
  assert.equal(pct(0.9767), '98%');
  assert.equal(pct(0.995), '>99%');
  assert.equal(pct(0.9996), '>99%');
  assert.equal(pct(1), '100%');
  assert.equal(pct(0.004), '<1%');
  assert.equal(pct(0.005), '1%');
  assert.equal(pct(0), '0%');
  assert.equal(duration(20.561), '20.6 hours');
  assert.equal(duration(9), '9 hours');
  assert.equal(duration(1), '1 hour');
  assert.equal(duration(50), '2.1 days');
  assert.equal(duration(48), '2 days');
  assert.equal(plural(1, 'agent'), '1 agent');
  assert.equal(plural(3228, 'message'), '3,228 messages');
  assert.equal(dateRange('2026-02-24', '2026-11-21'), 'Feb 24 – Nov 21');
  assert.equal(dateRange('2026-02-24', '2026-02-24'), 'Feb 24');
  assert.equal(hourLabel(0), 'midnight');
  assert.equal(hourLabel(12), 'noon');
  assert.equal(hourLabel(1), '1am');
});

test('wrap measures by character and never leaves one word on the last line', () => {
  const ls = wrap('Every token billed at list price across four agents', 60, 700);
  assert.ok(ls.length > 1);
  assert.ok(ls[ls.length - 1].split(' ').length > 1);
  for (const l of ls) assert.ok(measure(l, 60) <= 700);
  // Digits measure narrower than capitals, which the old flat estimate didn't know.
  assert.ok(measure('1111', 100) < measure('WWWW', 100));
});

test('peak chart bins start at the first day with any usage, weekly past 60 days', () => {
  const u = sampleSummary();
  const { daily, bins } = usageBins(u);
  assert.equal(daily, false);
  assert.equal(bins[0].start, u.since);
  assert.equal(bins.reduce((a, b) => a + b.tokens, 0), u.tokens.total);
  const short = { days: u.days.slice(0, 21) };
  assert.equal(usageBins(short).daily, true);
  assert.equal(usageBins(short).bins.length, 21);
});

// Every text's right edge, from the same measure the cards fit with.
function textEdges(svg) {
  const out = [];
  for (const m of svg.matchAll(/<text ([^>]*)>([\s\S]*?)<\/text>/g)) {
    const a = Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    const s = m[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    const size = +a['font-size'];
    const w = measure(s, size, { weight: +a['font-weight'], ls: +a['letter-spacing'] / size });
    const x = +a.x;
    const left = a['text-anchor'] === 'middle' ? x - w / 2 : a['text-anchor'] === 'end' ? x - w : x;
    out.push({ s, left, right: left + w, y: +a.y, size });
  }
  return out;
}

test('edge cases: every card is valid, has no NaN, and no text passes x 990 or leaves the safe area', () => {
  const sets = [['sample', { usage: sampleSummary(), value: SAMPLE_VALUE }], ...edgeCases()];
  for (const [name, data] of sets) {
    const d = recapData(data);
    const c = cards(d);
    const all = [...c.story, c.wide, ...(d.value ? PLANS.map((p) => valueCard(d, p)) : [])];
    for (const k of all) {
      const where = `${name}/${k.id}`;
      assert.match(k.svg, /^<svg [^>]+>[\s\S]*<\/svg>$/, where);
      assert.doesNotMatch(k.svg, /NaN|undefined|Infinity|null/, where);
      assert.equal((k.svg.match(/<text\b/g) || []).length, (k.svg.match(/<\/text>/g) || []).length, where);
      const maxX = k.w - 90 + (k.id === 'wide' ? 40 : 0);
      for (const t of textEdges(k.svg)) {
        assert.ok(t.right <= maxX + 0.5, `${where}: "${t.s}" ends at ${t.right.toFixed(0)}`);
        assert.ok(t.left >= 80, `${where}: "${t.s}" starts at ${t.left.toFixed(0)}`);
        if (k.id !== 'wide' && k.id !== 'intro') assert.ok(t.y - t.size * 0.72 >= 240 && t.y <= 1640, `${where}: "${t.s}" at y ${t.y}`);
      }
    }
  }
});

test('edge cases: one agent and model get the solo layout; many get +N more; unknown tokens are dashed', () => {
  const [[, solo], [, many], [, tiny]] = edgeCases();
  const s = cards(recapData(solo)).story;
  const words = (svg) => svg.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(words(s.find((c) => c.id === 'harnesses').svg), /100% of your tokens/);
  assert.ok(!s.some((c) => c.id === 'swarm'), '2 agents at once is not a swarm');
  assert.doesNotMatch(s.find((c) => c.id === 'tokens').svg, /stroke-dasharray/, 'no grid when output is unknown');
  const m = cards(recapData(many)).story;
  assert.match(words(m.find((c) => c.id === 'harnesses').svg), /\+3 more/);
  assert.match(m.find((c) => c.id === 'harnesses').svg, /stroke-dasharray="10 8"/);
  assert.match(words(m.find((c) => c.id === 'swarm').svg), /1 dot = 4 agents/);
  assert.match(words(m.find((c) => c.id === 'cache').svg), /100%/);
  const t = cards(recapData(tiny)).story;
  assert.match(words(t.find((c) => c.id === 'cache').svg), /&gt;99%/);
  assert.match(words(t.find((c) => c.id === 'tokens').svg), /6 written for every 1 read/);
});
