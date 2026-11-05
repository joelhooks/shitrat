import { Octokit } from "@octokit/rest"
import { describe, expect, spyOn, test } from "bun:test"
import { listRunnerJobs } from "../src/runner-jobs.js"
import { json, success } from "../src/response.js"

type Reply = { body?: unknown; status?: number; next?: string; headers?: Record<string, string> }
const token = "fixture-installation-token-do-not-output"
const github = (respond: (url: URL) => Reply | Promise<Reply>) => {
  const calls: string[] = []
  const signals: (AbortSignal | null | undefined)[] = []
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`)
    signals.push(init?.signal)
    const reply = await respond(url)
    // GitHub collection envelopes include total_count; Octokit uses it to normalize arrays.
    const body = typeof reply.body === "object" && reply.body !== null ? { total_count: 2, ...reply.body } : { message: token }
    const response = new Response(JSON.stringify(body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", "x-ratelimit-remaining": "4999", ...(reply.next ? { link: `<https://api.github.com${reply.next}>; rel="next"` } : {}), ...reply.headers },
    })
    Object.defineProperty(response, "url", { value: url.href })
    return response
  }
  return { calls, signals, octokit: new Octokit({ auth: token, request: { fetch }, log: { debug() {}, info() {}, warn() {}, error() {} } }) }
}
const job = (id: number, status = "queued") => ({
  id, name: "build", status, labels: ["self-hosted", "linux", "pool-a"],
  runner_name: "runner-1", runner_group_name: "pool-a",
  created_at: "2026-01-01T00:00:00Z", started_at: "2026-01-01T00:00:01Z", token,
})
const input = { org: "example", repos: ["example/project"] }
const runPath = "/repos/example/project/actions/runs"
const jobsPath = `${runPath}/1/jobs`
const onlyGets = (calls: string[]) => expect(calls.every((route) => route.startsWith("GET "))).toBe(true)

