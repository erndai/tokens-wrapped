import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeBill } from '../src/math.js';
import { recapData, cards, page, postText, fit, esc, writeShare } from '../src/share.js';
import { main } from '../src/cli.js';
import { sink, NOW, EMPTY_HOME } from './_helpers.js';

const withModels = () =>
  computeBill([
    {
      id: 'openai',
      monthly_usd: 10000,
      source: 'api',
      by_item: [
        { name: 'gpt-5.1', usd: 6200 },
        { name: 'gpt-5.1-mini', usd: 2100 },
        { name: 'o4 <deep> & research', usd: 1100 },
      ],
    },
    { id: 'anthropic', monthly_usd: 2000, source: 'api', by_item: [{ name: 'claude-opus-5-5', usd: 2000 }] },
    { id: 'wafer', monthly_usd: 2000 },
    { id: 'other', monthly_usd: 20000 },
  ]);

const manual = () => computeBill([{ id: 'openai', monthly_usd: 10000 }, { id: 'wafer', monthly_usd: 2000 }]);

test('recap data: AI vendors only, biggest first, models yearly', () => {
  const d = recapData(withModels(), { now: NOW });
  assert.equal(d.year, 2026);
  assert.equal(d.spend, 168000);
  assert.deepEqual(d.vendors.map((v) => v.name), ['OpenAI', 'Anthropic', 'Wafer']);
  assert.equal(d.models[0].name, 'gpt-5.1');
  assert.equal(d.models[0].value, '$74,400 a year');
  assert.ok(!d.vendors.some((v) => v.name === 'Everything else'));
});

test('story: models card only when there are models', () => {
  const ids = (b) => cards(recapData(b, { now: NOW })).story.map((c) => c.id);
  assert.deepEqual(ids(withModels()), ['intro', 'spend', 'vendors', 'models', 'summary']);
  assert.deepEqual(ids(manual()), ['intro', 'spend', 'vendors', 'summary']);
});

test('cards carry the numbers and escape names', () => {
  const { story, wide } = cards(recapData(withModels(), { now: NOW }));
  const all = [...story, wide].map((c) => c.svg).join('');
  assert.match(all, /\$168,000/);
  assert.match(all, /\$120,000 a year/);
  assert.match(all, /o4 &lt;deep&gt; &amp; research/);
  assert.doesNotMatch(all, /<deep>/);
  for (const c of [...story, wide]) assert.match(c.svg, /^<svg [^>]*width="\d+" height="\d+"/);
});

test('a recap, not an ad: branding only, no pitch, no borrowed brand words', () => {
  for (const b of [withModels(), computeBill([{ id: 'openai', monthly_usd: 50 }])]) {
    const d = recapData(b, { now: NOW });
    const c = cards(d);
    const all = [...c.story, c.wide].map((x) => x.svg).join('') + postText(d);
    const words = all.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    assert.match(words, /ernd\.ai/);
    assert.doesNotMatch(words, /back a year|% back|% at|annual fee|request|credit card|npx|make yours/i);
    assert.doesNotMatch(postText(d), /ernd/);
    assert.doesNotMatch(all, /spotify|\bwrapped\b/i); // our name is tokens-wrapped; never Spotify or "Wrapped" on its own
    assert.doesNotMatch(all, /\bsav(e|es|ing|ings)\b/i);
    assert.doesNotMatch(all, /[—–]/);
  }
});

test('fit shrinks long numbers', () => {
  assert.equal(fit('$1', 900, 260), 260);
  assert.ok(fit('$1,000,000,000', 900, 260) < 120);
});

test('page loads nothing from the network', () => {
  const html = page(recapData(withModels(), { now: NOW }));
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+href=/i);
  assert.doesNotMatch(html, /@import|url\(\s*['"]?https?:/i);
  const urls = html.match(/https?:\/\/[^\s"'<)]+/g) || [];
  for (const u of urls) {
    assert.ok(u.startsWith('http://www.w3.org/') || u.startsWith('https://x.com/intent/post') || u === 'https://tokenswrapped.com/api/card' || u.startsWith('https://tokenswrapped.com'), u);
  }
  // The only request the page can make is the card upload, and only from the Post on X click handler.
  assert.equal((html.match(/\bfetch\(/g) || []).length, 1);
  assert.match(html, /xBtn\.onclick=async\(\)=>\{[\s\S]*fetch\(UPLOAD,\{method:'POST',headers:\{'content-type':'image\/png'\},body:card/);
  assert.equal((html.match(/<template /g) || []).length, 6);
});

test('esc', () => {
  assert.equal(esc(`a<b>&"'`), 'a&lt;b&gt;&amp;&quot;&#39;');
});

test('writeShare never overwrites', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokens-wrapped-test-'));
  try {
    writeShare(manual(), { now: NOW, dir });
    assert.throws(() => writeShare(manual(), { now: NOW, dir }), /EEXIST/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function runShare({ tty }) {
  const dir = mkdtempSync(join(tmpdir(), 'tokens-wrapped-test-'));
  const opened = [];
  const stdout = sink({ isTTY: tty, columns: 80 });
  const stderr = sink({ isTTY: tty });
  const code = await main({
    home: EMPTY_HOME,
    argv: ['--openai', '10000', '--wafer', '2000', '--share'],
    env: {},
    stdout,
    stderr,
    stdin: { isTTY: tty },
    fetch: () => {
      throw new Error('network');
    },
    now: NOW,
    openFile: (f) => opened.push(f),
    shareDir: dir,
  });
  return { code, out: stdout.text, err: stderr.text, opened, dir };
}

test('--share on a terminal: writes the page, prints it, opens it', async () => {
  const r = await runShare({ tty: true });
  try {
    assert.equal(r.code, 0);
    assert.deepEqual(readdirSync(r.dir), ['year-in-ai.html']);
    assert.match(r.out, /Your year in AI: file:\/\/.*year-in-ai\.html/);
    assert.equal(r.opened.length, 1);
    assert.match(readFileSync(r.opened[0], 'utf8'), /\$144,000/);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test('--share piped: path on stderr, browser not opened', async () => {
  const r = await runShare({ tty: false });
  try {
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.out, /year-in-ai/);
    assert.match(r.err, /Your year in AI: file:\/\//);
    assert.equal(r.opened.length, 0);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});
