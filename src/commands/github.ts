import { Args, Command, Options } from "@effect/cli"
import { Console, Effect, Option } from "effect"
import { createHash } from "node:crypto"
import path from "node:path"
import { createRepoOctokit, listInstallations, parseRepo, resolveInstallationId } from "../github-app.js"
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

const createBranchFromOption = Options.text("create-branch-from").pipe(
  Options.withDescription("Create --branch from this existing branch/ref if it does not exist"),
  Options.optional,
)

const dryRunOption = Options.boolean("dry-run").pipe(
  Options.withDescription("Preview the commit payload without contacting GitHub or writing anything"),
)

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
      const source = Bun.file(localPath)
      if (!(await source.exists())) throw new Error(`Local file not found: ${file}`)
      const bytes = Buffer.from(await source.arrayBuffer())
      return {
        localPath,
        repoPath: deriveRepoPath(file, explicitPath),
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

      const createdBranch = yield* Effect.tryPromise({
        try: async () => {
          try {
            await octokit.rest.repos.getBranch({
              owner: repoRef.owner,
              repo: repoRef.repo,
              branch: targetBranch,
            })
            return false
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
              return true
            } catch (createError) {
              if (isAlreadyExistsError(createError)) return false
              throw createError
            }
          }
        },
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      })

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

      const response = yield* Effect.tryPromise({
        try: () =>
          octokit.rest.repos.createOrUpdateFileContents({
            owner: repoRef.owner,
            repo: repoRef.repo,
            path: prepared.repoPath,
            message,
            content: prepared.base64,
            branch: targetBranch,
            sha: existingSha,
          }),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      })

      yield* printSuccess(
        command,
        {
          repo: repoRef.fullName,
          branch: targetBranch,
          action: existingSha ? "updated" : "created",
          created_branch: createdBranch,
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
