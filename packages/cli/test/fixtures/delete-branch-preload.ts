// Fake HTTP only. Authentication uses the real installation client, with no network escape.
import { mock, setSystemTime } from "bun:test"
import { writeFileSync } from "node:fs"
setSystemTime(new Date("2026-10-26T00:00:00.000Z"))
const scenario = process.env.DELETE_BRANCH_TEST_SCENARIO ?? "behind"
const requests: string[] = []
process.on("exit", () => writeFileSync(process.env.DELETE_BRANCH_TEST_AUDIT!, JSON.stringify(requests)))
const refuseSpawn = (): never => { throw new Error("Unexpected subprocess") }
Bun.spawn = refuseSpawn
Bun.spawnSync = refuseSpawn
mock.module("node:child_process", () => ({ spawn: refuseSpawn, spawnSync: refuseSpawn, exec: refuseSpawn, execSync: refuseSpawn, execFile: refuseSpawn, execFileSync: refuseSpawn, fork: refuseSpawn }))
const reads = new Map<string, number>()
const deleted = new Set<string>()
let limitedReads = 0
const sha = "a".repeat(40)
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
  const route = `${init?.method ?? "GET"} ${decodeURIComponent(url.pathname)}`
  requests.push(route)
  if (url.origin !== "https://api.github.com") throw new Error("Unexpected network origin")
  const reply = (data: unknown, status = 200, headers: Record<string, string> = {}) => status === 204
    ? new Response(null, { status })
    : new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "x-ratelimit-remaining": "4999", ...headers } })
  const missing = () => reply({ message: "Not Found FAKE-INSTALLATION-TOKEN" }, 404)
  if (route === "POST /app/installations/123/access_tokens") return reply({ token: "FAKE-INSTALLATION-TOKEN", expires_at: "2099-01-01T00:00:00Z", permissions: scenario === "no-contents" ? {} : { contents: scenario === "read-only" ? "read" : "write" } })
  if (!/^(token|Bearer) FAKE-INSTALLATION-TOKEN$/.test(new Headers(init?.headers).get("authorization") ?? "")) throw new Error("Wrong installation authentication")
  const root = `/repos/${process.env.DELETE_BRANCH_TEST_REPO ?? "example/project"}`
  if (route === `GET ${root}`) {
    if (scenario === "repo-404") return missing()
    return reply({ default_branch: "main" })
  }
  if (route.startsWith(`GET ${root}/branches/`)) {
    if (scenario === "permission-403") return reply({ message: "FAKE-INSTALLATION-TOKEN" }, 403)
    if (scenario === "branch-404" || scenario === "absent") return missing()
    if (scenario.startsWith("rate-")) {
      limitedReads++
      if (scenario !== "rate-once" || limitedReads === 1) return reply({ message: "FAKE-INSTALLATION-TOKEN" }, scenario === "rate-403" ? 403 : 429, { "retry-after": "0" })
    }
    const branch = route.slice(`GET ${root}/branches/`.length)
    return reply({ protected: scenario === "protected" || branch === "protected" })
  }
  if (route.startsWith(`GET ${root}/git/ref/heads/`)) {
    const branch = route.slice(`GET ${root}/git/ref/heads/`.length)
    const count = (reads.get(branch) ?? 0) + 1
    reads.set(branch, count)
    if (deleted.has(branch) && scenario === "readback-403") return reply({ message: "FAKE-INSTALLATION-TOKEN" }, 403)
    if (scenario === "absent" || (scenario === "ref-disappeared" && count > 1) || (deleted.has(branch) && scenario !== "readback-mismatch")) return missing()
    return reply({ ref: `refs/heads/${branch}`, object: { type: "commit", sha: scenario === "moved" && count > 1 ? "b".repeat(40) : sha } })
  }
  if (route === `GET ${root}/compare/main...${sha}`) {
    if (scenario === "compare-404") return missing()
    if (scenario === "compare-403") return reply({ message: "FAKE-INSTALLATION-TOKEN" }, 403)
    return reply({ status: ["ahead", "diverged", "identical", "unknown"].includes(scenario) ? scenario : "behind" })
  }
  if (route.startsWith(`DELETE ${root}/git/refs/heads/`)) {
    if (scenario === "delete-404") return missing()
    if (scenario === "delete-403") return reply({ message: "FAKE-INSTALLATION-TOKEN" }, 403)
    deleted.add(route.slice(`DELETE ${root}/git/refs/heads/`.length))
    return reply(null, 204)
  }
  throw new Error(`Unexpected network request ${route}`)
}) as typeof fetch
