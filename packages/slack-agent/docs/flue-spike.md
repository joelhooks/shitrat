# Flue Spike

Flue is a first-class candidate for the ShitRat agent harness/session layer inside Cloudflare Agents SDK. This is the near-term buildout focus; joelclaw is a later privileged-local execution target.

## Why it is interesting

- headless agent harness
- sessions, skills, roles, tasks
- Node and Cloudflare targets
- virtual sandbox by default
- can use real remote sandboxes when needed

## Spike question

Can Flue run a ShitRat Cloudflare-hosted agent session that receives a normalized Slack intent and returns a structured result or action plan, while preserving skills/context and keeping secrets out of prompt history?

## First slice

The first useful Flue slice should stay boring:

```text
normalized Slack intent
  -> Cloudflare `ShitRatAgent:joel`
  -> Flue session with ShitRat role/context
  -> typed result
  -> Slack threaded reply/status
```

Do not require joelclaw for this slice. Keep a future executor seam for intents that need privileged local machine access.

## Prototype receipt

Current prototype files:

- `.flue/agents/shitrat.ts`
- `.flue/roles/shitrat.md`
- `.flue/wrangler.jsonc`
- `flue.config.ts`

Run locally:

```bash
pnpm flue:dev
curl -sS -X POST http://localhost:3583/agents/shitrat/test-1 \
  -H 'Content-Type: application/json' \
  -d '{"message":"what can you do from Slack?","trigger":"dm","userId":"UJOEL"}' \
  | python3 -m json.tool
```

Important route fact: `GET /` returns `route_not_found`; Flue webhook agents are served at `POST /agents/<name>/<id>`.

Model path:

- Cloudflare AI Gateway compat endpoint.
- Account id from `CLOUDFLARE_ACCOUNT_ID`.
- Gateway id `wizard-shit` via `CLOUDFLARE_AI_GATEWAY_ID`.
- Model `openai/gpt-5.5` via `SHITRAT_GATEWAY_MODEL`.
- BYOK means use `cf-aig-authorization: Bearer <Cloudflare token>` and do not send `Authorization: Bearer <Cloudflare token>` to Gateway compat.

GPT-5.5 chat parameter signature that works:

```json
{
  "model": "openai/gpt-5.5",
  "messages": [],
  "max_completion_tokens": 500,
  "reasoning_effort": "none",
  "verbosity": "low"
}
```

Do not send `temperature`, `max_tokens`, or top-level `thinking` for GPT-5.5 chat completions through Gateway compat. `SHITRAT_GATEWAY_THINKING=off` maps to `reasoning_effort: "none"` in code. Verified upstream usage reported `reasoning_tokens: 0`.
