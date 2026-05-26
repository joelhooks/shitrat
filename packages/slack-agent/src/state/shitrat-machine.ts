import { assign, setup } from "xstate";
import type { ShitRatIntent } from "../types";

export type ShitRatMachineContext = {
  activeIntent?: ShitRatIntent;
  lastError?: string;
};

export type ShitRatMachineEvent =
  | { type: "slack.intent.received"; intent: ShitRatIntent }
  | { type: "ack.succeeded" }
  | { type: "flue.succeeded"; needsLocalExecution: boolean }
  | { type: "flue.failed"; error: string }
  | { type: "local.result.completed" }
  | { type: "local.result.failed"; error: string }
  | { type: "reset" };

export const shitratMachine = setup({
  types: {
    context: {} as ShitRatMachineContext,
    events: {} as ShitRatMachineEvent,
  },
}).createMachine({
  id: "shitratSlackAgent",
  initial: "idle",
  context: {},
  states: {
    idle: {
      on: {
        "slack.intent.received": {
          target: "acknowledging",
          actions: assign({
            activeIntent: ({ event }) => event.intent,
            lastError: () => undefined,
          }),
        },
      },
    },
    acknowledging: {
      tags: ["busy"],
      on: {
        "ack.succeeded": "runningFlue",
        "flue.failed": {
          target: "degraded",
          actions: assign({
            lastError: ({ event }) => event.error,
          }),
        },
      },
    },
    runningFlue: {
      tags: ["busy"],
      on: {
        "flue.succeeded": [
          { guard: ({ event }) => event.needsLocalExecution, target: "awaitingLocalExecution" },
          { target: "idle" },
        ],
        "flue.failed": {
          target: "degraded",
          actions: assign({
            lastError: ({ event }) => event.error,
          }),
        },
      },
    },
    awaitingLocalExecution: {
      tags: ["blocked"],
      on: {
        "local.result.completed": "idle",
        "local.result.failed": {
          target: "degraded",
          actions: assign({
            lastError: ({ event }) => event.error,
          }),
        },
      },
    },
    degraded: {
      tags: ["error"],
      on: {
        reset: "idle",
      },
    },
  },
});
