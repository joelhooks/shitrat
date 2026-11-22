import { Args, Command, Options } from "@effect/cli"
import { Console, Effect, Option } from "effect"
import { writeSync } from "node:fs"
import { addRunnerToGroup, changeRunnerGroup, getRunnerGroup, groupWorkflowPolicy, type RunnerGroupVisibility, createOrgOctokit, ensureRunnerGroup, listOrgRunners, listRepoRunners, removeRepoRunner, listRunnerGroups, runnerWorkflowPolicy, registrationToken, RunnerApiError, RunnerRateLimitError } from "../org-runners.js"
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

const validateOrg = (org: string) => Effect.try({ try: () => {
  if (!/^[a-z\d][a-z\d-]*$/i.test(org)) throw new RunnerApiError("invalid --org")
}, catch: (error) => error })
const groupArg = Args.text({ name: "group" }).pipe(Args.withDescription("Runner group ID or exact name"))
const groupWorkflows = Options.text("workflow").pipe(Options.repeated)
const allWorkflows = Options.boolean("all-workflows")
const yes = Options.boolean("yes").pipe(Options.withDescription("Send the request; by default preview only"))
const groupOptions = {
  org: orgOption,
  visibility: Options.choice<RunnerGroupVisibility, readonly RunnerGroupVisibility[]>("visibility", ["selected", "private", "all"]).pipe(Options.optional),
  repo: Options.text("repo").pipe(Options.repeated),
  allowPublic: Options.boolean("allow-public"),
  restrictedToWorkflows: Options.boolean("restricted-to-workflows"),
  workflows: groupWorkflows,
  allWorkflows,
  yes,
}
const groupNext = (org: string) => [{ command: `runner-group get <group> --org ${org}`, description: "Read the effective group policy and repository access" }]
type GroupChange = Parameters<typeof changeRunnerGroup>[1]
const changeGroup = (input: GroupChange) => {
  const command = `runner-group ${input.action}`
  return Effect.gen(function* () {
    yield* validateOrg(input.org)
    yield* Effect.try({ try: () => groupWorkflowPolicy(input), catch: (error) => error })
    const octokit = yield* createOrgOctokit(input.org)
    const result = yield* apiEffect(() => changeRunnerGroup(octokit, input))
    yield* Console.log(json(success(command, result, groupNext(input.org))))
  }).pipe(Effect.catchAll((error) => failureEffect(command, error)))
}
const groupCreateCmd = Command.make("create", { ...groupOptions, name: Options.text("name") }, (input) =>
  changeGroup({ ...input, action: "create", visibility: Option.getOrUndefined(input.visibility) }))
const groupUpdateCmd = Command.make("update", { ...groupOptions, group: groupArg }, (input) =>
  changeGroup({ ...input, action: "update", visibility: Option.getOrUndefined(input.visibility) }))
const groupGetCmd = Command.make("get", { org: orgOption, group: groupArg }, ({ org, group }) => Effect.gen(function* () {
  yield* validateOrg(org)
  const octokit = yield* createOrgOctokit(org)
  const result = yield* apiEffect(() => getRunnerGroup(octokit, org, group))
  yield* Console.log(json(success("runner-group get", result)))
}).pipe(Effect.catchAll((error) => failureEffect("runner-group get", error))))
const groupAddRunnerCmd = Command.make("add-runner", {
  org: orgOption, group: groupArg, id: Args.integer({ name: "runner-id" }), yes,
}, (input) => Effect.gen(function* () {
  yield* validateOrg(input.org)
  if (!Number.isSafeInteger(input.id) || input.id <= 0) return yield* failureEffect("runner-group add-runner", new RunnerApiError("runner id must be a positive safe integer"))
  const octokit = yield* createOrgOctokit(input.org)
  const result = yield* apiEffect(() => addRunnerToGroup(octokit, input))
  yield* Console.log(json(success("runner-group add-runner", result, groupNext(input.org))))
}).pipe(Effect.catchAll((error) => failureEffect("runner-group add-runner", error))))

const failureEffect = (command: string, error: unknown) => Effect.gen(function* () {
  const rateLimited = error instanceof RunnerRateLimitError
  yield* Console.log(json(failure(command, safeError(error), rateLimited ? error.code : "ORG_RUNNERS_FAILED",
    rateLimited ? "Retry later after the GitHub rate limit clears." : "Check the existing App installation and endpoint permissions. Do not add App permissions.")))
  process.exitCode = 1
})

export const runnerGroupCmd = Command.make("runner-group", {
  org: orgOption.pipe(Options.optional),
  name: Options.text("name").pipe(Options.optional),
  repo: Options.text("repo").pipe(Options.optional),
  dryRun: Options.boolean("dry-run"),
  workflows: groupWorkflows,
  allWorkflows,
  yes,
}, (input) => Effect.gen(function* () {
  const { org, name, repo } = input
  if (Option.isNone(org) || Option.isNone(name) || Option.isNone(repo)) return yield* failureEffect("runner-group", new RunnerApiError("use a subcommand, or provide --org, --name, and --repo for the legacy one-repository form"))
  if (input.dryRun && input.yes) return yield* failureEffect("runner-group", new RunnerApiError("--dry-run and --yes are mutually exclusive"))
  yield* validateOrg(org.value)
  yield* Effect.try({ try: () => runnerWorkflowPolicy(org.value, input.workflows, input.allWorkflows), catch: (error) => error })
  const octokit = yield* createOrgOctokit(org.value)
  const result = yield* apiEffect(() => ensureRunnerGroup(octokit, { ...input, org: org.value, name: name.value, repo: repo.value, dryRun: !input.yes }))
  yield* Console.log(json(success("runner-group", result, groupNext(org.value))))
}).pipe(Effect.catchAll((error) => failureEffect("runner-group", error)))).pipe(
  Command.withDescription("Read or preview changes to organization runner groups"),
  Command.withSubcommands([groupCreateCmd, groupGetCmd, groupUpdateCmd, groupAddRunnerCmd]),
)

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
