# What tokens-wrapped reads, and what leaves your computer

## The default: `npx -y tokens-wrapped`

- It reads the usage logs and databases your coding agents already keep on your computer (Claude Code, Codex,
  OpenCode and the others listed in the README). Files are opened read-only; SQLite databases are opened with
  `readOnly: true`.
- It makes **no network requests**. No keys are needed or asked for.
- From those logs it keeps numbers (tokens, timestamps, counts), model names, tool names, and file extensions.
  Prompts, replies and code are never read out, printed or stored. Project folders and teammates are only counted.
- It writes exactly one file: the recap page, in a new folder in your temp directory.
- Zero dependencies, no install scripts, no telemetry, no update check.

## The one thing that can leave: a card you post

The recap page is a local file that makes no requests on its own. When you click **Post on X**, it uploads that
one card image (a 1600x900 PNG of the numbers you are about to post) to `tokenswrapped.com`, so X can show it
under your post. Nothing else is sent: no logs, no names, no other numbers. The image is deleted after 90 days.
The server code is [`worker/index.js`](worker/index.js): it accepts only a 1600x900 PNG and keeps a per-IP upload
count for two days to stop abuse. If you'd rather not upload, use "Save this card" and attach it yourself.

## Check it yourself

1. [`test/trust.test.js`](test/trust.test.js) fails the build if any code makes a network request (besides the
   recap page's single card upload), if anything but `src/share.js` writes a file, or if a dependency is added.
2. Each release is built and published by GitHub Actions from a tagged commit with npm provenance: the npm page
   links to the exact commit and workflow run. Or `git clone` and run `node bin/tokens-wrapped.js`.
3. Watch the network while it runs (Little Snitch, LuLu, `sudo nettop -m tcp`): the default run makes no
   connections.

## Reporting a problem

Use GitHub's private vulnerability reporting on this repo (Security tab, "Report a vulnerability").
