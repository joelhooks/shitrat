import type { GitHubOctokit } from "./github-app.js"
import { parseRepo } from "./github-app.js"
import { RunnerApiError } from "./org-runners.js"

export const runnerJobStatuses = ["queued", "in_progress"] as const
export type RunnerJobStatus = typeof runnerJobStatuses[number]
export interface RunnerJobsInput {
  readonly org: string
  readonly repos?: readonly string[]
  readonly statuses?: readonly RunnerJobStatus[]
  readonly maxRuns?: number
}
export interface RunnerJob {
  readonly repo: string
  readonly runId: number
  readonly jobId: number
  readonly name: string
  readonly status: RunnerJobStatus
  readonly labels: readonly string[]
  readonly runnerName: string | null
  readonly runnerGroupName: string | null
  readonly createdAt: string | null
  readonly startedAt: string | null
}
type ErrorCode = "request_failed" | "rate_limited" | "timeout"
class JobsApiError extends RunnerApiError {
  constructor(endpoint: string, status: number | undefined, readonly code: ErrorCode) {
    super(endpoint, status, endpoint === "GET /installation/repositories" ? "metadata: read" : "actions: read")
    if (code === "rate_limited") this.message = `${endpoint}: HTTP ${status}; rate limited; retry later.`
    if (code === "timeout") this.message = `${endpoint}: request timed out after 10000 ms.`
  }
}
interface RepoError {
  readonly repo: string
  readonly endpoint: string
  readonly status: number | null
  readonly code: ErrorCode
  readonly message: string
}
interface TruncatedRuns {
  readonly repo: string
  readonly status: RunnerJobStatus
}

// Inspect only bounded error metadata. Never retain or reflect headers, bodies or tokens.
const apiRead = async <T>(endpoint: string, read: (signal: AbortSignal) => Promise<T>): Promise<T> => {
  const signal = AbortSignal.timeout(10_000)
  let onAbort: () => void = () => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException("Request deadline exceeded", "TimeoutError"))
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    return await Promise.race([read(signal), aborted])
  } catch (error) {
    const value = typeof error === "object" && error !== null ? error : {}
    const status = "status" in value && typeof value.status === "number" ? value.status : undefined
    const response = "response" in value && typeof value.response === "object" && value.response !== null ? value.response : {}
    const headers = "headers" in response && typeof response.headers === "object" && response.headers !== null ? response.headers : {}
    const message = "message" in value && typeof value.message === "string" ? value.message : ""
    const rateLimited = (status === 403 || status === 429) && (
      "retry-after" in headers || ("x-ratelimit-remaining" in headers && String(headers["x-ratelimit-remaining"]) === "0") ||
      /secondary rate limit/i.test(message) || status === 429
    )
    const timedOut = signal.aborted || ("name" in value && (value.name === "TimeoutError" || value.name === "AbortError"))
    throw new JobsApiError(endpoint, status, timedOut ? "timeout" : rateLimited ? "rate_limited" : "request_failed")
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}

// Each page gets a fresh deadline, rather than sharing a single pagination signal.
const hasNext = (headers: { link?: string }) => /<[^>]+>;\s*rel="next"/.test(headers.link ?? "")
async function* pages<T>(read: (page: number | undefined) => Promise<{ data: T; headers: { link?: string } }>) {
  let page: number | undefined
  while (true) {
    const response = await read(page)
    yield response
    if (!hasNext(response.headers)) return
    page = (page ?? 1) + 1
  }
}
const uniqueRepos = (repos: readonly string[]) => [...new Map(repos.map((repo) => [repo.toLowerCase(), repo])).values()]

export const validateRunnerJobsInput = (input: RunnerJobsInput) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(input.org)) throw new RunnerApiError("invalid --org")
  const maxRuns = input.maxRuns ?? 50
  if (!Number.isSafeInteger(maxRuns) || maxRuns <= 0) throw new RunnerApiError("--max-runs must be a positive safe integer")
  const statuses = [...new Set(input.statuses?.length ? input.statuses : runnerJobStatuses)]
  if (statuses.some((status) => !runnerJobStatuses.includes(status))) throw new RunnerApiError("--status must be queued or in_progress")
  const repos = uniqueRepos(input.repos ?? [])
  for (const repo of repos) {
    if (parseRepo(repo).owner.toLowerCase() !== input.org.toLowerCase()) throw new RunnerApiError("--repo must belong to --org")
  }
  return { ...input, repos, statuses, maxRuns }
}

