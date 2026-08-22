import { Args, Command, Options } from "@effect/cli"
import { Console, Effect, Option } from "effect"
import { DEFAULT_X_ACCOUNT, oauth2SecretNames } from "../x/accounts.js"
import { assertOk, bearerHeaders, defaultXFetch, readJsonField, XApiError, type XFetch } from "../x/client.js"
import {
  articleStats,
  convertHtmlToContentState,
  convertMarkdownToContentState,
  type ContentState,
} from "../x/draftjs.js"
import { parseArticleLimitHeaders } from "../x/limits.js"
import { errorMessage, failure, json, success, type NextAction } from "../response.js"
import { readSecret } from "../secrets.js"

const accountOption = Options.text("account").pipe(
  Options.withDescription("X account handle used to namespace oauth2 secrets"),
  Options.withDefault(DEFAULT_X_ACCOUNT),
)

const titleOption = Options.text("title").pipe(Options.withDescription("Article title"))

const htmlFileOption = Options.text("html-file").pipe(
  Options.withDescription("Path to an HTML article body"),
  Options.optional,
)

const mdFileOption = Options.text("md-file").pipe(
  Options.withDescription("Path to a markdown article body"),
  Options.optional,
)

const coverOption = Options.text("cover").pipe(
  Options.withDescription("Local PNG/JPEG cover image path"),
  Options.optional,
)

const dryRunOption = Options.boolean("dry-run").pipe(
  Options.withDescription("Convert and inspect the payload without contacting X"),
)

const yesOption = Options.boolean("yes").pipe(
  Options.withDescription("Required for live article writes"),
)

