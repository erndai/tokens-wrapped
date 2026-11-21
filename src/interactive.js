import { createInterface } from 'node:readline/promises';
import { findLine, ANSWER_ALIASES, MAX_MONTHLY_USD } from './rates.js';
import { parseMoney } from './args.js';

// Words that carry no name or amount.
const FILLER = new Set([
  'and', 'with', 'on', 'at', 'for', '+', '&', '-', '~', 'a', 'month', 'mo', 'per', 'about', 'around',
  'roughly', 'approx', 'approximately', 'total', 'in', 'is', 'of', 'plus', 'usd', 'dollars', 'monthly',
]);

// Thrown when the person presses Ctrl+C or Ctrl+D at a prompt.
export class PromptCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'PromptCancelled';
  }
}

function money(tok) {
  const v = parseMoney(tok);
  return Number.isFinite(v) && v <= MAX_MONTHLY_USD ? v : NaN;
}

// Which line a typed name belongs to. Unknown names are AI vendors at the standard rate.
function resolve(raw) {
  const k = raw.toLowerCase();
  const words = k.split(' ');
  const aliasId = ANSWER_ALIASES[k] ?? words.map((w) => ANSWER_ALIASES[w]).find(Boolean);
  if (aliasId) return { line: findLine(aliasId) };
  let line = findLine(raw);
  if (line && line.kind === 'card') line = findLine('ai'); // "other 500" in the AI question
  return { line, raw };
}

// "openai 8k, anthropic 4000 and cursor 500" -> [{ id: 'openai', ... }, { id: 'anthropic', ... }, { id: 'custom:cursor', ... }]
// Also reads "8000 openai 4000 anthropic". A bare number is "other AI vendors".
// Returns { entries, leftover }: leftover is any name that never got an amount.
export function parseSpendAnswer(text) {
  const tokens = String(text || '')
    .toLowerCase()
    .replace(/\b(?:a|per)\s+month\b/g, ' ')
    .replace(/\/\s*(?:month|mo)\b/g, ' ')
    .replace(/[,;]\s+/g, ' ')
    .replace(/[:=~]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !FILLER.has(t));

  // Group into segments: numbers, and runs of words that make one name.
  const segs = [];
  let name = [];
  const flush = () => {
    if (name.length) segs.push({ name: name.join(' ') });
    name = [];
  };
  for (const tok of tokens) {
    const v = money(tok);
    if (Number.isFinite(v)) {
      // "agent 37" is a name, not "agent" with $37.
      if (name.length && !findLine(name.join(' ')) && findLine([...name, tok].join(' '))) {
        name.push(tok);
        continue;
      }
      flush();
      segs.push({ usd: v });
    } else name.push(tok);
  }
  flush();

  const out = new Map();
  const skipped = [];
  const add = (raw, usd) => {
    const { line } = raw ? resolve(raw) : { line: findLine('ai') };
    const key = line ? line.id : `custom:${raw}`;
    const label = line ? line.name : raw.replace(/^./, (c) => c.toUpperCase());
    const prev = out.get(key);
    out.set(key, { id: key, name: label, monthly_usd: (prev?.monthly_usd || 0) + usd });
  };

  const isNum = (s) => s && 'usd' in s;
  const isName = (s) => s && 'name' in s;
  const numberFirst = isNum(segs[0]) && isName(segs[1]);
  for (let i = 0; i < segs.length; ) {
    const s = segs[i];
    const next = segs[i + 1];
    if (numberFirst) {
      if (isNum(s) && isName(next)) {
        add(next.name, s.usd);
        i += 2;
      } else if (isNum(s)) {
        add('', s.usd);
        i += 1;
      } else {
        skipped.push(s.name);
        i += 1;
      }
      continue;
    }
    if (isName(s) && isNum(next)) {
      add(s.name, next.usd);
      i += 2;
    } else if (isNum(s) && isName(next) && !isNum(segs[i + 2])) {
      add(next.name, s.usd); // "openai 8000, 2000 wafer"
      i += 2;
    } else if (isNum(s)) {
      add('', s.usd);
      i += 1;
    } else {
      skipped.push(s.name);
      i += 1;
    }
  }
  return { entries: [...out.values()], leftover: skipped.join(' ') };
}

