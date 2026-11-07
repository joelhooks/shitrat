import { describe, expect, test } from "bun:test"
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildCellGitInvocation } from "../src/git-push.js"
import { deriveCallerDocument, verifyCallerDocument, verifyProtectedFile } from "../src/github-cell.js"

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } })
const signing = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "jwk" })
const identity = JSON.stringify({ did: "did:web:fixture.example.invalid", signing })
const fixture = path.join(import.meta.dir, "fixtures/cell-client.ts")
const readOrEmpty = async (file: string) => readFile(file, "utf8").catch(() => "")
type Seen = { method: string; path: string; search: string; authorization: string | null; auth: string | null; body: Buffer }
type NonceRecord = { command: string; nonce: string | null; identityPresent: boolean; privateKeyPresent: boolean }
type ForwardRequest = { token: string; nonce: string }
type GitChild = { args: string[]; nonceEnv: string | null; traceKeys: string[]; identityPresent: boolean; privateKeyPresent: boolean; passPresent?: boolean; inheritedTokenPresent?: boolean }

const scenario = async (input: {
  via?: string
  noName?: boolean
  nameOff?: boolean
  config?: "file" | "override" | "missing" | "malformed" | "relative-bin"
  configMode?: number
  configSymlink?: boolean
  secretsConfig?: boolean
  trustFailure?: "sc-mode" | "sc-link" | "sc-parent" | "secrets-mode" | "secrets-path"
  leaseGrandchild?: boolean
  describeHang?: boolean
  noAppEnv?: boolean
  parentCredentials?: boolean
  forceFakeClient?: boolean
  identityFixture?: "secure" | "insecure" | "symlink" | "foreign-owner"
  lease?: "ok" | "refused" | "invalid"
  unreachable?: boolean
  fallback?: string
  refusal?: boolean
  fetchRefusal?: boolean
  redirect?: boolean
  mode?: string
  missingIdentity?: boolean
  identityFile?: string
  cli?: boolean
  pushCli?: boolean
  cliArgs?: string[]
  runnerFailure?: { status: number; headers?: Record<string, string>; message: string }
  forwardFailure?: boolean
  failureEnvelope?: boolean
  unavailableClient?: boolean
  gitTracing?: boolean
  capability?: "old" | "garbage" | "timeout" | "missing" | "false" | "extra"
  oldClient?: boolean
  missingDocument?: boolean
  documentMismatch?: "did" | "key"
  git?: (home: string, run: (args: string[]) => Promise<Result>) => Promise<Result>
}) => {
  const home = await mkdtemp(path.join(tmpdir(), "shitrat-cell-test-"))
  const client = path.join(home, "sc-fixture.ts")
  // The probe has no inherited test hooks; the fake executable owns its fixture
  // configuration, just as a real executable owns its capability implementation.
  await writeFile(client, `#!${process.execPath}\nprocess.env.CELL_TEST_ARGV = ${JSON.stringify(path.join(home, "argv"))};\nprocess.env.CELL_TEST_NONCES = ${JSON.stringify(path.join(home, "nonces"))};\nprocess.env.CELL_TEST_CAPABILITY_MODE = ${JSON.stringify(input.capability ?? "supported")};\nawait import(${JSON.stringify(fixture)});\n`, { mode: 0o755 })
  const binDir = path.join(home, "bin")
  await mkdir(binDir)
  // Synthetic secrets remain in env/stdout, never in fixture files or argv.
  const secretsBin = path.join(binDir, "secrets")
  await writeFile(secretsBin, `#!${process.execPath}\nimport { appendFile } from "node:fs/promises";\nawait appendFile(${JSON.stringify(path.join(home, "leases"))}, JSON.stringify(process.argv.slice(2)) + "\\n");\nawait appendFile(${JSON.stringify(path.join(home, "lease-env"))}, JSON.stringify(Object.keys(process.env)) + "\\n");\n${input.leaseGrandchild ? `Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 60000)"], { stdin: "ignore", stdout: "inherit", stderr: "ignore" });` : ""}\nconst values = JSON.parse(process.env.AGENT_SECRETS_TEST_VALUES ?? "{}");\nprocess.stdout.write(process.argv[3]?.startsWith("rat_king_fleet_agent_") ? process.env.AGENT_SECRETS_TEST_LEASE_VALUE ?? "" : values[process.argv[3]] ?? ""); process.exit(${input.lease === "refused" ? 1 : 0});\n`, { mode: 0o755 })
  const useFakeClient = !!(input.forwardFailure || input.capability || input.mode?.startsWith("nonce-") || input.describeHang || input.trustFailure || input.forceFakeClient)
  let selectedClient = useFakeClient ? client : process.env.SHITRAT_TEST_SC_BIN ?? client
  if (input.trustFailure === "sc-mode" || input.trustFailure === "sc-link") await chmod(client, 0o777)
  if (input.trustFailure === "sc-parent") await chmod(home, 0o777)
  if (input.trustFailure === "sc-link") { selectedClient = path.join(home, "sc-link"); await symlink(client, selectedClient) }
  if (input.trustFailure === "secrets-mode") await chmod(secretsBin, 0o777)
  if (input.trustFailure === "secrets-path") await chmod(binDir, 0o777)
  let identityFile = input.identityFile
  if (input.identityFixture) {
    const target = path.join(home, "identity.json")
    await writeFile(target, identity, { mode: input.identityFixture === "insecure" ? 0o644 : 0o600 })
    identityFile = target
    if (input.identityFixture === "symlink") { identityFile = path.join(home, "identity-link.json"); await symlink(target, identityFile) }
  }
  const configFile = input.config === "override" ? path.join(home, "custom-cell.json") : path.join(home, ".config/shitrat/cell.json")
  const documentFile = path.join(home, "caller-public.json")
  const did = "did:web:fixture.example.invalid"
  await writeFile(documentFile, JSON.stringify({
    id: input.documentMismatch === "did" ? "did:web:other.example.invalid" : did,
    authentication: [`${did}#atproto`],
    verificationMethod: [{ id: `${did}#atproto`, controller: did, type: "JsonWebKey2020", publicKeyJwk: { kty: signing.kty, crv: signing.crv, x: input.documentMismatch === "key" ? "unrelated-public-key" : signing.x, y: signing.y } }],
  }))
  const seen: Seen[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      expect(request.headers.has("x-sc-forward-token")).toBe(false)
      if (process.env.SHITRAT_TEST_SC_BIN && selectedClient === process.env.SHITRAT_TEST_SC_BIN) {
        const token = request.headers.get("x-sc-auth") ?? ""
        const [header, payload, signature] = token.split(".")
        expect(header && payload && signature).toBeTruthy()
        expect(verify("sha256", Buffer.from(`${header}.${payload}`), { key: createPublicKey({ key: signing, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(signature!, "base64url"))).toBe(true)
        expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toMatchObject({ aud: "did:web:cell.example.invalid", iss: "did:web:fixture.example.invalid" })
      }
      seen.push({ method: request.method, path: url.pathname, search: url.search, authorization: request.headers.get("authorization"), auth: request.headers.get("x-sc-auth"), body: Buffer.from(await request.arrayBuffer()) })
      if (url.pathname === "/v1/describe") return Response.json({ name: "shitrat-github", kind: "github-app" }, { status: input.refusal ? 403 : 200 })
      if (input.fetchRefusal) return Response.json({ error: { what: "refused", why: "fixture-policy", next: "sc describe shitrat-github" } }, { status: 403 })
      if (input.redirect) return new Response(null, { status: 302, headers: { location: "https://unapproved.example.invalid/leak" } })
      if (url.pathname.startsWith("/v1/u/github.com/")) {
        const proc = Bun.spawn(["git", "http-backend"], {
          env: { PATH: process.env.PATH, GIT_PROJECT_ROOT: home, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: url.pathname.slice("/v1/u/github.com".length), QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method, CONTENT_TYPE: request.headers.get("content-type") ?? "", CONTENT_LENGTH: String(seen.at(-1)!.body.length), REMOTE_USER: "fixture" },
          stdin: seen.at(-1)!.body, stdout: "pipe", stderr: "pipe",
        })
        const bytes = Buffer.from(await new Response(proc.stdout).arrayBuffer())
        const exit = await proc.exited
        if (exit !== 0) return new Response("backend failed", { status: 500 })
        const boundary = bytes.indexOf("\r\n\r\n")
        const headers = new Headers()
        let status = 200
        for (const line of bytes.subarray(0, boundary).toString().split("\r\n")) {
          const colon = line.indexOf(":")
          if (colon > 0) {
            if (line.slice(0, colon).toLowerCase() === "status") status = Number(line.slice(colon + 1).trim().split(" ")[0])
            else headers.append(line.slice(0, colon), line.slice(colon + 1).trim())
          }
        }
        return new Response(bytes.subarray(boundary + 4), { status, headers })
      }
      const apiPath = url.pathname.replace("/v1/u/api.github.com", "")
      const page = Number(url.searchParams.get("page") ?? "1")
      const headers: Record<string, string> = page === 1 ? { link: `<https://api.github.com${apiPath}?per_page=100&page=2>; rel="next"` } : {}
      if (apiPath.endsWith("/check-runs")) return Response.json({ total_count: 2, check_runs: [{ id: page, name: `check-${page}`, status: "completed", conclusion: "success" }] }, { headers })
      if (apiPath.endsWith("/status")) return Response.json({ sha: "a".repeat(40), url: `https://api.github.com${apiPath}`, state: "success", total_count: 2, statuses: [{ context: `status-${page}`, state: "success" }] })
      if (input.runnerFailure && apiPath.endsWith("/actions/runner-groups")) return Response.json({ total_count: 0, runner_groups: [] })
      if (input.runnerFailure && apiPath.endsWith("/actions/runners")) return Response.json({ message: input.runnerFailure.message }, { status: input.runnerFailure.status, headers: input.runnerFailure.headers ?? {} })
      if (apiPath.endsWith("/actions/runners")) return Response.json({ total_count: 2, runners: [{ id: page, name: `runner-${page}`, os: "linux", status: "offline", busy: false, labels: [] }] }, { headers })
      if (apiPath === "/installation/repositories") return Response.json({ total_count: 2, repositories: [{ full_name: `example/project-${page}`, owner: { login: "example" } }] }, { headers })
      if (apiPath.endsWith("/actions/runs")) {
        const status = url.searchParams.get("status")
        const next = page === 1 ? { link: `<https://api.github.com${apiPath}?status=${status}&per_page=50&page=2>; rel="next"` } : {}
        return Response.json({ total_count: 2, workflow_runs: [{ id: (status === "queued" ? 0 : 10) + page }] }, { headers: next })
      }
      if (apiPath.endsWith("/jobs")) return Response.json({ total_count: 2, jobs: [{ id: page, name: "build", status: "queued", labels: ["self-hosted", "linux", "pool-a"], runner_name: "runner-1", runner_group_name: "pool-a", created_at: "2026-01-01T00:00:00Z", started_at: null }] }, { headers })
      return Response.json({ full_name: "example/project", cell: true, ...(input.pushCli ? { private: true } : {}) })
    },
  })
  if (input.config === "file" || input.config === "override" || input.config === "malformed" || input.config === "relative-bin") {
    await mkdir(path.dirname(configFile), { recursive: true })
    const target = input.configSymlink ? `${configFile}.target` : configFile
    await writeFile(target, input.config === "malformed" ? "not JSON" : JSON.stringify(input.config === "override" ? { url: "http://127.0.0.1:1", audience: "wrong-audience", scBin: "missing-sc" } : { url: server.url.origin, audience: "did:web:cell.example.invalid", scBin: input.config === "relative-bin" ? "sc" : selectedClient, ...(input.secretsConfig ? { secretsBin } : {}) }), { mode: input.configMode ?? 0o600 })
    if (input.configMode !== undefined) await chmod(target, input.configMode)
    if (input.configSymlink) await symlink(target, configFile)
  }
  const run = async (args: string[] = []): Promise<Result> => {
    const nodeModule = path.join(home, "github-cell.mjs")
    if (input.mode === "no-bun") {
      const build = await Bun.build({ entrypoints: [path.join(import.meta.dir, "../src/github-cell.ts")], target: "node" })
      expect(build.success).toBe(true)
      await writeFile(nodeModule, await build.outputs[0]!.text())
    }
    const proc = Bun.spawn(input.mode === "no-bun" ? ["node", path.join(import.meta.dir, "fixtures/cell-node-driver.mjs"), nodeModule] : [process.execPath, "--preload", path.join(import.meta.dir, "fixtures/cell-direct-preload.ts"), ...(input.cli || input.pushCli ? [path.join(import.meta.dir, "../src/cli.ts"), ...(input.pushCli ? ["push", "example/project", "--repo-dir", path.join(home, "local"), "--allow-any-author", "--dry-run"] : input.cliArgs ?? ["status", "example/project"])] : [path.join(import.meta.dir, input.mode === "dead-forward" ? "fixtures/cell-dead-forward-driver.ts" : "fixtures/cell-driver.ts"), input.mode ?? "repo"])], {
      env: {
        PATH: `${binDir}:${process.env.PATH}`, HOME: home,
        ...(!input.noName ? { RATKING_NAME: input.nameOff ? "off" : "fixture/agent" } : {}),
        ...(!input.config || input.config === "override" ? { SC_URL: input.unreachable ? "http://127.0.0.1:1" : server.url.origin, SC_AUDIENCE: "did:web:cell.example.invalid" } : {}),
        ...(input.config === "override" ? { SHITRAT_CELL_CONFIG: configFile } : {}),
        ...(input.lease ? { AGENT_SECRETS_TEST_LEASE_VALUE: input.lease === "invalid" ? "invalid-identity" : identity } : {}),
        ...(input.noAppEnv ? { AGENT_SECRETS_TEST_VALUES: JSON.stringify({ shitrat_github_app_id: "123", shitrat_github_private_key: privateKey, shitrat_github_client_id: "fixture-client", shitrat_github_installations_json: '{"example":123}' }) } : {}),
        ...(!input.missingIdentity ? { SC_IDENTITY_JSON: identity } : {}),
        ...(identityFile ? { SHITRAT_CELL_IDENTITY_FILE: identityFile } : {}),
        ...(input.identityFixture === "foreign-owner" ? { CELL_TEST_FOREIGN_OWNER_FILE: identityFile } : {}),
        ...(!input.missingDocument ? { SHITRAT_CELL_CALLER_DOCUMENT_FILE: documentFile } : {}),
        ...(!input.config || input.config === "override" ? { SHITRAT_SC_BIN: input.oldClient ? process.env.SHITRAT_TEST_OLD_SC_BIN : input.unavailableClient ? path.join(home, "missing-sc") : selectedClient } : {}),
        SC_FORWARD_NONCE: "inherited-nonce-must-be-replaced-not-forwarded",
        ...(input.parentCredentials ? { SC_PASS_FILE: path.join(home, "parent-pass"), SHITRAT_PUSH_TOKEN: "inherited-fixture-token", SHITRAT_GITHUB_TOKEN: "inherited-fixture-token", GITHUB_TOKEN: "inherited-fixture-token", GH_TOKEN: "inherited-fixture-token" } : {}),
        CELL_TEST_NONCES: path.join(home, "nonces"), CELL_TEST_FORWARD_REQUESTS: path.join(home, "forward-requests"),
        ...(process.env.SHITRAT_TEST_SC_BIN ? { CELL_TEST_REAL_SC_BIN: process.env.SHITRAT_TEST_SC_BIN } : {}),
        ...(input.mode === "nonce-refusal" ? { CELL_TEST_NONCE_REFUSAL: "1" } : {}),
        ...(input.mode === "nonce-echo" ? { CELL_TEST_ECHO_NONCE: "1" } : {}),
        ...(input.forwardFailure ? { CELL_TEST_FORWARD_FAIL: "1" } : {}),
        ...(input.describeHang ? { CELL_TEST_DESCRIBE_HANG: "1" } : {}),
        ...(input.failureEnvelope ? { CELL_TEST_CLI_ENVELOPE_DEFECT: "1" } : {}),
        ...(input.via ? { SHITRAT_GITHUB_VIA: input.via } : {}),
        ...(input.fallback ? { SHITRAT_GITHUB_CELL_FALLBACK: input.fallback } : {}),
        ...(!input.noAppEnv ? { SHITRAT_GITHUB_APP_ID: "123", SHITRAT_GITHUB_PRIVATE_KEY: privateKey, SHITRAT_GITHUB_CLIENT_ID: "fixture-client", SHITRAT_GITHUB_INSTALLATIONS_JSON: '{"example":123}' } : {}),
        CELL_TEST_DIRECT: path.join(home, "direct"), CELL_TEST_ARGV: path.join(home, "argv"),
        CELL_TEST_GIT_ARGS: JSON.stringify(args), CELL_TEST_GIT_CWD: path.join(home, "local"),
        ...(input.git && (input.config === "missing" || input.refusal) ? { CELL_TEST_DIRECT_GIT_REMOTE: path.join(home, "example/project.git") } : {}),
        CELL_TEST_GIT_CHILDREN: path.join(home, "git-children"),
        CELL_TEST_ALL_GIT_CHILDREN: path.join(home, "all-git-children"),
        ...(input.gitTracing ? { GIT_TRACE: "1", GIT_TRACE_CURL: "1", GIT_TRACE_PACKET: "1", GIT_CURL_VERBOSE: "1", GIT_REDACT_COOKIES: "fixture", GIT_TRACE2_EVENT: path.join(home, "git-trace") } : {}),
      },
      stdout: "pipe", stderr: "pipe",
    })
    const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    const argv = await readOrEmpty(path.join(home, "argv"))
    for (const secret of [privateKey, signing.d!, "FAKE-INSTALLATION-TOKEN", identity]) expect(stdout + stderr + argv).not.toContain(secret)
    const nonces: NonceRecord[] = (await readOrEmpty(path.join(home, "nonces"))).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    const forwardRequests: ForwardRequest[] = (await readOrEmpty(path.join(home, "forward-requests"))).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    const gitChildren: GitChild[] = (await readOrEmpty(path.join(home, "git-children"))).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    const gitTrace = await readOrEmpty(path.join(home, "git-trace"))
    for (const secret of [privateKey, signing.d!, identity, "FAKE-INSTALLATION-TOKEN"]) expect(JSON.stringify(gitChildren)).not.toContain(secret)
    for (const child of gitChildren) {
      expect(child.identityPresent).toBe(false)
      if (child.args.includes("protocol.http.allow=always")) {
        expect(child.nonceEnv).toBeNull()
        expect(child.privateKeyPresent).toBe(false)
        expect(child.traceKeys).toEqual([])
      }
    }
    for (const { command, nonce } of nonces) {
      if (command !== "forward") expect(nonce).toBeNull()
      else {
        expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(Buffer.from(nonce!, "base64url")).toHaveLength(32)
        expect(nonce).not.toBe("inherited-nonce-must-be-replaced-not-forwarded")
        expect(stdout + stderr + argv + JSON.stringify(gitChildren) + gitTrace).not.toContain(nonce!)
      }
    }
    for (const request of forwardRequests) expect(request.token).toBe(request.nonce)
    return { stdout, stderr, exit, argv, allGitChildren: (await readOrEmpty(path.join(home, "all-git-children"))).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)), leaseEnv: (await readOrEmpty(path.join(home, "lease-env"))).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)), leases: await readOrEmpty(path.join(home, "leases")), nonces: nonces.filter((record) => record.command === "forward"), probes: nonces.filter((record) => record.command === "capabilities").length, forwardRequests, gitChildren, gitTrace, direct: await readOrEmpty(path.join(home, "direct")), seen }
  }
  try {
    if (input.git) return await input.git(home, run)
    return await run()
  } finally {
    server.stop(true)
    await rm(home, { recursive: true, force: true })
  }
}
type Result = { allGitChildren: GitChild[]; leaseEnv: string[][]; leases: string; stdout: string; stderr: string; exit: number; argv: string; nonces: NonceRecord[]; probes: number; forwardRequests: ForwardRequest[]; gitChildren: GitChild[]; gitTrace: string; direct: string; seen: Seen[] }

