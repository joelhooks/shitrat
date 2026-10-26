// Fake HTTP only. Authentication uses the real installation client, with no network escape.
import { mock, setSystemTime } from "bun:test"
import { writeFileSync } from "node:fs"
setSystemTime(new Date("2026-10-26T00:00:00.000Z"))
const scenario = process.env.CANCEL_RUNS_TEST_SCENARIO ?? "default"
const requests: string[] = []
process.on("exit", () => writeFileSync(process.env.CANCEL_RUNS_TEST_AUDIT!, JSON.stringify(requests)))
const refuseSpawn = (): never => { throw new Error("Unexpected subprocess") }
Bun.spawn = refuseSpawn
Bun.spawnSync = refuseSpawn
mock.module("node:child_process", () => ({ spawn: refuseSpawn, spawnSync: refuseSpawn, exec: refuseSpawn, execSync: refuseSpawn, execFile: refuseSpawn, execFileSync: refuseSpawn, fork: refuseSpawn }))
// Readback polling sleeps 2 s between reads; collapse timers so the bounded-read tests stay fast.
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = ((handler: () => void, _ms?: number, ...args: unknown[]) => realSetTimeout(handler, 0, ...args)) as typeof setTimeout

type Run = { id: number; status: string; conclusion: string | null; head_sha: string; created_at: string }
const run = (id: number, status: string, created_at: string): Run => ({ id, status, conclusion: null, head_sha: String(id).padStart(40, "0"), created_at })
const runs: Run[] = [
  run(101, "pending", "2026-10-23T00:00:00Z"),
  run(102, "pending", "2026-10-25T00:00:00Z"),
  run(103, "pending", "2026-10-25T12:00:00Z"),
  run(201, "queued", "2026-10-22T00:00:00Z"),
]
if (scenario === "listed-in-progress") runs.push(run(104, "in_progress", "2026-10-21T00:00:00Z"))
if (scenario === "many") for (let i = 0; i < 5; i++) runs.push(run(300 + i, "pending", `2026-10-2${i}T06:00:00Z`))
const byId = new Map(runs.map((item) => [item.id, item]))
let limited = 0

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
  const route = `${init?.method ?? "GET"} ${decodeURIComponent(url.pathname)}`
  requests.push(url.searchParams.has("status") ? `${route}?status=${url.searchParams.get("status")}` : route)
  if (url.origin !== "https://api.github.com") throw new Error("Unexpected network origin")
  // Octokit's paginator reads response.url, which a constructed Response leaves empty.
  const reply = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
    Object.defineProperty(new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "x-ratelimit-remaining": "4999", ...headers } }), "url", { value: url.href })
  const denied = () => reply({ message: "Resource not accessible by integration FAKE-INSTALLATION-TOKEN" }, 403)
  if (route === "POST /app/installations/123/access_tokens") return reply({ token: "FAKE-INSTALLATION-TOKEN", expires_at: "2099-01-01T00:00:00Z", permissions: scenario === "no-actions" ? {} : { actions: scenario === "actions-read" ? "read" : "write" } })
  if (!/^(token|Bearer) FAKE-INSTALLATION-TOKEN$/.test(new Headers(init?.headers).get("authorization") ?? "")) throw new Error("Wrong installation authentication")
  const root = "/repos/example/project/actions"
  if (route === `GET ${root}/workflows/preview.yml/runs`) {
    if (scenario === "list-403") return denied()
    if (scenario === "rate-once" && limited++ === 0) return reply({ message: "slow down" }, 429, { "retry-after": "0.01" })
    const status = url.searchParams.get("status")
    // GitHub's own filter is not trusted: listed-in-progress returns a started run under status=pending.
    const listed = runs.filter((item) => item.status === status || (scenario === "listed-in-progress" && status === "pending" && item.id === 104))
    return reply({ total_count: listed.length, workflow_runs: listed })
  }
  const match = route.match(/^(GET|POST) \/repos\/example\/project\/actions\/runs\/(\d+)(\/cancel)?$/)
  const item = match ? byId.get(Number(match[2])) : undefined
  if (match && item && match[1] === "GET" && !match[3]) {
    if (scenario === "started" && item.id === 101 && item.conclusion === null) return reply({ ...item, status: "in_progress" })
    return reply(item)
  }
  if (match && item && match[1] === "POST" && match[3]) {
    if (scenario === "cancel-403") return denied()
    if (scenario !== "never-cancels") Object.assign(item, { status: "completed", conclusion: "cancelled" })
    return reply({}, 202)
  }
  throw new Error(`Unexpected network request ${route}`)
}) as typeof fetch
