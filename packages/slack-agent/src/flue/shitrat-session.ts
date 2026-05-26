import type { Env, ShitRatIntent } from "../types";

export type ShitRatFlueResult = {
  ok: true;
  session: string;
  model: string;
  provider: string;
  gatewayError?: string;
  raw: unknown;
  reply: string;
  intent: "answer" | "clarify" | "escalate_local" | "ignore";
  confidence: "low" | "medium" | "high";
  needsLocalExecution: boolean;
  nextAction: string;
};

type GatewayEnv = Pick<
  Env,
  | "AI"
  | "CLOUDFLARE_ACCOUNT_ID"
  | "CLOUDFLARE_API_TOKEN"
  | "CLOUDFLARE_AI_GATEWAY_ID"
  | "SHITRAT_GATEWAY_MODEL"
  | "SHITRAT_GATEWAY_THINKING"
  | "OPENAI_API_KEY"
  | "ANTHROPIC_API_KEY"
>;

const SYSTEM_PROMPT = `You are ShitRat 🐀, Joel Hooks' Slack-native digital familiar.

Sharp, loyal, skeptical, action-oriented. Use plain language. Be concise. Push back when the premise is fucky. Do not fake tool access or local-machine work.

Scope: Slack intent -> Cloudflare-hosted ShitRat session -> structured result -> Slack thread reply.

Cloudflare can handle Slack-native replies, lightweight reasoning, summaries from provided text, and escalation decisions.
If the request needs repo/filesystem access, private secrets, deploys, Slack API mutation beyond the current reply, pi, panda, shell commands, commits, pushes, or joelclaw, mark needsLocalExecution=true and intent=escalate_local. Do not pretend the work was done.

Return ONLY JSON with these exact keys:
{
  "reply": "short Slack-ready reply",
  "intent": "answer|clarify|escalate_local|ignore",
  "confidence": "low|medium|high",
  "needsLocalExecution": true/false,
  "nextAction": "short next action"
}`;

export function needsLocalExecution(text: string): boolean {
  return /repo|file|deploy|secret|slack api|joelclaw|panda|run|fix|commit|push|read|grep|terminal|shell/i.test(text);
}

function fallbackResult(text: string): Omit<ShitRatFlueResult, "ok" | "session" | "model" | "provider" | "raw" | "gatewayError"> {
  const needsLocal = needsLocalExecution(text);
  return {
    reply: needsLocal
      ? "That needs local execution. I can flag it for joelclaw later, but I won't pretend Cloudflare can touch the machine directly. 🐀"
      : "I can handle Slack-native triage, answer small questions, decide when to escalate, and keep replies short instead of yapping like a corporate bot.",
    intent: needsLocal ? "escalate_local" : "answer",
    confidence: "medium",
    needsLocalExecution: needsLocal,
    nextAction: needsLocal ? "Flag for privileged local execution." : "Reply in Slack thread.",
  };
}

