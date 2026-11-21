// VS Code agent extensions that keep one folder per task: Cline, Roo Code and the older Kilo Code extension.
// <editor user dir>/globalStorage/<extension id>/tasks/<taskId>/ui_messages.json is a JSON array of UI messages.
// say "api_req_started" rows carry ts (ms) and text = JSON {tokensIn, tokensOut, cacheWrites, cacheReads, cost,
// apiProtocol?}; partial rows are still streaming and are skipped. Roo and Kilo count cache reads and writes inside
// tokensIn from 2025-11-02 (ts 1762041600000) on, and before that only on OpenAI-protocol rows; Cline never does.
// Edits: say/ask "tool" rows with text = JSON {tool, path, content?, diff?, diffStats?: {added}}.
// Only numbers, model ids, tool names and paths (counted) are kept; message text is parsed and dropped.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyTally, addReply, addTool, addEdit, touchedSince, safeJson, toDate, inWindow, num } from './tally.js';

// Editor builds whose globalStorage can hold these extensions.
export const EDITORS = ['Code', 'Code - Insiders', 'Cursor', 'Windsurf', 'VSCodium'];

// <app>/User for one VS Code-style editor on this platform.
export function editorUserDir(app, { home, env = {}, platform = process.platform }) {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', app, 'User');
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), app, 'User');
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), app, 'User');
}

// Every globalStorage folder that exists: local editors plus remote-server installs.
export function globalStorageDirs({ home, env = {}, platform = process.platform }) {
  const list = EDITORS.map((a) => join(editorUserDir(a, { home, env, platform }), 'globalStorage'));
  for (const s of ['.vscode-server', '.vscode-server-insiders', '.cursor-server', '.windsurf-server']) {
    list.push(join(home, s, 'data', 'User', 'globalStorage'));
  }
  return [...new Set(list)].filter((p) => existsSync(p));
}

// Roo and Kilo started counting cache tokens inside tokensIn on every protocol from this date.
export const CACHE_IN_INPUT_SINCE = 1762041600000; // 2025-11-02T00:00:00Z

const EDIT_TOOLS = new Set(['editedExistingFile', 'newFileCreated', 'appliedDiff', 'insertContent', 'searchAndReplace']);

// input as the tally wants it (including cache reads and writes), from one api_req_started row.
export function normalizeInput(flavor, req, ts) {
  const tokensIn = num(req.tokensIn);
  const cached = num(req.cacheReads);
  const cacheWrite = num(req.cacheWrites);
  let included = false;
  if (flavor === 'roo') included = ts >= CACHE_IN_INPUT_SINCE || req.apiProtocol === 'openai';
  let input = included ? tokensIn : tokensIn + cached + cacheWrite;
  if (input < cached + cacheWrite) input = tokensIn + cached + cacheWrite; // the row can't include what it's smaller than
  return { input, cached, cacheWrite };
}

// One task's ui_messages array into the tally.
export function addTask(t, messages, win, taskId, flavor) {
  if (!Array.isArray(messages)) return;
  let first = true;
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const isFirst = first;
    first = false;
    if (m.partial) continue;
    const when = toDate(m.ts);
    if (!inWindow(when, win)) continue;
    if (m.type === 'say' && m.say === 'api_req_started') {
      const req = safeJson(m.text);
      if (!req || typeof req !== 'object') continue;
      const { input, cached, cacheWrite } = normalizeInput(flavor, req, when.getTime());
      const output = num(req.tokensOut);
      addReply(t, { when, model: m.modelInfo?.modelId || null, input, cached, cacheWrite, output, session: taskId });
      t.cost += num(req.cost);
    } else if ((isFirst && m.type === 'say' && m.say === 'text') || m.say === 'user_feedback') {
      t.prompts++; // the task itself, then each later message the person typed
      t.sessions.add(taskId);
    } else if (m.say === 'tool' || m.ask === 'tool') {
      const tool = safeJson(m.text);
      if (!tool || typeof tool !== 'object' || !tool.tool) continue;
      addTool(t, tool.tool);
      if (!EDIT_TOOLS.has(tool.tool)) continue;
      const added = tool.diffStats?.added;
      if (Number.isFinite(Number(added)) && added != null) {
        addEdit(t, tool.path, '');
        t.lines += num(added);
      } else {
        addEdit(t, tool.path, typeof tool.content === 'string' ? tool.content : '');
      }
    }
  }
}

function safeDir(d) {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
}

export function taskFiles(roots, since) {
  const out = [];
  for (const root of roots) {
    const tasks = join(root, 'tasks');
    for (const id of safeDir(tasks)) {
      const f = join(tasks, id, 'ui_messages.json');
      if (touchedSince(f, since)) out.push({ id, file: f });
    }
  }
  return out;
}

function makeReader({ id, NAME, extId, flavor, extraRoots = () => [] }) {
  const roots = ({ home, env = {}, platform = process.platform }) => {
    const list = globalStorageDirs({ home, env, platform }).map((g) => join(g, extId));
    list.push(...extraRoots({ home, env, platform }));
    return [...new Set(list)].filter((p) => existsSync(p));
  };
  async function read({ home, env = {}, win, progress = () => {}, platform = process.platform }) {
    const list = taskFiles(roots({ home, env, platform }), win.start);
    if (!list.length) return null;
    const t = emptyTally(id, NAME);
    let i = 0;
    for (const { id: taskId, file } of list) {
      if (++i % 200 === 0) progress(`${NAME}: ${i} of ${list.length} tasks`);
      let text;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      addTask(t, safeJson(text), win, taskId, flavor);
    }
    return t.replies || t.prompts ? t : null;
  }
  return { id, NAME, extId, flavor, roots, read };
}

export const cline = makeReader({
  id: 'cline',
  NAME: 'Cline',
  extId: 'saoudrizwan.claude-dev',
  flavor: 'cline',
  // The Cline CLI and newer builds can keep tasks in ~/.cline/data.
  extraRoots: ({ home }) => [join(home, '.cline', 'data')],
});

export const roo = makeReader({ id: 'roo-code', NAME: 'Roo Code', extId: 'rooveterinaryinc.roo-cline', flavor: 'roo' });

// Same id and name as kilo.js (the Kilo CLI), so the two merge into one Kilo Code row.
export const kiloExt = makeReader({ id: 'kilo-code', NAME: 'Kilo Code', extId: 'kilocode.kilo-code', flavor: 'roo' });

export const readers = [cline, roo, kiloExt];
