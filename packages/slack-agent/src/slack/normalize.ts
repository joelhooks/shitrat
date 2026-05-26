import type { Env, ShitRatIntent } from "../types";
import type {
  SlackAppMentionEvent,
  SlackEnvelope,
  SlackMessageEvent,
  SlackReactionAddedEvent,
} from "./types";
import { isRecord } from "./types";

export function normalizeSlackIntent(
  envelope: SlackEnvelope,
  env: Pick<Env, "SHITRAT_REACTION_SUMMON" | "SHITRAT_REACTION_SUMMON_ALIASES" | "SHITRAT_REACTION_WATCH">,
): ShitRatIntent | null {
  if (envelope.type !== "event_callback" || !envelope.event || !isRecord(envelope.event)) {
    return null;
  }

  const eventType = typeof envelope.event.type === "string" ? envelope.event.type : "";
  if (eventType === "reaction_added") {
    return normalizeReaction(envelope, envelope.event as SlackReactionAddedEvent, env);
  }
  if (eventType === "app_mention") {
    return normalizeMention(envelope, envelope.event as SlackAppMentionEvent);
  }
  if (eventType === "message") {
    return normalizeDm(envelope, envelope.event as SlackMessageEvent);
  }

  return null;
}

function normalizeReaction(
  envelope: SlackEnvelope,
  event: SlackReactionAddedEvent,
  env: Pick<Env, "SHITRAT_REACTION_SUMMON" | "SHITRAT_REACTION_SUMMON_ALIASES" | "SHITRAT_REACTION_WATCH">,
): ShitRatIntent | null {
  const summonReactions = reactionSet(env.SHITRAT_REACTION_SUMMON ?? "rat", env.SHITRAT_REACTION_SUMMON_ALIASES, ["shitrat"]);
  const watchReaction = env.SHITRAT_REACTION_WATCH ?? "eyes";
  const reaction = event.reaction?.trim();
  if (!reaction || (!summonReactions.has(reaction) && reaction !== watchReaction)) return null;
  if (event.item?.type !== "message") return null;
  if (!event.item.channel || !event.item.ts) return null;

  const kind = summonReactions.has(reaction) ? "summon" : "watch";
  return {
    id: buildIntentId(envelope, event.item.channel, event.item.ts, kind),
    kind,
    teamId: envelope.team_id,
    channelId: event.item.channel,
    messageTs: event.item.ts,
    threadTs: event.item.ts,
    actorUserId: event.user,
    trigger: "reaction",
    rawEventId: envelope.event_id,
    createdAt: new Date().toISOString(),
  };
}

function normalizeMention(envelope: SlackEnvelope, event: SlackAppMentionEvent): ShitRatIntent | null {
  if (!event.channel || !event.ts) return null;
  return {
    id: buildIntentId(envelope, event.channel, event.ts, "mention"),
    kind: "mention",
    teamId: envelope.team_id,
    channelId: event.channel,
    messageTs: event.ts,
    threadTs: event.thread_ts ?? event.ts,
    actorUserId: event.user,
    text: event.text,
    trigger: "mention",
    rawEventId: envelope.event_id,
    createdAt: new Date().toISOString(),
  };
}

function normalizeDm(envelope: SlackEnvelope, event: SlackMessageEvent): ShitRatIntent | null {
  if (event.subtype || event.bot_id) return null;
  if (event.channel_type !== "im") return null;
  if (!event.channel || !event.ts) return null;
  return {
    id: buildIntentId(envelope, event.channel, event.ts, "dm"),
    kind: "dm",
    teamId: envelope.team_id,
    channelId: event.channel,
    messageTs: event.ts,
    threadTs: event.thread_ts ?? event.ts,
    actorUserId: event.user,
    text: event.text,
    trigger: "dm",
    rawEventId: envelope.event_id,
    createdAt: new Date().toISOString(),
  };
}

function buildIntentId(envelope: SlackEnvelope, channelId: string, ts: string, kind: string): string {
  return [envelope.team_id ?? "team", channelId, ts, envelope.event_id ?? kind].join(":");
}

function reactionSet(primary: string, aliases: string | undefined, defaults: string[]): Set<string> {
  return new Set(
    [primary, ...defaults, ...(aliases?.split(",") ?? [])]
      .map((reaction) => reaction.trim())
      .filter(Boolean),
  );
}
