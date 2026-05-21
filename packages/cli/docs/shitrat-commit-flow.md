# ShitRat GitHub Commit Flow

Use this when the GitHub commit should show as `shitratgit[bot]` instead of Joel.

## One-file commit

1. Verify app access:

```bash
shitrat status joelhooks/shitrat-cli
```

2. Dry-run the payload:

```bash
shitrat commit-file joelhooks/shitrat-cli \
  --branch main \
  --message "docs: update ShitRat notes" \
  --file docs/shitrat-commit-flow.md \
  --dry-run
```

3. Commit the file:

```bash
shitrat commit-file joelhooks/shitrat-cli \
  --branch main \
  --message "docs: update ShitRat notes" \
  --file docs/shitrat-commit-flow.md
```

## Different repo path

Use `--path` when the local source path and repo destination differ, or the local file is outside the current working directory.

```bash
shitrat commit-file joelhooks/shitrat-cli \
  --branch main \
  --message "docs: add commit flow" \
  --file /tmp/commit-flow.md \
  --path docs/shitrat-commit-flow.md
```

## New branch

If the target branch does not exist, create it from an existing branch:

```bash
shitrat commit-file joelhooks/shitrat-cli \
  --branch shitrat/commit-flow \
  --create-branch-from main \
  --message "docs: add commit flow" \
  --file docs/shitrat-commit-flow.md
```

## Multi-file atomic commit

Use `commit-files` for a small batch that should land in one commit:

```bash
shitrat commit-files joelhooks/shitrat-cli \
  --branch main \
  --message "docs: update ShitRat docs" \
  --file README.md \
  --file docs/shitrat-commit-flow.md \
  --dry-run

shitrat commit-files joelhooks/shitrat-cli \
  --branch main \
  --message "docs: update ShitRat docs" \
  --file README.md \
  --file docs/shitrat-commit-flow.md
```

`commit-files` uses Git blobs + trees under the hood, then advances the branch ref once. That makes the batch atomic instead of one commit per file.

Safety caps: each file is capped at 5 MiB and each batch is capped at 10 MiB. This keeps the GitHub API path for small agent commits, not giant artifact nonsense.

## Use normal git instead when

- The change is large or complicated.
- You need local hooks or a full test/commit/push loop.
- You need a signed commit.
- You need custom file modes, deletes, renames, or binary artifacts larger than the safety cap.

`commit-file` and `commit-files` are intentionally small and boring: local file(s), GitHub API commit, JSON receipts.
