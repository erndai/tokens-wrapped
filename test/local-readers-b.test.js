// Local readers for Cursor, Goose, Crush, Kilo Code and the VS Code task extensions (Cline, Roo Code, Kilo).
// Every fixture is synthetic and built in a temp folder; SQLite fixtures need node:sqlite (Node 22.5+).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqliteModule } from '../src/local/sqlite.js';
import * as cursor from '../src/local/cursor.js';
import * as goose from '../src/local/goose.js';
import * as crush from '../src/local/crush.js';
import * as kilo from '../src/local/kilo.js';
import { readers, cline, roo, kiloExt, CACHE_IN_INPUT_SINCE, editorUserDir } from '../src/local/vscode-agents.js';

const WIN = { start: new Date(2026, 0, 1), end: new Date('2026-11-20T15:00:00Z') };
const SECRET = 'SECRET-PROMPT-TEXT';

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tw-readers-b-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function newDb(t, path) {
  const m = await sqliteModule();
  if (!m) return null;
  mkdirSync(join(path, '..'), { recursive: true });
  const db = new m.DatabaseSync(path);
  return db;
}

// Sets and Maps flattened so the whole tally can be searched as text.
function dump(tally) {
  return JSON.stringify(tally, (_, v) => (v instanceof Set ? [...v] : v instanceof Map ? [...v.entries()] : v));
}

const sec = (iso) => Math.floor(new Date(iso).getTime() / 1000);