export const listRunnerJobs = async (octokit: GitHubOctokit, input: RunnerJobsInput) => {
  const { org, statuses, maxRuns, repos: selectedRepos } = validateRunnerJobsInput(input)
  const discovered: string[] = []
  if (!selectedRepos.length) {
    for await (const page of pages((page) => apiRead("GET /installation/repositories", (signal) =>
      octokit.request("GET /installation/repositories", { per_page: 100, ...(page ? { page } : {}), request: { signal } })))) {
      for (const repo of page.data.repositories) {
        if (repo.owner?.login.toLowerCase() === org.toLowerCase()) discovered.push(repo.full_name)
      }
    }
  }
  const repos = selectedRepos.length ? selectedRepos : uniqueRepos(discovered)

  // Four independent repo workers; pagination and runs within a repo stay serial.
  // Each worker transitions pending -> reading -> done or failed, retaining partial jobs.
  const pending = repos.entries()
  const results: { jobs: RunnerJob[]; errors: RepoError[]; truncated: TruncatedRuns[] }[] = new Array(repos.length)
  await Promise.all(Array.from({ length: Math.min(4, repos.length) }, async () => {
    for (const [index, fullName] of pending) {
      const result: typeof results[number] = { jobs: [], errors: [], truncated: [] }
      results[index] = result
      try {
        const { owner, repo } = parseRepo(fullName)
        const ref = { owner, repo }
        const seenRuns = new Set<number>()
        // A queued matrix job can live in an in-progress run. Filter jobs, not runs.
        for (const status of runnerJobStatuses) {
          const runs: number[] = []
          for await (const page of pages((page) => apiRead("GET /repos/{owner}/{repo}/actions/runs", (signal) =>
            octokit.request("GET /repos/{owner}/{repo}/actions/runs", {
              ...ref, status, per_page: Math.min(100, maxRuns), ...(page ? { page } : {}), request: { signal },
            })))) {
            const remaining = maxRuns - runs.length
            runs.push(...page.data.workflow_runs.slice(0, remaining).map(({ id }) => id))
            if (runs.length === maxRuns) {
              if (page.data.workflow_runs.length > remaining || hasNext(page.headers) || page.data.total_count > maxRuns) result.truncated.push({ repo: fullName, status })
              break
            }
          }
          for (const runId of runs) {
            // A run can change state between the two filtered reads.
            if (seenRuns.has(runId)) continue
            seenRuns.add(runId)
            for await (const page of pages((page) => apiRead("GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs", (signal) =>
              octokit.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs", {
                ...ref, run_id: runId, filter: "latest", per_page: 100, ...(page ? { page } : {}), request: { signal },
              })))) {
              for (const job of page.data.jobs) {
                if ((job.status !== "queued" && job.status !== "in_progress") || !statuses.includes(job.status)) continue
                result.jobs.push({
                  repo: fullName, runId, jobId: job.id, name: job.name, status: job.status,
                  labels: job.labels, runnerName: job.runner_name || null,
                  runnerGroupName: job.runner_group_name || null,
                  createdAt: job.created_at ?? null, startedAt: job.started_at ?? null,
                })
              }
            }
          }
        }
      } catch (error) {
        const safe = error instanceof JobsApiError ? error : new JobsApiError("Actions job read failed", undefined, "request_failed")
        result.errors.push({ repo: fullName, endpoint: safe.endpoint, status: safe.status ?? null, code: safe.code, message: safe.message })
      }
    }
  }))
  const jobs = results.flatMap((result) => result.jobs)
  return { org, count: jobs.length, jobs, errors: results.flatMap((result) => result.errors), truncated: results.flatMap((result) => result.truncated) }
}