export function parseShitRatFlueResult(raw: unknown, originalText: string): Pick<ShitRatFlueResult, "reply" | "intent" | "confidence" | "needsLocalExecution" | "nextAction"> {
  const mustEscalate = needsLocalExecution(originalText);
  const text =
    typeof raw === "string"
      ? raw
      : raw && typeof raw === "object" && "response" in raw && typeof (raw as { response?: unknown }).response === "string"
        ? (raw as { response: string }).response
        : raw && typeof raw === "object" && "choices" in raw
          ? ((raw as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? JSON.stringify(raw))
          : JSON.stringify(raw);

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return fallbackResult(originalText);

  try {
    const parsed = JSON.parse(match[0]) as Partial<ShitRatFlueResult>;
    const fallback = fallbackResult(originalText);
    const normalized = {
      reply: typeof parsed.reply === "string" ? parsed.reply : fallback.reply,
      intent: parsed.intent === "answer" || parsed.intent === "clarify" || parsed.intent === "escalate_local" || parsed.intent === "ignore" ? parsed.intent : fallback.intent,
      confidence: parsed.confidence === "low" || parsed.confidence === "medium" || parsed.confidence === "high" ? parsed.confidence : "low",
      needsLocalExecution: typeof parsed.needsLocalExecution === "boolean" ? parsed.needsLocalExecution : fallback.needsLocalExecution,
      nextAction: typeof parsed.nextAction === "string" ? parsed.nextAction : fallback.nextAction,
    } satisfies Pick<ShitRatFlueResult, "reply" | "intent" | "confidence" | "needsLocalExecution" | "nextAction">;

    if (!mustEscalate) return normalized;

    return {
      ...normalized,
      reply: "That needs local execution. I can flag it for joelclaw later, but I won't pretend Cloudflare can touch the machine directly. 🐀",
      intent: "escalate_local",
      needsLocalExecution: true,
      nextAction: "Flag for privileged local execution.",
    };
  } catch {
    return fallbackResult(originalText);
  }
}

function providerAuthHeader(model: string, env: GatewayEnv): string | undefined {
  if (model.startsWith("openai/") && env.OPENAI_API_KEY) return `Bearer ${env.OPENAI_API_KEY}`;
  if (model.startsWith("anthropic/") && env.ANTHROPIC_API_KEY) return `Bearer ${env.ANTHROPIC_API_KEY}`;
  return undefined;
}

async function runGateway(prompt: string, env: GatewayEnv): Promise<{ raw: unknown; model: string; provider: string }> {
  const model = env.SHITRAT_GATEWAY_MODEL ?? "openai/gpt-5.5";
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  const gatewayId = env.CLOUDFLARE_AI_GATEWAY_ID ?? "wizard-shit";

  if (!accountId || !token) throw new Error("missing Cloudflare AI Gateway env");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "cf-aig-authorization": `Bearer ${token}`,
  };

  const upstreamAuth = providerAuthHeader(model, env);
  if (upstreamAuth) headers.Authorization = upstreamAuth;

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
  };

  if (model.startsWith("openai/gpt-5")) {
    body.max_completion_tokens = 500;
    body.verbosity = "low";
    body.reasoning_effort = env.SHITRAT_GATEWAY_THINKING === "off" ? "none" : (env.SHITRAT_GATEWAY_THINKING ?? "none");
  } else {
    body.temperature = 0.2;
    body.max_tokens = 500;
  }

  const response = await fetch(`https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/compat/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const rawText = await response.text();
  let raw: unknown = rawText;
  try {
    raw = JSON.parse(rawText);
  } catch {
    // keep raw text
  }

  if (!response.ok) throw new Error(`Cloudflare AI Gateway ${response.status}: ${rawText}`);
  return { raw, model, provider: "cloudflare-ai-gateway" };
}

async function runWorkersAi(prompt: string, env: GatewayEnv): Promise<{ raw: unknown; model: string; provider: string }> {
  if (!env.AI) throw new Error("missing Workers AI binding");
  const model = "@cf/meta/llama-3.1-8b-instruct";
  const raw = await env.AI.run(model, {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    max_tokens: 500,
  });
  return { raw, model, provider: "workers-ai-binding" };
}

export async function runShitRatFlueSession(intent: ShitRatIntent, env: GatewayEnv): Promise<ShitRatFlueResult> {
  const text = intent.text ?? "";
  const prompt = `Context:\n- Agent instance id: ${intent.id}\n- Trigger: ${intent.trigger}\n- User id: ${intent.actorUserId ?? "unknown"}\n- Channel id: ${intent.channelId}\n- Thread ts: ${intent.threadTs ?? "none"}\n\nMessage:\n${text}`;

  let gatewayError: string | undefined;
  const aiResult = needsLocalExecution(text)
    ? { raw: { response: JSON.stringify(fallbackResult(text)) }, model: "deterministic-local-escalation", provider: "cloudflare-escalation-guard" }
    : await runGateway(prompt, env).catch(async (error) => {
        gatewayError = error instanceof Error ? error.message : String(error);
        return await runWorkersAi(prompt, env);
      });

  return {
    ok: true,
    session: intent.id,
    model: aiResult.model,
    provider: aiResult.provider,
    gatewayError,
    raw: aiResult.raw,
    ...parseShitRatFlueResult(aiResult.raw, text),
  };
}
