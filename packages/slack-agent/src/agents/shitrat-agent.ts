import { Agent } from "agents";
import { runShitRatFlueSession } from "../flue/shitrat-session";
import { normalizeSlackIntent } from "../slack/normalize";
import type { SlackEnvelope } from "../slack/types";
import type { Env, JoelclawJobResponse, ShitRatAgentState, ShitRatIntent, ShitRatJobState } from "../types";

const RECENT_EVENT_LIMIT = 500;

export class ShitRatAgent extends Agent<Env, ShitRatAgentState> {
  initialState: ShitRatAgentState = {
    mode: "idle",
    recentEventIds: [],
    activeJobs: {},
  };

  async handleSlackEnvelope(envelope: SlackEnvelope): Promise<{ ok: boolean; handled: boolean; reason?: string }> {
    const intent = normalizeSlackIntent(envelope, this.env);
    if (!intent) {
      this.setState({
        ...this.state,
        lastSlackEventAt: new Date().toISOString(),
      });
      return { ok: true, handled: false, reason: "not-a-shitrat-intent" };
    }

    if (this.hasSeen(intent.id)) {
      return { ok: true, handled: true, reason: "duplicate" };
    }

    this.rememberIntent(intent.id);
    this.waitUntil(this.processIntent(intent));
    return { ok: true, handled: true };
  }

  async receiveExecutorResult(result: JoelclawJobResponse & { jobId: string; intentId?: string }): Promise<{ ok: boolean }> {
    const activeJobs = { ...this.state.activeJobs };
    const job = activeJobs[result.jobId];
    if (!job) {
      this.setState({
        ...this.state,
        lastError: `unknown executor job: ${result.jobId}`,
      });
      return { ok: false };
    }

    const updatedJob: ShitRatJobState = {
      ...job,
      status: result.ok ? "completed" : "failed",
      updatedAt: new Date().toISOString(),
      summary: result.message ?? job.summary,
      error: result.error,
    };
    activeJobs[result.jobId] = updatedJob;

    this.setState({
      ...this.state,
      mode: result.ok ? "idle" : "degraded",
      activeJobs,
      ...(result.error ? { lastError: result.error } : {}),
    });

    await this.postJobResult(updatedJob);
    return { ok: true };
  }

  private async processIntent(intent: ShitRatIntent): Promise<void> {
    try {
      this.setState({ ...this.state, mode: "acknowledging" });
      await this.acknowledgeIntent(intent);

      this.setState({ ...this.state, mode: "running_flue" });
      const response = await runShitRatFlueSession(intent, this.env);
      const now = new Date().toISOString();
      const job: ShitRatJobState = {
        jobId: intent.id,
        intentId: intent.id,
        status: response.needsLocalExecution ? "queued" : "completed",
        createdAt: now,
        updatedAt: now,
        slackChannelId: intent.channelId,
        slackMessageTs: intent.messageTs,
        slackThreadTs: intent.threadTs,
        summary: response.nextAction,
      };

      this.setState({
        ...this.state,
        mode: response.needsLocalExecution ? "awaiting_local_execution" : "idle",
        activeJobs: {
          ...this.state.activeJobs,
          [job.jobId]: job,
        },
      });

      await this.postThreadMessage(intent, response.reply);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setState({ ...this.state, mode: "degraded", lastError: message });
      await this.postThreadMessage(intent, `ShitRat tripped on the wire: ${message}`);
    }
  }

  private hasSeen(intentId: string): boolean {
    return this.state.recentEventIds.includes(intentId);
  }

  private rememberIntent(intentId: string): void {
    const recentEventIds = [intentId, ...this.state.recentEventIds.filter((id) => id !== intentId)].slice(0, RECENT_EVENT_LIMIT);
    this.setState({
      ...this.state,
      recentEventIds,
      lastSlackEventAt: new Date().toISOString(),
    });
  }

  private waitUntil(promise: Promise<unknown>): void {
    const runtime = this as unknown as { ctx?: { waitUntil?: (promise: Promise<unknown>) => void } };
    runtime.ctx?.waitUntil?.(promise.catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.setState({ ...this.state, mode: "degraded", lastError: message });
    }));
  }

  private async acknowledgeIntent(intent: ShitRatIntent): Promise<void> {
    const reaction = intent.kind === "watch" ? (this.env.SHITRAT_REACTION_WATCH ?? "eyes") : (this.env.SHITRAT_REACTION_ACK ?? "shitrat");
    await this.addReactionWithFallback(intent, reaction);
  }

  private async addReactionWithFallback(intent: ShitRatIntent, reaction: string): Promise<void> {
    try {
      await this.callSlackApi("reactions.add", {
        channel: intent.channelId,
        timestamp: intent.messageTs,
        name: reaction,
      });
    } catch (error) {
      if (reaction !== "rat" && error instanceof Error && error.message.includes("invalid_name")) {
        await this.callSlackApi("reactions.add", {
          channel: intent.channelId,
          timestamp: intent.messageTs,
          name: "rat",
        });
        return;
      }
      throw error;
    }
  }

  private async postThreadMessage(intent: ShitRatIntent, text: string): Promise<void> {
    await this.postSlackThreadMessage({
      channelId: intent.channelId,
      messageTs: intent.messageTs,
      threadTs: intent.threadTs,
      text,
    });
  }

  private async postJobResult(job: ShitRatJobState): Promise<void> {
    const text = job.status === "completed"
      ? (job.summary ?? "🐀 Done.")
      : `ShitRat hit a snag: ${job.error ?? job.summary ?? "unknown executor failure"}`;

    await this.postSlackThreadMessage({
      channelId: job.slackChannelId,
      messageTs: job.slackMessageTs,
      threadTs: job.slackThreadTs,
      text,
    });
  }

  private async postSlackThreadMessage(input: { channelId: string; messageTs: string; threadTs?: string; text: string }): Promise<void> {
    await this.callSlackApi("chat.postMessage", {
      channel: input.channelId,
      thread_ts: input.threadTs ?? input.messageTs,
      text: input.text,
      unfurl_links: false,
      unfurl_media: false,
    });
  }

  private async callSlackApi(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.env.SLACK_BOT_TOKEN}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });

    const payload = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    if (!response.ok || !payload?.ok) {
      const error = payload?.error ?? `slack_http_${response.status}`;
      if (error === "already_reacted") return payload ?? { ok: true };
      throw new Error(`Slack ${method} failed: ${error}`);
    }

    return payload as Record<string, unknown>;
  }
}