describe("runner-jobs", () => {
  test("paginates installation repos, both run filters and jobs; maps only safe job fields", async () => {
    const gh = github((url) => {
      const page2 = url.searchParams.get("page") === "2"
      if (url.pathname === "/installation/repositories") return {
        body: { repositories: page2 ? [{ full_name: "example/project", owner: { login: "example" } }] : [{ full_name: "other/project", owner: { login: "other" } }] },
        ...(!page2 ? { next: "/installation/repositories?per_page=100&page=2" } : {}),
      }
      const status = url.searchParams.get("status")
      if (url.pathname === runPath) return {
        body: { workflow_runs: page2 ? [{ id: status === "queued" ? 1 : 2 }] : [] },
        ...(!page2 ? { next: `${runPath}?status=${status}&per_page=50&page=2` } : {}),
      }
      if (url.pathname.endsWith("/jobs")) return {
        body: { jobs: page2 ? [job(url.pathname.includes("/1/") ? 11 : 21, "in_progress")] : [job(url.pathname.includes("/1/") ? 10 : 20), job(99, "completed")] },
        ...(!page2 ? { next: `${url.pathname}?filter=latest&per_page=100&page=2` } : {}),
      }
      return { status: 404 }
    })
    const result = await listRunnerJobs(gh.octokit, { org: "example" })
    expect(result.errors).toEqual([])
    expect(result.count).toBe(4)
    expect(result.jobs[0]).toEqual({ repo: "example/project", runId: 1, jobId: 10, name: "build", status: "queued", labels: ["self-hosted", "linux", "pool-a"], runnerName: "runner-1", runnerGroupName: "pool-a", createdAt: "2026-01-01T00:00:00Z", startedAt: "2026-01-01T00:00:01Z" })
    expect(result.jobs.map(({ jobId }) => jobId)).toEqual([10, 11, 20, 21])
    expect(gh.calls).toHaveLength(10)
    expect(gh.signals.every((signal) => signal instanceof AbortSignal)).toBe(true)
    expect(new Set(gh.signals).size).toBe(10)
    expect(result.truncated).toEqual([])
    expect(gh.calls.filter((route) => route.startsWith(`GET ${runPath}?`))).toEqual([
      `GET ${runPath}?status=queued&per_page=50`, `GET ${runPath}?status=queued&per_page=50&page=2`,
      `GET ${runPath}?status=in_progress&per_page=50`, `GET ${runPath}?status=in_progress&per_page=50&page=2`,
    ])
    expect(json(success("runner-jobs", result))).not.toContain(token)
    onlyGets(gh.calls)
  })

  for (const status of ["queued", "in_progress"] as const) test(`${status} filters jobs but always reads both run states, including matrix jobs`, async () => {
    const gh = github((url) => url.pathname === runPath
      ? { body: { workflow_runs: url.searchParams.get("status") === "in_progress" ? [{ id: 1 }] : [] } }
      : { body: { jobs: [job(1, "queued"), job(2, "in_progress"), job(3, "completed"), job(4, "waiting")] } })
    const result = await listRunnerJobs(gh.octokit, { ...input, statuses: [status] })
    expect(result.jobs.map(({ status }) => status)).toEqual([status])
    expect(result.errors).toEqual([])
    expect(gh.calls).toEqual([`GET ${runPath}?status=queued&per_page=50`, `GET ${runPath}?status=in_progress&per_page=50`, `GET ${jobsPath}?filter=latest&per_page=100`])
    onlyGets(gh.calls)
  })

  test("records a per-repo 403 without reflecting credentials or failing other repos", async () => {
    const gh = github((url) => url.pathname.includes("/denied/") ? { status: 403 }
      : url.pathname === runPath ? { body: { workflow_runs: [{ id: 1 }] } }
      : { body: { jobs: [job(1)] } })
    const result = await listRunnerJobs(gh.octokit, { ...input, repos: ["example/denied", ...input.repos] })
    expect(result.count).toBe(1)
    expect(result.errors).toEqual([{ repo: "example/denied", endpoint: "GET /repos/{owner}/{repo}/actions/runs", status: 403, code: "request_failed", message: "GET /repos/{owner}/{repo}/actions/runs: HTTP 403; requires actions: read. Stop; do not change app permissions." }])
    expect(json(success("runner-jobs", result))).not.toContain(token)
    onlyGets(gh.calls)
  })

  test("job endpoint failure keeps earlier jobs and records the affected repo", async () => {
    const gh = github((url) => url.pathname === runPath ? { body: { workflow_runs: [{ id: 1 }, { id: 2 }] } }
      : url.pathname === jobsPath ? { body: { jobs: [job(1)] } } : { status: 403 })
    const result = await listRunnerJobs(gh.octokit, input)
    expect(result.count).toBe(1)
    expect(result.errors).toMatchObject([{ repo: "example/project", endpoint: "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs", status: 403 }])
    expect(JSON.stringify(result)).not.toContain(token)
  })

  test("caps each status independently without fetching beyond max-runs, including pagination past 100", async () => {
    const gh = github((url) => {
      if (url.pathname === runPath) {
        const start = url.searchParams.get("page") === "2" ? 100 : 0
        const offset = url.searchParams.get("status") === "queued" ? 0 : 1000
        return { body: { workflow_runs: Array.from({ length: 100 }, (_, i) => ({ id: offset + start + i })) }, next: `${runPath}?status=${url.searchParams.get("status")}&per_page=100&page=${start ? 3 : 2}` }
      }
      return { body: { jobs: [] } }
    })
    const result = await listRunnerJobs(gh.octokit, { ...input, maxRuns: 101 })
    expect(result.truncated).toEqual([{ repo: "example/project", status: "queued" }, { repo: "example/project", status: "in_progress" }])
    expect(gh.calls.filter((route) => route.includes("/jobs?"))).toHaveLength(202)
    expect(gh.calls.filter((route) => route.startsWith(`GET ${runPath}?`))).toHaveLength(4)
    expect(gh.calls.some((route) => route.includes("page=3"))).toBe(false)
  })

  test("the default cap stops after 50 runs per status without following next links", async () => {
    const gh = github((url) => url.pathname === runPath ? {
      body: { workflow_runs: Array.from({ length: 50 }, (_, i) => ({ id: (url.searchParams.get("status") === "queued" ? 0 : 100) + i })) },
      next: `${runPath}?status=${url.searchParams.get("status")}&per_page=50&page=2`,
    } : { body: { jobs: [] } })
    const result = await listRunnerJobs(gh.octokit, input)
    expect(result.truncated).toHaveLength(2)
    expect(gh.calls.filter((route) => route.includes("/jobs?"))).toHaveLength(100)
    expect(gh.calls.filter((route) => route.startsWith(`GET ${runPath}?`))).toEqual([
      `GET ${runPath}?status=queued&per_page=50`, `GET ${runPath}?status=in_progress&per_page=50`,
    ])
  })

  test("an inaccessible installation fails discovery without reflecting response tokens", async () => {
    const gh = github(() => ({ status: 403 }))
    await expect(listRunnerJobs(gh.octokit, { org: "example" })).rejects.toThrow("GET /installation/repositories: HTTP 403")
    expect(gh.calls).toEqual(["GET /installation/repositories?per_page=100"])
  })

  test("an installation with no matching repositories returns an empty complete result", async () => {
    const gh = github(() => ({ body: { repositories: [{ full_name: "other/project", owner: { login: "other" } }] } }))
    expect(await listRunnerJobs(gh.octokit, { org: "example" })).toEqual({ org: "example", count: 0, jobs: [], errors: [], truncated: [] })
    expect(gh.calls).toHaveLength(1)
  })

  test("normalizes unassigned fields to null and deduplicates runs during status transitions", async () => {
    const gh = github((url) => url.pathname === runPath ? { body: { workflow_runs: [{ id: 1 }] } }
      : { body: { jobs: [{ ...job(1), runner_name: "", runner_group_name: null, started_at: null, created_at: undefined }] } })
    const result = await listRunnerJobs(gh.octokit, input)
    expect(result.jobs).toMatchObject([{ runnerName: null, runnerGroupName: null, startedAt: null, createdAt: null }])
    expect(result.count).toBe(1)
    expect(gh.calls.filter((route) => route.includes("/jobs?"))).toHaveLength(1)
  })

  test("rejects invalid scope and limits before HTTP", async () => {
    for (const invalid of [
      { ...input, maxRuns: 0 }, { ...input, maxRuns: 1.5 }, { ...input, maxRuns: Number.MAX_SAFE_INTEGER + 1 },
      { ...input, repos: ["elsewhere/project"] }, { ...input, repos: ["invalid"] }, { ...input, org: "bad/org" },
    ]) {
      const gh = github(() => ({ status: 500 }))
      await expect(listRunnerJobs(gh.octokit, invalid)).rejects.toThrow()
      expect(gh.calls).toEqual([])
    }
  })

  test("exactly max-runs without more runs is not marked truncated", async () => {
    const gh = github((url) => url.pathname === runPath
      ? { body: { total_count: 1, workflow_runs: [{ id: 1 }] } }
      : { body: { jobs: [] } })
    expect((await listRunnerJobs(gh.octokit, { ...input, maxRuns: 1 })).truncated).toEqual([])
  })

  test("deduplicates repository spelling case-insensitively", async () => {
    const gh = github(() => ({ body: { workflow_runs: [] } }))
    await listRunnerJobs(gh.octokit, { ...input, repos: ["EXAMPLE/Project", "example/project"] })
    expect(gh.calls).toHaveLength(2)
  })

  for (const status of [403, 429]) for (const hint of ["retry-after", "remaining", "secondary"]) test(`${status} ${hint} is rate_limited, not a permission refusal`, async () => {
    const gh = github(() => ({ status,
      body: { message: hint === "secondary" ? `secondary rate limit ${token}` : token },
      headers: hint === "retry-after" ? { "retry-after": "30" } : hint === "remaining" ? { "x-ratelimit-remaining": "0" } : {},
    }))
    const result = await listRunnerJobs(gh.octokit, input)
    expect(result.errors).toEqual([{ repo: "example/project", endpoint: "GET /repos/{owner}/{repo}/actions/runs", status, code: "rate_limited", message: `GET /repos/{owner}/{repo}/actions/runs: HTTP ${status}; rate limited; retry later.` }])
    expect(JSON.stringify(result)).not.toContain(token)
    expect(JSON.stringify(result)).not.toContain("requires actions")
    expect(gh.calls).toHaveLength(1)
  })

  test("non-RunnerApiError transport failures retain a sanitized endpoint in JSON", async () => {
    const gh = github(() => { throw new Error(token) })
    const result = await listRunnerJobs(gh.octokit, input)
    const output = JSON.parse(json(success("runner-jobs", result)))
    expect(output.result.errors).toEqual([{ repo: "example/project", endpoint: "GET /repos/{owner}/{repo}/actions/runs", status: 500, code: "request_failed", message: "GET /repos/{owner}/{repo}/actions/runs: HTTP 500" }])
    expect(JSON.stringify(output)).not.toContain(token)
  })

  test("gives each page a fresh timeout signal", async () => {
    const gh = github((url) => url.pathname === runPath ? { body: { workflow_runs: [{ id: 1 }] } } : { body: { jobs: [] } })
    await listRunnerJobs(gh.octokit, input)
    expect(gh.signals.length).toBe(3)
    expect(gh.signals.every((signal) => signal instanceof AbortSignal)).toBe(true)
    expect(new Set(gh.signals).size).toBe(3)
  })

  test("a hung request times out per repo and other repos continue", async () => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal)
    let deadlines = 0
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      expect(ms).toBe(10_000)
      // Exercise the abort path without waiting ten real seconds.
      return deadlines++ === 0 ? AbortSignal.abort(new DOMException("fixture deadline", "TimeoutError")) : realTimeout(ms)
    })
    try {
      const gh = github((url) => url.pathname.includes("/one/") ? new Promise<Reply>(() => {}) : { body: { workflow_runs: [] } })
      const result = await listRunnerJobs(gh.octokit, { ...input, repos: ["example/one", "example/two"] })
      expect(gh.calls.filter((route) => route.includes("/two/"))).toHaveLength(2)
      expect(result.errors).toHaveLength(1)
      for (const error of result.errors) expect(error).toMatchObject({ endpoint: "GET /repos/{owner}/{repo}/actions/runs", status: null, code: "timeout", message: "GET /repos/{owner}/{repo}/actions/runs: request timed out after 10000 ms." })
    } finally { timeout.mockRestore() }
  })

  test("runs four repo reads concurrently, then drains remaining repos", async () => {
    let active = 0
    let peak = 0
    const gates: (() => void)[] = []
    let firstFour!: () => void
    const ready = new Promise<void>((resolve) => { firstFour = resolve })
    const gh = github(async () => {
      active++
      peak = Math.max(peak, active)
      if (gates.length < 4) {
        const gate = new Promise<void>((resolve) => { gates.push(resolve) })
        if (gates.length === 4) firstFour()
        await gate
      }
      active--
      return { body: { workflow_runs: [] } }
    })
    const result = listRunnerJobs(gh.octokit, { org: "example", repos: Array.from({ length: 9 }, (_, i) => `example/project-${i}`) })
    await ready
    expect(gh.calls).toHaveLength(4)
    for (const release of gates) release()
    expect((await result).errors).toEqual([])
    expect(peak).toBe(4)
    expect(gh.calls).toHaveLength(18)
    onlyGets(gh.calls)
  })
})
