import { afterEach, describe, expect, test, vi } from "vitest";
import { dispatchToJoelclaw, verifyBridgeRequest } from "../src/executor/joelclaw-bridge";
import { hmacSha256Hex } from "../src/slack/verify";
import type { Env, ShitRatIntent } from "../src/types";

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

function makeIntent(): ShitRatIntent {
  return {
    id: "T1:C1:1772990000.000100:Ev1",
    kind: "summon",
    teamId: "T1",
    channelId: "C1",
    messageTs: "1772990000.000100",
    threadTs: "1772990000.000100",
    actorUserId: "U1",
    trigger: "reaction",
    rawEventId: "Ev1",
    createdAt: "2026-05-20T00:00:00.000Z",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("verifyBridgeRequest", () => {
  test("accepts a signed joelclaw callback", async () => {
    const secret = "bridge-secret";
    const timestamp = "1772990000";
    const rawBody = JSON.stringify({ jobId: "job_1", ok: true });
    const signature = `v0=${await hmacSha256Hex(secret, `v0:${timestamp}:${rawBody}`)}`;

    await expect(
      verifyBridgeRequest({
        secret,
        timestamp,
        signature,
        rawBody,
        nowSeconds: 1772990000,
      }),
    ).resolves.toBe(true);
  });

  test("rejects an invalid callback signature", async () => {
    await expect(
      verifyBridgeRequest({
        secret: "bridge-secret",
        timestamp: "1772990000",
        signature: "v0=bad",
        rawBody: JSON.stringify({ jobId: "job_1", ok: true }),
        nowSeconds: 1772990000,
      }),
    ).resolves.toBe(false);
  });
});

describe("dispatchToJoelclaw", () => {
  test("posts a signed bounded intent job", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1772990000 * 1000));

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      const signature = String((init?.headers as Record<string, string>)["x-shitrat-signature"]);
      const timestamp = String((init?.headers as Record<string, string>)["x-shitrat-timestamp"]);

      await expect(
        verifyBridgeRequest({
          secret: "bridge-secret",
          timestamp,
          signature,
          rawBody: body,
          nowSeconds: 1772990000,
        }),
      ).resolves.toBe(true);

      expect(JSON.parse(body)).toMatchObject({
        requestedBy: "cloudflare-shitrat-agent",
        intent: {
          id: "T1:C1:1772990000.000100:Ev1",
          kind: "summon",
          trigger: "reaction",
        },
      });

      return new Response(JSON.stringify({ ok: true, jobId: "job_1", status: "queued" }), {
        headers: { "content-type": "application/json" },
      });
    });

    vi.stubGlobal("fetch", fetchMock);

    await expect(dispatchToJoelclaw(makeEnv(), makeIntent())).resolves.toEqual({
      ok: true,
      jobId: "job_1",
      status: "queued",
    });

    expect(fetchMock).toHaveBeenCalledWith("https://executor.test/jobs", expect.objectContaining({ method: "POST" }));
  });
});
