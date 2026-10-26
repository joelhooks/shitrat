import { describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const sha = "a".repeat(40)
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } })
const run = async (scenario = "behind", args = ["--branch", "land/abc1234", "--yes"], repo = "example/project") => {
  const home = await mkdtemp(path.join(tmpdir(), "shitrat-delete-branch-test-"))
  try {
    const audit = path.join(home, "requests.json")
    const customLog = path.join(home, "custom", "deletes.jsonl")
    await writeFile(path.join(home, "branches.txt"), "protected\r\nland/abc1234\r\n\n")
    await writeFile(path.join(home, "empty.txt"), "\n")
    if (["existing-log", "insecure-log", "symlink-log"].includes(scenario)) {
      await mkdir(path.dirname(customLog), { mode: scenario === "insecure-log" ? 0o755 : 0o700 })
      if (scenario === "existing-log") { await writeFile(customLog, '{"outcome":"prior"}\n'); await chmod(customLog, 0o644) }
      if (scenario === "symlink-log") { await writeFile(path.join(home, "untouched.jsonl"), '{"outcome":"prior"}\n'); await symlink(path.join(home, "untouched.jsonl"), customLog) }
    }
    const proc = Bun.spawn([process.execPath, "--preload", path.join(import.meta.dir, "fixtures/delete-branch-preload.ts"), path.join(import.meta.dir, "../src/cli.ts"), "delete-branch", ...args.map((arg) => arg === "FILE" ? path.join(home, "branches.txt") : arg === "EMPTY" ? path.join(home, "empty.txt") : arg === "LOG" ? customLog : arg), repo], {
      env: { PATH: process.env.PATH, HOME: home, SHITRAT_GITHUB_APP_ID: "123", SHITRAT_GITHUB_PRIVATE_KEY: privateKey, SHITRAT_GITHUB_CLIENT_ID: "test-client", SHITRAT_GITHUB_INSTALLATIONS_JSON: `{"${repo.split("/")[0]}":123}`, DELETE_BRANCH_TEST_AUDIT: audit, DELETE_BRANCH_TEST_SCENARIO: scenario, DELETE_BRANCH_TEST_REPO: repo },
      stdout: "pipe", stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    expect(stdout + stderr).not.toContain("FAKE-INSTALLATION-TOKEN")
    expect(stdout + stderr).not.toContain(privateKey)
    const requests: string[] = JSON.parse(await readFile(audit, "utf8"))
    const logPath = args.includes("LOG") ? customLog : path.join(home, ".local/state/shitrat/branch-deletes.jsonl")
    const rawLog = await readFile(logPath, "utf8").catch(() => "")
    expect(rawLog).not.toContain("FAKE-INSTALLATION-TOKEN")
    expect(rawLog).not.toContain(privateKey)
    const log = rawLog.trim() ? rawLog.trim().split("\n").map((line) => JSON.parse(line)) : []
    const logMode = await stat(logPath).then((s) => s.mode & 0o777).catch(() => null)
    const dirMode = await stat(path.dirname(logPath)).then((s) => s.mode & 0o777).catch(() => null)
    const envelope = JSON.parse(stdout)
    if (process.env.DELETE_BRANCH_FIXTURE_OUTPUT && repo === "badass-courses/front-desk") {
      await writeFile(process.env.DELETE_BRANCH_FIXTURE_OUTPUT, stdout.replaceAll(home, "<fixture-home>"))
    }
    return { stdout, envelope, exitCode, requests, deletes: requests.filter((r) => r.startsWith("DELETE ")), log, logMode, dirMode }
  } finally { await rm(home, { recursive: true, force: true }) }
}

describe("delete-branch CLI (fake HTTP)", () => {
  for (const scenario of ["behind", "identical"]) test(`${scenario} deletes and verifies 404, logging a private receipt`, async () => {
    const r = await run(scenario)
    expect(r.exitCode).toBe(0)
    expect(r.envelope).toMatchObject({ ok: true, result: { dry_run: false, github_write: true, counts: { deleted: 1, refused: 0, failed: 0 } } })
    expect(r.deletes).toEqual(["DELETE /repos/example/project/git/refs/heads/land/abc1234"])
    expect(r.requests.slice(-3)).toEqual(["GET /repos/example/project/git/ref/heads/land/abc1234", ...r.deletes, "GET /repos/example/project/git/ref/heads/land/abc1234"])
    expect(r.log).toEqual(r.envelope.result.results)
    expect(r.log[0]).toMatchObject({ repo: "example/project", branch: "land/abc1234", sha, compare_status: scenario, outcome: "deleted", timestamp: "2026-10-26T00:00:00.000Z", cli_version: "0.1.0" })
    expect(r.logMode).toBe(0o600)
    expect(r.dirMode).toBe(0o700)
  })
  for (const args of [["--branch", "land/abc1234"], ["--branch", "land/abc1234", "--dry-run"]]) test(`dry run sends no DELETE (${args.join(" ")})`, async () => {
    const r = await run("behind", args, "badass-courses/front-desk")
    expect(r.exitCode).toBe(0)
    expect(r.deletes).toEqual([])
    expect(r.envelope.result).toMatchObject({ dry_run: true, github_write: false, counts: { dryRun: 1 } })
    expect(r.log[0]).toMatchObject({ outcome: "dryRun", sha, compare_status: "behind" })
  })
  for (const scenario of ["ahead", "diverged", "unknown"]) test(`${scenario} refuses NotMerged`, async () => {
    const r = await run(scenario)
    expect(r.exitCode).not.toBe(0)
    expect(r.deletes).toEqual([])
    expect(r.envelope.result.results[0]).toMatchObject({ outcome: "refused", compare_status: scenario, error: { code: "NotMerged" } })
  })
  for (const [scenario, branch, code] of [["behind", "main", "DefaultBranch"], ["protected", "land/abc1234", "ProtectedBranch"], ["moved", "land/abc1234", "BranchMoved"], ["ref-disappeared", "land/abc1234", "BranchMoved"], ["behind", "refs/heads/land/abc1234", "InvalidBranch"]]) test(`${code} refuses ${scenario}/${branch}`, async () => {
    const r = await run(scenario, ["--branch", branch!, "--yes"])
    expect(r.exitCode).not.toBe(0)
    expect(r.deletes).toEqual([])
    expect(r.envelope.result.results[0]).toMatchObject({ outcome: "refused", error: { code } })
    expect(r.log).toHaveLength(1)
  })
  for (const confirmation of [[], ["--dry-run"], ["--yes"]]) test(`open PRs refuse in preflight (${confirmation.join(" ") || "default preview"})`, async () => {
    const r = await run("open-pull", ["--branch", "land/abc1234", ...confirmation])
    expect(r.exitCode).not.toBe(0)
    expect(r.deletes).toEqual([])
    expect(r.envelope.result).toMatchObject({ github_write: false, counts: { refused: 1, failed: 0 } })
    expect(r.log[0]).toMatchObject({ outcome: "refused", error: { code: "OpenPullRequest" } })
    expect(r.log[0].error.message).toContain("#42")
    expect(r.log[0].error.message).toContain("#73")
    const query = new URL(`https://api.github.com${r.requests.find((route) => route.includes("/pulls?"))!.slice(4)}`)
    expect(query.searchParams.get("state")).toBe("open")
    expect(query.searchParams.get("head")).toBe("example:land/abc1234")
    expect(r.requests.filter((route) => route.includes("/git/ref/"))).toHaveLength(1)
  })
  test("404 ref is alreadyAbsent, with no DELETE", async () => {
    const r = await run("absent")
    expect(r.exitCode).toBe(0)
    expect(r.deletes).toEqual([])
    expect(r.envelope.result.results[0]).toMatchObject({ outcome: "alreadyAbsent", sha: null })
    expect(r.requests.some((r) => r.includes("/compare/"))).toBe(false)
  })
  test("readback mismatch fails after exactly one DELETE", async () => {
    const r = await run("readback-mismatch")
    expect(r.exitCode).not.toBe(0)
    expect(r.deletes).toHaveLength(1)
    expect(r.envelope.result.results[0]).toMatchObject({ outcome: "failed", error: { code: "ReadbackMismatch" } })
  })
  for (const [scenario, endpoint, status] of [["permission-403", "branches/land%2Fabc1234", 403], ["repo-404", "example/project", 404], ["branch-404", "branches/land%2Fabc1234", 404], ["compare-404", `compare/main...${sha}`, 404], ["compare-403", `compare/main...${sha}`, 403], ["delete-404", "git/refs/heads/land%2Fabc1234", 404], ["delete-403", "git/refs/heads/land%2Fabc1234", 403], ["readback-403", "git/ref/heads/land%2Fabc1234", 403], ["pulls-403", "pulls?state=open&head=example%3Aland%2Fabc1234", 403], ["pulls-404", "pulls?state=open&head=example%3Aland%2Fabc1234", 404]] as const) test(`${scenario} names endpoint, HTTP status and contents: write`, async () => {
    const r = await run(scenario)
    expect(r.exitCode).not.toBe(0)
    const error = r.envelope.result.results[0].error
    expect(error.message).toContain(endpoint)
    expect(error.message).toContain(`HTTP ${status}`)
    expect(error.message).toContain("contents: write")
    expect(r.log).toHaveLength(1)
  })
  for (const args of [["--branch", "protected", "--branch", "land/abc1234", "--yes"], ["--branches-file", "FILE", "--log", "LOG", "--yes"]]) test(`batch continues after refusal and exits nonzero (${args.join(" ")})`, async () => {
    const r = await run("behind", args)
    expect(r.exitCode).not.toBe(0)
    expect(r.envelope.ok).toBe(false)
    expect(r.envelope.result.counts).toMatchObject({ refused: 1, deleted: 1, failed: 0 })
    expect(r.deletes).toHaveLength(1)
    expect(r.log.map((l) => l.outcome)).toEqual(["refused", "deleted"])
    expect(r.logMode).toBe(0o600)
    expect(r.envelope.next_actions.length).toBeGreaterThan(0)
  })
  test("processes duplicate names serially and appends, never truncates log", async () => {
    const r = await run("behind", ["--branch", "land/abc1234", "--branch", "land/abc1234", "--yes"])
    expect(r.exitCode).toBe(0)
    expect(r.deletes).toHaveLength(1)
    expect(r.log.map((l) => l.outcome)).toEqual(["deleted", "alreadyAbsent"])
  })
  for (const args of [[], ["--branch", "land/x", "--branches-file", "FILE"], ["--branches-file", "EMPTY"], ["--branch", "land/x", "--yes", "--dry-run"]]) test(`invalid input makes no authenticated requests (${args.join(" ")})`, async () => {
    const r = await run("behind", args)
    expect(r.exitCode).not.toBe(0)
    expect(r.requests).toEqual([])
    expect(r.deletes).toEqual([])
  })
  test("existing audit records survive and file mode is tightened to 0600", async () => {
    const r = await run("existing-log", ["--branch", "land/abc1234", "--log", "LOG", "--yes"])
    expect(r.exitCode).toBe(0)
    expect(r.log.map((l) => l.outcome)).toEqual(["prior", "deleted"])
    expect(r.logMode).toBe(0o600)
  })
  for (const scenario of ["insecure-log", "symlink-log"]) test(`${scenario} stops before DELETE, without changing existing data`, async () => {
    const r = await run(scenario, ["--branch", "land/abc1234", "--log", "LOG", "--yes"])
    expect(r.exitCode).not.toBe(0)
    expect(r.envelope.error.code).toBe("AuditLogFailed")
    expect(r.deletes).toEqual([])
    if (scenario === "symlink-log") expect(r.log).toEqual([{ outcome: "prior" }])
    else expect(r.dirMode).toBe(0o755)
  })
  for (const scenario of ["no-contents", "read-only"]) test(`${scenario} refuses confirmed deletes rather than treating access denial as absence`, async () => {
    const r = await run(scenario)
    expect(r.exitCode).not.toBe(0)
    expect(r.deletes).toEqual([])
    expect(r.log[0].error.code).toBe("PermissionDenied")
    expect(r.log[0].error.message).toContain("contents: write")
  })
  test("contents: read suffices for a preview", async () => {
    const r = await run("read-only", ["--branch", "land/abc1234"])
    expect(r.exitCode).toBe(0)
    expect(r.deletes).toEqual([])
  })
  for (const scenario of ["rate-long", "rate-long-date"]) test(`${scenario} stops without sleeping or retrying and carries reset time`, async () => {
    const r = await run(scenario, ["--branch", "land/one", "--branch", "land/two", "--yes"])
    expect(r.exitCode).not.toBe(0)
    expect(r.requests.filter((route) => route.includes("/branches/"))).toHaveLength(1)
    expect(r.deletes).toEqual([])
    expect(r.envelope.result.counts.failed).toBe(2)
    expect(r.log.map((item) => item.error)).toEqual([
      expect.objectContaining({ code: "RateLimited", reset_at: "2026-10-26T00:05:01.000Z" }),
      expect.objectContaining({ code: "RateLimited", reset_at: "2026-10-26T00:05:01.000Z" }),
    ])
    expect(r.log[0].error.message).toContain("2026-10-26T00:05:01.000Z")
  }, 5000)
  test("honors a short Retry-After wait once using the installation client", async () => {
    const r = await run("rate-once")
    expect(r.exitCode).toBe(0)
    expect(r.requests.filter((r) => r.includes("/branches/"))).toHaveLength(2)
    expect(r.deletes).toHaveLength(1)
  })
  for (const scenario of ["rate-repeat", "rate-403"]) test(`${scenario} stops requests after one retry with a typed error`, async () => {
    const r = await run(scenario, ["--branch", "land/one", "--branch", "land/two", "--yes"])
    expect(r.exitCode).not.toBe(0)
    expect(r.requests.filter((r) => r.includes("/branches/"))).toHaveLength(2)
    expect(r.deletes).toEqual([])
    expect(r.envelope.result.counts.failed).toBe(2)
    expect(r.log.map((l) => l.error.code)).toEqual(["RateLimited", "RateLimited"])
  })
})
