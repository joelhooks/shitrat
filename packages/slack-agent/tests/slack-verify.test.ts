import { describe, expect, test } from "vitest";
import { hmacSha256Hex, verifySlackRequest } from "../src/slack/verify";

describe("verifySlackRequest", () => {
  test("accepts a valid Slack signature", async () => {
    const signingSecret = "shh";
    const timestamp = "1772990000";
    const rawBody = JSON.stringify({ type: "event_callback" });
    const signature = `v0=${await hmacSha256Hex(signingSecret, `v0:${timestamp}:${rawBody}`)}`;

    await expect(
      verifySlackRequest({
        signingSecret,
        timestamp,
        rawBody,
        signature,
        nowSeconds: 1772990000,
      }),
    ).resolves.toBe(true);
  });

  test("rejects stale timestamps", async () => {
    await expect(
      verifySlackRequest({
        signingSecret: "shh",
        timestamp: "1000",
        rawBody: "{}",
        signature: "v0=bad",
        nowSeconds: 2000,
      }),
    ).resolves.toBe(false);
  });
});
