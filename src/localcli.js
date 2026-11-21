// The default run: no keys, no network. Reads coding agents' local logs, prints a short summary, opens the recap.

import { scanLocal } from './local/index.js';
import { estimate } from './local/value.js';
import { usd } from './format.js';
import { compact, shortDate, langName, prettyModel } from './share.js';

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const n0 = (x) => Math.round(x).toLocaleString('en-US');
const and = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

function hourLabel(h) {
  if (h === 0) return '12am';
  if (h === 12) return '12pm';
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

export function localText(s, value, { bold = (x) => x, dim = (x) => x } = {}) {
  const rows = [];
  rows.push(`${bold(`Your ${s.year} in AI`)}  ${dim(`${shortDate(s.since)} to ${shortDate(s.until)}, from ${and(s.sources)}`)}`);
  rows.push('');
  const pair = (a, b) => rows.push(`  ${a.padEnd(30)}${b}`);
  pair(`${compact(s.tokens.total)} tokens`, value ? `${usd(value.api)} at API prices` : '');
  pair(s.cacheHit != null ? `${pct(s.cacheHit)} cache hits` : '', s.streak > 1 ? `${s.streak}-day streak` : '');
  if (s.peak) pair(`Biggest day ${shortDate(s.peak.date)}`, s.busiestHour != null ? `busiest at ${hourLabel(s.busiestHour)}` : '');
  rows.push('');
  rows.push(`  ${dim('Harnesses')}  ${s.harnesses.map((h) => `${h.name} ${h.tokensKnown ? compact(h.tokens) : `${n0(h.replies)} replies`}`).join(dim(' · '))}`);
  if (s.models.length) rows.push(`  ${dim('Models')}     ${s.models.slice(0, 3).map((m) => prettyModel(m.name)).join(dim(' · '))}`);
  if (s.built?.lines) {
    const lang = s.built.languages[0] ? `, mostly ${langName(s.built.languages[0].ext)}` : '';
    rows.push(`  ${dim('Built')}      ${n0(s.built.lines)} lines across ${n0(s.built.files)} files${lang}`);
  }
  return rows.map((r) => r.replace(/\s+$/, '')).join('\n') + '\n';
}

export function localJson(s, value) {
  return { ...s, apiValue: value };
}

// A one-line progress spinner on stderr, cleared when done. No-op when stderr isn't a terminal.
function spinner(stream) {
  if (!stream?.isTTY) return { update() {}, done() {} };
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  let msg = 'Reading your coding agents...';
  const draw = () => stream.write(`\r\x1b[2K${frames[i++ % frames.length]} ${msg}`);
  const timer = setInterval(draw, 90);
  draw();
  return {
    update(m) {
      msg = m;
    },
    done() {
      clearInterval(timer);
      stream.write('\r\x1b[2K');
    },
  };
}

export async function runLocal({ args, env, home, now, out, err, stderr, scan = scanLocal }) {
  const spin = spinner(stderr);
  let r;
  try {
    r = await scan({ home, env, now, progress: (m) => spin.update(m) });
  } finally {
    spin.done();
  }
  for (const n of r.notes) err(`tokens-wrapped: ${n}\n`);
  if (!r.summary) {
    err(
      'tokens-wrapped: no coding agent logs from this year found on this computer.\n' +
        '  It reads Claude Code, Codex and OpenCode logs.\n' +
        '  Team admin keys instead: tokens-wrapped --keys\n',
    );
    return { code: 1 };
  }
  const value = estimate(r.tallies, r.summary);
  if (args.json) out(JSON.stringify(localJson(r.summary, value), null, 2) + '\n');
  return { code: 0, summary: r.summary, value };
}
