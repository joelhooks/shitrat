import { Args, Command, Options } from "@effect/cli"
import { Console, Effect, Option } from "effect"
import { constants } from "node:fs"
import { lstat, mkdir, open } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import packageInfo from "../../package.json" with { type: "json" }
import { createRepoOctokit, parseRepo, type GitHubOctokit, type RepoRef } from "../github-app.js"
import { failure, json, success } from "../response.js"

class RunCancelError extends Error {
  constructor(readonly code: string, message: string, readonly resetAt?: string) { super(message) }
}
// Only runs that have not started may be cancelled. Cancelling a started run can kill a deploy or preview mid-apply.
const WAITING = ["pending", "queued", "waiting"] as const
type WaitingStatus = (typeof WAITING)[number]
const isWaiting = (status: unknown): status is WaitingStatus => WAITING.includes(status as WaitingStatus)
const DEFAULT_MAX = 200
const MAX_CEILING = 500
// GitHub settles a cancelled waiting run within seconds: read about every 2 s for about 8 s.
const READBACK = { reads: 5, intervalMs: 2000 }
const PERMISSION = "actions: write (previews need at least actions: read)"

type RunResult = {
  repo: string; run_id: number; workflow: string; head_sha: string | null; created_at: string | null
  status_before: string | null; outcome: string; timestamp: string; cli_version: string; cancel_attempted: boolean
  error?: { code: string; message: string; reset_at?: string }
}
type ListedRun = { id: number; status: string | null; head_sha: string; created_at: string }
const fail = (code: string, message: string): never => { throw new RunCancelError(code, message) }
const statusOf = (error: unknown): number | undefined =>
  typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : undefined
