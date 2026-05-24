# Mileage — Engineering Roadmap

## Context

**Strategy: Path A** (decided 2026-05-22). Lead with **Cost-per-Ship in dollars** as the wedge. Build YPT as a Phase 2 standards-play asset (published spec + annual report) in parallel to dogfooding. Personal brand + acquihire as primary revenue outcomes; lifestyle SaaS as floor. See `docs/research/2026-05-22-icp-and-wedge-analysis.md` for the strategic reframe and the research that drove it.

**ICP:** Cost-Conscious Solo Dev. $100–1,500/mo on AI tools, building real software, has had "wait I spent HOW much?" moments. Uses 1–2 AI tools (not 3+). Wants concrete dollar answers.

**The moat: published methodology + privacy-by-default architecture + first-mover credibility on cost-honest measurement.** Anyone can build a token tracker. Nobody else is grounding the metrics in academic literature while keeping code on-device and refusing to compete on team SaaS dimensions.

**Current version:** V0.1 complete (sync + show + explain working on author's local data). V0.2 Phase 1 in progress (cost-wedge).
Run the CLI: `mileage sync && mileage show`

---

## Immediate

### V0.2 Phase 1 — The cost wedge

Make `mileage show` lead with dollar spend and Cost-per-Ship. Surface the most expensive sessions of the week. Flag waste sessions (high cost, zero attributed commits). See `docs/superpowers/plans/2026-05-22-v0.2-phase1.md`.

- [ ] **0.2.1** — Pricing table (`src/pricing/models.ts`) for current Anthropic/OpenAI/Google models, with cache-creation and cache-read weights
- [ ] **0.2.2** — Compute USD cost per session from token usage + model + pricing table
- [ ] **0.2.3** — Restructure `mileage show` output: dollar spend leads, Cost-per-Ship is the headline, YPT moves to below-the-fold
- [ ] **0.2.4** — "Top N expensive sessions this week" with timestamps and short descriptions (where + when)
- [ ] **0.2.5** — Waste-session detection (cost > threshold AND zero attributed commits AND no self-tag) — surface with warning
- [ ] **0.2.6** — Per-session storage of computed cost so `show` is fast and recomputable
- [ ] **0.2.7** — End-to-end verification on user's real data; check whether the "bank statement" moment lands viscerally

### V0.2 Phase 2a — Max-plan wedge (COMPLETE 2026-05-23)

See `docs/superpowers/plans/2026-05-23-v0.2-phase2a.md` and `docs/superpowers/specs/2026-05-23-v0.2-phase2-design.md`. Strategic context in `docs/research/2026-05-23-oauth-policy-findings.md` (key finding: `/api/oauth/usage` exists but is policy-prohibited; we use local files instead).

- [x] **0.2.a1** — `mileage config:set-plan` + `~/.mileage/config.json` (api / pro / max-100 / max-200 / cursor-pro / copilot / unknown)
- [x] **0.2.a2** — Rate-limit hit detection in JSONL (tightened patterns; 0 false positives on author's data)
- [x] **0.2.a3** — stats-cache.json reader (supplemental data source)
- [x] **0.2.a4** — Tier-flex audit (compute + warning logic)
- [x] **0.2.a5** — Plan-aware `mileage show`: API view (dollars lead) / Subscription view (tokens + cap-equivalent + rate-limit hits prominent) / Unknown view (banner prompt)
- [x] **0.2.a6** — Verified end-to-end on author's Max-100 data — 196 sessions, 100 commits, 0 false-positive rate-limit hits

### V0.2 Phase 2b — Sticky behavioral features (COMPLETE 2026-05-23)

- [x] **0.2.b1** — `mileage tag` (interactive single-keypress tagging: shipped / exploring / debugging / dead-end)
- [x] **0.2.b2** — `mileage install-hook` / `uninstall-hook` (cross-platform: bash for *nix, .cmd for Windows)
- [x] **0.2.b3** — Behavioral pattern detection (time-of-day, day-of-week, model × outcome, long-expensive-zero-commit)
- [x] **0.2.b4** — Code Survival Rate 7d (file-level approximation; pulled forward from V0.3). Verified: 82% survival on author's data over 12 commits.

### V0.2 Phase 2c — Visual polish + brand artifact (COMPLETE 2026-05-23)

- [x] **0.2.c1** — Heatmap renderer (`mileage show --heatmap`, ANSI 256-color, 90-day grid, color = efficiency)
- [x] **0.2.c2** — Sparkline + bar chart helpers (`src/render/charts.ts`)
- [x] **0.2.c3** — `mileage report --week` — copy-pasteable markdown summary (the brand-building artifact)
- [x] **0.2.c4** — `mileage review` — interactive weekly forcing function

---

## Completed Milestones

<details>
<summary><strong>V0.1 — Works on my terminal (COMPLETE 2026-05-22)</strong> — click to expand</summary>

Smallest demonstrable thing the user can run to see a real number computed from their own data. See `docs/superpowers/plans/2026-05-22-mvp.md`.

- [x] **0.1.1** — Project skeleton, package.json, tsconfig
- [x] **0.1.2** — SQLite schema (events + snapshots + attributions tables); switched from better-sqlite3 to `node:sqlite` (built into Node 22+, zero native build deps)
- [x] **0.1.3** — Claude Code JSONL parser; dedup by `requestId`, sessionizes by 10-min gaps, excludes `cache_read_input_tokens` from the spend count
- [x] **0.1.4** — Git parser via `git log --numstat`
- [x] **0.1.5** — Direct + Inferred attribution (High tier deferred to V0.2 hook)
- [x] **0.1.6** — YPT compute, recalibrated for developer-daily token volumes (V0.1.1 formula: `(10·direct + 5·inferred) - 5·log₁₀(tokens / 100,000)` — log-penalty form, known to produce negative values; will be replaced in V0.3)
- [x] **0.1.7** — `mileage show` and `mileage explain ypt` terminal output
- [x] **0.1.8** — Verified end-to-end on author's machine — 177 sessions across 36 JSONL files, 95 commits, 16 attributions

</details>

<details>
<summary><strong>Pre-V0.1 — Strategy, naming, math deep-dive (COMPLETE 2026-05-22)</strong> — click to expand</summary>

- Pivoted from PostHog-style team SaaS to "DORA of AI Coding" + WakaTime-lifestyle two-path strategy
- Locked architecture: Approach A pipeline (Ingest → Compute → Render), SQLite, three-tier attribution, self-tag outcome system, privacy-by-default with opt-in Quality Mode
- Named the thing: **Mileage** (product) + **YPT (Yield Per Token)** (metric)
- Deep math+outcomes research (4 parallel agents) surfaced limits of YPT-as-wedge and identified Cost-per-Ship as the better wedge
- Strategic pivot to **Path A**: Cost-per-Ship leads, YPT becomes Phase 2 standards-play asset, personal brand + acquihire as primary outcomes

</details>

---

## V0.3 — Honest YPT + Quality Mode foundations

The math upgrade and the first crossing of the diff-reading line (opt-in only).

### Phase 1: YPT v2 math
- [ ] **0.3.1** — Replace V0.1.1 log-penalty formula with **log-normal CDF over yield_rate** anchored to two empirical control points (Lighthouse pattern). See research doc.
- [ ] **0.3.2** — Bayesian shrinkage from literature prior during cold start
- [ ] **0.3.3** — Stratification by tool/model in YPT computation
- [ ] **0.3.4** — Validity predicate (don't score sessions below threshold; report "not scored" instead of 0)
- [ ] **0.3.5** — `mileage explain ypt` upgraded to show formula, literature anchors, version stamp (`YPT-2026.1`)

### Phase 2: Code Survival Rate (proper)
- [ ] **0.3.6** — File-level survival tracking — % AI-attributed lines alive at 30 days
- [ ] **0.3.7** — Background recompute job for 7d/30d survival snapshots

### Phase 3: Quality Mode (opt-in, crosses the diff-read line)
- [ ] **0.3.8** — `mileage enable quality-mode` — explicit opt-in, prints exactly what gets read and where
- [ ] **0.3.9** — Cognitive complexity delta on touched functions (via tree-sitter + lizard)
- [ ] **0.3.10** — jscpd duplication detection on diffs vs repo
- [ ] **0.3.11** — Semgrep diff-aware anti-pattern scanning with conservative ruleset
- [ ] **0.3.12** — LLM-as-judge intent fulfillment (local Qwen 3 7B via Ollama or similar) — opt-in inside Quality Mode

---

## V0.4 — Cross-tool + enrichment

For users who want to compare or have GitHub data.

- [ ] **0.4.1** — `mileage connect github` — PAT in OS keychain; PR merge + review-round enrichment
- [ ] **0.4.2** — CI pass/fail via GitHub Checks API
- [ ] **0.4.3** — Cursor log ingestion
- [ ] **0.4.4** — Copilot metrics API ingestion
- [ ] **0.4.5** — `mileage compare-tools` — Cost-per-Ship and YPT by tool/model

---

## V1.0 — Public launch + standards-play opening

Domain bought; OSS public; first State-of-YPT publishing milestone.

- [ ] **1.0.1** — Domain registration (`mileage.dev`; verify USPTO TM clear first)
- [ ] **1.0.2** — GitHub org (`github.com/mileage-cli`) + public repo
- [ ] **1.0.3** — npm publish (`@mileage/cli` scoped — `mileage` is a 2018 squat)
- [ ] **1.0.4** — Landing page (mileage.dev) — leads with Cost-per-Ship story, YPT spec linked
- [ ] **1.0.5** — **YPT Spec v1** — public methodology document, citations, current calibration, version stamped
- [ ] **1.0.6** — Show-HN launch with "see what your Claude bill actually buys" framing
- [ ] **1.0.7** — Personal-brand content series: weekly dogfooding posts, surprising findings, the cost-honest argument

---

## V2.0+ — State of YPT (Phase 2 standards-play)

The annual publishing rhythm that builds the standards-play asset. Targets 18+ months from V1.0 launch.

- [ ] **2.0.1** — First annual *State of YPT* report — even with N=1 (dogfooding) data initially
- [ ] **2.0.2** — Opt-in anonymized data sharing for users who want to contribute to the report
- [ ] **2.0.3** — Conference talks + podcast circuit
- [ ] **2.0.4** — Concordance tables when calibration shifts year-over-year

---

## Deprioritized

Explicitly NOT being built. Captured so we don't re-litigate.

- **Web dashboard / hosted UI:** Terminal-only ships faster, fits ICP better, removes hosting burden.
- **Cloud sync of metrics:** Privacy story dies. Local-only is a feature.
- **Team SaaS with SSO/RBAC/SOC2:** Wrong game for a solo builder. DX Core 4 owns this category.
- **Per-seat $15–20/mo pricing:** Mid-market is already filling.
- **Line-level rework tracking:** Requires `git blame` which reads file content. Crosses privacy line.
- **Real-time prompt optimizer:** Out of scope — defeats privacy.
- **Reading prompt content from JSONL for "session quality" scoring:** Same — defeats privacy.
- **Telemetry / error reporting that phones home:** Never. Even opt-in.
- **Multi-tool comparison as the launch wedge:** Reframed in V0.4 as enrichment, not the front door — most users are single-tool loyalists.
- **"DORA of AI Coding" as launch positioning:** That's V2.0+ publishing work. Launch is "see what your AI bill buys" — the standards-play asset is built later.

## Backlog

- [ ] `mileage export` — JSONL or CSV dump of own data (data portability)
- [ ] `mileage diff <commit1> <commit2>` — Cost-per-Ship across two points in history
- [ ] Per-language Cost-per-Ship and YPT breakdown
- [ ] Honesty audit: cross-correlate self-tags vs auto-proxies to validate proxy quality per user
- [ ] Logical/evolutionary coupling metric (files that change together) — research flagged this as an underrated differentiation signal

---

## Reference Notes

**Competitive landscape (2026-05-22 sweep, updated post-research):**
- **WakaTime** — closest precedent; tracks tokens + AI vs human lines, but no outcome correlation, no academic metrics. Possible acquihire target.
- **CodeBurn (OSS, ~5.7K stars)** — has "yield" feature via timestamp correlation. Inferior attribution; no quality scoring. **Most direct competitor in the same niche as Mileage.** Open-source so we can watch them.
- **ccusage (OSS, ~14K stars)** — read-only cost tracker; no outcomes at all.
- **Waydev / Larridin / Exceeds AI** — enterprise outcome-correlation, $50K–$500K/yr. Different ICP.
- **DX Core 4 (Forsgren et al.)** — most credible competitor philosophically; **explicitly rejects single-scalar individual-dev metrics.** We sidestep by scoping Mileage as "personal-efficiency lens, not HR tool." Direct competitor for the standards-play.
- **Hivel ($20/user/mo) / Codemetrics ($10/user/mo)** — mid-market team SaaS. Crowded — we're avoiding this lane.

**Architecture principle:** Every metric must work git-only. PR/CI/GitHub data is enrichment, never a requirement. If the solo dev committing straight to main can't get value, the product is broken.

**Wedge principle:** Lead with dollars. Cost-per-Ship is the visceral first-value moment. YPT is below the fold.

**Standards-play principle (Phase 2):** Annual recalibration discipline, versioned spec, concordance tables, anonymized opt-in data. The published methodology is the asset.

**Privacy principle:** Code content never leaves the machine. Crossing this line destroys the trust moat.

**Brand principle:** Personal brand is a primary outcome, not a side-effect. Public dogfooding posts, conference talks, the published spec — these are the work, not optional polish.
