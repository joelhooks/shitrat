# Slack App Setup

## V1 event subscriptions

Start narrow:

- `reaction_added`
- `app_mention`
- `message.im`

Use `:shitrat:` as the primary summon reaction. Keep `:rat:` as a backwards-compatible alias.

Request URL:

```text
https://<worker-host>/slack/events
```

## Bot scopes

Minimum bot-mouth scopes for V1:

- `app_mentions:read`
- `chat:write`
- `reactions:read`
- `reactions:write`
- `im:history`

If ShitRat should post with its own per-message name/icon while reusing the Joelclaw Slack app, add/verify `chat:write.customize` and pass `username`, `icon_emoji`, or `icon_url` through `chat.postMessage` only after a clear Joel action.

Custom `username`/`icon_url` does not create a real mentionable Slack identity. `@ShitRat` only works after installing a real ShitRat app/bot user; until then, mentions target the underlying Joelclaw app identity and `:shitrat:` is the reliable summon.

Add only what the vertical slice proves it needs.

## Existing Joelclaw app reuse

Use the existing Joelclaw Slack app tokens before creating a new bot/app:

- `slack_bot_token` in `agent-secrets` -> `SLACK_BOT_TOKEN`
- `slack_user_token` in `agent-secrets` -> future explicit user-token observation paths

`slack_app_token` is only needed if this moves to Socket Mode. The current HTTP Events API route does not need it.

Keep `SLACK_SIGNING_SECRET` separate for request verification.

## User-token ears

Full Joel-level omnipresence is a user-token scope problem, not a bot trick.

Likely future user scopes:

- `channels:history`, `groups:history`, `im:history`, `mpim:history`
- `channels:read`, `groups:read`, `im:read`, `mpim:read`

Keep user-token observation explicit and reversible.

## Handler contract

Slack event handlers must:

1. verify Slack signature from raw body
2. return quickly
3. normalize only known ShitRat intents
4. enqueue durable work
5. never run local pi work inline
