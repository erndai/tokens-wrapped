// The counting bugs found by checking against ccusage on a heavy user's machine (Nov 2026), each pinned here
// with made-up logs: subagent transcripts, resumed-session copies, partial output lines, compressed and forked
// Codex rollouts, the byte-level line filter, and threaded reading giving the same answer as one thread.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import * as zlib from 'node:zlib';
import * as claude from '../src/local/claude.js';
import * as codex from '../src/local/codex.js';
import { eachLine, canZstd } from '../src/local/tally.js';
import { localYear, summarizeLocal, together, longestSession } from '../src/local/index.js';
import { NOW } from './_helpers.js';

const win = localYear(NOW);
const put = (file, lines) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
};
let n = 0;
const uuid = () => `u-${++n}`;
const reply = (o) => ({
  type: 'assistant', timestamp: o.ts, sessionId: o.session, uuid: o.uuid || uuid(), requestId: o.req, isSidechain: !!o.agent, agentId: o.agent,
  message: { id: o.id, model: 'claude-opus-5-5', content: o.content || [], usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: o.out ?? 50 } },
});
const prompt = (o) => ({ type: 'user', timestamp: o.ts, sessionId: o.session, uuid: o.uuid || uuid(), message: { role: 'user', content: 'hi' } });
const write = (path, lines) => ({ type: 'tool_use', name: 'Write', input: { file_path: path, content: lines } });

test('Claude Code: subagent and workflow transcripts count; journals do not; copies and partial lines count once', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tw-acc-'));
  const proj = join(home, '.claude', 'projects', '-p');
  const p1 = prompt({ ts: '2026-05-01T10:00:00Z', session: 's1' });
  const r1a = reply({ ts: '2026-05-01T10:00:05Z', session: 's1', id: 'm1', req: 'q1', out: 3, content: [{ type: 'thinking' }] }); // partial output
  const r1b = reply({ ts: '2026-05-01T10:00:05Z', session: 's1', id: 'm1', req: 'q1', out: 90, content: [write('/p/a.py', 'a\nb\nc')] }); // final
  put(join(proj, 's1.jsonl'), [p1, r1a, r1b]);
  // A resumed session: the same lines copied in (same uuids), then one new reply.
  put(join(proj, 's2.jsonl'), [p1, r1a, r1b, reply({ ts: '2026-05-02T09:00:00Z', session: 's2', id: 'm2', req: 'q2' })]);
  // A subagent, and a workflow agent one level deeper; a workflow journal that must be ignored.
  put(join(proj, 's1', 'subagents', 'agent-x.jsonl'), [reply({ ts: '2026-05-01T10:00:20Z', session: 's1', agent: 'x', id: 'm3', req: 'q3' })]);
  put(join(proj, 's1', 'subagents', 'workflows', 'wf_1', 'agent-y.jsonl'), [reply({ ts: '2026-05-01T10:00:30Z', session: 's1', agent: 'y', id: 'm4', req: 'q4' })]);
  put(join(proj, 's1', 'subagents', 'workflows', 'wf_1', 'journal.jsonl'), [reply({ ts: '2026-05-01T10:00:40Z', session: 's1', id: 'jj', req: 'jj', out: 9999 })]);
  const t = await claude.read({ home, env: {}, win });
  assert.equal(t.replies, 4); // m1, m2, m3, m4
  assert.equal(t.tokens.output, 90 + 50 * 3); // m1's final count, not its partial one
  assert.equal(t.prompts, 1); // the copied prompt is the same line
  assert.equal(t.lines, 3); // the copied Write is the same line
  assert.equal(t.tools.get('Write'), 1);
  assert.equal(t.lanes.size, 4); // s1, s2, and the two subagents, each its own agent
});

test('Claude Code: the most actions between two of your messages', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tw-acc-'));
  const f = join(home, '.claude', 'projects', '-p', 's.jsonl');
  const bash = { type: 'tool_use', name: 'Bash', input: {} };
  const lines = [prompt({ ts: '2026-05-01T10:00:00Z', session: 's' })];
  for (let i = 0; i < 30; i++) lines.push(reply({ ts: `2026-05-01T10:${String(i * 2 + 1).padStart(2, '0')}:00Z`, session: 's', id: `a${i}`, req: `a${i}`, content: [bash] }));
  lines.push(prompt({ ts: '2026-05-01T11:10:00Z', session: 's' }));
  for (let i = 0; i < 5; i++) lines.push(reply({ ts: `2026-05-01T11:1${i + 1}:00Z`, session: 's', id: `b${i}`, req: `b${i}`, content: [bash] }));
  put(f, lines);
  const t = await claude.read({ home, env: {}, win });
  assert.equal(t.leash.actions, 30);
  const s = summarizeLocal([t], win);
  assert.deepEqual(s.leash, { actions: 30, date: '2026-05-01' });
  assert.equal(Math.round(s.longestSession.hours * 60), 74); // replies 10:01 to 11:15, never 30 minutes quiet
});

