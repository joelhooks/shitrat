import { Octokit } from "@octokit/rest"
import { describe, expect, test } from "bun:test"
import { ensureRunnerGroup, listOrgRunners, registrationToken } from "../src/org-runners.js"

const repo = { id: 42, full_name: "example/project", private: true }
const group = { id: 7, name: "isolated", visibility: "selected", allows_public_repositories: false }
const runner = { id: 10, name: "ci-1", status: "online", busy: false, labels: [{ name: "linux" }] }
type Reply = { body?: unknown; status?: number; headers?: Record<string, string> }
const github = (routes: Record<string, Reply>) => {
  const calls: { route: string; body: unknown }[] = []
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    const route = `${init?.method ?? "GET"} ${url.pathname}${url.search}`
    calls.push({ route, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const reply = routes[route] ?? { status: 404, body: { message: "Unexpected route" } }
    const response = new Response(reply.status === 204 ? null : JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: { "content-type": "application/json", "x-ratelimit-remaining": "4999", ...reply.headers } })
    Object.defineProperty(response, "url", { value: url.href })
    return response
  }
  return { octokit: new Octokit({ request: { fetch }, log: { debug() {}, info() {}, warn() {}, error() {} } }), calls }
}
const groupsRoute = "GET /orgs/example/actions/runner-groups?per_page=100"
const groupRoute = "/orgs/example/actions/runner-groups/7"
const base = (existing: boolean): Record<string, Reply> => ({
  "GET /repos/example/project": { body: repo },
  [groupsRoute]: { body: { total_count: existing ? 1 : 0, runner_groups: existing ? [group] : [] } },
  "POST /orgs/example/actions/runner-groups": { body: group, status: 201 },
  [`PATCH ${groupRoute}`]: { body: group },
  [`PUT ${groupRoute}/repositories`]: { status: 204 },
  [`GET ${groupRoute}`]: { body: group },
  [`GET ${groupRoute}/repositories?per_page=100`]: { body: { total_count: 1, repositories: [repo] } },
})
const input = { org: "example", name: "isolated", repo: "example/project", dryRun: false }
const writes = (calls: ReturnType<typeof github>["calls"]) => calls.filter(({ route }) => !route.startsWith("GET "))

