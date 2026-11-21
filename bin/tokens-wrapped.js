#!/usr/bin/env node
import { main } from '../src/cli.js';
import { redact } from '../src/http.js';

const secrets = [process.env.OPENAI_ADMIN_KEY, process.env.ANTHROPIC_ADMIN_KEY].filter(Boolean);

// Never print a stack trace: it could carry request details.
function die(e) {
  const msg = redact(e?.message || String(e), secrets).split('\n')[0];
  process.stderr.write(`tokens-wrapped: unexpected error: ${msg}\n`);
  process.exit(1);
}
process.on('uncaughtException', die);
process.on('unhandledRejection', die);

main({
  argv: process.argv.slice(2),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
}).then(
  (code) => {
    process.exitCode = code;
  },
  die,
);
