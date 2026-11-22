import { Octokit } from "@octokit/rest"
import { describe, expect, test } from "bun:test"
import { changeVariable, listVariables, variableScope } from "../src/actions-variables.js"
import { addRunnerToGroup, changeRunnerGroup, getRunnerGroup } from "../src/org-runners.js"

type Reply = { body?: unknown; status?: number; headers?: Record<string, string> }
const github = (routes: Record<string, Reply | Reply[]>) => {
  const calls: { route: string; body?: unknown }[] = []
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    const route = `${init?.method ?? "GET"} ${url.pathname}${url.search}`
    calls.push(init?.body ? { route, body: JSON.parse(String(init.body)) } : { route })
    const replies = routes[route]
    const reply = (Array.isArray(replies) ? replies.shift() : replies) ?? { status: 404, body: { message: "Unexpected fixture route" } }
    const response = new Response(reply.status === 204 ? null : JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: { "content-type": "application/json", ...reply.headers } })
    Object.defineProperty(response, "url", { value: url.href })
    return response
  }
  return { octokit: new Octokit({ request: { fetch }, log: { debug() {}, info() {}, warn() {}, error() {} } }), calls }
}

const org = "example"
const repoPath = "/repos/example/project/actions/variables"
const orgPath = "/orgs/example/actions/variables"
const variable = { name: "CI_ROUTE", value: "build", updated_at: "2026-11-22T20:00:00Z" }
const variableList = (variables: unknown[]) => ({ body: { total_count: variables.length, variables } })
const repoList = `GET ${repoPath}?per_page=100`
const orgList = `GET ${orgPath}?per_page=100`
const noContent = { status: 204 }

describe("Actions variables", () => {
  test("lists every page and projects name, value and updated_at", async () => {
    const second = { ...variable, name: "CI_HEAVY" }
    const gh = github({
      [repoList]: { ...variableList([{ ...variable, created_at: "unused" }]), headers: { link: `<https://api.github.com${repoPath}?per_page=100&page=2>; rel="next"` } },
      [`${repoList}&page=2`]: variableList([second]),
    })
    expect(await listVariables(gh.octokit, variableScope(undefined, "example/project"))).toEqual([variable, second])
  })

  test("shows existing value and exact patch or delete request without writing", async () => {
    const gh = github({ [repoList]: variableList([variable]) })
    const scope = variableScope(undefined, "example/project")
    expect(await changeVariable(gh.octokit, { scope, change: { action: "set", name: "ci_route", value: "new" } })).toMatchObject({
      dry_run: true, before: variable, request: { method: "PATCH", endpoint: `${repoPath}/CI_ROUTE`, body: { value: "new" } },
    })
    expect(await changeVariable(gh.octokit, { scope, change: { action: "delete", name: variable.name } })).toMatchObject({
      dry_run: true, before: variable, request: { method: "DELETE", endpoint: `${repoPath}/CI_ROUTE` },
    })
    expect(gh.calls.map(({ route }) => route)).toEqual([repoList, repoList])
  })

  test("creates an org variable for private repos only and verifies with a fresh read", async () => {
    const gh = github({ [orgList]: [variableList([]), variableList([variable])], [`POST ${orgPath}`]: { status: 201 } })
    const scope = variableScope(org, undefined)
    const receipt = await changeVariable(gh.octokit, { scope, change: { action: "set", name: variable.name, value: variable.value }, yes: true })
    expect(receipt).toMatchObject({ dry_run: false, before: null, after: variable })
    expect(gh.calls).toEqual([
      { route: orgList }, { route: `POST ${orgPath}`, body: { name: variable.name, value: variable.value, visibility: "private" } }, { route: orgList },
    ])
  })

  test("keeps org visibility on update and refuses a value mismatch", async () => {
    const gh = github({ [orgList]: variableList([{ ...variable, visibility: "selected" }]), [`PATCH ${orgPath}/${variable.name}`]: noContent })
    await expect(changeVariable(gh.octokit, { scope: variableScope(org, undefined), change: { action: "set", name: variable.name, value: "unseen" }, yes: true })).rejects.toThrow("readback mismatch")
    expect(gh.calls).toEqual([{ route: orgList }, { route: `PATCH ${orgPath}/${variable.name}`, body: { value: "unseen" } }, { route: orgList }])
  })

  test("deletes an existing repo variable, then proves absence without treating 404 as proof", async () => {
    const gh = github({ [repoList]: [variableList([variable]), variableList([])], [`DELETE ${repoPath}/${variable.name}`]: noContent })
    expect(await changeVariable(gh.octokit, { scope: variableScope(undefined, "example/project"), change: { action: "delete", name: variable.name }, yes: true })).toMatchObject({ before: variable, after: null })
    expect(gh.calls.map(({ route }) => route)).toEqual([repoList, `DELETE ${repoPath}/${variable.name}`, repoList])
  })

  test("an installation refusal is sanitized and never becomes a create", async () => {
    const gh = github({ [orgList]: { status: 403, body: { message: "private detail" } } })
    const error = await changeVariable(gh.octokit, { scope: variableScope(org, undefined), change: { action: "set", name: variable.name, value: "new" }, yes: true }).catch((cause: unknown) => cause)
    expect(String(error)).toContain("organization_variables: read")
    expect(String(error)).not.toContain("private detail")
    expect(gh.calls).toEqual([{ route: orgList }])
  })
})

