<p align="center"><img src="docs/banner.png" alt="Your year in AI: tokens, API cost, cache hits, streaks and what your agents built" width="100%"></p>

<p align="center">
  <a href="https://github.com/erndai/tokens-wrapped/actions/workflows/ci.yml"><img alt="tests" src="https://github.com/erndai/tokens-wrapped/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/tokens-wrapped"><img alt="npm" src="https://img.shields.io/npm/v/tokens-wrapped?color=6a97e6"></a>
  <img alt="dependencies: 0" src="https://img.shields.io/badge/dependencies-0-7682d7">
  <a href="SECURITY.md"><img alt="everything stays on your computer" src="https://img.shields.io/badge/data-stays%20on%20your%20computer-6a97e6"></a>
  <img alt="license: MIT" src="https://img.shields.io/badge/license-MIT-9775c6">
</p>

# tokens-wrapped

Your year in AI, from the logs your coding agents already keep ([tokenswrapped.com](https://tokenswrapped.com)).
One command, no keys:

```sh
npx -y tokens-wrapped
```

It reads this year's usage from Claude Code, Codex, OpenCode and the other agents on your computer, prints a
summary, and opens a recap you can tap through and post.

## Everything stays on your computer

- It reads agent logs and databases on your machine, read-only, and makes no network requests at all.
- It keeps only numbers, model names and tool names. It never reads out your prompts or code.
- Nothing is saved except the recap page, one local file.
- The only thing that ever leaves is the card you choose to post: "Post on X" uploads that one image so X can show
  it, and it's deleted after 90 days ([worker/index.js](worker/index.js)).
- Zero dependencies, no telemetry. Every release is published from this repo by GitHub Actions with npm
  provenance. Details: [SECURITY.md](SECURITY.md).

## What's in the recap

| Card | From |
|---|---|
| At API prices: what the year would have cost, next to a $20, $100 or $200 plan | Tokens by model x public list prices ([src/local/prices.js](src/local/prices.js)) |
| Tokens, top models, cache hit rate | Each agent's usage records |
| Your harnesses | Which coding agents you used, by tokens and days |
| Your biggest day, your rhythm (streak, busiest hour) | Timestamps, in your local time |
| What your agents wrote: lines, files, languages, sessions | The agents' edit and write tool calls |
| Your AI personality, summary, a wide card for X | All of the above |

Supported: Claude Code, Codex, Cursor, OpenCode, Kilo Code, Cline, Roo Code, Pi, Gemini CLI, Qwen Code, Copilot CLI,
Droid, Kimi CLI, Goose and Crush. Notes:

- Claude Code (and Gemini CLI) delete logs after 30 days by default, so the recap starts at your oldest log. It tells you
  when that happened; set `cleanupPeriodDays` in `~/.claude/settings.json` to keep more.
- Cursor keeps no token counts on your computer, so it shows messages and AI-written lines, not tokens. Crush stores
  cost but not token totals. Amp keeps its history on its servers, so it can't be read locally.
- "At API prices" is an estimate: it ignores long-context tiers, batch and fast modes.

## Where the numbers come from

Each agent keeps usage on your computer. tokens-wrapped opens those files read-only and keeps only numbers, model
names, tool names and file extensions: [src/local/](src/local/), one small reader per agent.

| Agent | What it reads |
|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl`, subagents and workflow agents included (token counts per reply, tool calls; lines copied into resumed sessions counted once) |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl[.zst]` and `~/.codex/archived_sessions/` (forked sessions don't recount their parent) |
| Cursor | Cursor's `state.vscdb` (messages per chat) and `~/.cursor/ai-tracking` (AI-written lines) |
| OpenCode, Kilo Code | their SQLite databases in `~/.local/share` |
| Cline, Roo Code | the extension's task folders in your editor's storage |
| Pi, Gemini CLI, Qwen Code, Copilot CLI, Droid, Kimi CLI, Goose, Crush | each agent's own session files or database |

"At API prices" multiplies each model's tokens (uncached input, cache reads, cache writes, output) by the
provider's published list price ([src/local/prices.js](src/local/prices.js), with sources and dates). Agents that
store their own cost (OpenCode, Pi) use it as is.

Needs Node 18 or newer; agents that keep a SQLite database (Cursor, OpenCode, Kilo, Goose, Crush) need Node 22.5+, and
Codex's compressed logs need Node 22.15+. Big logs are read on several threads, all on your computer.

Checked against [ccusage](https://github.com/ryoppippi/ccusage) on a heavy user's Claude Code and Codex logs: token
totals agree within 0.2%.
Options: `--no-open`, `--json`, `--no-color`. From source: `git clone`, then `node bin/tokens-wrapped.js`.

## Tests

```sh
npm test
```

[test/trust.test.js](test/trust.test.js) fails the build if any code makes a network request (other than the
recap page's card upload on "Post on X"), writes a file other than the recap page, or adds a dependency.
