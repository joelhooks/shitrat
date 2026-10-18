// All HTTP is fake, including authentication. Never fall through to the network.
import { mock, setSystemTime } from "bun:test"
import { writeFileSync } from "node:fs"

setSystemTime(new Date("2026-10-18T12:00:00.000Z"))
const target = "a".repeat(40)
const tagSha = "b".repeat(40)
const scenario = process.env.RELEASE_TEST_SCENARIO ?? "happy"
const requests: { route: string; body?: unknown }[] = []
const refuseSpawn = (): never => { throw new Error("Unexpected subprocess") }
Bun.spawn = refuseSpawn
Bun.spawnSync = refuseSpawn
mock.module("node:child_process", () => ({ spawn: refuseSpawn, spawnSync: refuseSpawn, exec: refuseSpawn, execSync: refuseSpawn, execFile: refuseSpawn, execFileSync: refuseSpawn, fork: refuseSpawn }))
process.on("exit", () => writeFileSync(process.env.RELEASE_TEST_AUDIT!, JSON.stringify(requests)))
let tagCreated = false
let tagReads = 0
let tagBody: Record<string, unknown> = {}
let releaseBody: Record<string, unknown> = {}
const release = () => ({
  id: 7, tag_name: releaseBody.tag_name, name: releaseBody.name,
  body: releaseBody.body ?? (releaseBody.generate_release_notes ? "Generated notes" : ""),
  draft: releaseBody.draft, prerelease: releaseBody.prerelease,
  html_url: "https://github.com/example/project/releases/tag/v0.1.0",
})
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
  const route = `${init?.method ?? "GET"} ${decodeURIComponent(url.pathname)}`
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  requests.push({ route, ...(body === undefined ? {} : { body }) })
  if (url.origin !== "https://api.github.com") throw new Error("Unexpected network origin")
  const reply = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "x-ratelimit-remaining": "4999", ...headers } })
  const missing = () => reply({ message: "Not Found" }, 404)
  if (route === "POST /app/installations/123/access_tokens") return reply({ token: "FAKE-INSTALLATION-TOKEN", expires_at: "2099-01-01T00:00:00Z", permissions: { contents: "write" } })
  const authorization = new Headers(init?.headers).get("authorization")
  if (authorization !== "token FAKE-INSTALLATION-TOKEN" && authorization !== "Bearer FAKE-INSTALLATION-TOKEN") throw new Error("Wrong installation authentication")
  if (route === "GET /repos/example/project/git/ref/tags/v0.1.0") {
    tagReads++
    if (scenario === "tag-deleted-during-preflight" && tagReads > 1) return missing()
    if (scenario === "tag-changed-during-preflight" && tagReads > 1) return reply({ ref: "refs/tags/v0.1.0", object: { type: "tag", sha: "c".repeat(40) } })
    if (scenario === "permission-denied") return reply({ message: "Do not expose FAKE-INSTALLATION-TOKEN" }, 403)
    const exists = tagCreated || process.env.RELEASE_TEST_COMMAND === "release" || scenario.startsWith("existing-tag")
    if (!exists || scenario === "missing-tag") return missing()
    return reply({ ref: "refs/tags/v0.1.0", object: { type: scenario.startsWith("existing-tag") && scenario !== "existing-tag-annotation" ? "commit" : "tag", sha: scenario === "tag-ref-mismatch" ? "c".repeat(40) : scenario === "existing-tag-different" ? "d".repeat(40) : tagCreated ? tagSha : target } })
  }
  if (route === `GET /repos/example/project/git/commits/${target}`) return scenario === "unknown-target" ? missing() : reply({ sha: target })
  if (route === "POST /repos/example/project/git/tags") { tagBody = body; return reply({ sha: tagSha }, 201) }
  if (route === "POST /repos/example/project/git/refs") {
    if (scenario === "tag-race") return reply({ message: "Reference already exists" }, 422)
    tagCreated = true
    return reply({ ref: body.ref, object: { type: "tag", sha: tagSha } }, 201)
  }
  if (route === `GET /repos/example/project/git/tags/${tagSha}`) return reply({ sha: tagSha, tag: tagBody.tag, message: scenario === "tag-message-mismatch" || scenario === "existing-tag-annotation" ? "Different annotation" : tagBody.message, object: { type: "commit", sha: scenario === "tag-target-mismatch" ? "c".repeat(40) : target } })
  if (route === "GET /repos/example/project/releases") {
    if (scenario === "list-permission-denied") return reply({ message: "FAKE-INSTALLATION-TOKEN" }, 403)
    if (scenario === "duplicate-release") return reply([{ tag_name: "v0.1.0", draft: false }])
    if (scenario === "duplicate-draft") return reply([{ tag_name: "v0.1.0", draft: true }])
    if (scenario === "duplicate-page-two") return url.searchParams.get("page") === "2"
      ? reply([{ tag_name: "v0.1.0", draft: true }])
      : reply([{ tag_name: "old" }], 200, { link: '<https://api.github.com/repos/example/project/releases?per_page=100&page=2>; rel="next"' })
    return reply([])
  }
  if (route === "POST /repos/example/project/releases") { releaseBody = body; return reply(release(), 201) }
  if (route === "GET /repos/example/project/releases/7") return reply({ ...release(), ...(scenario === "release-mismatch" ? { tag_name: "wrong" } : {}), ...(scenario === "release-body-mismatch" ? { body: "wrong" } : {}), ...(scenario === "release-draft-mismatch" ? { draft: !releaseBody.draft } : {}) })
  throw new Error(`Unexpected network request: ${route}`)
}) as typeof fetch
