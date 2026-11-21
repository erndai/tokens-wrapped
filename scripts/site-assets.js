#!/usr/bin/env node
// Builds the website's sample recap (made-up numbers): site/cards/*.svg for the hero, and site/demo.html.
//   node scripts/site-assets.js
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recapData, cards, page } from '../src/share.js';
import { sampleSummary, SAMPLE_VALUE } from './sample.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'site');

const usage = sampleSummary();
const value = SAMPLE_VALUE;
const d = recapData({ usage, value });
const c = cards(d);
mkdirSync(join(out, 'cards'), { recursive: true });
const ids = [];
for (const x of c.story) {
  writeFileSync(join(out, 'cards', `${x.id}.svg`), x.svg);
  ids.push(x.id);
}
writeFileSync(join(out, 'cards', 'order.json'), JSON.stringify(ids));
let demo = page(d)
  .replace('<title>Your year in AI</title>', '<title>tokens-wrapped sample</title><meta name="robots" content="noindex">')
  .replace(/<p class="note">[^<]*<\/p>/, '<p class="note">A sample with made-up numbers. Run <code>npx -y tokens-wrapped</code> for yours.</p>');
writeFileSync(join(out, 'demo.html'), demo);
console.log('cards:', ids.join(' '));
