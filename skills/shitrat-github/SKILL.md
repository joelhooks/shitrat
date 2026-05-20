---
name: shitrat-github
description: Post GitHub issue comments, PR reviews, and small file commits as the ShitRat GitHub App (`shitratgit[bot]`) instead of Joel. Use when reviewing PRs, commenting on issues, doing smoke tests, committing repo files through the GitHub API, or any workflow where GitHub authorship should be ShitRat.
---

# ShitRat GitHub

Use ShitRat when GitHub should show `shitratgit[bot]` as the actor instead of Joel.

## Default rule

Prefer ShitRat for published agent-authored GitHub comments/reviews:

```bash
shitrat status skillrecordings/migrate-egghead
shitrat comment skillrecordings/migrate-egghead 26 --body-file comment.md
shitrat review skillrecordings/egghead-next 1608 --event REQUEST_CHANGES --body-file review.md
shitrat commit-file joelhooks/shitrat-cli --branch main --message "docs: update notes" --file README.md
shitrat commit-files joelhooks/shitrat-cli --branch main --message "docs: update docs" --file README.md --file docs/shitrat-commit-flow.md
```

If the pi extension is loaded, prefer the tools:

- `shitrat_status`
- `shitrat_comment`
- `shitrat_review`
- `shitrat_commit_file`
- `shitrat_commit_files`

## Safety rails

- Do not paste or print the private key.
- Do not use Joel's `gh pr review` when the desired actor is ShitRat.
- Use `shitrat status <owner/repo>` first when repo access is uncertain.
- Use `--body-file` for non-trivial Markdown so shell quoting does not mangle review text.
- Use `shitrat commit-file ... --dry-run` before writing unless Joel explicitly asked to commit as ShitRat.
- `commit-file` is for small, intentional single-file commits. `commit-files` is for small atomic multi-file GitHub API commits. For large/complex changes, commit locally and push normally unless Joel specifically wants ShitRat API commits.
- Only post comments/reviews/commits when the user asked to publish or the workflow clearly requires it.

## Secrets

The CLI reads env first, then `agent-secrets` leases:

- `shitrat_github_app_id`
- `shitrat_github_private_key`
- `shitrat_github_installations_json`
- `shitrat_github_installation_id_<owner_key>` as fallback

Known owner keys:

- `joelhooks`
- `badass_courses`
- `skillrecordings`
- `wzrrd_sh`

## Install as pi package

From the repo root:

```bash
pi install /Users/joel/Code/joelhooks/shitrat-cli
```

Or once pushed:

```bash
pi install git:github.com/joelhooks/shitrat-cli
```
