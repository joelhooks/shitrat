// No live HTTP. Mint via the real App code; fake git is an executable on PATH.
import { setSystemTime } from "bun:test"
import { appendFileSync } from "node:fs"
setSystemTime(new Date(process.env.GIT_TOKEN_TEST_SCENARIO === "expired" ? "2026-11-11T00:00:00Z" : "2026-10-27T08:00:00Z"))
const scenario = process.env.GIT_TOKEN_TEST_SCENARIO!
const record = (event: string) => appendFileSync(process.env.GIT_TOKEN_TEST_AUDIT!, event + "\n")
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
  const route = `${init?.method ?? "GET"} ${url.pathname}`
  if (url.origin !== "https://api.github.com") throw new Error("Unexpected network origin")
  const reply = (data: unknown, status = 200) => status === 204 ? new Response(null, { status }) : Response.json(data, { status })
  const authorization = new Headers(init?.headers).get("authorization") ?? ""
  if (route === "POST /app/installations/123/access_tokens") {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (body && JSON.stringify(body) !== JSON.stringify({ repositories: ["project"] })) throw new Error("Wrong narrowing")
    const scope = body ? "repository" : "installation"
    record(`mint ${scope}`)
    return reply({ token: body ? "FAKE-SCOPED-TOKEN" : "FAKE-FULL-TOKEN", expires_at: "2026-10-27T09:00:00Z", permissions: { contents: scenario === "no-permission" ? "read" : "write", workflows: "write" } })
  }
  if (route === "DELETE /installation/token") {
    if (authorization !== "Bearer FAKE-FULL-TOKEN") throw new Error("Wrong revoke auth")
    record("revoke installation")
    return reply(null, scenario.includes("revoke-fails") ? 503 : 204)
  }
  if (!/^(token|Bearer) FAKE-SCOPED-TOKEN$/.test(authorization)) throw new Error("REST must use scoped credentials")
  record(route)
  if (route === "GET /repos/example/project") {
    if (scenario === "rest-fails") return reply({ message: "FAKE-SCOPED-TOKEN" }, 404)
    if (init?.redirect !== "error") throw new Error("Must refuse REST redirects")
    return reply({ full_name: scenario === "wrong-repo" ? "other/project" : "example/project", owner: { login: scenario === "wrong-repo" ? "other" : "example" }, name: "project", permissions: { push: scenario !== "no-permission" } })
  }
  if (scenario.startsWith("empty-") && route.includes("/branches/")) return reply({ message: "Not Found" }, 404)
  if (scenario.startsWith("empty-") && (route.includes("/git/refs") || route.includes("/git/ref/"))) return reply({ message: "Git Repository is empty." }, 409)
  throw new Error(`Unexpected fixture HTTP route: ${route}`)
}) as typeof fetch
