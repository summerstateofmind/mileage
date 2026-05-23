# Mileage — See what your AI tools actually cost per shipped feature

## What This Is

Mileage is a local-first CLI that answers the question every dev with a $200+/mo Claude Code or Cursor bill is asking: **"Is this worth what I'm paying?"** It correlates your AI token spend (and dollar cost) with real git outcomes — commits, code survival — and surfaces the bank-statement-for-AI-spend moment. The hero metric is **Cost-per-Ship** in dollars. **YPT (Yield Per Token)** is a sophistication-tier feature for the curious; it's also the Phase 2 standards-play asset (eventual "DORA of AI Coding" spec).

See `docs/research/2026-05-22-icp-and-wedge-analysis.md` for the strategic reframe that drove the Cost-per-Ship pivot. The Mileage→MPG metaphor still maps cleanly: cost-per-ship is "dollars for the distance shipped."

## Target User (ICP)

**The Cost-Conscious Solo Dev.** Spending $100–1,500/mo on AI coding tools. Building real software, often solo or in a tiny team. Has had at least one "wait, I spent HOW much?" moment with their AI bill. Wants concrete dollar answers, not opaque dashboards or vanity metrics.

Profile:
- Commits straight to `main` half the time (no PRs, no CI, no formal review)
- Uses **1–2 AI coding tools** (not 3+ — multi-tool tinkerers are a niche audience, not the wedge)
- An Anthropic-only or ChatGPT-only loyalist is **first-class** — the value is their own cost-over-time, not cross-tool comparison
- Will not install anything that ships their code off the machine

**What this means for product decisions:**
- **Lead with dollars.** `mileage show` opens with `$ spent this week / Cost-per-Ship / top expensive sessions`. If a feature obscures the dollar number, demote it.
- **The bank-statement moment is the first-value moment.** Concrete > clever. A wasteful session that surfaces with a `$84 — 3hr debug, no commits` line beats any abstract score.
- **Git-only must work.** Every core metric has to function with just `git log` + Claude Code JSONL — no GitHub, no CI required. PR/CI are *enrichment*, not requirements.
- **Self-tags > commit counts as outcomes.** Solo dev commits are easy to game; their own tag of "shipped" vs "dead end" is the more honest outcome signal.
- **Privacy is non-negotiable.** Code content never leaves the machine. The product collapses if we cross that line.
- **YPT lives below the fold.** It's the depth feature accessed via `mileage explain ypt` or expanded view — not the front door. Phase 2 publishing work will make it the standard; for now, dogfood it quietly.

## Tech Stack

- **Language:** TypeScript + Node ≥18
- **CLI framework:** commander
- **Database:** SQLite via `better-sqlite3` (synchronous, no async overhead for a CLI)
- **Storage location:** `~/.mileage/metrics.db`
- **Package manager:** npm
- **No frontend yet** — terminal output only. Optional local web UI later.
- **No external APIs in MVP** — git subprocess + local JSONL file reads only.

## Key Files

- `src/cli.ts` — commander entry point, wires subcommands
- `src/ingest/claude_code.ts` — JSONL parser, session boundary detection, dedup
- `src/ingest/git.ts` — `git log --numstat` parser, commit event emitter
- `src/ingest/attribution.ts` — three-tier session→commit linking
- `src/pricing/models.ts` — model→$/token pricing table (V0.2+)
- `src/compute/cost.ts` — token-to-dollar computation (V0.2+)
- `src/compute/ypt.ts` — YPT formula (OckBench-derived V0.1; log-normal CDF V0.3+), snapshot writer
- `src/compute/derived.ts` — Cost-per-Ship, Code Survival, Waste Ratio
- `src/render/show.ts` — terminal output of current metrics
- `src/storage/db.ts` — SQLite schema, migrations, query helpers
- `src/storage/paths.ts` — resolves `~/.mileage/` paths cross-platform

**Reference docs:**
- `docs/research/2026-05-22-icp-and-wedge-analysis.md` — the strategic reframe driving Path A
- `docs/research/2026-05-22-math-and-outcomes-research.md` — math + outcomes literature synthesis (Phase 2 foundation)
- `docs/superpowers/specs/2026-05-22-mvp-design.md` — V0.1 design spec
- `docs/superpowers/specs/2026-05-22-v0.2-cost-wedge-design.md` — V0.2 design spec
- `docs/superpowers/plans/2026-05-22-mvp.md` — V0.1 implementation plan (complete)
- `docs/superpowers/plans/2026-05-22-v0.2-phase1.md` — V0.2 Phase 1 plan with checkboxes
- `ROADMAP.md` — phased version plan

## Architecture

Approach A — Pipeline: **Ingest → Compute → Render**. Three modules with clean interfaces, each independently testable. Ingest writes raw events; Compute reads events and writes snapshots; Render reads snapshots only.

<important if="parsing Claude Code JSONL files">
**JSONL is hostile.** The research found:
- 51–55% of entries are duplicates from streaming chunks — dedup by `messageId` or by `(sessionId, timestamp, content_hash)` is required
- Token count fields are often placeholder `0` or `1` values; prefer `usage.input_tokens` / `usage.output_tokens` from the assistant turn metadata when present
- Session boundaries are detected by **time gaps > 10 minutes**, not by an explicit marker
- Tool-call entries with `tool_name: "Bash"` running `git commit` are the **direct-attribution** signal — parse the tool response for the commit hash with a tight regex on `^\[.+?\s+([a-f0-9]{7,40})\]`

