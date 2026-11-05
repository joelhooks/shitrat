import type { GitHubOctokit } from "./github-app.js"
import { parseRepo } from "./github-app.js"
import { runnerApiCall, RunnerApiError } from "./org-runners.js"

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
interface RepoError {
  readonly repo: string
  readonly endpoint: string
  readonly status: number | null
  readonly message: string
}

export const validateRunnerJobsInput = (input: RunnerJobsInput) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(input.org)) throw new RunnerApiError("invalid --org")
  const maxRuns = input.maxRuns ?? 50
  if (!Number.isSafeInteger(maxRuns) || maxRuns <= 0) throw new RunnerApiError("--max-runs must be a positive safe integer")
  const statuses = [...new Set(input.statuses?.length ? input.statuses : runnerJobStatuses)]
  if (statuses.some((status) => !runnerJobStatuses.includes(status))) throw new RunnerApiError("--status must be queued or in_progress")
  const repos = [...new Set(input.repos ?? [])]
  for (const repo of repos) {
    if (parseRepo(repo).owner.toLowerCase() !== input.org.toLowerCase()) throw new RunnerApiError("--repo must belong to --org")
  }
  return { ...input, repos, statuses, maxRuns }
}

export const listRunnerJobs = async (octokit: GitHubOctokit, input: RunnerJobsInput) => {
  const { org, statuses, maxRuns, repos: selectedRepos } = validateRunnerJobsInput(input)
  const repos = selectedRepos.length ? selectedRepos : (await runnerApiCall("GET /installation/repositories", () =>
    octokit.paginate("GET /installation/repositories", { per_page: 100 }), "metadata: read"))
    .filter(({ owner }) => owner?.login.toLowerCase() === org.toLowerCase())
    .map(({ full_name }) => full_name)

  // Four independent repo workers; pagination and runs within a repo stay serial.
  // Each worker transitions pending -> reading -> done or failed, retaining partial jobs.
  const pending = repos.entries()
  const results: { jobs: RunnerJob[]; errors: RepoError[] }[] = new Array(repos.length)
  await Promise.all(Array.from({ length: Math.min(4, repos.length) }, async () => {
    for (const [index, fullName] of pending) {
      const result: { jobs: RunnerJob[]; errors: RepoError[] } = { jobs: [], errors: [] }
      results[index] = result
      try {
        const { owner, repo } = parseRepo(fullName)
        const ref = { owner, repo }
        const seenRuns = new Set<number>()
        for (const status of statuses) {
          const runs = await runnerApiCall("GET /repos/{owner}/{repo}/actions/runs", async () => {
            const found: number[] = []
            for await (const page of octokit.paginate.iterator("GET /repos/{owner}/{repo}/actions/runs", {
              ...ref, status, per_page: Math.min(100, maxRuns),
            })) {
              for (const run of page.data) {
                found.push(run.id)
                if (found.length === maxRuns) break
              }
              if (found.length === maxRuns) break
            }
            return found
          }, "actions: read")
          for (const runId of runs) {
            // A run can change state between the two filtered reads.
            if (seenRuns.has(runId)) continue
            seenRuns.add(runId)
            const jobs = await runnerApiCall("GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs", () =>
              octokit.paginate("GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs", {
                ...ref, run_id: runId, filter: "latest", per_page: 100,
              }), "actions: read")
            for (const job of jobs) {
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
      } catch (error) {
        // Do not serialize arbitrary request errors, headers, bodies or credentials.
        const safe = error instanceof RunnerApiError ? error : new RunnerApiError("Actions job read failed")
        result.errors.push({ repo: fullName, endpoint: safe.endpoint, status: safe.status ?? null, message: safe.message })
      }
    }
  }))
  const jobs = results.flatMap((result) => result.jobs)
  return { org, count: jobs.length, jobs, errors: results.flatMap((result) => result.errors) }
}
