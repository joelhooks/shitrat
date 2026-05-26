---
name: shitbox-triage
displayName: Shitbox Triage
description: "Front inbox janitor for Joel's personal shitbox: Brain-mapped executive digests, contextual grouping, safe archive sweeps, and Front thread links. Use when asked to clean the shitbox, summarize inbox, run a digest, sweep personal Front, or tune inbox interest rules."
version: 0.1.0
author: joel
tags:
  - front
  - inbox
  - shitbox
  - triage
  - brain
---

# Shitbox Triage

Clean Joel's personal Front inbox without becoming a reckless email cannon. This is the light-process counterpart to `aih-triage`: Brain first, metadata first, executive summary always, mutate only boring trash or explicitly approved actions.

## Session status

Set the Pi session name to `📥 Front Shitbox Sweep` for active sweeps. Keep it stable. Use status/progress rows when available instead of renaming for every phase.

Useful phases:

- `Brain Map` — read/export inbox interest rules
- `Queue Scan` — pull metadata snapshot
- `Digest Shape` — group by signal/digest/trash/risk/conditional
- `Safe Archive` — archive obvious trash only
- `Context Fetch` — fetch bodies for risk/signal/ambiguous groups
- `Operator Report` — executive summary with grouped links
- `Rule Capture` — update Brain interest map when Joel corrects the sweep

## Core taste

Joel wants:

1. Executive summary: counts, what changed, what matters next.
2. Context: profile/window/source, caveats, rate limits, token/path receipts.
3. Reasoning: why each group was archived, kept, fetched, or escalated.
4. Grouped items: related threads batched by type, not flat ticket dumps.
5. Front links: `https://app.frontapp.com/open/<conversation-or-message-id>` for every actionable item and archive group.

Do not just say "archived 20." That is receipt-only sludge. Give the shape above.

## Brain map

Canonical interest map:

```bash
/Users/joel/.brain/areas/joel-inbox-interest-map.svx
```

Runtime export:

```bash
shitrat inbox rules export
# writes ~/.shitrat/inbox/context/interest-map.json
```

The Brain map defines:

- `signal` — show now or fetch body
- `digest` — summarize, don't show individually
- `temptation` — interesting/desirable but bad for attention/spending
- `trash` — archive or unsubscribe
- `conditional` — depends on subject/body/seasonal context
- `risk` — never archive from metadata only
- `unknown` — ask or fetch

Use Brain as judgment context, not a dumb keyword broom. If Joel corrects a category, update the Brain map or add a note under `/Users/joel/.brain/resources/inbox-triage-preferences.svx`.

## Default commands

```bash
secrets lease shitrat_front_private >/dev/null
shitrat inbox rules export
shitrat inbox snapshot --profile joel-combined --metadata-only --refresh --since-hours 24 --limit-per-lane 40 --max-pages-per-lane 3 --max-requests 100
shitrat inbox pull --profile joel-combined --metadata-only --refresh --format ndjson --headless --out /tmp/shitbox.ndjson
shitrat inbox janitor prompt --mode daily --events /tmp/shitbox.ndjson
```

If the secret is missing, add it to agent-secrets. Never print the token.

## Sweep workflow

1. **Read Brain first**
   - `/Users/joel/.brain/areas/joel-inbox-interest-map.svx`
   - `/Users/joel/.brain/resources/inbox-triage-preferences.svx` when present
   - active project notes if a thread maps to current work

2. **Export rules**
   - Run `shitrat inbox rules export` so the CLI annotates metadata with current Brain rules.

3. **Pull metadata**
   - Use `shitrat inbox pull ... --metadata-only` first.
   - Do not fetch full bodies for everything.
   - Keep request budgets and Front rate limits in the report.

4. **Group before acting**
   - Group by bucket and context:
     - money/account/security/legal/travel/family/work: keep/fetch
     - human asks: keep/fetch
     - active project/person: keep/fetch or digest with links
     - digests/newsletters: summarize then archive when low-risk
     - retail/temptation: archive and maybe summarize good sales
     - deterministic trash: archive

5. **Archive only boring safe stuff**
   - Safe: promos, duplicate notification copies, routine app digests, read-later newsletters, delivery noise, low-risk social metrics.
   - Not safe from metadata only: money, security, account access, legal, calendar logistics, real humans, current-project asks, family/school/health.

6. **Fetch bodies when needed**
   - Fetch only `signal`, `risk`, and ambiguous `conditional` threads.
   - Use body reads to extract dates, account, app, amount, due date, required action, or why it is safe to archive.

7. **Report in Joel's preferred shape**
   - Executive summary
   - Context
   - Reasoning
   - Grouped archive receipts
   - Still-open links grouped by why they remain open
   - Proposed rule/Brain updates

8. **Capture learnings**
   - If Joel says "yes archive those," "keep those," "I like summaries like X," or corrects a bucket, update Brain first.
   - Durable process changes belong in this skill.

## Report template

```text
## Executive summary
- Archived: <n>
- Kept/fetch-needed: <n>
- Top things that matter: <3 bullets>

## Context
- Profile/window: joel-combined, <hours>
- Source: Front via shitrat inbox
- Brain maps used: <paths>
- Rate limit/errors: <receipt>

## Reasoning
- <group>: why archived/kept/fetched

## Grouped archive receipts
### <group>
- <subject> — <why> — <Front URL>

## Still open / needs review
### Money/account/security
- <subject> — <why kept> — <Front URL>

### Human/work/calendar
- <subject> — <why kept> — <Front URL>

## Rule candidates
- Add/update `<rule-id>` because <evidence/correction>
```

## Hard rules

- Front is queue truth.
- Brain is preference/context truth.
- Metadata first; body fetch only where it changes a decision.
- No sends, replies, assigns, tags, unsubscribes, or ambiguous archives without explicit approval.
- Do not archive money/security/account/legal/calendar/human-work threads from metadata only.
- Always include Front links in the operator report.
- Preserve secrets. Never echo `shitrat_front_private`.
- If the CLI returns stale inbox IDs or 404s, fix the profile/config or use the current token path; don't handwave.

## Installing / related

- CLI repo: `/Users/joel/Code/joelhooks/shitrat-cli`
- Interest map exporter: `packages/cli/src/inbox/interest-map.ts`
- Front snapshot/pull: `packages/cli/src/inbox/front-snapshot.ts`
- Janitor prompt surface: `packages/cli/src/commands/inbox.ts`
