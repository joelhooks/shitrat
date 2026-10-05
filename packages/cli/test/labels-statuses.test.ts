import { describe, expect, test } from "bun:test"
import {
  labelIssue,
  planLabelChange,
  resolveCommitSha,
  setCommitStatus,
  type IssuesApi,
  type StatusesApi,
} from "../src/labels-statuses.js"

const ref = { owner: "o", repo: "r", number: 7 }
const FULL_SHA = "0123456789abcdef0123456789abcdef01234567"

const notFound = () => Object.assign(new Error("Not Found"), { status: 404 })

const issuesApi = (initial: string[], repoLabels: string[] = ["NO MERGE", "ready", "bug"]) => {
  let labels = [...initial]
  const writes: { method: string; input: unknown }[] = []
  const api = {
    get: async () => ({
      data: { number: 7, html_url: "https://github.com/o/r/pull/7", state: "open", pull_request: {}, labels: labels.map((name) => ({ name })) },
    }),
    getLabel: async ({ name }: { name: string }) => {
      if (!repoLabels.some((label) => label.toLowerCase() === name.toLowerCase())) throw notFound()
      return { data: { name } }
    },
    addLabels: async (input: { labels: string[] }) => {
      writes.push({ method: "addLabels", input })
      labels = [...labels, ...input.labels]
      return { data: labels.map((name) => ({ name })) }
    },
    removeLabel: async (input: { name: string }) => {
      writes.push({ method: "removeLabel", input })
      if (!labels.includes(input.name)) throw notFound()
      labels = labels.filter((name) => name !== input.name)
      return { data: labels.map((name) => ({ name })) }
    },
  }
  return { api: api as unknown as IssuesApi, writes }
}

describe("label", () => {
  test("adds and removes in one call and reports the labels it read back", async () => {
    const gh = issuesApi(["ready"])
    const result = await labelIssue(gh.api, ref, ["NO MERGE"], ["ready"], false)
    expect(gh.writes.map((write) => write.method)).toEqual(["addLabels", "removeLabel"])
    expect(result).toMatchObject({ kind: "pull_request", labels_before: ["ready"], labels: ["NO MERGE"], changed: true })
  })

  test("removing a label that is not there is a no-op success", async () => {
    const gh = issuesApi(["bug"])
    const result = await labelIssue(gh.api, ref, [], ["NO MERGE"], false)
    expect(gh.writes).toEqual([])
    expect(result).toMatchObject({ remove: [], not_present: ["NO MERGE"], changed: false, labels: ["bug"] })
  })

  test("a remove that loses a race to another writer still succeeds", async () => {
    const gh = issuesApi(["NO MERGE"])
    const api = { ...gh.api, removeLabel: async () => { throw notFound() } } as unknown as IssuesApi
    expect(await labelIssue(api, ref, [], ["NO MERGE"], false)).toMatchObject({ changed: true })
  })

  test("a dry run reads and plans but writes nothing", async () => {
    const gh = issuesApi(["ready"])
    const result = await labelIssue(gh.api, ref, ["NO MERGE"], ["ready"], true)
    expect(gh.writes).toEqual([])
    expect(result).toMatchObject({ add: ["NO MERGE"], remove: ["ready"], labels: ["ready"], changed: false })
  })

  test("refuses a label the repository lacks, so a typo cannot mint one", async () => {
    const gh = issuesApi([])
    await expect(labelIssue(gh.api, ref, ["NO MERGEE"], [], false)).rejects.toThrow(/No label named "NO MERGEE"/)
    expect(gh.writes).toEqual([])
  })

  test("matches labels case-insensitively and skips ones already present", () => {
    expect(planLabelChange(["No Merge"], ["no merge", "bug"], ["READY"])).toEqual({
      add: ["bug"],
      remove: [],
      already_present: ["no merge"],
      not_present: ["READY"],
    })
    expect(planLabelChange(["No Merge"], [], ["no merge"]).remove).toEqual(["No Merge"])
  })

  test.each([
    ["no labels", [], [], /at least one --add or --remove/],
    ["the same label both ways", ["NO MERGE"], ["no merge"], /both add and remove/],
  ])("refuses %s", (_name, add, remove, message) => {
    expect(() => planLabelChange([], add, remove)).toThrow(message)
  })
})

