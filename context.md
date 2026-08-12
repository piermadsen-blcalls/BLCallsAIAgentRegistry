# BL Calls AI Agent Registry - Context

> Auto-compiled 2026-08-10 from Granola (last 3 weeks), Outlook, and the Executive Reporting board. Sources listed at the bottom. Summaries only - no raw meeting/email contents.
>
> **2026-08-12 infra note (from build sessions, not an auto-pull):** production AI scoring migrated to **Gemini 3.6 Flash via Google's native Batch API** (~50% cheaper, async two-phase submit/ingest); ran a 30-day backfill re-scoring the last month of calls; shipped Calls/Agents dashboard perf + metric fixes (jsonb indexes; an agent daily-rollup that cut the Agents load from ~5-9s to ~44ms). Technical detail in `HISTORY.md` / `CLAUDE.md`.

## What this is (from the Exec Reporting board)
AI IVR call handling + compliance registry for BL Calls' AI phone agents. Syncs Canoe call data, AI-analyzes each call for outcome, compliance, and a publisher score, and alerts account managers. **Live since January**; current push is accuracy tuning, publisher scoring, and LLM-dispo training.

- Stage: Live | Health: green | Completion: 90% (prev 70)
- Value: ~$1.5M direct revenue/yr and growing
- This week: testing + validating with the team
- Recent: built compliance, AI outcomes, and publisher scoring and pushed it all live

## Ownership
Day-to-day handed off to **James Teasdale** (ad ops) as of Aug 3; Pier retains the high-level/complex pieces. Registry scope expanded to **all calls with a Canoe transcript**, not just AI calls.

## Compliance tooling
- AI scores compliance + conversion per publisher/vertical; flags non-compliant calls to a DB and sends a **2-day summary digest** to account managers (Mon/Wed/Fri), not real-time alerts.
- Flag categories: outbound/robo dials on inbound campaigns; Facebook Marketplace calls; angry callers; caller confusion (wrong company reached); call-duration anomalies (~4-min spike then drop = likely coached/incentivized).
- Hosting moved off GitHub; pulls directly from Canoe. Jira ticket-writing via MCP is feasible; reading back from Jira deferred.
- **Compliance flags do NOT affect scoring** - separate tracks. Flags trigger AM review; AMs decide whether to act.

## AI call outcomes
- Original Shelly outcomes weren't trusted; rebuilt from scratch (Martin's labels not reused).
- Taxonomy nuance: "quoted not interested"/"too expensive" = positive; "caller hangup" = negative (not zero); "agent not available"/"voicemail" = more negative; "agent confused" softened (usually bad caller). Distinguishes publisher wrong-category vs advertiser wrong-category.
- Reducing from 24 outcomes to ~10 (or vertical-specific subsets); hard rules handle more, LLM handles fewer.
- Gold-standard plan: run the most expensive model against ~2,000 calls to build a clean labeled set, then validate the cheaper model.

## Publisher scoring (Vicky's framework)
- Separate scoring for advertisers vs publishers; range -5 to +10 (appointments = 10).
- Three metrics per entity: average score, defect rate (<0 calls / total), conversion-adjacent rate (2+ calls / total).
- Tiering (retroactively calibrated before launch): Tier 1 = avg 4+, defect <8%, conv-adjacent >15%; Tiers 2-4 descending.
- **Scored per publisher/vertical pairing** (e.g. Instar HVAC separate from Instar Roofing). Drives tiered pricing + premium matching matrix (block Tier 4 from premium advertisers; auto payout adjustments on tier moves).

## Fraud detection (visibility-first, not auto-block)
- Home-services fraud spiking (incentivized calls, early AI-bot calling).
- Coached-call signal: ~4-min duration spike then drop-off.
- Duplicate caller ID across multiple verticals in a 2-day rolling window (e.g. home insurance + pest control + roofing same day). Goal: blocking repeat offenders daily for a week cuts bad traffic ~50%.
- Geo mismatches: publisher zip vs caller's actual location (flag, don't re-route).
- eLocal flagged as repeat coached-call culprit; Saleo paused several home-services buyers.

## LLM disposition training
- Ran ~100 calls across models (Gemini 2.5, 3.5 Flash, others); reviewer picks the accurate result and the tool ranks models. **Vicky** is the human reviewer. 100-call sample deemed sufficient.
- Cost: ~30K of 60-70K monthly calls have transcripts; even Opus is <$1K/mo. Batch API pricing (half cost) to switch on post-testing.
- Chosen model defines all AI outcomes + compliance flags going forward; retrainable anytime via the same review loop.

## Caller ID / buyer acceptance (Ring Partner strategy, w/ David)
- Problem: publishers send pings without caller ID -> buyers reject (can't screen dupes). BCI requires no caller ID on ping but runs rev-share (effective ~$80 vs stated $105).
- Proposed "intercept and re-ping": win the call, capture caller ID, re-ping higher-value buyers. Risk mitigation: if the call drops before connect-duration threshold, no publisher payment owed.
- Two opportunities: (1) BCI pre-ping national - contained fix; (2) caller-ID-requiring network buyers - larger, more complex.
- AI-agent gap: agent doesn't yet return the caller's phone number in its own ping field (small change, high QoL for advertisers).

## Quality scoring tool
- Pier working closely with Vicky; target date was **Aug 10, 2026**.
- Admin ability to modify framework/scores; nightly scoring job, tier history storage, tier-change detection required.

## Blockers
- Canoe outage risk - Shelly single point of failure; Anastasia being trained (not yet capable).
- Compliance-tool maintenance post-launch - James being trained, Anastasia backup; tool to hand to Shelly for Canoe integration in 2-3 months.
- Dispo automation: lead-ID matching blocked internally (Venkata working a workaround; needs Brett/Tatevik/Andre approval for DB access).

## Key people
Pier (owner/strategy), James Teasdale (day-to-day), Vicky (taxonomy/scoring/model reviewer), Shelly (Canoe), Anastasia (Canoe backup), Matt (quality reports), David (caller ID / Ring Partner), Aaron (BL Calls priorities).

## Jira
- No live tickets. Prior tracking tickets (MK-150, MK-153 publisher scoring) were **deleted**.

## Email sources (Outlook, subject / sender / date)
- "Compliance digest: 23 accounts flagged - Jul 31-Aug 7" (ASCND AI Weekly Recap) + Pier's reply - Aug 7

## Meeting sources (Granola, last 3 weeks)
- Compliance tool and publisher scoring - AI outcomes, fraud detection, timeline with James - Jul 24
- Team sync - Ascend handoff to James, quality scoring tool, booking contractors roadmap - Jul 27
- Ring Partner call strategy - caller ID and buyer acceptance with David - Aug 7
