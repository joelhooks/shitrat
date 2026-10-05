import { describe, expect, test } from "bun:test"
import {
  convertPullRequestToDraft,
  enqueuePullRequest,
  isMergeQueueRequired,
  readyPullRequest,
  type GraphqlClient,
  type PullRequestQueueState,
} from "../src/merge-queue.js"

const ref = { owner: "o", repo: "r", number: 7 }

const openPull = (overrides: Partial<PullRequestQueueState> = {}): PullRequestQueueState => ({
  id: "PR_7",
  number: 7,
  url: "https://github.com/o/r/pull/7",
  state: "OPEN",
  isDraft: false,
  headRefOid: "abc123",
  baseRefName: "main",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  isMergeQueueEnabled: true,
  isInMergeQueue: false,
  mergeQueueEntry: null,
  ...overrides,
})

const github = (pull: PullRequestQueueState, queueMethod: string | null = "SQUASH") => {
  const calls: { query: string; variables: Record<string, unknown> }[] = []
  const graphql: GraphqlClient = async <T>(query: string, variables: Record<string, unknown>) => {
    calls.push({ query, variables })
    if (query.includes("enqueuePullRequest")) {
      return { enqueuePullRequest: { mergeQueueEntry: { position: 3, state: "QUEUED" } } } as T
    }
    if (query.includes("convertPullRequestToDraft")) {
      return { convertPullRequestToDraft: { pullRequest: { isDraft: true, url: pull.url } } } as T
    }
    if (query.includes("markPullRequestReadyForReview")) {
      return { markPullRequestReadyForReview: { pullRequest: { isDraft: false, url: pull.url } } } as T
    }
    if (query.includes("mergeQueue(branch")) {
      return {
        repository: {
          mergeQueue: pull.isMergeQueueEnabled
            ? { url: "https://github.com/o/r/queue/main", configuration: { mergeMethod: queueMethod } }
            : null,
        },
      } as T
    }
    return { repository: { pullRequest: pull } } as T
  }
  const writes = () => calls.filter((call) => call.query.trimStart().startsWith("mutation"))
  return { calls, graphql, writes }
}

describe("enqueue-pr", () => {
  test("enqueues the head it read and reports the entry's position and state", async () => {
    const gh = github(openPull())
    const result = await enqueuePullRequest(gh.graphql, ref, "squash", false)
    expect(gh.writes()).toHaveLength(1)
    expect(gh.writes()[0]?.variables).toEqual({ id: "PR_7", head: "abc123" })
    expect(result).toMatchObject({ enqueued: true, position: 3, state: "QUEUED", queue_method: "squash" })
  })

  test("a dry run reads the pull request and the queue but writes nothing", async () => {
    const gh = github(openPull())
    const result = await enqueuePullRequest(gh.graphql, ref, undefined, true)
    expect(gh.writes()).toEqual([])
    expect(result).toMatchObject({ enqueued: false, already_queued: false, queue_method: "squash", merge_state: "CLEAN" })
  })

  test("an already queued pull request is reported where it stands, not enqueued again", async () => {
    const gh = github(openPull({ isInMergeQueue: true, mergeQueueEntry: { position: 1, state: "AWAITING_CHECKS" } }))
    const result = await enqueuePullRequest(gh.graphql, ref, undefined, false)
    expect(gh.writes()).toEqual([])
    expect(result).toMatchObject({ already_queued: true, enqueued: false, position: 1, state: "AWAITING_CHECKS" })
  })

  test.each([
    ["a draft", openPull({ isDraft: true }), undefined, /draft.*ready-pr/],
    ["a closed pull request", openPull({ state: "CLOSED" }), undefined, /closed, not open/],
    ["a base without a queue", openPull({ isMergeQueueEnabled: false }), undefined, /no merge queue.*merge-pr/],
    ["a conflicting pull request", openPull({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }), undefined, /not mergeable/],
    ["a method the queue does not use", openPull(), "merge" as const, /merges with squash, not merge/],
  ])("refuses %s without writing", async (_name, pull, method, message) => {
    const gh = github(pull)
    await expect(enqueuePullRequest(gh.graphql, ref, method, false)).rejects.toThrow(message)
    expect(gh.writes()).toEqual([])
  })
})

describe("ready-pr", () => {
  test("marks a draft ready by its node id", async () => {
    const gh = github(openPull({ isDraft: true }))
    const result = await readyPullRequest(gh.graphql, ref, false)
    expect(gh.writes().map((call) => call.variables)).toEqual([{ id: "PR_7" }])
    expect(result).toMatchObject({ was_draft: true, is_draft: false, changed: true })
  })

  test("leaves a ready pull request and a dry run unwritten", async () => {
    const ready = github(openPull())
    expect(await readyPullRequest(ready.graphql, ref, false)).toMatchObject({ was_draft: false, changed: false })
    const preview = github(openPull({ isDraft: true }))
    expect(await readyPullRequest(preview.graphql, ref, true)).toMatchObject({ was_draft: true, changed: false })
    expect([...ready.writes(), ...preview.writes()]).toEqual([])
  })
})

describe("convert-to-draft", () => {
  test("converts a ready pull request by its node id and reports that it was queued", async () => {
    const gh = github(openPull({ isInMergeQueue: true, mergeQueueEntry: { position: 2, state: "QUEUED" } }))
    const result = await convertPullRequestToDraft(gh.graphql, ref, false)
    expect(gh.writes()).toHaveLength(1)
    expect(gh.writes()[0]?.query).toContain("convertPullRequestToDraft")
    expect(gh.writes()[0]?.variables).toEqual({ id: "PR_7" })
    expect(result).toMatchObject({ was_draft: false, is_draft: true, changed: true, was_queued: true })
  })

  test("leaves a draft and a dry run unwritten", async () => {
    const draft = github(openPull({ isDraft: true }))
    expect(await convertPullRequestToDraft(draft.graphql, ref, false)).toMatchObject({ was_draft: true, changed: false })
    const preview = github(openPull())
    expect(await convertPullRequestToDraft(preview.graphql, ref, true)).toMatchObject({ was_draft: false, is_draft: false, changed: false })
    expect([...draft.writes(), ...preview.writes()]).toEqual([])
  })

  test("refuses a closed pull request without writing", async () => {
    const gh = github(openPull({ state: "MERGED" }))
    await expect(convertPullRequestToDraft(gh.graphql, ref, false)).rejects.toThrow(/merged, not open/)
    expect(gh.writes()).toEqual([])
  })
})

describe("merge-pr on a queue-required branch", () => {
  const refusal = (status: number, message: string) => Object.assign(new Error(message), { status })

  test("recognises GitHub's merge-queue refusal and nothing else", () => {
    expect(isMergeQueueRequired(refusal(405, "Changes must be made through the merge queue"))).toBe(true)
    expect(isMergeQueueRequired(refusal(405, "Pull Request is not mergeable"))).toBe(false)
    expect(isMergeQueueRequired(refusal(422, "merge queue is busy"))).toBe(false)
    expect(isMergeQueueRequired(new Error("Changes must be made through the merge queue"))).toBe(false)
  })
})