const articleIdArg = Args.text({ name: "article-id" }).pipe(
  Args.withDescription("Draft article id returned by x article draft"),
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

const optionValue = <A>(option: Option.Option<A>): A | undefined =>
  Option.isSome(option) ? option.value : undefined

const readSource = (
  htmlFile: Option.Option<string>,
  mdFile: Option.Option<string>,
): Effect.Effect<{ kind: "html" | "markdown"; text: string; path: string }, Error> =>
  Effect.tryPromise({
    try: async () => {
      const htmlPath = optionValue(htmlFile)
      const mdPath = optionValue(mdFile)
      if (htmlPath && mdPath) throw new Error("Use either --html-file or --md-file, not both.")
      if (!htmlPath && !mdPath) throw new Error("Missing body. Use --html-file or --md-file.")
      const path = htmlPath ?? mdPath
      if (!path) throw new Error("Missing body.")
      const text = await Bun.file(path).text()
      return { kind: htmlPath ? "html" : "markdown", text, path }
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })

const toContentState = (kind: "html" | "markdown", text: string): ContentState =>
  kind === "html" ? convertHtmlToContentState(text) : convertMarkdownToContentState(text)

const draftLimitsNote =
  "X counts failed article creates against the 24h user cap of 10. Do not probe. Dry-run first."

const composerUrl = (articleId?: string): string =>
  articleId
    ? `https://x.com/compose/articles/edit/${articleId}`
    : "https://x.com/compose/articles"

const liveWriteGuard = (command: string, dryRun: boolean, yes: boolean): string | undefined => {
  if (dryRun) return undefined
  if (!yes) {
    return `${command} writes to X. Run --dry-run first, then pass --yes for the live call.`
  }
  return undefined
}

const redactUser = (payload: unknown): Record<string, unknown> | undefined => {
  const data = readJsonField(payload, ["data"])
  if (!data || typeof data !== "object") return undefined
  const user = data as Record<string, unknown>
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    subscription_type: user.subscription_type,
    verified_type: user.verified_type,
  }
}

const meCmd = Command.make("me", { account: accountOption }, ({ account }) => {
  const command = `x me --account ${account}`
  return Effect.gen(function* () {
    const names = oauth2SecretNames(account)
    const token = yield* readSecret(names.accessToken)
    const response = yield* Effect.tryPromise({
      try: () =>
        defaultXFetch({
          method: "GET",
          url: "https://api.x.com/2/users/me?user.fields=username,subscription_type,verified_type",
          headers: bearerHeaders(token),
        }),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    })
    try {
      assertOk(response)
    } catch (error) {
      yield* printFailure(
        command,
        error,
        error instanceof XApiError && error.status === 401 ? "X_AUTH_EXPIRED" : "X_ME_FAILED",
        error instanceof XApiError && error.status === 401
          ? "Refresh the OAuth2 user token, then retry."
          : "Inspect the X API error and retry.",
      )
      return
    }
    yield* printSuccess(command, {
      account,
      user: redactUser(response.json),
    })
  }).pipe(
    Effect.catchAll((error) =>
      printFailure(
        command,
        error,
        "X_ME_FAILED",
        "Lease the namespaced OAuth2 access token, then retry.",
      ),
    ),
  )
}).pipe(Command.withDescription("Read the authenticated X user without printing tokens"))

const convertCmd = Command.make(
  "convert",
  { title: titleOption, htmlFile: htmlFileOption, mdFile: mdFileOption },
  ({ title, htmlFile, mdFile }) => {
    const command = "x article convert"
    return Effect.gen(function* () {
      const source = yield* readSource(htmlFile, mdFile)
      const contentState = toContentState(source.kind, source.text)
      yield* printSuccess(command, {
        title,
        source: source.path,
        kind: source.kind,
        stats: articleStats(contentState),
        content_state: contentState,
      })
    }).pipe(
      Effect.catchAll((error) =>
        printFailure(command, error, "X_CONVERT_FAILED", "Pass --html-file or --md-file with a readable body."),
      ),
    )
  },
).pipe(Command.withDescription("Convert HTML or markdown into X Articles DraftJS content_state"))

const uploadCover = (token: string, coverPath: string, fetchImpl: XFetch) =>
  Effect.tryPromise({
    try: async () => {
      const bytes = await Bun.file(coverPath).bytes()
      const form = new FormData()
      form.set("media_category", "tweet_image")
      form.set("media_type", "image/png")
      form.set("media", new Blob([bytes], { type: "image/png" }), "cover.png")
      const response = await fetchImpl({
        method: "POST",
        url: "https://api.x.com/2/media/upload",
        headers: bearerHeaders(token),
        body: form,
      })
      assertOk(response)
      const mediaId =
        readJsonField(response.json, ["data", "id"]) ??
        readJsonField(response.json, ["media_id_string"]) ??
        readJsonField(response.json, ["id"])
      if (typeof mediaId !== "string" && typeof mediaId !== "number") {
        throw new Error("Cover upload succeeded without a media id.")
      }
      return String(mediaId)
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })

const draftCmd = Command.make(
  "draft",
  {
    title: titleOption,
    htmlFile: htmlFileOption,
    mdFile: mdFileOption,
    cover: coverOption,
    account: accountOption,
    dryRun: dryRunOption,
    yes: yesOption,
  },
  ({ title, htmlFile, mdFile, cover, account, dryRun, yes }) => {
    const command = "x article draft"
    return Effect.gen(function* () {
      const guard = liveWriteGuard(command, dryRun, yes)
      if (guard) {
        yield* printFailure(command, new Error(guard), "X_WRITE_CONFIRMATION_REQUIRED", guard)
        return
      }
      const source = yield* readSource(htmlFile, mdFile)
      const contentState = toContentState(source.kind, source.text)
      const stats = articleStats(contentState)
      const coverPath = optionValue(cover)
      if (dryRun) {
        yield* printSuccess(
          command,
          {
            dry_run: true,
            x_write: false,
            title,
            account,
            source: source.path,
            kind: source.kind,
            cover: coverPath,
            stats,
            composer_hint: composerUrl(),
            limits_note: draftLimitsNote,
          },
          [
            {
              command: "x article draft --title <title> --html-file <path> --cover <png> --yes",
              description: "Create a live X article draft. This consumes the 10/24h user cap.",
            },
          ],
        )
        return
      }

      const names = oauth2SecretNames(account)
      const token = yield* readSecret(names.accessToken)
      const mediaId = coverPath ? yield* uploadCover(token, coverPath, defaultXFetch) : undefined
      const body: Record<string, unknown> = {
        title,
        content_state: contentState,
      }
      if (mediaId) {
        body.cover_media = { media_category: "tweet_image", media_id: mediaId }
      }
      const response = yield* Effect.tryPromise({
        try: () =>
          defaultXFetch({
            method: "POST",
            url: "https://api.x.com/2/articles/draft",
            headers: { ...bearerHeaders(token), "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      })
      const limits = parseArticleLimitHeaders(response.headers)
      if (!response.ok) {
        yield* printFailure(
          command,
          new XApiError(response.status, response.text, limits),
          response.status === 429 ? "X_ARTICLE_CAP" : "X_ARTICLE_DRAFT_FAILED",
          response.status === 429
            ? "The 24h user draft cap is exhausted, including failed creates. Wait for userResetAt. Do not retry."
            : "Inspect stats with --dry-run. Large bodies have 503'd. Failed creates still consume the cap.",
          [
            {
              command: "x article draft --dry-run --title <title> --html-file <path>",
              description: "Inspect conversion stats without contacting X",
            },
          ],
        )
        return
      }
      const articleId = readJsonField(response.json, ["data", "id"])
      const id = typeof articleId === "string" ? articleId : undefined
      yield* printSuccess(command, {
        dry_run: false,
        x_write: true,
        title,
        account,
        stats,
        article_id: id,
        edit_url: composerUrl(id),
        cover_uploaded: Boolean(mediaId),
        limits,
      })
    }).pipe(
      Effect.catchAll((error) =>
        printFailure(
          command,
          error,
          "X_ARTICLE_DRAFT_FAILED",
          "Dry-run the conversion, then retry a live draft only when the 24h cap has remaining slots.",
        ),
      ),
    )
  },
).pipe(
  Command.withDescription("Create an X Article draft. Dry-run by default until --yes. Consumes the 10/24h cap."),
)

const publishCmd = Command.make(
  "publish",
  { articleId: articleIdArg, account: accountOption, dryRun: dryRunOption, yes: yesOption },
  ({ articleId, account, dryRun, yes }) => {
    const command = "x article publish"
    return Effect.gen(function* () {
      const guard = liveWriteGuard(command, dryRun, yes)
      if (guard) {
        yield* printFailure(command, new Error(guard), "X_WRITE_CONFIRMATION_REQUIRED", guard)
        return
      }
      if (dryRun) {
        yield* printSuccess(command, {
          dry_run: true,
          x_write: false,
          article_id: articleId,
          publish_url: `https://api.x.com/2/articles/${articleId}/publish`,
        })
        return
      }
      const names = oauth2SecretNames(account)
      const token = yield* readSecret(names.accessToken)
      const response = yield* Effect.tryPromise({
        try: () =>
          defaultXFetch({
            method: "POST",
            url: `https://api.x.com/2/articles/${articleId}/publish`,
            headers: bearerHeaders(token),
          }),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      })
      if (!response.ok) {
        yield* printFailure(
          command,
          new XApiError(response.status, response.text, parseArticleLimitHeaders(response.headers)),
          "X_ARTICLE_PUBLISH_FAILED",
          "Confirm the draft id in the composer, then retry with --yes.",
        )
        return
      }
      const postId = readJsonField(response.json, ["data", "post_id"])
      const id = typeof postId === "string" ? postId : undefined
      yield* printSuccess(command, {
        dry_run: false,
        x_write: true,
        article_id: articleId,
        post_id: id,
        url: id ? `https://x.com/i/web/status/${id}` : undefined,
      })
    }).pipe(
      Effect.catchAll((error) =>
        printFailure(command, error, "X_ARTICLE_PUBLISH_FAILED", "Pass a draft article id and --yes."),
      ),
    )
  },
).pipe(Command.withDescription("Publish an existing X Article draft. Requires --yes."))

const articleCmd = Command.make("article", {}, () =>
  Console.log(
    json(
      success("x article", {
        description: "X Articles draft and publish commands.",
        commands: {
          convert: "shitrat x article convert --title <title> --html-file <path>",
          draft: "shitrat x article draft --title <title> --html-file <path> --cover <png> --dry-run",
          publish: "shitrat x article publish <article-id> --dry-run",
        },
        limits_note: draftLimitsNote,
      }),
    ),
  ),
).pipe(Command.withSubcommands([convertCmd, draftCmd, publishCmd]))

export const xCmd = Command.make("x", {}, () =>
  Console.log(
    json(
      success("x", {
        description: "X API commands for @account OAuth2 user context. Articles require Premium and tweet.write.",
        commands: {
          me: "shitrat x me --account joelhooks",
          convert: "shitrat x article convert --title <title> --html-file <path>",
          draft: "shitrat x article draft --title <title> --html-file <path> --dry-run",
          publish: "shitrat x article publish <article-id> --dry-run",
        },
        auth: "OAuth 2.0 user tokens. OAuth 1.0a cannot create articles. Never print tokens.",
        limits_note: draftLimitsNote,
      }),
    ),
  ),
).pipe(Command.withSubcommands([meCmd, articleCmd]))
