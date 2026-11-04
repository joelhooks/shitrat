import { describe, expect, test } from "bun:test"
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildCellGitInvocation } from "../src/git-push.js"

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } })
const signing = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "jwk" })
const identity = JSON.stringify({ did: "did:web:fixture.example.invalid", signing })
const fixture = path.join(import.meta.dir, "fixtures/cell-client.ts")
const readOrEmpty = async (file: string) => readFile(file, "utf8").catch(() => "")
type Seen = { path: string; authorization: string | null; auth: string | null; body: Buffer }

const scenario = async (input: {
  via?: string
  fallback?: string
  refusal?: boolean
  fetchRefusal?: boolean
  redirect?: boolean
  mode?: string
  missingIdentity?: boolean
  identityFile?: string
  cli?: boolean
  forwardFailure?: boolean
  unavailableClient?: boolean
  missingDocument?: boolean
  documentMismatch?: "did" | "key"
  git?: (home: string, run: (args: string[]) => Promise<Result>) => Promise<Result>
}) => {
  const home = await mkdtemp(path.join(tmpdir(), "shitrat-cell-test-"))
  await chmod(fixture, 0o755)
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
      if (process.env.SHITRAT_TEST_SC_BIN && !input.forwardFailure) {
        const token = request.headers.get("x-sc-auth") ?? ""
        const [header, payload, signature] = token.split(".")
        expect(header && payload && signature).toBeTruthy()
        expect(verify("sha256", Buffer.from(`${header}.${payload}`), { key: createPublicKey({ key: signing, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(signature!, "base64url"))).toBe(true)
        expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toMatchObject({ aud: "did:web:cell.example.invalid", iss: "did:web:fixture.example.invalid" })
      }
      seen.push({ path: url.pathname, authorization: request.headers.get("authorization"), auth: request.headers.get("x-sc-auth"), body: Buffer.from(await request.arrayBuffer()) })
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
      return Response.json({ full_name: "example/project", cell: true })
    },
  })
  const run = async (args: string[] = []): Promise<Result> => {
    const proc = Bun.spawn([process.execPath, "--preload", path.join(import.meta.dir, "fixtures/cell-direct-preload.ts"), ...(input.cli ? [path.join(import.meta.dir, "../src/cli.ts"), "status", "example/project"] : [path.join(import.meta.dir, "fixtures/cell-driver.ts"), input.mode ?? "repo"])], {
      env: {
        PATH: process.env.PATH, HOME: home,
        SC_URL: server.url.origin, SC_AUDIENCE: "did:web:cell.example.invalid",
        ...(!input.missingIdentity ? { SC_IDENTITY_JSON: identity } : {}),
        ...(input.identityFile ? { SHITRAT_CELL_IDENTITY_FILE: input.identityFile } : {}),
        ...(!input.missingDocument ? { SHITRAT_CELL_CALLER_DOCUMENT_FILE: documentFile } : {}),
        SHITRAT_SC_BIN: input.unavailableClient ? path.join(home, "missing-sc") : input.forwardFailure ? fixture : process.env.SHITRAT_TEST_SC_BIN ?? fixture,
        ...(input.forwardFailure ? { CELL_TEST_FORWARD_FAIL: "1" } : {}),
        ...(input.via ? { SHITRAT_GITHUB_VIA: input.via } : {}),
        ...(input.fallback ? { SHITRAT_GITHUB_CELL_FALLBACK: input.fallback } : {}),
        SHITRAT_GITHUB_APP_ID: "123", SHITRAT_GITHUB_PRIVATE_KEY: privateKey, SHITRAT_GITHUB_CLIENT_ID: "fixture-client", SHITRAT_GITHUB_INSTALLATIONS_JSON: '{"example":123}',
        CELL_TEST_DIRECT: path.join(home, "direct"), CELL_TEST_ARGV: path.join(home, "argv"),
        CELL_TEST_GIT_ARGS: JSON.stringify(args), CELL_TEST_GIT_CWD: path.join(home, "local"),
      },
      stdout: "pipe", stderr: "pipe",
    })
    const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    const argv = await readOrEmpty(path.join(home, "argv"))
    for (const secret of [privateKey, signing.d!, "FAKE-INSTALLATION-TOKEN", identity]) expect(stdout + stderr + argv).not.toContain(secret)
    return { stdout, stderr, exit, argv, direct: await readOrEmpty(path.join(home, "direct")), seen }
  }
  try {
    if (input.git) return await input.git(home, run)
    return await run()
  } finally {
    server.stop(true)
    await rm(home, { recursive: true, force: true })
  }
}
type Result = { stdout: string; stderr: string; exit: number; argv: string; direct: string; seen: Seen[] }

