import { describe, expect, test, vi } from "vitest";
import { verifyBridgeRequest } from "../src/executor/joelclaw-bridge";
import { handleExecutorResult, handleSlackEvents, type ShitRatAgentPort } from "../src/server/handlers";
import { hmacSha256Hex } from "../src/slack/verify";
import type { Env } from "../src/types";

const nowSeconds = 1772990000;

function makeEnv(): Env {
  return {
    ShitRatAgent: {} as Env["ShitRatAgent"],
    SLACK_SIGNING_SECRET: "slack-secret",
    SLACK_BOT_TOKEN: "xoxb-test",
    JOELCLAW_EXECUTOR_URL: "https://executor.test/jobs",
    JOELCLAW_EXECUTOR_SECRET: "bridge-secret",
    SHITRAT_AGENT_INSTANCE: "joel",
    SHITRAT_REACTION_SUMMON: "rat",
    SHITRAT_REACTION_WATCH: "eyes",
  };
}

function makeAgent(): ShitRatAgentPort {
  return {
    handleSlackEnvelope: vi.fn(async () => ({ ok: true, handled: true })),
    receiveExecutorResult: vi.fn(async () => ({ ok: true })),
  };
}

async function signedSlackRequest(payload: unknown, overrides: HeadersInit = {}): Promise<Request> {
  const rawBody = JSON.stringify(payload);
  const signature = `v0=${await hmacSha256Hex("slack-secret", `v0:${nowSeconds}:${rawBody}`)}`;
  return new Request("https://shitrat.test/slack/events", {
    method: "POST",
    headers: {
      "x-slack-request-timestamp": String(nowSeconds),
      "x-slack-signature": signature,
      ...overrides,
    },
    body: rawBody,
  });
}

async function signedExecutorRequest(payload: unknown, overrides: HeadersInit = {}): Promise<Request> {
  const rawBody = JSON.stringify(payload);
  const signature = `v0=${await hmacSha256Hex("bridge-secret", `v0:${nowSeconds}:${rawBody}`)}`;
  return new Request("https://shitrat.test/executor/result", {
    method: "POST",
    headers: {
      "x-shitrat-timestamp": String(nowSeconds),
      "x-shitrat-signature": signature,
      ...overrides,
    },
    body: rawBody,
  });
}

describe("server handlers", () => {
  test("answers Slack url_verification without touching the agent", async () => {
    const agent = makeAgent();
    const response = await handleSlackEvents(
      await signedSlackRequest({ type: "url_verification", challenge: "prove-it" }),
      makeEnv(),
      { getAgent: async () => agent, nowSeconds: () => nowSeconds },
    );

    await expect(response.json()).resolves.toEqual({ challenge: "prove-it" });
    expect(agent.handleSlackEnvelope).not.toHaveBeenCalled();
  });

  test("rejects invalid Slack signatures", async () => {
    const response = await handleSlackEvents(
      await signedSlackRequest({ type: "event_callback" }, { "x-slack-signature": "v0=bad" }),
      makeEnv(),
      { getAgent: async () => makeAgent(), nowSeconds: () => nowSeconds },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "invalid_slack_signature" });
  });

  test("routes verified Slack events to the durable agent", async () => {
    const agent = makeAgent();
    const envelope = {
      type: "event_callback",
      team_id: "T1",
      event_id: "Ev1",
      event: {
        type: "reaction_added",
        user: "U1",
        reaction: "rat",
        item: { type: "message", channel: "C1", ts: "1772990000.000100" },
      },
    };

    const response = await handleSlackEvents(await signedSlackRequest(envelope), makeEnv(), {
      getAgent: async () => agent,
      nowSeconds: () => nowSeconds,
    });

    await expect(response.json()).resolves.toEqual({ ok: true, handled: true });
    expect(agent.handleSlackEnvelope).toHaveBeenCalledWith(envelope);
  });

  test("verifies executor callbacks before updating the agent", async () => {
    const agent = makeAgent();
    const payload = { jobId: "job_1", intentId: "intent_1", ok: true, message: "done" };
    const response = await handleExecutorResult(await signedExecutorRequest(payload), makeEnv(), {
      getAgent: async () => agent,
      nowSeconds: () => nowSeconds,
    });

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(agent.receiveExecutorResult).toHaveBeenCalledWith(payload);
  });

  test("rejects invalid executor callback signatures", async () => {
    const agent = makeAgent();
    const response = await handleExecutorResult(
      await signedExecutorRequest({ jobId: "job_1", ok: true }, { "x-shitrat-signature": "v0=bad" }),
      makeEnv(),
      { getAgent: async () => agent, nowSeconds: () => nowSeconds },
    );

    expect(response.status).toBe(401);
    expect(agent.receiveExecutorResult).not.toHaveBeenCalled();
  });
});

describe("test signing sanity", () => {
  test("executor helper signs the same base string as verifyBridgeRequest", async () => {
    const request = await signedExecutorRequest({ jobId: "job_1", ok: true });
    await expect(
      verifyBridgeRequest({
        secret: "bridge-secret",
        timestamp: request.headers.get("x-shitrat-timestamp"),
        signature: request.headers.get("x-shitrat-signature"),
        rawBody: await request.text(),
        nowSeconds,
      }),
    ).resolves.toBe(true);
  });
});
