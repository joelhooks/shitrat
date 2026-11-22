import { Args, Command, Options } from "@effect/cli"
import { Console, Effect, Option } from "effect"
import { changeVariable, listVariables, variableScope, variableName, type VariableChange } from "../actions-variables.js"
import { createOrgOctokit, RunnerApiError, RunnerRateLimitError } from "../org-runners.js"
import { failure, json, success } from "../response.js"

const scopeOptions = {
  org: Options.text("org").pipe(Options.optional, Options.withDescription("Organization scope instead of a positional owner/repo")),
  args: Args.text({ name: "argument" }).pipe(Args.repeated),
}
const attempt = <T>(request: () => Promise<T>) => Effect.tryPromise({ try: request, catch: (error) => error })

const handle = (action: "list" | "set" | "delete", org: Option.Option<string>, args: readonly string[], yes = false) => {
  const command = `variables ${action}`
  return Effect.gen(function* () {
    const { scope, change } = yield* Effect.try({ try: () => {
      const orgName = Option.getOrUndefined(org)
      const fields = orgName === undefined ? args.slice(1) : args
      if (fields.length !== ({ list: 0, set: 2, delete: 1 })[action]) {
        throw new RunnerApiError(`usage: variables ${action} <owner/repo>${action === "list" ? "" : action === "delete" ? " <NAME>" : " <NAME> <VALUE>"}; replace <owner/repo> with --org <org> for org scope`)
      }
      const scope = variableScope(orgName, orgName === undefined ? args[0] : undefined)
      const name = fields[0] === undefined ? undefined : variableName(fields[0])
      let change: VariableChange | undefined
      if (action === "set" && name !== undefined && fields[1] !== undefined) change = { action, name, value: fields[1] }
      if (action === "delete" && name !== undefined) change = { action, name }
      return { scope, change }
    }, catch: (error) => error })
    const octokit = yield* createOrgOctokit(scope.owner, scope.repo)
    const result = change === undefined
      ? { scope, variables: yield* attempt(() => listVariables(octokit, scope)) }
      : yield* attempt(() => changeVariable(octokit, { scope, change, yes }))
    const scopeArg = scope.repo === undefined ? `--org ${scope.owner}` : `${scope.owner}/${scope.repo}`
    yield* Console.log(json(success(command, result, change === undefined ? [] : [{
      command: `variables list ${scopeArg}`,
      description: "Read the current Actions variables",
    }])))
  }).pipe(Effect.catchAll((error) => Effect.gen(function* () {
    const rateLimited = error instanceof RunnerRateLimitError
    yield* Console.log(json(failure(command, error instanceof RunnerApiError ? error.message : "Actions variables request failed; check scope and App installation access.",
      rateLimited ? "VARIABLES_RATE_LIMITED" : "VARIABLES_FAILED",
      rateLimited ? "Retry after the GitHub rate limit clears." : "Check the scope and existing App permissions. Do not add permissions.")))
    process.exitCode = 1
  })))
}

const listCmd = Command.make("list", scopeOptions, ({ args, org }) => handle("list", org, args))
const yes = Options.boolean("yes").pipe(Options.withDescription("Send the request; without this switch only preview it"))
const setCmd = Command.make("set", { ...scopeOptions, yes }, ({ args, org, yes }) => handle("set", org, args, yes))
const deleteCmd = Command.make("delete", { ...scopeOptions, yes }, ({ args, org, yes }) => handle("delete", org, args, yes))

export const variablesCmd = Command.make("variables").pipe(
  Command.withDescription("Read or preview changes to GitHub Actions variables for a repository or organization"),
  Command.withSubcommands([listCmd, setCmd, deleteCmd]),
)