describe("GitHub cell route", () => {
  test("no opt-in uses direct auth, logs direct and never starts sc", async () => {
    const result = await scenario({})
    expect(result.exit).toBe(0)
    expect(JSON.parse(result.stdout).data.direct).toBe(true)
    expect(result.stderr).toContain('"path":"direct"')
    expect(result.stderr).not.toContain('"path":"cell"')
    expect(result.argv).toBe("")
    expect(result.seen).toEqual([])
    expect(result.direct).toContain("/app/installations/123/access_tokens")
  })
  for (const mode of ["repo", "org"]) test(`${mode} success goes through signed client forwarding only`, async () => {
    const result = await scenario({ via: "cell", mode })
    expect(result.exit).toBe(0)
    expect(JSON.parse(result.stdout).data.cell).toBe(true)
    expect(result.direct).toBe("")
    expect(result.stderr.trim()).toBe('{"event":"github-route","path":"cell","reason":"requested"}')
    expect(result.seen.at(-1)).toMatchObject({ path: "/v1/u/api.github.com/repos/example/project", authorization: "Bearer {{secret:shitrat-github/example}}" })
    expect(result.seen.every((request) => !!request.auth)).toBe(true)
  })
  test("status CLI works without direct installation discovery", async () => {
    const result = await scenario({ via: "cell", cli: true })
    expect(result.exit).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, result: { repo: "example/project" } })
    expect(result.direct).toBe("")
    expect(result.seen).toHaveLength(2)
  })
  for (const config of [{ missingIdentity: true }, { identityFile: "/fixture/identity.json" }]) test(`identity source refuses invalid configuration ${JSON.stringify(config)}`, async () => {
    const result = await scenario({ via: "cell", ...config })
    expect(result.exit).toBe(1)
    expect(result.direct).toBe("")
    expect(result.seen).toEqual([])
    expect(result.argv).toBe("")
  })
  for (const config of [{ missingDocument: true }, { documentMismatch: "did" as const }, { documentMismatch: "key" as const }]) test(`caller document pin refuses before sc ${JSON.stringify(config)}`, async () => {
    const result = await scenario({ via: "cell", ...config })
    expect(result.exit).toBe(1)
    expect(result.direct).toBe("")
    expect(result.seen).toEqual([])
    expect(result.argv).toBe("")
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
  test("explicit missing-client fallback logs cell-client", async () => {
    const result = await scenario({ via: "cell", unavailableClient: true, fallback: "direct" })
    expect(result.exit).toBe(0)
    expect(result.stderr).toContain('"reason":"cell-client"')
    expect(JSON.parse(result.stdout).data.direct).toBe(true)
  })
  test("forwarder failure suppresses raw child diagnostics and does not replay direct", async () => {
    const result = await scenario({ via: "cell", fallback: "direct", forwardFailure: true })
    expect(result.exit).toBe(1)
    expect(result.direct).toBe("")
    expect(result.seen).toHaveLength(1)
  })
  test("invalid selectors fail closed", async () => {
    const result = await scenario({ via: "cel" })
    expect(result.exit).toBe(1)
    expect(result.direct).toBe("")
    expect(result.seen).toEqual([])
  })
  test("App-wide operations refuse without reading the direct key", async () => {
    const result = await scenario({ via: "cell", mode: "installations" })
    expect(result.exit).toBe(1)
    expect(result.direct).toBe("")
    expect(result.stderr).toContain('"reason":"unsupported-app-operation"')
  })
  test("git invocation has only a Basic placeholder and disables redirects/helpers", () => {
    const invocation = buildCellGitInvocation({ args: ["push", "https://github.com/example/project.git", "HEAD:refs/heads/main"], placeholder: "{{secret:shitrat-github/example}}", origin: "http://127.0.0.1:12345" })
    expect(invocation.args).toContain("http.followRedirects=false")
    expect(invocation.args).toContain("credential.helper=")
    expect(invocation.args).toContain("http://127.0.0.1:12345/example/project.git")
    expect(invocation.args.join(" ")).toContain("{{secret-basic:user=x-access-token,password=shitrat-github/example}}")
    expect(invocation.env).not.toHaveProperty("SHITRAT_PUSH_TOKEN")
  })
  test("real git smart HTTP pushes binary packs and fetches through the fake cell", async () => {
    await scenario({ via: "cell", mode: "git", git: async (home, run) => {
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
      expect(await git(["rev-parse", "refs/heads/main"], path.join(home, "example/project.git"))).toBe(sha)
      const fetched = await run(["fetch", "https://github.com/example/project.git", "refs/heads/main:refs/remotes/cell/main"])
      expect(fetched.exit).toBe(0)
      expect(await git(["rev-parse", "refs/remotes/cell/main"], local)).toBe(sha)
      expect(fetched.seen.some((request) => request.body.includes(Buffer.from("PACK")))).toBe(true)
      expect(fetched.seen.filter((request) => request.path.startsWith("/v1/u/github.com")).every((request) => request.authorization === "{{secret-basic:user=x-access-token,password=shitrat-github/example}}")).toBe(true)
      return fetched
    } })
  })
})