test('agents at once: distinct agents replying in the same minute', () => {
  const at = (iso) => new Date(iso).getTime();
  const t = { id: 'x', name: 'X', lanes: new Map([['a', [at('2026-05-01T10:00:10Z')]], ['a/sub', [at('2026-05-01T10:00:40Z')]], ['b', [at('2026-05-01T10:00:50Z'), at('2026-05-01T10:05:00Z')]], ['c', [at('2026-05-01T10:01:10Z')]]]) };
  assert.equal(together([t]).agents, 3);
  assert.equal(together([{ ...t, lanes: new Map([['a', [1]]]) }]), null); // one agent is not "at once"
  assert.ok(longestSession([t]) === null); // under an hour
});

test('Codex: compressed and archived rollouts, each once; a fork counts only its own first turn', { skip: !canZstd && 'needs Node 22.15+' }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'tw-acc-'));
  const base = join(home, '.codex');
  const tc = (ts, total, last) => ({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } } });
  const u = (i, c, o) => ({ input_tokens: i, cached_input_tokens: c, output_tokens: o, reasoning_output_tokens: 0 });
  const ctx = { timestamp: '2026-05-01T10:00:00Z', type: 'turn_context', payload: { model: 'gpt-6-astra' } };
  const plain = (lines) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  const zst = (lines) => zlib.zstdCompressSync(Buffer.from(plain(lines)));
  const write2 = (p, data) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data);
  };
  // A compressed session: two turns, 100 then 50 more input.
  write2(join(base, 'sessions', '2026', '05', '01', 'rollout-a.jsonl.zst'), zst([ctx, tc('2026-05-01T10:00:01Z', u(100, 80, 10), u(100, 80, 10)), tc('2026-05-01T10:00:02Z', u(150, 120, 15), u(50, 40, 5))]));
  // The same rollout also left uncompressed: read once.
  write2(join(base, 'sessions', '2026', '05', '01', 'rollout-a.jsonl'), plain([ctx, tc('2026-05-01T10:00:01Z', u(100, 80, 10), u(100, 80, 10)), tc('2026-05-01T10:00:02Z', u(150, 120, 15), u(50, 40, 5))]));
  // An archived fork: its first total already holds its parent's 1000; only its own 30 counts.
  write2(join(base, 'archived_sessions', 'rollout-b.jsonl.zst'), zst([ctx, tc('2026-05-02T10:00:01Z', u(1030, 900, 103), u(30, 20, 3))]));
  const t = await codex.read({ home, env: {}, win });
  assert.equal(t.tokens.input, 150 + 30);
  assert.equal(t.tokens.output, 15 + 3);
});

test('byte-level line filter: same lines as splitting text, across chunk edges', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-acc-'));
  const lines = [];
  for (let i = 0; i < 3000; i++) lines.push(i % 7 === 0 ? `{"type":"assistant","i":${i},"pad":"${'é'.repeat(i % 900)}"}` : `{"type":"other","i":${i},"pad":"${'x'.repeat(i % 1300)}"}`);
  lines.push(`{"type":"assistant","big":"${'z'.repeat(3_000_000)}"}`); // longer than a read chunk
  const f = join(dir, 'x.jsonl');
  writeFileSync(f, lines.join('\n')); // no trailing newline
  const want = lines.filter((l) => l.includes('"type":"assistant"'));
  const got = [];
  await eachLine(f, (l) => got.push(l), { match: ['"type":"assistant"'] });
  assert.equal(got.length, want.length);
  assert.ok(got.every((l, i) => l === want[i]));
  const all = [];
  await eachLine(f, (l) => all.push(l));
  assert.equal(all.length, lines.length);
});

test('threads: reading on several threads gives the same tally as one', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tw-acc-'));
  for (let p = 0; p < 6; p++) {
    for (let s = 0; s < 10; s++) {
      const shared = reply({ ts: '2026-04-01T10:00:00Z', session: `p${p}s0`, id: `p${p}m0`, req: 'r', uuid: `p${p}-shared` });
      put(join(home, '.claude', 'projects', `-p${p}`, `s${s}.jsonl`), [shared, reply({ ts: `2026-04-0${(s % 9) + 1}T1${p}:00:00Z`, session: `p${p}s${s}`, id: `p${p}m${s + 1}`, req: 'r', out: s + 1 })]);
    }
  }
  const files = claude.files({ home, env: {}, since: win.start });
  assert.equal(files.length, 60); // enough to use threads
  const threaded = await claude.read({ home, env: {}, win });
  const single = await claude.readList(files, win);
  assert.equal(threaded.replies, 6 * 11);
  assert.deepEqual(threaded.tokens, single.tokens);
  assert.deepEqual([...threaded.days].sort(), [...single.days].sort());
});

test('Claude Code: says so when its 30-day cleanup cut the year short', async () => {
  const mk = (settings) => {
    const home = mkdtempSync(join(tmpdir(), 'tw-acc-'));
    put(join(home, '.claude', 'projects', '-p', 's.jsonl'), [reply({ ts: '2026-11-01T10:00:00Z', session: 's', id: 'm', req: 'r' })]);
    if (settings) put(join(home, '.claude', 'settings.json'), [settings]);
    return home;
  };
  const a = await claude.read({ home: mk(null), env: {}, win });
  assert.match(a.notes.join(' '), /keeps 30 days of logs by default, so its numbers start 2026-11-01/);
  const b = await claude.read({ home: mk({ cleanupPeriodDays: 400 }), env: {}, win });
  assert.deepEqual(b.notes, []); // keeps the whole year: a late start is real
});
