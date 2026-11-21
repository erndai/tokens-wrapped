// The only place tokens-wrapped talks to the network. Every request is a GET to an allowed host.

export const ALLOWED_HOSTS = new Set(['api.openai.com', 'api.anthropic.com']);
export const TIMEOUT_MS = 15000;

export class AiBillError extends Error {
  constructor(message, { code, provider, status, retryAfter } = {}) {
    super(message);
    this.name = 'AiBillError';
    this.code = code || 'error';
    this.provider = provider;
    this.status = status;
    this.retryAfter = retryAfter ?? null; // seconds, from a 429's Retry-After
  }
}

// Keys typed at the prompt are registered here, so every redact() call removes them, even in a crash message.
const REGISTERED = new Set();
export function registerSecret(secret) {
  if (secret && secret.length >= 4) REGISTERED.add(secret);
}

// Strip anything that looks like a secret. `secrets` are exact strings to remove (the key in use).
export function redact(text, secrets = []) {
  let s = String(text ?? '');
  for (const secret of [...secrets, ...REGISTERED]) {
    if (!secret || secret.length < 4) continue;
    s = s.split(secret).join('[redacted]');
    // Also drop long fragments of the key (a provider may echo the start or end of it).
    for (const frag of [secret.slice(0, 12), secret.slice(-8)]) {
      if (frag.length >= 8) s = s.split(frag).join('[redacted]');
    }
  }
  return s
    .replace(/sk-[A-Za-z0-9_\-*.]{3,}/g, '[redacted]')
    .replace(/(bearer\s+)\S+/gi, '$1[redacted]')
    .replace(/(x-api-key["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[redacted]')
    .replace(/(authorization["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[redacted]');
}

function retryAfterSeconds(headers) {
  const v = headers?.get?.('retry-after');
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  const t = Date.parse(v);
  if (Number.isFinite(t)) return Math.max(1, Math.ceil((t - Date.now()) / 1000));
  return null;
}

function requestIdOf(headers) {
  const v = headers?.get?.('x-request-id') || headers?.get?.('request-id') || '';
  return /^[A-Za-z0-9_.:-]{1,100}$/.test(v) ? v : null;
}

// Provider error text can echo headers or parts of a key, so it is never shown.
// Only the error type is kept, and only when it is a plain identifier like "invalid_request_error".
async function readErrorType(res) {
  try {
    const j = JSON.parse(await res.text());
    const t = j?.error?.type ?? j?.type;
    return typeof t === 'string' && /^[a-z_]{1,40}$/.test(t) && t !== 'error' ? t : '';
  } catch {
    return '';
  }
}

// GET a URL and return parsed JSON. Throws AiBillError with a one-line, key-free message.
export async function getJson(url, { fetch, headers, provider, secrets = [], timeoutMs = TIMEOUT_MS }) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) {
    throw new AiBillError(`${provider}: refusing to call ${u.hostname}`, { code: 'host', provider });
  }
  if (typeof fetch !== 'function') {
    throw new AiBillError(`${provider}: no fetch available (needs Node 18 or newer)`, { code: 'fetch', provider });
  }
  const host = u.hostname;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  let res;
  try {
    // Never follow a redirect: it could carry the key to another host.
    res = await fetch(u.toString(), { method: 'GET', headers, signal: ctrl.signal, redirect: 'error' });
  } catch (err) {
    clearTimeout(timer);
    if (timedOut || err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      throw new AiBillError(`${provider}: no answer from ${host} after ${Math.round(timeoutMs / 1000)}s`, {
        code: 'timeout',
        provider,
      });
    }
    if (/redirect/i.test(`${err?.message || ''} ${err?.cause?.message || ''}`)) {
      throw new AiBillError(`${provider}: unexpected redirect, not following it`, { code: 'redirect', provider });
    }
    const cause = err?.cause?.code || err?.code || '';
    throw new AiBillError(`${provider}: couldn't reach ${host}${cause ? ` (${redact(cause, secrets)})` : ''}`, {
      code: 'network',
      provider,
    });
  }
  clearTimeout(timer);

  if ((res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect') {
    throw new AiBillError(`${provider}: unexpected redirect, not following it`, {
      code: 'redirect',
      provider,
      status: res.status,
    });
  }

  const rid = requestIdOf(res.headers);
  const ridText = rid ? `, request id ${redact(rid, secrets)}` : '';
  if (res.ok) {
    try {
      return await res.json();
    } catch {
      throw new AiBillError(`${provider}: got a response that isn't JSON (${res.status}${ridText})`, {
        code: 'parse',
        provider,
        status: res.status,
      });
    }
  }

  const status = res.status;
  const opts = { provider, status };
  if (status === 401) {
    throw new AiBillError(`${provider}: that key can't read costs (401). Use an admin key.`, { ...opts, code: 'auth' });
  }
  if (status === 403) {
    throw new AiBillError(
      `${provider}: that key isn't allowed to read costs (403). It needs admin or cost read access.`,
      { ...opts, code: 'forbidden' },
    );
  }
  if (status === 429) {
    const ra = retryAfterSeconds(res.headers);
    throw new AiBillError(
      `${provider}: rate limited (429). ${ra ? `Try again in ${ra}s.` : 'Try again in a minute.'}`,
      { ...opts, code: 'rate_limit', retryAfter: ra },
    );
  }
  if (status === 404) {
    throw new AiBillError(
      `${provider}: cost endpoint returned 404${ridText}. This is often a problem on the provider's side, try later.`,
      { ...opts, code: 'not_found' },
    );
  }
  if (status >= 500) {
    throw new AiBillError(`${provider}: server error (${status}${ridText}). Try again later.`, {
      ...opts,
      code: 'server',
    });
  }
  const type = await readErrorType(res);
  throw new AiBillError(`${provider}: request rejected (${status}${ridText})${type ? `: ${type}` : ''}`, {
    ...opts,
    code: 'rejected',
  });
}