const statusesApi = (resolve: (ref: string) => string | Error, existing: { context: string; state: string }[] = []) => {
  const writes: unknown[] = []
  const api = {
    getCommit: async ({ ref }: { ref: string }) => {
      const sha = resolve(ref)
      if (sha instanceof Error) throw sha
      return { data: { sha } }
    },
    getCombinedStatusForRef: async () => ({
      data: { statuses: existing.map((status) => ({ ...status, description: "old", updated_at: "2026-10-05T00:00:00Z" })) },
    }),
    createCommitStatus: async (input: unknown) => {
      writes.push(input)
      return { data: { id: 42, created_at: "2026-10-05T19:30:00Z" } }
    },
  }
  return { api: api as unknown as StatusesApi, writes }
}

const input = { sha: FULL_SHA, state: "failure" as const, context: "gavel/hold", description: "Held by review" }

describe("set-status", () => {
  test("creates the status on the full sha", async () => {
    const gh = statusesApi(() => FULL_SHA)
    const result = await setCommitStatus(gh.api, ref, { ...input, targetUrl: "https://example.com/hold" }, false)
    expect(gh.writes).toEqual([
      { owner: "o", repo: "r", sha: FULL_SHA, state: "failure", context: "gavel/hold", description: "Held by review", target_url: "https://example.com/hold" },
    ])
    expect(result).toMatchObject({ sha: FULL_SHA, changed: true, status_id: 42, current: null })
  })

  test("resolves a short sha to the full sha before writing", async () => {
    const gh = statusesApi(() => FULL_SHA)
    const result = await setCommitStatus(gh.api, ref, { ...input, sha: "0123456" }, false)
    expect(result).toMatchObject({ sha: FULL_SHA, sha_input: "0123456" })
    expect(gh.writes).toEqual([expect.objectContaining({ sha: FULL_SHA })])
  })

  test("a dry run resolves the sha and reports the current status for the context without writing", async () => {
    const gh = statusesApi(() => FULL_SHA, [{ context: "gavel/hold", state: "success" }])
    const result = await setCommitStatus(gh.api, ref, input, true)
    expect(gh.writes).toEqual([])
    expect(result).toMatchObject({ changed: false, current: { state: "success", description: "old" } })
  })

  test.each([
    ["a non-hex sha", { sha: "main" }, /not a commit sha/],
    ["a sha shorter than 7", { sha: "01234" }, /not a commit sha/],
    ["an empty context", { context: " " }, /--context must not be empty/],
    ["a description over 140 characters", { description: "x".repeat(141) }, /GitHub allows 140/],
    ["a non-http target url", { targetUrl: "javascript:alert(1)" }, /http\(s\) URL/],
  ])("refuses %s without writing", async (_name, override, message) => {
    const gh = statusesApi(() => FULL_SHA)
    await expect(setCommitStatus(gh.api, ref, { ...input, ...override }, false)).rejects.toThrow(message)
    expect(gh.writes).toEqual([])
  })

  test("refuses a short sha GitHub cannot resolve to one commit", async () => {
    const ambiguous = statusesApi(() => Object.assign(new Error("No commit found for SHA"), { status: 422 }))
    await expect(resolveCommitSha(ambiguous.api, ref, "0123456")).rejects.toThrow(/does not resolve to exactly one commit/)
  })

  test("refuses hex that names a branch rather than the commit", async () => {
    const branch = statusesApi(() => "fedcba9876543210fedcba9876543210fedcba98")
    await expect(resolveCommitSha(branch.api, ref, "abcdef1")).rejects.toThrow(/branch or tag/)
  })
})
