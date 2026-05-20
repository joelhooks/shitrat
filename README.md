# ShitRat CLI 🐀

GitHub App CLI and pi package for posting as `shitratgit[bot]` instead of Joel.

ShitRat uses short-lived GitHub App installation tokens, not Joel's PAT. The CLI is agent-first: every command emits a JSON envelope with `ok`, `result`, and `next_actions`.

## Install

```bash
bun install
bun run check
bun run test
bun run build
```

Optional local binary:

```bash
bun run build:binary
cp dist/shitrat ~/.bun/bin/shitrat
```

## Required secrets

The CLI reads environment variables first, then `agent-secrets` leases.

```bash
secrets add shitrat_github_app_id --value '3782744'
secrets add shitrat_github_client_id --value 'Iv23liAHqTYZQsEkRJRx'
secrets add shitrat_github_private_key --value "$(cat /path/to/shitratgit.private-key.pem)"
secrets add shitrat_github_installations_json --value '{"badass-courses":134074872,"skillrecordings":134074954,"wzrrd-sh":134075002}'
```

Fallback per-owner installation secrets are also supported:

```bash
secrets add shitrat_github_installation_id_skillrecordings --value '134074954'
secrets add shitrat_github_installation_id_badass_courses --value '134074872'
secrets add shitrat_github_installation_id_wzrrd_sh --value '134075002'
```

## Commands

```bash
# Discover command tree
bun run src/cli.ts

# List app installations
bun run src/cli.ts installations

# Verify access and permissions
bun run src/cli.ts status skillrecordings/migrate-egghead

# Post issue/PR conversation comment as shitratgit[bot]
bun run src/cli.ts comment skillrecordings/migrate-egghead 26 --body-file comment.md

# Create PR review as shitratgit[bot]
bun run src/cli.ts review skillrecordings/egghead-next 1608 --event REQUEST_CHANGES --body-file review.md

# Preview one-file GitHub API commit as shitratgit[bot]
bun run src/cli.ts commit-file joelhooks/shitrat-cli --branch main --message "docs: update README" --file README.md --dry-run

# Commit one file as shitratgit[bot]
bun run src/cli.ts commit-file joelhooks/shitrat-cli --branch main --message "docs: update README" --file README.md

# Atomically commit multiple files as shitratgit[bot]
bun run src/cli.ts commit-files joelhooks/shitrat-cli --branch main --message "docs: update ShitRat docs" --file README.md --file docs/shitrat-commit-flow.md
```

Review events:

- `COMMENT`
- `APPROVE`
- `REQUEST_CHANGES`

More detail: [`docs/shitrat-commit-flow.md`](docs/shitrat-commit-flow.md)

## Diff viewer

Hunk is configured as the system and repo-local Git difftool:

```bash
git difftool
git difftool --staged
git difftool main...HEAD
```

More detail: [`docs/hunk-diff-viewer.md`](docs/hunk-diff-viewer.md)

## Pi package

This repo includes:

- `extensions/shitrat`: pi extension that registers `shitrat_status`, `shitrat_comment`, `shitrat_review`, `shitrat_commit_file`, and `shitrat_commit_files` tools.
- `skills/shitrat-github`: skill instructions for using ShitRat as the GitHub actor.

Install locally:

```bash
pi install /Users/joel/Code/joelhooks/shitrat-cli
```

Install from GitHub after push:

```bash
pi install git:github.com/joelhooks/shitrat-cli
```

## Test scope

Use the scoped project test script:

```bash
bun run test
```

Do not use broad `bun test` as the project health check. It descends into vendored `/pi` reference source tests and can fail on Vitest API mismatch outside ShitRat’s code.

## TypeScript 7 / tsgo

This project uses the Microsoft TypeScript-Go native compiler preview via `@typescript/native-preview`.

```bash
bun run check # tsgo --noEmit --pretty false
```

Reference: https://github.com/microsoft/typescript-go

## Vendored source references

The repo keeps shallow, squashed source snapshots for local reference:

- `/effect`: `Effect-TS/effect`
- `/pi`: `earendil-works/pi-mono`

They are reference trees, not runtime dependencies.
