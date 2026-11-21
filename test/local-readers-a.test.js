// Local readers for Pi, Gemini CLI, Qwen Code, Copilot CLI, Droid and Kimi CLI, against tiny synthetic logs
// written to a temp folder. Every fixture carries SECRET in prompts, replies and tool inputs; it must never
// reach the tally.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import * as pi from '../src/local/pi.js';
import * as gemini from '../src/local/gemini.js';
import * as qwen from '../src/local/qwen.js';
import * as copilot from '../src/local/copilot.js';
import * as droid from '../src/local/droid.js';
import * as kimi from '../src/local/kimi.js';

const SECRET = 'PRIVATE-PROMPT-zebra-42';
const WIN = { start: new Date(2026, 0, 1), end: new Date(2027, 0, 1) };
const IN = new Date('2026-06-15T12:00:00Z'); // file times inside the window
const OLD = new Date('2025-06-15T12:00:00Z');

// Writes { 'rel/path': content } under a fresh temp home. Arrays become JSONL. Returns the home.
function tree(files, mtimes = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tw-readers-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    const text = Array.isArray(content)
      ? content.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n') + '\n'
      : typeof content === 'string'
        ? content
        : JSON.stringify(content);
    writeFileSync(p, text);
    const t = mtimes[rel] || IN;
    utimesSync(p, t, t);
  }
  return root;
}

const plain = (t) => JSON.stringify(t, (k, v) => (v instanceof Set || v instanceof Map ? [...v] : v));
function noSecret(t) {
  assert.ok(!plain(t).includes(SECRET), 'prompt or reply text leaked into the tally');
  assert.ok(!plain(t).includes('zebra'), 'prompt text leaked into the tally');
}
const toks = (t) => ({ ...t.tokens });

test('every reader returns null when its agent is not installed', async () => {
  const home = tree({});
  for (const r of [pi, gemini, qwen, copilot, droid, kimi]) {
    assert.equal(await r.read({ home, env: {}, win: WIN }), null, r.NAME);
    assert.equal(typeof r.id, 'string');
    assert.equal(typeof r.NAME, 'string');
  }
});

// ---------- Pi ----------

const piMsg = (id, ts, message) => ({ type: 'message', id, parentId: null, timestamp: ts, message });
const piReply = (id, ts, responseId, usage, content = []) =>
  piMsg(id, ts, { role: 'assistant', model: 'claude-sonnet-4-5', provider: 'anthropic', responseId, content, usage, stopReason: 'stop' });
const PI_U1 = piMsg('u1', '2026-06-01T10:00:01.000Z', { role: 'user', content: [{ type: 'text', text: SECRET }] });
const PI_A1 = piReply(
  'a1',
  '2026-06-01T10:00:05.000Z',
  'msg_1',
  { input: 100, output: 50, cacheRead: 1000, cacheWrite: 200, cacheWrite1h: 50, reasoning: 10, totalTokens: 1350, cost: { total: 0.5 } },
  [
    { type: 'text', text: SECRET },
    { type: 'toolCall', id: 't1', name: 'edit', arguments: { path: 'src/a.ts', edits: [{ oldText: SECRET, newText: 'one\ntwo' }] } },
    { type: 'toolCall', id: 't2', name: 'write', arguments: { path: 'notes.md', content: 'l1\nl2\nl3' } },
    { type: 'toolCall', id: 't3', name: 'bash', arguments: { command: `echo ${SECRET}` } },
  ],
);

