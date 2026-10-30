# ShitRat CLI 🐀

GitHub App CLI and pi package for posting as `shitratgit[bot]` instead of Joel.

ShitRat uses short-lived GitHub App installation tokens, not Joel's PAT. The CLI is agent-first: commands emit a JSON envelope with `ok`, `result`, and `next_actions`. `runner-token` is the exception: stdout contains only the registration token and a newline; expiry, help, and errors go to stderr.

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

# Reply to an inline PR review comment thread as shitratgit[bot]
bun run src/cli.ts reply skillrecordings/egghead-next 1608 123456 --body-file reply.md

# Edit a pull request's title, body, base branch, or state as shitratgit[bot]
bun run src/cli.ts edit-pr skillrecordings/egghead-next 1608 --title "fix: clearer title" --body-file pr.md --base main --state open

# Preview an annotated tag; --target must be a full existing commit SHA. Default is dry-run.
bun run src/cli.ts tag example/project --name v0.1.0 --target aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --message "Release v0.1.0" --dry-run

# Preview a release; the tag must already exist. Default is dry-run.
bun run src/cli.ts release example/project --tag v0.1.0 --title "First release" --notes-file notes.md --dry-run
# Alternative: ask GitHub to generate notes; --draft and --prerelease are optional.
bun run src/cli.ts release example/project --tag v0.1.0 --generate-notes --draft --prerelease --dry-run
# For either command, replace --dry-run with --yes only after approving the payload.

# Mark a draft pull request ready for review as shitratgit[bot]; --dry-run reads it and writes nothing
bun run src/cli.ts ready-pr badass-courses/drovr 698 --dry-run

# Add a pull request to its base branch's merge queue; reports the entry's position and state.
# The queue's ruleset picks the merge method; --method only refuses when it differs.
# merge-pr answers MERGE_QUEUE_REQUIRED on a queue-required branch and points here.
bun run src/cli.ts enqueue-pr badass-courses/drovr 696 --method squash --dry-run

# Convert a pull request back to a draft; GitHub also drops it from the merge queue
bun run src/cli.ts convert-to-draft badass-courses/drovr 696 --dry-run

# Add and remove labels on an issue or pull request. --add refuses a label the repo lacks;
# --remove of a label that is not there is a no-op.
bun run src/cli.ts label badass-courses/drovr 886 --add "NO MERGE" --dry-run

# Create a commit status. A short sha is resolved to the full sha, or refused if GitHub cannot.
bun run src/cli.ts set-status badass-courses/drovr <sha> --state failure --context gavel/hold --description "Held by review" --dry-run

# CI reads on the app's 5,000/hour budget instead of unauthenticated curl. Reads print JSON
# and exit 1 on failure with a typed error.code (NOT_FOUND, PERMISSION_DENIED, RATE_LIMITED).
bun run src/cli.ts checks badass-courses/drovr <sha>
bun run src/cli.ts pr-status badass-courses/drovr 867
# Needs Actions: read on the app; without it, PERMISSION_DENIED. --tail 0 returns the whole log.
bun run src/cli.ts run-log badass-courses/drovr <job-id> --tail 300
# Rerun a workflow run, or only its failed jobs. Reports run_attempt as GitHub reads it back;
# 403/404/409 come back as typed errors (PERMISSION_DENIED, NOT_FOUND, CONFLICT).
bun run src/cli.ts rerun badass-courses/drovr <run-id> --failed --dry-run

# Preview an org runner group restricted to exactly one private repo. Existing access is replaced.
bun run src/cli.ts runner-group --org example --name isolated --repo example/project --dry-run
# Apply only after authorizing the runner group change.
bun run src/cli.ts runner-group --org example --name isolated --repo example/project
# Restrict workflow access too. Repeat --workflow for each allowed workflow/ref.
bun run src/cli.ts runner-group --org example --name isolated --repo example/project --workflow example/project/.github/workflows/deploy.yml@refs/heads/main --dry-run
# Undo only workflow restrictions, keeping the one-repository policy.
bun run src/cli.ts runner-group --org example --name isolated --repo example/project --all-workflows --dry-run
# Read group policy and selected repository names, optionally filtered by name.
bun run src/cli.ts runner-groups --org example --name isolated
# Read back org runners, optionally restricted to a group.
bun run src/cli.ts runners --org example --group isolated
# Read repository-level runners (exactly one of --org or --repo is required).
bun run src/cli.ts runners --repo example/project
# Preview removal of an offline, idle repository runner. This still reads GitHub.
bun run src/cli.ts runner-remove --repo example/project --id 10 --dry-run
# Remove only after authorizing the deletion.
bun run src/cli.ts runner-remove --repo example/project --id 10
# Mint an org registration token only when needed. Keep stdout on a private pipe;
# do not redirect it to a file/log or pass it through a child process argv.
# A 403 names the endpoint and required permission; stop rather than adding permissions.
bun run src/cli.ts runner-token --org example

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
# After a real push or create-pr, `fleet-compute attest` runs best-effort when it is on PATH.
# Exit 3 (or FLEET_ATTEST=off) adds nothing; other outcomes appear as `attest` in the result. The push never fails on it.
# Every attempt is appended to ~/.shitrat/log/attest.jsonl (ts, repo, sha, shitrat_build, exit, reason or stderr).

