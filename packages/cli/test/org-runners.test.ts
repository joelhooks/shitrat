import { Octokit } from "@octokit/rest"
import { describe, expect, test } from "bun:test"
import { ensureRunnerGroup, listOrgRunners, listRunnerGroups, registrationToken, RunnerApiError } from "../src/org-runners.js"

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

const workflow = "example/project/.github/workflows/deploy.yml@refs/heads/main"
const taggedWorkflow = "example/project/.github/workflows/test.yaml@refs/tags/v1.0"
const workflowRoutes = (existing: boolean, selected_workflows = [workflow]): Record<string, Reply> => ({
  ...base(existing),
  [`GET ${groupRoute}`]: { body: { ...group, restricted_to_workflows: true, selected_workflows } },
})

describe("runner-group workflow restrictions", () => {
  for (const existing of [false, true]) test(`sends and verifies workflow policy on ${existing ? "update" : "create"}`, async () => {
    const gh = github(workflowRoutes(existing))
    expect(await ensureRunnerGroup(gh.octokit, { ...input, workflows: [workflow] })).toMatchObject({ restricted_to_workflows: true, selected_workflows: [workflow] })
    expect(writes(gh.calls)[0]?.body).toEqual({ name: "isolated", visibility: "selected", allows_public_repositories: false, ...(existing ? {} : { selected_repository_ids: [42] }), restricted_to_workflows: true, selected_workflows: [workflow] })
  })
  test("readback compares an exact order-insensitive workflow set", async () => {
    const gh = github(workflowRoutes(true, [taggedWorkflow, workflow]))
    await ensureRunnerGroup(gh.octokit, { ...input, workflows: [workflow, taggedWorkflow, workflow] })
    expect(writes(gh.calls)[0]?.body).toMatchObject({ selected_workflows: [workflow, taggedWorkflow] })
  })
  for (const selected_workflows of [[], [taggedWorkflow], [workflow, taggedWorkflow], [workflow, workflow], undefined]) test(`rejects workflow readback mismatch ${JSON.stringify(selected_workflows)}`, async () => {
    const gh = github({ ...base(true), [`GET ${groupRoute}`]: { body: { ...group, restricted_to_workflows: true, selected_workflows } } })
    await expect(ensureRunnerGroup(gh.octokit, { ...input, workflows: [workflow] })).rejects.toBeInstanceOf(RunnerApiError)
    await expect(ensureRunnerGroup(gh.octokit, { ...input, workflows: [workflow] })).rejects.toThrow("readback mismatch")
  })
  test("rejects a workflow policy that was not enabled", async () => {
    const gh = github({ ...base(true), [`GET ${groupRoute}`]: { body: { ...group, restricted_to_workflows: false, selected_workflows: [workflow] } } })
    await expect(ensureRunnerGroup(gh.octokit, { ...input, workflows: [workflow] })).rejects.toThrow("readback mismatch")
  })
  for (const bad of [
    "example/project/.github/workflows/deploy.yml@main",
    "example/project/.github/workflows/deploy.yml@0123456789abcdef0123456789abcdef01234567",
    "example/project/.github/workflows/*.yml@refs/heads/main",
    "example/project/.github/workflows/deploy.yml@refs/heads/*",
    "example/project/.github/workflows/deploy.yml@refs/pull/1/merge",
    "elsewhere/project/.github/workflows/deploy.yml@refs/heads/main",
    "example/project/workflows/deploy.yml@refs/heads/main",
    "example/project/.github/workflows/deploy.json@refs/heads/main",
    "example/project/.github/workflows/deploy.yml@refs/heads/",
    "example/project/.github/workflows/deploy.yml@refs/heads/a..b",
    "example/project/.github/workflows/deploy.yml@refs/heads/a b",
  ]) test(`refuses workflow shape ${bad} before any HTTP`, async () => {
    const gh = github({})
    await expect(ensureRunnerGroup(gh.octokit, { ...input, workflows: [bad] })).rejects.toThrow("invalid --workflow")
    expect(gh.calls).toEqual([])
  })
  test("workflow and all-workflows are mutually exclusive before HTTP", async () => {
    const gh = github({})
    await expect(ensureRunnerGroup(gh.octokit, { ...input, workflows: [workflow], allWorkflows: true })).rejects.toThrow("mutually exclusive")
    expect(gh.calls).toEqual([])
  })
  for (const existing of [false, true]) test(`all-workflows sends and verifies false on ${existing ? "update" : "create"}`, async () => {
    const routes = { ...base(existing), [`GET ${groupRoute}`]: { body: { ...group, restricted_to_workflows: false, selected_workflows: [] } } }
    const gh = github(routes)
    expect(await ensureRunnerGroup(gh.octokit, { ...input, allWorkflows: true })).toMatchObject({ restricted_to_workflows: false })
    expect(writes(gh.calls)[0]?.body).toMatchObject({ restricted_to_workflows: false })
    expect(writes(gh.calls)[0]?.body).not.toHaveProperty("selected_workflows")
    routes[`GET ${groupRoute}`] = { body: { ...group, restricted_to_workflows: true, selected_workflows: [] } }
    await expect(ensureRunnerGroup(github(routes).octokit, { ...input, allWorkflows: true })).rejects.toThrow("readback mismatch")
  })
  for (const existing of [false, true]) test(`no flags preserve payload and result shape on ${existing ? "update" : "create"}`, async () => {
    const gh = github(workflowRoutes(existing))
    const result = await ensureRunnerGroup(gh.octokit, input)
    expect(result).not.toHaveProperty("restricted_to_workflows")
    for (const call of writes(gh.calls)) {
      expect(call.body).not.toHaveProperty("restricted_to_workflows")
      expect(call.body).not.toHaveProperty("selected_workflows")
    }
  })
  for (const existing of [false, true]) test(`dry-run reports workflow policy without writes (${existing})`, async () => {
    const gh = github(base(existing))
    expect(await ensureRunnerGroup(gh.octokit, { ...input, workflows: [workflow], dryRun: true })).toMatchObject({ restricted_to_workflows: true, selected_workflows: [workflow] })
    expect(await ensureRunnerGroup(gh.octokit, { ...input, allWorkflows: true, dryRun: true })).toMatchObject({ restricted_to_workflows: false })
    expect(writes(gh.calls)).toEqual([])
  })
  for (const status of [403, 422]) for (const existing of [false, true]) test(`HTTP ${status} refuses ${existing ? "update" : "create"} without retry or fallback`, async () => {
    const endpoint = existing ? `PATCH ${groupRoute}` : "POST /orgs/example/actions/runner-groups"
    const gh = github({ ...workflowRoutes(existing), [endpoint]: { status, body: { message: "sensitive fixture response" } } })
    const error = await ensureRunnerGroup(gh.octokit, { ...input, workflows: [workflow] }).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(RunnerApiError)
    expect(String(error)).toContain(`HTTP ${status}`)
    expect(String(error)).toContain(existing ? "PATCH /orgs/{org}/actions/runner-groups/{runner_group_id}" : "POST /orgs/{org}/actions/runner-groups")
    expect(String(error)).toContain("workflow restriction not available for this group or plan")
    expect(String(error)).not.toContain("sensitive fixture response")
    expect(writes(gh.calls)).toHaveLength(1)
  })
  for (const stage of ["list", "write", "readback"]) test(`read-only workflow restriction refuses at ${stage}`, async () => {
    const routes = workflowRoutes(true)
    const locked = { ...group, workflow_restrictions_read_only: true }
    if (stage === "list") routes[groupsRoute] = { body: { total_count: 1, runner_groups: [locked] } }
    if (stage === "write") routes[`PATCH ${groupRoute}`] = { body: locked }
    if (stage === "readback") routes[`GET ${groupRoute}`] = { body: locked }
    const gh = github(routes)
    const error = await ensureRunnerGroup(gh.octokit, { ...input, workflows: [workflow] }).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(RunnerApiError)
    expect(String(error)).toContain("HTTP 200")
    expect(String(error)).toContain("workflow restriction not available for this group or plan")
    expect(writes(gh.calls)).toHaveLength(stage === "list" ? 0 : stage === "write" ? 1 : 2)
  })
})

