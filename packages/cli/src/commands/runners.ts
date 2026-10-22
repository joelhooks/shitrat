import { Command, Options } from "@effect/cli"
import { Console, Effect, Option } from "effect"
import { writeSync } from "node:fs"
import { createOrgOctokit, ensureRunnerGroup, listOrgRunners, listRepoRunners, removeRepoRunner, listRunnerGroups, runnerWorkflowPolicy, registrationToken, RunnerApiError } from "../org-runners.js"
import { parseRepo } from "../github-app.js"
import { failure, json, success } from "../response.js"

const orgOption = Options.text("org").pipe(Options.withDescription("GitHub organization with a ShitRat App installation"))
const safeError = (error: unknown) => error instanceof RunnerApiError ? error.message : "Organization runner request failed; check App installation access."
const apiEffect = <T>(request: () => Promise<T>) => Effect.tryPromise({ try: request, catch: (error) => error })

// Set by the parsed command, not by argv position (global options can precede the verb).
export let runnerTokenInvoked = false

export const runnerTokenCmd = Command.make("runner-token", { org: orgOption }, ({ org }) =>
  Effect.gen(function* () {
    runnerTokenInvoked = true
    const octokit = yield* createOrgOctokit(org)
    const result = yield* apiEffect(() => registrationToken(octokit, org))
    // Deliberate exception to JSON output. Bypass the CLI capture/envelope completely.
    // Never pass this value to Console, an attestation, a file, or a subprocess.
    writeSync(2, `expires_at: ${result.expires_at}\n`)
    writeSync(1, `${result.token}\n`)
  }).pipe(Effect.catchAll((error) => Effect.sync(() => {
    writeSync(2, `${safeError(error)}\n`)
    process.exitCode = 1
  }))),
).pipe(Command.withDescription("Mint an org runner registration token; token only on stdout, expiry on stderr"))

const failureEffect = (command: string, error: unknown) => Effect.gen(function* () {
  yield* Console.log(json(failure(command, safeError(error), "ORG_RUNNERS_FAILED", "Check the existing App installation and endpoint permissions. Do not add App permissions.")))
  process.exitCode = 1
})

export const runnerGroupCmd = Command.make("runner-group", {
  org: orgOption,
  name: Options.text("name"),
  repo: Options.text("repo"),
  dryRun: Options.boolean("dry-run"),
  workflows: Options.text("workflow").pipe(Options.repeated),
  allWorkflows: Options.boolean("all-workflows"),
}, (input) => Effect.gen(function* () {
  yield* Effect.try({ try: () => runnerWorkflowPolicy(input.org, input.workflows, input.allWorkflows), catch: (error) => error })
  const octokit = yield* createOrgOctokit(input.org)
  const result = yield* apiEffect(() => ensureRunnerGroup(octokit, input))
  yield* Console.log(json(success("runner-group", result, [{
    command: `runners --org ${input.org} --group ${input.name}`,
    description: "Read the runners registered in this group",
  }])))
}).pipe(Effect.catchAll((error) => failureEffect("runner-group", error))))
  .pipe(Command.withDescription("Create or restrict a runner group to exactly one private repository"))

export const runnerGroupsCmd = Command.make("runner-groups", {
  org: orgOption,
  name: Options.text("name").pipe(Options.optional),
}, ({ org, name }) => Effect.gen(function* () {
  const octokit = yield* createOrgOctokit(org)
  const groups = yield* apiEffect(() => listRunnerGroups(octokit, org, Option.getOrUndefined(name)))
  yield* Console.log(json(success("runner-groups", { org, count: groups.length, groups })))
}).pipe(Effect.catchAll((error) => failureEffect("runner-groups", error))))
  .pipe(Command.withDescription("Read org runner groups, workflow policy and selected repositories"))

export const runnersCmd = Command.make("runners", {
  org: orgOption.pipe(Options.optional),
  repo: Options.text("repo").pipe(Options.optional),
  group: Options.text("group").pipe(Options.optional),
}, (options) => Effect.gen(function* () {
  const org = Option.getOrUndefined(options.org)
  const repo = Option.getOrUndefined(options.repo)
  const group = Option.getOrUndefined(options.group)
  if ((org === undefined) === (repo === undefined)) return yield* failureEffect("runners", new RunnerApiError("exactly one of --org or --repo is required; they are mutually exclusive"))
  if (repo !== undefined && group !== undefined) return yield* failureEffect("runners", new RunnerApiError("--group requires --org; omit it for repo-level runners"))
  const owner = yield* Effect.try({ try: () => repo === undefined ? org! : parseRepo(repo).owner, catch: (error) => error })
  const octokit = yield* createOrgOctokit(owner)
  const runners = repo === undefined
    ? yield* apiEffect(() => listOrgRunners(octokit, org!, group))
    : yield* apiEffect(() => listRepoRunners(octokit, repo))
  yield* Console.log(json(success("runners", { ...(repo === undefined ? { org } : { repo }), count: runners.length, runners })))
}).pipe(Effect.catchAll((error) => failureEffect("runners", error))))
  .pipe(Command.withDescription("Read organization or repository runners"))

export const runnerRemoveCmd = Command.make("runner-remove", {
  repo: Options.text("repo"),
  id: Options.integer("id"),
  dryRun: Options.boolean("dry-run"),
}, (input) => Effect.gen(function* () {
  const owner = yield* Effect.try({ try: () => {
    if (!Number.isSafeInteger(input.id) || input.id <= 0) throw new RunnerApiError("--id must be a positive safe integer")
    return parseRepo(input.repo).owner
  }, catch: (error) => error })
  const octokit = yield* createOrgOctokit(owner)
  const result = yield* apiEffect(() => removeRepoRunner(octokit, input))
  yield* Console.log(json(success("runner-remove", result, [{
    command: `runners --repo ${input.repo}`,
    description: "Read repository runners before any further action",
  }])))
}).pipe(Effect.catchAll((error) => failureEffect("runner-remove", error))))
  .pipe(Command.withDescription("Remove an offline, idle repository runner and verify absence"))
