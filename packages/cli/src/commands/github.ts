import { Args, Command, Options } from "@effect/cli"
import { Console, Effect, Option } from "effect"
import { createHash } from "node:crypto"
import { lstat } from "node:fs/promises"
import path from "node:path"
import {
  createRepoOctokit,
  listInstallations,
  parseRepo,
  resolveInstallationId,
  type GitHubOctokit,
} from "../github-app.js"
import { errorMessage, failure, json, success, type NextAction } from "../response.js"

const repoArg = Args.text({ name: "repo" }).pipe(
  Args.withDescription("Repository in owner/repo form"),
)

const issueNumberArg = Args.integer({ name: "number" }).pipe(
  Args.withDescription("Issue or pull request number"),
)

const bodyOption = Options.text("body").pipe(
  Options.withDescription("Markdown body text"),
  Options.optional,
)

const bodyFileOption = Options.text("body-file").pipe(
  Options.withDescription("Path to markdown body file"),
  Options.optional,
)

const eventOption = Options.choice("event", ["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const).pipe(
  Options.withDescription("Pull request review event"),
  Options.withDefault("COMMENT" as const),
)

const branchOption = Options.text("branch").pipe(
  Options.withDescription("Target branch"),
  Options.withDefault("main"),
)

const messageOption = Options.text("message").pipe(
  Options.withDescription("Git commit message"),
)

const fileOption = Options.text("file").pipe(
  Options.withDescription("Local file to commit"),
)

const repoPathOption = Options.text("path").pipe(
  Options.withDescription("Target file path in the GitHub repository; defaults to --file relative to cwd"),
  Options.optional,
)

const filesOption = Options.text("file").pipe(
  Options.withDescription("Local file to include in an atomic multi-file commit; repeat for each file"),
  Options.repeated,
)

const createBranchFromOption = Options.text("create-branch-from").pipe(
  Options.withDescription("Create --branch from this existing branch/ref if it does not exist"),
  Options.optional,
)

const baseOption = Options.text("base").pipe(
  Options.withDescription("Base branch to merge into"),
  Options.withDefault("main"),
)

const headOption = Options.text("head").pipe(
  Options.withDescription("Head branch or ref to merge from"),
)

const dryRunOption = Options.boolean("dry-run").pipe(
  Options.withDescription("Preview the commit payload without contacting GitHub or writing anything"),
)

const shitRatCommitIdentity = () => ({
  name: "shitratgit[bot]",
  email: "286405550+shitratgit[bot]@users.noreply.github.com",
  date: new Date().toISOString(),
})

const printSuccess = (command: string, result: unknown, nextActions: readonly NextAction[] = []) =>
  Console.log(json(success(command, result, nextActions)))

const printFailure = (
  command: string,
  error: unknown,
  code: string,
  fix: string,
  nextActions: readonly NextAction[] = [],
) => Console.log(json(failure(command, errorMessage(error), code, fix, nextActions)))

const optionToUndefined = <A>(option: Option.Option<A>): A | undefined =>
  Option.isSome(option) ? option.value : undefined

const readBody = (
  command: string,
  body: Option.Option<string>,
  bodyFile: Option.Option<string>,
): Effect.Effect<string, Error> =>
  Effect.tryPromise({
    try: async () => {
      const inline = optionToUndefined(body)
      const file = optionToUndefined(bodyFile)
      if (inline && file) throw new Error("Use either --body or --body-file, not both.")
      if (inline) return inline
      if (file) return await Bun.file(file).text()
      throw new Error(`Missing body. Use ${command} --body '<markdown>' or --body-file review.md`)
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })

const normalizeRepoPath = (value: string): string => {
  const raw = value.trim()
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) {
    throw new Error(`Invalid repository path '${value}'. Use a relative path, not an absolute path.`)
  }

  const normalized = raw.replaceAll("\\", "/").replace(/^\.\//, "")
  const parts = normalized.split("/").filter((part) => part.length > 0 && part !== ".")
  if (parts.length === 0 || parts.some((part) => part === "..")) {
    throw new Error(`Invalid repository path '${value}'. Use a relative path without '..'.`)
  }
  if (parts.some((part) => part === ".git")) {
    throw new Error("Refusing to commit files under .git/.")
  }
  return parts.join("/")
}

const deriveRepoPath = (file: string, explicitPath: Option.Option<string>): string => {
  const provided = optionToUndefined(explicitPath)
  if (provided) return normalizeRepoPath(provided)

  const resolved = path.resolve(file)
  const relative = path.relative(process.cwd(), resolved)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Absolute/outside-cwd --file requires an explicit --path <repo-path>.")
  }

  return normalizeRepoPath(relative)
}

const MAX_COMMIT_FILE_BYTES = 5 * 1024 * 1024
const MAX_COMMIT_BATCH_BYTES = 10 * 1024 * 1024

interface PreparedCommitFile {
  readonly localPath: string
  readonly repoPath: string
  readonly size: number
  readonly sha256: string
  readonly base64: string
}

const prepareCommitFile = (
  file: string,
  explicitPath: Option.Option<string>,
): Effect.Effect<PreparedCommitFile, Error> =>
  Effect.tryPromise({
    try: async () => {
      const localPath = path.resolve(file)
      const repoPath = deriveRepoPath(file, explicitPath)
      const info = await lstat(localPath).catch(() => undefined)
      if (!info) throw new Error(`Local file not found: ${file}`)
      if (info.isSymbolicLink()) throw new Error(`Refusing to commit symlink: ${file}`)
      if (!info.isFile()) throw new Error(`Refusing to commit non-file path: ${file}`)
      if (info.size > MAX_COMMIT_FILE_BYTES) {
        throw new Error(
          `File '${file}' is ${info.size} bytes; commit-file is capped at ${MAX_COMMIT_FILE_BYTES} bytes. Use normal git for large artifacts.`,
        )
      }
      const source = Bun.file(localPath)
      const bytes = Buffer.from(await source.arrayBuffer())
      return {
        localPath,
        repoPath,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        base64: bytes.toString("base64"),
      }
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })

const isNotFoundError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "status" in error && error.status === 404

const isAlreadyExistsError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null || !("status" in error)) return false
  const message = "message" in error ? String(error.message) : ""
  return error.status === 422 && /already exists/i.test(message)
}

