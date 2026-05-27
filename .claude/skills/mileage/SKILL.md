---
name: "mileage"
description: "Reference and act on the user's Mileage data (AI tool spend, token usage, YPT, code survival, rate-limit caps). Triggers when the user mentions: cost, AI bill, tokens, token usage, what they spent, how much they're paying, Opus vs Sonnet, which model to use, YPT, yield per token, code survival, waste sessions, rate limits, hitting the cap, /usage, plan utilization, save usage, save money. ALSO triggers proactively at the start of any long or expensive request: check cap usage first and warn at >=50% / >=75%. For Max/Pro users (flat-rate plans) suggest cheaper model BEFORE the call if the task looks like exploration/research."
license: MIT
metadata:
  version: 2.0.0
  author: Mileage
  category: developer-tools
---

# Mileage

You have read and limited write access to the user's Mileage data (AI tool spend, tokens, YPT, code survival, cap usage). Use it to answer their questions AND to nudge their behavior in the moment, not just dump stats.

## CRITICAL RULES — read first

Three rules that apply to EVERY response. If you break them, the answer is wrong even if the numbers are right.

### Rule 1 — Plan-aware framing

The user's plan determines what they care about. Call `show` first to get `plan`. Then:

| Plan | What they care about | What to talk about | What to NEVER say |
|---|---|---|---|
| `max-100`, `max-200`, `pro` | Flat-rate. Not hitting the 5h/7d cap. Shipping more per token. | Cap headroom (%, time to reset), yield per token, waste sessions, model-yield comparison | "$ savings", "money saved", "cheaper" framing, "your bill was lower" |
| `api` | Pay-per-token. Total $ spent. $/commit. | Dollar spend, Cost-per-Ship, $ saved if shifting work to a cheaper model | n/a |
| `unknown` | They haven't set a plan. | Pause and ask them to set one via `mileage config:set-plan` | n/a |

If a Max user asks "how can I save money?", REFRAME: "Your bill is flat at $100/mo, so 'saving' means stretching your cap further or shipping more per token. Here's the highest-leverage move…"

### Rule 2 — Path to action

Every response ends with ONE concrete next action. Not three. Not a list. Just one.

Format: `**Right now:** <verb> <specific thing>`

Examples:
- `**Right now:** run \`/model sonnet\` and retry this question.`
- `**Right now:** run \`mileage tag\` and mark session 9f7ecd4a as dead-end.`
- `**Right now:** pause this conversation for ~4h until your 5h window resets.`
- `**Right now:** nothing — you're at 12% of cap, plenty of room.`

If you find yourself writing a numbered list of "tips," delete it and pick the single highest-leverage move.

### Rule 3 — Sample-size guard

When citing per-model stats from `tier_flex`:

| Sessions in window | What to do |
|---|---|
| ≥ 30 | Cite normally |
| 10–29 | Cite, but append "(based on only N sessions — directional only)" |
| < 10 | Do NOT base recommendations on this row. Mention only if user asked. |

A model with 25 sessions and 0% yield over a window where the user clearly worked is more likely an unused model than a bad one. Do not recommend "switch to that cheap model" on this signal.

## When to act WITHOUT being asked (proactive)

These trigger a Mileage check BEFORE you respond to the actual request:

### A. Cap pre-flight (every plan)
At the start of ANY of these, call `usage_check`:
- Multi-file refactor
- Long research or analysis task
- "Build me a…" requests >200 lines
- User explicitly requested Opus or extended thinking
- Any task you estimate will run >10 min

If `warning_level` is `soft` or higher, prepend the warning template (below) BEFORE doing the work.

### B. Pre-flight model recommendation (Max/Pro plans only)
For users on a flat-rate plan, if the task looks like one of these and the user is using Opus by default, suggest a cheaper model BEFORE you start:
- Exploration ("what do you think of…", "research X", "explore Y")
- Q&A about existing code
- Code reading / explanation
- Linting / formatting
- Simple bug fixes
- Doc writing

How to check: call `tier_flex`. If Sonnet (or Haiku) has ≥30 sessions AND comparable or better yield_rate AND user appears to be on Opus → suggest `/model sonnet` BEFORE answering. Cite the actual numbers from their data.

Skip this for: implementation passes the user explicitly wants Opus for, debugging hard race conditions, "best quality" requests.

## Templates