describe("runner command adapters", () => {
  // Isolate module mocks in a child, with only fake HTTP and no credentials.
  const run = async (command: "runner-group" | "runner-groups", args: string[], routes = base(true)) => {
    const script = `
      import { mock } from "bun:test";
      import { Octokit } from "@octokit/rest";
      import { Command } from "@effect/cli";
      import { Effect } from "effect";
      const real = await import("./src/org-runners.ts");
      const github = ${github.toString()};
      const gh = github(${JSON.stringify(routes)});
      globalThis.fetch = () => { throw new Error("live HTTP forbidden"); };
      mock.module("./src/org-runners.ts", () => ({ ...real, createOrgOctokit: () => Effect.succeed(gh.octokit) }));
      const commands = await import("./src/commands/runners.ts");
      const cmd = commands.${command === "runner-group" ? "runnerGroupCmd" : "runnerGroupsCmd"};
      await Effect.runPromise(Command.run(cmd, { name: "test", version: "0" })(["bun", "test", ...${JSON.stringify(args)}]));
      console.error(JSON.stringify(gh.calls));
    `
    const child = Bun.spawn([process.execPath, "--eval", script], { cwd: new URL("..", import.meta.url).pathname, env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { stdout, stderr, exitCode }
  }
  test("repeatable --workflow reaches dry-run policy and --all-workflows undoes it", async () => {
    const args = ["--org", "example", "--name", "isolated", "--repo", "example/project", "--dry-run"]
    const restricted = await run("runner-group", [...args, "--workflow", workflow, "--workflow", taggedWorkflow])
    expect(restricted.exitCode).toBe(0)
    expect(JSON.parse(restricted.stdout).result).toMatchObject({ restricted_to_workflows: true, selected_workflows: [workflow, taggedWorkflow] })
    const all = await run("runner-group", [...args, "--all-workflows"])
    expect(all.exitCode).toBe(0)
    expect(JSON.parse(all.stdout).result).toMatchObject({ restricted_to_workflows: false })
    const conflict = await run("runner-group", [...args, "--workflow", workflow, "--all-workflows"])
    expect(conflict.exitCode).toBe(1)
    expect(conflict.stdout).toContain("mutually exclusive")
    expect(conflict.stderr.trim()).toBe("[]")
  })
  test("runner-groups parses the name filter and missing names fail", async () => {
    const result = await run("runner-groups", ["--org", "example", "--name", "isolated"])
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout).result).toMatchObject({ count: 1, groups: [{ id: 7, repositories: ["example/project"] }] })
    const missing = await run("runner-groups", ["--org", "example", "--name", "missing"])
    expect(missing.exitCode).toBe(1)
    expect(JSON.parse(missing.stdout).ok).toBe(false)
  })
})