Read ONLY these fields: `timestamp`, `sessionId`, `messageId`, `role`, `usage.*`, `model`, `tool_name`, tool-response strings (regex-extracted, not stored verbatim). Never read or store: `content`, `text`, code blocks, prompt content, file contents echoed in tool inputs.
</important>

<important if="invoking git or shelling out for repo data">
**Privacy line — what's allowed:**
- `git log --numstat --pretty=format:"%H|%ct|%an"` — commit metadata + line counts only
- `git log --name-only` — file paths (extensions used for language inference)
- `git rev-parse HEAD` — commit hash lookups
- `git diff --stat HEAD~1` — line-count deltas

**What's FORBIDDEN:**
- `git show` (reveals diff content)
- `git diff` without `--stat` (reveals diff content)
- `git blame` (would enable line-level rework tracking — crosses the privacy line)
- Reading any file content from the working tree

Rework is tracked at the **file level** only (was `auth.ts` touched twice within 7 days?), never line level.
</important>

<important if="writing or modifying YPT, Cost-per-Ship, or any computed metric">
**Every computed metric MUST store provenance.** Snapshots include a `provenance` JSON field with `formula`, `inputs`, `academic_source` (where relevant). `mileage explain <metric>` reads this back to the user. No black boxes — this is a core trust contract and the Phase 2 standards-play depends on it.

**Cost-per-Ship** is the hero — keep its provenance simple and dollar-denominated:
```
cost_per_ship_usd = total_cost_usd / attributed_outcome_count
```
where `attributed_outcome_count` includes direct- and inferred-tier attributed commits (V0.2). V0.3+ extends to PR-merge and survival-weighted outcomes.

**YPT current formula (V0.1.1; will be replaced in V0.3+):**
```
YPT = (10·direct + 5·inferred) - 5 · log₁₀(tokens / 100,000)
```
This is the OckBench-style log-penalty form, calibrated for daily-token volumes. **Known-broken** — produces negative numbers for normal use; the V0.3 spec replaces it with a log-normal CDF over a composite outcome (survival-weighted attribution + LLM-as-judge intent fulfillment + self-tag overlay). See `docs/research/2026-05-22-math-and-outcomes-research.md` for the math.

Until V0.3, YPT is shown below the fold — Cost-per-Ship is the front-door metric.
</important>

<important if="working on the storage layer or DB schema">
**Snapshots are recomputable.** Never store data in `snapshots` that can't be regenerated by replaying `events`. If you find yourself adding a "fix-up" column, you're doing it wrong — fix the compute layer instead. `mileage rebuild` should always produce identical snapshots from a clean DB.

`project_hash` = SHA256 of the repo's remote URL or absolute path. Lets us segment by project without storing project names.
</important>

## Roadmap

See `ROADMAP.md` for phased versions. See `docs/superpowers/specs/` for design specs and `docs/superpowers/plans/` for task-by-task implementation plans.

## Conventions

### Code Style
- Strict TypeScript. No `any` unless interfacing with a third-party JSONL field that's genuinely untyped — and then narrow it immediately.
- Single-purpose modules. If a file has two exports doing two different things, split it.
- No comments unless they explain *why*. Names should explain *what*.
- **Prefer succinct, simple, fast code.** This is a CLI — sub-second startup matters.

### Quality Gates
- **Re-review code for errors before committing.** Compile check (`npm run build`), spot run the CLI, then commit.
- **Ask the user to test before committing and pushing.** Never auto-commit.
- Build piecewise — one task from the plan, test, commit, then next.

<important if="running build, tests, or the CLI itself">
### Command Output
Keep output lean. When running TypeScript builds, surface errors only. When running the CLI for verification, capture just the final output, not verbose logs. Don't flood context with successful step-by-step traces.
</important>

### Branching
- No remote yet — local-only until V1.0 launch. User is dogfooding.
- When GitHub goes live: `main` = stable, feature branches for major work.

### What NOT to Add Prematurely
- **No web UI / dashboard server.** Terminal output only until users ask. The heatmap renders in the terminal with ANSI colors.
- **No cloud sync.** Local-only is a feature, not a limitation.
- **No telemetry, no analytics, no error reporting that phones home.** Ever.
- **No ORM.** `better-sqlite3` is synchronous and fast; raw SQL is fine for this scope.
- **No Cursor/Copilot ingest in MVP.** Claude Code only. Add others once the core loop works on the user's own data.
- **No multi-user, no auth, no SaaS scaffolding.** Single-user CLI. If we add a team tier, that's a separate product surface.

<important if="planning or implementing a new feature, data source, or multi-step task">
### Research Before Building
Non-trivial features get a spec in `docs/superpowers/specs/` before code. Plans go in `docs/superpowers/plans/` with task-by-task checkboxes. Skip this only for one-file bug fixes. Errors caught at spec stage cost ~1% of errors caught in code.
</important>

## Proactive Guidance

You're not just an executor — actively flag:
- **Product:** features that would make solo-dev dogfooding faster or more honest
- **Technical:** perf wins (CLI startup time, sync speed on large repos), reliability gaps
- **Strategy:** observations from dogfooding that affect the standards-play positioning
- **Process:** automation that would let the user share results publicly with one command (key for the standards-play)

Don't wait to be asked.