test('Cursor: tokens unknown, prompts, replies, tools and AI lines counted', async (t) => {
  const home = tmp(t);
  const platform = 'linux';
  const state = cursor.stateDb({ home, env: {}, platform });
  const db = await newDb(t, state);
  if (!db) return t.skip('node:sqlite not available');
  db.exec('create table cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  const put = db.prepare('insert into cursorDiskKV (key, value) values (?, ?)');
  put.run('composerData:c1', JSON.stringify({ composerId: 'c1', createdAt: Date.parse('2026-03-01T10:00:00Z'), modelConfig: { modelName: 'composer-2' }, text: SECRET }));
  const bubble = (b, v) => put.run(`bubbleId:c1:${b}`, JSON.stringify({ tokenCount: { inputTokens: 0, outputTokens: 0 }, requestId: '', ...v }));
  bubble('b0', { type: 2, createdAt: '2026-03-01T10:00:30.000Z', text: 'before any pick' }); // composer model
  bubble('b1', { type: 1, createdAt: '2026-03-01T10:01:00.000Z', text: SECRET, modelInfo: { modelName: 'claude-x' } });
  bubble('b2', { type: 2, createdAt: '2026-03-01T10:01:05.000Z', text: '', thinking: { text: SECRET } }); // thinking only
  bubble('b3', { type: 2, createdAt: '2026-03-01T10:01:10.000Z', text: '', toolFormerData: { name: 'read_file_v2', params: SECRET } });
  bubble('b4', { type: 2, createdAt: '2026-03-01T10:01:20.000Z', text: `reply ${SECRET}` });
  bubble('b5', { type: 2, createdAt: '2026-03-01T10:01:25.000Z', text: '' }); // empty
  bubble('old', { type: 1, createdAt: '2025-12-30T10:00:00.000Z', text: SECRET }); // before the window
  db.close();

  const tdb = await newDb(t, cursor.trackingDb({ home }));
  tdb.exec(`create table scored_commits (commitHash TEXT NOT NULL, branchName TEXT NOT NULL, scoredAt INTEGER NOT NULL,
    linesAdded INTEGER, tabLinesAdded INTEGER, composerLinesAdded INTEGER, commitMessage TEXT, PRIMARY KEY (commitHash, branchName))`);
  const sc = tdb.prepare('insert into scored_commits values (?, ?, ?, ?, ?, ?, ?)');
  sc.run('aaa', 'main', Date.parse('2026-04-01T00:00:00Z'), 40, 5, 10, SECRET);
  sc.run('aaa', 'feature', Date.parse('2026-04-01T00:00:00Z'), 40, 5, 10, SECRET); // same commit, other branch
  sc.run('bbb', 'main', Date.parse('2025-06-01T00:00:00Z'), 99, 99, 99, SECRET); // before the window
  tdb.close();

  const tally = await cursor.read({ home, env: {}, win: WIN, platform });
  assert.equal(tally.id, 'cursor');
  assert.equal(tally.name, 'Cursor');
  assert.equal(tally.tokensKnown, false);
  assert.deepEqual(tally.tokens, { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 });
  for (const b of tally.byModel.values()) assert.equal(b.input + b.cached + b.cacheWrite + b.output, 0);
  assert.equal(tally.prompts, 1);
  // Activity is counted per typed message: assistant bubbles are split into dozens per turn, so they don't count.
  assert.equal(tally.replies, 1);
  assert.equal(tally.lines, 15); // composer 10 + tab 5, once per commit
  assert.equal(tally.tools.get('read_file_v2'), 1);
  assert.deepEqual([...tally.byModel.keys()].sort(), ['claude-x']);
  assert.equal(tally.sessions.size, 1);
  assert.equal([...tally.dayActivity.values()].reduce((a, b) => a + b, 0), 1);
  assert.ok(!dump(tally).includes(SECRET));
});

test('Cursor: user dir per platform', () => {
  const home = '/h';
  assert.equal(cursor.stateDb({ home, platform: 'darwin' }), '/h/Library/Application Support/Cursor/User/globalStorage/state.vscdb');
  assert.equal(cursor.stateDb({ home, platform: 'linux', env: { XDG_CONFIG_HOME: '/x' } }), '/x/Cursor/User/globalStorage/state.vscdb');
  assert.equal(editorUserDir('Cursor', { home, platform: 'win32', env: { APPDATA: '/appdata' } }), join('/appdata', 'Cursor', 'User'));
});

test('Goose: ledger tokens normalized, carried-forward and pre-ledger sessions, window', async (t) => {
  const home = tmp(t);
  const env = { GOOSE_PATH_ROOT: join(home, 'groot') };
  const db = await newDb(t, join(home, 'groot', 'data', 'sessions', 'sessions.db'));
  if (!db) return t.skip('node:sqlite not available');
  db.exec(`create table sessions (id TEXT PRIMARY KEY, name TEXT, working_dir TEXT NOT NULL, created_at TIMESTAMP,
    accumulated_input_tokens INTEGER, accumulated_output_tokens INTEGER, accumulated_cache_read_tokens INTEGER,
    accumulated_cache_write_tokens INTEGER, accumulated_cost REAL, model_config_json TEXT, parent_session_id TEXT);
    create table messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content_json TEXT, created_timestamp INTEGER);
    create table usage_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, created_timestamp INTEGER NOT NULL,
    model TEXT, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, cache_read_tokens INTEGER,
    cache_write_tokens INTEGER, cost REAL, cost_source TEXT, is_compaction INTEGER DEFAULT 0)`);
  const s = db.prepare('insert into sessions values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const mc = JSON.stringify({ model_name: 'gpt-5' });
  s.run('s1', SECRET, '/proj/a', '2026-02-01 09:00:00', 0, 0, 0, 0, 0, mc, null);
  s.run('s1-sub', '', '/proj/a', '2026-02-01 09:05:00', 0, 0, 0, 0, 0, mc, 's1');
  s.run('old', '', '/proj/b', '2026-03-01 09:00:00', 2000, 300, 1500, 0, 0.25, mc, null); // never in the ledger
  const l = db.prepare(`insert into usage_ledger (session_id, created_timestamp, model, input_tokens, output_tokens,
    cache_read_tokens, cache_write_tokens, cost, cost_source) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  l.run('s1', sec('2026-02-01T09:01:00Z'), 'claude-opus', 15007, 50, 5000, 10000, 0.1, 'estimated'); // includes cache
  l.run('s1', sec('2026-02-01T09:02:00Z'), 'claude-opus', 7, 50, 5000, 10000, 0.1, 'estimated'); // excludes cache
  l.run('s1-sub', sec('2026-02-01T09:06:00Z'), 'claude-haiku', 100, 10, 0, 0, 0.01, 'estimated');
  l.run('s1', sec('2025-12-31T09:00:00Z'), 'claude-opus', 1e6, 1e6, 0, 0, 99, 'estimated'); // before the window
  l.run('s1', sec('2026-05-01T00:00:00Z'), null, 400, 40, 0, 0, null, 'carried_forward'); // dated at session start
  const m = db.prepare('insert into messages (session_id, role, content_json, created_timestamp) values (?, ?, ?, ?)');
  m.run('s1', 'user', JSON.stringify([{ type: 'text', text: SECRET }]), sec('2026-02-01T09:00:30Z'));
  m.run('s1', 'assistant', JSON.stringify([{ type: 'text', text: SECRET }, { type: 'toolRequest', id: 'x', toolCall: { status: 'success', value: { name: 'developer__shell', arguments: { command: SECRET } } } }]), sec('2026-02-01T09:01:00Z'));
  m.run('s1', 'user', JSON.stringify([{ type: 'toolResponse', id: 'x', toolResult: { status: 'success', value: SECRET } }]), sec('2026-02-01T09:01:30Z'));
  db.close();

  const tally = await goose.read({ home, env, win: WIN, platform: 'linux' });
  assert.equal(tally.name, 'Goose');
  assert.equal(tally.replies, 5); // two calls + sub-agent + carried forward + pre-ledger session
  assert.equal(tally.tokens.input, 15007 + 15007 + 100 + 400 + 2000); // the old session's 2000 already holds its 1500 cached
  assert.equal(tally.tokens.cached, 5000 + 5000 + 1500);
  assert.equal(tally.tokens.cacheWrite, 20000);
  assert.equal(tally.tokens.output, 50 + 50 + 10 + 40 + 300);
  assert.ok(Math.abs(tally.cost - 0.46) < 1e-9);
  assert.deepEqual([...tally.sessions].sort(), ['old', 's1']); // the sub-agent rolls up to its parent
  assert.equal(tally.byModel.get('gpt-5').input, 400 + 2000); // model from the session when the row has none
  assert.equal(tally.days.get('2026-05-01'), undefined); // carried forward is dated at the session's start
  assert.equal(tally.prompts, 1); // the tool result is not a prompt
  assert.equal(tally.tools.get('developer__shell'), 1);
  assert.equal(tally.projects.size, 2);
  assert.ok(!dump(tally).includes(SECRET));
});

test('Goose: input that already includes cache is left alone', () => {
  assert.deepEqual(goose.normalize({ input_tokens: 15007, output_tokens: 1, cache_read_tokens: 5000, cache_write_tokens: 10000 }), {
    input: 15007, cached: 5000, cacheWrite: 10000, output: 1,
  });
  assert.equal(goose.normalize({ input_tokens: 7, cache_read_tokens: 5000, cache_write_tokens: 10000 }).input, 15007);
  assert.equal(goose.sqlTime('2026-02-01 09:00:00').toISOString(), '2026-02-01T09:00:00.000Z');
});

test('Crush: root-session cost only, replies from messages, tokens unknown', async (t) => {
  const home = tmp(t);
  const proj = join(home, 'work', 'app');
  const env = { CRUSH_GLOBAL_DATA: join(home, 'crushdata') };
  mkdirSync(env.CRUSH_GLOBAL_DATA, { recursive: true });
  writeFileSync(join(env.CRUSH_GLOBAL_DATA, 'projects.json'), JSON.stringify({ projects: [
    { path: proj, data_dir: '.crush', last_accessed: '2026-06-01T00:00:00Z' },
    { path: join(home, 'gone'), data_dir: '.crush' }, // no database: ignored
  ] }));
  const db = await newDb(t, join(proj, '.crush', 'crush.db'));
  if (!db) return t.skip('node:sqlite not available');
  db.exec(`create table sessions (id TEXT PRIMARY KEY, parent_session_id TEXT, title TEXT NOT NULL, message_count INTEGER,
    prompt_tokens INTEGER, completion_tokens INTEGER, cost REAL, updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
    create table messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, parts TEXT NOT NULL default '[]',
    model TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  const s = db.prepare('insert into sessions values (?, ?, ?, 0, ?, ?, ?, ?, ?)');
  s.run('root', null, SECRET, 90000, 4000, 1.5, sec('2026-06-02T12:00:00Z'), sec('2026-06-02T10:00:00Z'));
  s.run('child', 'root', SECRET, 5000, 200, 0.5, sec('2026-06-02T11:00:00Z'), sec('2026-06-02T10:30:00Z')); // cost already in root
  s.run('old', null, SECRET, 1, 1, 9, sec('2025-11-01T12:00:00Z'), sec('2025-11-01T10:00:00Z')); // before the window
  const m = db.prepare('insert into messages values (?, ?, ?, ?, ?, ?, ?)');
  const at = sec('2026-06-02T10:00:10Z');
  m.run('m1', 'root', 'user', JSON.stringify([{ type: 'text', data: { text: SECRET } }]), null, at, at);
  m.run('m2', 'root', 'assistant', JSON.stringify([
    { type: 'text', data: { text: SECRET } },
    { type: 'tool_call', data: { id: 't1', name: 'edit', input: JSON.stringify({ file_path: '/w/app/main.go', old_string: SECRET, new_string: 'a\nb' }) } },
  ]), 'claude-sonnet-4', at + 1, at + 1);
  m.run('m3', 'child', 'user', JSON.stringify([{ type: 'text', data: { text: SECRET } }]), null, at + 2, at + 2);
  m.run('m4', 'child', 'assistant', JSON.stringify([{ type: 'tool_call', data: { name: 'view', input: '{}' } }]), 'claude-haiku', at + 3, at + 3);
  m.run('m5', 'old', 'assistant', '[]', 'x', sec('2025-11-01T10:00:00Z'), 0);
  db.close();

  const tally = await crush.read({ home, env, win: WIN, platform: 'linux' });
  assert.equal(tally.name, 'Crush');
  assert.equal(tally.tokensKnown, false);
  assert.equal(tally.tokens.input + tally.tokens.output, 0); // prompt/completion_tokens are last-step snapshots
  assert.equal(tally.cost, 1.5);
  assert.equal(tally.replies, 2);
  assert.equal(tally.prompts, 1); // the sub-agent's task is not the person's prompt
  assert.equal(tally.sessions.size, 1);
  assert.deepEqual([...tally.byModel.keys()].sort(), ['claude-haiku', 'claude-sonnet-4']);
  assert.equal(tally.tools.get('edit'), 1);
  assert.equal(tally.tools.get('view'), 1);
  assert.equal(tally.lines, 2);
  assert.equal(tally.exts.get('go'), 1);
  assert.ok(!dump(tally).includes(SECRET));
});

test('Crush: global data folder per platform', () => {
  assert.equal(crush.globalDataDir({ home: '/h', platform: 'linux' }), '/h/.local/share/crush');
  assert.equal(crush.globalDataDir({ home: '/h', env: { XDG_DATA_HOME: '/x' }, platform: 'darwin' }), '/x/crush');
  assert.equal(crush.globalDataDir({ home: '/h', env: { LOCALAPPDATA: '/l' }, platform: 'win32' }), join('/l', 'crush'));
});

test('Kilo Code CLI: OpenCode message shape from kilo.db and channel databases', async (t) => {
  const home = tmp(t);
  const dir = join(home, '.local', 'share', 'kilo');
  const msg = (data) => JSON.stringify(data);
  for (const [file, cost] of [['kilo.db', 0.2], ['kilo-dev.db', 0.3]]) {
    const db = await newDb(t, join(dir, file));
    if (!db) return t.skip('node:sqlite not available');
    db.exec('create table message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)');
    const ins = db.prepare('insert into message values (?, ?, ?, ?)');
    const ts = Date.parse('2026-07-01T10:00:00Z');
    ins.run('u', 'ses1', ts, msg({ role: 'user', time: { created: ts }, content: SECRET }));
    ins.run('a', 'ses1', ts + 1, msg({ role: 'assistant', modelID: 'kilo/model', cost, time: { created: ts + 1 },
      tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 300, write: 50 } }, path: { cwd: '/proj' }, text: SECRET }));
    ins.run('o', 'ses1', 1, msg({ role: 'assistant', time: { created: Date.parse('2025-07-01T00:00:00Z') }, tokens: { input: 9 } }));
    db.close();
  }
  const tally = await kilo.read({ home, env: {}, win: WIN });
  assert.equal(tally.id, 'kilo-code');
  assert.equal(tally.id, kiloExt.id);
  assert.equal(tally.name, kiloExt.NAME);
  assert.equal(tally.replies, 2);
  assert.equal(tally.prompts, 2);
  assert.equal(tally.tokens.input, 2 * (100 + 300 + 50));
  assert.equal(tally.tokens.output, 2 * 25);
  assert.ok(Math.abs(tally.cost - 0.5) < 1e-9);
  assert.ok(!dump(tally).includes(SECRET));
  assert.deepEqual(kilo.dbPaths({ home, env: { KILO_DB: 'kilo.db' } }), [join(dir, 'kilo.db'), join(dir, 'kilo-dev.db')]);
});

// ui_messages.json rows for one task, used for Cline, Roo Code and the Kilo extension.
function taskRows() {
  const before = CACHE_IN_INPUT_SINCE - 86400000;
  const after = CACHE_IN_INPUT_SINCE + 86400000;
  const req = (ts, body, extra = {}) => ({ ts, type: 'say', say: 'api_req_started', text: JSON.stringify({ request: SECRET, ...body }), ...extra });
  return [
    { ts: before - 1000, type: 'say', say: 'text', text: SECRET }, // the task
    req(before, { tokensIn: 100, tokensOut: 10, cacheReads: 1000, cacheWrites: 50, cost: 0.01, apiProtocol: 'anthropic' }, { modelInfo: { providerId: 'anthropic', modelId: 'claude-sonnet' } }),
    req(before + 1, { tokensIn: 1100, tokensOut: 10, cacheReads: 1000, cacheWrites: 0, cost: 0.01, apiProtocol: 'openai' }),
    req(after, { tokensIn: 1150, tokensOut: 10, cacheReads: 1000, cacheWrites: 50, cost: 0.01, apiProtocol: 'anthropic' }),
    req(after + 1, { tokensIn: 999999, tokensOut: 1 }, { partial: true }), // still streaming
    { ts: after + 2, type: 'say', say: 'user_feedback', text: SECRET },
    { ts: after + 3, type: 'say', say: 'tool', text: JSON.stringify({ tool: 'appliedDiff', path: 'src/a.ts', diff: SECRET, diffStats: { added: 7, removed: 2 } }) },
    { ts: after + 4, type: 'ask', ask: 'tool', text: JSON.stringify({ tool: 'newFileCreated', path: 'src/b.py', content: `${SECRET}\nx\ny` }) },
    { ts: after + 5, type: 'say', say: 'tool', text: JSON.stringify({ tool: 'readFile', path: 'src/c.ts', content: SECRET }) },
    req(Date.parse('2020-01-01T00:00:00Z'), { tokensIn: 5, tokensOut: 5 }), // outside the window
  ];
}

const WIDE = { start: new Date('2025-01-01T00:00:00Z'), end: new Date('2026-12-31T00:00:00Z') };

async function runTask(t, reader, editor = 'Code') {
  const home = tmp(t);
  const dir = join(editorUserDir(editor, { home, env: {}, platform: 'linux' }), 'globalStorage', reader.extId, 'tasks', 'task-1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ui_messages.json'), JSON.stringify(taskRows()));
  return reader.read({ home, env: {}, win: WIDE, platform: 'linux' });
}

test('Roo Code: cache counted inside tokensIn from the cutoff, and on OpenAI rows before it', async (t) => {
  const tally = await runTask(t, roo, 'Cursor');
  assert.equal(tally.id, 'roo-code');
  assert.equal(tally.name, 'Roo Code');
  assert.equal(tally.replies, 3);
  // before cutoff, anthropic: 100 + 1000 + 50; before cutoff, openai: 1100 as is; after cutoff: 1150 as is
  assert.equal(tally.tokens.input, 1150 + 1100 + 1150);
  assert.equal(tally.tokens.cached, 3000);
  assert.equal(tally.tokens.cacheWrite, 100);
  assert.equal(tally.tokens.output, 30);
  assert.ok(Math.abs(tally.cost - 0.03) < 1e-9);
  assert.equal(tally.prompts, 2);
  assert.equal(tally.lines, 7 + 3);
  assert.equal(tally.files.size, 2);
  assert.equal(tally.tools.get('readFile'), 1);
  assert.equal(tally.byModel.get('claude-sonnet').input, 1150);
  assert.ok(!dump(tally).includes(SECRET));
});

test('Cline: tokensIn never includes cache', async (t) => {
  const tally = await runTask(t, cline);
  assert.equal(tally.id, 'cline');
  assert.equal(tally.tokens.input, 1150 + 2100 + 2200);
  assert.equal(tally.replies, 3);
  assert.ok(!dump(tally).includes(SECRET));
});

test('Kilo extension: Roo rules, same id as the Kilo CLI', async (t) => {
  const tally = await runTask(t, kiloExt, 'Code - Insiders');
  assert.equal(tally.id, 'kilo-code');
  assert.equal(tally.name, 'Kilo Code');
  assert.equal(tally.tokens.input, 1150 + 1100 + 1150);
  assert.deepEqual(readers.map((r) => r.id), ['cline', 'roo-code', 'kilo-code']);
});

test('VS Code task readers: nothing installed gives null', async (t) => {
  const home = tmp(t);
  for (const r of readers) assert.equal(await r.read({ home, env: {}, win: WIN, platform: 'linux' }), null);
  assert.equal(await cursor.read({ home, env: {}, win: WIN, platform: 'linux' }), null);
  assert.equal(await goose.read({ home, env: {}, win: WIN, platform: 'linux' }), null);
  assert.equal(await crush.read({ home, env: {}, win: WIN, platform: 'linux' }), null);
  assert.equal(await kilo.read({ home, env: {}, win: WIN }), null);
});

test('Cursor fast path: chat headers give prompts and times without reading bubbles', async (t) => {
  const { DatabaseSync } = await import('node:sqlite').catch(() => ({}));
  if (!DatabaseSync) return t.skip('node:sqlite unavailable');
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const cursor = await import('../src/local/cursor.js');
  const home = mkdtempSync(join(tmpdir(), 'tw-cursor-h-'));
  const dir = join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'state.vscdb'));
  db.exec('create table cursorDiskKV (key text unique on conflict replace, value blob)');
  const put = db.prepare('insert into cursorDiskKV values (?, ?)');
  const at = (s) => Date.parse(s);
  put.run('composerData:h1', JSON.stringify({ createdAt: at('2026-04-02T09:00:00Z'), modelConfig: { modelName: 'gpt-x' }, text: 'SECRET-H',
    fullConversationHeadersOnly: [
      { bubbleId: 'a', type: 1, createdAt: at('2026-04-02T09:00:00Z') },
      { bubbleId: 'b', type: 2 },
      { bubbleId: 'c', type: 2, createdAt: at('2026-04-02T09:01:00Z') },
      { bubbleId: 'd', type: 1 }, // no time: inherits 09:01
      { bubbleId: 'e', type: 1, createdAt: at('2025-12-30T09:00:00Z') }, // outside the window
    ] }));
  // A bubble row that would be counted if the fast path read bubbles: it must not be.
  put.run('bubbleId:h1:a', JSON.stringify({ type: 1, createdAt: '2026-04-02T09:00:00Z', text: 'SECRET-H' }));
  db.close();
  const win = { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-11-20T00:00:00Z') };
  const tally = await cursor.read({ home, env: {}, win, platform: 'darwin' });
  assert.equal(tally.prompts, 2);
  assert.equal(tally.replies, 2);
  assert.deepEqual([...tally.byModel.keys()], ['gpt-x']);
  assert.equal(tally.tokensKnown, false);
  assert.ok(!JSON.stringify([...tally.models.keys(), tally.prompts]).includes('SECRET'));
});
