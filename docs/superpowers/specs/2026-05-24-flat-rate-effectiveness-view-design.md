# Mileage — Flat-Rate Effectiveness View Design Spec

**Date:** 2026-05-24
**Status:** Draft
**Goal:** Make `mileage show` answer the two questions a flat-rate (Max/Pro) user actually has — **"am I about to get blocked?"** (cap headroom) and **"did I ship?"** (effectiveness) — by leading the subscription view with a headroom + effectiveness front-door block, replacing the binary commit count with honest **Shipped / Likely / Research** buckets, and retiring the `⚠ waste` label that mislabels research as waste.

This is **Part 2 of 3** of the effectiveness work, built on Part 1's attribution (now ~39% session coverage, mostly `direct`/`high`).

- ✅ Part 1 — Attribution sharpening (shipped) + multi-repo sync (shipped)
- **Part 2 — Flat-rate effectiveness view (this spec)**
- ⬜ Part 3 — Targeted local LLM judge (sharpens the "Research" bucket; not required here)

---

## Why now

`mileage show` already forks by plan (`renderApiView` / `renderSubscriptionView` / `renderUnknownView`). The subscription view has three gaps for a flat-rate user:

1. **No cap headroom.** `computeUsageCheck` (5h/7d cap %) powers `mileage check` and the JSON, but never appears in the main view — the one live, decision-relevant gauge on a flat plan is absent from the front door.
2. **Binary outcomes.** The Outcomes line is just `N commits shipped` or `—`. No honest gradation.
3. **The `⚠ waste` label.** `fmtTopRow` flags any 0-commit session over the $ threshold as waste. Per the dogfooding lesson (the user's largest no-commit sessions were YPT research/design, not waste), **no-commit ≠ waste** — this label must go.

Part 1 made attribution trustworthy enough (mostly `direct`/`high`) that Shipped/Likely buckets now stand on real data instead of being mostly empty.

---

## Scope

### What we ARE building
- **`src/compute/effectiveness.ts`** — a pure session classifier + a window tally, built on the existing `gatherComposites` (`composite_outcomes.ts`).
- **Front-door block** in `renderSubscriptionView`: cap headroom (from `computeUsageCheck`) + effectiveness buckets + code-health, with Tokens / Rate-limit / Cost-equivalent demoted below a divider.
- **Neutral top-session labels**: replace the `⚠ waste` marker with the session's bucket label (`shipped` / `likely` / `research` / `N commits`), in **both** views.
- Unit tests for the classifier and the tally.

### What we are NOT building (defers / YAGNI)
- **API view restructure.** Only its top-session label changes (waste → bucket); spend / Cost-per-Ship lead is unchanged.
- **YPT changes.** Stays below the fold, unchanged.
- **A new daily-vs-weekly mode.** The existing `--week` / `--days` / `--month` window selector covers it; buckets and headroom render within the chosen window (headroom's 5h/7d are inherently rolling).
- **Schema / snapshot changes.** Buckets are computed live; nothing persisted.
- **Part 3 LLM judge.**

### What changes for users
| | Before | After (subscription view) |
|---|---|---|
| Lead | Tokens used | **Cap headroom + Shipped/Likely/Research + code health** |
| Outcomes | `N commits shipped` | three honest buckets over sessions |
| 0-commit session | `⚠ waste` | neutral `research` |
| Tokens / Cost-eq | lead | demoted below the front-door block |

---

## The design

### `effectiveness.ts`

```ts
export type EffBucket = 'shipped' | 'likely' | 'research';

const SURVIVAL_SHIPPED_MIN = 0.5; // direct/high but <50% lines survive → downgrade to likely

export function classifySessionBucket(
  composite: SessionComposite,
  attrs: SessionAttribution[],
): EffBucket {
  if (composite.tag === 'shipped') return 'shipped';
  if (composite.tag === 'exploring' || composite.tag === 'dead-end') return 'research';
  // untagged or 'debugging' → classify by attribution × survival
  if (attrs.length === 0) return 'research';
  const strong = attrs.some((a) => a.tier === 'direct' || a.tier === 'high');
  if (!strong) return 'likely'; // inferred-only
  const evaluated = attrs.filter((a) => a.lines_surviving !== null && a.lines_added > 0);
  if (evaluated.length > 0) {
    const added = evaluated.reduce((s, a) => s + a.lines_added, 0);
    const surv = evaluated.reduce((s, a) => s + (a.lines_surviving as number), 0);
    if (added > 0 && surv / added < SURVIVAL_SHIPPED_MIN) return 'likely';
  }
  return 'shipped';
}

export interface EffTally { shipped: number; likely: number; research: number; total: number; }

export function bucketWindow(
  db: DatabaseSync,
  startMs: number,
  endMs: number,
  projectHash?: string,
): EffTally {
  const { composites, attrMap } = gatherComposites(db, startMs, endMs, projectHash);
  const t: EffTally = { shipped: 0, likely: 0, research: 0, total: composites.length };
  for (const c of composites) {
    t[classifySessionBucket(c, attrMap.get(c.session_id) ?? [])]++;
  }
  return t;
}
```

`SessionComposite` and `SessionAttribution` are the existing exports from `composite_outcomes.ts` / `db.ts`. `gatherComposites` already returns every session in range plus an attribution map, so no new query is needed.

### Front-door block (`renderSubscriptionView` in `show.ts`)

Rendered at the very top, right after the header bar, before Tokens:

```
 Cap   5h ▓▓▓▓░░░░ 48%   7d ▓▓▓▓▓▓░░ 71%   ✓
 Ship  18 shipped · 9 likely · 23 research
        50 sessions · 82% alive @7d
 ────────────────────────────────────────────
```

- **Cap line:** from `computeUsageCheck(db, cfg.plan)`. For each of `five_hour` / `seven_day`: an 8-segment bar `▓`/`░` filled to `round(percent_used/100 * 8)` (clamped 0–8) plus the integer `%`. Color by `warning_level` (`ok`→green, `soft`→yellow, `strong`/`over`→red). Trailing glyph: `✓` when both `ok`, else `⚠`. If `percent_used` is `null` (no cap estimate for the plan), render `—` for that window.
- **Ship line:** `bucketWindow(db, currStart, now, projectFilter)` → `X shipped · Y likely · Z research`, colored green/cyan/dim. Sub-line: `{total} sessions · {N}% alive @7d`, where `{N}` is the 7-day window's rate from `getSurvivalSummariesSince`; if the 7d window has no evaluated commits, omit the `· N% alive @7d` clause. Fold this standalone "Code health" info into the sub-line and **drop** the separate `renderSurvivalBlock` call from the subscription view.
- Divider, then the existing Tokens / Rate-limit / Cost-equivalent lines unchanged in content, just relocated below.

### Top-session labels (`fmtTopRow`)

Replace the `waste: boolean` field with a `label: string`: `${attr_count} commit(s)` when the session has ≥1 attributed commit, else neutral `research`. (The front-door Ship line uses the full `classifySessionBucket`; the per-row label stays this lighter commit-count/research form to avoid a per-session composite+survival fetch for each of the 5 rows.) Color: `research`→dim, commits→green. The `⚠ waste` string is removed from the codebase.

---

## Contracts upheld
- **Recomputable:** buckets and headroom are derived live from `events` + `attributions` + token usage. No snapshot/schema change; re-running `sync` yields identical display. No persisted bucket state.
- **Privacy:** unchanged — reads only metadata already in the DB.
- **Provenance:** the bucket rule is documented here and in `effectiveness.ts`; YPT's own provenance (`explain ypt`) is untouched.

## Error handling & edge cases
- **No sessions in window:** `bucketWindow` returns all-zero/total 0; the Ship line shows `0 sessions` and the existing "No data" notice still fires.
- **No cap estimate (e.g. `pro` without a published cap, or `unknown` plan):** Cap line shows `—` per window; the rest of the block renders normally. (The `unknown` plan routes to `renderUnknownView` → API view, so the front-door block is subscription-only.)
- **Survival not yet evaluated** (commits <7 days old): `classifySessionBucket` treats unknown survival as surviving (direct/high → shipped), matching the "innocent until reverted" stance; the `· N% alive @7d` clause is omitted when the 7d window has no evaluated commits.
- **`debugging` tag:** falls through to attribution-based classification (a debugging session that produced a surviving commit is `shipped`; one that didn't is `research`).

## Acceptance criteria
1. `mileage show` on a `max-100`/`max-200` plan leads with the Cap + Ship + code-health block, then a divider, then Tokens/Rate-limit/Cost-equivalent.
2. The string `⚠ waste` no longer appears in any `mileage show` output; 0-commit sessions show a neutral bucket label.
3. `bucketWindow` buckets sum to `total`, and `classifySessionBucket` matches the rule table (unit tests).
4. API view is unchanged except the top-session label.
5. `npm test` green; `npm run build` clean.

## Testing
- **Unit — `classifySessionBucket`:** tagged-`shipped`→shipped; tagged-`exploring`/`dead-end`→research; no attrs→research; `inferred`-only→likely; `direct`+surviving→shipped; `direct`+<50% surviving→likely; untagged `debugging`+surviving commit→shipped.
- **Unit — `bucketWindow`:** seed an in-memory DB (sessions + commits + attributions + one tag) and assert the tally and that buckets sum to `total`.
- **Render:** run `mileage show` against the live DB; confirm the front-door block, neutral labels, and no `⚠ waste`.

## Known limitations
- "Research" conflates productive design/research with genuine dead-ends; separating them needs intent-reading (Part 3). Framed neutrally on purpose until then.
- A session that committed to a not-yet-ingested repo classifies as `research` (Part 1's known cross-repo limitation); multi-repo sync mitigates this for repos you've run Claude Code in.
