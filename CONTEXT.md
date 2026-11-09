# BL Calls AI IVR Governance (AI Agent Registry) - Context

> Current picture as of **2026-11-09**. Summaries only; people by role. Replaces the 2026-08-10
> `context.md` (still in git history). Running log is in `HISTORY.md`; technical map in `CLAUDE.md`.

## What it is and why
The registry and compliance dashboard for BL Calls' AI phone agents (AI IVRs built on the
Ascend voice agent, sitting in Canoe/RingPartner call flows). It syncs Canoe call data daily,
AI-scores every transcribed call for outcome and compliance flags (Gemini batch), scores
publishers and advertisers per vertical, sends account managers a twice-weekly compliance digest,
and hosts the AI IVR review/audit workflow. It exists because BL Calls had no reliable view of
what its AI agents were doing, which publishers send bad traffic, or whether agents convert.
Live since January 2026; the dashboard is a deliberate prototype meant to be absorbed into Canoe.

## Business goal and success measure
- Goal: lift AI IVR revenue and conversion while catching non-compliant / fraudulent supply early.
- Measures in use: monthly AI IVR revenue goal (set Aug 25), paid conversion, flagged-call rates
  per publisher, publisher/advertiser outcome scores (Wispr, Aug-Oct).
- Health signal (Wispr, Oct 6-22): AI-routed revenue and volume fell sharply Jul -> Oct while
  conversion held - driven mainly by fraud-related publisher pauses, routing changes and dentist
  pass-through, not the agents. Q4 target likely missed (Oct 7).

## Stakeholders (by role)
- **Owner (builder/maintainer):** product, code, scoring, `Agent Registry Update` tickets.
- **Exec sponsor:** BL Calls AI program; wants people/process accountability.
- **BL Calls GM:** supply side, revenue targets.
- **Demand-side lead / quality lead:** outcome taxonomy, scoring framework, model review; built a
  separate Jira-driven Compliance Tracker (Oct 26).
- **Audit coordinator (account lead):** runs the AI IVR audits, files most MK registry tickets.
- **Account managers:** review their own accounts' IVRs, file MK tickets, act on digest flags.
- **IVR builder (ad ops):** builds AI IVRs in Canoe (`AI IVR` tickets).
- **New monitoring hire (Nov 2026):** day-to-day AI IVR monitoring and review.
- **Compliance analyst:** outcome-accuracy analysis, publisher flag priorities.
- **New CTO:** briefed Oct 16; registry's move into Canoe goes through them.
- **Canoe dev team:** Canoe-side tickets (EX board) the registry depends on.

## Systems
Netlify (static `index.html`), Supabase Postgres (+ pg_cron rollups), GitHub Actions
(`sync`, `process-submit`/`process-ingest`, `alert`), Gemini 3.6 Flash native Batch API,
Canoe API, ASCND webhook (digest email), Jira MK (registry/IVR) and EX (Canoe).

## Status and health (dated)
- **Code:** last ship 2026-10-16 (PR #7: saved call notes, `quoted_abandoned` flag + 2,457-call
  backfill, `coached_call` flag via prompt v4, review assignments dropped). No code changes since.
- **Usage:** all-team AI IVR audit ran Nov 2-6 on the Review tab and worked (Teams, Nov 2-4).
  Audit reporting moved to an AM debrief on Nov 12 instead of registry changes (Teams, Nov 9).
- **Coverage gap:** new AI IVRs are created in Canoe but not added to the registry, so some
  agents are missing (Teams/Jira, Nov 4-6).
- **Coached calls** rising industry-wide; AMs actively looking for defences (Teams, Nov 6-9).
  The flag is conservative and its recall is unproven (HISTORY, Oct 16).
- **Canoe outcomes** pipeline was dropping results for a large client; fix pending deploy
  (Jira EX-2399, Nov 5).
- **Security:** Supabase weekly security advisories on the project (public schema), unread
  (Outlook, Sep 29 - Nov 3). Site is password-protected (Teams, Oct 22).
- **Known bug:** Settings "set active prompt" calls a missing RPC; activation done by SQL
  (HISTORY, Oct 16).
- **Jira lag:** MK-184 / MK-186 show To Do but shipped (Jira, Nov 9). Epic MK-150 no longer
  resolves (deleted earlier).

## Open items for the owner (Jira/Teams, as of 2026-11-09)
1. Register missing IVRs (MK-189 Medicare, the ADOPS-20349 pest-control path) and ship **MK-177**
   (Canoe/registry naming match + a process so new IVRs get registered) - chased repeatedly.
2. **MK-188** - an AM missing from the Review tab filter (check vs. the dropped-assignments change).
3. Close MK-184 / MK-186 in Jira; confirm `coached_call` is firing and tell the AMs.
4. **MK-180** - move "sent back to Canoe" reporting into the Canoe workflow (untouched since Sep 29).
5. **MK-176** visualizations tab - parked until the Canoe move (Wispr, Oct 6).
6. Future audit reporting/export (deferred by the debrief format, will return next quarter).

## Open decisions
- Coached-call detection approach: per-call flag vs. publisher flag-rate outliers (Wispr, Oct 16).
- Timing and shape of moving the registry into Canoe under the new CTO (Wispr, Oct 16).
- How the audit runs going forward with a dedicated monitoring hire (Teams, Nov 9); Q4 audit
  previously targeted for early December (Wispr, Sep 22).
- Ownership of connected/rejected tagging via Canoe post-back workflows (~30-40 workflows) -
  assigned to the incoming hire (Wispr, Oct 7).

## Blockers and dependencies
- Canoe IVR rework **EX-2250** (publisher vs advertiser IVR split) idle since Sep 16; blocks
  vertical-wide / advertiser-side AI IVRs (MK-112). EX-2186 and EX-2267 idle in Screening.
- Accurate AM/publisher/advertiser assignments for the Review tab scopes.
- Owner capacity (Wispr, Oct 9).

## Next (week of 2026-11-09)
- Nov 9 AI Initiatives Review with leadership; Nov 10 Weekly BL Calls Sync; **Nov 12 AI IVR audit
  team debrief**; Ticket Grooming Nov 16/23/30 (calendar).
- Clear items 1-3 above; pick up the coached-call outlier view and the outcome-accuracy analysis.

## Sources
- Repo: `HISTORY.md`, `CLAUDE.md`, `SCORING_AND_DIGEST_SPEC.md`, git log (to Oct 16).
- Wispr Flow meetings Aug 4 - Oct 23 (none recorded during leave Oct 24 - Nov 8).
- Jira MK, EX, ADOPS, SY tickets, activity through Nov 9.
- Outlook mail, Teams chats and calendar, Sep 15 - Nov 9 (plus upcoming to Nov 30).
- Meeting-prep files Oct 13 - Oct 23 (no registry-specific content).
- Not pulled: older `bl-calls` GitHub repo (not needed); compliance-digest emails not found in mail.
