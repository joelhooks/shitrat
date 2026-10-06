import { Octokit } from "@octokit/rest"
import { describe, expect, test } from "bun:test"
import { ACTIONS_READ_MISSING, CiReadError, readChecks, readJobLog, readPullRequestStatus } from "../src/ci-reads.js"

const ref = { owner: "o", repo: "r" }
const SHA = "0123456789abcdef0123456789abcdef01234567"
const API = "https://api.github.com"

type Reply = { status?: number; body?: unknown; text?: string; headers?: Record<string, string> }

// A GitHub stand-in at the fetch boundary: routes match method, path and the query octokit sends.
const github = (routes: Record<string, Reply>) => {
  const requests: string[] = []
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    const key = `${init?.method ?? "GET"} ${url.pathname}${url.search}`
    requests.push(key)
    const reply = routes[key] ?? { status: 404, body: { message: "Not Found" } }
    const headers = { "x-ratelimit-remaining": "4999", ...reply.headers }
    const response =
      reply.text !== undefined
        ? new Response(reply.text, { status: reply.status ?? 200, headers: { "content-type": "text/plain", ...headers } })
        : new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { "content-type": "application/json", ...headers } })
    // Real fetch sets url; octokit's paginator parses it.
    Object.defineProperty(response, "url", { value: url.href })
    return response
  }
  const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  return { octokit: new Octokit({ request: { fetch }, log: quiet }), requests }
}

const nextPage = (path: string) => ({ link: `<${API}${path}>; rel="next"` })

const checkRun = (id: number, name: string, status: string, conclusion: string | null, app = "github-actions") => ({
  id,
  name,
  status,
  conclusion,
  html_url: `https://github.com/o/r/runs/${id}`,
  app: { slug: app },
})

const combined = (statuses: { context: string; state: string }[], totalCount = statuses.length, state = "success") => ({
  sha: SHA,
  state,
  total_count: totalCount,
  url: `${API}/repos/o/r/commits/${SHA}/status`,
  statuses: statuses.map((status) => ({ ...status, description: `${status.context} said ${status.state}`, target_url: null })),
})

const checksRoutes = (runs: ReturnType<typeof checkRun>[], statuses: { context: string; state: string }[] = [], sha = SHA): Record<string, Reply> => ({
  [`GET /repos/o/r/commits/${sha}/check-runs?per_page=100`]: { body: { total_count: runs.length, check_runs: runs } },
  [`GET /repos/o/r/commits/${sha}/status?per_page=100&page=1`]: { body: combined(statuses) },
})

const forbidden: Reply = { status: 403, body: { message: "Resource not accessible by integration" } }

