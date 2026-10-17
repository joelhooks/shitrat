// Test-only preload: all HTTP is stubbed and all child spawns are refused.
import { mock } from "bun:test"
import { writeFileSync } from "node:fs"

// Freeze the clock so future/past validation remains deterministic as calendar time advances.
Date.now = () => Date.parse("2026-10-17T00:00:00Z")
const TOKEN = "TEST-RUNNER-TOKEN-0f3c"
const INSTALLATION_TOKEN = "TEST-INSTALLATION-TOKEN-9d2a"
const spawned: unknown[] = []
const requests: string[] = []
const refuseSpawn = (...args: unknown[]): never => {
  spawned.push(args)
  throw new Error("Unexpected subprocess")
}
Bun.spawn = refuseSpawn
Bun.spawnSync = refuseSpawn
mock.module("node:child_process", () => ({
  spawn: refuseSpawn, spawnSync: refuseSpawn, exec: refuseSpawn, execSync: refuseSpawn,
  execFile: refuseSpawn, execFileSync: refuseSpawn, fork: refuseSpawn,
}))
process.on("exit", () => {
  writeFileSync(process.env.RUNNER_TEST_AUDIT!, JSON.stringify({ spawned, requests }))
})
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
  const route = `${init?.method ?? "GET"} ${url.pathname}`
  requests.push(route)
  if (url.origin !== "https://api.github.com") throw new Error("Unexpected network origin")
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json", "x-ratelimit-remaining": "4999" },
  })
  if (route === "POST /app/installations/123/access_tokens") {
    return reply({ token: INSTALLATION_TOKEN, expires_at: "2026-10-17T20:00:00Z", permissions: { organization_self_hosted_runners: "write" } })
  }
  if (route === "POST /orgs/example/actions/runners/registration-token") {
    const authorization = new Headers(init?.headers).get("authorization")
    if (authorization !== `token ${INSTALLATION_TOKEN}` && authorization !== `Bearer ${INSTALLATION_TOKEN}`) throw new Error("Wrong installation auth")
    if (process.env.RUNNER_TEST_FAILURE) return reply({ message: `Do not print ${TOKEN} or ${INSTALLATION_TOKEN}`, token: TOKEN }, 403)
    if (process.env.RUNNER_TEST_INVALID) return reply({ token: TOKEN, expires_at: `invalid ${TOKEN}` })
    const expiry: unknown = process.env.RUNNER_TEST_EXPIRY_JSON !== undefined
      ? JSON.parse(process.env.RUNNER_TEST_EXPIRY_JSON)
      : process.env.RUNNER_TEST_EXPIRY ?? "2026-10-17T12:13:35.123-08:00"
    return reply({ token: TOKEN, expires_at: expiry }, 201)
  }
  throw new Error(`Unexpected network request: ${route}`)
}) as typeof fetch
