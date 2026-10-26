import { describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } })
const cutoff = ["--workflow", "preview.yml", "--created-before", "2026-10-25T00:00:00Z"]
const run = async (scenario = "default", args = [...cutoff, "--yes"]) => {
  const home = await mkdtemp(path.join(tmpdir(), "shitrat-cancel-runs-test-"))
  try {
    const audit = path.join(home, "requests.json")
    const customLog = path.join(home, "custom", "cancels.jsonl")
    const proc = Bun.spawn([process.execPath, "--preload", path.join(import.meta.dir, "fixtures/cancel-runs-preload.ts"), path.join(import.meta.dir, "../src/cli.ts"), "cancel-runs", ...args.map((arg) => arg === "LOG" ? customLog : arg), "example/project"], {
      env: { PATH: process.env.PATH, HOME: home, SHITRAT_GITHUB_APP_ID: "123", SHITRAT_GITHUB_PRIVATE_KEY: privateKey, SHITRAT_GITHUB_CLIENT_ID: "test-client", SHITRAT_GITHUB_INSTALLATIONS_JSON: '{"example":123}', CANCEL_RUNS_TEST_AUDIT: audit, CANCEL_RUNS_TEST_SCENARIO: scenario },
      stdout: "pipe", stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    expect(stdout + stderr).not.toContain("FAKE-INSTALLATION-TOKEN")
    expect(stdout + stderr).not.toContain(privateKey)
    const requests: string[] = JSON.parse(await readFile(audit, "utf8"))
    const logPath = args.includes("LOG") ? customLog : path.join(home, ".local/state/shitrat/run-cancels.jsonl")
    const rawLog = await readFile(logPath, "utf8").catch(() => "")
    expect(rawLog).not.toContain("FAKE-INSTALLATION-TOKEN")
    expect(rawLog).not.toContain(privateKey)
    const log = rawLog.trim() ? rawLog.trim().split("\n").map((line) => JSON.parse(line)) : []
    const logMode = await stat(logPath).then((s) => s.mode & 0o777).catch(() => null)
    const dirMode = await stat(path.dirname(logPath)).then((s) => s.mode & 0o777).catch(() => null)
    const posts = requests.filter((r) => r.startsWith("POST /repos/"))
    return { envelope: JSON.parse(stdout), exitCode, requests, posts, log, logMode, dirMode }
  } finally { await rm(home, { recursive: true, force: true }) }
}
const cancelOf = (id: number) => `POST /repos/example/project/actions/runs/${id}/cancel`

describe("cancel-runs CLI (fake HTTP)", () => {
  test("pending and queued runs before the cutoff cancel and read back cancelled, oldest first", async () => {
    const r = await run()
    expect(r.exitCode).toBe(0)
    expect(r.envelope).toMatchObject({ ok: true, result: { dry_run: false, github_write: true, counts: { cancelled: 2, refused: 0, failed: 0 } } })
    expect(r.posts).toEqual([cancelOf(201), cancelOf(101)])
    expect(r.requests.filter((route) => route.endsWith("/runs/101"))).toHaveLength(2)
    expect(r.log).toEqual(r.envelope.result.results)
    expect(r.log[1]).toMatchObject({ repo: "example/project", run_id: 101, workflow: "preview.yml", head_sha: "101".padStart(40, "0"), created_at: "2026-10-23T00:00:00Z", status_before: "pending", outcome: "cancelled", timestamp: "2026-10-26T00:00:00.000Z", cli_version: "0.1.0" })
    expect(r.requests).toContain("GET /repos/example/project/actions/workflows/preview.yml/runs?status=waiting")
  })
  test("runs at or after the cutoff are skipped, never posted or logged", async () => {
    const r = await run()
    expect(r.posts).not.toContain(cancelOf(102))
    expect(r.posts).not.toContain(cancelOf(103))
    expect(r.log.map((l) => l.run_id)).toEqual([201, 101])
    expect(r.envelope.result.skipped_after_cutoff).toBe(2)
  })
  test("--status narrows the listed states", async () => {
    const r = await run("default", [...cutoff, "--status", "pending", "--yes"])
    expect(r.posts).toEqual([cancelOf(101)])
    expect(r.requests.filter((route) => route.includes("/workflows/"))).toEqual(["GET /repos/example/project/actions/workflows/preview.yml/runs?status=pending"])
  })
  test("an in_progress run listed as pending never gets a POST", async () => {
    const r = await run("listed-in-progress")
    expect(r.exitCode).not.toBe(0)
    expect(r.posts).not.toContain(cancelOf(104))
    expect(r.requests.some((route) => route.includes("/runs/104"))).toBe(false)
    expect(r.log[0]).toMatchObject({ run_id: 104, outcome: "refused:StatusNotWaiting", cancel_attempted: false })
    expect(r.envelope.result.counts).toMatchObject({ refused: 1, cancelled: 2 })
  })
  test("a run that started between list and cancel refuses StatusChanged; the batch continues and exits nonzero", async () => {
    const r = await run("started")
    expect(r.exitCode).not.toBe(0)
    expect(r.envelope.ok).toBe(false)
    expect(r.posts).toEqual([cancelOf(201)])
    expect(r.log.map((l) => l.outcome)).toEqual(["cancelled", "refused:StatusChanged"])
    expect(r.envelope.result.counts).toMatchObject({ cancelled: 1, refused: 1, failed: 0 })
    expect(r.envelope.next_actions.length).toBeGreaterThan(0)
  })
  for (const args of [cutoff, [...cutoff, "--dry-run"], [...cutoff, "--dry-run", "--yes"]]) test(`dry run sends no POST and logs would-cancel (${args.slice(4).join(" ") || "default"})`, async () => {
    const r = await run("default", args)
    expect(r.exitCode).toBe(0)
    expect(r.posts).toEqual([])
    expect(r.requests.some((route) => route.includes("/actions/runs/"))).toBe(false)
    expect(r.envelope.result).toMatchObject({ dry_run: true, github_write: false, counts: { "would-cancel": 2 } })
    expect(r.log.map((l) => l.outcome)).toEqual(["would-cancel", "would-cancel"])
  })
  test("actions: read suffices for a preview but not for --yes", async () => {
    expect((await run("actions-read", cutoff)).exitCode).toBe(0)
    const r = await run("actions-read")
    expect(r.exitCode).not.toBe(0)
    expect(r.posts).toEqual([])
    expect(r.envelope.error).toMatchObject({ code: "PermissionDenied" })
    expect(r.envelope.error.message).toContain("actions: write")
  })
  test("--max stops the batch at the limit and reports the rest", async () => {
    const r = await run("many", [...cutoff, "--max", "2", "--yes"])
    expect(r.exitCode).toBe(0)
    expect(r.posts).toEqual([cancelOf(300), cancelOf(301)])
    expect(r.log).toHaveLength(2)
    expect(r.envelope.result.remaining_over_max).toBe(5)
  })
  test("a readback that never reaches cancelled is a mismatch after bounded reads", async () => {
    const r = await run("never-cancels", [...cutoff, "--status", "pending", "--yes"])
    expect(r.exitCode).not.toBe(0)
    expect(r.posts).toEqual([cancelOf(101)])
    expect(r.requests.filter((route) => route === "GET /repos/example/project/actions/runs/101")).toHaveLength(6)
    expect(r.log[0]).toMatchObject({ outcome: "failed:ReadbackMismatch", cancel_attempted: true })
    expect(r.log[0].error.message).toContain("pending/null")
  })
  test("a 403 listing runs names the endpoint, HTTP status and actions: write", async () => {
    const r = await run("list-403")
    expect(r.exitCode).not.toBe(0)
    expect(r.posts).toEqual([])
    expect(r.envelope.error.message).toContain("GET /repos/example/project/actions/workflows/preview.yml/runs?status=pending")
    expect(r.envelope.error.message).toContain("HTTP 403")
    expect(r.envelope.error.message).toContain("actions: write")
  })
  test("a 403 on cancel names the endpoint and actions: write per run, and the batch continues", async () => {
    const r = await run("cancel-403")
    expect(r.exitCode).not.toBe(0)
    expect(r.posts).toEqual([cancelOf(201), cancelOf(101)])
    expect(r.log.map((l) => l.outcome)).toEqual(["failed:GitHubRequestFailed", "failed:GitHubRequestFailed"])
    expect(r.log[0].error.message).toContain(`${cancelOf(201)} failed (HTTP 403)`)
    expect(r.log[0].error.message).toContain("actions: write")
  })
  test("honors a short Retry-After once through the installation client", async () => {
    const r = await run("rate-once", [...cutoff, "--status", "pending", "--yes"])
    expect(r.exitCode).toBe(0)
    expect(r.requests.filter((route) => route.includes("/workflows/"))).toHaveLength(2)
    expect(r.posts).toEqual([cancelOf(101)])
  })
  test("the default log is 0600 in a 0700 directory and holds no token", async () => {
    const r = await run()
    expect(r.logMode).toBe(0o600)
    expect(r.dirMode).toBe(0o700)
    expect(JSON.stringify(r.log)).not.toContain("FAKE-INSTALLATION-TOKEN")
    const custom = await run("default", [...cutoff, "--log", "LOG", "--dry-run"])
    expect(custom.log).toHaveLength(2)
    expect(custom.logMode).toBe(0o600)
  })
  for (const args of [
    ["--created-before", "2026-10-25T00:00:00Z"],
    ["--workflow", "preview.yml"],
    ["--workflow", "preview.yml", "--created-before", "2026-10-25"],
    ["--workflow", "preview.yml", "--created-before", "2026-10-27T00:00:00Z"],
    ["--workflow", "../preview.yml", "--created-before", "2026-10-25T00:00:00Z"],
    [...cutoff, "--status", "in_progress"],
    [...cutoff, "--status", "pending", "--status", "requested"],
    [...cutoff, "--status", "completed"],
    [...cutoff, "--max", "501"],
    [...cutoff, "--max", "0"],
  ]) test(`invalid input refuses before any request (${args.join(" ")})`, async () => {
    const r = await run("default", [...args, "--yes"])
    expect(r.exitCode).not.toBe(0)
    expect(r.requests).toEqual([])
    expect(r.log).toEqual([])
  })
  test("--status in_progress names the started-run harm", async () => {
    const r = await run("default", [...cutoff, "--status", "in_progress"])
    expect(r.envelope.error).toMatchObject({ code: "InvalidStatus" })
    expect(r.envelope.error.message).toContain("mid-apply")
  })
})