# Preview opening a pull request as shitratgit[bot]
bun run src/cli.ts create-pr joelhooks/shitrat-cli --title "docs: propose vision" --head shitrat/propose-vision --base main --body-file pr.md --dry-run

# Open a pull request as shitratgit[bot]
bun run src/cli.ts create-pr joelhooks/shitrat-cli --title "docs: propose vision" --head shitrat/propose-vision --base main --body-file pr.md

# Preview merging a pull request as shitratgit[bot]
bun run src/cli.ts merge-pr joelhooks/shitrat-cli 123 --method squash --dry-run

# Merge a pull request as shitratgit[bot] when project policy allows
bun run src/cli.ts merge-pr joelhooks/shitrat-cli 123 --method squash

# Inspect an X Article payload without contacting X
bun run src/cli.ts x article draft --title "The past blocked the future" --html-file ./post.html --dry-run

# Re-authorize the X OAuth2 user token in the browser (PKCE), then confirm it
bun run src/cli.ts x auth --account joelhooks
bun run src/cli.ts x me --account joelhooks
```

### X OAuth2 authorization

`x auth` opens X's consent page with a PKCE (S256) challenge and waits on a loopback callback, `http://127.0.0.1:8721/callback` by default. That URL must be registered on the X app; pass `--redirect-uri` for another one. The authorize URL also prints on stderr straight away, so `--no-open` works in a pane without a browser. It gives up after `--timeout-seconds` (default 300).

Default scopes are `tweet.read users.read dm.read offline.access tweet.write media.write`. The write scopes keep `x article` and cover uploads working after a re-consent. Repeat `--scope` to replace the set.

The stored tokens change only after every check passes: callback state matches, the exchange succeeds, every requested scope was granted, and `users/me` with the new token returns the expected `@account`. Anything else fails with a named code and writes nothing. The refresh token is written first, then the access token. Values go to `secrets` on stdin and are read back to confirm. The store has no multi-key transaction, so a failure between the two writes leaves a new refresh token with a stale access token; the next `x auth` run fixes it. Token values never appear in output.

### Runner group workflow policy

`runner-group --workflow` accepts only workflows owned by `--org`, using `.github/workflows/<file>.yml` or `.yaml` and a full `@refs/heads/<branch>` or `@refs/tags/<tag>` ref. Wildcards, bare branches and commit SHAs are refused. Repeat the flag to allow more workflows. Readback must match the exact requested workflow set, regardless of order.

`--all-workflows` disables the workflow restriction and verifies that GitHub saved `false`. It cannot be combined with `--workflow`. Without either flag, workflow fields are omitted from requests and existing workflow restrictions stay untouched. Dry-run includes the intended workflow policy and performs no writes.

A 403, 422 or read-only workflow policy fails with the endpoint, status and `workflow restriction not available for this group or plan`. There is no retry or repository-only fallback. Updates still use separate policy and repository-access requests, so failures can leave a partial change. Inspect with `runner-groups` before retrying. The read command paginates groups and selected repositories; a missing named group fails.

### Repository runners

`runners --repo <owner/repo>` uses the repository owner's App installation and paginates repository-level runners. It returns `id`, `name`, `os`, `status`, `busy`, label names and `runner_group_id` when GitHub provides it. Exactly one of `--org` or `--repo` is required. `--group` is only valid with `--org`; the existing organization read is unchanged.

`runner-remove --repo <owner/repo> --id <positive-integer> [--dry-run]` reads first and proceeds only when `status` is exactly `"offline"` and `busy` is exactly `false`. Online, busy, unknown or missing state refuses without a DELETE and reports the observed status and busy values. Dry-run reports the intended DELETE without sending it. A confirmed removal sends one DELETE and requires a runner GET 404 plus a successful paginated list without that id. A runner GET 404 alone can also mean missing App permissions, so both initial absence and post-delete absence require that list check. Results report `readback: { single: 404, listed: false }`; an already absent runner returns `removed: false, alreadyAbsent: true` without a DELETE. Dry-run of a present runner has no readback field because no deletion was attempted.

Requests use existing repository `administration` permissions. A 403 or permission-masked 404 fails with sanitized endpoint, status and permission context. There are no retries or permission changes. A readback failure after DELETE can mean deletion happened but could not be verified; inspect with `runners --repo` before retrying. The pre-delete read is not atomic with DELETE: keep the runner stopped while removing its registration.

