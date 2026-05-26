import { afterEach, describe, expect, test, vi } from "vitest";
import { parseShitRatFlueResult, runShitRatFlueSession } from "../src/flue/shitrat-session";
import type { Env, ShitRatIntent } from "../src/types";

function makeIntent(text: string): ShitRatIntent {
  return {
    id: "T1:C1:1.000:Ev1",
    kind: "dm",
    teamId: "T1",
    channelId: "C1",
    messageTs: "1.000",
    threadTs: "1.000",
    actorUserId: "UJOEL",
    text,
    trigger: "dm",
    rawEventId: "Ev1",
    createdAt: "2026-05-20T00:00:00.000Z",
  };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ShitRatAgent: {} as Env["ShitRatAgent"],
    SLACK_SIGNING_SECRET: "slack-secret",
    SLACK_BOT_TOKEN: "xoxb-test",
    JOELCLAW_EXECUTOR_URL: "https://executor.test/jobs",
    JOELCLAW_EXECUTOR_SECRET: "bridge-secret",
    CLOUDFLARE_ACCOUNT_ID: "cf-account",
    CLOUDFLARE_API_TOKEN: "cf-token",
    CLOUDFLARE_AI_GATEWAY_ID: "wizard-shit",
    SHITRAT_GATEWAY_MODEL: "openai/gpt-5.5",
    SHITRAT_GATEWAY_THINKING: "off",
    SHITRAT_AGENT_INSTANCE: "joel",
    SHITRAT_REACTION_SUMMON: "rat",
    SHITRAT_REACTION_WATCH: "eyes",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runShitRatFlueSession", () => {
  test("calls Cloudflare AI Gateway compat with the verified GPT-5.5 chat params", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(String(_url)).toBe("https://gateway.ai.cloudflare.com/v1/cf-account/wizard-shit/compat/chat/completions");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        "Content-Type": "application/json",
        "cf-aig-authorization": "Bearer cf-token",
      });
      expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();

      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe("openai/gpt-5.5");
      expect(body.max_completion_tokens).toBe(500);
      expect(body.reasoning_effort).toBe("none");
      expect(body.verbosity).toBe("low");
      expect(body.temperature).toBeUndefined();
      expect(body.max_tokens).toBeUndefined();
      expect(body.thinking).toBeUndefined();

      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          reply: "Slack-native answer.",
          intent: "answer",
          confidence: "high",
          needsLocalExecution: false,
          nextAction: "Reply in Slack thread.",
        }) } }],
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(runShitRatFlueSession(makeIntent("what can you do from Slack?"), makeEnv())).resolves.toMatchObject({
      provider: "cloudflare-ai-gateway",
      model: "openai/gpt-5.5",
      reply: "Slack-native answer.",
      needsLocalExecution: false,
    });
  });

  test("does not call Gateway for privileged local work; it flags escalation", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(runShitRatFlueSession(makeIntent("read this repo and push a fix"), makeEnv())).resolves.toMatchObject({
      provider: "cloudflare-escalation-guard",
      model: "deterministic-local-escalation",
      intent: "escalate_local",
      needsLocalExecution: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("parseShitRatFlueResult", () => {
  test("overrides model output that tries to perform local work", () => {
    expect(parseShitRatFlueResult({
      choices: [{ message: { content: JSON.stringify({
        reply: "Done, pushed it.",
        intent: "answer",
        confidence: "high",
        needsLocalExecution: false,
        nextAction: "None.",
      }) } }],
    }, "push the repo fix")).toMatchObject({
      intent: "escalate_local",
      needsLocalExecution: true,
      nextAction: "Flag for privileged local execution.",
    });
  });
});