test('Pi: cache folded into input, forks and subagent artifacts not double counted, window respected', async () => {
  const dir = '.pi/agent/sessions/--work-pi--';
  const home = tree({
    [`${dir}/2026-06-01T10-00-00-000Z_aaa.jsonl`]: [
      { type: 'session', version: 3, id: 'aaa', timestamp: '2026-06-01T10:00:00.000Z', cwd: '/work/pi' },
      PI_U1,
      PI_A1,
      piMsg('r1', '2026-06-01T10:00:06.000Z', { role: 'toolResult', content: [{ type: 'text', text: SECRET }] }),
      piReply('a0', '2025-06-01T10:00:00.000Z', 'msg_old', { input: 999999, output: 1, cacheRead: 0, cacheWrite: 0 }),
    ],
    // A fork copies the parent's entries verbatim, then adds its own.
    [`${dir}/2026-06-02T10-00-00-000Z_bbb.jsonl`]: [
      { type: 'session', version: 3, id: 'bbb', timestamp: '2026-06-02T10:00:00.000Z', cwd: '/work/pi', parentSession: 'x' },
      PI_U1,
      PI_A1,
      piReply('a2', '2026-06-02T10:00:05.000Z', 'msg_2', { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }),
    ],
    [`${dir}/subagent-artifacts/run/debug.jsonl`]: [piReply('s1', '2026-06-01T11:00:00.000Z', 'msg_3', { input: 5000, output: 5000 })],
  });
  const t = await pi.read({ home, env: {}, win: WIN });
  assert.equal(t.id, 'pi');
  assert.equal(t.name, 'Pi');
  assert.deepEqual(toks(t), { input: 1310, cached: 1000, cacheWrite: 200, output: 55, reasoning: 10 });
  assert.equal(t.replies, 2);
  assert.equal(t.prompts, 1);
  assert.equal(t.cost, 0.5);
  assert.equal(t.byModel.get('claude-sonnet-4-5').cacheWrite1h, 50);
  assert.equal(t.tools.get('edit'), 1);
  assert.equal(t.tools.get('write'), 1);
  assert.equal(t.lines, 5);
  assert.equal(t.projects.size, 1);
  assert.deepEqual([...t.sessions].sort(), ['aaa', 'bbb']);
  noSecret(t);
});

test('Pi: honors PI_CODING_AGENT_SESSION_DIR and PI_CODING_AGENT_DIR', async () => {
  const home = tree({
    'elsewhere/s/2026-06-01T10-00-00-000Z_c.jsonl': [piReply('a', '2026-06-01T10:00:00.000Z', 'r-a', { input: 1, output: 1 })],
    'agent2/sessions/p/2026-06-01T10-00-00-000Z_d.jsonl': [piReply('b', '2026-06-01T10:00:00.000Z', 'r-b', { input: 2, output: 2 })],
  });
  const t = await pi.read({ home, env: { PI_CODING_AGENT_SESSION_DIR: join(home, 'elsewhere'), PI_CODING_AGENT_DIR: join(home, 'agent2') }, win: WIN });
  assert.equal(t.replies, 2);
  assert.equal(t.tokens.input, 3);
});

// ---------- Gemini CLI ----------

const gUser = (id, ts) => ({ id, timestamp: ts, type: 'user', content: [{ text: SECRET }] });
const G_M2_FINAL = {
  id: 'm2',
  timestamp: '2026-06-01T10:00:05.000Z',
  type: 'gemini',
  content: SECRET,
  model: 'gemini-2.5-pro',
  thoughts: [{ subject: SECRET, description: SECRET }],
  tokens: { input: 1000, output: 100, cached: 400, thoughts: 50, tool: 0, total: 1150 },
  toolCalls: [
    { id: 'c1', name: 'replace', args: { file_path: '/w/a.py', old_string: SECRET, new_string: 'a\nb' }, status: 'success' },
    { id: 'c2', name: 'write_file', args: { file_path: '/w/n.txt', content: 'x' }, status: 'error' },
  ],
};

