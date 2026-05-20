import { describe, expect, test } from "bun:test"
import { parseRepo } from "../src/github-app.js"
import { failure, success } from "../src/response.js"

const runCli = async (...args: string[]) => {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    cwd: new URL("../", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  return { stdout, stderr, exitCode, json: JSON.parse(stdout) as { ok: boolean } }
}

describe("response envelope", () => {
  test("normalizes commands", () => {
    const envelope = success("status joelhooks/shitrat-cli", { ok: true })
    expect(envelope.command).toBe("shitrat status joelhooks/shitrat-cli")
    expect(envelope.ok).toBe(true)
  })

  test("normalizes next actions", () => {
    const envelope = failure("comment", "boom", "NOPE", "fix it", [
      { command: "status <repo>", description: "check repo" },
    ])
    expect(envelope.next_actions[0]?.command).toBe("shitrat status <repo>")
    expect(envelope.error.code).toBe("NOPE")
  })
})

describe("github repo parsing", () => {
  test("parses owner/repo", () => {
    expect(parseRepo("skillrecordings/migrate-egghead")).toEqual({
      owner: "skillrecordings",
      repo: "migrate-egghead",
      fullName: "skillrecordings/migrate-egghead",
    })
  })

  test("rejects loose names", () => {
    expect(() => parseRepo("migrate-egghead")).toThrow("Invalid repo")
  })
})

describe("cli json output", () => {
  test("wraps parser errors as json", async () => {
    const result = await runCli("status")

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe("")
    expect(result.json.ok).toBe(false)
    expect(result.stdout).toContain("Missing argument <repo>")
  })

  test("wraps help output as json", async () => {
    const result = await runCli("--help")

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.json.ok).toBe(true)
    expect(result.stdout).toContain("COMMANDS")
  })
})
