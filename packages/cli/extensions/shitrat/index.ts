import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { StringEnum } from "@earendil-works/pi-ai"
import { Type } from "typebox"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const baseDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(baseDir, "../..")
const cliPath = join(packageRoot, "src/cli.ts")
const skillPath = join(packageRoot, "skills/shitrat-github/SKILL.md")

const runShitRat = async (
  pi: ExtensionAPI,
  args: readonly string[],
  signal?: AbortSignal,
  cwd = packageRoot,
) => {
  const execOptions = {
    cwd,
    timeout: 60_000,
    ...(signal ? { signal } : {}),
  }
  const result = await pi.exec("bun", ["run", cliPath, ...args], execOptions)

  const output = result.stdout.trim()

  try {
    const parsed = JSON.parse(output) as unknown
    return parsed
  } catch {
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || output || `shitrat exited ${result.code}`)
    }
    return { raw: output }
  }
}

const withBodyFile = async <A>(body: string, fn: (path: string) => Promise<A>): Promise<A> => {
  const dir = await mkdtemp(join(tmpdir(), "shitrat-pi-"))
  const path = join(dir, "body.md")
  await writeFile(path, body, "utf8")
  try {
    return await fn(path)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined

const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" ? value : undefined

const resultRecord = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) return {}
  const result = value.result
  return isRecord(result) ? result : {}
}

const summarizeFiles = (files: unknown): string => {
  if (!Array.isArray(files)) return ""
  const paths = files
    .map((file) => (isRecord(file) ? stringValue(file.repo_path) : undefined))
    .filter((path): path is string => Boolean(path))
  if (paths.length === 0) return ""
  if (paths.length <= 5) return paths.join(", ")
  return `${paths.slice(0, 5).join(", ")} +${paths.length - 5} more`
}

const summarizeShitRatResult = (value: unknown): string => {
  if (!isRecord(value)) return String(value)

  const command = stringValue(value.command) ?? "shitrat"
  if (value.ok === false) {
    const error = isRecord(value.error) ? stringValue(value.error.message) : undefined
    const fix = stringValue(value.fix)
    return [`❌ ${command}`, error, fix ? `Fix: ${fix}` : undefined]
      .filter(Boolean)
      .join("\n")
  }

  const result = resultRecord(value)
  const repo = stringValue(result.repo)
  const branch = stringValue(result.branch)
  const url = stringValue(result.url)
  const author = stringValue(result.author)
  const fileCount = numberValue(result.file_count)
  const totalSize = numberValue(result.total_size)
  const files = summarizeFiles(result.files)
  const dryRun = result.dry_run === true
  const commit = isRecord(result.commit) ? result.commit : undefined
  const commitSha = commit ? stringValue(commit.sha)?.slice(0, 12) : undefined
  const commitUrl = commit ? stringValue(commit.html_url) : undefined
  const singleFile = isRecord(result.file) ? result.file : undefined
  const singleFilePath = singleFile ? stringValue(singleFile.repo_path) : undefined

  if (command.startsWith("shitrat commit-files")) {
    return [
      dryRun ? "🧪 Dry run: ShitRat multi-file commit ready" : "✅ ShitRat committed files",
      repo && branch ? `${repo}@${branch}` : repo,
      fileCount
        ? `${fileCount} file${fileCount === 1 ? "" : "s"}${totalSize ? `, ${totalSize} bytes` : ""}`
        : undefined,
      files ? `Files: ${files}` : undefined,
      commitSha ? `Commit: ${commitSha}` : undefined,
      commitUrl,
    ]
      .filter(Boolean)
      .join("\n")
  }

  if (command.startsWith("shitrat commit-file")) {
    return [
      dryRun ? "🧪 Dry run: ShitRat file commit ready" : "✅ ShitRat committed file",
      repo && branch ? `${repo}@${branch}` : repo,
      singleFilePath ? `File: ${singleFilePath}` : undefined,
      commitSha ? `Commit: ${commitSha}` : undefined,
      commitUrl,
    ]
      .filter(Boolean)
      .join("\n")
  }

  if (command.startsWith("shitrat comment")) {
    return ["✅ ShitRat posted comment", repo, url, author ? `Author: ${author}` : undefined]
      .filter(Boolean)
      .join("\n")
  }

  if (command.startsWith("shitrat review")) {
    return ["✅ ShitRat posted PR review", repo, url, author ? `Author: ${author}` : undefined]
      .filter(Boolean)
      .join("\n")
  }

  if (command.startsWith("shitrat status")) {
    const permissions = isRecord(result.permissions)
      ? Object.entries(result.permissions)
          .map(([key, permission]) => `${key}:${String(permission)}`)
          .join(", ")
      : undefined
    return [
      "✅ ShitRat repo access verified",
      repo,
      stringValue(result.default_branch) ? `Default branch: ${result.default_branch}` : undefined,
      permissions ? `Permissions: ${permissions}` : undefined,
    ]
      .filter(Boolean)
      .join("\n")
  }

  return JSON.stringify(value, null, 2)
}