export function defaultPrompt({ input, output }) {
  return (question) =>
    new Promise((resolve, reject) => {
      const rl = createInterface({ input, output, terminal: true });
      let done = false;
      const finish = (fn, v) => {
        if (done) return;
        done = true;
        fn(v);
        rl.close();
      };
      rl.once('close', () => finish(reject, new PromptCancelled())); // Ctrl+D
      rl.once('SIGINT', () => finish(reject, new PromptCancelled())); // Ctrl+C
      rl.question(question).then(
        (a) => finish(resolve, a),
        () => finish(reject, new PromptCancelled()),
      );
    });
}

// Ask 2 short questions (3 if the first answer can't be read). Returns spend entries.
export async function ask(prompt, write) {
  const q1 = 'What does your company spend on AI a month, and with whom?\n  e.g. openai 8000 anthropic 4000 wafer 2000, or one total\n> ';
  let { entries, leftover } = parseSpendAnswer(await prompt(q1));
  if (!entries.length) {
    write('  A number is enough, like 12000.\n');
    ({ entries, leftover } = parseSpendAnswer(await prompt('> ')));
    if (!entries.length) return [];
  }
  if (leftover) write(`  Skipped "${leftover}". Use: name amount, like wafer 2000.\n`);
  const otherRaw = (await prompt('Other card spend a month, not AI? (USD, enter to skip)\n> ')).trim();
  if (otherRaw) {
    const usd = money(otherRaw.replace(/\/\s*(?:month|mo)\b|\b(?:a|per)\s+month\b/gi, ''));
    if (Number.isFinite(usd) && usd > 0) {
      const prev = entries.find((e) => e.id === 'other'); // "azure 3000" in the first answer
      if (prev) prev.monthly_usd += usd;
      else entries.push({ id: 'other', monthly_usd: usd });
    }
  }
  return entries;
}

// Asks for a secret without echoing it. Raw mode, so nothing typed or pasted is shown or kept in history.
// Handles paste (any chunk size), bracketed-paste markers, backspace, Enter, Ctrl+C and Ctrl+D.
export function hiddenPrompt({ input, output }) {
  return (question) =>
    new Promise((resolve, reject) => {
      output.write(question);
      let buf = '';
      const raw = typeof input.setRawMode === 'function' && input.isTTY;
      if (raw) input.setRawMode(true);
      input.resume();
      input.setEncoding?.('utf8');
      const done = (fn, v) => {
        input.removeListener('data', onData);
        if (raw) input.setRawMode(false);
        input.pause();
        output.write('\n');
        fn(v);
      };
      const onData = (chunk) => {
        const s = String(chunk).replace(/\x1b\[20[01]~/g, ''); // bracketed paste start/end
        for (const ch of s) {
          if (ch === '\r' || ch === '\n') return done(resolve, buf.trim());
          if (ch === '\u0003') return done(reject, new PromptCancelled()); // Ctrl+C
          if (ch === '\u0004') return buf ? done(resolve, buf.trim()) : done(reject, new PromptCancelled()); // Ctrl+D
          if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
          else if (ch >= ' ' && ch !== '\u007f') buf += ch;
        }
      };
      input.on('data', onData);
    });
}

// What a key of each kind looks like, to warn early about a regular (non-admin) key.
export const KEY_SHAPES = {
  OPENAI_ADMIN_KEY: { name: 'OpenAI', prefix: 'sk-admin-', where: 'platform.openai.com/settings/organization/admin-keys' },
  ANTHROPIC_ADMIN_KEY: { name: 'Anthropic', prefix: 'sk-ant-admin', where: 'console.anthropic.com/settings/admin-keys' },
};

// Ask for both admin keys, hidden. Returns { OPENAI_ADMIN_KEY?, ANTHROPIC_ADMIN_KEY? }; Enter skips one.
export async function askKeys(promptHidden, write, repoUrl) {
  write(
    'Your year in AI, from your OpenAI and Anthropic admin keys.\n' +
      '  Keys stay on this computer. tokens-wrapped only calls api.openai.com and api.anthropic.com,\n' +
      '  only reads cost and usage reports, saves nothing and sends nothing anywhere else.\n' +
      `  Read the code: ${repoUrl}\n\n`,
  );
  const keys = {};
  for (const [env, k] of Object.entries(KEY_SHAPES)) {
    const v = await promptHidden(`${k.name} admin key (hidden, Enter to skip): `);
    if (!v) continue;
    if (!v.startsWith(k.prefix)) write(`  That doesn't look like an ${k.name} admin key (${k.prefix}...). Make one at ${k.where}\n`);
    else write('  got it\n');
    keys[env] = v;
  }
  return keys;
}
