# Mileage — Status

_Updated 2026-05-25._ A one-page map of what's shipped and what's next. Detailed specs/plans live in `docs/superpowers/`; phased versions in `ROADMAP.md`.

**Install:** `npm i -g mileage-cli` (command: `mileage`). Published `mileage-cli@0.1.0`. Pre-1.0.

## Shipped
- **V0.1–V0.2 core** — ingest (Claude Code JSONL + `git log`), 3-tier attribution, cost + YPT, code survival (7d/30d), tier-flex audit, behavioral patterns, 90-day heatmap, plan-aware `show`, `tag`/`review`/`report`, MCP server + skill, cap-usage `check`, first-run wizard, post-commit hook.
- **Attribution sharpening + multi-repo sync** — compound `git commit` detection (10% → 100%), concurrency-aware `high`/`inferred` tiers that abstain under parallel sessions, and `mileage sync` now git-scans every known repo minus a `config:exclude-repo` list. Session-attribution coverage **7.5% → 39%**.
- **Flat-rate effectiveness view** — `show` (subscription plans) leads with **Shipped / Likely / Research** + code survival; the `⚠ waste` label is retired (no-commit framed as research, never waste) in `show` and `report`. The estimated cap-% gauge was **removed** — it can't match Anthropic's real accounting (unpublished, cache-weighted), so `show`/`check` now cite `/usage` (the source of truth) instead of contradicting it.
- **Session-intent judge — Foundation** — opt-in `judge:enable` gate, **local-first** model selection (`detect`: total-RAM tiers — 16 GB+ → 7-8B, 8 GB → 3B — with cloud as an explicit fallback), prompts+trajectory extraction (content confined to `src/judge/input.ts`), Ollama/cloud runner, `session_verdicts` cache, `mileage judge`. **View integration + YPT feed are NOT wired yet** (see Up next).
- **CLI polish** — cap-hit detection from API-error entries (`isApiErrorMessage`/429), **rate-limit-hit clustering** (retry-spam + simultaneous 429s across concurrent instances collapse into one true wall-hit event; a single account cap is hit once), sync-ago `m`/`h`/`d`, `judge:enable` `[y/N]` prompt, shell completion (`mileage completion pwsh|bash|zsh`).
- **Published to npm** as `mileage-cli` (one-command install).

## Up next
1. **Dogfood the judge** — needs a model: **local Ollama 7-8B (16 GB+ RAM, the default)**, or the **cloud fallback** (for <16 GB boxes incl. this dev machine). Run `mileage judge`, eyeball whether `productive`/`spinning` verdicts ring true. **Gate for everything below.** Guide: `docs/superpowers/plans/2026-05-25-part3-remaining-and-dogfood.md`.
2. **Judge Integration plan** — split the research bucket into `explored` / `spun` / `unjudged` in `show` (0.7 confidence gate). Build *after* verdicts are trusted.
3. **Judge v2 — YPT feed** — confidence-gated `productive` term contributes to `composite_outcomes`/YPT, once calibrated (re-opens the cache-not-snapshot decision).

## Backlog (polish)
- **bash/zsh completion** is field-untested (PowerShell is solid) — testers wanted (README flags it).
- Prune `.js.map`/`.d.ts` from the npm package (dead weight; `src` isn't shipped).
- Align names: GitHub repo is `summerstateofmind/mileage`, npm package is `mileage-cli`.

## Reference
- Specs → `docs/superpowers/specs/` · Plans → `docs/superpowers/plans/` · Research → `docs/research/` · Roadmap → `ROADMAP.md`
