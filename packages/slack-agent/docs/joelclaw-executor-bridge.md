# Joelclaw Executor Bridge

Cloudflare owns Slack ingress. Panda owns privileged execution.

## Request

Cloudflare sends a signed JSON request to `JOELCLAW_EXECUTOR_URL`:

```json
{
  "intent": {
    "id": "T1:C1:1772990000.000100:Ev1",
    "kind": "summon",
    "channelId": "C1",
    "messageTs": "1772990000.000100",
    "threadTs": "1772990000.000100",
    "trigger": "reaction"
  },
  "requestedBy": "cloudflare-shitrat-agent",
  "requestedAt": "2026-05-20T00:00:00.000Z"
}
```

Headers:

```text
x-shitrat-timestamp: <unix seconds>
x-shitrat-signature: v0=<hmac_sha256(secret, `v0:${timestamp}:${body}`)>
```

## Response

```json
{
  "ok": true,
  "jobId": "job_123",
  "status": "queued",
  "message": "🐀 ShitRat is on it."
}
```

## Rules

- Reject stale timestamps.
- Verify HMAC before parsing work as trusted.
- Accept only known intent kinds.
- Map work to bounded joelclaw workload/pi actions.
- Report terminal result back to `/executor/result` with the same HMAC header contract.
