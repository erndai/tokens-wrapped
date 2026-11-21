// Reads a long list of logs on several threads, then merges what each found. Same reader code and rules; this
// only splits the work. Used for Claude Code and Codex, whose logs can run to many GB. A unit is a list of files
// that must be read together (Claude Code: one project folder, since copies of a line stay inside it).
// Read-only like every reader: a worker opens files for reading and sends numbers back.

import { Worker } from 'node:worker_threads';
import * as os from 'node:os';
import { statSync } from 'node:fs';
import { mergeInto } from './tally.js';

export function groupBy(list, keyOf) {
  const m = new Map();
  for (const x of list) {
    const k = keyOf(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return [...m.values()];
}

const sizeOf = (f) => {
  try {
    return statSync(f).size;
  } catch {
    return 0;
  }
};

// Biggest units first, each to the lightest batch: batches end up close in size.
export function balance(units, n) {
  const batches = Array.from({ length: n }, () => ({ bytes: 0, files: [] }));
  const sized = units.map((u) => ({ u, bytes: u.reduce((a, f) => a + sizeOf(f), 0) })).sort((a, b) => b.bytes - a.bytes);
  for (const { u, bytes } of sized) {
    const b = batches.reduce((a, x) => (x.bytes < a.bytes ? x : a));
    b.bytes += bytes;
    b.files.push(...u);
  }
  return batches.filter((b) => b.files.length).map((b) => b.files);
}

const cores = () => (typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length || 1);

export function threadCount(files, cpus = cores()) {
  if (files < 40) return 1;
  return Math.max(1, Math.min(cpus - 1, 12, Math.ceil(files / 20)));
}

// What the loading screen needs while threads run: running token totals and tokens by day.
function snapshot(t) {
  return { tokens: { input: t.tokens.input, output: t.tokens.output }, days: [...t.days] };
}

export async function readSplit({ reader, units, win, name, unit, progress = () => {}, empty }) {
  const total = units.reduce((a, u) => a + u.length, 0);
  const n = threadCount(total);
  const mod = await import(reader);
  const inline = async () =>
    mod.readList(units.flat(), win, async (i, t) => {
      progress(`${name}: ${i} of ${total} ${unit}`, { i, n: total, t });
      await new Promise((r) => setImmediate(r)); // let the loading screen draw
    });
  if (n === 1) return inline();

  const batches = balance(units, n);
  const done = new Array(batches.length).fill(0);
  const snaps = new Array(batches.length).fill(null);
  const live = { ...empty(), days: new Map() };
  const report = () => {
    live.tokens = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 };
    live.days = new Map();
    for (const s of snaps) {
      if (!s) continue;
      live.tokens.input += s.tokens.input;
      live.tokens.output += s.tokens.output;
      for (const [d, v] of s.days) live.days.set(d, (live.days.get(d) || 0) + v);
    }
    const i = done.reduce((a, b) => a + b, 0);
    progress(`${name}: ${i} of ${total} ${unit}`, { i, n: total, t: live });
  };
  try {
    const parts = await Promise.all(
      batches.map(
        (files, k) =>
          new Promise((resolve, reject) => {
            const w = new Worker(new URL('./worker.js', import.meta.url), { workerData: { reader, files, win } });
            w.on('message', (m) => {
              if (m.type === 'tick') {
                done[k] = m.i;
                snaps[k] = m.snap;
                report();
              } else if (m.type === 'done') resolve(m.t);
            });
            w.on('error', reject);
            w.on('exit', (code) => code && reject(new Error(`worker exited ${code}`)));
          }),
      ),
    );
    const t = empty();
    for (const p of parts) mergeInto(t, p);
    return t;
  } catch {
    return inline(); // threads unavailable or failed: read on this one
  }
}

export { snapshot };
