---
name: shitrat-x
description: Draft and publish X.com Articles and inspect X OAuth2 user identity through the ShitRat CLI. Use when posting an X Article, converting HTML or markdown to X DraftJS content_state, uploading an article cover, publishing a draft, or when an agent reaches for /tmp X API scripts, md2x, or raw POST /2/articles/draft.
---

# ShitRat X

X Articles go through `shitrat x`, not throwaway scripts.

JSON only. Never print tokens. Live article writes need `--yes` after a `--dry-run`.

## Commands

```bash
shitrat x me --account joelhooks
shitrat x article convert --title "The past blocked the future" --html-file ./post.html
shitrat x article draft --title "The past blocked the future" --html-file ./post.html --cover ./banner.png --dry-run
shitrat x article draft --title "The past blocked the future" --html-file ./post.html --cover ./banner.png --yes
shitrat x article publish <article-id> --dry-run
shitrat x article publish <article-id> --yes
```

`--md-file` is accepted instead of `--html-file`. Cover is optional. Account defaults to `joelhooks`.

## Auth

Articles need OAuth 2.0 user context with `tweet.write` and `media.write`. OAuth 1.0a can upload media and still 403 article create with a fake Premium error.

Secret names are `x_<account>_oauth2_access_token`, `_refresh_token`, `_client_id`, and `_client_secret`. Lease them. Do not print them.

Access tokens expire in two hours. Refresh with the confidential-client token endpoint before a live write if `x me` returns 401.

## Caps

X gives 10 article creates per 24 hours per user. Failed creates count. 503 and probe retries burn the cap. There is no official update or list endpoint. Do not retry a 429. The envelope includes `limits.userRemaining` and `limits.userResetAt` when X sends those headers.

Large DraftJS bodies have 503'd. Dry-run first and inspect `stats.blocks`. Prefer a paste pack or a thinner body over hammering create.

Publish is a separate call and still needs `--yes`.

## Output

A successful dry-run draft returns title, stats, `x_write: false`, and a composer hint. A live draft returns `article_id`, `edit_url`, cover upload flag, and limit headers. A live publish returns `post_id` and status URL when present.
