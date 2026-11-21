import { parse, UsageError } from './args.js';
import { computeBill } from './math.js';
import { render } from './render.js';
import { colorLevel } from './format.js';
import { redact, registerSecret, AiBillError } from './http.js';
import { periodFor } from './period.js';
import { ERND, LINES } from './rates.js';
import { VERSION, REPO_URL } from './version.js';
import * as openai from './providers/openai.js';
import * as anthropic from './providers/anthropic.js';
import { ask, askKeys, defaultPrompt, hiddenPrompt, PromptCancelled } from './interactive.js';
import { writeShare, openInBrowser } from './share.js';
import { yearUsage } from './usage.js';
import { runLocal, localText } from './localcli.js';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

export const PROVIDERS = [openai, anthropic];

export function helpText() {
  const partners = LINES.filter((l) => l.kind === 'partner')
    .map((l) => `--${l.id} ${l.rate}%`)
    .join('  ');
  const perks = LINES.filter((l) => l.kind === 'perk_only' || l.kind === 'limits')
    .map((l) => `--${l.id}`)
    .join(' ');
  return `tokens-wrapped ${VERSION}: your year in AI, from your OpenAI and Anthropic reports.

Usage
  tokens-wrapped                  your year in AI from Claude Code, Codex and
                                  OpenCode logs on this computer. No keys.
  tokens-wrapped --keys           team mode: org admin keys (hidden prompt)
  tokens-wrapped --dry-run --keys list every request --keys would make
  tokens-wrapped --openai 8000 --anthropic 4000 --wafer 2000 --other 20000

Keys, only for --keys (hidden prompt or env, never flags)
  OPENAI_ADMIN_KEY                OpenAI org admin key (sk-admin-...)
  ANTHROPIC_ADMIN_KEY             Anthropic Admin API key (sk-ant-admin01-...)

Monthly spend in USD, e.g. --wafer 2000
  --openai --anthropic            AI vendors, 4% back
  ${wrap(partners, 76, '  ')}
  ${perks.padEnd(32)}perks, see the card
  --ai                            other AI vendors
  --other                         card spend that isn't AI

Options
  -m, --months <1-12>             average the last N full months
                                  (default: the last 30 days)
  --by-model                      top models and line items per provider
  --share                         "year in AI" cards to post, opens a page
  --dry-run                       print the requests instead of sending them
  --no-open                       don't open the recap in the browser
  --offline                       ignore keys, make no network calls
  --json                          machine output
  --no-color                      plain text (NO_COLOR is respected too)
  -h, --help    -v, --version

Privacy
  It only calls api.openai.com and api.anthropic.com, with GET requests to
  their cost endpoints when a key is set. It sends nothing to ernd or anyone
  else and has no telemetry or update check. Keys never show up in output.

${ERND.oneLiner} ${ERND.url}
`;
}

function wrap(text, width, indent) {
  const words = text.split('  ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (cur && (indent + cur + '  ' + w).length > width) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? cur + '  ' + w : w;
  }
  if (cur) lines.push(cur);
  return lines.join('\n' + indent);
}

function writer(stream) {
  return (s) => stream.write(s);
}

