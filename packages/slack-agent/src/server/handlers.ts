import { verifyBridgeRequest } from "../executor/joelclaw-bridge";
import { verifySlackRequest } from "../slack/verify";
import type { SlackEnvelope } from "../slack/types";
import type { Env, JoelclawJobResponse } from "../types";

export type ExecutorResultPayload = JoelclawJobResponse & {
  jobId: string;
  intentId?: string;
};

export type ShitRatAgentPort = {
  handleSlackEnvelope(envelope: SlackEnvelope): Promise<{ ok: boolean; handled: boolean; reason?: string }>;
  receiveExecutorResult(result: ExecutorResultPayload): Promise<{ ok: boolean }>;
};

export type HandlerDeps = {
  getAgent(env: Env): Promise<ShitRatAgentPort>;
  nowSeconds?: () => number;
};

export async function handleSlackEvents(request: Request, env: Env, deps: HandlerDeps): Promise<Response> {
  const rawBody = await request.text();
  const verified = await verifySlackRequest({
    signingSecret: env.SLACK_SIGNING_SECRET,
    timestamp: request.headers.get("x-slack-request-timestamp"),
    signature: request.headers.get("x-slack-signature"),
    rawBody,
    nowSeconds: deps.nowSeconds?.(),
  });

  if (!verified) {
    return json({ ok: false, error: "invalid_slack_signature" }, 401);
  }

  const envelope = parseJson<SlackEnvelope>(rawBody);
  if (!envelope) {
    return json({ ok: false, error: "invalid_slack_payload" }, 400);
  }

  if (envelope.type === "url_verification") {
    return json({ challenge: envelope.challenge ?? "" });
  }

  const agent = await deps.getAgent(env);
  const result = await agent.handleSlackEnvelope(envelope);
  return json(result);
}

export async function handleExecutorResult(request: Request, env: Env, deps: HandlerDeps): Promise<Response> {
  const rawBody = await request.text();
  const verified = await verifyBridgeRequest({
    secret: env.JOELCLAW_EXECUTOR_SECRET,
    timestamp: request.headers.get("x-shitrat-timestamp"),
    signature: request.headers.get("x-shitrat-signature"),
    rawBody,
    nowSeconds: deps.nowSeconds?.(),
  });

  if (!verified) {
    return json({ ok: false, error: "invalid_executor_signature" }, 401);
  }

  const payload = parseJson<ExecutorResultPayload>(rawBody);
  if (!payload) {
    return json({ ok: false, error: "invalid_executor_payload" }, 400);
  }

  const agent = await deps.getAgent(env);
  const result = await agent.receiveExecutorResult(payload);
  return json(result);
}

export function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function parseJson<T>(rawBody: string): T | null {
  try {
    return JSON.parse(rawBody) as T;
  } catch {
    return null;
  }
}