test('Gemini CLI: last copy per id wins, $rewindTo drops later messages, legacy .json deduped, window respected', async () => {
  const home = tree({
    '.gemini/tmp/proj1/chats/session-2026-06-01T10-00-abc.jsonl': [
      { sessionId: 'g1', projectHash: 'proj1', startTime: '2026-06-01T10:00:00.000Z', lastUpdated: '2026-06-01T10:00:00.000Z', kind: 'main' },
      gUser('m1', '2026-06-01T10:00:00.000Z'),
      { id: 'm2', timestamp: '2026-06-01T10:00:05.000Z', type: 'gemini', content: SECRET, model: 'gemini-2.5-pro' },
      G_M2_FINAL,
      { $set: { lastUpdated: '2026-06-01T10:00:06.000Z' } },
      { $patch: { id: 'm2', content: SECRET } },
      gUser('m3', '2026-06-01T10:01:00.000Z'),
      { id: 'm4', timestamp: '2026-06-01T10:01:05.000Z', type: 'gemini', model: 'gemini-2.5-pro', tokens: { input: 5000, output: 500, cached: 0, thoughts: 0, total: 5500 } },
      { $rewindTo: 'm3' },
      { id: 'm5', timestamp: '2025-06-01T10:00:00.000Z', type: 'gemini', model: 'gemini-2.5-pro', tokens: { input: 7777, output: 1 } },
    ],
    // The pre-JSONL copy of the same session, left behind after conversion.
    '.gemini/tmp/proj1/chats/session-2026-06-01T10-00-abc.json': { sessionId: 'g1', projectHash: 'proj1', messages: [gUser('m1', '2026-06-01T10:00:00.000Z'), G_M2_FINAL] },
    '.gemini/tmp/proj2/chats/session-old.json': {
      sessionId: 'g2',
      projectHash: 'proj2',
      messages: [
        gUser('x1', '2026-03-01T09:00:00.000Z'),
        { id: 'x2', timestamp: '2026-03-01T09:00:02.000Z', type: 'gemini', model: 'gemini-2.5-flash', tokens: { input: 10, output: 5, cached: 0, thoughts: 0, tool: 0, total: 15 } },
      ],
    },
  });
  const t = await gemini.read({ home, env: {}, win: WIN });
  assert.equal(t.id, 'gemini-cli');
  assert.deepEqual(toks(t), { input: 1010, cached: 400, cacheWrite: 0, output: 155, reasoning: 50 });
  assert.equal(t.replies, 2);
  assert.equal(t.prompts, 2);
  assert.equal(t.tools.get('replace'), 1);
  assert.equal(t.tools.get('write_file'), 1);
  assert.equal(t.lines, 2); // the failed write_file adds nothing
  assert.equal(t.projects.size, 2);
  noSecret(t);
});

test('Gemini CLI: cached kept apart from input is folded back in; GEMINI_CLI_HOME is honored', async () => {
  assert.deepEqual(gemini.tokensOf({ input: 600, cached: 400, output: 100, thoughts: 50, tool: 0, total: 1150 }), { input: 1000, cached: 400, output: 150, reasoning: 50 });
  assert.deepEqual(gemini.tokensOf({ input: 1000, cached: 400, output: 100, thoughts: 50, tool: 20, total: 1170 }), { input: 1020, cached: 400, output: 150, reasoning: 50 });
  const home = tree({ 'alt/.gemini/tmp/p/chats/session-1.jsonl': [{ id: 'a', timestamp: '2026-06-01T10:00:00.000Z', type: 'gemini', tokens: { input: 3, output: 2 } }] });
  const t = await gemini.read({ home: join(home, 'nope'), env: { GEMINI_CLI_HOME: join(home, 'alt') }, win: WIN });
  assert.equal(t.tokens.input, 3);
});

// ---------- Qwen Code ----------

const qRec = (uuid, ts, extra) => ({ uuid, parentUuid: null, sessionId: 's1', timestamp: ts, cwd: '/w/q', version: '0.5.0', ...extra });
const Q_REPLY = qRec('q2', '2026-06-01T10:00:05.000Z', {
  type: 'assistant',
  model: 'qwen3-coder-plus',
  message: { role: 'model', parts: [{ text: SECRET }, { functionCall: { id: 'f1', name: 'edit', args: { file_path: '/w/q/a.js', old_string: SECRET, new_string: '1\n2\n3' } } }] },
  usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 600, candidatesTokenCount: 80, thoughtsTokenCount: 20, totalTokenCount: 1100 },
});

