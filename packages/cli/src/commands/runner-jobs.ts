import { Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { createOrgOctokit, RunnerApiError } from "../org-runners.js"
import { listRunnerJobs, runnerJobStatuses, validateRunnerJobsInput } from "../runner-jobs.js"
import { failure, json, success } from "../response.js"

export const runnerJobsCmd = Command.make("runner-jobs", {
  org: Options.text("org"),
  repos: Options.text("repo").pipe(Options.repeated),
  statuses: Options.choice("status", runnerJobStatuses).pipe(Options.repeated),
  maxRuns: Options.integer("max-runs").pipe(Options.withDefault(50)),
}, (input) => Effect.gen(function* () {
  yield* Effect.try({ try: () => validateRunnerJobsInput(input), catch: (error) => error })
  const octokit = yield* createOrgOctokit(input.org)
  const result = yield* Effect.tryPromise({ try: () => listRunnerJobs(octokit, input), catch: (error) => error })
  yield* Console.log(json(success("runner-jobs", result)))
}).pipe(Effect.catchAll((error) => Effect.gen(function* () {
  yield* Console.log(json(failure("runner-jobs",
    error instanceof RunnerApiError ? error.message : "Actions job request failed; check App installation access.",
    "RUNNER_JOBS_FAILED", "Check the existing App installation and Actions read access. Do not add App permissions.")))
  process.exitCode = 1
})))).pipe(Command.withDescription("Read queued and in-progress Actions jobs across an organization's accessible repositories"))
