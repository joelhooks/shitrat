import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

  return {
    stdout,
    stderr,
    exitCode,
    json: JSON.parse(stdout) as { ok: boolean; result?: Record<string, unknown> },
  }
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

  test("rejects unsafe commit-file repo paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shitrat-test-"))
    const file = join(dir, "note.md")
    await writeFile(file, "hello from the rat\n", "utf8")

    try {
      const result = await runCli(
        "commit-file",
        "joelhooks/shitrat-cli",
        "--branch",
        "main",
        "--message",
        "test: dry run",
        "--file",
        file,
        "--path",
        "/docs/nope.md",
        "--dry-run",
      )

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      expect(result.json.ok).toBe(false)
      expect(result.stdout).toContain("Use a relative path")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("dry-runs commit-file without GitHub credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shitrat-test-"))
    const file = join(dir, "note.md")
    await writeFile(file, "hello from the rat\n", "utf8")

    try {
      const result = await runCli(
        "commit-file",
        "joelhooks/shitrat-cli",
        "--branch",
        "main",
        "--message",
        "test: dry run",
        "--file",
        file,
        "--path",
        "docs/note.md",
        "--dry-run",
      )

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      expect(result.json.ok).toBe(true)
      expect(result.json.result?.dry_run).toBe(true)
      expect(result.stdout).toContain("docs/note.md")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("dry-runs commit-files atomically without GitHub credentials", async () => {
    const result = await runCli(
      "commit-files",
      "joelhooks/shitrat-cli",
      "--branch",
      "main",
      "--message",
      "test: dry run",
      "--file",
      "README.md",
      "--file",
      "AGENTS.md",
      "--dry-run",
    )

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.json.ok).toBe(true)
    expect(result.json.result?.dry_run).toBe(true)
    expect(result.json.result?.file_count).toBe(2)
    expect(result.stdout).toContain("README.md")
    expect(result.stdout).toContain("AGENTS.md")
  })

<<<<<<< Updated upstream
  test("dry-runs git push without GitHub credentials", async () => {
    const result = await runCli(
      "push",
      "joelhooks/shitrat-cli",
      "--branch",
      "main",
      "--source",
      "HEAD",
      "--dry-run",
    )

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.json.ok).toBe(true)
    expect(result.json.result?.dry_run).toBe(true)
    expect(typeof result.json.result?.source_sha).toBe("string")
    expect(result.stdout).toContain("Real push mints one GitHub App installation token")
||||||| Stash base
=======
  test("dry-runs create-pr without GitHub credentials", async () => {
    const result = await runCli(
      "create-pr",
      "joelhooks/shitrat-cli",
      "--title",
      "docs: propose vision",
      "--head",
      "shitrat/propose-vision",
      "--base",
      "main",
      "--body",
      "Tiny PR body.",
      "--dry-run",
    )

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.json.ok).toBe(true)
    expect(result.json.result?.dry_run).toBe(true)
    expect(result.stdout).toContain("shitrat/propose-vision")
  })

  test("dry-runs merge-pr without GitHub credentials", async () => {
    const result = await runCli(
      "merge-pr",
      "joelhooks/shitrat-cli",
      "123",
      "--method",
      "squash",
      "--dry-run",
    )

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.json.ok).toBe(true)
    expect(result.json.result?.dry_run).toBe(true)
    expect(result.stdout).toContain("github_write")
>>>>>>> Stashed changes
  })

  test("compiles the default Codex Desktop familiar", async () => {
    const result = await runCli("compile", "--target", "codex-desktop", "--dry-run")

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.json.ok).toBe(true)
    expect(result.stdout).toContain("TOOLS: Codex Desktop")
  })

  test("plans Codex Desktop install as dry run", async () => {
    const result = await runCli("install", "codex-desktop", "--dry-run", "--home", "/tmp/codex")

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.json.ok).toBe(true)
    expect(result.stdout).toContain("/tmp/codex/AGENTS.md")
  })

  test("refuses real install writes", async () => {
    const result = await runCli("install", "codex-desktop")

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.json.ok).toBe(false)
    expect(result.stdout).toContain("INSTALL_CONFIRMATION_REQUIRED")
  })

  test("writes install with explicit confirmation and backup behavior", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shitrat-install-test-"))
    await writeFile(join(dir, "AGENTS.md"), "old instructions\n", "utf8")

    try {
      const result = await runCli("install", "codex-desktop", "--home", dir, "--yes")

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      expect(result.json.ok).toBe(true)
      expect(result.stdout).toContain("backup_path")
      expect(await Bun.file(join(dir, "AGENTS.md")).text()).toContain("TOOLS: Codex Desktop")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("updates Pi APPEND_SYSTEM.md in a delimited block while preserving local instructions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shitrat-pi-update-test-"))
    await writeFile(join(dir, "APPEND_SYSTEM.md"), "local operator note\n", "utf8")

    try {
      const result = await runCli("update", "pi", "--home", dir, "--yes")
      const updated = await Bun.file(join(dir, "APPEND_SYSTEM.md")).text()

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      expect(result.json.ok).toBe(true)
      expect(result.stdout).toContain('"action": "merge"')
      expect(updated).toContain("<!-- shitrat:start -->")
      expect(updated).toContain("<!-- shitrat:end -->")
      expect(updated).toContain("local operator note")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("reports parity across harnesses", async () => {
    const result = await runCli("parity")

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.json.ok).toBe(true)
    expect(result.stdout).toContain("codex-desktop")
    expect(result.stdout).toContain("claude")
  })
})
