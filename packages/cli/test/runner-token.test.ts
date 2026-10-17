import { describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const TOKEN = "TEST-RUNNER-TOKEN-0f3c"
const INSTALLATION_TOKEN = "TEST-INSTALLATION-TOKEN-9d2a"
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } })
const readTree = async (dir: string): Promise<string> => {
  if (!existsSync(dir)) return ""
  const entries = await readdir(dir, { withFileTypes: true })
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? readTree(path.join(dir, entry.name)) : readFile(path.join(dir, entry.name), "utf8")))).join("\n")
}

const run = async (extraEnv: Record<string, string> = {}, args = ["--org", "example"], prefix: string[] = []) => {
  const home = await mkdtemp(path.join(tmpdir(), "runner-token-test-"))
  try {
    await mkdir(path.join(home, ".shitrat", "log"), { recursive: true })
    await writeFile(path.join(home, ".shitrat", "log", "attest.jsonl"), "existing-log\n")
    const auditPath = path.join(home, "audit.json")
    const argv = [process.execPath, "--preload", path.join(import.meta.dir, "fixtures/runner-token-preload.ts"), path.join(import.meta.dir, "../src/cli.ts"), ...prefix, "runner-token", ...args]
    expect(JSON.stringify(argv)).not.toContain(TOKEN)
    expect(JSON.stringify(argv)).not.toContain(INSTALLATION_TOKEN)
    const proc = Bun.spawn(argv, {
      env: {
        // Do not inherit real App credentials, secret clients, or logging configuration.
        PATH: process.env.PATH, HOME: home,
        SHITRAT_GITHUB_APP_ID: "123",
        SHITRAT_GITHUB_PRIVATE_KEY: privateKey,
        SHITRAT_GITHUB_CLIENT_ID: "test-client",
        SHITRAT_GITHUB_INSTALLATIONS_JSON: '{"example":123}',
        RUNNER_TEST_AUDIT: auditPath,
        ...extraEnv,
      },
      stdout: "pipe", stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    const audit = JSON.parse(await readFile(auditPath, "utf8"))
    const files = await readTree(path.join(home, ".shitrat"))
    expect(audit.spawned).toEqual([])
    expect(JSON.stringify(audit)).not.toContain(TOKEN)
    expect(JSON.stringify(audit)).not.toContain(INSTALLATION_TOKEN)
    expect(files).toBe("existing-log\n")
    for (const text of [stderr, files]) {
      expect(text).not.toContain(TOKEN)
      expect(text).not.toContain(INSTALLATION_TOKEN)
    }
    expect(stdout).not.toContain(INSTALLATION_TOKEN)
    return { stdout, stderr, exitCode, requests: audit.requests }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

describe("runner-token CLI secret output boundary", () => {
  test("only stdout contains the fake registration token, exactly once and with a newline", async () => {
    const result = await run()
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe(`${TOKEN}\n`)
    expect(result.stderr).toBe("expires_at: 2026-10-17T20:00:00Z\n")
    expect(result.requests).toEqual(["POST /app/installations/123/access_tokens", "POST /orgs/example/actions/runners/registration-token"])
  })
  test("global logging options before the verb cannot wrap or log the token", async () => {
    const result = await run({}, ["--org", "example"], ["--log-level", "debug"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe(`${TOKEN}\n`)
    expect(result.stderr).toBe("expires_at: 2026-10-17T20:00:00Z\n")
  })
  test("a 403 containing both credentials leaks neither and exits nonzero", async () => {
    const result = await run({ RUNNER_TEST_FAILURE: "1" })
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("HTTP 403")
    expect(result.stderr).toContain("organization_self_hosted_runners: write")
  })
  test("invalid response metadata cannot smuggle the token to stderr", async () => {
    const result = await run({ RUNNER_TEST_INVALID: "1" })
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).not.toContain(TOKEN)
  })
  test("usage errors leave stdout empty and do not authenticate", async () => {
    const result = await run({}, [])
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toBe("")
    expect(result.requests).toEqual([])
  })
  test("help stays on stderr and does not authenticate", async () => {
    const result = await run({}, ["--help"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("--org")
    expect(result.requests).toEqual([])
  })
})
