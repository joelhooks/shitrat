import type { GitHubOctokit } from "./github-app.js"

interface RepoRef {
  owner: string
  repo: string
}

export type CiReadErrorCode = "NOT_FOUND" | "PERMISSION_DENIED" | "RATE_LIMITED" | "CONFLICT" | "INVALID_INPUT" | "GITHUB_ERROR"

export class CiReadError extends Error {
  constructor(
    readonly code: CiReadErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

const statusOf = (error: unknown): number | undefined =>
  typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : undefined

const headerOf = (error: unknown, name: string): string | undefined => {
  if (typeof error !== "object" || error === null || !("response" in error)) return undefined
  const response = error.response as { headers?: Record<string, unknown> } | undefined
  const value = response?.headers?.[name]
  return value === undefined ? undefined : String(value)
}

const isRateLimited = (error: unknown): boolean => {
  const status = statusOf(error)
  if (status === 429) return true
  if (status !== 403) return false
  return headerOf(error, "x-ratelimit-remaining") === "0" || /rate limit/i.test(error instanceof Error ? error.message : "")
}

interface Meaning {
  notFound: string
  forbidden: string
  conflict?: string
  // GitHub answers an unknown sha with 422 "No commit found for SHA" rather than 404.
  unknownShaIs422?: boolean
}

// One call, one translation: callers say what a 404, 403 and 409 mean for the thing they asked for.
const translate = (error: unknown, meaning: Meaning): CiReadError => {
  if (error instanceof CiReadError) return error
  const status = statusOf(error)
  const detail = error instanceof Error ? error.message : String(error)
  if (isRateLimited(error)) {
    const reset = headerOf(error, "x-ratelimit-reset")
    const until = reset ? ` until ${new Date(Number(reset) * 1000).toISOString()}` : ""
    return new CiReadError("RATE_LIMITED", `GitHub rate limit reached for the shitratgit app${until}: ${detail}`, status)
  }
  if (status === 404 || (status === 422 && meaning.unknownShaIs422)) return new CiReadError("NOT_FOUND", meaning.notFound, status)
  if (status === 403) return new CiReadError("PERMISSION_DENIED", `${meaning.forbidden} (GitHub: ${detail})`, status)
  if (status === 409 && meaning.conflict) return new CiReadError("CONFLICT", `${meaning.conflict} (GitHub: ${detail})`, status)
  return new CiReadError("GITHUB_ERROR", detail, status)
}

const call = async <T>(run: () => Promise<T>, meaning: Meaning): Promise<T> => {
  try {
    return await run()
  } catch (error) {
    throw translate(error, meaning)
  }
}

export interface CheckRunSummary {
  id: number
  name: string
  status: string
  conclusion: string | null
  html_url: string | null
  app: string | null
}

export interface CommitStatusSummary {
  context: string
  state: string
  description: string | null
  target_url: string | null
}

// Conclusions that block a merge. neutral and skipped pass; stale is superseded by a newer run.
const FAILING_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"])
const FAILING_STATES = new Set(["failure", "error"])

export const isFailingRun = (run: { conclusion: string | null }): boolean =>
  run.conclusion !== null && FAILING_CONCLUSIONS.has(run.conclusion)

export type CiVerdict = "success" | "failure" | "pending" | "none"

export const summarizeChecks = (runs: readonly CheckRunSummary[], statuses: readonly CommitStatusSummary[]) => {
  const byConclusion: Record<string, number> = {}
  for (const run of runs) {
    // An unfinished run has no conclusion yet; count it under its status (queued, in_progress, ...).
    const key = run.conclusion ?? run.status
    byConclusion[key] = (byConclusion[key] ?? 0) + 1
  }
  const byState: Record<string, number> = {}
  for (const status of statuses) byState[status.state] = (byState[status.state] ?? 0) + 1
  const failing = [
    ...runs.filter(isFailingRun).map((run) => run.name),
    ...statuses.filter((status) => FAILING_STATES.has(status.state)).map((status) => status.context),
  ]
  const pending = [
    ...runs.filter((run) => run.status !== "completed").map((run) => run.name),
    ...statuses.filter((status) => status.state === "pending").map((status) => status.context),
  ]
  const total = runs.length + statuses.length
  const verdict: CiVerdict = total === 0 ? "none" : failing.length > 0 ? "failure" : pending.length > 0 ? "pending" : "success"
  return {
    verdict,
    total,
    check_runs_by_conclusion: byConclusion,
    statuses_by_state: byState,
    failing,
    pending,
  }
}

export const readChecks = async (octokit: GitHubOctokit, ref: RepoRef, sha: string) => {
  const input = sha.trim()
  if (input.length === 0) throw new CiReadError("INVALID_INPUT", "Pass a commit sha or ref.")
  const meaning = {
    notFound: `${input} is not a commit, branch or tag in ${ref.owner}/${ref.repo}, or the shitratgit app cannot see the repository.`,
    forbidden: `Reading checks needs Checks: read and Commit statuses: read on the shitratgit app`,
    unknownShaIs422: true,
  }
  const runs = await call(
    () => octokit.paginate(octokit.rest.checks.listForRef, { owner: ref.owner, repo: ref.repo, ref: input, per_page: 100 }),
    meaning,
  )
  // The combined status carries url, so octokit.paginate cannot flatten it; walk the pages by hand.
  const first = await call(
    () => octokit.rest.repos.getCombinedStatusForRef({ owner: ref.owner, repo: ref.repo, ref: input, per_page: 100, page: 1 }),
    meaning,
  )
  const statuses = [...first.data.statuses]
  for (let page = 2; statuses.length < first.data.total_count; page += 1) {
    const next = await call(
      () => octokit.rest.repos.getCombinedStatusForRef({ owner: ref.owner, repo: ref.repo, ref: input, per_page: 100, page }),
      meaning,
    )
    if (next.data.statuses.length === 0) break
    statuses.push(...next.data.statuses)
  }
  const checkRuns: CheckRunSummary[] = runs.map((run) => ({
    id: run.id,
    name: run.name,
    status: run.status,
    conclusion: run.conclusion ?? null,
    html_url: run.html_url ?? null,
    app: run.app?.slug ?? null,
  }))
  const commitStatuses: CommitStatusSummary[] = statuses.map((status) => ({
    context: status.context,
    state: status.state,
    description: status.description ?? null,
    target_url: status.target_url ?? null,
  }))
  return {
    sha: first.data.sha,
    ref: input,
    check_runs: checkRuns,
    combined_status: {
      // GitHub reports "pending" for a commit with no statuses at all; statuses.length tells them apart.
      state: first.data.state,
      total: commitStatuses.length,
      statuses: commitStatuses,
    },
    summary: summarizeChecks(checkRuns, commitStatuses),
  }
}

export const readPullRequestStatus = async (octokit: GitHubOctokit, ref: RepoRef, number: number) => {
  const pull = await call(() => octokit.rest.pulls.get({ owner: ref.owner, repo: ref.repo, pull_number: number }), {
    notFound: `Pull request #${number} does not exist in ${ref.owner}/${ref.repo}, or the shitratgit app cannot see the repository.`,
    forbidden: `Reading a pull request needs Pull requests: read on the shitratgit app`,
  })
  const checks = await readChecks(octokit, ref, pull.data.head.sha)
  return {
    number: pull.data.number,
    url: pull.data.html_url,
    title: pull.data.title,
    state: pull.data.state,
    merged: pull.data.merged,
    draft: pull.data.draft ?? false,
    // null means GitHub is still computing it; read again in a few seconds.
    mergeable: pull.data.mergeable,
    mergeable_state: pull.data.mergeable_state,
    head: { sha: pull.data.head.sha, ref: pull.data.head.ref },
    base: { ref: pull.data.base.ref },
    labels: pull.data.labels.map((label) => label.name),
    checks: {
      sha: checks.sha,
      ...checks.summary,
      failing_runs: checks.check_runs
        .filter(isFailingRun)
        .map((run) => ({ id: run.id, name: run.name, conclusion: run.conclusion, html_url: run.html_url, app: run.app })),
    },
  }
}

export const ACTIONS_READ_MISSING = "needs Actions: read permission on the shitratgit app"

const decodeLog = (data: unknown): string => {
  if (typeof data === "string") return data
  if (data instanceof ArrayBuffer || data instanceof Uint8Array) return new TextDecoder().decode(data)
  return String(data ?? "")
}

export const readJobLog = async (octokit: GitHubOctokit, ref: RepoRef, jobId: number, tail: number) => {
  if (!Number.isInteger(jobId) || jobId <= 0) throw new CiReadError("INVALID_INPUT", `${jobId} is not a job id.`)
  if (!Number.isInteger(tail) || tail < 0) throw new CiReadError("INVALID_INPUT", "--tail must be 0 (whole log) or a positive line count.")
  const meaning = {
    notFound: `Job ${jobId} does not exist in ${ref.owner}/${ref.repo}, or its logs have expired.`,
    forbidden: ACTIONS_READ_MISSING,
  }
  const job = await call(() => octokit.rest.actions.getJobForWorkflowRun({ owner: ref.owner, repo: ref.repo, job_id: jobId }), meaning)
  // GitHub answers with a 302 to a short-lived download URL; fetch follows it.
  const log = await call(
    () => octokit.rest.actions.downloadJobLogsForWorkflowRun({ owner: ref.owner, repo: ref.repo, job_id: jobId }),
    meaning,
  )
  const text = decodeLog(log.data)
  const lines = text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  const kept = tail === 0 ? lines : lines.slice(-tail)
  return {
    job_id: job.data.id,
    run_id: job.data.run_id,
    name: job.data.name,
    status: job.data.status,
    conclusion: job.data.conclusion,
    html_url: job.data.html_url,
    head_sha: job.data.head_sha,
    failed_steps: (job.data.steps ?? [])
      .filter((step) => isFailingRun({ conclusion: step.conclusion ?? null }))
      .map((step) => ({ number: step.number, name: step.name, conclusion: step.conclusion })),
    total_lines: lines.length,
    returned_lines: kept.length,
    truncated: kept.length < lines.length,
    log: kept.join("\n"),
  }
}

type WorkflowRun = Awaited<ReturnType<GitHubOctokit["rest"]["actions"]["getWorkflowRun"]>>["data"]

const runSummary = (run: WorkflowRun) => ({
  run_id: run.id,
  name: run.name ?? null,
  status: run.status,
  conclusion: run.conclusion,
  run_attempt: run.run_attempt ?? null,
  head_sha: run.head_sha,
  head_branch: run.head_branch,
  html_url: run.html_url,
})

export type RerunMode = "all" | "failed"

export interface RerunPolling {
  reads: number
  intervalMs: number
  sleep: (ms: number) => Promise<void>
}

// GitHub bumps run_attempt a few seconds after it accepts a rerun: read about every 2 s for about 10 s.
const DEFAULT_POLLING: RerunPolling = { reads: 5, intervalMs: 2000, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }

export const rerunWorkflowRun = async (
  octokit: GitHubOctokit,
  ref: RepoRef,
  runId: number,
  mode: RerunMode,
  dryRun: boolean,
  polling: RerunPolling = DEFAULT_POLLING,
) => {
  if (!Number.isInteger(runId) || runId <= 0) throw new CiReadError("INVALID_INPUT", `${runId} is not a workflow run id.`)
  const meaning: Meaning = {
    notFound: `Workflow run ${runId} does not exist in ${ref.owner}/${ref.repo}.`,
    forbidden: "GitHub refused the rerun: it needs Actions: write on the shitratgit app, and GitHub refuses runs older than 30 days",
    conflict: `Workflow run ${runId} cannot be rerun now; it is probably still running or already re-running`,
  }
  const before = runSummary((await call(() => octokit.rest.actions.getWorkflowRun({ owner: ref.owner, repo: ref.repo, run_id: runId }), meaning)).data)
  const base = { mode, before }
  if (dryRun) return { ...base, changed: false, after: before }
  const params = { owner: ref.owner, repo: ref.repo, run_id: runId }
  const accepted = await call(
    () => (mode === "failed" ? octokit.rest.actions.reRunWorkflowFailedJobs(params) : octokit.rest.actions.reRunWorkflow(params)),
    meaning,
  )
  // Report the run as GitHub reads back after accepting, not as we hope it looks.
  let after = before
  let reads = 0
  let confirmed = false
  while (reads < polling.reads && !confirmed) {
    if (reads > 0) await polling.sleep(polling.intervalMs)
    after = runSummary((await call(() => octokit.rest.actions.getWorkflowRun(params), meaning)).data)
    reads += 1
    confirmed = after.run_attempt !== null && before.run_attempt !== null && after.run_attempt > before.run_attempt
  }
  return { ...base, changed: true, github_status: accepted.status, attempt_confirmed: confirmed, readback_reads: reads, after }
}