describe("checks", () => {
  test("reads check runs and the combined status and summarizes them", async () => {
    const gh = github(
      checksRoutes(
        [checkRun(1, "build", "completed", "success"), checkRun(2, "test", "completed", "failure"), checkRun(3, "e2e", "in_progress", null)],
        [{ context: "gavel/hold", state: "success" }],
      ),
    )
    const result = await readChecks(gh.octokit, ref, SHA)
    expect(result.sha).toBe(SHA)
    expect(result.check_runs).toEqual([
      { id: 1, name: "build", status: "completed", conclusion: "success", html_url: "https://github.com/o/r/runs/1", app: "github-actions" },
      { id: 2, name: "test", status: "completed", conclusion: "failure", html_url: "https://github.com/o/r/runs/2", app: "github-actions" },
      { id: 3, name: "e2e", status: "in_progress", conclusion: null, html_url: "https://github.com/o/r/runs/3", app: "github-actions" },
    ])
    expect(result.combined_status).toEqual({
      state: "success",
      total: 1,
      statuses: [{ context: "gavel/hold", state: "success", description: "gavel/hold said success", target_url: null }],
    })
    expect(result.summary).toEqual({
      verdict: "failure",
      total: 4,
      check_runs_by_conclusion: { success: 1, failure: 1, in_progress: 1 },
      statuses_by_state: { success: 1 },
      failing: ["test"],
      pending: ["e2e"],
    })
  })

  test("follows every page of check runs and statuses", async () => {
    const runs = Array.from({ length: 101 }, (_, index) => checkRun(index + 1, `job-${index + 1}`, "completed", "success"))
    const statuses = Array.from({ length: 101 }, (_, index) => ({ context: `ctx-${index + 1}`, state: index === 100 ? "error" : "success" }))
    const gh = github({
      [`GET /repos/o/r/commits/${SHA}/check-runs?per_page=100`]: {
        body: { total_count: 101, check_runs: runs.slice(0, 100) },
        headers: nextPage(`/repos/o/r/commits/${SHA}/check-runs?per_page=100&page=2`),
      },
      [`GET /repos/o/r/commits/${SHA}/check-runs?per_page=100&page=2`]: { body: { total_count: 101, check_runs: runs.slice(100) } },
      [`GET /repos/o/r/commits/${SHA}/status?per_page=100&page=1`]: { body: combined(statuses.slice(0, 100), 101, "failure") },
      [`GET /repos/o/r/commits/${SHA}/status?per_page=100&page=2`]: { body: combined(statuses.slice(100), 101, "failure") },
    })
    const result = await readChecks(gh.octokit, ref, SHA)
    expect(result.check_runs).toHaveLength(101)
    expect(result.check_runs.at(-1)?.name).toBe("job-101")
    expect(result.combined_status.total).toBe(101)
    expect(result.summary).toMatchObject({ verdict: "failure", total: 202, failing: ["ctx-101"] })
  })

  test("a commit with nothing reported has verdict none, not GitHub's empty pending", async () => {
    const gh = github({
      [`GET /repos/o/r/commits/${SHA}/check-runs?per_page=100`]: { body: { total_count: 0, check_runs: [] } },
      [`GET /repos/o/r/commits/${SHA}/status?per_page=100&page=1`]: { body: combined([], 0, "pending") },
    })
    expect((await readChecks(gh.octokit, ref, SHA)).summary.verdict).toBe("none")
  })

  test("an unknown sha is a typed NOT_FOUND", async () => {
    const gh = github({})
    const error = await readChecks(gh.octokit, ref, "deadbeef").catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CiReadError)
    expect(error).toMatchObject({ code: "NOT_FOUND", status: 404 })
    expect((error as Error).message).toContain("deadbeef is not a commit, branch or tag in o/r")
  })

  test("GitHub's 422 for a sha with no commit is NOT_FOUND too", async () => {
    const gh = github({
      "GET /repos/o/r/commits/deadbeef/check-runs?per_page=100": { status: 422, body: { message: "No commit found for SHA: deadbeef" } },
    })
    await expect(readChecks(gh.octokit, ref, "deadbeef")).rejects.toMatchObject({ code: "NOT_FOUND", status: 422 })
  })

  test("a 403 with no rate limit left is RATE_LIMITED, not a permission problem", async () => {
    const gh = github({
      [`GET /repos/o/r/commits/${SHA}/check-runs?per_page=100`]: {
        status: 403,
        body: { message: "API rate limit exceeded for installation" },
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1791244800" },
      },
    })
    await expect(readChecks(gh.octokit, ref, SHA)).rejects.toMatchObject({ code: "RATE_LIMITED", status: 403 })
  })

  test("a 403 permission refusal is PERMISSION_DENIED", async () => {
    const gh = github({ [`GET /repos/o/r/commits/${SHA}/check-runs?per_page=100`]: forbidden })
    await expect(readChecks(gh.octokit, ref, SHA)).rejects.toMatchObject({ code: "PERMISSION_DENIED" })
  })
})

const pull = {
  number: 7,
  html_url: "https://github.com/o/r/pull/7",
  title: "feat: things",
  state: "open",
  merged: false,
  draft: false,
  mergeable: true,
  mergeable_state: "blocked",
  head: { sha: SHA, ref: "worker/things" },
  base: { ref: "main" },
  labels: [{ name: "NO MERGE" }, { name: "ready" }],
}

