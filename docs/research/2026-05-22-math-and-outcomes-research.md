# YPT Math + Outcomes Research Synthesis

**Date:** 2026-05-22
**Status:** Foundational research for V0.3+ standards-play
**Source:** Four parallel research agents covering academic literature on AI coding efficiency, code quality measurement from diffs, bounded-score construction methodology, and SPACE/DORA/outcome attribution research.

This document distills what the research found into the load-bearing claims for Phase 2 (the published YPT specification). Full agent outputs are in the session transcript that produced this work; the citations below are the load-bearing ones.

---

## 1. The diagnosis: OckBench-style log-penalty is the wrong family

The shape `Accuracy − 10·log₁₀(tokens / 10⁴)` (OckScore, arxiv 2511.05722) was designed for **fixed-scope benchmark problems** where every task has the same target. Three structural failures break it for open-ended developer work:

1. **The "10,000-token anchor" is hard-coded to benchmark task sizes.** Daily work has token budgets spanning 5+ orders of magnitude across tasks. The metric is not scale-invariant.
2. **Additive across incommensurable units.** Accuracy ∈ [0,1] minus log(tokens) (unbounded) puts two unit-incompatible quantities on the same line. Produces negative numbers as a normal outcome.
3. **Linear-in-log assumes constant elasticity of "wasted tokens → score reduction."** Empirically, marginal token value is highly non-monotonic — the early-stopping literature ([Conformal Thinking arxiv 2602.03814](https://arxiv.org/pdf/2602.03814)) shows most reasoning chains converge at ~60% of tokens, so the last 40% has near-zero marginal yield.
4. **Dictator problem.** A single 1M-token agent run dominates weeks of efficient work in any sum-based aggregation.

This is why our V0.1.1 `(10·direct + 5·inferred) − 5·log₁₀(tokens / 100,000)` formula produces negative numbers for normal usage despite recalibration. The shape is wrong, not the constants.

---

## 2. The right mathematical shape

After surveying MM/Hill curves, CDF-based percentile scoring, DORA cluster analysis, NPS, Lighthouse, EPA fuel economy ratings, IRT, and information-theoretic alternatives, the most defensible construction for a bounded 0–100 rating over a yield rate is:

### Log-normal CDF with two-point empirical anchoring

This is the Lighthouse pattern, applied to developer YPT:

```
yield_rate    = composite_outcomes / (tokens / 100,000)
score(r)      = 100 × Φ((ln r − ln μ) / σ)
```

Where:
- `Φ` is the standard normal CDF.
- `(μ, σ)` are anchored to **two empirical control points**, e.g., P50→50 and P10→90.
- Solving two equations in two unknowns gives unique `(μ, σ)`.

**Why log-normal:** processes that are products of many small effects (developer skill × task type × model quality × prompt structure × ...) are log-normally distributed by the multiplicative central limit theorem ([Limpert/Stahel/Abbt 2001, *BioScience* 51:341](https://academic.oup.com/bioscience/article/51/5/341/243981)). Token yield rates fit this prior well.

**Why two-point anchoring:** lets us tune both "where is the median" AND "how steep is the curve" without needing to estimate the full distribution. Lighthouse uses (P50→0.5, P25→0.9). For YPT a reasonable initial setting is (P50→50, P10→90) — "median is 50, top decile is 90."

### Bayesian shrinkage solves cold start

Before we have users, anchor `(μ, σ)` from literature priors. As real data arrives, shrink toward the empirical estimate with weight `w_prior = N₀ / (N₀ + N)` where `N₀` is a pseudo-sample size (say 100) reflecting confidence in the prior. After 10,000 users the score is essentially empirical; before 100 it's essentially the prior. This is the James-Stein shrinkage pattern; Andrew Gelman's literature is the reference.

### Robust statistics throughout

- **MAD** (median absolute deviation) not SD for variance estimation
- **Winsorize at P1/P99** before computing the empirical CDF
- **Drop sessions failing validity heuristics** (e.g., >1M tokens in 8h suggests non-human use)
- **Median per-session yield over a 7- or 30-day window** rather than raw daily sums

### Stratification by tool/model

Claude tokens, GPT tokens, Gemini tokens are not unit-equivalent (tokenizer differences of ~1.1–1.3×). Either normalize against a reference tokenizer (EPA-MPGe move) or stratify by model. Cross-tool comparison without stratification is incoherent.

### Cross-task comparability — the IRT path

A senior on a distributed-systems bug and a junior on a typo both ship "1 commit." Stratifying by tool/language helps. The rigorous answer is **IRT (Item Response Theory)** where each task is an item with difficulty `b_task` and discrimination `a_task`, each developer has latent ability `θ_dev`, and `score = 100 × Φ(θ_dev / σ_θ)`. Used by NAEP, PISA, computerized adaptive tests. **Requires lots of tagged data we won't have for years.**

For V0.3 ship, stratify by tool/model only. Scope YPT explicitly as "within-cohort, within-context." This is honest and defensible.

---

## 3. The outcomes side — what really counts

"Weighted attributed commits" is the LOC mistake recapitulated. The right composite, drawing from GitClear's 211M-line study, DORA 2025's Rework Rate formalization, and the LLM-as-judge literature (CodeJudge, CodeJudgeBench, Sphinx):

### Three components, weighted geometric mean

1. **Survival-weighted attribution.** Merged-and-not-reverted-or-churned within 30/60 days. This is GitClear's churn metric (newly-added lines revised within 2 weeks doubled from 3.3% → 7.1% in the AI era) and DORA 2025's formalized 5th metric. **Hard to game** — you can't fake the absence of a future revert.

2. **LLM-as-judge intent fulfillment.** Score `(commit_msg, diff)` alignment using a local 7–8B model (Qwen3-8B benchmarks beat 14B Prometheus and 70B non-thinking judges per [Judge's Verdict arxiv 2510.09738](https://arxiv.org/pdf/2510.09738)). Runs ~10s/diff locally. Position-bias mitigated by running prompts twice with swapped order. **Caveat:** CodeFuse-CommitEval (arxiv 2511.19875) shows judges catch component/file/operation inconsistencies confidently but **cannot confidently judge "did this diff actually fix the race condition it claims to fix."** Score as judge confidence, not ground truth.

3. **Self-tag overlay.** One-keypress tagging (shipped / exploring / debugging / dead-end). Storey's "Mind the Gap" (arxiv 2012.07428) validates daily self-reports correlate with telemetry-derived focus/flow signals. **Use to segment data, not to score** — METR's perception/reality gap means self-reports of AI productivity are systematically biased upward.

### Why geometric mean

Penalizes balanced gaming (Lighthouse-style weighted arithmetic mean rewards balanced mediocrity; geometric mean punishes any zero/low component). All three components need to be credible for a high composite outcome — gaming one without the others moving exposes the lie.

### Validity predicate

Sessions/days that fail to meet a minimum predicate (e.g., <1 attributed outcome AND no self-tag) should report **"not scored"** rather than YPT 0. Exploration is real work and shouldn't tank the metric. This is the Strava pattern (no GPS = "activity not scored").

---

## 4. The quality ladder ceiling — what we cannot measure

The 6-layer quality ladder bounds what a diff-only privacy-respecting tool can honestly measure:

| Layer | What it measures | Diff-only signal? | Status |
|---|---|---|---|
| **1. Does it run?** | Compile/typecheck pass | Tree-sitter + `tsc/mypy/pyright` | **Clean** |
| **2. Does it do the right thing?** | Intent fulfillment | LLM-as-judge with caveats | **Medium with caveats** |
| **3. Is it well-written?** | Style, complexity | Cognitive complexity, Semgrep, jscpd | **Medium for objective metrics, theatre for aggregate** |
| **4. Is it maintainable?** | Churn, survival, coupling | GitClear-style metrics fully replicable | **Strong via evolutionary metrics; structural coupling impossible** |
| **5. Does it serve users?** | Production telemetry | Zero from diffs; integration-only | **Out of scope** |
| **6. Was it worth building?** | Business value | Zero from anything | **Out of scope** |

**The cliff is between Layer 4 and Layer 5.** The standards-play positioning is *helped* by this clarity: Mileage owns Layers 1–4 with academic backing and explicitly hands off Layer 5 to DORA/SPACE-integrated tools (Swarmia, LinearB, Faros). "DORA of AI Coding" framing made literal — define the local-measurable layers as a published spec, integrate with production-telemetry stack for the rest.

**Most underrated signal:** logical/evolutionary coupling (files that change together in commits). Fully metadata-derivable, predicts architectural problems, almost no AI-coding dashboard surfaces it. Strong candidate for differentiation.

**Most overrated signal:** Maintainability Index (1992 formula combining Halstead + cyclomatic, nobody validates it, produces a single number begging misinterpretation). Skip.

---

## 5. Critiques to engage when publishing the YPT spec

A peer reviewer will hand us these. The spec must defend against them:

### DX Core 4 (Forsgren et al., December 2024)
The SPACE authors themselves now reject single-scalar individual-dev metrics. Direct quote: PR throughput "should never be used at the individual level or tied to performance evaluations."

**Defense:** Scope YPT as a *personal-efficiency lens, not an HR tool.* WakaTime is fine because no manager uses it; Strava is fine because no one fires you for low VO2max. Publish explicit terms of use: "do not use for performance reviews." This isn't a workaround — it's the right scope given what's measurable.

### METR's 19%-slower-but-feel-20%-faster ([arxiv 2507.09089](https://arxiv.org/abs/2507.09089))
16 experienced devs, 246 tasks, RCT design. Real: 19% slower with AI. Perceived: 20% faster. **39-point perception gap.**

**Defense:** YPT exists *because* perception is biased. The metric beats the gut. We should cite this paper in the spec as the motivation.

### DORA 2025 — AI hurts system-level metrics
PR review time +441%; 31% merge without review; bugs per dev +54%; production incidents per change tripled. AI is making engineering measurably worse at the system level.

**Defense:** YPT is an individual-efficiency lens, not a system-health one. We cite DORA as the complementary system view; YPT lives below it. The standards-play frame becomes "DORA for the system, YPT for the individual."

### Goodhart's Law
Any single metric gets gamed.

**Defense:** Composite outcome (gaming requires lying credibly across 3 dimensions); geometric mean (punishes zero components); anomaly detection on input distributions; **gaming-alignment principle** (Microsoft EngThrive) — choose components where the obvious gaming behavior IS the desired behavior.

### Brynjolfsson Productivity J-Curve
Short-window outcome metrics systematically underestimate the long-run value of general-purpose technologies during the early adoption period (we are in the trough now).

**Defense:** Include flow/satisfaction signals (self-tag) as a leading indicator alongside outcome signals (lagging indicator). Document this explicitly in the spec.

### McKinsey backlash (2023)
Beck/Orosz substantive critique: surveillance backfires; the earliest measurement is the most gameable; invisible work is the most valuable work.

**Defense:** No surveillance posture (local-only); no individual reviews; "invisible work" tagging via self-tag.

---

## 6. Calibration discipline (the standards-play asset)

The metric alone isn't the standard — the **calibration discipline around it** is. Three concrete pieces, modeled on DORA:

1. **YPT Spec v1** — public doc defining formula, academic sources, current `(μ, σ)` anchor with citations.
2. **Annual *State of YPT* report** — recalibrate `(μ, σ)` each year from anonymized opt-in data + new academic work. Like DORA's annual report.
3. **Versioned scores + concordance tables.** `YPT-2026.1`, `YPT-2027.1`. When recalibration shifts everyone's score, publish a concordance table linking old and new (the SAT does this). Allow opt-in frozen calibration for longitudinal personal tracking.

The published spec is the actual standards-play asset, not the tool. The tool is the proof.

---

## 7. Three open questions before publication

1. **Initial `(μ, σ)` calibration values.** What is median yield rate in OckBench/Cost-of-Pass terms converted to "outcomes per 100K Anthropic tokens"? Benchmark medians don't generalize cleanly — selection bias, fixed-scope vs open-ended mismatch. Needs a real paranoid sweep before publication. Launch with explicit "v0 calibration; expect change" labeling is acceptable.

2. **Composite weights.** Survival vs intent-judge vs self-tag — what weights? Lighthouse picks by fiat and publishes. Or fit weights to maximize correlation with downstream truth (e.g., merged-and-not-reverted-after-90d). Latter is more principled but requires accumulating user data first.

3. **Tier names and the "what's a good YPT" story.** DORA shifted from Elite/High/Medium/Low to seven archetypes from cluster analysis in 2025 because the linear hierarchy proved misleading. Decide whether to ship simple tiers and migrate, or use archetypes from the start.

---

## Load-bearing citations

- [OckBench / OckScore — arxiv 2511.05722](https://arxiv.org/abs/2511.05722)
- [SWE-Effi — arxiv 2509.09853](https://arxiv.org/abs/2509.09853)
- [Cost-of-Pass — arxiv 2602.08765](https://arxiv.org/abs/2602.08765)
- [LLMThinkBench (harmonic-mean F1 of accuracy and efficiency) — arxiv 2507.04023](https://arxiv.org/abs/2507.04023)
- [CLEAR / Cost-Normalized Accuracy — arxiv 2511.14136](https://arxiv.org/abs/2511.14136)
- [Economic Evaluation of LLMs — arxiv 2507.03834](https://arxiv.org/abs/2507.03834)
- [METR study — arxiv 2507.09089](https://arxiv.org/abs/2507.09089)
- [GitClear AI Code Quality 2025 report](https://gitclear-public.s3.us-west-2.amazonaws.com/GitClear-AI-Copilot-Code-Quality-2025.pdf)
- [SPACE of Developer Productivity — Forsgren et al., ACM Queue 2021](https://queue.acm.org/detail.cfm?id=3454124)
- [DX Core 4 — Abi Noda, Dec 2024](https://newsletter.getdx.com/p/introducing-the-dx-core-4)
- [DORA 2025 State of AI-Assisted Software Development](https://cloud.google.com/resources/content/2025-dora-ai-assisted-software-development-report)
- [CodeJudge — arxiv 2410.02184](https://arxiv.org/abs/2410.02184)
- [CodeJudgeBench — arxiv 2507.10535](https://arxiv.org/abs/2507.10535)
- [CodeFuse-CommitEval — arxiv 2511.19875](https://arxiv.org/pdf/2511.19875)
- [Judge's Verdict (local 7-8B for code judgment) — arxiv 2510.09738](https://arxiv.org/pdf/2510.09738)
- [Mind the Gap (self-report vs telemetry) — arxiv 2012.07428](https://arxiv.org/pdf/2012.07428)
- [Lighthouse performance scoring docs](https://github.com/GoogleChrome/lighthouse/blob/main/docs/scoring.md)
- [Brynjolfsson Productivity J-Curve — NBER 2018](https://www.nber.org/system/files/working_papers/w25148/w25148.pdf)
- [Microsoft EngThrive + Goodhart](https://leaddev.com/reporting/is-microsofts-engthrive-framework-immune-to-goodharts-law)
- [Rework Rate as 5th DORA metric (Faros)](https://www.faros.ai/blog/5th-dora-metric-rework-rate-track-it-now)