test('Qwen Code: output from total minus prompt, archive copies deduped on uuid, window respected', async () => {
  const home = tree({
    '.qwen/projects/-w-q/chats/s1.jsonl': [
      qRec('q1', '2026-06-01T10:00:00.000Z', { type: 'user', message: { role: 'user', parts: [{ text: SECRET }] } }),
      qRec('q1b', '2026-06-01T10:00:01.000Z', { type: 'user', subtype: 'slash_command', message: { role: 'user', parts: [{ text: SECRET }] } }),
      Q_REPLY,
      qRec('q3', '2026-06-01T10:00:09.000Z', { type: 'assistant', model: 'qwen3-coder-plus', usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 30, thoughtsTokenCount: 10 } }),
      qRec('q4', '2025-06-01T10:00:00.000Z', { type: 'assistant', model: 'qwen3-coder-plus', usageMetadata: { promptTokenCount: 99999, totalTokenCount: 100000 } }),
      qRec('q5', '2026-06-01T10:00:10.000Z', { type: 'tool_result', message: { parts: [{ text: SECRET }] } }),
    ],
    '.qwen/projects/-w-q/chats/archive/s1.jsonl': [Q_REPLY],
  });
  const t = await qwen.read({ home, env: {}, win: WIN });
  assert.equal(t.id, 'qwen-code');
  assert.deepEqual(toks(t), { input: 1200, cached: 600, cacheWrite: 0, output: 140, reasoning: 30 });
  assert.equal(t.replies, 2);
  assert.equal(t.prompts, 1);
  assert.equal(t.tools.get('edit'), 1);
  assert.equal(t.lines, 3);
  assert.equal(t.projects.size, 1);
  noSecret(t);
});

test('Qwen Code: QWEN_HOME and QWEN_RUNTIME_DIR are both scanned', async () => {
  const rec = (uuid) => [qRec(uuid, '2026-06-01T10:00:00.000Z', { type: 'assistant', usageMetadata: { promptTokenCount: 5, totalTokenCount: 7 } })];
  const home = tree({ 'qh/projects/p/chats/a.jsonl': rec('h1'), 'qr/projects/p/chats/b.jsonl': rec('r1') });
  const t = await qwen.read({ home, env: { QWEN_HOME: join(home, 'qh'), QWEN_RUNTIME_DIR: join(home, 'qr') }, win: WIN });
  assert.equal(t.replies, 2);
  assert.equal(t.tokens.output, 4);
});

// ---------- Copilot CLI ----------

const cEv = (type, id, ts, data) => ({ type, id, timestamp: ts, parentId: null, data });
const RECEIPT_1 = cEv('session.usage_record', 'rec-1', '2026-06-01T10:00:05.000Z', {
  usage: {
    model: 'claude-sonnet-4.6-1m',
    interactionType: 'conversation-agent',
    inputTokens: 1200,
    outputTokens: 80,
    cacheReadTokens: 1000,
    cacheWriteTokens: 100,
    reasoningTokens: 20,
    accounting: { sourceSessionId: 'sess-r', sequence: 1, usageId: 'call-1' },
  },
});

