# Mileage Roadmap

**Wedge:** Cost-per-Ship in dollars for API users. Tokens-per-Ship + rate-limit hits for subscription users. YPT (Yield Per Token) is the depth metric; available via `mileage explain ypt`.

**Target user:** Solo developer spending $100–$1,500/month on AI coding tools, using one or two tools (not three or more), who's had the "wait, I spent HOW much?" moment with their bill. Wants concrete dollar answers, not a dashboard.

**Architecture rule:** Every metric must work git-only. PR, CI, and GitHub-side data are enrichment, never required. If a solo dev committing straight to main can't get value, the product is broken.

**Privacy rule:** Code content never leaves the machine. Crossing this line breaks the trust contract the product is built on.

**Current version:** V0.4 in progress (MCP server + skill + cap warnings shipped; awaiting verification on real cap-strain). V0.3 Phase 1+2 shipped (YPT v2 math, Code Survival 30d). V0.2 shipped. V0.1 shipped.
Run the CLI: `mileage`

---

## Next sprint

### V0.4 — Claude integration (MCP + Skill + cap-warning loop)

Closes the behavior loop. Mileage data becomes consumable by Claude itself, and the skill proactively warns the user before they burn their cap.

**Why this before Quality Mode:** the current data already supports useful behavior change (tier-flex, waste detection, survival). What's missing is an *agent that acts on it during the session, not after.* MCP + skill is also a ~1–2 hour build vs Quality Mode's 5–10 hours of dep work, so we learn faster what to invest in next.