describe("runner-group", () => {
  test("creates selected-only, public-disabled access with exactly one repo id and verifies it", async () => {
    const gh = github(base(false))
    expect(await ensureRunnerGroup(gh.octokit, input)).toMatchObject({ id: 7, name: "isolated", visibility: "selected", allows_public_repositories: false, repositories: [{ id: 42, full_name: "example/project" }] })
    expect(writes(gh.calls)).toEqual([{ route: "POST /orgs/example/actions/runner-groups", body: { name: "isolated", visibility: "selected", allows_public_repositories: false, selected_repository_ids: [42] } }])
  })
  test("updates an existing broad group and replaces, not appends, its repository access", async () => {
    const routes = base(true)
    routes[groupsRoute] = { body: { total_count: 1, runner_groups: [{ ...group, visibility: "all", allows_public_repositories: true }] } }
    const gh = github(routes)
    await ensureRunnerGroup(gh.octokit, input)
    expect(writes(gh.calls)).toEqual([
      { route: `PATCH ${groupRoute}`, body: { name: "isolated", visibility: "selected", allows_public_repositories: false } },
      { route: `PUT ${groupRoute}/repositories`, body: { selected_repository_ids: [42] } },
    ])
  })
  for (const existing of [true, false]) test(`dry-run ${existing ? "update" : "create"} reads but never writes`, async () => {
    const gh = github(base(existing))
    expect(await ensureRunnerGroup(gh.octokit, { ...input, dryRun: true })).toMatchObject({ dry_run: true, action: existing ? "update" : "create", visibility: "selected", allows_public_repositories: false, selected_repository_ids: [42] })
    expect(writes(gh.calls)).toEqual([])
  })
  test("follows pagination before deciding a group is missing", async () => {
    const routes = base(true)
    routes[groupsRoute] = { body: { total_count: 1, runner_groups: [] }, headers: { link: '<https://api.github.com/orgs/example/actions/runner-groups?per_page=100&page=2>; rel="next"' } }
    routes[`${groupsRoute}&page=2`] = { body: { total_count: 1, runner_groups: [group] } }
    const gh = github(routes)
    expect(await ensureRunnerGroup(gh.octokit, { ...input, dryRun: true })).toMatchObject({ action: "update", id: 7 })
  })
  test("refuses public and cross-org repositories without mutations", async () => {
    const gh = github({ ...base(false), "GET /repos/example/project": { body: { ...repo, private: false } } })
    await expect(ensureRunnerGroup(gh.octokit, input)).rejects.toThrow("public repository refused")
    await expect(ensureRunnerGroup(gh.octokit, { ...input, repo: "elsewhere/project" })).rejects.toThrow("repository must belong")
    expect(writes(gh.calls)).toEqual([])
  })
  test("a readback with extra repos is not reported as success", async () => {
    const gh = github({ ...base(true), [`GET ${groupRoute}/repositories?per_page=100`]: { body: { total_count: 2, repositories: [repo, { ...repo, id: 99 }] } } })
    await expect(ensureRunnerGroup(gh.octokit, input)).rejects.toThrow("policy readback mismatch")
  })
  test("403 stops at the endpoint and reports required permission without reflecting errors", async () => {
    const gh = github({ ...base(false), "POST /orgs/example/actions/runner-groups": { status: 403, body: { message: "sensitive response" } } })
    const error = await ensureRunnerGroup(gh.octokit, input).catch((error: unknown) => error)
    expect(error).toMatchObject({ status: 403, endpoint: "POST /orgs/{org}/actions/runner-groups" })
    expect(String(error)).toContain("organization_self_hosted_runners: write")
    expect(String(error)).not.toContain("sensitive response")
    expect(writes(gh.calls)).toHaveLength(1)
  })
})

describe("runners", () => {
  const routes = {
    [groupsRoute]: { body: { total_count: 1, runner_groups: [group] } },
    [`GET ${groupRoute}/runners?per_page=100`]: { body: { total_count: 1, runners: [runner] } },
    "GET /orgs/example/actions/runners?per_page=100": { body: { total_count: 2, runners: [runner, { ...runner, id: 11, name: "ci-2", status: "offline", busy: true }] } },
  }
  test("lists safe runner fields with group membership, including unassigned runners", async () => {
    const gh = github(routes)
    expect(await listOrgRunners(gh.octokit, "example")).toEqual([
      { id: 10, name: "ci-1", status: "online", busy: false, labels: ["linux"], group: { id: 7, name: "isolated" } },
      { id: 11, name: "ci-2", status: "offline", busy: true, labels: ["linux"], group: null },
    ])
    expect(writes(gh.calls)).toEqual([])
  })
  test("filters to the named group and refuses an unknown group", async () => {
    const gh = github(routes)
    expect(await listOrgRunners(gh.octokit, "example", "isolated")).toHaveLength(1)
    await expect(listOrgRunners(gh.octokit, "example", "missing")).rejects.toThrow("not found")
    expect(writes(gh.calls)).toEqual([])
  })
})

test("registration token accepts GitHub's documented token alphabet", async () => {
  // Public example from GitHub's registration-token documentation, not a credential.
  const token = "LLBF3JGZDX3P5PMEXLND6TS6FCWO6"
  const expires_at = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const gh = github({ "POST /orgs/example/actions/runners/registration-token": { body: { token, expires_at } } })
  expect(await registrationToken(gh.octokit, "example")).toEqual({ token, expires_at })
})

test("registration token rejects invalid token syntax without including it in errors", async () => {
  const gh = github({ "POST /orgs/example/actions/runners/registration-token": { body: { token: "bad\nsecret", expires_at: "2026-10-17T20:00:00Z" } } })
  await expect(registrationToken(gh.octokit, "example")).rejects.toThrow("response validation")
})
