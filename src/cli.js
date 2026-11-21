// tokens-wrapped: your year in AI from the logs your coding agents already keep. No keys, no network.

import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { runLocal, localText } from './localcli.js';
import { writeShare, openInBrowser } from './share.js';
import { colorLevel } from './format.js';
import { VERSION, REPO_URL } from './version.js';

export function helpText() {
  return `tokens-wrapped ${VERSION}: your year in AI, from your coding agents' logs.

Usage
  npx -y tokens-wrapped           read this year's usage and open your recap

Options
  --no-open                       don't open the recap in the browser
  --json                          print the numbers as JSON
  --no-color                      plain text (NO_COLOR is respected too)
  -h, --help    -v, --version

Reads Claude Code, Codex, Cursor, OpenCode, Kilo Code, Cline, Roo Code, Pi,
Gemini CLI, Qwen Code, Copilot CLI, Droid, Kimi CLI, Goose and Crush logs on
this computer, read-only. No keys, no network, no telemetry.
Source: ${REPO_URL}
`;
}

export async function main({
  argv = [],
  env = {},
  stdout,
  stderr,
  now = new Date(),
  home = homedir(),
  scan,
  openFile = openInBrowser,
  shareDir,
} = {}) {
  const out = (s) => stdout.write(s);
  const err = (s) => stderr.write(s);
  let args;
  try {
    const { values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        json: { type: 'boolean' },
        'no-open': { type: 'boolean' },
        'no-color': { type: 'boolean' },
      },
    });
    args = { help: values.help, version: values.version, json: values.json, noOpen: values['no-open'], noColor: values['no-color'] };
  } catch (e) {
    const flag = (/'(-{1,2}[^' =]+)/.exec(String(e?.message)) || [])[1];
    err(`tokens-wrapped: ${flag ? `unknown option ${flag.slice(0, 40)}` : 'bad arguments'}\nRun tokens-wrapped --help for usage.\n`);
    return 2;
  }
  if (args.help) {
    out(helpText());
    return 0;
  }
  if (args.version) {
    out(`${VERSION}\n`);
    return 0;
  }

  const r = await runLocal({ args, env, home, now, out, err, stderr, scan });
  if (r.code) return r.code;
  if (!args.json) {
    const color = colorLevel({ env, isTTY: Boolean(stdout?.isTTY), noColorFlag: args.noColor });
    const bold = color ? (x) => `\x1b[1m${x}\x1b[22m` : (x) => x;
    const dim = color ? (x) => `\x1b[2m${x}\x1b[22m` : (x) => x;
    out('\n' + localText(r.summary, r.value, { bold, dim }) + '\n');
  }
  const file = writeShare({ usage: r.summary, value: r.value, now, dir: shareDir });
  const say = args.json || !stdout?.isTTY ? err : out;
  say(`Your year in AI: ${pathToFileURL(file).href}\n`);
  if (stdout?.isTTY && !args.noOpen) openFile(file);
  return 0;
}
