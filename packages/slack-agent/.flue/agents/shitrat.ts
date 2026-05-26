import type { FlueContext } from "@flue/runtime";

export const triggers = { webhook: true };

type ShitRatPrototypePayload = {
  text?: string;
  message?: string;
  userId?: string;
  channelId?: string;
  threadTs?: string;
  trigger?: "dm" | "mention" | "reaction" | "manual";
};

type ShitRatEnv = {
  AI?: {
    run(model: string, input: unknown, options?: unknown): Promise<unknown>;
  };
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_AI_GATEWAY_ID?: string;
  SHITRAT_GATEWAY_MODEL?: string;
  SHITRAT_GATEWAY_THINKING?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
};

type ShitRatPrototypeResult = {
  reply: string;
  intent: "answer" | "clarify" | "escalate_local" | "ignore";
  confidence: "low" | "medium" | "high";
  needsLocalExecution: boolean;
  nextAction: string;
};

const SYSTEM_PROMPT = `You are ShitRat 🐀, Joel Hooks' Slack-native digital familiar.

Sharp, loyal, skeptical, action-oriented. Use plain language. Be concise. Push back when the premise is fucky. Do not fake tool access or local-machine work.

Prototype scope: Slack-like input -> Cloudflare Flue webhook agent -> structured result -> Slack-like reply.

If the request needs repo/filesystem access, private secrets, deploys, Slack API mutation, pi, or joelclaw, mark needsLocalExecution=true and intent=escalate_local. Otherwise answer directly or ask one crisp clarification question.

Return ONLY JSON with these exact keys:
{
  "reply": "short Slack-ready reply",
  "intent": "answer|clarify|escalate_local|ignore",
  "confidence": "low|medium|high",
  "needsLocalExecution": true/false,
  "nextAction": "short next action"
}`;

function needsLocalExecution(text: string): boolean {
  return /repo|file|deploy|secret|slack api|joelclaw|panda|run|fix|commit|push|read|grep|terminal|shell/i.test(text);
}

function fallbackResult(text: string): ShitRatPrototypeResult {
  const needsLocal = needsLocalExecution(text);
  return {
    reply: needsLocal
      ? "That needs local execution. I can route it, but I won't pretend Cloudflare can touch the machine directly. 🐀"
      : "I can handle Slack-native triage, answer small questions, decide when to escalate, and keep replies short instead of yapping like a corporate bot.",
    intent: needsLocal ? "escalate_local" : "answer",
    confidence: "medium",
    needsLocalExecution: needsLocal,
    nextAction: needsLocal ? "Escalate through the privileged local execution path." : "Wire this result into Slack thread replies.",
  };
}

function parseResult(raw: unknown, originalText: string): ShitRatPrototypeResult {
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
    const parsed = JSON.parse(match[0]) as Partial<ShitRatPrototypeResult>;
    const normalized: ShitRatPrototypeResult = {
      reply: typeof parsed.reply === "string" ? parsed.reply : fallbackResult(originalText).reply,
      intent: parsed.intent === "answer" || parsed.intent === "clarify" || parsed.intent === "escalate_local" || parsed.intent === "ignore" ? parsed.intent : fallbackResult(originalText).intent,
      confidence: parsed.confidence === "low" || parsed.confidence === "medium" || parsed.confidence === "high" ? parsed.confidence : "low",
      needsLocalExecution: typeof parsed.needsLocalExecution === "boolean" ? parsed.needsLocalExecution : fallbackResult(originalText).needsLocalExecution,
      nextAction: typeof parsed.nextAction === "string" ? parsed.nextAction : fallbackResult(originalText).nextAction,
    };

    if (mustEscalate) {
      return {
        ...normalized,
        reply: "That needs local execution. I can route it, but I won't pretend Cloudflare can touch the machine directly. 🐀",
        intent: "escalate_local",
        needsLocalExecution: true,
        nextAction: "Escalate through the privileged local execution path.",
      };
    }

    return normalized;
  } catch {
    return fallbackResult(originalText);
  }
}

function providerAuthHeader(model: string, env: ShitRatEnv): string | undefined {
  if (model.startsWith("openai/") && env.OPENAI_API_KEY) return `Bearer ${env.OPENAI_API_KEY}`;
  if (model.startsWith("anthropic/") && env.ANTHROPIC_API_KEY) return `Bearer ${env.ANTHROPIC_API_KEY}`;
  return undefined;
}

async function runGateway(prompt: string, env: ShitRatEnv): Promise<{ raw: unknown; model: string; provider: string }> {
  const model = env.SHITRAT_GATEWAY_MODEL ?? "openai/gpt-5.5";
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  const gatewayId = env.CLOUDFLARE_AI_GATEWAY_ID ?? "default";

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
    // GPT-5 chat rejects custom `temperature`, `max_tokens`, and top-level `thinking` here.
    // `reasoning_effort: "none"` is the chat-completions shape that produces 0 reasoning tokens.
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

  if (response.ok) return { raw, model, provider: "cloudflare-ai-gateway" };

  const unifiedHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  const unifiedResponse = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`, {
    method: "POST",
    headers: unifiedHeaders,
    body: JSON.stringify(body),
  });
  const unifiedText = await unifiedResponse.text();
  let unifiedRaw: unknown = unifiedText;
  try {
    unifiedRaw = JSON.parse(unifiedText);
  } catch {
    // keep raw text
  }

  if (!unifiedResponse.ok) {
    throw new Error(`Cloudflare AI Gateway ${response.status}: ${rawText}; unified ${unifiedResponse.status}: ${unifiedText}`);
  }

  return { raw: unifiedRaw, model, provider: "cloudflare-ai-gateway-unified" };
}

async function runWorkersAi(prompt: string, env: ShitRatEnv): Promise<{ raw: unknown; model: string; provider: string }> {
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

export default async function ({ payload, id, runId, log, env }: FlueContext<ShitRatPrototypePayload, ShitRatEnv>) {
  const text = payload.text ?? payload.message ?? "";
  const trigger = payload.trigger ?? "manual";

  log.info("shitrat prototype invoked", { id, runId, trigger });

  const prompt = `Context:\n- Agent instance id: ${id}\n- Run id: ${runId}\n- Trigger: ${trigger}\n- User id: ${payload.userId ?? "unknown"}\n- Channel id: ${payload.channelId ?? "unknown"}\n- Thread ts: ${payload.threadTs ?? "none"}\n\nMessage:\n${text}`;

  let gatewayError: string | undefined;
  const aiResult = needsLocalExecution(text)
    ? { raw: { response: JSON.stringify(fallbackResult(text)) }, model: "deterministic-local-escalation", provider: "prototype-guard" }
    : await runGateway(prompt, env).catch(async (error) => {
        gatewayError = error instanceof Error ? error.message : String(error);
        log.warn("gateway failed, falling back to Workers AI", { error: gatewayError });
        return await runWorkersAi(prompt, env);
      });

  return {
    ok: true,
    prototype: "flue-webhook-cloudflare-ai-gateway",
    session: id,
    model: aiResult.model,
    provider: aiResult.provider,
    gatewayError,
    raw: aiResult.raw,
    ...parseResult(aiResult.raw, text),
  };
}
