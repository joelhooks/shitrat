import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createReviewCommentReply, updatePullRequest } from "../src/commands/github.js"

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
  return { stdout, stderr, exitCode, json: JSON.parse(stdout) as { ok: boolean; result?: Record<string, any> } }
}

describe("GitHub PR editing requests", () => {
  test("sends an inline review-thread reply through Octokit", async () => {
    const calls: unknown[] = []
    const mock = {
      createReplyForReviewComment: async (input: unknown) => {
        calls.push(input)
        return { data: { id: 99, html_url: "https://github.com/o/r/pull/4#discussion_r99" } }
      },
    }
    const result = await createReviewCommentReply(mock as never, {
      owner: "o", repo: "r", pull_number: 4, comment_id: 88, body: "Fixed.",
    })
    expect(calls).toEqual([{ owner: "o", repo: "r", pull_number: 4, comment_id: 88, body: "Fixed." }])
    expect(result.data.id).toBe(99)
  })

  test("sends only supplied PR fields through Octokit", async () => {
    const calls: unknown[] = []
    const mock = {
      update: async (input: unknown) => {
        calls.push(input)
        return { data: { title: "New", body: "Text", base: { ref: "next" }, state: "closed", html_url: "url" } }
      },
    }
    await updatePullRequest(mock as never, {
      owner: "o", repo: "r", pull_number: 4, title: "New", base: "next", state: "closed",
    })
    expect(calls).toEqual([{ owner: "o", repo: "r", pull_number: 4, title: "New", base: "next", state: "closed" }])
  })

  test("dry-runs reply without contacting GitHub and accepts body-file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shitrat-reply-test-"))
    const bodyFile = join(dir, "reply.md")
    await writeFile(bodyFile, "Thread reply", "utf8")
    try {
      const result = await runCli("reply", "o/r", "4", "88", "--body-file", bodyFile, "--dry-run")
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      expect(result.json.ok).toBe(true)
      expect(result.json.result).toMatchObject({ dry_run: true, number: 4, comment_id: 88, body: "Thread reply", github_write: false })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("dry-runs PR edits and requires at least one changed field", async () => {
    const result = await runCli("edit-pr", "o/r", "4", "--title", "Updated", "--state", "closed", "--dry-run")
    expect(result.exitCode).toBe(0)
    expect(result.json.ok).toBe(true)
    expect(result.json.result).toMatchObject({ dry_run: true, changed: { title: "Updated", state: "closed" }, github_write: false })

    const empty = await runCli("edit-pr", "o/r", "4", "--dry-run")
    expect(empty.exitCode).toBe(1)
    expect(empty.json.ok).toBe(false)
    expect(empty.stdout).toContain("at least one")
  })

  test("reads edit-pr body from a file in dry-run mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shitrat-edit-pr-test-"))
    const bodyFile = join(dir, "body.md")
    await writeFile(bodyFile, "Updated description", "utf8")
    try {
      const result = await runCli("edit-pr", "o/r", "4", "--body-file", bodyFile, "--dry-run")
      expect(result.exitCode).toBe(0)
      expect(result.json.ok).toBe(true)
      expect(result.json.result?.changed).toEqual({ body: "Updated description" })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
