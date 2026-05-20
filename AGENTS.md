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
- Use `shitrat commit-file ... --dry-run` before GitHub API commits unless Joel explicitly approved the write.
- Do not use `gh pr review` when the intended GitHub actor is ShitRat.
- Hunk is the default Git difftool here. Use `git difftool` only when Joel asks for an interactive diff viewer; otherwise inspect diffs with normal non-interactive git commands or Hunk session commands.

## Commands

```bash
bun run check
bun test
bun run build
bun run src/cli.ts status skillrecordings/migrate-egghead
bun run src/cli.ts commit-file joelhooks/shitrat-cli --branch main --message "docs: update README" --file README.md --dry-run
bun run src/cli.ts commit-files joelhooks/shitrat-cli --branch main --message "docs: update docs" --file README.md --file docs/shitrat-commit-flow.md --dry-run
```

## Vendored source trees

- `/effect`: shallow squashed subtree of `Effect-TS/effect`
- `/pi`: shallow squashed subtree of `earendil-works/pi-mono`

Do not edit vendored trees unless the task is explicitly about updating references.