## Delete merged branches

```bash
# Preview only. Supply branch names, not refs/heads/... refs.
bun run src/cli.ts delete-branch --branch land/abc1234 example/project
# Repeat --branch, or use a file with one name per line (not both).
bun run src/cli.ts delete-branch --branches-file merged-branches.txt --dry-run example/project
# After reviewing the preview, confirm the same inputs.
bun run src/cli.ts delete-branch --branches-file merged-branches.txt --yes example/project
```

`delete-branch` defaults to dry run. `--yes` permits deletion; combining it with `--dry-run` is an error. The installation token needs Contents: read for previews and Contents: write for deletion. No App permissions are changed by this command.

Each branch is checked serially. The command refuses the repository's default branch and branches whose branch GET reports protection. It reads the ref SHA and compares `default...sha`, accepting only `behind` or `identical`. `ahead` and `diverged` return `NotMerged`. A missing ref returns `alreadyAbsent` without a DELETE. Missing protection metadata with a present ref fails closed. After the merge check, preflight lists open pull requests with `state=open` and `head={owner}:{branch}`, including during previews. Any returned PR refuses deletion as `OpenPullRequest`, naming the PR numbers. The App must be able to read this PR endpoint; failures stop that branch rather than treating the result as an empty list. Permission failures name the endpoint, HTTP status and `contents: write`, without exposing GitHub response bodies or credentials.

Confirmed writes re-read the ref immediately before DELETE. A changed or disappeared SHA returns `BranchMoved`. Deletion succeeds only after a ref GET returns HTTP 404. GitHub has no conditional-SHA DELETE: another writer can still move the ref after the last read, so keep branch writers paused during cleanup. A failed readback can leave a real deletion; inspect state rather than retrying blindly. `github_write` reports whether any DELETE was attempted, not whether every deletion succeeded.

### Branches preserved by a tag

```bash
# Preview. One --branch only; the tag is a short name, not refs/tags/...
bun run src/cli.ts delete-branch --branch dist/abc1234 --preserved-by-tag dist/abc1234 example/project
bun run src/cli.ts delete-branch --branch dist/abc1234 --preserved-by-tag dist/abc1234 --yes example/project
```

Some branches never merge into the default branch, such as a parentless dist commit. GitHub answers `compare` on unrelated histories with HTTP 404, so the normal merge check fails. `--preserved-by-tag <tag>` replaces only that merge check, and makes no compare call. The command reads `GET /repos/{owner}/{repo}/git/ref/tags/{tag}` and peels it to a commit. A lightweight tag is its own commit. An annotated tag follows `GET .../git/tags/{sha}` through at most five tag objects. The peeled commit must equal the branch SHA exactly.

Refusals: a missing tag is `TagMissing`; a different commit is `TagMismatch`, naming both SHAs; a tag that ends at a tree or blob is `TagNotCommit`; more than five nested tag objects is `TagPeelTooDeep`. With `--yes`, the tag is re-read and re-peeled right after the branch re-read and before DELETE. A missing tag or a different peeled SHA refuses `TagMoved`. Every other guard is unchanged: default-branch refusal, fail-closed protection, open-PR preflight, `BranchMoved`, the 404 readback, dry run by default and the audit rules. `--preserved-by-tag` with `--branches-file` or a repeated `--branch` is a usage error before any request. Tag reads need Contents: read. Records keep `compare_status: null` and add `preserved_by_tag`, `tag_object_sha` (what the tag ref points at) and `tag_peeled_sha`. Without the flag, output is unchanged.

Every branch result, including previews and refusals, appends a JSONL record with repo, branch, SHA, compare status, outcome, timestamp and CLI version. The default log is `~/.local/state/shitrat/branch-deletes.jsonl`. Use `--log <path>` to choose another file. The parent directory must have mode 0700; newly created directories use 0700. The file uses 0600. Existing logs are appended, never truncated; symlink log files and non-private parent directories are refused before deletion. Log writes are flushed after each branch. Audit failures stop the batch, because continuing could delete branches without receipts.

The JSON envelope includes per-branch results and outcome counts, even when `ok` is false. A refusal or failure makes the exit code nonzero without stopping later branches. A rate limit honors `Retry-After` once through the same installation client; a repeated limit stops further requests with `RateLimited` and logs the remaining branches as failed. A Retry-After longer than five minutes also stops immediately, without sleeping or retrying; the typed error includes the reset time in its message and `reset_at` field. Short waits still retry once. Tests use fake HTTP only.

## Cancel stale waiting runs

```bash
# Preview only. Lists pending, queued and waiting preview.yml runs created before the cutoff.
bun run src/cli.ts cancel-runs --workflow preview.yml --created-before 2026-10-26T00:00:00Z --dry-run example/project
# After reviewing the preview, confirm the same inputs.
bun run src/cli.ts cancel-runs --workflow preview.yml --created-before 2026-10-26T00:00:00Z --yes example/project
```