const groups = "/orgs/example/actions/runner-groups"
const detail = `${groups}/7`
const repos = `${detail}/repositories`
const runnerId = 25
const workflow = "example/project/.github/workflows/ci.yml@refs/heads/main"
const repo = { id: 42, full_name: "example/project", private: true }
const policy = { id: 7, name: "trusted", visibility: "selected", allows_public_repositories: false, restricted_to_workflows: false, inherited: false }
const options = { org, repo: [], allowPublic: false, restrictedToWorkflows: false, allWorkflows: false, workflows: [] }

describe("organization runner groups", () => {
  test("empty selected group previews a POST with no repository ids by default", async () => {
    const gh = github({})
    expect(await changeRunnerGroup(gh.octokit, { ...options, action: "create", name: "trusted" })).toMatchObject({
      dry_run: true, requests: [{ method: "POST", endpoint: groups, body: { name: "trusted", visibility: "selected", allows_public_repositories: false, selected_repository_ids: [] } }],
    })
    expect(gh.calls).toEqual([])
  })

  test("unpinned or missing workflow refs fail before reading or writing", async () => {
    for (const workflows of [[], [workflow.replace("refs/heads/", "")]]) {
      const gh = github({})
      await expect(changeRunnerGroup(gh.octokit, { ...options, action: "update", group: "7", restrictedToWorkflows: true, workflows, yes: true })).rejects.toThrow("workflow")
      expect(gh.calls).toEqual([])
    }
  })

  test("get returns all group fields and the selected repository allowlist", async () => {
    const gh = github({ [`GET ${detail}`]: { body: policy }, [`GET ${repos}?per_page=100`]: { body: { repositories: [repo], total_count: 1 } } })
    expect(await getRunnerGroup(gh.octokit, org, "7")).toMatchObject({ ...policy, repositories: [repo] })
  })

  test("create sends the exact restricted policy and reads it back with the allowlist", async () => {
    const second = { id: 43, full_name: "example/docs", private: false }
    const expected = { ...policy, allows_public_repositories: true, restricted_to_workflows: true, selected_workflows: [workflow] }
    const gh = github({
      "GET /repos/example/project": { body: repo }, "GET /repos/example/docs": { body: second },
      [`POST ${groups}`]: { body: expected, status: 201 }, [`GET ${detail}`]: { body: expected },
      [`GET ${repos}?per_page=100`]: { body: { repositories: [second, repo], total_count: 2 } },
    })
    const input = { ...options, action: "create", name: "trusted", repo: [repo.full_name, second.full_name], restrictedToWorkflows: true, workflows: [workflow], yes: true } as const
    await expect(changeRunnerGroup(gh.octokit, input)).rejects.toThrow("public repository refused")
    expect(gh.calls.every(({ route }) => route.startsWith("GET"))).toBe(true)
    const receipt = await changeRunnerGroup(gh.octokit, { ...input, allowPublic: true })
    expect(receipt).toMatchObject({ dry_run: false, after: { ...expected, repositories: [second, repo] } })
    expect(gh.calls.find(({ route }) => route === `POST ${groups}`)?.body).toEqual({ name: "trusted", visibility: "selected", allows_public_repositories: true, restricted_to_workflows: true, selected_workflows: [workflow], selected_repository_ids: [42, 43] })
  })

  test("update can clear selected repositories and verifies its two writes", async () => {
    const gh = github({ [`GET ${detail}`]: { body: policy }, [`PATCH ${detail}`]: { body: policy }, [`PUT ${repos}`]: noContent, [`GET ${repos}?per_page=100`]: { body: { repositories: [], total_count: 0 } } })
    const input = { ...options, action: "update", group: "7", visibility: "selected" } as const
    expect(await changeRunnerGroup(gh.octokit, input)).toMatchObject({ dry_run: true, requests: [{ method: "PATCH" }, { method: "PUT", body: { selected_repository_ids: [] } }] })
    expect(gh.calls).toEqual([{ route: `GET ${detail}` }])
    expect(await changeRunnerGroup(gh.octokit, { ...input, yes: true })).toMatchObject({ dry_run: false, after: { repositories: [] } })
    expect(gh.calls.slice(1)).toEqual([
      { route: `GET ${detail}` }, { route: `PATCH ${detail}`, body: { name: "trusted", visibility: "selected", allows_public_repositories: false } },
      { route: `PUT ${repos}`, body: { selected_repository_ids: [] } }, { route: `GET ${detail}` }, { route: `GET ${repos}?per_page=100` },
    ])
  })

  test("add-runner previews then sends just one group move and verifies membership", async () => {
    const route = `PUT ${detail}/runners/${runnerId}`
    const read = `GET ${detail}/runners?per_page=100`
    const gh = github({ [`GET ${detail}`]: { body: policy }, [`GET /orgs/example/actions/runners/${runnerId}`]: { body: { id: runnerId } }, [route]: noContent,
      [read]: [{ body: { total_count: 1, runners: [{ id: runnerId }] } }, { body: { total_count: 0, runners: [] } }],
    })
    const input = { org, group: "7", id: runnerId }
    expect(await addRunnerToGroup(gh.octokit, input)).toMatchObject({ dry_run: true, request: { method: "PUT", endpoint: `${detail}/runners/${runnerId}` } })
    expect(gh.calls.every(({ route }) => route.startsWith("GET"))).toBe(true)
    expect(await addRunnerToGroup(gh.octokit, { ...input, yes: true })).toMatchObject({ dry_run: false, readback: { group: { id: 7, name: "trusted" }, runner_id: runnerId } })
    expect(gh.calls.slice(-2).map(({ route }) => route)).toEqual([route, read])
    await expect(addRunnerToGroup(gh.octokit, { ...input, yes: true })).rejects.toThrow("membership readback mismatch")
  })
})