test('Copilot CLI: receipts once per (session, sequence), cumulative shutdowns as deltas, window respected', async () => {
  const bigShutdown = { modelMetrics: { 'claude-sonnet-4.6': { usage: { inputTokens: 999999, outputTokens: 999999 }, requests: { count: 99 } } } };
  const home = tree({
    '.copilot/session-state/sess-r/events.jsonl': [
      cEv('session.start', 's0', '2026-06-01T10:00:00.000Z', { sessionId: 'sess-r', context: { cwd: '/w/c' } }),
      cEv('user.message', 'u1', '2026-06-01T10:00:01.000Z', { content: SECRET, transformedContent: SECRET }),
      cEv('tool.execution_start', 't1', '2026-06-01T10:00:02.000Z', { toolCallId: 'tc1', toolName: 'edit', arguments: { path: '/w/c/x.go', old_str: SECRET, new_str: 'a\nb' } }),
      cEv('tool.execution_complete', 't2', '2026-06-01T10:00:03.000Z', { toolCallId: 'tc1', success: true, result: { content: SECRET } }),
      RECEIPT_1,
      cEv('session.usage_record', 'rec-2', '2026-06-01T10:05:00.000Z', {
        usage: { model: 'gpt-5.4', tokens: { inputTokens: 300, outputTokens: 40, cacheReadTokens: 200, cacheWriteTokens: 0, reasoningTokens: 0 }, accounting: { sourceSessionId: 'sess-r', sequence: 2 } },
      }),
      cEv('session.shutdown', 'sd', '2026-06-01T11:00:00.000Z', bigShutdown), // totals the receipts: ignored
    ],
    // The same receipt copied into another session's log.
    '.copilot/session-state/sess-copy/events.jsonl': [RECEIPT_1],
    // An older session with no receipts: cumulative shutdown snapshots only.
    '.copilot/session-state/sess-s/events.jsonl': [
      cEv('session.start', 's0', '2025-12-30T10:00:00.000Z', { sessionId: 'sess-s', context: { cwd: '/w/s' } }),
      cEv('session.shutdown', 'sd1', '2025-12-30T11:00:00.000Z', {
        modelMetrics: { 'gpt-5': { usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 20, reasoningTokens: 5 }, requests: { count: 1 } } },
      }),
      cEv('session.shutdown', 'sd2', '2026-06-03T11:00:00.000Z', {
        modelMetrics: { 'gpt-5': { usage: { inputTokens: 200, outputTokens: 80, cacheReadTokens: 20, cacheWriteTokens: 30, reasoningTokens: 10 }, requests: { count: 3 } } },
      }),
    ],
  });
  const t = await copilot.read({ home, env: {}, win: WIN });
  assert.equal(t.id, 'copilot-cli');
  assert.equal(t.name, 'Copilot CLI');
  // receipts 1500/1200/100/120/20 + the 2026 shutdown's growth 100/10/10/30/5
  assert.deepEqual(toks(t), { input: 1600, cached: 1210, cacheWrite: 110, output: 150, reasoning: 25 });
  assert.equal(t.replies, 4); // 2 receipts + 2 calls in the shutdown interval
  assert.ok(t.models.has('claude-sonnet-4.6'));
  assert.ok(!t.models.has('claude-sonnet-4.6-1m'));
  assert.equal(t.prompts, 1);
  assert.equal(t.tools.get('edit'), 1);
  assert.equal(t.lines, 2);
  assert.equal(t.projects.size, 2);
  noSecret(t);
});

test('Copilot CLI: shutdowns before the first receipt still count, later ones do not', async () => {
  const home = tree({
    'cop/session-state/m/events.jsonl': [
      cEv('session.shutdown', 'sd1', '2026-02-07T09:00:00.000Z', { modelMetrics: { 'claude-sonnet-4.6': { usage: { inputTokens: 500, outputTokens: 40, cacheReadTokens: 300, cacheWriteTokens: 100 }, requests: { count: 2 } } } }),
      cEv('session.usage_record', 'r1', '2026-02-08T23:00:00.000Z', {
        usage: { model: 'claude-sonnet-4.6', inputTokens: 250, outputTokens: 30, cacheReadTokens: 200, cacheWriteTokens: 0, accounting: { sourceSessionId: 'm', sequence: 1 } },
      }),
      cEv('session.shutdown', 'sd2', '2026-02-09T01:00:00.000Z', {
        usageAccountingWatermarks: { m: 1 },
        modelMetrics: { 'claude-sonnet-4.6': { usage: { inputTokens: 750, outputTokens: 70, cacheReadTokens: 500, cacheWriteTokens: 100 }, requests: { count: 3 } } },
      }),
    ],
  });
  const t = await copilot.read({ home, env: { COPILOT_HOME: join(home, 'cop') }, win: WIN });
  assert.equal(t.tokens.input, 750);
  assert.equal(t.tokens.output, 70);
  assert.equal(t.replies, 3);
});

// ---------- Droid ----------

test('Droid: one cumulative entry per session, cache and thinking normalized, dated by file time, window respected', async () => {
  const home = tree(
    {
      '.factory/sessions/-w-d/abc.settings.json': {
        model: 'custom:Claude-Opus-4 [Anthropic]',
        providerLock: 'anthropic',
        providerLockTimestamp: '2026-06-01T10:00:00.000Z',
        tokenUsage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 200, cacheReadTokens: 1000, thinkingTokens: 25 },
      },
      '.factory/sessions/-w-d/abc.jsonl': [{ type: 'message', message: { role: 'user', content: [{ type: 'text', text: SECRET }] } }],
      '.factory/sessions/-w-d/old.settings.json': {
        model: 'gpt-5',
        providerLockTimestamp: '2025-06-01T10:00:00.000Z',
        tokenUsage: { inputTokens: 99999, outputTokens: 99999 },
      },
    },
    { '.factory/sessions/-w-d/old.settings.json': OLD },
  );
  const t = await droid.read({ home, env: {}, win: WIN });
  assert.equal(t.id, 'droid');
  assert.equal(t.name, 'Droid');
  assert.deepEqual(toks(t), { input: 1300, cached: 1000, cacheWrite: 200, output: 75, reasoning: 25 });
  assert.equal(t.replies, 1);
  assert.deepEqual([...t.sessions], ['abc']);
  assert.deepEqual([...t.models.keys()], ['Claude-Opus-4']);
  assert.equal(t.days.size, 1);
  assert.ok(t.days.has(`${IN.getFullYear()}-${String(IN.getMonth() + 1).padStart(2, '0')}-${String(IN.getDate()).padStart(2, '0')}`));
  noSecret(t);
  // thinking already inside output when the total says so
  assert.equal(droid.tokensOf({ inputTokens: 10, outputTokens: 20, thinkingTokens: 5, totalTokens: 30 }).output, 20);
});

