# Mileage

**See what your AI coding tools actually cost per shipped feature.**

Mileage is a local-first CLI that correlates your AI token spend with real git outcomes — commits, code survival, rate-limit hits — and surfaces the bank-statement-for-AI-spend moment. Built for solo developers spending $100–1,500/mo on AI tools who want concrete answers, not opaque dashboards.

```
Mileage  ·  this week  ·  May 16 – May 23
  Plan: Claude Max — 5× ($100/mo)

  Tokens used       24,253,539  ▲ +7% vs prior week (22,768,578)
  Outcomes          9 commits shipped  (vs 8 prior week)
  Rate-limit hits   0 this week ✓
  Cost-equivalent   $1,994.97 (informational — your plan is flat-rate)

  Top sessions this week (by usage):
    10%  Thu 11:38 · opus-4-7 · 1h00m · 0 commits  ⚠ waste
     6%  Sun 08:15 · opus-4-7 · 1h19m · 0 commits  ⚠ waste
    ...

  Code health       82% of AI-attributed lines still alive at 7d

  Tier-flex audit (last 30 days):
    opus-4-7   171 sessions   yield 9%   avg $22.26/session
    opus-4-6    25 sessions   yield 0%   avg  $3.79/session

  Patterns I noticed (last 30 days):
  → 26 expensive sessions (>$30) shipped zero commits — 62% of your total spend.

  For live cap %, run `/usage` in Claude Code.
```

## Status

V0.2 in active development. Working locally on the maintainer's machine; not yet published to npm. **Pre-1.0 — install at your own risk.**

## What it does

Reads metadata from:
- **Claude Code session logs** (`~/.claude/projects/*.jsonl`) — never the conversation content
- **Git history** (`git log --numstat`) — never the diff content
- **`~/.claude/stats-cache.json`** — Claude Code's own daily rollups

Computes:
- **Spend / Cost-per-Ship** (dollars, for API plans)
- **Tokens / Rate-limit-hits / Cost-equivalent** (for flat-rate Pro/Max plans)
- **Tier-flex audit** — Opus vs Sonnet vs Haiku outcome comparison
- **Code Survival Rate** (7-day) — % of AI-attributed lines still alive
- **Behavioral patterns** — time-of-day, model × outcome, recurring waste
- **YPT (Yield Per Token)** — experimental hero metric, currently using OckBench-style log penalty (will be replaced with log-normal CDF in V0.3)

## Privacy contract

- **Never reads code content.** Only metadata: line counts, file extensions, timestamps, token counts, commit hashes.
- Uses `git log --numstat` / `git diff --stat`; never `git show` or content diffs.
- Reads only targeted fields from Claude Code JSONL: `timestamp`, `sessionId`, `requestId`, `usage`, `model`, tool-call commands (regex-extracted for commit hashes only). **Never reads conversation content, prompts, or code blocks.**
- No telemetry. No cloud. No code ever leaves your machine.
- Mileage does **not** call Anthropic OAuth endpoints. For live cap %, run `/usage` in Claude Code itself.

## Install (local)

You need Node 22+ (uses the built-in `node:sqlite` module — no native build deps).

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
# Declare your plan (so the display adapts)
mileage config:set-plan max-100         # or pro / max-200 / api / cursor-pro / copilot

# From any git repo you've worked on with Claude Code:
cd <your-project>
mileage sync --since 30d                # ingest the last 30 days of data
mileage show                            # the dashboard
mileage show --heatmap                  # 90-day calendar
mileage tag                             # interactive: tag recent sessions
mileage review                          # interactive: walk top expensive sessions
mileage report --week                   # copy-pasteable markdown summary

# Optional: install a post-commit hook that auto-syncs after every commit
mileage install-hook
# (uninstall: `mileage uninstall-hook`)

mileage explain ypt                     # show the YPT formula and its inputs
```

## Why "Mileage"

**MPG of AI coding.** Cost-per-Ship is the literal "fuel for the distance shipped." For API users, that's dollars. For Pro/Max users, that's % of your weekly cap (and the rate-limit-hit count is the ground-truth "you ran out of fuel" signal).

## Project shape

This is intentionally a **lifestyle-scale OSS tool**, not a SaaS. There is no team tier, no enterprise edition, no cloud sync planned. If it grows, the path is:

1. **Tool** — useful to individuals, free + MIT
2. **Standards play (long-term)** — a published methodology for measuring AI coding efficiency, grounded in academic research (OckBench, SWE-Effi, GitClear, CodeJudge), with an annual *State of YPT* report
3. **Optional paid tier later** — Quality Mode (opt-in diff-static-analysis), longer history, cross-tool comparison

See `ROADMAP.md` and `docs/research/` for the strategic thinking and the math research that backs YPT.

## Architecture

Three-stage pipeline:

```
Ingest (src/ingest/*)      → Claude Code JSONL, git log, rate-limit detection
Compute (src/compute/*)    → cost, YPT, code survival, tier-flex, patterns
Render (src/render/*)      → plan-aware terminal output, heatmap, markdown report
```

Storage: SQLite via `node:sqlite` at `~/.mileage/metrics.db`. Config at `~/.mileage/config.json`. No native build deps, no daemon, no background processes.

## Caveats

- **Plan auto-detection from `~/.claude/.credentials.json` is intentionally NOT done**, even though the data is there. Anthropic's policy ("Authentication and credential use") restricts third-party use of OAuth tokens, and we want to stay clearly on the safe side of that line. You declare your plan via `mileage config:set-plan`.
- **YPT 0.1.1 produces negative numbers for normal usage.** The current OckBench-style log-penalty formula is the wrong shape for open-ended daily dev work. V0.3 will replace it with a log-normal CDF approach. For now, focus on **Cost-per-Ship** (API users) or **tokens-used + rate-limit-hits + code health** (subscription users).
- **Cap-utilization is approximate.** Anthropic doesn't publish exact Max cap numbers. For live, authoritative cap %, run `/usage` in Claude Code itself.
- **Single-tool support for V0.2.** Claude Code is the only AI tool ingested. Cursor and Copilot are V0.4.

## License

MIT.

## Contributing

Pre-1.0; not actively soliciting contributions yet. File issues if something breaks, especially with the JSONL parser on edge-case sessions.