describe("runner-groups read", () => {
  test("returns policy and full repository names across both paginated collections without writes", async () => {
    const policy = { ...group, default: false, restricted_to_workflows: true, selected_workflows: [workflow], workflow_restrictions_read_only: false }
    const gh = github({
      [groupsRoute]: { body: { total_count: 1, runner_groups: [] }, headers: { link: '<https://api.github.com/orgs/example/actions/runner-groups?per_page=100&page=2>; rel="next"' } },
      [`${groupsRoute}&page=2`]: { body: { total_count: 1, runner_groups: [policy] } },
      [`GET ${groupRoute}/repositories?per_page=100`]: { body: { total_count: 2, repositories: [repo] }, headers: { link: '<https://api.github.com/orgs/example/actions/runner-groups/7/repositories?per_page=100&page=2>; rel="next"' } },
      [`GET ${groupRoute}/repositories?per_page=100&page=2`]: { body: { total_count: 2, repositories: [{ ...repo, full_name: "example/another" }] } },
    })
    expect(await listRunnerGroups(gh.octokit, "example", "isolated")).toEqual([{ ...policy, repositories: ["example/project", "example/another"] }])
    expect(writes(gh.calls)).toEqual([])
    expect(gh.calls).toHaveLength(4)
  })
  test("lists all groups or only a named group, and refuses missing or ambiguous names", async () => {
    const gh = github({ ...base(true), [groupsRoute]: { body: { total_count: 2, runner_groups: [group, { ...group, id: 8, name: "other" }] } }, "GET /orgs/example/actions/runner-groups/8/repositories?per_page=100": { body: { total_count: 0, repositories: [] } } })
    expect(await listRunnerGroups(gh.octokit, "example")).toHaveLength(2)
    expect(await listRunnerGroups(gh.octokit, "example", "isolated")).toHaveLength(1)
    await expect(listRunnerGroups(gh.octokit, "example", "missing")).rejects.toThrow("not found")
    const duplicate = github({ [groupsRoute]: { body: { total_count: 2, runner_groups: [group, group] } } })
    await expect(listRunnerGroups(duplicate.octokit, "example", "isolated")).rejects.toThrow("ambiguous")
    expect(writes(gh.calls)).toEqual([])
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
