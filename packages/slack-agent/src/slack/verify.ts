const FIVE_MINUTES_SECONDS = 60 * 5;

export type VerifySlackRequestInput = {
  signingSecret: string;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  nowSeconds?: number;
};

export async function verifySlackRequest(input: VerifySlackRequestInput): Promise<boolean> {
  const timestamp = Number.parseInt(input.timestamp ?? "", 10);
  if (!Number.isFinite(timestamp)) return false;

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > FIVE_MINUTES_SECONDS) return false;

  const signature = input.signature ?? "";
  if (!signature.startsWith("v0=")) return false;

  const baseString = `v0:${timestamp}:${input.rawBody}`;
  const expected = `v0=${await hmacSha256Hex(input.signingSecret, baseString)}`;
  return timingSafeEqual(expected, signature);
}

export async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;

  for (let index = 0; index < length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }

  return diff === 0;
}
