# ShitRat CLI Agent Notes

ShitRat CLI is an agent-first GitHub App CLI and pi package. It posts as `shitratgit[bot]`, not Joel.

## Stack

- Bun for package management and runtime.
- Effect CLI for commands and JSON envelopes.
- TypeScript 7 native preview (`tsgo` from `@typescript/native-preview`) for type checks/build.
- GitHub App installation tokens via short-lived credentials.
- Pi package resources in `extensions/` and `skills/`.

## Rules

- JSON-only CLI output. No tables, ANSI, or prose-only success output.
- Use HATEOAS `next_actions` in every command response.
- Do not print private keys or installation tokens by default.
- Prefer `--body-file` for GitHub comments/reviews.
- Use `shitrat status <owner/repo>` before posting if access is uncertain.
- Do not use `gh pr review` when the intended GitHub actor is ShitRat.

## Commands

```bash
bun run check
bun test
bun run build
bun run src/cli.ts status skillrecordings/migrate-egghead
```

## Vendored source trees

- `/effect`: shallow squashed subtree of `Effect-TS/effect`
- `/pi`: shallow squashed subtree of `earendil-works/pi-mono`

Do not edit vendored trees unless the task is explicitly about updating references.