const run = async (command: "variables" | "runner-group", args: string[], routes: Record<string, Reply | Reply[]>) => {
  const script = `
    import { mock } from "bun:test";
    import { Octokit } from "@octokit/rest";
    import { Command } from "@effect/cli";
    import { Effect } from "effect";
    const real = await import("./src/org-runners.ts");
    const github = ${github.toString()};
    const gh = github(${JSON.stringify(routes)});
    globalThis.fetch = () => { throw new Error("live HTTP forbidden"); };
    mock.module("./src/org-runners.ts", () => ({ ...real, createOrgOctokit: (owner, repo) => {
      if (owner !== "example" || repo !== ${command === "variables" && args.includes("example/project") ? '"project"' : "undefined"}) throw new Error("wrong installation scope");
      return Effect.succeed(gh.octokit);
    } }));
    const cmd = ${(command === "variables") ? '(await import("./src/commands/variables.ts")).variablesCmd' : '(await import("./src/commands/runners.ts")).runnerGroupCmd'};
    await Effect.runPromise(Command.run(cmd, { name: "test", version: "0" })(["bun", "test", ...${JSON.stringify(args)}]));
    console.error(JSON.stringify(gh.calls));
  `
  const child = Bun.spawn([process.execPath, "--eval", script], { cwd: new URL("..", import.meta.url).pathname, env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout, stderr, exitCode }
}

test("CLI routes repo scope and org scope, and set without --yes only reads", async () => {
  const repo = await run("variables", ["list", "example/project"], { [repoList]: variableList([variable]) })
  expect(repo.exitCode).toBe(0)
  expect(JSON.parse(repo.stdout).result.variables).toEqual([variable])
  const org = await run("variables", ["set", "--org", "example", variable.name, "new"], { [orgList]: variableList([variable]) })
  expect(org.exitCode).toBe(0)
  expect(JSON.parse(org.stdout).result).toMatchObject({ dry_run: true, before: variable })
  expect(JSON.parse(org.stderr)).toEqual([{ route: orgList }])
})

test("CLI parses group subcommands and the legacy form is now dry-run unless --yes", async () => {
  const created = await run("runner-group", ["create", "--org", org, "--name", "trusted", "--visibility", "private", "--restricted-to-workflows", "--workflow", workflow, "--workflow", workflow.replace("main", "stable")], {})
  expect(created.exitCode).toBe(0)
  expect(JSON.parse(created.stdout).result).toMatchObject({ dry_run: true, requests: [{ body: { visibility: "private", selected_workflows: [workflow, workflow.replace("main", "stable")] } }] })
  const legacy = await run("runner-group", ["--org", org, "--name", "trusted", "--repo", "example/project"], {
    "GET /repos/example/project": { body: repo }, [`GET ${groups}?per_page=100`]: { body: { total_count: 1, runner_groups: [policy] } },
  })
  expect(legacy.exitCode).toBe(0)
  expect(JSON.parse(legacy.stdout).result).toMatchObject({ dry_run: true, action: "update", selected_repository_ids: [repo.id] })
  expect(JSON.parse(legacy.stderr)).toEqual([{ route: "GET /repos/example/project" }, { route: `GET ${groups}?per_page=100` }])
})