#### MCP server
- [x] **0.4.1** — `mileage-mcp` second binary, registered via Model Context Protocol SDK
- [x] **0.4.2** — Read tools: `show`, `explain_ypt`, `top_sessions`, `tier_flex`, `survival`, `patterns`, `projects`, `recent_waste`, `rate_limit_hits`
- [x] **0.4.3** — Write tools (behind Claude's per-call confirmation): `tag(session_id, tag)`
- [x] **0.4.4** — `usage_check` tool: returns 5-hour and 7-day rolling token use as % of estimated plan cap (Pro ≈ 5M, Max-100 ≈ 25M, Max-200 ≈ 100M per 5h; community-approximated, labeled as estimate). Warning levels: ok / soft / strong / over.
- [x] **0.4.5** — Install docs in README: how to add to `~/.claude.json` or Claude Desktop config
- [x] **0.4.6** — `mileage show --json` flag for non-MCP consumers (skill fallback over Bash)

#### Skill
- [x] **0.4.7** — Claude Code skill that auto-triggers when the user mentions cost, tokens, AI bill, YPT, or "should I use Opus/Sonnet for this"
- [x] **0.4.8** — Skill uses MCP if available, falls back to parsing `mileage show --json` over Bash
- [x] **0.4.9** — **Cap-warning hook**: skill checks `usage_check` before responding to long-running or Opus requests. At ≥50% → soft warning + suggested cheaper alternative. At ≥75% → strong warning + concrete recommendation (switch to Sonnet, batch the work, take a break until reset).
- [x] **0.4.10** — `mileage check` standalone command: one-shot version of `usage_check` for terminal use
- [x] **0.4.11** — Proactive suggestion templates: "your tier-flex audit suggests Sonnet first," "this looks like a waste pattern you tagged before," "you're at 60% of your 5-hour cap"

---

## Up next

### V0.4.5 — Ambient cap nudges (Ring 3 Lite, flat-rate plans only)

Always-on safety net for cap pressure. Fires desktop notifications when the user crosses meaningful thresholds, independent of whether a Claude conversation is happening. Quiet by default.

**Scope decision:** API plans are NOT in scope here. They get value from $-based runaway alerts which need a different framing. V0.4.5 is for `pro`, `max-100`, `max-200`.

#### Cap-threshold trigger (ship first)
- [ ] **0.4.5.1** — `mileage watch` daemon command (polls every 5 min, runs until Ctrl-C)
- [ ] **0.4.5.2** — Cross-platform desktop notification (`node-notifier`)
- [ ] **0.4.5.3** — Fire on honest signals, NOT a cap % (Mileage doesn't compute one — see `computeUsageCheck`): (a) a new clustered `recent_rate_limit_hits` event since last poll, and (b) 7d token volume crossing a multiple of the heavy-day p90 baseline. One-shot per event — don't refire on the same event.
- [ ] **0.4.5.4** — Plan filter: skip when `plan` is `api`, `unknown`, `cursor-pro`, `copilot`
- [ ] **0.4.5.5** — Notification content: single line with concrete action, e.g. "Mileage: you just hit Anthropic's rate limit. Run /usage, then /model sonnet or pause." Never invent a % or reset time.
- [ ] **0.4.5.6** — `mileage config:set-quiet-hours 22-07` to suppress notifications overnight

#### Velocity trigger (ship after dogfooding the cap trigger)
- [ ] **0.4.5.7** — "Long-hard session" heuristic: ≥3 hours continuous (no 30+ min gap between sessions), ≥3M tokens cumulative. Tune the thresholds against the author's real notification log over 1–2 weeks first.
- [ ] **0.4.5.8** — Gentle wording: "3h continuous session at high burn — want to step back?" (not a blocker, single-line)
- [ ] **0.4.5.9** — Velocity-trigger dedup: don't refire within 90 min

#### Optional persistence
- [ ] **0.4.5.10** — `mileage watch --install` to register as a startup task (Windows Task Scheduler / launchd / systemd). Opt-in, not automatic.

---

### V0.5 — Quality Mode (opt-in, crosses the diff-read line)

The first feature that reads diff content, gated behind an explicit opt-in. Adds quality signals to the YPT composite.

- [ ] **0.5.1** — `mileage enable quality-mode`: explicit opt-in flow, prints exactly what gets read and where, requires typed confirmation
- [ ] **0.5.2** — Cognitive complexity delta on touched functions, via tree-sitter + lizard
- [ ] **0.5.3** — jscpd duplication detection on diffs vs repo
- [ ] **0.5.4** — Semgrep diff-aware anti-pattern scanning with a conservative ruleset
- [ ] **0.5.5** — LLM-as-judge intent fulfillment via local Qwen 3 7B (Ollama)

Dependencies: tree-sitter, lizard, jscpd, semgrep, Ollama with ~5GB model download. Heavy install. Worth its own session.

---

## Completed

<details>
<summary><strong>V0.3 Phase 1+2 — YPT v2 math + Code Survival 30d (COMPLETE 2026-05-23)</strong></summary>

Replaces the V0.1.1 log-penalty formula with a log-normal CDF over composite outcomes. Adds 30-day survival.

- [x] **0.3.1** — Log-normal CDF over composite yield_rate, anchored to two empirical control points (Lighthouse pattern). Initial calibration: μ=ln(0.5), σ=1.26, anchor "P50→50, P10→90".
- [x] **0.3.2** — Bayesian shrinkage from literature prior during cold start. `shrinkCalibration` in `src/compute/calibration.ts`. N_prior=100. Pure-prior at N=0.
- [x] **0.3.3** — Stratification by model. Per-model yield_rate and score stored in `provenance.by_model`. Overall is session-weighted average.
- [x] **0.3.4** — Validity predicate. Sessions tagged `exploring` excluded from the denominator. Days with no scorable sessions report `ypt_score = null` (rendered as "not scored").
- [x] **0.3.5** — `mileage explain ypt` rewritten: formula + variable glossary, calibration, per-model breakdown, citations, version stamp `YPT-2026.1`.
- [x] **0.3.6** — File-level survival evaluated for both 7d and 30d windows on each sync. 30d feeds the YPT survival_weight when available, falling back to 7d.
- [x] **0.3.7** — Background recompute. `updateSurvivalForCwd(db, cwd, [7, 30])` catches up any commit old enough but not yet evaluated for either window.

See `docs/superpowers/specs/2026-05-23-v0.3-design.md` and `docs/superpowers/plans/2026-05-23-v0.3-phase1-2.md`.

</details>

<details>
<summary><strong>V0.2.5 — First-run polish + project naming (COMPLETE 2026-05-23)</strong></summary>

Made the install feel like a real CLI instead of a dev-mode script.

- [x] Bare `mileage` command: smart default that auto-syncs if stale, auto-filters to cwd's project if known, prints the dashboard
- [x] First-run wizard: asks plan, syncs history, offers post-commit hook install (prompted, not silent)
- [x] `mileage init` re-runs the wizard on demand
- [x] Project naming: local `projects` table maps hash → name + path; "By project" panel shows names; `mileage projects` lists known projects
- [x] CWD auto-filter: bare `mileage` from inside a tracked repo scopes to that project; from a parent dir, aggregates across descendants
- [x] `mileage tag` shows project, attributed and nearby commits, files touched, with `[i] info` for deeper context
- [x] `--week`, `--month`, `--days N` flags for window control
- [x] `mileage heatmap` as a dedicated subcommand

</details>

<details>
<summary><strong>V0.2 — Cost wedge + Max-plan wedge + behavioral features + visual polish (COMPLETE 2026-05-23)</strong></summary>

**Phase 1 — Cost wedge.** Made `mileage show` lead with dollar spend and Cost-per-Ship. Surfaced top expensive sessions and flagged waste.

- [x] Pricing table for current Anthropic, OpenAI, Google models with cache-creation and cache-read weights
- [x] USD cost per session from token usage + model + pricing
- [x] `mileage show` restructured: dollars lead, Cost-per-Ship is the headline, YPT below the fold
- [x] Top N expensive sessions per week with timestamps and short descriptions
- [x] Waste-session detection (high cost + zero attributed commits + no self-tag)
- [x] Per-session cost storage so `show` is fast and recomputable
- [x] End-to-end verification on the author's real data

**Phase 2a — Max-plan wedge.** Plan-aware output that doesn't depend on dollar framing.

- [x] `mileage config:set-plan` + `~/.mileage/config.json` (api / pro / max-100 / max-200 / cursor-pro / copilot / unknown)
- [x] Rate-limit hit detection from JSONL with zero false positives on the author's data
- [x] `stats-cache.json` reader as a supplemental data source
- [x] Tier-flex audit
- [x] Plan-aware `show`: API view (dollars) / Subscription view (tokens + rate-limit hits) / Unknown view (banner prompt)
- [x] Verified on the author's Max-100 data: 196 sessions, 100 commits, 0 false-positive rate-limit hits

**Phase 2b — Behavioral features.**

- [x] `mileage tag`: single-keypress tagging (shipped / exploring / debugging / dead-end)
- [x] `mileage install-hook` / `uninstall-hook` (cross-platform: bash for *nix, .cmd for Windows)
- [x] Behavioral pattern detection (time-of-day, day-of-week, model × outcome, long-expensive-zero-commit)
- [x] Code Survival Rate 7d (file-level approximation, pulled forward from V0.3). Verified: 82% survival on the author's data over 12 commits.

**Phase 2c — Visual polish + artifacts.**

- [x] Heatmap renderer (90-day grid, ANSI 256-color, color = efficiency)
- [x] Sparkline + bar chart helpers (`src/render/charts.ts`)
- [x] `mileage report --week`: copy-pasteable markdown summary
- [x] `mileage review`: interactive weekly forcing function

</details>

<details>
<summary><strong>V0.1 — Works on my terminal (COMPLETE 2026-05-22)</strong></summary>

Smallest demonstrable thing the author could run to see a real number computed from their own data.

- [x] Project skeleton, package.json, tsconfig
- [x] SQLite schema (events + snapshots + attributions). Uses `node:sqlite` (built into Node 22+, no native build deps).
- [x] Claude Code JSONL parser. Dedup by `requestId`, sessionizes by 10-min gaps, excludes `cache_read_input_tokens` from the spend count.
- [x] Git parser via `git log --numstat`
- [x] Direct + Inferred attribution (High-tier deferred to V0.2 hook)
- [x] YPT compute (V0.1.1 formula, known broken, replaced in V0.3)
- [x] `mileage show` and `mileage explain ypt` terminal output
- [x] Verified on author's machine: 177 sessions across 36 JSONL files, 95 commits, 16 attributions

</details>

---

## V0.6 — Cross-tool + enrichment

For users who want to compare tools or have GitHub data available.

- [ ] **0.6.1** — `mileage connect github`: PAT in OS keychain, PR-merge and review-round enrichment
- [ ] **0.6.2** — CI pass/fail via GitHub Checks API
- [ ] **0.6.3** — Cursor log ingestion
- [ ] **0.6.4** — Copilot metrics API ingestion
- [ ] **0.6.5** — `mileage compare-tools`: Cost-per-Ship and YPT by tool and model

---

## V1.0 — Public launch

Domain, npm publish, public repo, landing page.

- [ ] **1.0.1** — Domain (`mileage.dev`, verify USPTO trademark clear first)
- [ ] **1.0.2** — GitHub org (`github.com/mileage-cli`) + public repo
- [ ] **1.0.3** — npm publish (`@mileage/cli`, scoped since `mileage` is a 2018 squat)
- [ ] **1.0.4** — Landing page (leads with the Cost-per-Ship story, links the YPT spec)
- [ ] **1.0.5** — **YPT Spec v1**: public methodology document with citations, current calibration, version stamp
- [ ] **1.0.6** — Show-HN launch
- [ ] **1.0.7** — Weekly dogfooding posts on findings

---

## V2.0+ — State of YPT

Annual publishing rhythm. Targets 18+ months from V1.0.

- [ ] **2.0.1** — First annual *State of YPT* report
- [ ] **2.0.2** — Opt-in anonymized data sharing for users who want to contribute
- [ ] **2.0.3** — Conference talks
- [ ] **2.0.4** — Concordance tables when calibration shifts year-over-year

---

## Not building (and why)

Captured so we don't re-litigate.

- **Web dashboard / hosted UI.** Terminal-only ships faster, fits the ICP, removes hosting burden.
- **Cloud sync of metrics.** Local-only is a feature, not a limitation.
- **Team SaaS with SSO/RBAC/SOC2.** Wrong game for a solo builder. DX Core 4 owns this category.
- **Per-seat $15–20/mo pricing.** Mid-market is crowded.
- **Line-level rework tracking.** Requires `git blame` which reads file content. Crosses the privacy line.
- **Real-time prompt optimizer.** Defeats privacy.
- **Reading prompt content from JSONL for "session quality" scoring.** Defeats privacy.
- **Telemetry or error reporting that phones home.** Never. Not even opt-in.
- **Multi-tool comparison as the launch wedge.** Most users are single-tool loyalists. V0.4 frames it as enrichment.
- **"DORA of AI Coding" as launch positioning.** That's V2.0+. Launch is "see what your AI bill buys"; the spec is the asset.

## Backlog

- [ ] `mileage export`: JSONL or CSV dump of own data (data portability)
- [ ] `mileage diff <commit1> <commit2>`: Cost-per-Ship across two points in history
- [ ] Per-language Cost-per-Ship and YPT breakdown
- [ ] Honesty audit: cross-correlate self-tags vs auto-proxies to validate proxy quality per user
- [ ] Logical / evolutionary coupling metric (files that change together). Research flagged this as an underrated signal.

---

## Reference notes

**Competitive landscape (last swept 2026-05-22):**
- **WakaTime.** Closest precedent. Tracks tokens and AI vs human lines, but no outcome correlation, no academic metrics.
- **CodeBurn (OSS, ~5.7K stars).** Has a "yield" feature via timestamp correlation. Inferior attribution; no quality scoring. Open-source, easy to watch.
- **ccusage (OSS, ~14K stars).** Read-only cost tracker; no outcomes.
- **Waydev, Larridin, Exceeds AI.** Enterprise outcome-correlation, $50K–$500K/yr. Different ICP.
- **DX Core 4 (Forsgren et al.).** The most credible competitor philosophically. **Explicitly rejects single-scalar individual-dev metrics.** Mileage sidesteps by scoping as a personal-efficiency lens, not an HR tool.
- **Hivel ($20/user/mo), Codemetrics ($10/user/mo).** Mid-market team SaaS. Crowded.