`cancel-runs` clears runs that are stuck waiting in a workflow's concurrency queue. GitHub caps that queue, and a full queue makes new runs fail at creation with no jobs. The command defaults to dry run. `--yes` permits cancellation; `--dry-run` always wins, even next to `--yes`. `--workflow` takes the workflow file name and `--created-before` takes an ISO-8601 timestamp with a timezone. Both are required, and a future cutoff is refused, so there is no cancel-everything form. The installation token needs Actions: read for previews and Actions: write for cancellation. No App permissions are changed by this command.

`--status` is repeatable and defaults to `pending`, `queued` and `waiting`. Any other value, including `in_progress`, `requested` and completed states, refuses before authentication: cancelling a started run can kill a deploy or preview mid-apply. `--max` defaults to 200 and cannot exceed 500. Runs are listed per status from `GET /repos/{owner}/{repo}/actions/workflows/{file}/runs`, paged, deduplicated, kept only when `created_at` is strictly before the cutoff, and processed oldest first. The result reports `skipped_after_cutoff` and `remaining_over_max`.

Each run is checked serially. A listed run whose status is outside the allowed set refuses as `refused:StatusNotWaiting` without a request. Confirmed writes re-read the run immediately before `POST .../actions/runs/{id}/cancel`; a run that has left the waiting set refuses as `refused:StatusChanged`. Cancellation succeeds only when a readback shows `completed` with conclusion `cancelled`, within five reads about two seconds apart. Anything else is `failed:ReadbackMismatch`. GitHub has no conditional cancel, so a run can still start between the last read and the POST; a failed readback can still leave a real cancellation, so inspect the run rather than resending blindly. `github_write` reports whether any POST was sent.

Every processed run appends a JSONL record with repo, run id, workflow, head SHA, `created_at`, `status_before`, outcome (`cancelled`, `would-cancel`, `refused:<code>` or `failed:<code>`), timestamp and CLI version. The default log is `~/.local/state/shitrat/run-cancels.jsonl`; `--log <path>` chooses another file. The audit rules match `delete-branch`: a 0700 parent directory, a 0600 file, append-only, symlinks refused, and an audit failure stops the batch before any cancel.

The JSON envelope includes per-run results and outcome counts. A refusal or failure makes the exit code nonzero without stopping later runs. Failures name the endpoint, HTTP status and `actions: write`, without GitHub response bodies or credentials. Rate limits use the same capped Retry-After handling as `delete-branch`: one short wait through the same installation client, then `RateLimited` for the remaining runs. Tests use fake HTTP only.

## Tags and releases

`tag` and `release` authenticate as the App and read GitHub during preflight. Without `--yes`, they only preview repository writes. `--dry-run` and `--yes` are mutually exclusive. Both commands need repository access; writes need Contents: write permission. They return the JSON envelope and exit nonzero on refusal or read-back failure.

`tag` creates an annotated tag object, then a **new** `refs/tags/<name>` ref. It never updates or deletes a ref. Existing lightweight and annotated tags are refused, regardless of target or annotation. The default annotation is the tag name. The preview contains `tag_object_payload` and `ref_payload`; `<created-tag-object-sha>` in the latter denotes the first API response, not the commit SHA. The tagger timestamp is fixed when each command starts its tag operation, so a later invocation has a new timestamp. Successful creation reads back the ref, annotation, and commit target.

`release` checks that the tag exists and refuses an existing release for that tag, including drafts across all result pages. `--title` defaults to the tag name. Use either `--notes-file` or `--generate-notes`, not both. Generated notes are requested only on confirmed creation, not during preview. After creation, the command reads the release back by ID, which also works for drafts.

Keep tag changes serialized with release creation. The command rechecks the tag immediately before creating the release and refuses a disappeared or changed ref. GitHub's release endpoint has no atomic require-existing-tag option: a concurrent deletion after that final read remains a service-side race. The command sends neither a tag-creation request nor `target_commitish`.

Neither command retries or rolls back writes. If a second request or read-back fails, inspect repository state before retrying. Tag creation can leave an unreferenced annotation object, and a read-back failure can leave a real tag or release. Smoke tests must use `--dry-run`; the regression suite uses fake HTTP only.

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

- `extensions/shitrat`: pi extension that registers `shitrat_status`, `shitrat_comment`, `shitrat_reply`, `shitrat_edit_pr`, `shitrat_review`, `shitrat_merge`, `shitrat_commit_file`, and `shitrat_commit_files` tools.
- `skills/shitrat-github`: skill instructions for using ShitRat as the GitHub actor.
- `skills/shitrat-x`: X Articles draft and publish through `shitrat x`.

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
