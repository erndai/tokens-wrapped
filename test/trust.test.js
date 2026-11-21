// The promises in SECURITY.md, checked on every run. If one of these fails, the docs are wrong or the code is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
function files(dir) {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : [],
  );
}
const code = [...files('src'), ...files('bin')].map((f) => ({ f, s: readFileSync(join(root, f), 'utf8') }));

test('no dependencies at all', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const k of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies']) {
    assert.ok(!pkg[k] || !Object.keys(pkg[k]).length, `${k} must be empty`);
  }
  assert.ok(!pkg.scripts?.preinstall && !pkg.scripts?.install && !pkg.scripts?.postinstall, 'no install scripts');
});

test('no network code: the only request anywhere is the recap page uploading a card on Post on X', () => {
  const callers = code.filter(({ s }) => /\bfetch\s*\(/.test(s.replace(/\/\/.*$/gm, ''))).map((c) => c.f);
  // share.js builds the recap page; its one fetch runs in the browser, only when "Post on X" is clicked.
  assert.deepEqual(callers, ['src/share.js']);
  const share = readFileSync(join(root, 'src/share.js'), 'utf8');
  assert.equal((share.match(/\bfetch\(/g) || []).length, 1);
  assert.match(share, /CARD_UPLOAD_URL = 'https:\/\/tokenswrapped\.com\/api\/card'/);
  for (const { f, s } of code) {
    assert.doesNotMatch(s, /node:(http|https|net|tls|dgram|dns)\b|from '(http|https|net|tls|dgram|dns)'/, f);
    assert.doesNotMatch(s, /XMLHttpRequest|WebSocket|sendBeacon/, f);
  }
});

test('only the recap page is written to disk, and only share.js opens a browser', () => {
  // Local readers may only import read functions from fs; nothing but share.js writes or spawns.
  const READ_ONLY = new Set(['readFileSync', 'readdirSync', 'existsSync', 'statSync', 'lstatSync', 'realpathSync', 'createReadStream', 'readFile', 'readdir', 'stat']);
  for (const { f, s } of code) {
    for (const m of s.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(?:node:)?fs(?:\/promises)?'/g)) {
      const names = m[1].split(',').map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      if (f !== 'src/share.js') for (const n of names) assert.ok(READ_ONLY.has(n), `${f} imports fs.${n}`);
    }
    assert.doesNotMatch(s, /import\s+\*\s+as\s+\w+\s+from\s+'(?:node:)?fs/, `${f} imports all of fs`);
    if (/child_process/.test(s)) assert.equal(f, 'src/share.js', `${f} uses child_process`);
  }
  // SQLite databases are opened read-only.
  assert.match(readFileSync(join(root, 'src/local/sqlite.js'), 'utf8'), /readOnly: true/);
  const share = readFileSync(join(root, 'src/share.js'), 'utf8');
  assert.equal((share.match(/writeFileSync\(/g) || []).length, 1);
});
