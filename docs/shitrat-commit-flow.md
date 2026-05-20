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

## Use normal git instead when

- The change spans many files.
- You need local hooks or a full test/commit/push loop.
- You need a signed commit.

`commit-file` is intentionally small and boring: one local file, one GitHub API commit, JSON receipts.
