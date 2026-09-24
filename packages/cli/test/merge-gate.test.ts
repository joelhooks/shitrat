import { describe, expect, test } from "bun:test"
import { MergePrGateError, mergePullRequest, updatePullRequestBranch } from "../src/commands/github.js"
import { parseRepo, type GitHubOctokit } from "../src/github-app.js"

const repo = parseRepo("joelhooks/shitrat")
const headSha = "head-sha"
const calls = () => ({ merge: 0, updateBranch: [] as Record<string, unknown>[] })

type CheckRun = { name: string; status: string; conclusion: string | null }
type CommitStatus = { context: string; state: string }

const fakeOctokit = (options: {
  behindBy?: number
  mergeable?: boolean | null
  checks?: CheckRun[]
  statuses?: CommitStatus[]
  updateError?: Error
  calls: ReturnType<typeof calls>
}) => {
  const listChecks = async () => ({ data: [] })
  const listStatuses = async () => ({ data: [] })
  const checkRuns = options.checks ?? [{ name: "CI", status: "completed", conclusion: "success" }]
  const statuses = options.statuses ?? []
  return {
    rest: {
      pulls: {
        get: async () => ({
          data: {
            head: { sha: headSha, ref: "feature" },
            base: { ref: "main" },
            mergeable: options.mergeable ?? true,
          },
        }),
        merge: async () => {
          options.calls.merge += 1
          return { data: { merged: true, message: "Merged", sha: "merge-sha" } }
        },
        updateBranch: async (input: Record<string, unknown>) => {
          options.calls.updateBranch.push(input)
          if (options.updateError) throw options.updateError
          return { data: { message: "Branch update started" } }
        },
      },
      repos: {
        compareCommitsWithBasehead: async () => ({ data: { behind_by: options.behindBy ?? 0 } }),
        listCommitStatusesForRef: listStatuses,
      },
      checks: { listForRef: listChecks },
    },
    paginate: async (endpoint: unknown) => (endpoint === listChecks ? checkRuns : statuses),
  } as unknown as GitHubOctokit
}

const gateFailureCode = async (promise: Promise<unknown>) => {
  try {
    await promise
    throw new Error("expected gate refusal")
  } catch (error) {
    if (error instanceof MergePrGateError) return error.code
    throw error
  }
}

describe("merge-pr gate", () => {
  test("refuses a pull request behind the base before merging", async () => {
    const track = calls()
    const client = fakeOctokit({ behindBy: 2, calls: track })

    expect(await gateFailureCode(mergePullRequest(client, repo, 17, { method: "squash" }))).toBe("PR_BEHIND_BASE")
    expect(track.merge).toBe(0)
  })

  test("refuses red and pending checks before merging", async () => {
    for (const check of [
      { name: "lint", status: "completed", conclusion: "failure" },
      { name: "tests", status: "in_progress", conclusion: null },
    ]) {
      const track = calls()
      const client = fakeOctokit({ checks: [check], calls: track })
      expect(await gateFailureCode(mergePullRequest(client, repo, 17, { method: "squash" }))).toBe("PR_CHECKS_NOT_GREEN")
      expect(track.merge).toBe(0)
    }
  })

  test("refuses a PR with no checks before merging", async () => {
    const track = calls()
    const client = fakeOctokit({ checks: [], statuses: [], calls: track })

    expect(await gateFailureCode(mergePullRequest(client, repo, 17, { method: "squash" }))).toBe("PR_CHECKS_NOT_GREEN")
    expect(track.merge).toBe(0)
  })

  test("merges an up-to-date PR with green checks", async () => {
    const track = calls()
    const client = fakeOctokit({
      checks: [
        { name: "CI", status: "completed", conclusion: "success" },
        { name: "Docs", status: "completed", conclusion: "neutral" },
      ],
      statuses: [{ context: "required", state: "success" }],
      calls: track,
    })

    const result = await mergePullRequest(client, repo, 17, { method: "squash" })
    expect(track.merge).toBe(1)
    expect(result.gate).toEqual({ behind_by: 0, head_sha: headSha, checks: 3 })
  })

  test("requires a reason to skip the gate and reports the authorized bypass", async () => {
    const track = calls()
    const client = fakeOctokit({ behindBy: 1, calls: track })

    await expect(mergePullRequest(client, repo, 17, { method: "squash", skipGate: true })).rejects.toThrow()
    expect(track.merge).toBe(0)
    const result = await mergePullRequest(client, repo, 17, {
      method: "squash",
      skipGate: true,
      reason: "Operator-approved emergency",
    })
    expect(track.merge).toBe(1)
    expect(result.gateSkippedReason).toBe("Operator-approved emergency")
  })
})

describe("update-branch", () => {
  test("uses the current PR head as the expected head", async () => {
    const track = calls()
    const client = fakeOctokit({ calls: track })

    await updatePullRequestBranch(client, repo, 17)
    expect(track.updateBranch).toHaveLength(1)
    expect(track.updateBranch[0]?.expected_head_sha).toBe(headSha)
  })

  test("surfaces GitHub's 422 update refusal", async () => {
    const track = calls()
    const error = Object.assign(new Error("Validation failed"), { status: 422 })
    const client = fakeOctokit({ updateError: error, calls: track })

    await expect(updatePullRequestBranch(client, repo, 17)).rejects.toMatchObject({ status: 422 })
    expect(track.updateBranch).toHaveLength(1)
  })
})