const headersOf = (error: unknown): Record<string, string> => {
  if (typeof error !== "object" || error === null || !("response" in error)) return {}
  return (error as { response?: { headers?: Record<string, string> } }).response?.headers ?? {}
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Same capped Retry-After handling as delete-branch: one short cooldown, never a retry of ordinary failures or ambiguous writes.
const request = async <A>(endpoint: string, run: () => Promise<A>): Promise<A> => {
  for (let attempt = 0; ; attempt++) {
    try { return await run() } catch (error) {
      const status = statusOf(error)
      const headers = headersOf(error)
      const limited = status === 429 || (status === 403 && (headers["retry-after"] !== undefined || headers["x-ratelimit-remaining"] === "0"))
      if (limited) {
        const retryAfter = headers["retry-after"]
        if (attempt > 0 || retryAfter === undefined) return fail("RateLimited", `${endpoint} failed (HTTP ${status}); rate limit repeated or no Retry-After supplied. Stop and retry later.`)
        const delay = /^\d+(\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()
        if (!Number.isFinite(delay)) fail("RateLimited", `${endpoint} failed (HTTP ${status}); invalid Retry-After. Stop and retry later.`)
        const reset = new Date(Date.now() + Math.max(0, delay))
        if (!Number.isFinite(reset.getTime())) fail("RateLimited", `${endpoint} failed (HTTP ${status}); invalid Retry-After reset time. Stop and retry later.`)
        if (delay > 300_000) {
          const resetAt = reset.toISOString()
          throw new RunCancelError("RateLimited", `${endpoint} failed (HTTP ${status}); Retry-After exceeds five minutes. Stop the batch; retry after ${resetAt}.`, resetAt)
        }
        await sleep(Math.max(0, delay))
        continue
      }
      fail("GitHubRequestFailed", `${endpoint} failed${status === undefined ? "" : ` (HTTP ${status})`}. Verify the App has ${PERMISSION} on this repository and the workflow exists; inspect run state before retrying.`)
    }
  }
}

// Lists every allowed waiting status, oldest first, keeping only runs created strictly before the cutoff.
const listCandidates = async (octokit: GitHubOctokit, repo: RepoRef, workflow: string, statuses: WaitingStatus[], cutoff: number) => {
  const seen = new Map<number, ListedRun>()
  let afterCutoff = 0
  for (const status of statuses) {
    const endpoint = `GET /repos/${repo.owner}/${repo.repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?status=${status}`
    const runs = await request(endpoint, () => octokit.paginate(octokit.rest.actions.listWorkflowRuns,
      { owner: repo.owner, repo: repo.repo, workflow_id: workflow, status, per_page: 100 }))
    for (const run of runs) {
      if (seen.has(run.id)) continue
      const created = Date.parse(run.created_at)
      if (!Number.isFinite(created) || created >= cutoff) { afterCutoff++; continue }
      seen.set(run.id, { id: run.id, status: run.status, head_sha: run.head_sha, created_at: run.created_at })
    }
  }
  return { candidates: [...seen.values()].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id), afterCutoff }
}

const cancelOne = async (octokit: GitHubOctokit, repo: RepoRef, run: ListedRun, allowed: WaitingStatus[], yes: boolean, result: RunResult) => {
  // The list filter is GitHub's; this guard is ours. A listed run outside the waiting set never gets a POST.
  if (!isWaiting(run.status) || !allowed.includes(run.status)) fail("StatusNotWaiting", `Run was listed with status ${run.status}; only ${allowed.join(", ")} runs are cancelled. Nothing was sent.`)
  if (!yes) { result.outcome = "would-cancel"; return }
  const root = `/repos/${repo.owner}/${repo.repo}/actions/runs/${run.id}`
  const params = { owner: repo.owner, repo: repo.repo, run_id: run.id }
  const current = await request(`GET ${root}`, () => octokit.rest.actions.getWorkflowRun(params))
  if (!isWaiting(current.data.status) || !allowed.includes(current.data.status)) fail("StatusChanged", `Run status changed to ${current.data.status} after listing; a started run is never cancelled. Nothing was sent.`)
  result.cancel_attempted = true
  await request(`POST ${root}/cancel`, () => octokit.rest.actions.cancelWorkflowRun(params))
  let last = "unread"
  try {
    for (let read = 0; read < READBACK.reads; read++) {
      if (read > 0) await sleep(READBACK.intervalMs)
      const after = (await request(`GET ${root}`, () => octokit.rest.actions.getWorkflowRun(params))).data
      last = `${after.status}/${after.conclusion}`
      if (after.status === "completed" && after.conclusion === "cancelled") { result.outcome = "cancelled"; return }
      if (after.status === "completed") break
    }
  } catch (error) {
    if (error instanceof RunCancelError && error.code === "RateLimited") throw error
    fail("ReadbackMismatch", "Cancel was sent but the run readback failed. Inspect the run; do not resend blindly.")
  }
  fail("ReadbackMismatch", `Cancel was sent but the run read back as ${last}, not completed/cancelled. Inspect the run before retrying.`)
}

const REFUSALS = ["StatusNotWaiting", "StatusChanged"]

const runBatch = async (octokit: GitHubOctokit, repo: RepoRef, workflow: string, statuses: WaitingStatus[], cutoff: number, max: number, yes: boolean, logPath: string, actions: string | undefined) => {
  // Open the audit sink before any cancel. A broken audit sink stops writes, not just reporting.
  await mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 })
  const directory = await lstat(path.dirname(logPath))
  if (!directory.isDirectory() || (directory.mode & 0o777) !== 0o700) fail("AuditLogFailed", "Audit log directory must be a real directory with mode 0700. Choose a private directory; no shared directory permissions were changed.")
  const log = await open(logPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
  try {
    if (!(await log.stat()).isFile()) fail("AuditLogFailed", "Audit log must be a regular file.")
    await log.chmod(0o600)
    if (actions !== "write" && (yes || actions !== "read")) fail("PermissionDenied", `Installation token lacks ${PERMISSION}. Nothing was listed or cancelled.`)
    const { candidates, afterCutoff } = await listCandidates(octokit, repo, workflow, statuses, cutoff)
    const batch = candidates.slice(0, max)
    let stopped: RunCancelError | undefined
    const results: RunResult[] = []
    for (const run of batch) {
      const result: RunResult = { repo: repo.fullName, run_id: run.id, workflow, head_sha: run.head_sha, created_at: run.created_at, status_before: run.status, outcome: "failed:RunCancelFailed", timestamp: new Date().toISOString(), cli_version: packageInfo.version, cancel_attempted: false }
      try {
        if (stopped) throw stopped
        await cancelOne(octokit, repo, run, statuses, yes, result)
      } catch (error) {
        const typed = error instanceof RunCancelError ? error : new RunCancelError("RunCancelFailed", "Run operation failed. Inspect state before retrying.")
        result.error = { code: typed.code, message: typed.message, ...(typed.resetAt === undefined ? {} : { reset_at: typed.resetAt }) }
        result.outcome = `${REFUSALS.includes(typed.code) ? "refused" : "failed"}:${typed.code}`
        if (typed.code === "RateLimited") stopped = typed
      }
      await log.writeFile(`${JSON.stringify(result)}\n`)
      await log.sync()
      results.push(result)
    }
    const counts: Record<string, number> = { cancelled: 0, "would-cancel": 0, refused: 0, failed: 0 }
    for (const result of results) counts[result.outcome.split(":")[0]!]!++
    return { results, counts, skipped_after_cutoff: afterCutoff, remaining_over_max: candidates.length - batch.length }
  } finally { await log.close() }
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

export const cancelRunsCmd = Command.make("cancel-runs", {
  repo: Args.text({ name: "repo" }),
  workflow: Options.text("workflow").pipe(Options.optional),
  createdBefore: Options.text("created-before").pipe(Options.optional),
  statuses: Options.text("status").pipe(Options.repeated),
  max: Options.integer("max").pipe(Options.withDefault(DEFAULT_MAX)),
  log: Options.text("log").pipe(Options.optional),
  dryRun: Options.boolean("dry-run"), yes: Options.boolean("yes"),
}, ({ repo, workflow, createdBefore, statuses, max, log, dryRun, yes }) => Effect.gen(function* () {
  const invalid = (code: string, message: string) => Effect.fail(new RunCancelError(code, message))
  // --dry-run always wins: a preview never cancels, even next to --yes.
  const confirmed = yes && !dryRun
  const file = Option.getOrUndefined(workflow)
  if (!file || !/^[A-Za-z0-9._-]+\.ya?ml$/.test(file)) return yield* invalid("InvalidWorkflow", "Pass --workflow with the workflow file name, e.g. preview.yml. There is no cancel-everything form.")
  const before = Option.getOrUndefined(createdBefore)
  const cutoff = before !== undefined && ISO.test(before) ? Date.parse(before) : Number.NaN
  if (!Number.isFinite(cutoff)) return yield* invalid("InvalidCutoff", "Pass --created-before as an ISO-8601 timestamp with a timezone, e.g. 2026-10-26T00:00:00Z.")
  if (cutoff > Date.now()) return yield* invalid("InvalidCutoff", "--created-before is in the future; that would cancel runs that were just queued. Pick a past cutoff.")
  const picked = statuses.length ? [...new Set(statuses)] : [...WAITING]
  const bad = picked.filter((status) => !isWaiting(status))
  if (bad.length) return yield* invalid("InvalidStatus", `Refused --status ${bad.join(", ")}: only pending, queued and waiting runs can be cancelled. Cancelling a started run can kill a deploy or preview mid-apply.`)
  if (!Number.isInteger(max) || max < 1 || max > MAX_CEILING) return yield* invalid("InvalidMax", `--max must be between 1 and ${MAX_CEILING}.`)
  const repoRef = yield* Effect.try({ try: () => parseRepo(repo), catch: () => new RunCancelError("InvalidRepository", "Use owner/repo.") })
  const { octokit, token } = yield* createRepoOctokit(repoRef)
  const logPath = Option.getOrElse(log, () => path.join(homedir(), ".local/state/shitrat/run-cancels.jsonl"))
  const batch = yield* Effect.tryPromise({
    try: () => runBatch(octokit, repoRef, file, picked as WaitingStatus[], cutoff, max, confirmed, logPath, token.permissions.actions),
    catch: (error) => error instanceof RunCancelError ? error : new RunCancelError("AuditLogFailed", "Audit log could not be opened or appended. Stop and inspect run state and log permissions before retrying."),
  })
  const result = { ...batch, repo: repoRef.fullName, workflow: file, created_before: new Date(cutoff).toISOString(), statuses: picked, max, dry_run: !confirmed, github_write: batch.results.some((item) => item.cancel_attempted), actor: "shitratgit[bot]", installation_id: token.installationId, log: logPath }
  const actions = [{ command: "status <repo>", description: "Check repository access; inspect run results and the audit log before retrying", params: { repo: { value: repoRef.fullName } } }]
  const command = `cancel-runs ${repoRef.fullName}`
  if (batch.counts.refused || batch.counts.failed) {
    process.exitCode = 1
    yield* Console.log(JSON.stringify({ ...failure(command, "One or more runs refused or failed; inspect per-run results.", "RunCancelBatchFailed", `Verify ${PERMISSION} and run state; do not retry blindly.`, actions), result }, null, 2))
  } else yield* Console.log(json(success(command, result, actions)))
}).pipe(Effect.catchAll((error) => Effect.gen(function* () {
  process.exitCode = 1
  const typed = error instanceof RunCancelError ? error : new RunCancelError("RunCancelFailed", `Authentication or run cancellation failed. Verify repository access and ${PERMISSION}.`)
  yield* Console.log(json(failure(`cancel-runs ${repo}`, typed.message, typed.code, `Inspect inputs, run state and ${PERMISSION} before retrying.`, [{ command: "status <repo>", description: "Check App repository access", params: { repo: { value: repo } } }])))
})))).pipe(Command.withDescription("Cancel stale pending, queued or waiting workflow runs created before a cutoff; dry-run by default, writes require --yes"))
