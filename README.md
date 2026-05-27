# Mileage

**See what your AI coding tools actually cost per shipped feature.**

Mileage is a local-first CLI that correlates your AI token spend with real git outcomes: commits, code survival, and rate-limit hits. It surfaces the bank-statement-for-AI-spend moment. Built for developers spending $100–1,500/mo on AI tools who want helpful data.

```
Mileage  ·  Last 7 days  ·  May 18 – May 25
  Plan: Claude Max — 5× ($100/mo)   Scope: all projects

  Cap     run /usage in Claude Code for exact, live headroom
  Ship    71 shipped · 0 likely · 104 research
          75% of code alive @7d
  ────────────────────────────────────────────
  Tokens used       41,892,069  ▲ +51% vs prior period
  Rate-limit hits   ⚠ 3 this week  (Mon 13:40, Sun 22:10 …)
  Cost-equivalent   $2,722.48 (informational — flat-rate plan)

  Top sessions (by usage)
    10%  Thu 11:38  opus-4-7   1h00m   8 commits
     5%  Sat 21:44  opus-4-7   1h45m   10 commits

  Tier-flex audit (last 30 days)
    opus-4-7   227 sessions   yield 12%   avg $19.40/session

  YPT  38.2 / 100   (below the fold · `mileage explain ypt`)
```

## Status

V0.3 in active development; published on npm as **`mileage-cli`**. Single-author, dogfooded daily. **Pre-1.0 — expect rough edges.**

## What it does

Reads metadata from:
- **Claude Code session logs** (`~/.claude/projects/*.jsonl`). Never the conversation content.
- **Git history** (`git log --numstat`). Never the diff content.
- **`~/.claude/stats-cache.json`**. Claude Code's own daily rollups, used as a cross-check.

Computes:
- **Spend and Cost-per-Ship** in dollars for API plans
- **Tokens, rate-limit hits, cost-equivalent** for flat-rate Pro and Max plans
- **Tier-flex audit** comparing Opus vs Sonnet vs Haiku outcomes
- **Code Survival Rate** at 7 days and 30 days, the share of AI-attributed lines still alive
- **Behavioral patterns** like time-of-day yield, recurring waste, model and outcome correlations
- **YPT (Yield Per Token)**, a 0 to 100 score for token-to-outcome conversion. V0.3 uses a log-normal CDF with academic anchoring.

## Privacy contract

- **No code content read.** Only metadata: line counts, file paths, timestamps, token counts, commit hashes.
- Uses `git log --numstat` and `git diff --stat`. Not `git show`, not content diffs.
- From Claude Code JSONL, only reads: `timestamp`, `sessionId`, `requestId`, `usage`, `model`, tool-call commands (regex-extracted for commit hashes). Not conversation content, prompts, or code blocks.
- No telemetry, no analytics, no cloud sync. By default, nothing leaves your machine.
- Does not call Anthropic OAuth endpoints.
- **Opt-in judge (off by default):** `mileage judge:enable` lets a model read your *prompts* + tool-action metadata (never code or diffs) for no-commit "research" sessions, to tell productive research from spinning. It uses a **local** model on-device by default; a separate, explicit **cloud opt-in** sends prompts + trajectory only to an endpoint you configure. `mileage judge:disable` turns it off and purges all verdicts.

## Install

You need Node 22+ (uses the built-in `node:sqlite`, no native build deps).

```bash
npm install -g mileage-cli
mileage --version
```

The npm package is **`mileage-cli`**; the command it installs is **`mileage`**. Update anytime with `npm i -g mileage-cli@latest`.

<details><summary>Or from source (for development)</summary>

```bash
git clone https://github.com/summerstateofmind/mileage.git
cd mileage && npm install && npm run build && npm link
```

</details>

## Quickstart

```bash
# Bare command. First run kicks off a 30-second wizard:
# asks your plan, syncs your history, offers to install the post-commit hook.
mileage

# From inside a git repo, it auto-filters to that project.
# From a parent dir that contains tracked projects, it shows them all.
cd ~/projects && mileage          # everything under ~/projects
cd ~/projects/my-app && mileage   # just my-app

# Time window
mileage --week                    # last 7 days (default)
mileage --month                   # last 30 days
mileage --days 14                 # custom

# Explicit subcommands when you want them
mileage sync --since 30d
mileage show
mileage heatmap                   # 90-day calendar
mileage projects                  # list known projects
mileage tag                       # tag recent sessions with context
mileage review                    # walk top expensive sessions
mileage report --week             # copy-pasteable markdown

mileage install-hook              # post-commit auto-sync (per repo)
mileage explain ypt               # formula, calibration, sources
```

