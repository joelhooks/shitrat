import { getAgentByName, routeAgentRequest } from "agents";
import { ShitRatAgent } from "./agents/shitrat-agent";
import {
  handleExecutorResult,
  handleSlackEvents,
  json,
  type ShitRatAgentPort,
} from "./server/handlers";
import type { Env } from "./types";

export { ShitRatAgent };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const routed = await routeAgentRequest(request, env);
    if (routed) return routed;

    const url = new URL(request.url);
    const deps = { getAgent: getShitRatAgent };

    if (url.pathname === "/health") {
      return json({ ok: true, service: "shitrat-slack-agent", environment: env.ENVIRONMENT ?? "local" });
    }

    if (url.pathname === "/slack/events" && request.method === "POST") {
      return handleSlackEvents(request, env, deps);
    }

    if (url.pathname === "/executor/result" && request.method === "POST") {
      return handleExecutorResult(request, env, deps);
    }

    return json({ ok: false, error: "not_found" }, 404);
  },
} satisfies ExportedHandler<Env>;

async function getShitRatAgent(env: Env): Promise<ShitRatAgentPort> {
  const getNamedAgent = getAgentByName as unknown as (
    namespace: DurableObjectNamespace,
    name: string,
  ) => Promise<ShitRatAgentPort>;

  return await getNamedAgent(env.ShitRatAgent as unknown as DurableObjectNamespace, env.SHITRAT_AGENT_INSTANCE ?? "joel");
}
