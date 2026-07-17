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

# Preview a branch merge as shitratgit[bot]
bun run src/cli.ts merge joelhooks/shitrat-cli --base main --head feature-branch --message "merge: feature branch" --dry-run

# Merge a branch as shitratgit[bot]
bun run src/cli.ts merge joelhooks/shitrat-cli --base main --head feature-branch --message "merge: feature branch"

# Preview/update ShitRat harness install files
# Pi APPEND_SYSTEM.md updates replace only the delimited ShitRat block and preserve local instructions.
bun run src/cli.ts update pi --dry-run

# Preview one-file GitHub API commit as shitratgit[bot]
bun run src/cli.ts commit-file joelhooks/shitrat-cli --branch main --message "docs: update README" --file README.md --dry-run

# Commit one file as shitratgit[bot]
bun run src/cli.ts commit-file joelhooks/shitrat-cli --branch main --message "docs: update README" --file README.md

# Atomically commit multiple files as shitratgit[bot]
bun run src/cli.ts commit-files joelhooks/shitrat-cli --branch main --message "docs: update ShitRat docs" --file README.md --file docs/shitrat-commit-flow.md

# Preview a push of the checked-out branch using GitHub App credentials
bun run src/cli.ts push joelhooks/shitrat-cli --repo-dir . --dry-run

# Push existing local commits (all outgoing authors must be shitratgit[bot])
bun run src/cli.ts push joelhooks/shitrat-cli --repo-dir .

# Preview opening a pull request as shitratgit[bot]
bun run src/cli.ts create-pr joelhooks/shitrat-cli --title "docs: propose vision" --head shitrat/propose-vision --base main --body-file pr.md --dry-run

# Open a pull request as shitratgit[bot]
bun run src/cli.ts create-pr joelhooks/shitrat-cli --title "docs: propose vision" --head shitrat/propose-vision --base main --body-file pr.md

# Preview merging a pull request as shitratgit[bot]
bun run src/cli.ts merge-pr joelhooks/shitrat-cli 123 --method squash --dry-run

# Merge a pull request as shitratgit[bot] when project policy allows
bun run src/cli.ts merge-pr joelhooks/shitrat-cli 123 --method squash
```

## Commit doctrine

When a checkout exists, commit locally as `shitratgit[bot]`, let the repository's commit hooks run, and publish the unchanged commits with `shitrat push`. `push` fetches first, checks the checkout's `origin`, rejects non-bot outgoing authors unless `--allow-any-author` is explicit, and never amends, rebases, or force-pushes. It passes `--no-verify` and disables submodule recursion for authenticated Git commands so checkout-controlled hooks or nested repositories cannot inherit the short-lived installation token.

Use `commit-file` and `commit-files` for clone-less edits. They commit through the GitHub API with web-flow signing, so they cannot run local hooks. They remain useful for small remote-only changes, not normal worktree development.

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

- `extensions/shitrat`: pi extension that registers `shitrat_status`, `shitrat_comment`, `shitrat_review`, `shitrat_merge`, `shitrat_commit_file`, and `shitrat_commit_files` tools.
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
