import { parseArgs } from 'node:util';
import { findLine, spendFlagNames, MAX_MONTHLY_USD } from './rates.js';
import { redact } from './http.js';

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

// "8000", "8k", "$8,000", "1.5m", "2,500.50" -> number of dollars. NaN when it isn't a number.
export function parseMoney(input) {
  if (input == null) return NaN;
  const s = String(input).trim().toLowerCase().replace(/[$,_\s]/g, '').replace(/usd$/, '');
  const m = /^(\d+(?:\.\d+)?|\.\d+)([km])?$/.exec(s);
  if (!m) return NaN;
  const n = Number(m[1]);
  return m[2] === 'k' ? n * 1e3 : m[2] === 'm' ? n * 1e6 : n;
}

const MONTHS_MSG = '--months takes a whole number from 1 to 12';
const moneyMsg = (name) => `--${name} takes a monthly amount in USD, like --${name} 8000`;

// Node's parseArgs errors are long and mention '--' positionals. Turn them into one short line.
function parseErrorMessage(err, options) {
  const raw = String(err?.message || '');
  const flag = (/'(-{1,2}[^' =]+)/.exec(raw) || [])[1] || '';
  const name = flag.replace(/^-+/, '');
  const shown = redact(flag).slice(0, 40);
  if (err?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') return shown ? `unknown flag ${shown}` : 'unknown flag';
  if (err?.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
    const opt = options[name] || Object.entries(options).find(([, o]) => o.short === name)?.[1];
    if (name === 'months' || name === 'm') return MONTHS_MSG;
    if (opt?.type === 'string') return moneyMsg(name);
    return shown ? `${shown} doesn't take a value` : 'bad arguments';
  }
  return 'bad arguments';
}

const KEYISH = /(^|[^a-z])(key|token|secret)([^a-z]|$)/i;

export function parse(argv) {
  // Keys never come in on argv. Refuse anything that looks like one, without echoing it.
  for (const a of argv) {
    if (/sk-[A-Za-z0-9]/.test(a) || (a.startsWith('--') && KEYISH.test(a.split('=')[0].slice(2)))) {
      throw new UsageError(
        'keys never go in flags. Run tokens-wrapped with no flags to paste them hidden, or set OPENAI_ADMIN_KEY / ' +
          'ANTHROPIC_ADMIN_KEY (environment only). Remove the key from the command and from your shell history.',
      );
    }
  }

  const options = {
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
    json: { type: 'boolean' },
    'no-color': { type: 'boolean' },
    'by-model': { type: 'boolean' },
    offline: { type: 'boolean' },
    share: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    keys: { type: 'boolean' },
    'no-open': { type: 'boolean' },
    months: { type: 'string', short: 'm' },
  };
  for (const name of spendFlagNames()) options[name] = { type: 'string' };

  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(parseErrorMessage(err, options));
  }
  const { values, positionals } = parsed;
  if (positionals.length) {
    throw new UsageError(`unexpected argument "${redact(positionals[0])}". Amounts go after a flag, like --openai 8000`);
  }

  let months = null;
  if (values.months != null) {
    const raw = String(values.months).trim();
    const n = /^\d{1,2}$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 12) throw new UsageError(MONTHS_MSG);
    months = n;
  }

  const spend = new Map(); // line id -> monthly usd
  for (const name of spendFlagNames()) {
    if (values[name] == null) continue;
    const usd = parseMoney(values[name]);
    if (!Number.isFinite(usd) || usd < 0) throw new UsageError(moneyMsg(name));
    if (usd > MAX_MONTHLY_USD) throw new UsageError(`--${name} takes up to $1,000,000,000 a month`);
    const id = findLine(name).id;
    spend.set(id, (spend.get(id) || 0) + usd);
  }

  return {
    help: Boolean(values.help),
    version: Boolean(values.version),
    json: Boolean(values.json),
    noColor: Boolean(values['no-color']),
    byModel: Boolean(values['by-model']),
    offline: Boolean(values.offline),
    share: Boolean(values.share),
    dryRun: Boolean(values['dry-run']),
    keys: Boolean(values.keys),
    noOpen: Boolean(values['no-open']),
    months,
    spend,
  };
}
