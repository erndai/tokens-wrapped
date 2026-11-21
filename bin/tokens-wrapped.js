#!/usr/bin/env node
import { main } from '../src/cli.js';

// Never print a stack trace: one line is enough, and it can't leak paths from someone's logs.
function die(e) {
  process.stderr.write(`tokens-wrapped: unexpected error: ${String(e?.message || e).split('\n')[0]}\n`);
  process.exit(1);
}
process.on('uncaughtException', die);
process.on('unhandledRejection', die);

main({ argv: process.argv.slice(2), env: process.env, stdout: process.stdout, stderr: process.stderr }).then(
  (code) => {
    process.exitCode = code;
  },
  die,
);
