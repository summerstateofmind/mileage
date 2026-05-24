# Mileage

**See what your AI coding tools actually cost per shipped feature.**

Mileage is a local-first CLI that correlates your AI token spend with real git outcomes: commits, code survival, and rate-limit hits. It surfaces the bank-statement-for-AI-spend moment. Built for developers spending $100–1,500/mo on AI tools who want helpful data.

```
Mileage  ·  this week  ·  May 16 – May 23
  Plan: Claude Max — 5× ($100/mo)   Scope: all projects

  Tokens used       24,253,539  ▲ +7% vs prior week (22,768,578)
  Outcomes          9 commits shipped  (vs 8 prior week)
  Rate-limit hits   0 this week ✓
  Cost-equivalent   $1,994.97 (informational, your plan is flat-rate)

  Top sessions (by usage)
    10%  Thu 11:38  opus-4-7   1h00m   0 commits  ⚠ waste
     6%  Sun 08:15  opus-4-7   1h19m   0 commits  ⚠ waste
    ...

  Code health       82% alive at 7d   (12 commit evaluations)

  Tier-flex audit (last 30 days)
    opus-4-7   171 sessions   yield 9%   avg $22.26/session
    opus-4-6    25 sessions   yield 0%   avg  $3.79/session

  Patterns I noticed (last 30 days)
  → 26 expensive sessions (>$30) shipped zero commits, 62% of your total spend.

  YPT  38.2 / 100   (`mileage explain ypt` for the breakdown)
```

## Status

V0.3 in active development. Working on the author's machine. Not yet published to npm. **Pre-1.0, install at your own risk.**

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
- No telemetry. No cloud. Nothing leaves your machine.
- Does not call Anthropic OAuth endpoints.

## Install

You need Node 22+ (uses the built-in `node:sqlite`, no native build deps).

```bash
git clone https://github.com/summerstateofmind/mileage.git
cd mileage
npm install
npm run build
npm link
mileage --version
```

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
- **Cap utilization is approximate.** Anthropic doesn't publish exact Max caps. For live, authoritative cap percentages, use `/usage` inside Claude Code.
- **Single-tool support for V0.2 and V0.3.** Claude Code is the only AI tool ingested. Cursor and Copilot are planned for V0.4.

## License

MIT.

## Contributing

Pre-1.0, not actively soliciting contributions yet. File issues if something breaks, especially around the JSONL parser on edge-case sessions.
