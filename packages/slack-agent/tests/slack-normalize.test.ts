import { describe, expect, test } from "vitest";
import { normalizeSlackIntent } from "../src/slack/normalize";

const env = {
  SHITRAT_REACTION_SUMMON: "shitrat",
  SHITRAT_REACTION_SUMMON_ALIASES: "rat",
  SHITRAT_REACTION_WATCH: "eyes",
} as const;

describe("normalizeSlackIntent", () => {
  test("turns :rat: alias reactions into summon intents", () => {
    const intent = normalizeSlackIntent({
      type: "event_callback",
      team_id: "T1",
      event_id: "Ev1",
      event: {
        type: "reaction_added",
        user: "U1",
        reaction: "rat",
        item: { type: "message", channel: "C1", ts: "1772990000.000100" },
      },
    }, env);

    expect(intent?.kind).toBe("summon");
    expect(intent?.trigger).toBe("reaction");
    expect(intent?.channelId).toBe("C1");
  });

  test("turns :shitrat: reactions into summon intents", () => {
    const intent = normalizeSlackIntent({
      type: "event_callback",
      team_id: "T1",
      event_id: "Ev1b",
      event: {
        type: "reaction_added",
        user: "U1",
        reaction: "shitrat",
        item: { type: "message", channel: "C1", ts: "1772990000.000100" },
      },
    }, env);

    expect(intent?.kind).toBe("summon");
    expect(intent?.trigger).toBe("reaction");
    expect(intent?.channelId).toBe("C1");
  });

  test("turns :eyes: reactions into watch intents", () => {
    const intent = normalizeSlackIntent({
      type: "event_callback",
      team_id: "T1",
      event_id: "Ev2",
      event: {
        type: "reaction_added",
        user: "U1",
        reaction: "eyes",
        item: { type: "message", channel: "C1", ts: "1772990000.000100" },
      },
    }, env);

    expect(intent?.kind).toBe("watch");
  });

  test("ignores ordinary channel messages", () => {
    const intent = normalizeSlackIntent({
      type: "event_callback",
      event_id: "Ev3",
      event: {
        type: "message",
        channel_type: "channel",
        channel: "C1",
        ts: "1772990000.000100",
        text: "ambient chatter",
      },
    }, env);

    expect(intent).toBeNull();
  });
});
