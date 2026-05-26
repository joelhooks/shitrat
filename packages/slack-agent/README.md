# ShitRat Slack Agent

Joel-only Slack familiar running on Cloudflare Agents.

ShitRat is not a generic assistant and not a multi-tenant Slack SaaS bot. It is Joel's Slack-native familiar: reads broadly, speaks deliberately, and runs primarily inside Cloudflare Agents SDK with Flue as the agent harness/session layer. joelclaw is a later target for privileged local execution, not the first architecture constraint.

## Architecture

```text
Slack Events API
  -> Cloudflare Worker `/slack/events`
  -> ShitRatAgent Durable Object instance `joel`
  -> intent normalization + dedupe + state
  -> Flue agent session
  -> Slack thread status/result
  -> optional signed joelclaw executor bridge for privileged local work later
```

## V1 triggers

- `:rat:` / `:shitrat:` reaction: summon ShitRat for the message/thread.
- `:eyes:` reaction: watch/summarize/remember.
- DM to ShitRat: direct conversation.
- `@shitrat`: direct summon only after Slack has a real ShitRat app/bot identity.

Ambient Slack messages are context, not permission to yap.

## Mention identity caveat

Custom `chat.postMessage` `username`/`icon_url` makes replies look like ShitRat, but it does not create a mentionable `@ShitRat` identity. If `@messages` need to work, Slack needs a real ShitRat bot/app install or an explicit non-mention trigger like `:shitrat:`.

## Setup

From the monorepo root:

```bash
pnpm install
pnpm --filter @joelhooks/shitrat-slack-agent types
pnpm --filter @joelhooks/shitrat-slack-agent test
pnpm --filter @joelhooks/shitrat-slack-agent dev
```

Create `.dev.vars` from `.dev.vars.example` and lease/store secrets outside git.

Required secrets:

- `SLACK_SIGNING_SECRET`
- `SLACK_BOT_TOKEN`
- `JOELCLAW_EXECUTOR_URL`
- `JOELCLAW_EXECUTOR_SECRET`

## Slack app routes

Configure Slack Event Subscriptions to POST to:

```text
https://<worker-host>/slack/events
```

Subscribe to the narrow V1 events first:

- `reaction_added`
- `app_mention`
- `message.im`

## Notes

Durable project memory lives in the monorepo root `.brain/`. Start there before inventing new scope.
