import type { ShitRatAgent as ShitRatAgentClass } from "./agents/shitrat-agent";

export type Env = {
  ShitRatAgent: DurableObjectNamespace<ShitRatAgentClass>;
  AI?: {
    run(model: string, input: unknown, options?: unknown): Promise<unknown>;
  };
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;
  JOELCLAW_EXECUTOR_URL: string;
  JOELCLAW_EXECUTOR_SECRET: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_AI_GATEWAY_ID?: string;
  SHITRAT_GATEWAY_MODEL?: string;
  SHITRAT_GATEWAY_THINKING?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  SHITRAT_AGENT_INSTANCE: "joel";
  SHITRAT_REACTION_SUMMON: string;
  SHITRAT_REACTION_SUMMON_ALIASES?: string;
  SHITRAT_REACTION_ACK?: string;
  SHITRAT_REACTION_WATCH: string;
  ENVIRONMENT?: "staging" | "production";
};

export type ShitRatMode = "idle" | "acknowledging" | "running_flue" | "awaiting_local_execution" | "degraded";

export type ShitRatAgentState = {
  mode: ShitRatMode;
  recentEventIds: string[];
  activeJobs: Record<string, ShitRatJobState>;
  lastSlackEventAt?: string;
  lastError?: string;
};

export type ShitRatJobState = {
  jobId: string;
  intentId: string;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  slackChannelId: string;
  slackMessageTs: string;
  slackThreadTs?: string;
  summary?: string;
  error?: string;
};

export type ShitRatIntentKind = "summon" | "watch" | "mention" | "dm";

export type ShitRatIntent = {
  id: string;
  kind: ShitRatIntentKind;
  teamId?: string;
  channelId: string;
  messageTs: string;
  threadTs?: string;
  actorUserId?: string;
  text?: string;
  trigger: "reaction" | "mention" | "dm";
  rawEventId?: string;
  createdAt: string;
};

export type JoelclawJobRequest = {
  intent: ShitRatIntent;
  requestedBy: "cloudflare-shitrat-agent";
  requestedAt: string;
};

export type JoelclawJobResponse = {
  ok: boolean;
  jobId?: string;
  status?: "queued" | "running" | "completed" | "failed";
  message?: string;
  error?: string;
};
