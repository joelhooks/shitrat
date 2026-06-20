# ShitRat Vision

## Intent

ShitRat is a deployable agent familiar system.

The current monorepo has two practical jobs:

- provide a GitHub App CLI so agents can act as `shitratgit[bot]` instead of a human account;
- grow the ShitRat familiar surface across CLI, Pi package, Slack agent, inbox tooling, and future sandboxed execution.

The system should let agents take visible, attributable actions with narrow credentials, clear receipts, and project policy boundaries.

## Who It Serves

- Operators who want agent work to be clearly bot-authored.
- Repos that need comments, reviews, commits, and pull requests from a GitHub App actor.
- Future ShitRat surfaces that need a shared identity, command contract, and safety posture.

## Product Bet

Small, typed, boring tools beat ambient automation.

ShitRat should make the safe path obvious:

- status before write;
- dry-run before write;
- JSON envelopes for every command;
- short-lived GitHub App installation tokens instead of personal access tokens;
- public-safe project Brain and private context kept out of committed memory.

## Priorities

1. **Bot-authored GitHub work.** Comments, reviews, commits, and pull requests should be attributable to ShitRat.
2. **Agent-first command contracts.** Commands should emit stable machine-readable envelopes with `ok`, result data, errors, and next actions.
3. **Dry-run discipline.** Write paths should preview payloads before touching GitHub.
4. **Public-safe memory.** Committed Brain may capture architecture and decisions, never secrets, private topology, raw Slack content, customer data, or operator-private context.
5. **Composable familiar surfaces.** CLI, Pi extension, Slack agent, inbox tooling, and sandbox experiments should share identity and policy instead of becoming separate bots.

## Non-Goals

- Do not use a human PAT for GitHub-visible agent actions.
- Do not store private keys, installation tokens, Slack tokens, customer data, private hostnames, or raw private messages in committed project memory.
- Do not make ShitRat a generic multi-tenant SaaS assistant.
- Do not merge PRs unless project policy and explicit approval allow it.
- Do not treat a visual identity or custom username as a real installed bot identity.

## Merge By Default

Merge small, tested changes that:

- make CLI responses more predictable for agents;
- improve GitHub App auth, dry-run, or receipt behavior;
- add narrow command coverage with clear safety caps;
- document public-safe project decisions;
- improve package boundaries without copying private context into the repo.

## Needs Owner Sign-Off

Stop for explicit approval before:

- broadening GitHub permissions or installation scope;
- changing credential storage or lease behavior;
- adding autonomous merge/deploy behavior;
- posting into new private communication surfaces;
- changing public ShitRat identity, Slack behavior, or summon rules;
- moving sandboxed execution from read-only/spike mode into real code-writing authority.

## Evidence Of Progress

ShitRat is improving when:

- agents can open draft PRs and leave reviews as `shitratgit[bot]`;
- dry-run receipts are enough to approve or reject a write;
- command failures explain the missing permission or next command;
- committed project Brain stays useful and sanitized;
- new surfaces reuse the same safety model instead of inventing their own.