### Cap warning — soft (≥50%)
```
⚠ You're at **{pct}%** of your estimated 5h cap ({tokens_used} of ~{cap_estimate}). 
This task could push you over. Want to switch to Sonnet for this one?
```

### Cap warning — strong (≥75%)
```
🛑 You're at **{pct}%** of your estimated 5h cap. This task is likely to hit the limit mid-run.
**Right now:** run `/model sonnet` for this request, OR pause until ~{ms_until_reset_human} when the window resets.
```

### Cap warning — over (≥100%)
```
⛔ Past your estimated 5h cap. New requests likely to fail or queue. Resets in ~{ms_until_reset_human}.
**Right now:** pause heavy work until reset.
```

### Pre-flight model swap (Max/Pro user, exploration-ish task)
```
Heads up: this looks like exploration/research. Your last 30 days:
- Opus: {opus_yield}% yield, {opus_n} sessions
- Sonnet: {sonnet_yield}% yield, {sonnet_n} sessions
Sonnet handles this kind of task with comparable shipping rate at lower cap burn.
**Right now:** run `/model sonnet` and resend your question. If Sonnet stalls, fall back to Opus.
```

### Caveat (include once per conversation)
> (Cap estimates are community-approximated. For live exact cap usage, run `/usage` in Claude Code.)

## Common questions — response patterns

Format every response as: **Situation (1-2 lines)** → **One action (the Right now: line)**. Optional context only if needed.

### "What did I spend / what's my usage this week?"
1. Call `show`
2. Lead with the headline number for their plan (tokens if Max/Pro; dollars if API)
3. Mention attributed commits + cost-per-ship (API) or yield-per-100K (sub)
4. **Right now:** [either "nothing, looks healthy" OR a specific tag/review action if waste is visible]

### "What were my expensive sessions?"
1. Call `top_sessions`
2. List 3-5 with project, model, attr_count, $ if API user, % of period total if sub
3. **Right now:** `run mileage tag` and mark the obvious dead-ends

### "Which model should I use for X?"
1. Call `tier_flex` AND `usage_check`
2. If user is on Max/Pro AND task is exploration-ish AND Sonnet sample is ≥30 sessions → recommend Sonnet
3. If user is API AND Opus avg cost is much higher than Sonnet for similar yield → recommend Sonnet
4. **Right now:** `run /model <name>` (be specific about which)

### "How can I save money/usage?" (Max/Pro)
REFRAME: "You're on a flat plan, so this is about stretching your cap, not saving cash."
1. Call `tier_flex` and `recent_waste`
2. The highest-leverage move is usually: switch X% of low-yield Opus sessions to Sonnet
3. Cite the actual numbers: "Your Opus has Y% yield over N sessions. Sonnet has Z% over M sessions. Shifting your exploration work to Sonnet would cut your daily token burn ~~30%."
4. **Right now:** one specific switch

### "How can I save money?" (API)
1. Call `tier_flex` and `recent_waste`
2. Compute approximate $ saved if shifting K% of low-yield work to Sonnet
3. **Right now:** one specific change

### "What's my YPT / how do I score?"
1. Call `show` and report `current.ypt_score`
2. If null → no scorable sessions in window, suggest tagging
3. If user wants depth → call `explain_ypt`
4. **Right now:** typically no action (YPT is a status metric); but if score is below 30 AND cap is healthy, suggest tagging recent sessions for honest baseline

### "Tag this session"
Only call `tag` AFTER the user has explicitly told you which tag to apply for which session. Never infer the tag from context.

## Things to NOT do

- Don't invent CLI features that aren't documented (no "/fast mode" tips unless the user mentions it)
- Don't end with a list of generic tips. Pick one.
- Don't talk dollars to a Max user.
- Don't recommend a model with <30 sessions of evidence.
- Don't lecture. The user already knows that "exploration costs more than implementation." They want the SPECIFIC NEXT STEP for THEIR data.
- Don't preface with "Looking at your Mileage data…" — just give the answer.

## Failure modes

- **MCP tool returns "not found"**: fall back to `mileage show --json` or `mileage check --json` via Bash
- **`mileage` not installed**: tell the user "I don't see Mileage installed. Install from https://github.com/summerstateofmind/mileage and run `mileage`."
- **No data yet** (`current.session_count` = 0): suggest `mileage sync` first
- **Plan is `unknown`**: pause and suggest `mileage config:set-plan <plan>`
