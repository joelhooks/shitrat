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
shitrat merge joelhooks/shitrat-cli --base main --head feature-branch --message "merge: feature branch"
shitrat push joelhooks/shitrat-cli --repo-dir /path/to/checkout
shitrat commit-file joelhooks/shitrat-cli --branch main --message "docs: update notes" --file README.md
shitrat commit-files joelhooks/shitrat-cli --branch main --message "docs: update docs" --file README.md --file docs/shitrat-commit-flow.md
```

If the pi extension is loaded, prefer the tools:

- `shitrat_status`
- `shitrat_comment`
- `shitrat_review`
- `shitrat_merge`
- `shitrat_commit_file`
- `shitrat_commit_files`

## Safety rails

- Do not paste or print the private key.
- Do not use Joel's `gh pr review` when the desired actor is ShitRat.
- Use `shitrat status <owner/repo>` first when repo access is uncertain.
- Use `--body-file` for non-trivial Markdown so shell quoting does not mangle review text.
- Use `--dry-run` before writing unless Joel explicitly asked to commit/merge as ShitRat.
- `merge` uses GitHub's merge endpoint to merge one branch into another as `shitratgit[bot]`, so do not fake a merge by replaying branch contents onto `main`.
- When a checkout exists, commit locally as `shitratgit[bot]` so commit hooks run, then publish the unchanged commits with `shitrat push`. It rejects non-bot outgoing authors unless `--allow-any-author` is explicit, disables `pre-push` hooks so they cannot inherit the installation token, and never rewrites history or force-pushes.
- `commit-file` is for small, intentional clone-less edits. `commit-files` is for small atomic clone-less batches. On existing branches they use GitHub blobs/trees with web-flow signing; on brand-new empty repos they create one root commit through a temporary ShitRat-authenticated git push. They cannot run local hooks.
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