const validateBranchName = (value: string): string => {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("//") ||
    value.includes("..") ||
    value.includes("@{") ||
    value.endsWith(".lock") ||
    /[\u0000-\u001f\u007f\s~^:?*[\\]/.test(value)
  ) {
    throw new Error(`Invalid branch '${value}'. Use a normal branch name like main or shitrat/update-notes.`)
  }
  return value
}

const normalizeGitRef = (value: string): string => {
  const trimmed = value.trim()
  if (trimmed.startsWith("refs/heads/")) {
    return validateBranchName(trimmed.slice("refs/heads/".length))
  }
  if (trimmed.startsWith("heads/")) return validateBranchName(trimmed.slice("heads/".length))
  return validateBranchName(trimmed)
}

interface BranchHead {
  readonly headSha: string
  readonly createdBranch: boolean
}

interface CommitBranchBase {
  readonly headSha: string
  readonly branchExists: boolean
}

const ensureBranch = (
  octokit: GitHubOctokit,
  repoRef: ReturnType<typeof parseRepo>,
  targetBranch: string,
  createBranchFrom: Option.Option<string>,
): Effect.Effect<BranchHead, Error> =>
  Effect.tryPromise({
    try: async () => {
      try {
        const branch = await octokit.rest.repos.getBranch({
          owner: repoRef.owner,
          repo: repoRef.repo,
          branch: targetBranch,
        })
        return { headSha: branch.data.commit.sha, createdBranch: false }
      } catch (error) {
        if (!isNotFoundError(error)) throw error

        const base = optionToUndefined(createBranchFrom)
        if (!base) {
          throw new Error(
            `Branch '${targetBranch}' does not exist. Pass --create-branch-from <base-branch> to create it.`,
          )
        }

        const baseBranch = normalizeGitRef(base)
        const baseRef = await octokit.rest.git.getRef({
          owner: repoRef.owner,
          repo: repoRef.repo,
          ref: `heads/${baseBranch}`,
        })

        try {
          await octokit.rest.git.createRef({
            owner: repoRef.owner,
            repo: repoRef.repo,
            ref: `refs/heads/${targetBranch}`,
            sha: baseRef.data.object.sha,
          })
          return { headSha: baseRef.data.object.sha, createdBranch: true }
        } catch (createError) {
          if (!isAlreadyExistsError(createError)) throw createError
          const branch = await octokit.rest.repos.getBranch({
            owner: repoRef.owner,
            repo: repoRef.repo,
            branch: targetBranch,
          })
          return { headSha: branch.data.commit.sha, createdBranch: false }
        }
      }
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })

const resolveBranchBase = (
  octokit: GitHubOctokit,
  repoRef: ReturnType<typeof parseRepo>,
  targetBranch: string,
  createBranchFrom: Option.Option<string>,
): Effect.Effect<CommitBranchBase, Error> =>
  Effect.tryPromise({
    try: async () => {
      try {
        const branch = await octokit.rest.repos.getBranch({
          owner: repoRef.owner,
          repo: repoRef.repo,
          branch: targetBranch,
        })
        return { headSha: branch.data.commit.sha, branchExists: true }
      } catch (error) {
        if (!isNotFoundError(error)) throw error

        const base = optionToUndefined(createBranchFrom)
        if (!base) {
          throw new Error(
            `Branch '${targetBranch}' does not exist. Pass --create-branch-from <base-branch> to create it.`,
          )
        }

        const baseBranch = normalizeGitRef(base)
        const baseRef = await octokit.rest.git.getRef({
          owner: repoRef.owner,
          repo: repoRef.repo,
          ref: `heads/${baseBranch}`,
        })
        return { headSha: baseRef.data.object.sha, branchExists: false }
      }
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })

const findDuplicateRepoPath = (files: readonly PreparedCommitFile[]): string | undefined => {
  const seen = new Set<string>()
  for (const file of files) {
    if (seen.has(file.repoPath)) return file.repoPath
    seen.add(file.repoPath)
  }
  return undefined
}

const preflightRepoPath = async (
  octokit: GitHubOctokit,
  repoRef: ReturnType<typeof parseRepo>,
  ref: string,
  repoPath: string,
): Promise<void> => {
  const parts = repoPath.split("/")
  for (let index = 0; index < parts.length; index += 1) {
    const candidate = parts.slice(0, index + 1).join("/")
    const isLeaf = index === parts.length - 1
    try {
      const existing = await octokit.rest.repos.getContent({
        owner: repoRef.owner,
        repo: repoRef.repo,
        path: candidate,
        ref,
      })

      if (!isLeaf) {
        if (!Array.isArray(existing.data)) {
          throw new Error(
            `Repository parent path '${candidate}' exists but is not a directory.`,
          )
        }
        continue
      }

      if (Array.isArray(existing.data)) {
        throw new Error(`Repository path '${repoPath}' exists as a directory.`)
      }
      if (existing.data.type !== "file") {
        throw new Error(
          `Repository path '${repoPath}' exists but is ${existing.data.type}, not a file.`,
        )
      }
    } catch (error) {
      if (isNotFoundError(error)) return
      throw error
    }
  }
}

export const installationsCmd = Command.make("installations", {}, () =>
  Effect.gen(function* () {
    const result = yield* listInstallations
    yield* printSuccess("installations", { count: result.length, installations: result }, [
      {
        command: "status <repo>",
        description: "Verify ShitRat can access a repository",
        params: { repo: { required: true, description: "Repository in owner/repo form" } },
      },
    ])
  }).pipe(
    Effect.catchAll((error) =>
      printFailure(
        "installations",
        error,
        "INSTALLATIONS_FAILED",
        "Verify shitrat_github_app_id and shitrat_github_private_key are present in agent-secrets or env.",
      ),
    ),
  ),
).pipe(Command.withDescription("List ShitRat GitHub App installations"))

export const statusCmd = Command.make("status", { repo: repoArg }, ({ repo }) =>
  Effect.gen(function* () {
    const repoRef = parseRepo(repo)
    const installationId = yield* resolveInstallationId(repoRef.owner)
    const { octokit, token } = yield* createRepoOctokit(repoRef)
    const repository = yield* Effect.tryPromise(() =>
      octokit.rest.repos.get({ owner: repoRef.owner, repo: repoRef.repo }),
    )

    yield* printSuccess(
      `status ${repoRef.fullName}`,
      {
        app: "shitratgit",
        actor: "shitratgit[bot]",
        repo: repository.data.full_name,
        private: repository.data.private,
        default_branch: repository.data.default_branch,
        installation_id: installationId,
        token_expires_at: token.expiresAt,
        permissions: token.permissions,
      },
      [
        {
          command: "comment <repo> <number> --body-file <path>",
          description: "Post an issue or PR conversation comment as ShitRat",
          params: {
            repo: { value: repoRef.fullName, required: true },
            number: { description: "Issue or PR number", required: true },
            path: { description: "Markdown body file", required: true },
          },
        },
        {
          command: "review <repo> <number> --event <event> --body-file <path>",
          description: "Create a pull request review as ShitRat",
          params: {
            repo: { value: repoRef.fullName, required: true },
            number: { description: "PR number", required: true },
            event: { enum: ["APPROVE", "REQUEST_CHANGES", "COMMENT"], default: "COMMENT" },
            path: { description: "Markdown body file", required: true },
          },
        },
        {
          command: "commit-file <repo> --branch <branch> --message <message> --file <file> [--path <path>] [--dry-run]",
          description: "Commit one local file to GitHub as ShitRat",
          params: {
            repo: { value: repoRef.fullName, required: true },
            branch: { default: repository.data.default_branch ?? "main" },
            message: { description: "Git commit message", required: true },
            file: { description: "Local file to commit", required: true },
            path: { description: "Target repository path" },
          },
        },
        {
          command: "commit-files <repo> --branch <branch> --message <message> --file <file> [--file <file>...] [--dry-run]",
          description: "Atomically commit multiple local files to GitHub as ShitRat",
          params: {
            repo: { value: repoRef.fullName, required: true },
            branch: { default: repository.data.default_branch ?? "main" },
            message: { description: "Git commit message", required: true },
            file: { description: "Repeat --file for each local file", required: true },
          },
        },
      ],
    )
  }).pipe(
    Effect.catchAll((error) =>
      printFailure(
        `status ${repo}`,
        error,
        "STATUS_FAILED",
        "Check that the app is installed on the repo owner and the repo name is owner/repo.",
      ),
    ),
  ),
).pipe(Command.withDescription("Verify ShitRat GitHub App access to a repo"))

export const commentCmd = Command.make(
  "comment",
  { repo: repoArg, number: issueNumberArg, body: bodyOption, bodyFile: bodyFileOption },
  ({ repo, number, body, bodyFile }) =>
    Effect.gen(function* () {
      const repoRef = parseRepo(repo)
      const bodyText = yield* readBody(`comment ${repoRef.fullName} ${number}`, body, bodyFile)
      const { octokit, token } = yield* createRepoOctokit(repoRef)
      const comment = yield* Effect.tryPromise(() =>
        octokit.rest.issues.createComment({
          owner: repoRef.owner,
          repo: repoRef.repo,
          issue_number: number,
          body: bodyText,
        }),
      )

      yield* printSuccess(
        `comment ${repoRef.fullName} ${number}`,
        {
          repo: repoRef.fullName,
          number,
          url: comment.data.html_url,
          author: comment.data.user?.login,
          installation_id: token.installationId,
        },
        [
          {
            command: "comment <repo> <number> --body-file <path>",
            description: "Post another issue or PR conversation comment as ShitRat",
            params: {
              repo: { value: repoRef.fullName, required: true },
              number: { value: number, required: true },
              path: { required: true, description: "Markdown body file" },
            },
          },
        ],
      )
    }).pipe(
      Effect.catchAll((error) =>
        printFailure(
          `comment ${repo} ${number}`,
          error,
          "COMMENT_FAILED",
          "Verify Issues: write permission, installation access to the repo, and that the issue/PR number exists.",
        ),
      ),
    ),
).pipe(Command.withDescription("Post an issue or PR conversation comment as ShitRat"))

export const commitFileCmd = Command.make(
  "commit-file",
  {
    repo: repoArg,
    branch: branchOption,
    message: messageOption,
    file: fileOption,
    repoPath: repoPathOption,
    createBranchFrom: createBranchFromOption,
    dryRun: dryRunOption,
  },
  ({ repo, branch, message, file, repoPath, createBranchFrom, dryRun }) =>
    Effect.gen(function* () {
      const repoRef = parseRepo(repo)
      const targetBranch = normalizeGitRef(branch)
      const prepared = yield* prepareCommitFile(file, repoPath)
      const command = `commit-file ${repoRef.fullName}`

      if (dryRun) {
        yield* printSuccess(
          command,
          {
            dry_run: true,
            repo: repoRef.fullName,
            branch: targetBranch,
            message,
            file: {
              local_path: prepared.localPath,
              repo_path: prepared.repoPath,
              size: prepared.size,
              sha256: prepared.sha256,
            },
            github_write: false,
          },
          [
            {
              command: "commit-file <repo> --branch <branch> --message <message> --file <file> [--path <path>]",
              description: "Commit this local file to GitHub as ShitRat",
              params: {
                repo: { value: repoRef.fullName, required: true },
                branch: { value: targetBranch, default: "main" },
                message: { value: message, required: true },
                file: { value: prepared.localPath, required: true },
                path: { value: prepared.repoPath },
              },
            },
          ],
        )
        return
      }

      const { octokit, token } = yield* createRepoOctokit(repoRef)
      const branchHead = yield* ensureBranch(octokit, repoRef, targetBranch, createBranchFrom)

      const existingSha = yield* Effect.tryPromise({
        try: async () => {
          try {
            const existing = await octokit.rest.repos.getContent({
              owner: repoRef.owner,
              repo: repoRef.repo,
              path: prepared.repoPath,
              ref: targetBranch,
            })

            if (Array.isArray(existing.data) || existing.data.type !== "file") {
              throw new Error(`Repository path '${prepared.repoPath}' exists but is not a file.`)
            }

            return existing.data.sha
          } catch (error) {
            if (isNotFoundError(error)) return undefined
            throw error
          }
        },
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      })

      const fileRequest = {
            owner: repoRef.owner,
            repo: repoRef.repo,
            path: prepared.repoPath,
            message,
            content: prepared.base64,
            branch: targetBranch,
            author: shitRatCommitIdentity(),
            committer: shitRatCommitIdentity(),
            ...(existingSha ? { sha: existingSha } : {}),
          }

      const response = yield* Effect.tryPromise({
        try: () => octokit.rest.repos.createOrUpdateFileContents(fileRequest),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      })

      yield* printSuccess(
        command,
        {
          repo: repoRef.fullName,
          branch: targetBranch,
          action: existingSha ? "updated" : "created",
          created_branch: branchHead.createdBranch,
          file: {
            local_path: prepared.localPath,
            repo_path: prepared.repoPath,
            size: prepared.size,
            sha256: prepared.sha256,
            content_url: response.data.content?.html_url,
          },
          commit: {
            sha: response.data.commit.sha,
            html_url: response.data.commit.html_url,
          },
          actor: "shitratgit[bot]",
          installation_id: token.installationId,
        },
        [
          {
            command: "status <repo>",
            description: "Verify ShitRat still has access to this repository",
            params: { repo: { value: repoRef.fullName, required: true } },
          },
          {
            command: "commit-file <repo> --branch <branch> --message <message> --file <file> [--path <path>]",
            description: "Commit another local file to GitHub as ShitRat",
            params: {
              repo: { value: repoRef.fullName, required: true },
              branch: { value: targetBranch, default: "main" },
              message: { required: true },
              file: { required: true },
              path: { description: "Target repository path" },
            },
          },
        ],
      )
    }).pipe(
      Effect.catchAll((error) =>
        printFailure(
          `commit-file ${repo}`,
          error,
          "COMMIT_FILE_FAILED",
          "Verify Contents: write permission, repo installation access, branch existence, and file/path arguments. Use --dry-run first if unsure.",
          [
            {
              command: "commit-file <repo> --branch <branch> --message <message> --file <file> [--path <path>] [--dry-run]",
              description: "Preview or retry committing a local file as ShitRat",
              params: {
                repo: { value: repo, required: true },
                branch: { default: "main" },
                message: { required: true },
                file: { required: true },
                path: { description: "Target repository path" },
              },
            },
          ],
        ),
      ),
    ),
).pipe(Command.withDescription("Commit one local file to GitHub as ShitRat"))


export const commitFilesCmd = Command.make(
  "commit-files",
  {
    repo: repoArg,
    branch: branchOption,
    message: messageOption,
    files: filesOption,
    createBranchFrom: createBranchFromOption,
    dryRun: dryRunOption,
  },
  ({ repo, branch, message, files, createBranchFrom, dryRun }) =>
    Effect.gen(function* () {
      const repoRef = parseRepo(repo)
      const targetBranch = normalizeGitRef(branch)
      const command = `commit-files ${repoRef.fullName}`

      if (files.length === 0) {
        throw new Error("Pass at least one --file <path>.")
      }

      const preparedFiles = yield* Effect.forEach(files, (file) =>
        prepareCommitFile(file, Option.none()),
      )
      const duplicate = findDuplicateRepoPath(preparedFiles)
      if (duplicate) {
        throw new Error(`Duplicate repository path '${duplicate}'. Each --file must map to one unique path.`)
      }
      const totalBytes = preparedFiles.reduce((sum, prepared) => sum + prepared.size, 0)
      if (totalBytes > MAX_COMMIT_BATCH_BYTES) {
        throw new Error(
          `Commit batch is ${totalBytes} bytes; commit-files is capped at ${MAX_COMMIT_BATCH_BYTES} bytes. Use normal git for larger changes.`,
        )
      }

      const fileReceipts = preparedFiles.map((prepared) => ({
        local_path: prepared.localPath,
        repo_path: prepared.repoPath,
        size: prepared.size,
        sha256: prepared.sha256,
      }))

      if (dryRun) {
        yield* printSuccess(
          command,
          {
            dry_run: true,
            repo: repoRef.fullName,
            branch: targetBranch,
            message,
            files: fileReceipts,
            file_count: preparedFiles.length,
            total_size: totalBytes,
            github_write: false,
          },
          [
            {
              command: "commit-files <repo> --branch <branch> --message <message> --file <file> [--file <file>...]",
              description: "Atomically commit these local files to GitHub as ShitRat",
              params: {
                repo: { value: repoRef.fullName, required: true },
                branch: { value: targetBranch, default: "main" },
                message: { value: message, required: true },
                file: { required: true, description: "Repeat --file for each local file" },
              },
            },
          ],
        )
        return
      }

      const { octokit, token } = yield* createRepoOctokit(repoRef)
      const branchBase = yield* resolveBranchBase(octokit, repoRef, targetBranch, createBranchFrom)

      const commitResult = yield* Effect.tryPromise({
        try: async () => {
          const baseCommit = await octokit.rest.git.getCommit({
            owner: repoRef.owner,
            repo: repoRef.repo,
            commit_sha: branchBase.headSha,
          })

          await Promise.all(
            preparedFiles.map((prepared) =>
              preflightRepoPath(octokit, repoRef, branchBase.headSha, prepared.repoPath),
            ),
          )

          const blobs = await Promise.all(
            preparedFiles.map(async (prepared) => {
              const blob = await octokit.rest.git.createBlob({
                owner: repoRef.owner,
                repo: repoRef.repo,
                content: prepared.base64,
                encoding: "base64",
              })
              return { prepared, sha: blob.data.sha }
            }),
          )

          const tree = await octokit.rest.git.createTree({
            owner: repoRef.owner,
            repo: repoRef.repo,
            base_tree: baseCommit.data.tree.sha,
            tree: blobs.map(({ prepared, sha }) => ({
              path: prepared.repoPath,
              mode: "100644" as const,
              type: "blob" as const,
              sha,
            })),
          })

          const newCommit = await octokit.rest.git.createCommit({
            owner: repoRef.owner,
            repo: repoRef.repo,
            message,
            tree: tree.data.sha,
            parents: [branchBase.headSha],
            author: shitRatCommitIdentity(),
            committer: shitRatCommitIdentity(),
          })

          if (branchBase.branchExists) {
            await octokit.rest.git.updateRef({
              owner: repoRef.owner,
              repo: repoRef.repo,
              ref: `heads/${targetBranch}`,
              sha: newCommit.data.sha,
              force: false,
            })
            return { commit: newCommit.data, createdBranch: false }
          }

          try {
            await octokit.rest.git.createRef({
              owner: repoRef.owner,
              repo: repoRef.repo,
              ref: `refs/heads/${targetBranch}`,
              sha: newCommit.data.sha,
            })
            return { commit: newCommit.data, createdBranch: true }
          } catch (createError) {
            if (!isAlreadyExistsError(createError)) throw createError
            await octokit.rest.git.updateRef({
              owner: repoRef.owner,
              repo: repoRef.repo,
              ref: `heads/${targetBranch}`,
              sha: newCommit.data.sha,
              force: false,
            })
            return { commit: newCommit.data, createdBranch: false }
          }
        },
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      })

      yield* printSuccess(
        command,
        {
          repo: repoRef.fullName,
          branch: targetBranch,
          created_branch: commitResult.createdBranch,
          files: fileReceipts,
          file_count: preparedFiles.length,
          total_size: totalBytes,
          commit: {
            sha: commitResult.commit.sha,
            html_url: commitResult.commit.html_url,
          },
          actor: "shitratgit[bot]",
          installation_id: token.installationId,
        },
        [
          {
            command: "status <repo>",
            description: "Verify ShitRat still has access to this repository",
            params: { repo: { value: repoRef.fullName, required: true } },
          },
          {
            command: "commit-files <repo> --branch <branch> --message <message> --file <file> [--file <file>...] [--dry-run]",
            description: "Commit another small batch of files atomically as ShitRat",
            params: {
              repo: { value: repoRef.fullName, required: true },
              branch: { value: targetBranch, default: "main" },
              message: { required: true },
              file: { required: true, description: "Repeat --file for each local file" },
            },
          },
        ],
      )
    }).pipe(
      Effect.catchAll((error) =>
        printFailure(
          `commit-files ${repo}`,
          error,
          "COMMIT_FILES_FAILED",
          "Verify Contents: write permission, repo installation access, branch existence, and that every --file is inside cwd. Use --dry-run first if unsure.",
          [
            {
              command: "commit-files <repo> --branch <branch> --message <message> --file <file> [--file <file>...] [--dry-run]",
              description: "Preview or retry an atomic multi-file commit as ShitRat",
              params: {
                repo: { value: repo, required: true },
                branch: { default: "main" },
                message: { required: true },
                file: { required: true, description: "Repeat --file for each local file" },
              },
            },
          ],
        ),
      ),
    ),
).pipe(Command.withDescription("Atomically commit multiple local files to GitHub as ShitRat"))

export const mergeCmd = Command.make(
  "merge",
  {
    repo: repoArg,
    base: baseOption,
    head: headOption,
    message: Options.text("message").pipe(
      Options.withDescription("Merge commit message; defaults to GitHub's merge message"),
      Options.optional,
    ),
    dryRun: dryRunOption,
  },
  ({ repo, base, head, message, dryRun }) =>
    Effect.gen(function* () {
      const repoRef = parseRepo(repo)
      const baseBranch = normalizeGitRef(base)
      const headRef = normalizeGitRef(head)
      const command = `merge ${repoRef.fullName}`
      const mergeMessage = optionToUndefined(message)

      if (dryRun) {
        yield* printSuccess(
          command,
          {
            dry_run: true,
            repo: repoRef.fullName,
            base: baseBranch,
            head: headRef,
            message: mergeMessage,
            github_write: false,
          },
          [
            {
              command: "merge <repo> --base <base-branch> --head <head-branch> [--message <message>]",
              description: "Merge the head branch into the base branch as ShitRat",
              params: {
                repo: { value: repoRef.fullName, required: true },
                base: { value: baseBranch, default: "main" },
                head: { value: headRef, required: true },
                message: { description: "Merge commit message" },
              },
            },
          ],
        )
        return
      }

      const { octokit, token } = yield* createRepoOctokit(repoRef)
      const response = yield* Effect.tryPromise({
        try: () =>
          octokit.rest.repos.merge({
            owner: repoRef.owner,
            repo: repoRef.repo,
            base: baseBranch,
            head: headRef,
            ...(mergeMessage ? { commit_message: mergeMessage } : {}),
          }),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      })

      yield* printSuccess(
        command,
        {
          repo: repoRef.fullName,
          base: baseBranch,
          head: headRef,
          commit: {
            sha: response.data.sha,
            html_url: response.data.html_url,
            message: response.data.commit.message,
          },
          actor: "shitratgit[bot]",
          installation_id: token.installationId,
        },
        [
          {
            command: "status <repo>",
            description: "Verify ShitRat still has access to this repository",
            params: { repo: { value: repoRef.fullName, required: true } },
          },
        ],
      )
    }).pipe(
      Effect.catchAll((error) =>
        printFailure(
          `merge ${repo}`,
          error,
          "MERGE_FAILED",
          "Verify Contents: write permission, branch names, installation access, and that GitHub can merge the branches cleanly. Use --dry-run first if unsure.",
          [
            {
              command: "merge <repo> --base <base-branch> --head <head-branch> [--message <message>] [--dry-run]",
              description: "Preview or retry merging a branch as ShitRat",
              params: {
                repo: { value: repo, required: true },
                base: { default: "main" },
                head: { required: true },
              },
            },
          ],
        ),
      ),
    ),
).pipe(Command.withDescription("Merge one branch into another as ShitRat"))

export const reviewCmd = Command.make(
  "review",
  {
    repo: repoArg,
    number: issueNumberArg,
    event: eventOption,
    body: bodyOption,
    bodyFile: bodyFileOption,
  },
  ({ repo, number, event, body, bodyFile }) =>
    Effect.gen(function* () {
      const repoRef = parseRepo(repo)
      const bodyText = yield* readBody(`review ${repoRef.fullName} ${number}`, body, bodyFile)
      const { octokit, token } = yield* createRepoOctokit(repoRef)
      const review = yield* Effect.tryPromise(() =>
        octokit.rest.pulls.createReview({
          owner: repoRef.owner,
          repo: repoRef.repo,
          pull_number: number,
          event,
          body: bodyText,
        }),
      )

      yield* printSuccess(
        `review ${repoRef.fullName} ${number}`,
        {
          repo: repoRef.fullName,
          number,
          event,
          state: review.data.state,
          url: review.data.html_url,
          author: review.data.user?.login,
          installation_id: token.installationId,
        },
        [
          {
            command: "review <repo> <number> --event <event> --body-file <path>",
            description: "Create another pull request review as ShitRat",
            params: {
              repo: { value: repoRef.fullName, required: true },
              number: { value: number, required: true },
              event: { enum: ["APPROVE", "REQUEST_CHANGES", "COMMENT"], value: event },
              path: { required: true, description: "Markdown body file" },
            },
          },
        ],
      )
    }).pipe(
      Effect.catchAll((error) =>
        printFailure(
          `review ${repo} ${number}`,
          error,
          "REVIEW_FAILED",
          "Verify Pull requests: write permission, installation access to the repo, and that the number is a pull request.",
        ),
      ),
    ),
).pipe(Command.withDescription("Create a pull request review as ShitRat"))
