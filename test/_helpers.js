import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

export const NOW = new Date('2026-11-20T15:00:00Z');

// An empty home folder: tests never read the real machine's coding agent logs.
export const EMPTY_HOME = mkdtempSync(join(tmpdir(), 'tw-empty-home-'));

// A stream stand-in that keeps what's written.
export function sink({ isTTY = false, columns } = {}) {
  const s = { text: '', isTTY, columns, write(chunk) { s.text += chunk; return true; } };
  return s;
}

// A home folder with a tiny, made-up Claude Code transcript (two replies, one edit, one typed prompt).
export function claudeHome(secret = 'SECRET-PROMPT-TEXT') {
  const home = mkdtempSync(join(tmpdir(), 'tw-home-'));
  const file = join(home, '.claude', 'projects', '-proj', 'session-1.jsonl');
  mkdirSync(dirname(file), { recursive: true });
  const lines = [
    { type: 'user', timestamp: '2026-03-02T17:00:00Z', sessionId: 's1', cwd: '/p', message: { role: 'user', content: secret } },
    {
      type: 'assistant', timestamp: '2026-03-02T17:00:05Z', sessionId: 's1', cwd: '/p', requestId: 'r1',
      message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/p/a.py', content: 'x\ny\nz' } }],
        usage: { input_tokens: 100, cache_read_input_tokens: 9000, cache_creation_input_tokens: 400, output_tokens: 500 } },
    },
    // The same reply repeated on another line, as Claude Code writes it: must count once.
    {
      type: 'assistant', timestamp: '2026-03-02T17:00:05Z', sessionId: 's1', cwd: '/p', requestId: 'r1',
      message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'text', text: secret }],
        usage: { input_tokens: 100, cache_read_input_tokens: 9000, cache_creation_input_tokens: 400, output_tokens: 500 } },
    },
    {
      type: 'assistant', timestamp: '2026-03-03T09:00:00Z', sessionId: 's1', cwd: '/p', requestId: 'r2',
      message: { id: 'm2', model: 'claude-opus-5-5', content: [], usage: { input_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 50 } },
    },
  ];
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return home;
}
