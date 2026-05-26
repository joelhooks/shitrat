import type { Env, JoelclawJobRequest, JoelclawJobResponse, ShitRatIntent } from "../types";
import { hmacSha256Hex, timingSafeEqual } from "../slack/verify";

const FIVE_MINUTES_SECONDS = 60 * 5;

export async function dispatchToJoelclaw(env: Env, intent: ShitRatIntent): Promise<JoelclawJobResponse> {
  const request: JoelclawJobRequest = {
    intent,
    requestedBy: "cloudflare-shitrat-agent",
    requestedAt: new Date().toISOString(),
  };
  const body = JSON.stringify(request);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await signBridgeRequest(env.JOELCLAW_EXECUTOR_SECRET, timestamp, body);

  const response = await fetch(env.JOELCLAW_EXECUTOR_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shitrat-timestamp": timestamp,
      "x-shitrat-signature": signature,
    },
    body,
  });

  const payload = await safeJson<JoelclawJobResponse>(response);
  if (!response.ok) {
    return {
      ok: false,
      status: "failed",
      error: payload?.error ?? `joelclaw bridge HTTP ${response.status}`,
    };
  }

  return payload ?? { ok: true, status: "queued" };
}

export async function verifyBridgeRequest(input: {
  secret: string;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  nowSeconds?: number;
}): Promise<boolean> {
  const timestamp = Number.parseInt(input.timestamp ?? "", 10);
  if (!Number.isFinite(timestamp)) return false;

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > FIVE_MINUTES_SECONDS) return false;

  const signature = input.signature ?? "";
  if (!signature.startsWith("v0=")) return false;

  const expected = await signBridgeRequest(input.secret, String(timestamp), input.rawBody);
  return timingSafeEqual(expected, signature);
}

async function signBridgeRequest(secret: string, timestamp: string, body: string): Promise<string> {
  return `v0=${await hmacSha256Hex(secret, `v0:${timestamp}:${body}`)}`;
}

async function safeJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}