describe("pr-status", () => {
  test("reads the pull request and summarizes checks on its head sha", async () => {
    const gh = github({
      "GET /repos/o/r/pulls/7": { body: pull },
      ...checksRoutes(
        [checkRun(11, "build", "completed", "success"), checkRun(12, "test", "completed", "timed_out"), checkRun(13, "lint", "completed", "skipped")],
        [{ context: "gavel/hold", state: "failure" }],
      ),
    })
    const result = await readPullRequestStatus(gh.octokit, ref, 7)
    expect(result).toMatchObject({
      number: 7,
      draft: false,
      mergeable: true,
      mergeable_state: "blocked",
      head: { sha: SHA, ref: "worker/things" },
      labels: ["NO MERGE", "ready"],
      checks: {
        sha: SHA,
        verdict: "failure",
        check_runs_by_conclusion: { success: 1, timed_out: 1, skipped: 1 },
        failing: ["test", "gavel/hold"],
        failing_runs: [{ id: 12, name: "test", conclusion: "timed_out", html_url: "https://github.com/o/r/runs/12", app: "github-actions" }],
      },
    })
    expect(gh.requests[0]).toBe("GET /repos/o/r/pulls/7")
  })

  test("reports mergeable null while GitHub is still computing it", async () => {
    const gh = github({ "GET /repos/o/r/pulls/7": { body: { ...pull, mergeable: null, mergeable_state: "unknown" } }, ...checksRoutes([]) })
    expect(await readPullRequestStatus(gh.octokit, ref, 7)).toMatchObject({ mergeable: null, checks: { verdict: "none" } })
  })

  test("a missing pull request is a typed NOT_FOUND", async () => {
    const gh = github({})
    await expect(readPullRequestStatus(gh.octokit, ref, 404)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("Pull request #404 does not exist in o/r"),
    })
  })
})

const job = {
  id: 9,
  run_id: 5,
  name: "test",
  status: "completed",
  conclusion: "failure",
  html_url: "https://github.com/o/r/actions/runs/5/job/9",
  head_sha: SHA,
  steps: [
    { number: 1, name: "checkout", status: "completed", conclusion: "success" },
    { number: 2, name: "pnpm test", status: "completed", conclusion: "failure" },
  ],
}

describe("run-log", () => {
  test("reads the job and the tail of its log", async () => {
    const gh = github({
      "GET /repos/o/r/actions/jobs/9": { body: job },
      "GET /repos/o/r/actions/jobs/9/logs": { text: "line 1\nline 2\nline 3\nline 4\n" },
    })
    const result = await readJobLog(gh.octokit, ref, 9, 2)
    expect(result).toMatchObject({
      job_id: 9,
      run_id: 5,
      conclusion: "failure",
      failed_steps: [{ number: 2, name: "pnpm test", conclusion: "failure" }],
      total_lines: 4,
      returned_lines: 2,
      truncated: true,
      log: "line 3\nline 4",
    })
  })

  test("--tail 0 returns the whole log", async () => {
    const gh = github({
      "GET /repos/o/r/actions/jobs/9": { body: job },
      "GET /repos/o/r/actions/jobs/9/logs": { text: "a\nb" },
    })
    expect(await readJobLog(gh.octokit, ref, 9, 0)).toMatchObject({ log: "a\nb", truncated: false, total_lines: 2 })
  })

  test("a 403 says the app needs Actions: read, and nothing else is tried", async () => {
    const gh = github({ "GET /repos/o/r/actions/jobs/9": forbidden })
    const error = await readJobLog(gh.octokit, ref, 9, 300).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: "PERMISSION_DENIED", status: 403 })
    expect((error as Error).message).toStartWith(ACTIONS_READ_MISSING)
    expect(gh.requests).toEqual(["GET /repos/o/r/actions/jobs/9"])
  })

  test("a 403 on the log download itself is the same permission error", async () => {
    const gh = github({ "GET /repos/o/r/actions/jobs/9": { body: job }, "GET /repos/o/r/actions/jobs/9/logs": forbidden })
    await expect(readJobLog(gh.octokit, ref, 9, 300)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      message: expect.stringContaining(ACTIONS_READ_MISSING),
    })
  })

  test("an unknown job is a typed NOT_FOUND", async () => {
    const gh = github({})
    await expect(readJobLog(gh.octokit, ref, 404, 300)).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  test.each([
    ["a non-positive job id", 0, 300],
    ["a negative tail", 9, -1],
  ])("refuses %s before calling GitHub", async (_name, jobId, tail) => {
    const gh = github({})
    await expect(readJobLog(gh.octokit, ref, jobId, tail)).rejects.toMatchObject({ code: "INVALID_INPUT" })
    expect(gh.requests).toEqual([])
  })
})
