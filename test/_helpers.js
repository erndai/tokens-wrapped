import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export const FAKE_OPENAI_KEY = 'sk-admin-FAKEtestKEYdoNotUse0000111122223333';
export const FAKE_ANTHROPIC_KEY = 'sk-ant-admin01-FAKEtestKEYdoNotUse999988887777';
export const NOW = new Date('2026-11-20T15:00:00Z');

export function fixture(name) {
  return JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));
}

// A fetch that never touches the network. `route(url, init)` returns { status, body, headers } or throws.
export function fakeFetch(route) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const r = await route(new URL(url), init, calls.length);
    const headers = new Headers(r.headers || {});
    const body = r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return new Response(body, { status: r.status || 200, headers });
  };
  fn.calls = calls;
  return fn;
}

// A fetch that hangs until aborted, like a server that never answers.
export function hangingFetch() {
  return (url, init = {}) =>
    new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => {
        const e = new Error('This operation was aborted');
        e.name = 'AbortError';
        reject(e);
      });
    });
}

export function sink({ isTTY = false, columns } = {}) {
  const s = { text: '', isTTY, columns, write(chunk) { s.text += chunk; return true; } };
  return s;
}

export const providerRouter = () => {
  return (u) => {
    if (u.hostname === 'api.openai.com') {
      return { body: u.searchParams.get('page') ? fixture('openai-costs-page2.json') : fixture('openai-costs-page1.json') };
    }
    if (u.hostname === 'api.anthropic.com') {
      return { body: u.searchParams.get('page') ? fixture('anthropic-cost-page2.json') : fixture('anthropic-cost-page1.json') };
    }
    throw new Error('unexpected host ' + u.hostname);
  };
};

// An empty home folder: tests never read the real machine's coding agent logs.
export const EMPTY_HOME = mkdtempSync(join(tmpdir(), 'tw-empty-home-'));
