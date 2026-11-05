import { Effect } from "effect"
import { createRepoOctokit, listInstallations } from "../../src/github-app.js"
import { createOrgOctokit } from "../../src/org-runners.js"
import { runCellGit } from "../../src/git-push.js"
import { cellFetch, GitHubCellError, withCellCommand } from "../../src/github-cell.js"

try {
  await withCellCommand(async () => {
    if (process.argv[2] === "nonce-refusal" || process.argv[2] === "nonce-echo") {
      const request = () => cellFetch("https://api.github.com/repos/example/project", {
        headers: { authorization: "Bearer {{secret:shitrat-github/example}}", "x-sc-forward-token": "caller-must-not-control-the-nonce" },
      })
      if (process.argv[2] === "nonce-echo") {
        const response = await request()
        process.stdout.write(JSON.stringify({ headers: Object.fromEntries(response.headers), body: await response.text() }))
      } else {
        const errors = []
        for (let attempt = 0; attempt < 2; attempt++) {
          try { await request() } catch (error) {
            if (!(error instanceof GitHubCellError)) throw error
            errors.push({ reason: error.reason, message: error.message })
          }
        }
        process.stdout.write(JSON.stringify({ errors }))
      }
    } else if (process.argv[2] === "invalid-urls") {
      const errors = []
      for (const input of ["", "/relative", "https://unapproved.example.invalid/", "http://api.github.com/repos/example/project"]) {
        try { await cellFetch(input) } catch (error) {
          if (!(error instanceof GitHubCellError)) throw error
          errors.push({ reason: error.reason, message: error.message })
        }
      }
      process.stdout.write(JSON.stringify({ errors }))
    } else if (process.argv[2] === "git") {
      await cellFetch("https://api.github.com/repos/example/project", {
        headers: { authorization: "Bearer {{secret:shitrat-github/example}}" },
      })
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
      const request = () => octokit.request(process.argv[2] === "response-url" ? "GET /repos/example/project?per_page=2&page=3" : "GET /repos/example/project")
      const result = process.argv[2] === "parallel" ? (await Promise.all([request(), request()]))[0]! : await request()
      if (process.argv[2] === "twice" || process.argv[2] === "throw-after-request") await request()
      if (process.argv[2] === "throw-after-request") throw new Error("fixture failure after requests")
      process.stdout.write(JSON.stringify({ data: result.data, ...(process.argv[2] === "response-url" ? { url: result.url } : {}) }))
    }
  })
} catch {
  process.stdout.write(JSON.stringify({ failed: true }))
  process.exitCode = 1
}
