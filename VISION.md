# ShitRat Vision

## Intent

ShitRat is the deployable agent familiar for Joel's coding-agent harnesses.

It exists to make agent behavior portable across Codex Desktop, Pi, Claude, Slack, and future runtimes without hiding important rules in one-off prompts. The repo should provide a small semantic context system: public defaults, private overlays, typed prompt modules, harness adapters, and dry-run-first install tooling.

## Who It Serves

- Operators who want one familiar agent profile across local and hosted harnesses.
- Coding agents that need consistent source-control, GitHub, Brain, and safety rules.
- Maintainers who need ShitRat-authored GitHub actions to be auditable and distinct from Joel-authored work.
- Future users who should be able to install public defaults without receiving Joel's private topology, secrets, or personal context.

## Current Product Bet

ShitRat should be a real context runtime, not a copied prompt blob.

The bet is that semantic prompt modules plus explicit private overlays can keep agent behavior consistent while preserving a hard public/private boundary. Dry-run-first tooling should make install, compile, parity, and GitHub App actions inspectable before they mutate anything.

## Priorities

1. **Semantic context over prompt paste.** Keep identity, tool policy, Brain policy, receipts, and private overlays as validated prompt primitives.
2. **Harness parity.** Codex Desktop, Pi, Claude, and Slack adapters should share the same underlying contracts where possible.
3. **Public-safe defaults.** The committed repo must not leak private machine names, hostnames, personal details, secrets, raw Slack data, or private operational receipts.
4. **Dry-run-first operations.** Install, compile, GitHub App actions, and maintenance commands should produce receipts before writes.
5. **ShitRat-authored GitHub work.** Agent-authored commits, comments, reviews, PRs, and merges should go through the GitHub App actor where available.
6. **Small, typed CLI surfaces.** Commands should return structured output that another agent can consume without scraping prose.

## Non-Goals

- Do not turn ShitRat into a personal private-memory dump.
- Do not make raw local prompts the source of truth when semantic modules can own the contract.
- Do not make install commands silently mutate user environments without dry-run receipts.
- Do not use Joel-authenticated GitHub writes for agent-authored public work when the ShitRat actor is available.
- Do not couple public defaults to one local machine, tailnet, account, or private repo layout.

## Merge By Default

Merge small, tested changes that:

- improve CLI command structure, JSON output, or dry-run receipts;
- clarify public/private memory boundaries;
- add or harden harness adapters without weakening parity;
- make GitHub App actions safer, more explicit, or easier to audit;
- improve semantic prompt validation and compilation;
- keep private overlays out of committed source.

## Needs Owner Sign-Off

Stop for explicit approval before:

- changing ShitRat's public identity, name, or default persona;
- broadening GitHub App permissions or write behavior;
- adding new private-overlay fields that could leak sensitive local context;
- enabling real install writes where dry-run-only behavior is currently expected;
- changing how agent-authored GitHub work is attributed;
- publishing private operator facts, hostnames, account names, or secrets.

## Evidence Of Progress

ShitRat is getting better when:

- `doctor`, `compile`, `install --dry-run`, and parity checks produce useful receipts;
- GitHub App commands clearly report actor, repo, permission, dry-run, and next-action state;
- public defaults can be reviewed without private leakage;
- private overlays can customize behavior without forked prompts;
- Codex Desktop, Pi, Claude, and Slack behavior stay recognizably consistent;
- automation PRs can be labeled and reviewed without falling back to Joel-authenticated writes.
