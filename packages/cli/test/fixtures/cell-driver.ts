import { Effect } from "effect"
import { createRepoOctokit, listInstallations } from "../../src/github-app.js"
import { createOrgOctokit } from "../../src/org-runners.js"
import { runCellGit } from "../../src/git-push.js"

try {
  if (process.argv[2] === "git") {
    const result = await runCellGit({
      args: JSON.parse(process.env.CELL_TEST_GIT_ARGS!),
      cwd: process.env.CELL_TEST_GIT_CWD!,
      placeholder: "{{secret:shitrat-github/example}}",
    })
    process.stdout.write(JSON.stringify(result))
  } else if (process.argv[2] === "installations") {
    await Effect.runPromise(listInstallations)
  } else {
    const octokit = process.argv[2] === "org"
      ? await Effect.runPromise(createOrgOctokit("example"))
      : (await Effect.runPromise(createRepoOctokit({ owner: "example", repo: "project", fullName: "example/project" }))).octokit
    const result = await octokit.request("GET /repos/example/project")
    process.stdout.write(JSON.stringify({ data: result.data }))
  }
} catch {
  process.stdout.write(JSON.stringify({ failed: true }))
  process.exitCode = 1
}
