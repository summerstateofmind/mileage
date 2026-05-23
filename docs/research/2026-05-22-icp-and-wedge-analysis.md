# ICP and Wedge Analysis — Strategic Reframe to Path A

**Date:** 2026-05-22
**Status:** Decided. Drives V0.2 design.
**Trigger:** Deep math+outcomes research surfaced credibility limits on the standards-play as a *wedge* (it's still viable as a Phase 2 asset).

---

## Summary

The original strategy positioned YPT (Yield Per Token) as the hero metric and "DORA of AI Coding" standards-play as the wedge. The deep research changed conviction on two things:

1. **The standards-play is a *long-term* asset, not a *wedge*.** DX Core 4 (Forsgren's current framework) explicitly rejects single-scalar individual-dev metrics; METR shows AI users can't trust their gut about AI productivity; DORA 2025 shows AI is making system-level engineering measurably worse. The academic credibility bar for publishing the standard is high and takes 18+ months to clear.

2. **There's a stronger immediate wedge available.** Every dev with a $200+/mo Claude bill is asking "is this worth it?" Concrete dollar amounts answer that question instantly. YPT-as-score is too abstract for a first-value moment.

**Decision: Path A.** Ship Mileage with **Cost-per-Ship as the hero metric**, in dollars. YPT becomes a sophistication-tier feature. The standards-play continues as a Phase 2 publishing project running in parallel to dogfooding.

---

## Revised ICP

**Primary: The Cost-Conscious Solo Dev.**
- Spending $100–1,500/mo on AI tools (Claude Code, Cursor, Copilot)
- Building real software, often solo or in a tiny team
- Has had at least one "wait, I spent HOW much?" moment with their AI bill
- Wants concrete dollar answers, not opaque dashboards or vanity metrics
- Currently uses 1–2 AI tools (not 3+ — multi-tool comparison is a niche audience)
- Commits straight to `main` half the time; no PRs/CI required for the product to be valuable

**Secondary: The Quantified-Self Engineer.**
- Already uses WakaTime, RescueTime, Beeminder
- Cares about self-improvement curves
- Will tolerate noisy metrics if the privacy story is clean
- Smaller audience but high evangelism value (the personal-brand multiplier)

**Explicitly NOT the ICP:** Managers wanting team metrics, enterprises, multi-tool tinkerers as the *wedge* audience (still valuable as later expansion).

---

## The wedge / first-value moment

NOT YPT. YPT is too abstract to be a first-value moment — the number "47" means nothing until the standard is established and the user has weeks of baseline.

**The wedge is the bank-statement-for-AI-spend moment.** Concrete, dollar-denominated, instantly visceral.

### Target UX of the wedge

```
mileage show

Mileage  ·  this week
  Spend          $487   (vs $156 last week — what changed?)
  Outcomes        4 PRs shipped   (vs 5 last week)
  Cost-per-Ship   $122 / PR   (vs $31 last week)

  Where the money went:
    $84  Wed 3pm — 3hr debugging session (no commits)  ⚠ flag?
    $61  Thu morning refactor (1 commit)
    $58  Fri feature work (2 commits + tests)
    $54  Mon onboarding (1 commit, later reverted)  ⚠ 
    ...

  YPT score 42 (your trailing 30d median: 39) — see `mileage explain ypt`
```

The dollar number leads. The wasteful session jumps out. Self-tagging is contextual. YPT lives at the bottom for the curious.

### Why this works as a wedge

- **Universally visceral.** Every dev has had the "wait, I spent $300 on Claude this month?" moment. We pay it off concretely.
- **No standard required.** Dollars are dollars. The user doesn't need to know what "good" is on day one — they compare to their own last week / last month.
- **Honest about waste.** The 3-hour debug session that produced nothing surfaces immediately. METR's perception/reality gap helps here — you don't have to *believe* you wasted time, you can see the receipt.
- **Single-tool-loyalist compatible.** Anthropic-only and ChatGPT-only users get full value because the metric is about their own spend over time, not cross-tool comparison.

---

## Single-tool loyalist value (the "what if I'm an Anthropic fanboy" question)

Cross-model comparison was assumed to be the headline value. The honest audience math:

- Multi-tool tinkerers (3+ AI tools active): **5–15%** of paid AI-coding users
- Single primary tool (Anthropic-only or Cursor-only or ChatGPT-only): **majority**

For a single-tool user, the value stack is:

1. **Cost awareness.** "You spent $487 this week." Concrete. Always works.
2. **Waste detection.** "Session X cost $84 and produced nothing — review it." Always works.
3. **Tier-mismatch detection.** "You used Opus 73% of the time; Sonnet has comparable outcomes at 35% the cost." Works within a single provider's model lineup.
4. **Self-trajectory.** "You're at $122/PR vs $31/PR last month — what changed?" Works but noisy at low session counts.
5. **Cross-model comparison.** Only works if user has 2+ models. Niche.

For an Anthropic-only or ChatGPT-only user, items 1–4 cover the value prop without needing item 5.

---

## Revenue paths (ranked by likelihood)

1. **Acquihire / acquisition ($500K–$5M).** Most likely meaningful outcome. Anthropic, Anysphere, GitHub, WakaTime are plausible buyers. The asset is the published methodology + credibility + early data. The OSS tool is the proof.
2. **Personal brand → consulting/speaking/book ($50–200K/yr within 18 months).** Probably the highest-EV outcome short of acquihire. Underrated in the original strategy.
3. **Sponsored *State of YPT* report ($50–200K/yr).** Once credible: Anthropic/Anysphere will sponsor a report because they want their tools to look efficient against the metric. Requires 18–24 months credibility-building.
4. **Paid Quality Mode tier ($9–14/mo individual).** WakaTime model. Realistic ceiling $200–600K ARR. Lifestyle business. The floor, not the ceiling.
5. **Team tier / enterprise.** Ruled out — crowded with funded players.

**Strategic implication: the primary outcome to optimize for is personal brand + acquihire optionality, not lifestyle SaaS revenue.** Lifestyle SaaS is the safety net.

---

## What the personal-brand play requires

If personal brand is the primary asset, the work isn't just shipping the tool — it's shipping content alongside it. Specifically:

- **Weekly public dogfooding posts.** "What my Mileage data showed this week." Surprising findings. Mistakes. Tradeoffs.
- **The annual *State of YPT* report.** Even with N=1 (just the author) as the dataset for v0, the report sets the template.
- **Conference talks.** "Measuring AI Coding Honestly" — easy slot to fill in 2026.
- **The published spec.** YPT-2026.1 with full math, citations, failure modes documented.
- **Engagement with skeptics.** Forsgren's DX Core 4 critique deserves a public response, not silence.

This is the standards-play but reframed: it's *brand-building through publishing*, not *product-building through marketing*. The tool exists to give the brand artifacts to publish.

---

## What's no longer in the plan

- **YPT-as-hero-metric in the UI.** Demoted to a sophistication-tier feature accessed via subcommand or expanded view.
- **"DORA of AI Coding" as the launch positioning.** That positioning is the Phase 2 publishing project, not the OSS launch story.
- **Multi-tool comparison as the wedge.** Stays as a value-add for the multi-tool subset; not the front door.
- **Standards-first launch sequencing.** Tool ships first, becomes useful, builds credibility, *then* the spec gets published with real dogfooding data behind it.

---

## What stays in the plan

- The strategic sequencing of "ship CLI → dogfood publicly → publish methodology" is unchanged; the priority order of the pieces just shifted.
- Privacy-by-default + opt-in Quality Mode architecture.
- Three-tier attribution model.
- Local-only, no cloud, no telemetry.
- The brand-asset framing ("the published spec is the standards-play asset").
- All the V0.1 plumbing (storage, ingest, attribution).

---

## Implications for V0.2 design

V0.2 = **the cost-wedge release.** Two phases:

**Phase 1 (the wedge itself):**
- Pricing table → real USD cost computed per session
- `mileage show` restructured: dollar spend leads, Cost-per-Ship is the hero, YPT moves below
- "Top expensive sessions" surfacing in the default view
- Waste-session detection (high cost, zero attributed commits) with explicit warning

**Phase 2 (sticky features that drive retention):**
- Self-tag system + interactive UX (one-keypress tagging on top-expensive sessions)
- Heatmap renderer (colors by cost-efficiency, not raw activity)
- Git post-commit hook installer (High-tier attribution)
- `mileage report` for shareable weekly summaries (the brand-building artifact)

YPT itself stays on the V0.1 formula for V0.2 — the math upgrade (log-normal CDF, composite outcomes, etc.) is V0.3+ when we're ready to start publishing the spec.
