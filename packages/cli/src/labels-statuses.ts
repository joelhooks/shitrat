import type { GitHubOctokit } from "./github-app.js"

export type IssuesApi = Pick<GitHubOctokit["rest"]["issues"], "get" | "getLabel" | "addLabels" | "removeLabel">
export type StatusesApi = Pick<GitHubOctokit["rest"]["repos"], "getCommit" | "getCombinedStatusForRef" | "createCommitStatus">

export type CommitState = "pending" | "success" | "failure" | "error"

interface RepoRef {
  owner: string
  repo: string
}

const statusOf = (error: unknown): unknown =>
  typeof error === "object" && error !== null && "status" in error ? error.status : undefined

const labelName = (label: string | { name?: string | null }): string =>
  typeof label === "string" ? label : (label.name ?? "")

const sameLabel = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase()

const uniqueLabels = (labels: readonly string[]): string[] =>
  labels
    .map((label) => label.trim())
    .filter((label, index, all) => label.length > 0 && all.findIndex((other) => sameLabel(other, label)) === index)

export const planLabelChange = (current: readonly string[], add: readonly string[], remove: readonly string[]) => {
  const adds = uniqueLabels(add)
  const removes = uniqueLabels(remove)
  if (adds.length === 0 && removes.length === 0) throw new Error("Provide at least one --add or --remove label.")
  const both = adds.filter((label) => removes.some((other) => sameLabel(other, label)))
  if (both.length > 0) throw new Error(`Cannot both add and remove: ${both.join(", ")}.`)
  return {
    add: adds.filter((label) => !current.some((name) => sameLabel(name, label))),
    // GitHub matches label names case-insensitively; remove by the name the issue carries.
    remove: current.filter((name) => removes.some((label) => sameLabel(label, name))),
    already_present: adds.filter((label) => current.some((name) => sameLabel(name, label))),
    not_present: removes.filter((label) => !current.some((name) => sameLabel(name, label))),
  }
}

export const labelIssue = async (
  issues: IssuesApi,
  ref: RepoRef & { number: number },
  add: readonly string[],
  remove: readonly string[],
  dryRun: boolean,
) => {
  const issue = await issues.get({ owner: ref.owner, repo: ref.repo, issue_number: ref.number })
  const current = issue.data.labels.map(labelName).filter((name) => name.length > 0)
  const plan = planLabelChange(current, add, remove)
  // addLabels creates a label the repo lacks, so a typo would mint a new label instead of setting the real one.
  const unknown: string[] = []
  for (const label of plan.add) {
    try {
      await issues.getLabel({ owner: ref.owner, repo: ref.repo, name: label })
    } catch (error) {
      if (statusOf(error) !== 404) throw error
      unknown.push(label)
    }
  }
  if (unknown.length > 0) {
    throw new Error(`No label named ${unknown.map((label) => `"${label}"`).join(", ")} exists in ${ref.owner}/${ref.repo}. Check the spelling; nothing was written.`)
  }
  const base = {
    number: issue.data.number,
    url: issue.data.html_url,
    kind: issue.data.pull_request ? "pull_request" : "issue",
    state: issue.data.state,
    labels_before: current,
    add: plan.add,
    remove: plan.remove,
    already_present: plan.already_present,
    not_present: plan.not_present,
  }
  if (dryRun || (plan.add.length === 0 && plan.remove.length === 0)) {
    return { ...base, labels: current, changed: false }
  }
  if (plan.add.length > 0) {
    await issues.addLabels({ owner: ref.owner, repo: ref.repo, issue_number: ref.number, labels: plan.add })
  }
  for (const label of plan.remove) {
    try {
      await issues.removeLabel({ owner: ref.owner, repo: ref.repo, issue_number: ref.number, name: label })
    } catch (error) {
      // Someone removed it between the read and this write: the label is gone, which is what was asked.
      if (statusOf(error) !== 404) throw error
    }
  }
  const after = await issues.get({ owner: ref.owner, repo: ref.repo, issue_number: ref.number })
  return { ...base, labels: after.data.labels.map(labelName).filter((name) => name.length > 0), changed: true }
}

const SHA_PATTERN = /^[0-9a-f]{7,40}$/i

export const resolveCommitSha = async (repos: Pick<StatusesApi, "getCommit">, ref: RepoRef, sha: string): Promise<string> => {
  const input = sha.trim().toLowerCase()
  if (!SHA_PATTERN.test(input)) throw new Error(`"${sha}" is not a commit sha: pass 7 to 40 hex characters.`)
  let resolved: string
  try {
    resolved = (await repos.getCommit({ owner: ref.owner, repo: ref.repo, ref: input, per_page: 1 })).data.sha
  } catch (error) {
    const status = statusOf(error)
    if (status === 404 || status === 422) {
      throw new Error(`${sha} does not resolve to exactly one commit in ${ref.owner}/${ref.repo}. Pass the full 40-character sha.`)
    }
    throw error
  }
  // A branch or tag named like hex resolves too; only accept the commit the sha names.
  if (!resolved.toLowerCase().startsWith(input)) {
    throw new Error(`${sha} resolved to a branch or tag pointing at ${resolved}, not a commit sha. Pass the full 40-character sha.`)
  }
  return resolved
}

export interface CommitStatusInput {
  sha: string
  state: CommitState
  context: string
  description: string
  targetUrl?: string | undefined
}

export const validateCommitStatus = (input: CommitStatusInput) => {
  const context = input.context.trim()
  const description = input.description.trim()
  if (context.length === 0) throw new Error("--context must not be empty.")
  if (description.length === 0) throw new Error("--description must not be empty.")
  if (description.length > 140) throw new Error(`--description is ${description.length} characters; GitHub allows 140.`)
  if (input.targetUrl !== undefined && !/^https?:\/\//i.test(input.targetUrl)) {
    throw new Error("--target-url must be an http(s) URL.")
  }
  return { context, description }
}

export const setCommitStatus = async (repos: StatusesApi, ref: RepoRef, input: CommitStatusInput, dryRun: boolean) => {
  const { context, description } = validateCommitStatus(input)
  const sha = await resolveCommitSha(repos, ref, input.sha)
  const combined = await repos.getCombinedStatusForRef({ owner: ref.owner, repo: ref.repo, ref: sha, per_page: 100 })
  const existing = combined.data.statuses.find((status) => status.context === context)
  const base = {
    sha,
    sha_input: input.sha,
    context,
    state: input.state,
    description,
    ...(input.targetUrl !== undefined ? { target_url: input.targetUrl } : {}),
    current: existing ? { state: existing.state, description: existing.description, updated_at: existing.updated_at } : null,
  }
  if (dryRun) return { ...base, changed: false }
  const created = await repos.createCommitStatus({
    owner: ref.owner,
    repo: ref.repo,
    sha,
    state: input.state,
    context,
    description,
    ...(input.targetUrl !== undefined ? { target_url: input.targetUrl } : {}),
  })
  return { ...base, changed: true, status_id: created.data.id, created_at: created.data.created_at }
}