The post-commit hook is **prompted, not silent**. The first-run wizard asks before installing anything, and you can install or remove per-repo any time with `install-hook` and `uninstall-hook`.

## Claude Code integration (MCP + skill)

Mileage ships with an MCP server and a Claude Code skill so Claude can read your Mileage data inside a conversation and warn you before you burn your cap.

### MCP server

Add to your Claude Code config (`~/.claude.json` or `~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "mileage": {
      "command": "mileage-mcp"
    }
  }
}
```

Restart Claude Code. The server exposes read tools (`show`, `usage_check`, `top_sessions`, `tier_flex`, `survival`, `patterns`, `projects`, `recent_waste`, `rate_limit_hits`, `explain_ypt`) and one write tool (`tag`, behind per-call confirmation).

### Skill

Copy `.claude/skills/mileage/SKILL.md` from this repo to your `~/.claude/skills/mileage/` (or wherever your Claude Code skills live). The skill auto-triggers when you mention cost, tokens, AI bill, YPT, Opus-vs-Sonnet choices, or start a long/expensive request — and proactively warns you at 50% / 75% of your estimated cap.

If the MCP server is not configured, the skill falls back to running `mileage show --json` over Bash.

### Quick check

```bash
mileage check          # one-shot terminal version of `usage_check`
mileage check --json   # JSON for scripts
```

## Shell completion

Tab-complete commands — `mileage ju⇥` → `mileage judge:enable`. Print a script for your shell and load it from your profile:

```bash
mileage completion pwsh | Out-String | Invoke-Expression   # PowerShell ($PROFILE)
source <(mileage completion bash)                           # bash (~/.bashrc)
source <(mileage completion zsh)                            # zsh (~/.zshrc)
```

> **Testers wanted:** PowerShell completion is solid; **bash/zsh completion is new** — the `:` in commands like `judge:enable` is a bash word-break we strip by hand, so edge cases may remain. If it misbehaves in your shell, please open an issue. (An easy, friendly first contribution.)

## Why "Mileage"

MPG of AI coding. Cost-per-Ship is the literal "fuel for the distance shipped." For API users that's dollars per commit. For Pro and Max users it's tokens-per-commit, with rate-limit hits as the ground-truth "you ran out of fuel" signal.

## Project shape

OSS, MIT, single-user CLI. No team tier, no cloud, no SaaS scaffolding. If it grows, the plan is:

1. **Tool**: useful to individual devs, free and MIT
2. **Methodology**: a published spec for measuring AI coding efficiency, grounded in the research that's been done (OckBench, SWE-Effi, GitClear, CodeJudge, DORA 2025)
3. **Optional paid layer later**: Quality Mode (opt-in diff-aware analysis), cross-tool comparison, longer history

See `ROADMAP.md` for the version plan and `docs/research/` for the math.

## Architecture

Three-stage pipeline.

```
Ingest (src/ingest/*)      → Claude Code JSONL, git log, rate-limit detection
Compute (src/compute/*)    → cost, YPT, code survival, tier-flex, patterns
Render (src/render/*)      → plan-aware terminal output, heatmap, markdown report
```

Storage: SQLite via `node:sqlite` at `~/.mileage/metrics.db`. Config at `~/.mileage/config.json`. No native build deps, no daemon, no background processes.

## Caveats

- **Plan auto-detection from `~/.claude/.credentials.json` is intentionally NOT done**, even though the data is there. Anthropic's "Authentication and credential use" policy restricts third-party use of OAuth tokens, and we want to stay clearly on the safe side of that line. Declare your plan via `mileage init` or `mileage config:set-plan`.
- **Cap utilization is not estimated.** Anthropic's real limit accounting is unpublished and weights cache tokens, so Mileage deliberately does not show a cap % — an estimate would only contradict the truth. Mileage tracks token volume and when you actually hit the wall (rate-limit hits, de-duplicated into distinct events); for live cap %, use `/usage` inside Claude Code.
- **Single-tool support for V0.2 and V0.3.** Claude Code is the only AI tool ingested. Cursor and Copilot are planned for V0.4.

## License

MIT.

## Contributing

Pre-1.0, not actively soliciting contributions yet. File issues if something breaks, especially around the JSONL parser on edge-case sessions.