export async function main({
  argv = [],
  env = {},
  stdout,
  stderr,
  stdin,
  fetch = globalThis.fetch,
  now = new Date(),
  prompt,
  timeoutMs,
  openFile = openInBrowser,
  shareDir,
  keyPrompt,
  home = homedir(),
  scan,
} = {}) {
  const out = writer(stdout);
  const err = writer(stderr);
  let secrets = [env.OPENAI_ADMIN_KEY, env.ANTHROPIC_ADMIN_KEY].filter(Boolean);
  const safe = (s) => redact(s, secrets);

  let args;
  try {
    args = parse(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      err(`tokens-wrapped: ${safe(e.message)}\nRun tokens-wrapped --help for usage.\n`);
      return 2;
    }
    throw e;
  }

  if (args.help) {
    out(helpText());
    return 0;
  }
  if (args.version) {
    out(`${VERSION}\n`);
    return 0;
  }

  if (args.dryRun) return dryRun(args, { env, now, out });

  // Default: no keys, no amounts -> read coding agents' local logs. No network at all.
  if (!args.keys && !args.spend.size && !env.OPENAI_ADMIN_KEY && !env.ANTHROPIC_ADMIN_KEY) {
    const r = await runLocal({ args, env, home, now, out, err, stderr, scan });
    // No agent logs: on a terminal, fall through to typing monthly amounts instead (below).
    const askable = Boolean(prompt) || Boolean(stdin?.isTTY && (args.json || !stdout?.isTTY ? stderr : stdout)?.isTTY);
    if (r.code && !askable) return r.code;
    if (!r.code) return finishLocal(r);
  }
  function finishLocal(r) {
    const color = colorLevel({ env, isTTY: Boolean(stdout?.isTTY), noColorFlag: args.noColor });
    const bold = color ? (x) => `\x1b[1m${x}\x1b[22m` : (x) => x;
    const dim = color ? (x) => `\x1b[2m${x}\x1b[22m` : (x) => x;
    if (!args.json) out('\n' + localText(r.summary, r.value, { bold, dim }) + '\n');
    const file = writeShare(null, { now, dir: shareDir, usage: r.summary, value: r.value });
    const say = args.json || !stdout?.isTTY ? err : out;
    say(`Your year in AI: ${pathToFileURL(file).href}\n`);
    if (stdout?.isTTY && !args.noOpen) openFile(file);
    return 0;
  }

  // --keys: team mode. Ask for admin keys, hidden, then show the recap from the provider reports.
  //    Typed keys live in memory only: never written, never put in the environment, removed from all output.
  const keyStream = args.json || !stdout?.isTTY ? stderr : stdout;
  // A test that injects only the amount prompt gets no key prompt.
  const canAsk = keyPrompt ? true : !prompt && Boolean(stdin?.isTTY && keyStream?.isTTY);
  if (args.keys && !args.offline && !env.OPENAI_ADMIN_KEY && !env.ANTHROPIC_ADMIN_KEY && canAsk) {
    let keys;
    try {
      keys = await askKeys(keyPrompt || hiddenPrompt({ input: stdin, output: keyStream }), writer(keyStream), REPO_URL);
    } catch (e) {
      if (e instanceof PromptCancelled) return 130;
      throw e;
    }
    for (const k of Object.values(keys)) registerSecret(k);
    if (Object.keys(keys).length) {
      env = { ...env, ...keys };
      secrets = [...secrets, ...Object.values(keys)];
      args.share = true;
    }
  }

  const entries = [];
  const errors = [];
  const warnings = [];
  const fromApi = [];

  // 1. Keys from env (unless --offline). A manual flag for the same provider wins.
  const keyed = args.offline ? [] : PROVIDERS.filter((p) => env[p.ENV] && !args.spend.has(p.id));
  const results = await Promise.all(
    keyed.map(async (p) => {
      try {
        return { p, r: await p.monthlyCosts({ key: env[p.ENV], fetch, months: args.months, now, timeoutMs }) };
      } catch (e) {
        const msg = e instanceof AiBillError ? e.message : `${p.NAME}: unexpected error (${e?.name || 'Error'})`;
        return { p, error: { provider: p.NAME, code: e?.code || 'error', message: safe(msg) } };
      }
    }),
  );
  for (const { p, r, error } of results) {
    if (error) {
      errors.push(error);
      continue;
    }
    fromApi.push(r);
    warnings.push(...(r.warnings || []).map(safe));
    entries.push({ id: p.id, monthly_usd: r.monthly_usd, source: 'api', by_item: r.by_item });
  }

  // 2. Manual flags.
  for (const [id, usd] of args.spend) entries.push({ id, monthly_usd: usd, source: 'manual' });
  if (args.months != null && !keyed.length) err('tokens-wrapped: --months only applies to costs read with admin keys\n');

  // 3. Nothing given: ask on a TTY, otherwise print help.
  //    Questions go to stderr when stdout is a file or pipe, so `tokens-wrapped > card.txt` gets only the card.
  if (!entries.length && !errors.length) {
    const promptStream = args.json || !stdout?.isTTY ? stderr : stdout;
    const tty = Boolean(stdin?.isTTY && promptStream?.isTTY);
    if (!tty && !prompt) {
      err(helpText());
      return 1;
    }
    const ask1 = prompt || defaultPrompt({ input: stdin, output: promptStream });
    let answers;
    try {
      answers = await ask(ask1, writer(promptStream));
    } catch (e) {
      if (e instanceof PromptCancelled) {
        promptStream.write('\n');
        return 130;
      }
      throw e;
    }
    for (const a of answers) entries.push({ ...a, source: 'interactive' });
  }

  // Typed numbers that are all zero: nothing to show.
  if (!fromApi.length && !errors.length && !entries.some((e) => e.monthly_usd > 0)) {
    err('tokens-wrapped: no spend given.\n');
    return 1;
  }

  for (const e of errors) err(`tokens-wrapped: ${e.message}\n`);
  for (const w of warnings) err(`tokens-wrapped: ${w}\n`);
  if (!entries.length && !args.json) return 1;

  const bill = computeBill(entries);
  const period = fromApi.length
    ? periodFor({ months: args.months, now })
    : { kind: 'monthly', label: 'per month', months: 1 };
  const periodLabel = fromApi.length ? period.label : '';

  if (args.json) {
    out(JSON.stringify(toJson(bill, period, errors, warnings), null, 2) + '\n');
  } else {
    const color = colorLevel({ env, isTTY: Boolean(stdout?.isTTY), noColorFlag: args.noColor });
    out(render(bill, { color, columns: stdout?.columns || 80, byModel: args.byModel, periodLabel }) + '\n');
  }
  if (args.share) {
    // The page is written locally and opened in the browser. Nothing is uploaded.
    // With keys: this year's tokens, cache hits and Claude Code stats too. Each part that fails is left out.
    let usage = null;
    if (!args.offline && (env.OPENAI_ADMIN_KEY || env.ANTHROPIC_ADMIN_KEY)) {
      const r = await yearUsage({ env, fetch, now, timeoutMs, progress: (m) => stderr?.isTTY && err(`tokens-wrapped: ${m}\n`) });
      usage = r.usage;
      for (const c of r.checks) err(`tokens-wrapped: data: ${safe(c)}\n`);
      for (const w of r.warnings) err(`tokens-wrapped: ${safe(w)}\n`);
    }
    const file = writeShare(bill, { now, dir: shareDir, usage });
    const say = args.json || !stdout?.isTTY ? err : out;
    say(`Your year in AI: ${pathToFileURL(file).href}\n`);
    if (stdout?.isTTY) openFile(file);
  }
  return errors.length ? 1 : 0;
}

