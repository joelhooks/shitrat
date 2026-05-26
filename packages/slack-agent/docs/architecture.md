# Architecture

## Goal

ShitRat should be Joel's Slack-native familiar for the whole workbench: present in Slack, useful across local tools, and not an auto-reply sewer pipe.

## Agent plane

Cloudflare Agents SDK owns the familiar runtime:

- `ShitRatAgent:joel` Durable Object instance
- state, dedupe, active session registry
- Slack event ingress
- reaction/mention/DM intent normalization
- progress/result callbacks

Flue is the first-class candidate for the headless agent harness/session layer inside the Cloudflare-hosted agent:

- typed agent handlers
- session prompts with structured results
- roles/skills/context as agent substrate
- Cloudflare-compatible shell/virtual workspace patterns
- a seam for later local or remote execution backends

## Privileged local execution plane

joelclaw is a later target for privileged local work, not the first thing to optimize around. When ShitRat needs local filesystem, repo, machine secrets, k8s/restate, or pi access, Cloudflare should route through signed joelclaw ingress. Panda is the current host, but host identity is intentionally replaceable because a beefier central joelclaw machine is expected to take over.

## V1 flow

```text
Slack :rat: reaction
  -> verify Slack signature
  -> normalize `summon` intent
  -> dedupe by team/channel/ts/event
  -> add ack reaction
  -> POST signed job to joelclaw executor
  -> record active job state
  -> post threaded status
  -> accept executor callback
  -> update state + post final reply
```

## State machine sketch

```text
idle
  -> acknowledging
  -> dispatching
  -> awaitingResult
  -> idle
  -> degraded on Slack/API/bridge failure
```

The checked-in XState sketch lives in `src/state/shitrat-machine.ts`.

## Non-goals for V1

- no multi-user OAuth product
- no broad auto-posting
- no raw Slack warehouse
- no direct shell from Cloudflare
- no bot-token omnipresence claims
