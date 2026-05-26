# ShitRat Slack Agent — Agent Instructions

Single-operator Slack familiar infrastructure. ShitRat is a loyal, opinionated digital familiar, not a helpdesk chatbot and not a multi-tenant SaaS app.

## Operating rules

- Use the monorepo root `.brain/` for durable project memory before tracker artifacts. Do not recreate a package-local Brain.
- Do not commit Slack tokens, Slack raw dumps, channel IDs from private workspaces, or user data.
- Slack event handlers must ack fast. Heavy work goes through queued/durable execution.
- Default posture: read broadly, speak deliberately.
- No ambient channel auto-replies. Speak only for DMs, mentions, operator reaction triggers, or explicit allowlists.
- Use explicit state machines for Slack ingress, reactions, retries, degraded auth/scope states, and executor lifecycle.
- Prefer Cloudflare Agents SDK as the control plane. Keep local/private execution behind a signed executor bridge.

## Required skills for agents

Load relevant skills before edits:

- `xstate-v5` for finite modes/lifecycle design.
- `documentation-lookup` before changing Cloudflare Agents SDK or Slack API code.
- `systematic-debugging` for failures.
- `pi-notes` / Brain-first workflow for PRDs, plans, and decisions.

## Architecture stance

```text
Slack event
  -> Cloudflare ShitRatAgent Durable Object
  -> normalized intent + state/dedupe
  -> signed joelclaw executor bridge for privileged local work
  -> Slack thread progress/result
```

Cloudflare owns familiar state and Slack ingress. The private executor boundary owns local tools, pi, repo/filesystem work, and private machine actions.
