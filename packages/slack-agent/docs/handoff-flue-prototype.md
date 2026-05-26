# Handoff: Flue + Cloudflare AI Gateway Prototype

## Current state

This repo has a working Flue webhook prototype for ShitRat:

```text
POST /agents/shitrat/<session-id>
  -> .flue/agents/shitrat.ts
  -> Cloudflare AI Gateway compat
  -> openai/gpt-5.5
  -> structured ShitRat result
```

Run it:

```bash
pnpm flue:dev
```

Test it:

```bash
curl -sS -X POST http://localhost:3583/agents/shitrat/test-1 \
  -H 'Content-Type: application/json' \
  -d '{"message":"what can you do from Slack?","trigger":"dm","userId":"UJOEL"}' \
  | python3 -m json.tool
```

`GET /` intentionally returns `route_not_found`; Flue webhook agents are POST-only at `/agents/<name>/<id>`.

## Important files

- `.flue/agents/shitrat.ts` — webhook agent and Gateway call.
- `.flue/roles/shitrat.md` — ShitRat vibe/system role.
- `.flue/wrangler.jsonc` — isolated Flue Worker config with AI binding.
- `flue.config.ts` — isolates Flue source root/output from the main Slack Worker.
- `.dev.vars.example` — env shape.
- `docs/flue-spike.md` — durable receipt and parameter lore.
- `../../.brain/projects/shitrat-cloudflare-slack-agent.svx` — canonical monorepo Brain project state.

## Env

`.dev.vars` is ignored and should contain:

```env
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_AI_GATEWAY_ID=wizard-shit
SHITRAT_GATEWAY_MODEL=openai/gpt-5.5
SHITRAT_GATEWAY_THINKING=off
```

`package.json` scripts source `.dev.vars` into shell env before running Flue because Wrangler remote bindings need the Cloudflare vars in process env, not only Worker env.

## Gateway/BYOK lore

Gateway endpoint:

```text
https://gateway.ai.cloudflare.com/v1/<account_id>/wizard-shit/compat/chat/completions
```

BYOK auth:

```text
cf-aig-authorization: Bearer <Cloudflare token>
```

Do **not** send `Authorization: Bearer <Cloudflare token>` to `/compat`; OpenAI treats `Authorization` as an OpenAI provider key.

## GPT-5.5 chat params

Working signature:

```json
{
  "model": "openai/gpt-5.5",
  "messages": [],
  "max_completion_tokens": 500,
  "reasoning_effort": "none",
  "verbosity": "low"
}
```

Do not send:

- `thinking`
- `temperature`
- `max_tokens`

Verified result via local Flue endpoint:

- `provider: "cloudflare-ai-gateway"`
- `model: "openai/gpt-5.5"`
- upstream model `gpt-5.5-2026-04-23`
- `reasoning_tokens: 0`

## Next best step

Wire the existing Slack DM/mention/reaction normalization to call the Flue-backed ShitRat path instead of the current joelclaw-first scaffold. Keep joelclaw as future privileged local escalation only.

## Handoff prompt

Continue in `/Users/joel/Code/joelhooks/shitrat-cli/packages/slack-agent`.

Read first:

- `AGENTS.md`
- `../../BRAIN.md`
- `../../.brain/projects/shitrat-cloudflare-slack-agent.svx`
- `docs/flue-spike.md`
- `docs/handoff-flue-prototype.md`
- `.flue/agents/shitrat.ts`
- `src/agents/shitrat-agent.ts`
- `src/slack/normalize.ts`
- `src/server/handlers.ts`

Goal: integrate the working Flue/Gateway prototype into the main Cloudflare Slack agent flow. Preserve the boundary: Cloudflare/Flue handles Slack-native replies; privileged local work is only flagged/escalated for later joelclaw. Do not resurrect joelclaw as the spine.

Known working dev command:

```bash
pnpm flue:dev
```

Known working test request:

```bash
curl -sS -X POST http://localhost:3583/agents/shitrat/test-1 \
  -H 'Content-Type: application/json' \
  -d '{"message":"what can you do from Slack?","trigger":"dm","userId":"UJOEL"}' \
  | python3 -m json.tool
```

Before editing, check `git status --short` from the monorepo root. After editing, run the narrow checks: `pnpm --filter @joelhooks/shitrat-slack-agent check`, relevant tests, `pnpm --filter @joelhooks/shitrat-slack-agent flue:build`, and `pi-notes brain check .` if Brain changes.
