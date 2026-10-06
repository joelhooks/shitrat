import { afterAll, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { attestPushedSha, withAttest } from "../src/attest.js"

const SHA = "a".repeat(40)
const dirs: string[] = []

// A PATH holding one fake fleet-compute that records its argv and answers with the given script body.
const fakeFleetCompute = async (body: string) => {
  const dir = await mkdtemp(join(tmpdir(), "shitrat-attest-"))
  dirs.push(dir)
  const script = join(dir, "fleet-compute")
  await writeFile(script, `#!/bin/sh\nprintf '%s ' "$@" > "${dir}/argv"\n${body}\n`)
  await chmod(script, 0o755)
  return { pathEnv: `${dir}:/usr/bin:/bin`, logPath: join(dir, "log", "attest.jsonl"), argv: () => readFile(join(dir, "argv"), "utf8").then((text) => text.trim()) }
}

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

const logLines = async (logPath: string) =>
  (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)

describe("attest after push", () => {
  test("exit 0 records a posted attestation and passes the full sha", async () => {
    const fake = await fakeFleetCompute("exit 0")
    expect(await attestPushedSha("o/r", SHA, { pathEnv: fake.pathEnv, logPath: fake.logPath })).toEqual({ exit: 0, status: "posted" })
    expect(await fake.argv()).toBe(`attest --github o/r --sha ${SHA}`)
  })

  test("exit 3 is a silent no-op: nothing is added to the result", async () => {
    const fake = await fakeFleetCompute("echo off; exit 3")
    const attest = await attestPushedSha("o/r", SHA, { pathEnv: fake.pathEnv, logPath: fake.logPath })
    expect(attest).toBeUndefined()
    expect(withAttest(attest)).toEqual({})
  })

  test("exit 2 (bad args) is recorded with stderr, not thrown", async () => {
    const fake = await fakeFleetCompute("echo 'unknown flag --sha' >&2; exit 2")
    const attest = await attestPushedSha("o/r", SHA, { pathEnv: fake.pathEnv, logPath: fake.logPath })
    expect(attest).toEqual({ exit: 2, stderr: "unknown flag --sha" })
    expect(withAttest(attest)).toEqual({ attest: { exit: 2, stderr: "unknown flag --sha" } })
  })

  test("any other exit is recorded as an error", async () => {
    const fake = await fakeFleetCompute("echo 'github 502' >&2; exit 7")
    expect(await attestPushedSha("o/r", SHA, { pathEnv: fake.pathEnv, logPath: fake.logPath })).toEqual({ exit: 7, stderr: "github 502" })
  })

  test("a hung fleet-compute is killed at the timeout and recorded", async () => {
    // A child that outlives the killed wrapper keeps the pipes open, as on Linux CI.
    const fake = await fakeFleetCompute(`sleep 30 & echo $! > "$(dirname "$0")/child"; wait`)
    const started = Date.now()
    const attest = await attestPushedSha("o/r", SHA, { pathEnv: fake.pathEnv, logPath: fake.logPath, timeoutMs: 1000 })
    expect(Date.now() - started).toBeLessThan(3000)
    const child = Number(await readFile(join(fake.pathEnv.split(":")[0]!, "child"), "utf8"))
    process.kill(child)
    expect(attest).toMatchObject({ stderr: expect.stringContaining("killed") })
    expect(attest && "exit" in attest && attest.exit).not.toBe(0)
  })

  test("fleet-compute missing from PATH adds nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shitrat-attest-empty-"))
    dirs.push(dir)
    expect(await attestPushedSha("o/r", SHA, { pathEnv: dir, logPath: join(dir, "attest.jsonl") })).toBeUndefined()
  })

  test("never passes a short sha: records a refusal and does not run fleet-compute", async () => {
    const fake = await fakeFleetCompute("exit 0")
    const attest = await attestPushedSha("o/r", "abc1234", { pathEnv: fake.pathEnv, logPath: fake.logPath })
    expect(attest).toMatchObject({ exit: null, reason: expect.stringContaining("not a full 40-hex sha") })
    await expect(fake.argv()).rejects.toThrow()
  })
})

describe("attest log", () => {
  test("exit 3 is logged with its reason while the JSON result stays silent", async () => {
    const fake = await fakeFleetCompute("echo no-qualifying-attestation; exit 3")
    const attest = await attestPushedSha("o/r", SHA, { pathEnv: fake.pathEnv, logPath: fake.logPath, command: "push" })
    expect(attest).toBeUndefined()
    const [entry] = await logLines(fake.logPath)
    expect(entry).toMatchObject({ command: "push", repo: "o/r", sha: SHA, shitrat_build: "dev", "fleet-compute": "present", exit: 3, reason: "no-qualifying-attestation" })
    expect(typeof entry?.ts).toBe("string")
  })

  test("a missing fleet-compute is logged as missing, distinct from exit 3", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shitrat-attest-empty-"))
    dirs.push(dir)
    const logPath = join(dir, "log", "attest.jsonl")
    await attestPushedSha("o/r", SHA, { pathEnv: dir, logPath, command: "create-pr" })
    const [entry] = await logLines(logPath)
    expect(entry).toMatchObject({ command: "create-pr", sha: SHA, "fleet-compute": "missing" })
    expect(entry).not.toHaveProperty("exit")
  })

  test("appends one line per attempt and never writes the environment", async () => {
    const fake = await fakeFleetCompute("echo 'github 502' >&2; exit 7")
    process.env.SHITRAT_TEST_SECRET = "s3cr3t-value"
    try {
      await attestPushedSha("o/r", SHA, { pathEnv: fake.pathEnv, logPath: fake.logPath, command: "push" })
      await attestPushedSha("o/r", SHA, { pathEnv: fake.pathEnv, logPath: fake.logPath, command: "push" })
    } finally {
      delete process.env.SHITRAT_TEST_SECRET
    }
    const lines = await logLines(fake.logPath)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ exit: 7, stderr: "github 502" })
    expect(Object.keys(lines[0] ?? {}).sort()).toEqual(["command", "exit", "fleet-compute", "repo", "sha", "shitrat_build", "stderr", "ts"])
    expect(await readFile(fake.logPath, "utf8")).not.toContain("s3cr3t-value")
  })

  test("an unwritable log does not change the result or throw", async () => {
    const fake = await fakeFleetCompute("exit 0")
    // A regular file where the log directory should be: mkdir fails.
    const blocker = join(fake.pathEnv.split(":")[0]!, "blocker")
    await writeFile(blocker, "")
    const attest = await attestPushedSha("o/r", SHA, { pathEnv: fake.pathEnv, logPath: join(blocker, "log", "attest.jsonl") })
    expect(attest).toEqual({ exit: 0, status: "posted" })
  })
})
