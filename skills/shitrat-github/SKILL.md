---
name: shitrat-github
description: Post GitHub issue comments and PR reviews as the ShitRat GitHub App (`shitratgit[bot]`) instead of Joel. Use when reviewing PRs, commenting on issues, doing smoke tests, or any workflow where GitHub authorship should be ShitRat.
---

# ShitRat GitHub

Use ShitRat when GitHub should show `shitratgit[bot]` as the actor instead of Joel.

## Default rule

Prefer ShitRat for published agent-authored GitHub comments/reviews:

```bash
shitrat status skillrecordings/migrate-egghead
shitrat comment skillrecordings/migrate-egghead 26 --body-file comment.md
shitrat review skillrecordings/egghead-next 1608 --event REQUEST_CHANGES --body-file review.md
```

If the pi extension is loaded, prefer the tools:

- `shitrat_status`
- `shitrat_comment`
- `shitrat_review`

## Safety rails

- Do not paste or print the private key.
- Do not use Joel's `gh pr review` when the desired actor is ShitRat.
- Use `shitrat status <owner/repo>` first when repo access is uncertain.
- Use `--body-file` for non-trivial Markdown so shell quoting does not mangle review text.
- Only post comments/reviews when the user asked to publish or the workflow clearly requires it.

## Secrets

The CLI reads env first, then `agent-secrets` leases:

- `shitrat_github_app_id`
- `shitrat_github_private_key`
- `shitrat_github_installations_json`
- `shitrat_github_installation_id_<owner_key>` as fallback

Known owner keys:

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