// ---------- Kimi CLI ----------

const kLine = (sec, type, payload) => ({ timestamp: sec, message: { type, payload } });
const T0 = Date.parse('2026-06-01T10:00:00Z') / 1000;

test('Kimi CLI: legacy StatusUpdate and turn usage.record, repeats once, model from config, window respected', async () => {
  const status = kLine(T0 + 2.5, 'StatusUpdate', { token_usage: { input_other: 100, output: 40, input_cache_read: 500, input_cache_creation: 50 }, message_id: 'chatcmpl-1', context_usage: 0.1 });
  const turn = { type: 'usage.record', usageScope: 'turn', model: 'kimi-code/kimi-k2.6', usage: { inputOther: 10, output: 5, inputCacheRead: 20, inputCacheCreation: 0 }, time: T0 * 1000 };
  const home = tree({
    '.kimi/config.toml': 'default_model = "kimi-k2-turbo"\n[models."kimi-k2-turbo"]\nprovider = "moonshot"\n',
    '.kimi/sessions/wd1/sessA/wire.jsonl': [
      { type: 'metadata', protocol_version: '1.3' },
      kLine(T0, 'TurnBegin', { user_input: SECRET }),
      kLine(T0 + 1.25, 'ToolCall', { type: 'function', id: 'c1', function: { name: 'WriteFile', arguments: JSON.stringify({ path: 'a.txt', content: SECRET }) } }),
      status,
      status, // the same step written twice
      kLine(T0 + 3, 'ContentPart', { type: 'text', text: SECRET }),
      kLine(Date.parse('2025-06-01T10:00:00Z') / 1000, 'StatusUpdate', { token_usage: { input_other: 99999, output: 99999 }, message_id: 'old' }),
    ],
    '.kimi-code/sessions/wd2/sessB/agents/main/wire.jsonl': [
      turn,
      turn,
      { type: 'usage.record', usageScope: 'session', model: 'kimi-code/kimi-k2.6', usage: { inputOther: 5000, output: 5000 }, time: T0 * 1000 + 10 },
    ],
  });
  const t = await kimi.read({ home, env: {}, win: WIN });
  assert.equal(t.id, 'kimi-cli');
  assert.deepEqual(toks(t), { input: 680, cached: 520, cacheWrite: 50, output: 45, reasoning: 0 });
  assert.equal(t.replies, 2);
  assert.equal(t.prompts, 1);
  assert.equal(t.tools.get('WriteFile'), 1);
  assert.deepEqual([...t.models.keys()].sort(), ['kimi-k2-turbo', 'kimi-k2.6']);
  assert.deepEqual([...t.sessions].sort(), ['sessA', 'sessB']);
  assert.equal(t.projects.size, 2);
  noSecret(t);
});

test('Kimi CLI: KIMI_SHARE_DIR replaces ~/.kimi', async () => {
  const home = tree({
    'share/sessions/w/s/wire.jsonl': [kLine(T0, 'StatusUpdate', { token_usage: { input_other: 1, output: 2 } })],
  });
  const t = await kimi.read({ home, env: { KIMI_SHARE_DIR: join(home, 'share') }, win: WIN });
  assert.equal(t.tokens.output, 2);
  assert.ok(t.models.has('kimi-for-coding')); // no config: Kimi's default
});