const toolResult = (result: unknown) => ({
  content: [{ type: "text" as const, text: summarizeShitRatResult(result) }],
  details: result,
})

export default function shitratExtension(pi: ExtensionAPI) {
  pi.on("resources_discover", () => ({
    skillPaths: [skillPath],
  }))

  pi.registerCommand("shitrat", {
    description: "Run ShitRat GitHub App CLI status/installations from pi",
    getArgumentCompletions: (prefix) => {
      const items = [
        "installations",
        "status skillrecordings/migrate-egghead",
        "commit-file skillrecordings/migrate-egghead --branch main --message 'message' --file path --dry-run",
        "commit-files skillrecordings/migrate-egghead --branch main --message 'message' --file path --file other --dry-run",
      ]
      const filtered = items.filter((item) => item.startsWith(prefix))
      return filtered.map((value) => ({ value, label: value }))
    },
    handler: async (args, ctx) => {
      const parts = args.trim().length > 0 ? args.trim().split(/\s+/) : []
      const commandArgs = parts.length > 0 ? parts : []
      const result = await runShitRat(pi, commandArgs, ctx.signal, ctx.cwd)
      ctx.ui.notify(JSON.stringify(result, null, 2), "info")
    },
  })

  pi.registerTool({
    name: "shitrat_status",
    label: "ShitRat Status",
    description: "Verify ShitRat GitHub App access to a repository.",
    promptSnippet: "Verify ShitRat GitHub App installation and permissions for a GitHub repo",
    promptGuidelines: [
      "Use shitrat_status before posting comments or reviews as ShitRat when repo access is uncertain.",
    ],
    parameters: Type.Object({
      repo: Type.String({ description: "Repository in owner/repo form" }),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await runShitRat(pi, ["status", params.repo], signal)
      return toolResult(result)
    },
  })

  pi.registerTool({
    name: "shitrat_comment",
    label: "ShitRat Comment",
    description: "Post an issue or pull request conversation comment as shitratgit[bot].",
    promptSnippet: "Post GitHub issue or PR comments as shitratgit[bot] via the ShitRat GitHub App",
    promptGuidelines: [
      "Use shitrat_comment instead of gh issue comment when Joel wants ShitRat, not Joel, to be the GitHub actor.",
      "Use shitrat_comment only after the user has approved posting or the workflow clearly calls for publishing a comment.",
    ],
    parameters: Type.Object({
      repo: Type.String({ description: "Repository in owner/repo form" }),
      number: Type.Number({ description: "Issue or pull request number" }),
      body: Type.String({ description: "Markdown comment body" }),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await withBodyFile(params.body, (bodyFile) =>
        runShitRat(
          pi,
          ["comment", params.repo, String(params.number), "--body-file", bodyFile],
          signal,
        ),
      )
      return toolResult(result)
    },
  })

  pi.registerTool({
    name: "shitrat_commit_file",
    label: "ShitRat Commit File",
    description: "Commit one local file to GitHub as shitratgit[bot].",
    promptSnippet: "Commit a local file to GitHub as shitratgit[bot] via the ShitRat GitHub App",
    promptGuidelines: [
      "Use shitrat_commit_file instead of gh/git push when Joel wants the commit authored by ShitRat's GitHub App identity.",
      "Prefer dryRun: true first unless the user explicitly asked to write the commit.",
      "Use path when the local file is outside the repo root or should land at a different repository path.",
    ],
    parameters: Type.Object({
      repo: Type.String({ description: "Repository in owner/repo form" }),
      branch: Type.Optional(Type.String({ description: "Target branch; defaults to main" })),
      message: Type.String({ description: "Git commit message" }),
      file: Type.String({ description: "Local file to commit" }),
      path: Type.Optional(Type.String({ description: "Target path in the GitHub repository" })),
      createBranchFrom: Type.Optional(
        Type.String({ description: "Create branch from this existing branch if missing" }),
      ),
      dryRun: Type.Optional(Type.Boolean({ description: "Preview without writing to GitHub" })),
      cwd: Type.Optional(
        Type.String({ description: "Working directory to resolve relative file paths; defaults to current pi cwd" }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const args = [
        "commit-file",
        params.repo,
        "--branch",
        params.branch ?? "main",
        "--message",
        params.message,
        "--file",
        params.file,
      ]
      if (params.path) args.push("--path", params.path)
      if (params.createBranchFrom) args.push("--create-branch-from", params.createBranchFrom)
      if (params.dryRun) args.push("--dry-run")

      const result = await runShitRat(pi, args, signal, params.cwd ?? ctx.cwd)
      return toolResult(result)
    },
  })

  pi.registerTool({
    name: "shitrat_commit_files",
    label: "ShitRat Commit Files",
    description: "Atomically commit multiple local files to GitHub as shitratgit[bot].",
    promptSnippet: "Commit multiple local files atomically to GitHub as shitratgit[bot] via the ShitRat GitHub App",
    promptGuidelines: [
      "Use shitrat_commit_files when Joel wants a small multi-file GitHub API commit authored by ShitRat's GitHub App identity.",
      "Prefer dryRun: true first unless the user explicitly asked to write the commit.",
      "Use normal git for large or complex changes; shitrat_commit_files is for small intentional batches.",
    ],
    parameters: Type.Object({
      repo: Type.String({ description: "Repository in owner/repo form" }),
      branch: Type.Optional(Type.String({ description: "Target branch; defaults to main" })),
      message: Type.String({ description: "Git commit message" }),
      files: Type.Array(Type.String({ description: "Local file to include" }), {
        description: "Local files to commit; each must be inside cwd",
        minItems: 1,
      }),
      createBranchFrom: Type.Optional(
        Type.String({ description: "Create branch from this existing branch if missing" }),
      ),
      dryRun: Type.Optional(Type.Boolean({ description: "Preview without writing to GitHub" })),
      cwd: Type.Optional(
        Type.String({ description: "Working directory to resolve relative file paths; defaults to current pi cwd" }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const args = [
        "commit-files",
        params.repo,
        "--branch",
        params.branch ?? "main",
        "--message",
        params.message,
      ]
      for (const file of params.files) args.push("--file", file)
      if (params.createBranchFrom) args.push("--create-branch-from", params.createBranchFrom)
      if (params.dryRun) args.push("--dry-run")

      const result = await runShitRat(pi, args, signal, params.cwd ?? ctx.cwd)
      return toolResult(result)
    },
  })

  pi.registerTool({
    name: "shitrat_review",
    label: "ShitRat Review",
    description: "Create a pull request review as shitratgit[bot].",
    promptSnippet: "Create GitHub pull request reviews as shitratgit[bot] via the ShitRat GitHub App",
    promptGuidelines: [
      "Use shitrat_review instead of gh pr review when Joel wants ShitRat, not Joel, to approve, comment, or request changes.",
      "Use shitrat_review only after review findings are evidence-backed and the user has asked to publish or the review workflow clearly calls for publishing.",
    ],
    parameters: Type.Object({
      repo: Type.String({ description: "Repository in owner/repo form" }),
      number: Type.Number({ description: "Pull request number" }),
      event: StringEnum(["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const),
      body: Type.String({ description: "Markdown review body" }),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await withBodyFile(params.body, (bodyFile) =>
        runShitRat(
          pi,
          [
            "review",
            params.repo,
            String(params.number),
            "--event",
            params.event,
            "--body-file",
            bodyFile,
          ],
          signal,
        ),
      )
      return toolResult(result)
    },
  })
}
