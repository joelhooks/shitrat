import { Effect } from 'effect'
import { createRepoOctokit, parseRepo } from './src/github-app.ts'
const program = Effect.gen(function* () {
  const { octokit } = yield* createRepoOctokit(parseRepo('badass-courses/course-builder'))
  const issue = yield* Effect.tryPromise(() => octokit.issues.get({owner:'badass-courses',repo:'course-builder',issue_number:948}))
  yield* Effect.tryPromise(() => octokit.issues.update({owner:'badass-courses',repo:'course-builder',issue_number:948,assignees:['joelhooks']}))
  console.log(JSON.stringify({title: issue.data.title, state: issue.data.state, body: issue.data.body, html_url: issue.data.html_url, assignees:['joelhooks']}, null, 2))
})
Effect.runPromise(program)