export function toJson(bill, period, errors = [], warnings = []) {
  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    version: VERSION,
    period: {
      kind: period.kind,
      label: period.label,
      months: period.months,
      ...(period.start ? { start: period.start.toISOString(), end: period.end.toISOString() } : {}),
    },
    lines: bill.lines.map((l) => ({
      id: l.id,
      name: l.name,
      kind: l.kind,
      source: l.source,
      monthly_usd: r2(l.monthly_usd),
      yearly_usd: r2(l.yearly_usd),
      rate_pct: l.rate_pct,
      back_per_year_usd: l.back_per_year_usd,
      perk: l.perk,
      by_item: (l.by_item || []).map((i) => ({ name: i.name, usd: r2(i.usd) })),
    })),
    ai_monthly_usd: r2(bill.ai_monthly_usd),
    ai_yearly_usd: r2(bill.ai_yearly_usd),
    other_monthly_usd: r2(bill.other_monthly_usd),
    back_per_year_exact_usd: bill.back_per_year_exact_usd,
    back_per_year_usd: bill.back_per_year_usd,
    errors,
    warnings,
    ernd: { about: ERND.oneLiner, rates: ERND.rates, fees: ERND.fees, url: ERND.url },
  };
}

// --dry-run: run the same code with a fetch that records each request and answers with an empty report.
// Prints method, host, path and query, and header names only. Nothing leaves the machine.
async function dryRun(args, { env, now, out }) {
  const calls = [];
  const fakeFetch = async (url, init = {}) => {
    calls.push({ url: new URL(url), method: init.method, headers: Object.keys(init.headers || {}) });
    return new Response(JSON.stringify({ data: [], has_more: false, next_page: null }), { status: 200 });
  };
  const keys = {
    OPENAI_ADMIN_KEY: env.OPENAI_ADMIN_KEY || 'sk-admin-dry-run',
    ANTHROPIC_ADMIN_KEY: env.ANTHROPIC_ADMIN_KEY || 'sk-ant-admin01-dry-run',
  };
  for (const p of PROVIDERS) await p.monthlyCosts({ key: keys[p.ENV], fetch: fakeFetch, months: args.months, now });
  if (args.share) await yearUsage({ env: keys, fetch: fakeFetch, now });
  const groups = new Map();
  for (const c of calls) {
    const k = `${c.method} https://${c.url.hostname}${c.url.pathname}`;
    const g = groups.get(k) || { n: 0, example: c.url, headers: c.headers };
    g.n++;
    groups.set(k, g);
  }
  out(`tokens-wrapped would make ${calls.length} request${calls.length === 1 ? '' : 's'}, all GET, to ${[...new Set(calls.map((c) => c.url.hostname))].join(' and ')}:\n\n`);
  for (const [k, g] of groups) {
    out(`  ${k}${g.n > 1 ? `  (x${g.n})` : ''}\n    e.g. ?${g.example.searchParams.toString()}\n    headers: ${g.headers.join(', ')}\n`);
  }
  out(`\nLong reports take more pages of the same requests. The key goes only in the x-api-key or Authorization\nheader. Nothing is sent anywhere else.\n`);
  return 0;
}
