export type SlackEnvelope = {
  type: "url_verification" | "event_callback" | string;
  token?: string;
  challenge?: string;
  team_id?: string;
  api_app_id?: string;
  event_id?: string;
  event_time?: number;
  event?: SlackEvent;
};

export type SlackEvent = SlackReactionAddedEvent | SlackAppMentionEvent | SlackMessageEvent | Record<string, unknown>;

export type SlackReactionAddedEvent = {
  type: "reaction_added";
  user?: string;
  reaction?: string;
  item?: {
    type?: string;
    channel?: string;
    ts?: string;
  };
  item_user?: string;
  event_ts?: string;
};

export type SlackAppMentionEvent = {
  type: "app_mention";
  user?: string;
  channel?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  event_ts?: string;
};

export type SlackMessageEvent = {
  type: "message";
  user?: string;
  channel?: string;
  channel_type?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
  event_ts?: string;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
