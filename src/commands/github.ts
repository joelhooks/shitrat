import { Args, Command, Options } from "@effect/cli"
import { Console, Effect, Option } from "effect"
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
