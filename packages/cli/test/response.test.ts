import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gitModeFromFileMode } from "../src/commands/github.js"
import {
  buildAuthenticatedGitInvocation,
  buildFetchCommandArgs,
  buildPushCommandArgs,
  inspectPushRepository,
  resolvePushPlan,
  SHITRAT_GIT_AUTHOR,
  ShitRatPushError,
} from "../src/git-push.js"
import { parseRepo } from "../src/github-app.js"
import { failure, success } from "../src/response.js"

const runGit = async (cwd: string, ...args: string[]): Promise<string> => {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

const commitFile = async (
  cwd: string,
  message: string,
  author: { readonly name: string; readonly email: string },
): Promise<string> => {
  const file = join(cwd, "history.txt")
  const previous = await Bun.file(file).text().catch(() => "")
  await writeFile(file, `${previous}${message}\n`, "utf8")
  await runGit(cwd, "add", "history.txt")
  await runGit(
    cwd,
    "-c",
    `user.name=${author.name}`,
    "-c",
    `user.email=${author.email}`,
    "commit",
    "-m",
    message,
  )
  return runGit(cwd, "rev-parse", "HEAD")
}

const createPushRepo = async (): Promise<{ readonly dir: string; readonly baseSha: string }> => {
  const dir = await mkdtemp(join(tmpdir(), "shitrat-push-test-"))
  await runGit(dir, "init", "-b", "main")
  await runGit(dir, "remote", "add", "origin", "https://github.com/joelhooks/shitrat-cli.git")
  const baseSha = await commitFile(dir, "base", SHITRAT_GIT_AUTHOR)
  await runGit(dir, "update-ref", "refs/remotes/origin/main", baseSha)
  return { dir, baseSha }
}

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

describe("local git push", () => {
  test("preserves executable file mode for API commits", () => {
    expect(gitModeFromFileMode(0o100755)).toBe("100755")
    expect(gitModeFromFileMode(0o100644)).toBe("100644")
  })

  test("accepts bot-authored outgoing commits", async () => {
    const { dir } = await createPushRepo()
    try {
      const outgoingSha = await commitFile(dir, "bot change", SHITRAT_GIT_AUTHOR)
      const repository = await inspectPushRepository({
        repo: "joelhooks/shitrat-cli",
        repoDir: dir,
      })
      const plan = await resolvePushPlan(repository, false)

      expect(plan.commits.map((commit) => commit.sha)).toEqual([outgoingSha])
      expect(plan.nothingToPush).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("rejects mixed outgoing authors with AUTHOR_NOT_BOT", async () => {
    const { dir } = await createPushRepo()
    try {
      await commitFile(dir, "bot change", SHITRAT_GIT_AUTHOR)
      await commitFile(dir, "human change", {
        name: "Example Human",
        email: "human@example.com",
      })
      const repository = await inspectPushRepository({
        repo: "joelhooks/shitrat-cli",
        repoDir: dir,
      })

      try {
        await resolvePushPlan(repository, false)
        throw new Error("expected authorship gate to fail")
      } catch (error) {
        expect(error).toBeInstanceOf(ShitRatPushError)
        expect((error as ShitRatPushError).code).toBe("AUTHOR_NOT_BOT")
        expect((error as ShitRatPushError).fix).toContain("git -c user.name='shitratgit[bot]'")
        expect((error as ShitRatPushError).fix).toContain("--allow-any-author")
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("allows mixed outgoing authors when explicitly requested", async () => {
    const { dir } = await createPushRepo()
    try {
      await commitFile(dir, "human change", {
        name: "Example Human",
        email: "human@example.com",
      })
      const repository = await inspectPushRepository({
        repo: "joelhooks/shitrat-cli",
        repoDir: dir,
      })
      const plan = await resolvePushPlan(repository, true)

      expect(plan.commits).toHaveLength(1)
      expect(plan.commits[0]?.authorName).toBe("Example Human")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("counts creation of a new branch even when its commit already exists on origin", async () => {
    const { dir, baseSha } = await createPushRepo()
    try {
      await runGit(dir, "branch", "release", baseSha)
      const repository = await inspectPushRepository({
        repo: "joelhooks/shitrat-cli",
        repoDir: dir,
        branch: "release",
      })
      const plan = await resolvePushPlan(repository, false)

      expect(plan.commits).toHaveLength(0)
      expect(plan.nothingToPush).toBe(false)
      expect(plan.pushedCount).toBe(1)
      expect(plan.range).toBe(`0000000000000000000000000000000000000000..${baseSha}`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("refuses checkout-local URL rewrites", async () => {
    const { dir } = await createPushRepo()
    try {
      await runGit(
        dir,
        "config",
        "--local",
        "url.ext::credential-catcher.insteadOf",
        "https://github.com/",
      )
      try {
        await inspectPushRepository({ repo: "joelhooks/shitrat-cli", repoDir: dir })
        throw new Error("expected unsafe git config to fail")
      } catch (error) {
        expect(error).toBeInstanceOf(ShitRatPushError)
        expect((error as ShitRatPushError).code).toBe("UNSAFE_GIT_CONFIG")
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("refuses worktree-scoped URL rewrites", async () => {
    const { dir } = await createPushRepo()
    try {
      await runGit(dir, "config", "--local", "extensions.worktreeConfig", "true")
      await runGit(
        dir,
        "config",
        "--worktree",
        "url.ext::credential-catcher.insteadOf",
        "https://github.com/",
      )
      try {
        await inspectPushRepository({ repo: "joelhooks/shitrat-cli", repoDir: dir })
        throw new Error("expected unsafe worktree git config to fail")
      } catch (error) {
        expect(error).toBeInstanceOf(ShitRatPushError)
        expect((error as ShitRatPushError).code).toBe("UNSAFE_GIT_CONFIG")
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("refuses a checkout whose origin does not match the requested repo", async () => {
    const { dir } = await createPushRepo()
    try {
      try {
        await inspectPushRepository({ repo: "joelhooks/not-this-repo", repoDir: dir })
        throw new Error("expected repo mismatch to fail")
      } catch (error) {
        expect(error).toBeInstanceOf(ShitRatPushError)
        expect((error as ShitRatPushError).code).toBe("REPO_MISMATCH")
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("returns a nothing-to-push success envelope", async () => {
    const { dir, baseSha } = await createPushRepo()
    try {
      const repository = await inspectPushRepository({
        repo: "joelhooks/shitrat-cli",
        repoDir: dir,
      })
      const plan = await resolvePushPlan(repository, false)
      const envelope = success("push joelhooks/shitrat-cli", {
        repo: repository.repo,
        branch: repository.branch,
        pushed: plan.commits.length,
        range: plan.range,
        actor: SHITRAT_GIT_AUTHOR.name,
      })

      expect(plan.nothingToPush).toBe(true)
      expect(envelope.ok).toBe(true)
      expect(envelope.result).toEqual({
        repo: "joelhooks/shitrat-cli",
        branch: "main",
        pushed: 0,
        range: `${baseSha}..${baseSha}`,
        actor: "shitratgit[bot]",
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("keeps installation tokens out of git argv", () => {
    const fakeToken = "ghs_DO_NOT_PUT_THIS_IN_ARGV"
    const invocation = buildAuthenticatedGitInvocation(
      ["push", "https://github.com/joelhooks/shitrat-cli.git", "HEAD:refs/heads/main"],
      fakeToken,
    )
    const argv = JSON.stringify(invocation.args)

    expect(argv).not.toContain(fakeToken)
    expect(argv).toContain("$SHITRAT_PUSH_TOKEN")
    expect(argv).toContain("$protocol")
    expect(argv).toContain("$host")
    expect(invocation.args).toContain("core.hooksPath=/dev/null")
    expect(invocation.args).toContain("protocol.allow=never")
    expect(invocation.args).toContain("protocol.https.allow=always")
    expect(invocation.env.SHITRAT_PUSH_TOKEN).toBe(fakeToken)
    expect(invocation.env.GIT_CONFIG_GLOBAL).toBe("/dev/null")
    expect(invocation.env.GIT_CONFIG_NOSYSTEM).toBe("1")

    const pushArgs = buildPushCommandArgs(
      {
        repo: "joelhooks/shitrat-cli",
        gitRoot: "/tmp/unused",
        branch: "main",
        localSha: "0123456789012345678901234567890123456789",
      },
      false,
    )
    expect(pushArgs).toContain("--no-verify")
    expect(pushArgs).toContain("--recurse-submodules=no")
    expect(pushArgs).not.toContain("--force")
    expect(
      buildFetchCommandArgs({
        repo: "joelhooks/shitrat-cli",
        gitRoot: "/tmp/unused",
        branch: "main",
        localSha: "0123456789012345678901234567890123456789",
      }),
    ).toContain("--no-recurse-submodules")
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
