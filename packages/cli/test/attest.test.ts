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
  return { pathEnv: `${dir}:/usr/bin:/bin`, argv: () => readFile(join(dir, "argv"), "utf8").then((text) => text.trim()) }
}

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("attest after push", () => {
  test("exit 0 records a posted attestation and passes the full sha", async () => {
    const fake = await fakeFleetCompute("exit 0")
    expect(await attestPushedSha("o/r", SHA, { pathEnv: fake.pathEnv })).toEqual({ exit: 0, status: "posted" })
    expect(await fake.argv()).toBe(`attest --github o/r --sha ${SHA}`)
  })

  test("exit 3 is a silent no-op: nothing is added to the result", async () => {
    const fake = await fakeFleetCompute("echo off; exit 3")
    const attest = await attestPushedSha("o/r", SHA, { pathEnv: fake.pathEnv })
    expect(attest).toBeUndefined()
    expect(withAttest(attest)).toEqual({})
  })

  test("exit 2 (bad args) is recorded with stderr, not thrown", async () => {
    const fake = await fakeFleetCompute("echo 'unknown flag --sha' >&2; exit 2")
    const attest = await attestPushedSha("o/r", SHA, { pathEnv: fake.pathEnv })
    expect(attest).toEqual({ exit: 2, stderr: "unknown flag --sha" })
    expect(withAttest(attest)).toEqual({ attest: { exit: 2, stderr: "unknown flag --sha" } })
  })

  test("any other exit is recorded as an error", async () => {
    const fake = await fakeFleetCompute("echo 'github 502' >&2; exit 7")
    expect(await attestPushedSha("o/r", SHA, { pathEnv: fake.pathEnv })).toEqual({ exit: 7, stderr: "github 502" })
  })

  test("a hung fleet-compute is killed at the timeout and recorded", async () => {
    const fake = await fakeFleetCompute("sleep 5")
    const attest = await attestPushedSha("o/r", SHA, { pathEnv: fake.pathEnv, timeoutMs: 100 })
    expect(attest).toMatchObject({ stderr: expect.stringContaining("killed") })
    expect(attest && "exit" in attest && attest.exit).not.toBe(0)
  })

  test("fleet-compute missing from PATH adds nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shitrat-attest-empty-"))
    dirs.push(dir)
    expect(await attestPushedSha("o/r", SHA, { pathEnv: dir })).toBeUndefined()
  })

  test("never passes a short sha: records a refusal and does not run fleet-compute", async () => {
    const fake = await fakeFleetCompute("exit 0")
    const attest = await attestPushedSha("o/r", "abc1234", { pathEnv: fake.pathEnv })
    expect(attest).toMatchObject({ exit: null, reason: expect.stringContaining("not a full 40-hex sha") })
    await expect(fake.argv()).rejects.toThrow()
  })
})
