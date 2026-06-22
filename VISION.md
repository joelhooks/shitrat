# ShitRat Vision

## Intent

ShitRat is the agent-first GitHub App and harness context system for Joel's coding-agent work.

It exists to give Codex Desktop, Pi, Claude, Slack, and future agent harnesses a consistent operating profile, a safe GitHub-visible actor, and dry-run-first tooling. It is not just a prompt blob and it is not a way for agents to act as Joel.

## Who It Serves

- Operators who need agent-authored GitHub work to use a distinct bot identity.
- Coding agents that need typed commands, JSON envelopes, next actions, and short-lived credentials.
- Harness adapters that need shared defaults plus local/private overlays.
- Repos that need source-grounded comments, reviews, commits, and PRs without using a human token.

## Product Bet

The useful shape is a semantic context system plus a narrow GitHub App CLI.

Public defaults should be safe to share. Private overlays should stay private. Real writes should be explicit, attributable, and easy to dry-run first. Every command should return machine-readable output that another agent can use without scraping prose.

## Priorities

1. Keep GitHub-visible work authored by `shitratgit[bot]`, not Joel.
2. Keep the CLI JSON-only with stable envelopes, errors, and `next_actions`.
3. Prefer dry-run commands before comments, reviews, commits, PRs, installs, and merges.
4. Separate public defaults from private overlays, secrets, host wiring, and paid/private corpora.
5. Keep harness adapters boring: Codex Desktop, Pi, Claude, and Slack should compile from the same semantic source.
6. Preserve source-grounded reviews, receipt trails, and exact follow-up commands.
7. Keep vendored Effect and Pi trees as read-only references unless the task is explicitly about updating them.

## Non-Goals

- Do not impersonate Joel or use Joel's personal GitHub token for agent-authored work.
- Do not store private keys, installation tokens, private overlays, secrets, host topology, or personal context in public defaults.
- Do not make real install writes the default path.
- Do not make broad harness promises before the adapter contract is proven.
- Do not edit vendored reference trees as part of normal CLI work.

## Merge By Default

Merge small, tested changes that:

- improve CLI envelopes, parser errors, repo validation, or `next_actions`;
- improve ShitRat GitHub App status, comment, review, commit, PR, or merge dry-runs;
- clarify public defaults, semantic context modules, or harness adapter boundaries;
- improve installer planning without enabling unsafe writes;
- add focused tests for command output, repo parsing, and dry-run behavior.

## Needs Owner Sign-Off

Stop for explicit approval before:

- enabling real install writes by default;
- changing credential storage, app permissions, or token handling;
- publishing private overlays or private operator context;
- adding broad new harness behavior that changes installed prompts;
- merging PRs, tagging releases, or publishing binaries from automation;
- changing the default familiar identity in public artifacts.

## Evidence Of Progress

ShitRat is getting better when:

- `bun run check`, `bun run test`, and `bun run build` pass for the CLI;
- `shitrat status <repo>` gives clear access and permission state;
- dry-run commands show exactly what would be written before any write;
- PRs and comments are attributable to `shitratgit[bot]`;
- public defaults compile across target harnesses without leaking private context;
- the next agent can read a JSON envelope and know the next safe command.