describe("GitHub cell route", () => {
  for (const trustFailure of ["sc-mode", "sc-link", "sc-parent", "secrets-mode", "secrets-path"] as const) test(`auto refuses untrusted executable ${trustFailure} before leasing`, async () => {
    const result = await scenario({ config: "file", trustFailure, secretsConfig: trustFailure === "secrets-mode", missingIdentity: true, lease: "ok" })
    expect(result.exit).toBe(0)
    expect(result.leases).toBe("")
    expect(result.argv).toBe("")
    expect(result.stderr).toBe('{"event":"github-route","path":"direct","reason":"cell-configuration"}\n')
  })
  test("auto uses an explicit trusted secretsBin with a minimal lease environment", async () => {
    const result = await scenario({ config: "file", secretsConfig: true, missingIdentity: true, missingDocument: true, lease: "ok" })
    expect(result.exit).toBe(0)
    expect(result.direct).toBe("")
    expect(result.leaseEnv).toHaveLength(1)
    expect(result.leaseEnv[0]).toContain("PATH")
    expect(result.leaseEnv[0]).toContain("HOME")
    expect(result.leaseEnv[0]!.every((key) => key === "PATH" || key === "HOME" || key.startsWith("AGENT_SECRETS") || key.startsWith("XDG"))).toBe(true)
  })
  for (const noName of [false, true]) test(`auto App-wide installations uses direct once without an identity lease (no name=${noName})`, async () => {
    const result = await scenario({ noName, config: "file", missingIdentity: true, noAppEnv: true, cli: true, cliArgs: ["installations"] })
    expect(result.exit).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, result: { count: 1 } })
    expect(result.stderr).toBe('{"event":"github-route","path":"direct","reason":"app-operation"}\n')
    expect(result.argv).toBe("")
    const calls: string[][] = result.leases.trim().split("\n").map((line) => JSON.parse(line))
    expect(calls.some((args) => args[1] === "shitrat_github_private_key")).toBe(true)
    expect(calls.some((args) => args[1]?.startsWith("rat_king_fleet_agent_"))).toBe(false)
  })
  test("auto describe black hole falls back within its 8-second setup deadline", async () => {
    const start = performance.now()
    const result = await scenario({ config: "file", describeHang: true, missingIdentity: true, lease: "ok" })
    expect(performance.now() - start).toBeLessThan(12_000)
    expect(result.exit).toBe(0)
    expect(result.stderr).toBe('{"event":"github-route","path":"direct","reason":"cell-client"}\n')
  }, 15_000)
  test("auto lease deadline includes a grandchild holding stdout open", async () => {
    const start = performance.now()
    const result = await scenario({ config: "file", missingIdentity: true, lease: "ok", leaseGrandchild: true })
    expect(performance.now() - start).toBeLessThan(14_000)
    expect(result.exit).toBe(0)
    expect(result.argv).toBe("")
    expect(result.stderr).toBe('{"event":"github-route","path":"direct","reason":"cell-configuration"}\n')
  }, 16_000)
  test("a prior App-wide direct decision cannot authorize direct after a cell request", async () => {
    const result = await scenario({ mode: "fallback-app-after-direct-selection" })
    expect(result.exit).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ directCalls: 0, error: { reason: "unsupported" } })
    expect(result.seen).toHaveLength(1)
    expect(result.direct).toBe("")
    expect(result.stderr.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      { event: "github-route", path: "direct", reason: "app-operation" },
      { event: "github-route", path: "cell", reason: "unsupported-app-operation" },
    ])
  })
  test("auto typed client error after a forwarded request cannot fall back", async () => {
    const result = await scenario({ mode: "fallback-client-after-request" })
    expect(result.exit).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ directCalls: 0, error: { reason: "client" } })
    expect(JSON.parse(result.stdout).error.message).toContain("Auto mode falls back to direct on setup failures only.")
    expect(result.seen).toHaveLength(1)
    expect(result.stderr).toBe('{"event":"github-route","path":"cell","reason":"requested"}\n')
  })
  test("auto rejects a config symlink without a lease", async () => {
    const result = await scenario({ config: "file", configSymlink: true, missingIdentity: true, lease: "ok" })
    expect(result.exit).toBe(0)
    expect(result.leases).toBe("")
    expect(result.argv).toBe("")
    expect(result.stderr).toBe('{"event":"github-route","path":"direct","reason":"cell-configuration"}\n')
  })
  for (const via of ["auto", "cell"]) for (const identityFixture of ["secure", "insecure", "symlink", "foreign-owner"] as const) test(`${via} opens a real identity file with no env identity (${identityFixture})`, async () => {
    const result = await scenario({ via, cli: true, identityFixture, missingIdentity: true, ...(via === "auto" ? { config: "file" as const } : {}) })
    expect(result.leases).toBe("")
    if (identityFixture === "secure") {
      expect(result.exit).toBe(0)
      expect(result.direct).toBe("")
      expect(result.seen).toHaveLength(2)
    } else {
      expect(result.exit).toBe(via === "auto" ? 0 : 1)
      expect(result.seen).toEqual([])
      expect(result.argv).not.toContain('"--listen"')
      if (via === "auto") expect(result.stderr).toBe('{"event":"github-route","path":"direct","reason":"cell-configuration"}\n')
      else {
        expect(result.direct).toBe("")
        expect(JSON.parse(result.stdout).error.message).toContain("No automatic direct-key fallback")
      }
    }
  })
  test("derived caller document is public-only and verifies without a file", () => {
    const document = deriveCallerDocument(identity)
    expect(() => verifyCallerDocument(identity, document)).not.toThrow()
    expect(JSON.stringify(document)).not.toContain('"d":')
    expect(JSON.stringify(document)).not.toContain(signing.d!)
    expect(document).toEqual({ id: "did:web:fixture.example.invalid", authentication: ["did:web:fixture.example.invalid#atproto"], verificationMethod: [{ id: "did:web:fixture.example.invalid#atproto", controller: "did:web:fixture.example.invalid", publicKeyJwk: { kty: signing.kty, crv: signing.crv, x: signing.x, y: signing.y } }] })
    for (const mutation of ["did", "key", "private"]) {
      const changed = JSON.parse(JSON.stringify(document))
      if (mutation === "did") changed.id = "did:web:wrong.example.invalid"
      if (mutation === "key") changed.verificationMethod[0].publicKeyJwk.x = "wrong-key"
      if (mutation === "private") changed.verificationMethod[0].publicKeyJwk.d = signing.d
      expect(() => verifyCallerDocument(identity, changed)).toThrow()
    }
    const custom = JSON.stringify({ ...JSON.parse(identity), kid: "#custom" })
    expect(JSON.stringify(deriveCallerDocument(custom))).toContain("#custom")
    for (const kid of ["did:web:other.example.invalid#key", "did:web:fixture.example.invalid#key", "not-a-fragment"]) {
      expect(() => deriveCallerDocument(JSON.stringify({ ...JSON.parse(identity), kid }))).toThrow()
    }
  })
  test("auto without RATKING_NAME stays direct and never leases", async () => {
    const result = await scenario({ noName: true, missingIdentity: true })
    expect(result.exit).toBe(0)
    expect(result.direct).not.toBe("")
    expect(result.leases).toBe("")
    expect(result.argv).toBe("")
    expect(result.stderr).toBe('{"event":"github-route","path":"direct","reason":"selected"}\n')
  })
  test("auto with RATKING_NAME=off opts out even with explicit identity and URL", async () => {
    const result = await scenario({ nameOff: true })
    expect(result.exit).toBe(0)
    expect(result.direct).not.toBe("")
    expect(result.leases).toBe("")
    expect(result.argv).toBe("")
  })
  test("auto honours explicit identity plus URL without RATKING_NAME", async () => {
    const result = await scenario({ noName: true, missingDocument: true })
    expect(result.exit).toBe(0)
    expect(JSON.parse(result.stdout).data.cell).toBe(true)
    expect(result.direct).toBe("")
    expect(result.leases).toBe("")
    expect(result.stderr).toContain('"path":"cell"')
  })
  test("protected files must be regular, mode 0600, and owned by the current user", () => {
    const uid = process.getuid!()
    const stat = { isFile: () => true, mode: 0o600, uid }
    expect(() => verifyProtectedFile(stat)).not.toThrow()
    expect(() => verifyProtectedFile({ ...stat, uid: uid + 1 })).toThrow()
    expect(() => verifyProtectedFile({ ...stat, isFile: () => false })).toThrow()
    for (const mode of [0o644, 0o620, 0o602, 0o660, 0o666]) expect(() => verifyProtectedFile({ ...stat, mode })).toThrow()
  })
  for (const configMode of [0o644, 0o620, 0o602, 0o660, 0o666]) test(`auto refuses insecure cell.json mode ${configMode.toString(8)} before leasing`, async () => {
    const result = await scenario({ config: "file", configMode, missingIdentity: true, lease: "ok" })
    expect(result.exit).toBe(0)
    expect(result.direct).not.toBe("")
    expect(result.leases).toBe("")
    expect(result.argv).toBe("")
    expect(result.stderr).toContain('"reason":"cell-configuration"')
  })
  test("auto refuses a relative scBin before leasing", async () => {
    const result = await scenario({ config: "relative-bin", missingIdentity: true, lease: "ok" })
    expect(result.exit).toBe(0)
    expect(result.direct).not.toBe("")
    expect(result.leases).toBe("")
    expect(result.argv).toBe("")
    expect(result.stderr).toContain('"reason":"cell-configuration"')
  })
  for (const failureEnvelope of [false, true]) test(`auto leased identity stays out of the CLI failure envelope when the forward echoes it (outer catch=${failureEnvelope})`, async () => {
    const result = await scenario({ cli: true, config: "file", missingIdentity: true, missingDocument: true, lease: "ok", forwardFailure: true, failureEnvelope })
    expect(result.exit).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false })
    if (failureEnvelope) expect(JSON.parse(result.stdout)).toMatchObject({ error: { code: "CLI_USAGE_ERROR" } })
    expect(result.leases).not.toBe("")
    expect(result.argv).toContain('"forward"')
    expect(result.stdout).not.toContain(signing.d!)
    expect(result.stderr).not.toContain(signing.d!)
    expect(result.stdout).not.toContain(identity)
    expect(result.stderr).not.toContain(identity)
    // cli.ts captures String(chunk): a raw Uint8Array must not leak private
    // material as comma-separated byte values instead of decoded text either.
    for (const value of [identity, signing.d!]) {
      const bytes = Array.from(new TextEncoder().encode(value)).join(",")
      expect(result.stdout).not.toContain(bytes)
      expect(result.stderr).not.toContain(bytes)
    }
  })
  test("auto without config stays direct and never leases", async () => {
    const result = await scenario({ config: "missing", missingIdentity: true })
    expect(result.exit).toBe(0)
    expect(result.direct).not.toBe("")
    expect(result.leases).toBe("")
    expect(result.argv).toBe("")
    expect(result.stderr).toContain('"reason":"cell-configuration"')
  })
  for (const config of ["file", "override"] as const) test(`auto leases once and derives caller document (${config})`, async () => {
    const result = await scenario({ config, missingIdentity: true, missingDocument: true, lease: "ok", mode: "twice" })
    expect(result.exit).toBe(0)
    expect(JSON.parse(result.stdout).data.cell).toBe(true)
    expect(result.direct).toBe("")
    expect(result.leases.trim().split("\n").map((line) => JSON.parse(line))).toEqual([["lease", "rat_king_fleet_agent_fixture.agent_identity", "--client-id", "shitrat-cell", "--ttl", "5m"]])
    expect(result.seen).toHaveLength(3)
    expect(result.stderr).toContain('"path":"cell"')
  })
  for (const lease of ["refused", "invalid"] as const) test(`auto identity lease ${lease} falls back without leaking`, async () => {
    const result = await scenario({ config: "file", missingIdentity: true, missingDocument: true, lease })
    expect(result.exit).toBe(0)
    expect(result.direct).not.toBe("")
    expect(result.leases).not.toBe("")
    expect(result.argv).toBe("")
    expect(result.stderr).toContain('"reason":"cell-configuration"')
    expect(result.stdout + result.stderr).not.toContain("invalid-identity")
  })
  test("auto CLI status emits its route even when stdout is a JSON envelope", async () => {
    const result = await scenario({ cli: true, config: "file", missingIdentity: true, missingDocument: true, lease: "ok" })
    expect(result.exit).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, result: { repo: "example/project" } })
    expect(result.stderr.trim()).toBe('{"event":"github-route","path":"cell","reason":"requested"}')
    expect(result.direct).toBe("")
    expect(result.leases.trim().split("\n")).toHaveLength(1)
  })
  test("auto explicit identity derives document and skips lease", async () => {
    const result = await scenario({ via: "auto", missingDocument: true })
    expect(result.exit).toBe(0)
    expect(result.leases).toBe("")
    expect(result.direct).toBe("")
    expect(result.seen).toHaveLength(2)
  })
  test("auto unreachable during setup falls back with bounded reason", async () => {
    const result = await scenario({ unreachable: true })
    expect(result.exit).toBe(0)
    expect(result.stderr).toMatch(/^\{"event":"github-route","path":"direct","reason":"cell-(?:client|refused)"\}\n$/)
    expect(result.direct).not.toBe("")
    expect(result.forwardRequests).toEqual([])
  })
  for (const mode of ["fallback-after-request", "fallback-write-timeout", "fallback-write-abort"] as const) test(`auto ${mode} propagates failure without direct replay (typed client case separately proves the phase guard)`, async () => {
    const result = await scenario({ mode })
    expect(result.exit).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ directCalls: 0, error: {} })
    expect(result.seen).toHaveLength(1)
    expect(result.direct).toBe("")
    expect(result.stderr).not.toContain('"path":"direct"')
  })
  test("explicit cell ignores auto config and fails closed without env", async () => {
    const result = await scenario({ via: "cell", config: "file", missingIdentity: true })
    expect(result.exit).toBe(1)
    expect(result.leases).toBe("")
    expect(result.direct).toBe("")
  })
  test("explicit direct ignores auto config and identity leasing", async () => {
    const result = await scenario({ via: "direct", config: "malformed", missingIdentity: true })
    expect(result.exit).toBe(0)
    expect(result.leases).toBe("")
    expect(result.argv).toBe("")
  })
  for (const capability of ["old", "garbage", "timeout", "missing", "false"] as const) test(`unsupported sc capability refuses before describe/forward without fallback (${capability})`, async () => {
    const result = await scenario({ via: "cell", fallback: "direct", capability, cli: true })
    expect(result.exit).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: "GITHUB_CELL_ERROR", reason: "configuration", message: "Cell route failed (configuration). sc too old for forward nonce; update sc" } })
    expect(result.probes).toBe(1)
    expect(result.nonces).toEqual([])
    expect(result.forwardRequests).toEqual([])
    expect(result.seen).toEqual([])
    expect(result.direct).toBe("")
    expect(result.stderr).not.toContain("usage:")
    expect(result.stderr).not.toContain('"path":"direct"')
  }, 10_000)
  test.skipIf(!process.env.SHITRAT_TEST_OLD_SC_BIN)("real old sc is refused without a forward or setup fallback", async () => {
    const result = await scenario({ via: "cell", fallback: "direct", oldClient: true, cli: true })
    expect(result.exit).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: "GITHUB_CELL_ERROR", reason: "configuration", message: "Cell route failed (configuration). sc too old for forward nonce; update sc" } })
    expect(result.seen).toEqual([])
    expect(result.forwardRequests).toEqual([])
    expect(result.direct).toBe("")
    expect(result.stderr).not.toContain('"path":"direct"')
  })
  test("capability results accept extra fields and are cached once per command", async () => {
    const result = await scenario({ via: "cell", capability: "extra", mode: "parallel" })
    expect(result.exit).toBe(0)
    expect(result.probes).toBe(1)
    expect(result.nonces).toHaveLength(1)
    expect(result.forwardRequests).toHaveLength(2)
  })
  test("capability refusals are cached for standalone adapter attempts too", async () => {
    const result = await scenario({ via: "cell", capability: "old", mode: "nonce-refusal" })
    expect(result.exit).toBe(0)
    expect(JSON.parse(result.stdout).errors).toEqual(Array(2).fill({ reason: "configuration", message: "Cell route failed (configuration). sc too old for forward nonce; update sc" }))
    expect(result.probes).toBe(1)
    expect(result.nonces).toEqual([])
    expect(result.seen).toEqual([])
  })
  test("aborts and timeouts retain their kinds without reflecting transport diagnostics", async () => {
    const result = await scenario({ via: "cell", mode: "transport-errors" })
    expect(result.exit).toBe(0)
    expect(JSON.parse(result.stdout).errors).toEqual([
      { name: "AbortError", message: "cell forward request aborted" },
      { name: "TimeoutError", message: "cell forward request timed out" },
    ])
    expect(result.stdout + result.stderr).not.toContain("fixture transport details")
    expect(result.seen).toEqual([])
  })
  for (const cliArgs of [["status", "example/project"], ["comment", "example/project", "1", "--body", "fixture"]]) test(`${cliArgs[0]} preserves a typed nonce refusal and exits nonzero`, async () => {
    const result = await scenario({ via: "cell", fallback: "direct", mode: "nonce-refusal", cli: true, cliArgs })
    expect(result.exit).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: "GITHUB_CELL_ERROR", reason: "client", message: "Cell route failed (client). cell forward rejected the run nonce; rerun" } })
    expect(result.forwardRequests).toHaveLength(1)
    expect(result.direct).toBe("")
  })
  test("separate command runs generate different 32-byte nonces", async () => {
    const first = await scenario({ via: "cell", mode: "nonce-echo" })
    const second = await scenario({ via: "cell", mode: "nonce-echo" })
    expect(first.exit).toBe(0)
    expect(second.exit).toBe(0)
    expect(first.nonces).toHaveLength(1)
    expect(second.nonces).toHaveLength(1)
    expect(first.nonces[0]!.nonce).not.toBe(second.nonces[0]!.nonce)
    expect(first.forwardRequests).toHaveLength(1)
    expect(second.forwardRequests).toHaveLength(1)
  })
  test("forward nonce refusal is a terminal client error without retry or fallback", async () => {
    const result = await scenario({ via: "cell", fallback: "direct", mode: "nonce-refusal" })
    expect(result.exit).toBe(0)
    expect(JSON.parse(result.stdout).errors).toEqual(Array(2).fill({ reason: "client", message: "Cell route failed (client). cell forward rejected the run nonce; rerun" }))
    expect(result.forwardRequests).toHaveLength(1)
    expect(result.nonces).toHaveLength(1)
    expect(result.seen).toEqual([])
    expect(result.direct).toBe("")
  })
  test("echoed nonce headers and response bodies are redacted before callers see them", async () => {
    const result = await scenario({ via: "cell", mode: "nonce-echo" })
    expect(result.exit).toBe(0)
    const output = JSON.parse(result.stdout)
    expect(output.headers).not.toHaveProperty("x-sc-forward-token")
    expect(output.headers["x-echo"]).toBe("[REDACTED]")
    expect(JSON.parse(output.body).headers["x-sc-forward-token"]).toBe("[REDACTED]")
  })
  test("explicit direct uses direct auth, logs direct and never starts sc", async () => {
    const result = await scenario({ via: "direct" })
    expect(result.exit).toBe(0)
    expect(JSON.parse(result.stdout).data.direct).toBe(true)
    expect(result.stderr).toContain('"path":"direct"')
    expect(result.stderr).not.toContain('"path":"cell"')
    expect(result.argv).toBe("")
    expect(result.seen).toEqual([])
    expect(result.direct).toContain("/app/installations/123/access_tokens")
  })
  test("unset route with fleet identity defaults to cell without loading direct credentials", async () => {
    const result = await scenario({})
    expect(result.exit).toBe(0)
    expect(JSON.parse(result.stdout).data.cell).toBe(true)
    expect(result.stderr.trim()).toBe('{"event":"github-route","path":"cell","reason":"requested"}')
    expect(result.direct).toBe("")
    expect(result.seen.map((request) => request.path)).toEqual(["/v1/describe", "/v1/u/api.github.com/repos/example/project"])
  })
  for (const mode of ["repo", "org"]) test(`${mode} success uses ${process.env.SHITRAT_TEST_SC_BIN ? "real-client signing" : "fixture-contract forwarding"} only`, async () => {
    const result = await scenario({ via: "cell", mode })
    expect(result.exit).toBe(0)
    expect(JSON.parse(result.stdout).data.cell).toBe(true)
    expect(result.direct).toBe("")
    expect(result.stderr.trim()).toBe('{"event":"github-route","path":"cell","reason":"requested"}')
    expect(result.seen.at(-1)).toMatchObject({ path: "/v1/u/api.github.com/repos/example/project", authorization: "Bearer {{secret:shitrat-github/example}}" })
    expect(result.seen.every((request) => !!request.auth)).toBe(true)
  })
  for (const mode of ["twice", "parallel", "throw-after-request"]) test(`${mode} reuses one forward and closes it at command exit`, async () => {
    const result = await scenario({ via: "cell", mode })
    expect(result.exit).toBe(mode === "throw-after-request" ? 1 : 0)
    expect(result.direct).toBe("")
    expect(result.seen.filter((request) => request.path.startsWith("/v1/u/"))).toHaveLength(2)
    // The contract fixture records each child spawn, not each request.
    if (!process.env.SHITRAT_TEST_SC_BIN) {
      expect(result.forwardRequests).toHaveLength(2)
      expect(new Set(result.forwardRequests.map((request) => request.token)).size).toBe(1)
      const forwards: string[][] = result.argv.trim().split("\n").map((line) => JSON.parse(line)).filter((args) => args.includes("forward") && !args.includes("--capabilities"))
      expect(forwards).toHaveLength(1)
      const args = forwards[0]!
      const listen = args[args.indexOf("--listen") + 1]!
      await expect(fetch(`http://${listen}/`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow()
    }
  })
  test("an exited forward refuses later calls before fetching a replacement listener", async () => {
    const result = await scenario({ via: "cell", mode: "dead-forward" })
    expect(result.exit).toBe(0)
    const output = JSON.parse(result.stdout)
    expect(output.errors).toHaveLength(2)
    for (const error of output.errors) {
      expect(error.reason).toBe("client")
      expect(error.message).toContain("cell forward exited mid-command; rerun")
    }
    expect(output.replacementFetches).toBe(0)
    expect(output.forwardSpawns).toBe(1)
    expect(result.seen).toHaveLength(1)
    expect(result.direct).toBe("")
  })
  test("cell setup and forwarding refuse non-Bun runtimes as configuration", async () => {
    const result = await scenario({ via: "cell", mode: "no-bun" })
    expect(result.exit).toBe(0)
    const errors = JSON.parse(result.stdout).errors
    expect(errors).toHaveLength(2)
    for (const error of errors) {
      expect(error.reason).toBe("configuration")
      expect(error.message).toContain("cell route needs Bun")
    }
    expect(result.argv).toBe("")
    expect(result.seen).toEqual([])
    expect(result.direct).toBe("")
  })
  for (const cliArgs of [
    ["cancel-runs", "example/project", "--workflow", "preview.yml", "--created-before", "2020-01-01T00:00:00Z", "--yes"],
    ["delete-branch", "example/project", "--branch", "old-branch", "--yes"],
  ]) test(`${cliArgs[0]} refuses unavailable cell permission metadata explicitly`, async () => {
    const result = await scenario({ via: "cell", cli: true, cliArgs })
    expect(result.exit).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: "GITHUB_CELL_ERROR" } })
    expect(result.stdout).toContain("unsupported")
    expect(result.stdout).toContain("cell mode")
    expect(result.stdout).not.toContain("Installation token lacks")
    expect(result.direct).toBe("")
    expect(result.seen.map((request) => request.path)).toEqual(["/v1/describe"])
    expect(result.argv).not.toContain("--listen")
  })
  test("direct-mode status retains installation_id from the selected token", async () => {
    const result = await scenario({ via: "direct", cli: true })
    expect(result.exit).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, result: { repo: "example/project", installation_id: 123 } })
    expect(result.direct).toContain("/app/installations/123/access_tokens")
    expect(result.argv).toBe("")
    expect(result.seen).toEqual([])
    expect(result.stderr).toContain('{"event":"github-route","path":"direct","reason":"selected"}')
  })
  for (const via of [undefined, "cell"]) test(`status CLI works without direct installation discovery (via=${via ?? "unset"})`, async () => {
    const result = await scenario({ ...(via === undefined ? {} : { via }), cli: true })
    expect(result.exit).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, result: { repo: "example/project" } })
    expect(result.direct).toBe("")
    expect(result.seen).toHaveLength(2)
  })
  test("buffered API response exposes the original GitHub URL including query", async () => {
    const result = await scenario({ via: "cell", mode: "response-url" })
    expect(result.exit).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ url: "https://api.github.com/repos/example/project?per_page=2&page=3", data: { cell: true } })
    expect(result.direct).toBe("")
  })
  test("malformed and non-GitHub fetch URLs refuse as unsupported before starting a forward", async () => {
    const result = await scenario({ via: "cell", mode: "invalid-urls" })
    expect(result.exit).toBe(0)
    const errors = JSON.parse(result.stdout).errors
    expect(errors).toHaveLength(4)
    expect(errors.every((error: { reason: string }) => error.reason === "unsupported")).toBe(true)
    expect(result.argv).toBe("")
    expect(result.seen).toEqual([])
    expect(result.direct).toBe("")
  })
  test("checks CLI preserves logical response URLs through check-run and combined-status pagination", async () => {
    const sha = "a".repeat(40)
    const result = await scenario({ via: "cell", cli: true, cliArgs: ["checks", "example/project", sha] })
    expect(result.stdout).toContain('"ok": true')
    expect(result.exit).toBe(0)
    const envelope = JSON.parse(result.stdout)
    expect(envelope).toMatchObject({ ok: true, result: { summary: { verdict: "success", total: 4 } } })
    expect(envelope.result.check_runs.map((run: { name: string }) => run.name)).toEqual(["check-1", "check-2"])
    expect(envelope.result.combined_status.statuses.map((status: { context: string }) => status.context)).toEqual(["status-1", "status-2"])
    const calls = result.seen.filter((request) => request.path.startsWith("/v1/u/"))
    expect(calls.map((request) => [request.path, new URLSearchParams(request.search).get("page") ?? "1"])).toEqual([
      [`/v1/u/api.github.com/repos/example/project/commits/${sha}/check-runs`, "1"],
      [`/v1/u/api.github.com/repos/example/project/commits/${sha}/check-runs`, "2"],
      [`/v1/u/api.github.com/repos/example/project/commits/${sha}/status`, "1"],
      [`/v1/u/api.github.com/repos/example/project/commits/${sha}/status`, "2"],
    ])
    expect(result.direct).toBe("")
    expect(calls.every((request) => request.authorization === "Bearer {{secret:shitrat-github/example}}")).toBe(true)
    if (!process.env.SHITRAT_TEST_SC_BIN) expect(result.argv.trim().split("\n").map((line) => JSON.parse(line)).filter((args: string[]) => args.includes("forward") && !args.includes("--capabilities"))).toHaveLength(1)
  })
  test("runners CLI follows a GitHub next link through the same cell forward", async () => {
    const result = await scenario({ via: "cell", cli: true, cliArgs: ["runners", "--repo", "example/project"] })
    expect(result.stdout).toContain('"ok": true')
    expect(result.exit).toBe(0)
    const envelope = JSON.parse(result.stdout)
    expect(envelope).toMatchObject({ ok: true, result: { count: 2 } })
    expect(envelope.result.runners.map((runner: { name: string }) => runner.name)).toEqual(["runner-1", "runner-2"])
    const calls = result.seen.filter((request) => request.path.endsWith("/actions/runners"))
    expect(calls.map((request) => new URLSearchParams(request.search).get("page") ?? "1")).toEqual(["1", "2"])
    expect(result.direct).toBe("")
    expect(result.seen).toHaveLength(3)
    if (!process.env.SHITRAT_TEST_SC_BIN) expect(result.argv.trim().split("\n").map((line) => JSON.parse(line)).filter((args: string[]) => args.includes("forward") && !args.includes("--capabilities"))).toHaveLength(1)
  })
  for (const runnerFailure of [
    { status: 403, headers: { "x-ratelimit-remaining": "0" }, message: "fixture-response" },
    { status: 403, headers: { "retry-after": "30" }, message: "fixture-response" },
    { status: 403, message: "You have exceeded a secondary rate limit: fixture-response" },
    { status: 429, message: "fixture-response" },
  ]) test(`runners CLI reports rate limits without permission advice (${JSON.stringify(runnerFailure)})`, async () => {
    const result = await scenario({ cli: true, cliArgs: ["runners", "--org", "example"], runnerFailure })
    expect(result.exit).toBe(1)
    expect(JSON.parse(result.stdout)).toEqual({ ok: false, command: "shitrat runners", result: null,
      error: { code: "ORG_RUNNERS_RATE_LIMITED", message: `GET /orgs/{org}/actions/runners: HTTP ${runnerFailure.status}; rate limited; retry later.` },
      fix: "Retry later after the GitHub rate limit clears.", next_actions: [] })
    expect(result.stdout).not.toContain("requires")
    expect(result.stdout).not.toContain("fixture-response")
    expect(result.direct).toBe("")
    const reads = result.seen.filter((request) => request.path.startsWith("/v1/u/"))
    expect(reads).toHaveLength(2)
    expect(reads.every((request) => request.method === "GET")).toBe(true)
  })
  test("runners CLI keeps the permission hint for a plain 403", async () => {
    const result = await scenario({ cli: true, cliArgs: ["runners", "--org", "example"], runnerFailure: { status: 403, message: "fixture-response" } })
    expect(result.exit).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: "ORG_RUNNERS_FAILED", message: "GET /orgs/{org}/actions/runners: HTTP 403; requires organization_self_hosted_runners: read. Stop; do not change app permissions." } })
    expect(result.stdout).not.toContain("fixture-response")
    expect(result.direct).toBe("")
  })
  test("runner-jobs CLI defaults to the cell, paginates and keeps one shared forward", async () => {
    const result = await scenario({ cli: true, cliArgs: ["runner-jobs", "--org", "example"] })
    expect(result.exit).toBe(0)
    const envelope = JSON.parse(result.stdout)
    expect(envelope).toMatchObject({ ok: true, command: "shitrat runner-jobs", next_actions: [], result: { org: "example", count: 16, errors: [], truncated: [] } })
    expect(envelope.result.jobs[0]).toEqual({ repo: "example/project-1", runId: 1, jobId: 1, name: "build", status: "queued", labels: ["self-hosted", "linux", "pool-a"], runnerName: "runner-1", runnerGroupName: "pool-a", createdAt: "2026-01-01T00:00:00Z", startedAt: null })
    const calls = result.seen.filter((request) => request.path.startsWith("/v1/u/"))
    expect(calls).toHaveLength(26)
    expect(calls.every((request) => request.method === "GET" && request.authorization === "Bearer {{secret:shitrat-github/example}}")).toBe(true)
    expect(result.direct).toBe("")
    expect(result.nonces).toHaveLength(1)
  })
  test("runner-jobs CLI invalid cap emits failure JSON and exits 1 before auth", async () => {
    const result = await scenario({ cli: true, cliArgs: ["runner-jobs", "--org", "example", "--max-runs", "0"] })
    expect(result.exit).toBe(1)
    expect(JSON.parse(result.stdout)).toEqual({ ok: false, command: "shitrat runner-jobs", result: null,
      error: { code: "RUNNER_JOBS_FAILED", message: "--max-runs must be a positive safe integer: request failed" },
      fix: "Check the existing App installation and Actions read access. Do not add App permissions.", next_actions: [] })
    expect(result.seen).toEqual([])
    expect(result.direct).toBe("")
  })
  test("runner-jobs CLI accepts repeated repo and status flags and a run cap", async () => {
    const result = await scenario({ cli: true, cliArgs: ["runner-jobs", "--org", "example", "--repo", "example/one", "--repo", "example/two", "--status", "queued", "--status", "in_progress", "--max-runs", "1"] })
    expect(result.exit).toBe(0)
    const envelope = JSON.parse(result.stdout)
    expect(envelope.result.count).toBe(8)
    expect(envelope.result.errors).toEqual([])
    expect(envelope.result.truncated).toEqual([
      { repo: "example/one", status: "queued" }, { repo: "example/one", status: "in_progress" },
      { repo: "example/two", status: "queued" }, { repo: "example/two", status: "in_progress" },
    ])
    expect([...new Set(envelope.result.jobs.map((job: { repo: string }) => job.repo))]).toEqual(["example/one", "example/two"])
    expect(result.seen.some((request) => request.path.endsWith("/installation/repositories"))).toBe(false)
    expect(result.seen.filter((request) => request.path.endsWith("/actions/runs"))).toHaveLength(4)
    expect(result.direct).toBe("")
  })
  for (const config of [{ missingIdentity: true }, { identityFile: "/fixture/identity.json" }]) test(`identity source refuses invalid configuration ${JSON.stringify(config)}`, async () => {
    const result = await scenario({ via: "cell", ...config })
    expect(result.exit).toBe(1)
    expect(result.direct).toBe("")
    expect(result.seen).toEqual([])
    expect(result.argv).not.toContain("--listen")
  })
  for (const config of [{ missingDocument: true }, { documentMismatch: "did" as const }, { documentMismatch: "key" as const }]) test(`caller document pin refuses before sc ${JSON.stringify(config)}`, async () => {
    const result = await scenario({ via: "cell", ...config })
    expect(result.exit).toBe(1)
    expect(result.direct).toBe("")
    expect(result.seen).toEqual([])
    expect(result.argv).not.toContain("--listen")
  })
  test("refusal never silently falls back", async () => {
    const result = await scenario({ via: "cell", refusal: true })
    expect(result.exit).toBe(1)
    expect(result.direct).toBe("")
    expect(result.stderr).not.toContain('"path":"direct"')
    expect(result.seen.map((request) => request.path)).toEqual(["/v1/describe"])
  })
  test("explicit fallback logs path and a bounded reason", async () => {
    const result = await scenario({ via: "cell", fallback: "direct", refusal: true })
    expect(result.exit).toBe(0)
    expect(JSON.parse(result.stdout).data.direct).toBe(true)
    expect(result.stderr).toContain('{"event":"github-route","path":"direct","reason":"cell-refused"}')
  })
  for (const [mode, name] of [["fallback-write-timeout", "TimeoutError"], ["fallback-write-abort", "AbortError"], ["fallback-write-upstream", "Error"]] as const) test(`${mode} propagates reply-loss/upstream errors without replay; not a phase-guard proof`, async () => {
    const result = await scenario({ fallback: "direct", mode, ...(mode === "fallback-write-upstream" ? { fetchRefusal: true } : {}) })
    expect(result.exit).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ directCalls: 0, error: { name } })
    expect(result.seen).toHaveLength(1)
    expect(result.seen[0]!.method).toBe("POST")
    expect(result.seen[0]!.body.toString()).toBe('{"title":"fixture write"}')
    expect(result.direct).toBe("")
    expect(result.stderr).not.toContain('"path":"direct"')
  })
  for (const mode of ["fallback-configuration", "fallback-forward-start"]) test(`${mode} still permits explicit setup fallback`, async () => {
    const result = await scenario({ fallback: "direct", mode, ...(mode === "fallback-forward-start" ? { forwardFailure: true } : {}) })
    expect(result.exit).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ directCalls: 1 })
    expect(result.seen).toEqual([])
    expect(result.stderr).toContain('"path":"direct"')
  })
  test("a Git push failure after reaching the forward never replays through direct", async () => {
    await scenario({ fallback: "direct", mode: "fallback-git-push", fetchRefusal: true, git: async (home, run) => {
      const local = path.join(home, "local")
      for (const args of [
        ["init", "-b", "main", local],
        ["-C", local, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture"],
      ]) {
        const proc = Bun.spawn(["git", ...args], { stdout: "ignore", stderr: "ignore" })
        expect(await proc.exited).toBe(0)
      }
      const result = await run(["push", "https://github.com/example/project.git", "HEAD:refs/heads/main"])
      expect(result.exit).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ directCalls: 0, error: { reason: "refused" } })
      expect(result.seen).toHaveLength(1)
      expect(result.seen[0]!.path).toBe("/v1/u/github.com/example/project.git/info/refs")
      expect(new URLSearchParams(result.seen[0]!.search).get("service")).toBe("git-receive-pack")
      expect(result.gitChildren).toHaveLength(1)
      expect(result.gitChildren[0]!.args).toContain("push")
      expect(result.direct).toBe("")
      expect(result.stderr).not.toContain('"path":"direct"')
      return result
    } })
  })
  test("an untyped setup error preserves the original error and cannot fall back", async () => {
    const result = await scenario({ fallback: "direct", mode: "fallback-untyped" })
    expect(result.exit).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ directCalls: 0, originalPreserved: true, error: { name: "Error", message: "fixture unknown failure" } })
    expect(result.seen).toEqual([])
    expect(result.direct).toBe("")
    expect(result.stderr).not.toContain('"path":"direct"')
  })
  test("missing command state rethrows the original setup error without falling back", async () => {
    const result = await scenario({ fallback: "direct", mode: "fallback-missing-store" })
    expect(result.exit).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ directCalls: 0, originalPreserved: true, error: { reason: "configuration", message: "Cell route failed (configuration). fixture missing command state" } })
    expect(result.seen).toEqual([])
    expect(result.direct).toBe("")
    expect(result.stderr).not.toContain('"path":"direct"')
  })
  for (const mode of ["fallback-unlisted-reason", "fallback-unsupported"]) test(`${mode} is outside the setup fallback allow-list`, async () => {
    const result = await scenario({ fallback: "direct", mode })
    expect(result.exit).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ directCalls: 0, error: { reason: mode === "fallback-unlisted-reason" ? "future-setup-reason" : "unsupported" } })
    expect(result.seen).toEqual([])
    expect(result.direct).toBe("")
    expect(result.stderr).not.toContain('"path":"direct"')
  })
  for (const mode of ["fallback-after-request", "fallback-app-after-request"]) test(`${mode} cannot authorize direct fallback`, async () => {
    const result = await scenario({ fallback: "direct", mode })
    expect(result.exit).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ directCalls: 0, error: {} })
    expect(result.seen).toHaveLength(1)
    expect(result.direct).toBe("")
    expect(result.stderr).not.toContain('"path":"direct"')
  })
  test("no fallback after repository requests begin, even if permitted", async () => {
    const result = await scenario({ via: "cell", fallback: "direct", fetchRefusal: true })
    expect(result.exit).toBe(1)
    expect(result.direct).toBe("")
  })
  test("refuses redirected API requests", async () => {
    const result = await scenario({ via: "cell", redirect: true })
    expect(result.exit).toBe(1)
    expect(result.direct).toBe("")
    expect(result.seen).toHaveLength(2)
  })
  test("missing client refuses without direct authentication", async () => {
    const result = await scenario({ via: "cell", unavailableClient: true })
    expect(result.exit).toBe(1)
    expect(result.direct).toBe("")
    expect(result.seen).toEqual([])
  })
  test("unavailable capability probe refuses even with explicit setup fallback", async () => {
    const result = await scenario({ via: "cell", unavailableClient: true, fallback: "direct" })
    expect(result.exit).toBe(1)
    expect(result.direct).toBe("")
    expect(result.stderr).not.toContain('"path":"direct"')
    expect(result.seen).toEqual([])
  })
  test("forwarder failure suppresses raw child diagnostics and does not replay direct", async () => {
    const result = await scenario({ via: "cell", fallback: "direct", forwardFailure: true })
    expect(result.exit).toBe(1)
    expect(result.direct).toBe("")
    expect(result.seen).toHaveLength(1)
  })
  test("unknown selectors refuse as configuration before any authentication", async () => {
    const result = await scenario({ via: "cel", cli: true })
    expect(result.exit).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: "GITHUB_CELL_ERROR", reason: "configuration" } })
    expect(result.direct).toBe("")
    expect(result.argv).toBe("")
    expect(result.seen).toEqual([])
  })
  test("App-wide operations refuse without reading the direct key", async () => {
    const result = await scenario({ via: "cell", mode: "installations" })
    expect(result.exit).toBe(1)
    expect(result.direct).toBe("")
    expect(result.stderr).toContain('"reason":"unsupported-app-operation"')
  })
  test("git invocation has only a Basic placeholder and disables redirects/helpers", () => {
    const invocation = buildCellGitInvocation({ args: ["push", "https://github.com/example/project.git", "HEAD:refs/heads/main"], placeholder: "{{secret:shitrat-github/example}}", origin: "http://127.0.0.1:12345", nonce: "fixture-run-nonce" })
    expect(invocation.args).toContain("http.followRedirects=false")
    expect(invocation.args).toContain("credential.helper=")
    expect(invocation.args).toContain("http://127.0.0.1:12345/example/project.git")
    expect(invocation.env.GIT_CONFIG_VALUE_1).toContain("{{secret-basic:user=x-access-token,password=shitrat-github/example}}")
    expect(invocation.env.GIT_CONFIG_VALUE_2).toBe("x-sc-forward-token: fixture-run-nonce")
    expect(invocation.args.join(" ")).not.toContain("fixture-run-nonce")
    expect(invocation.env).not.toHaveProperty("SHITRAT_PUSH_TOKEN")
  })
  for (const config of ["file", "missing", "fallback"] as const) for (const pushCli of [false, true]) test(`auto ${pushCli ? "push CLI dry run" : "real push"} uses ${config === "file" ? "cell" : config === "missing" ? "direct without lease or probe" : "direct fallback with explicit parent credentials stripped"}`, async () => {
    await scenario({ config: config === "fallback" ? "file" : config, pushCli, mode: "auto-push", missingIdentity: config !== "fallback", missingDocument: true, lease: "ok", gitTracing: true, parentCredentials: config === "fallback", refusal: config === "fallback", forceFakeClient: config === "fallback", git: async (home, run) => {
      const local = path.join(home, "local")
      await mkdir(path.join(home, "example"))
      const git = async (args: string[], cwd = home) => {
        const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
        const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
        if (exit !== 0) throw new Error(stderr)
        return stdout.trim()
      }
      await git(["init", "--bare", "-b", "main", "example/project.git"])
      await git(["config", "http.receivepack", "true"], path.join(home, "example/project.git"))
      await git(["init", "-b", "main", "local"])
      await git(["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture"], local)
      await git(["remote", "add", "origin", "https://github.com/example/project.git"], local)
      const sha = await git(["rev-parse", "HEAD"], local)
      const result = await run(["push", "https://github.com/example/project.git", "HEAD:refs/heads/main"])
      expect(result.exit).toBe(0)
      expect(result.gitChildren.some((child) => child.args.includes("push"))).toBe(true)
      expect(result.gitChildren.every((child) => !child.identityPresent)).toBe(true)
      expect(result.allGitChildren.length).toBeGreaterThanOrEqual(result.gitChildren.length)
      for (const child of result.allGitChildren) {
        expect(child.identityPresent).toBe(false)
        expect(child.privateKeyPresent).toBe(false)
        expect(child.passPresent).toBe(false)
        expect(child.inheritedTokenPresent).toBe(false)
        expect(child.nonceEnv).toBeNull()
        expect(child.traceKeys).toEqual([])
      }
      if (pushCli) expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, result: { dry_run: true, would_push: 1 } })
      else expect(await git(["rev-parse", "refs/heads/main"], path.join(home, "example/project.git"))).toBe(sha)
      if (config === "file") {
        expect(result.stderr).toContain('"path":"cell"')
        expect(result.direct).toBe("")
        expect(result.leases.trim().split("\n")).toHaveLength(1)
        expect(result.probes).toBe(1)
        expect(result.nonces).toHaveLength(pushCli ? 2 : 1)
        for (const forward of result.nonces) expect(forward).toMatchObject({ command: "forward", identityPresent: true, privateKeyPresent: false })
        expect(result.gitChildren.every((child) => !child.privateKeyPresent)).toBe(true)
      } else {
        expect(result.stderr).toContain('"path":"direct"')
        expect(result.leases).toBe("")
        expect(result.probes).toBe(config === "fallback" ? 1 : 0)
        if (config === "missing") expect(result.argv).toBe("")
        else expect(result.stderr).toBe('{"event":"github-route","path":"direct","reason":"cell-refused"}\n')
        expect(result.nonces).toEqual([])
        expect(result.direct).not.toBe("")
      }
      return result
    } })
  })
  for (const gitTracing of [false, true]) test(`real git smart HTTP pushes binary packs and fetches through the fake cell (parent tracing=${gitTracing})`, async () => {
    await scenario({ via: "cell", mode: "git", gitTracing, git: async (home, run) => {
      const local = path.join(home, "local")
      await mkdir(path.join(home, "example"))
      const git = async (args: string[], cwd = home) => {
        const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
        const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
        if (exit !== 0) throw new Error(stderr)
        return stdout.trim()
      }
      await git(["init", "--bare", "example/project.git"])
      await git(["config", "http.receivepack", "true"], path.join(home, "example/project.git"))
      await git(["init", "-b", "main", "local"])
      await git(["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture"], local)
      const sha = await git(["rev-parse", "HEAD"], local)
      const pushed = await run(["push", "https://github.com/example/project.git", "HEAD:refs/heads/main"])
      expect(pushed.exit).toBe(0)
      if (!process.env.SHITRAT_TEST_SC_BIN) {
        expect(pushed.probes).toBe(1)
        expect(pushed.nonces).toHaveLength(2)
        expect(new Set(pushed.nonces.map((record) => record.nonce)).size).toBe(1)
        expect(new Set(pushed.forwardRequests.map((request) => request.token)).size).toBe(1)
      }
      expect(await git(["rev-parse", "refs/heads/main"], path.join(home, "example/project.git"))).toBe(sha)
      const fetched = await run(["fetch", "https://github.com/example/project.git", "refs/heads/main:refs/remotes/cell/main"])
      expect(fetched.exit).toBe(0)
      expect(fetched.gitChildren).toHaveLength(2)
      expect(fetched.gitTrace).toBe("")
      if (!process.env.SHITRAT_TEST_SC_BIN) {
        expect(fetched.probes).toBe(2)
        expect(new Set(fetched.nonces.map((record) => record.nonce)).size).toBe(2)
      }
      expect(await git(["rev-parse", "refs/remotes/cell/main"], local)).toBe(sha)
      expect(fetched.seen.some((request) => request.body.includes(Buffer.from("PACK")))).toBe(true)
      expect(fetched.seen.filter((request) => request.path.startsWith("/v1/u/github.com")).every((request) => request.authorization === "{{secret-basic:user=x-access-token,password=shitrat-github/example}}")).toBe(true)
      return fetched
    } })
  })
})
