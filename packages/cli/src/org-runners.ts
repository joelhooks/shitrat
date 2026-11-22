import { Octokit } from "@octokit/rest"
import { Effect } from "effect"
import { createInstallationToken, createTokenOctokit, parseRepo, type GitHubOctokit } from "./github-app.js"
import { isCellPlaceholder } from "./github-cell.js"
import { isGitHubRateLimit } from "./github-rate-limit.js"

// Never retain an Octokit error: it can contain authorization headers or response tokens.
export class RunnerApiError extends Error {
  constructor(readonly endpoint: string, readonly status?: number, readonly permission = "organization_self_hosted_runners: write", workflowRestriction = false) {
    super(workflowRestriction
      ? `${endpoint}: ${status ? `HTTP ${status}` : "request failed"}; workflow restriction not available for this group or plan`
      : status === 403 || (status === 404 && permission.startsWith("administration:"))
      ? `${endpoint}: HTTP ${status}; requires ${permission}. Stop; do not change app permissions.`
      : `${endpoint}: ${status ? `HTTP ${status}` : "request failed"}`)
  }
}

export class RunnerRateLimitError extends RunnerApiError {
  readonly code = "ORG_RUNNERS_RATE_LIMITED"
  constructor(endpoint: string, status: number | undefined) {
    super(endpoint, status)
    this.message = `${endpoint}: HTTP ${status}; rate limited; retry later.`
  }
}

export const runnerApiCall = async <T>(endpoint: string, request: () => Promise<T>, permission?: string): Promise<T> => {
  try {
    return await request()
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
      ? error.status : undefined
    if (isGitHubRateLimit(error)) throw new RunnerRateLimitError(endpoint, status)
    throw new RunnerApiError(endpoint, status, permission)
  }
}

export const createOrgOctokit = (org: string, repo?: string) => createInstallationToken(org, repo).pipe(
  Effect.map(({ token }) => isCellPlaceholder(token) ? createTokenOctokit(token) : new Octokit({
    auth: token,
    // Octokit's default logger can print an HTTP error before our sanitizer sees it.
    log: { debug() {}, info() {}, warn() {}, error() {} },
  })),
)

export const registrationToken = async (octokit: GitHubOctokit, org: string) => {
  const { data } = await runnerApiCall("POST /orgs/{org}/actions/runners/registration-token", () =>
    octokit.rest.actions.createRegistrationTokenForOrg({ org }))
  // Require an ISO-shaped string that Date can parse to a future instant. GitHub
  // includes fractional seconds and UTC offsets, not just whole seconds with Z.
  const expiresAt = typeof data.expires_at === "string" ? Date.parse(data.expires_at) : NaN
  if (typeof data.token !== "string" || !/^[A-Za-z0-9_-]+$/.test(data.token) || typeof data.expires_at !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?(Z|[+-]\d\d:\d\d)$/.test(data.expires_at) || Number.isNaN(expiresAt) || expiresAt <= Date.now()) {
    throw new RunnerApiError("runner registration response validation")
  }
  return { token: data.token, expires_at: data.expires_at }
}

const groups = (octokit: GitHubOctokit, org: string) => runnerApiCall("GET /orgs/{org}/actions/runner-groups", () =>
  octokit.paginate("GET /orgs/{org}/actions/runner-groups", { org, per_page: 100 }), "organization_self_hosted_runners: read")

export const runnerWorkflowPolicy = (org: string, workflows: readonly string[] = [], allWorkflows = false) => {
  if (workflows.length && allWorkflows) throw new RunnerApiError("--workflow and --all-workflows are mutually exclusive")
  for (const workflow of workflows) {
    const match = /^([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/\.github\/workflows\/([^/@\s]+\.ya?ml)@refs\/(heads|tags)\/(.+)$/.exec(workflow)
    const ref = match?.[5]
    if (!match || match[1]!.toLowerCase() !== org.toLowerCase() || /[\s*?\[\\~^:\x00-\x1f\x7f]/.test(workflow) || !ref || ref.includes("..") || ref.includes("@{") || ref.includes("//") || ref.includes("@") || ref.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))) {
      throw new RunnerApiError("invalid --workflow: use owner/repo/.github/workflows/file.yml@refs/heads/branch or @refs/tags/tag in --org")
    }
  }
  return workflows.length
    ? { restricted_to_workflows: true, selected_workflows: [...new Set(workflows)] }
    : allWorkflows ? { restricted_to_workflows: false } : {}
}

const workflowWritable = (group: { workflow_restrictions_read_only?: boolean }, endpoint: string, enabled: boolean) => {
  if (enabled && group.workflow_restrictions_read_only === true) throw new RunnerApiError(endpoint, 200, undefined, true)
}

const groupPolicyCall = async <T>(endpoint: string, request: () => Promise<T>, workflowPolicy: boolean): Promise<T> => {
  try {
    return await runnerApiCall(endpoint, request)
  } catch (error) {
    if (workflowPolicy && error instanceof RunnerApiError && !(error instanceof RunnerRateLimitError) && (error.status === 403 || error.status === 422)) {
      throw new RunnerApiError(endpoint, error.status, undefined, true)
    }
    throw error
  }
}

const groupPath = "/orgs/{org}/actions/runner-groups/{runner_group_id}"
const groupRepoPath = "/orgs/{org}/actions/runner-groups/{runner_group_id}/repositories"
const groupRunnersPath = "/orgs/{org}/actions/runner-groups/{runner_group_id}/runners"
const groupsPath = "/orgs/{org}/actions/runner-groups"
const groupsRead = "organization_self_hosted_runners: read"

const getGroupPolicy = async (octokit: GitHubOctokit, org: string, group: string) => {
  const id = /^[1-9]\d*$/.test(group) ? Number(group) : undefined
  if (id !== undefined && !Number.isSafeInteger(id)) throw new RunnerApiError("runner group id must be a positive safe integer")
  const candidates = id !== undefined ? [] : (await groups(octokit, org)).filter(({ name }) => name === group)
  if (id === undefined && candidates.length !== 1) throw new RunnerApiError("runner group not found or ambiguous")
  const idToRead = id ?? candidates[0]?.id
  if (idToRead === undefined) throw new RunnerApiError("runner group not found")
  const { data } = await runnerApiCall(`GET ${groupPath}`, () => octokit.request(`GET ${groupPath}`, { org, runner_group_id: idToRead }), groupsRead)
  if (data.id !== idToRead) throw new RunnerApiError("runner group id readback mismatch")
  return data
}

const getGroupRepos = (octokit: GitHubOctokit, org: string, id: number) =>
  runnerApiCall(`GET ${groupRepoPath}`, () => octokit.paginate(`GET ${groupRepoPath}`, { org, runner_group_id: id, per_page: 100 }), groupsRead)

export const getRunnerGroup = async (octokit: GitHubOctokit, org: string, group: string) => {
  const policy = await getGroupPolicy(octokit, org, group)
  // The repositories subresource represents a selected allowlist, not an org-wide inventory.
  const repositories = policy.visibility === "selected" ? await getGroupRepos(octokit, org, policy.id) : policy.visibility
  return { ...policy, repositories }
}

export type RunnerGroupVisibility = "selected" | "private" | "all"
type GroupChange = {
  org: string; repo: readonly string[]; visibility?: RunnerGroupVisibility | undefined; allowPublic: boolean
  restrictedToWorkflows: boolean; allWorkflows: boolean; workflows: readonly string[]; yes?: boolean
} & ({ action: "create"; name: string } | { action: "update"; group: string })

export const groupWorkflowPolicy = (input: Pick<GroupChange, "org" | "workflows" | "restrictedToWorkflows" | "allWorkflows">) => {
  if (input.restrictedToWorkflows && input.workflows.length === 0) throw new RunnerApiError("--restricted-to-workflows requires at least one pinned --workflow")
  return runnerWorkflowPolicy(input.org, input.workflows, input.allWorkflows)
}

export const changeRunnerGroup = async (octokit: GitHubOctokit, input: GroupChange) => {
  const { org, action } = input
  const workflowPolicy = groupWorkflowPolicy(input)
  const changesWorkflows = workflowPolicy.restricted_to_workflows !== undefined
  const existing = action === "update" ? await getGroupPolicy(octokit, org, input.group) : null
  if (existing) workflowWritable(existing, `GET ${groupPath}`, changesWorkflows)
  const visibility = input.visibility ?? (input.repo.length ? "selected" : existing?.visibility ?? "selected")
  if (visibility !== "selected" && visibility !== "private" && visibility !== "all") throw new RunnerApiError("unknown runner group visibility")
  if (input.repo.length && visibility !== "selected") throw new RunnerApiError("--repo requires selected visibility")
  const repoIds = new Set<number>()
  for (const repo of input.repo) {
    const ref = parseRepo(repo)
    if (ref.owner.toLowerCase() !== org.toLowerCase()) throw new RunnerApiError("repository must belong to --org")
    const { data } = await runnerApiCall("GET /repos/{owner}/{repo}", () => octokit.rest.repos.get({ owner: ref.owner, repo: ref.repo }), "repository metadata: read")
    if (data.private !== true && !input.allowPublic) throw new RunnerApiError("public repository refused: pass --allow-public to include public repositories")
    if (!Number.isSafeInteger(data.id) || data.id <= 0) throw new RunnerApiError("invalid repository id in metadata response")
    repoIds.add(data.id)
  }
  const selected = visibility === "selected" && (!existing || input.visibility === "selected" || input.repo.length > 0)
    ? { selected_repository_ids: [...repoIds] } : undefined
  const name = input.action === "create" ? input.name : existing?.name
  if (!name?.trim()) throw new RunnerApiError("runner group name is required")
  const base = `/orgs/${encodeURIComponent(org)}/actions/runner-groups`
  const policy = { name, visibility, allows_public_repositories: input.allowPublic, ...workflowPolicy } as const
  const body = { ...policy, ...selected }
  const requests = existing
    ? [{ method: "PATCH", endpoint: `${base}/${existing.id}`, body: policy },
      ...(selected ? [{ method: "PUT", endpoint: `${base}/${existing.id}/repositories`, body: selected }] : [])]
    : [{ method: "POST", endpoint: base, body }]
  if (!input.yes) return { dry_run: true, action, before: existing, requests }

  const saved = existing
    ? (await groupPolicyCall(`PATCH ${groupPath}`, () => octokit.request(`PATCH ${groupPath}`, { org, runner_group_id: existing.id, ...policy }), changesWorkflows)).data
    : (await groupPolicyCall(`POST ${groupsPath}`, () => octokit.request(`POST ${groupsPath}`, { org, ...body }), changesWorkflows)).data
  const writeEndpoint = existing ? `PATCH ${groupPath}` : `POST ${groupsPath}`
  if (!Number.isSafeInteger(saved.id) || saved.id <= 0 || (existing && existing.id !== saved.id)) throw new RunnerApiError("runner group write returned an unexpected id")
  workflowWritable(saved, writeEndpoint, changesWorkflows)
  if (existing && selected) {
    await runnerApiCall(`PUT ${groupRepoPath}`, () => octokit.request(`PUT ${groupRepoPath}`, { org, runner_group_id: existing.id, ...selected }))
  }
  const after = await getRunnerGroup(octokit, org, String(saved.id))
  workflowWritable(after, `GET ${groupPath}`, changesWorkflows)
  const workflows = workflowPolicy.selected_workflows
  if (after.name !== name || after.visibility !== visibility || after.allows_public_repositories !== input.allowPublic ||
    (changesWorkflows && after.restricted_to_workflows !== workflowPolicy.restricted_to_workflows) ||
    (workflows && (after.selected_workflows?.length !== workflows.length || !workflows.every((workflow) => after.selected_workflows?.includes(workflow)))) ||
    (selected && (!Array.isArray(after.repositories) || after.repositories.length !== repoIds.size ||
      new Set(after.repositories.map(({ id }) => id)).size !== repoIds.size || after.repositories.some(({ id }) => !repoIds.has(id))))) {
    throw new RunnerApiError("runner group policy readback mismatch; inspect the group before retrying")
  }
  return { dry_run: false, action, before: existing, requests, after }
}

export const addRunnerToGroup = async (octokit: GitHubOctokit, { org, group, id, yes }: { org: string; group: string; id: number; yes?: boolean }) => {
  if (!Number.isSafeInteger(id) || id <= 0) throw new RunnerApiError("runner id must be a positive safe integer")
  const target = await getGroupPolicy(octokit, org, group)
  const runner = await runnerApiCall("GET /orgs/{org}/actions/runners/{runner_id}", () => octokit.rest.actions.getSelfHostedRunnerForOrg({ org, runner_id: id }), groupsRead)
  if (runner.data.id !== id) throw new RunnerApiError("runner id readback mismatch")
  const params = { org, runner_group_id: target.id }
  const request = { method: "PUT", endpoint: `/orgs/${encodeURIComponent(org)}/actions/runner-groups/${target.id}/runners/${id}` }
  const result = { org, id, group: { id: target.id, name: target.name }, request }
  if (!yes) return { ...result, dry_run: true }
  await runnerApiCall(`PUT ${groupRunnersPath}/{runner_id}`, () =>
    octokit.request(`PUT ${groupRunnersPath}/{runner_id}`, { ...params, runner_id: id }))
  const members = await runnerApiCall(`GET ${groupRunnersPath}`, () => octokit.paginate(`GET ${groupRunnersPath}`, { ...params, per_page: 100 }), groupsRead)
  if (!members.some((member) => member.id === id)) throw new RunnerApiError("runner group membership readback mismatch; inspect the runner before retrying")
  return { ...result, dry_run: false, readback: { group: result.group, runner_id: id } }
}

export const ensureRunnerGroup = async (octokit: GitHubOctokit, input: { org: string; name: string; repo: string; dryRun: boolean; workflows?: readonly string[]; allWorkflows?: boolean }) => {
  const { org, name, dryRun } = input
  const workflowPolicy = runnerWorkflowPolicy(org, input.workflows, input.allWorkflows)
  const changesWorkflows = workflowPolicy.restricted_to_workflows !== undefined
  const ref = parseRepo(input.repo)
  if (ref.owner.toLowerCase() !== org.toLowerCase()) throw new RunnerApiError("repository must belong to --org")
  const { data: repo } = await runnerApiCall("GET /repos/{owner}/{repo}", () => octokit.rest.repos.get({ owner: ref.owner, repo: ref.repo }), "repository metadata: read")
  if (repo.private === false) throw new RunnerApiError("public repository refused: allows_public_repositories is false")
  const found = (await groups(octokit, org)).filter((group) => group.name === name)
  if (found.length > 1) throw new RunnerApiError("ambiguous runner group name")
  const existing = found[0]
  if (existing) workflowWritable(existing, "GET /orgs/{org}/actions/runner-groups", changesWorkflows)
  const policy = { visibility: "selected" as const, allows_public_repositories: false, ...workflowPolicy }
  const desired = { ...policy, selected_repository_ids: [repo.id] }
  if (dryRun) return { dry_run: true, action: existing ? "update" : "create", id: existing?.id ?? null, name, ...desired, repositories: [{ id: repo.id, full_name: repo.full_name }] }

  const group = existing
    ? (await groupPolicyCall("PATCH /orgs/{org}/actions/runner-groups/{runner_group_id}", () =>
      octokit.request("PATCH /orgs/{org}/actions/runner-groups/{runner_group_id}", { org, runner_group_id: existing.id, name, ...policy }), changesWorkflows)).data
    : (await groupPolicyCall("POST /orgs/{org}/actions/runner-groups", () =>
      octokit.request("POST /orgs/{org}/actions/runner-groups", { org, name, ...desired }), changesWorkflows)).data
  workflowWritable(group, existing ? "PATCH /orgs/{org}/actions/runner-groups/{runner_group_id}" : "POST /orgs/{org}/actions/runner-groups", changesWorkflows)
  if (existing) await runnerApiCall("PUT /orgs/{org}/actions/runner-groups/{runner_group_id}/repositories", () =>
    octokit.request("PUT /orgs/{org}/actions/runner-groups/{runner_group_id}/repositories", { org, runner_group_id: group.id, selected_repository_ids: [repo.id] }))

  // Read back the effective policy rather than claiming the requested state was saved.
  const { data: saved } = await runnerApiCall("GET /orgs/{org}/actions/runner-groups/{runner_group_id}", () =>
    octokit.request("GET /orgs/{org}/actions/runner-groups/{runner_group_id}", { org, runner_group_id: group.id }), "organization_self_hosted_runners: read")
  const repositories = await runnerApiCall("GET /orgs/{org}/actions/runner-groups/{runner_group_id}/repositories", () =>
    octokit.paginate("GET /orgs/{org}/actions/runner-groups/{runner_group_id}/repositories", { org, runner_group_id: group.id, per_page: 100 }), "organization_self_hosted_runners: read")
  workflowWritable(saved, "GET /orgs/{org}/actions/runner-groups/{runner_group_id}", changesWorkflows)
  const requestedWorkflows = workflowPolicy.selected_workflows
  const workflowsMatch = requestedWorkflows === undefined || (
    Array.isArray(saved.selected_workflows) && saved.selected_workflows.length === requestedWorkflows.length &&
    requestedWorkflows.every((workflow) => saved.selected_workflows!.includes(workflow))
  )
  if (changesWorkflows && (saved.restricted_to_workflows !== workflowPolicy.restricted_to_workflows || !workflowsMatch)) {
    throw new RunnerApiError("runner group workflow policy readback mismatch")
  }
  if (saved.visibility !== "selected" || saved.allows_public_repositories !== false || repositories.length !== 1 || repositories[0]?.id !== repo.id) {
    throw new RunnerApiError("runner group policy readback mismatch")
  }
  return { dry_run: false, id: saved.id, name: saved.name, visibility: saved.visibility, allows_public_repositories: saved.allows_public_repositories, repositories: repositories.map(({ id, full_name }) => ({ id, full_name })), ...(changesWorkflows ? { restricted_to_workflows: saved.restricted_to_workflows, selected_workflows: saved.selected_workflows } : {}) }
}

export const listRunnerGroups = async (octokit: GitHubOctokit, org: string, name?: string) => {
  const allGroups = await groups(octokit, org)
  const selected = name === undefined ? allGroups : allGroups.filter((group) => group.name === name)
  if (name !== undefined && selected.length !== 1) throw new RunnerApiError("runner group not found or ambiguous")
  const result = []
  for (const group of selected) {
    const repositories = group.visibility === "selected"
      ? (await runnerApiCall("GET /orgs/{org}/actions/runner-groups/{runner_group_id}/repositories", () =>
        octokit.paginate("GET /orgs/{org}/actions/runner-groups/{runner_group_id}/repositories", { org, runner_group_id: group.id, per_page: 100 }), "organization_self_hosted_runners: read")).map(({ full_name }) => full_name)
      : group.visibility
    result.push({
      id: group.id, name: group.name, visibility: group.visibility, default: group.default,
      allows_public_repositories: group.allows_public_repositories,
      restricted_to_workflows: group.restricted_to_workflows, selected_workflows: group.selected_workflows,
      workflow_restrictions_read_only: group.workflow_restrictions_read_only,
      repositories,
    })
  }
  return result
}

// Repo runners use the owner's installation client, not organization runner permissions.
export const listRepoRunners = async (octokit: GitHubOctokit, repo: string) => {
  const ref = parseRepo(repo)
  const runners = await runnerApiCall("GET /repos/{owner}/{repo}/actions/runners", () =>
    octokit.paginate(octokit.rest.actions.listSelfHostedRunnersForRepo, { owner: ref.owner, repo: ref.repo, per_page: 100 }), "administration: read")
  return runners.map(({ id, name, os, status, busy, labels, ...rest }) => ({
    id, name, os, status, busy, labels: labels.map(({ name }) => name),
    ...("runner_group_id" in rest ? { runner_group_id: rest.runner_group_id } : {}),
  }))
}

// Lifecycle: read -> refuse unproven idle | verify absent | preview | delete -> verify absent.
// A runner GET 404 alone is ambiguous: GitHub also masks missing permissions as 404.
export const removeRepoRunner = async (octokit: GitHubOctokit, input: { repo: string; id: number; dryRun: boolean }) => {
  const { repo, id, dryRun } = input
  if (!Number.isSafeInteger(id) || id <= 0) throw new RunnerApiError("--id must be a positive safe integer")
  const ref = parseRepo(repo)
  const params = { owner: ref.owner, repo: ref.repo, runner_id: id }
  const endpoint = "/repos/{owner}/{repo}/actions/runners/{runner_id}"
  const read = async () => {
    try {
      return (await runnerApiCall(`GET ${endpoint}`, () => octokit.rest.actions.getSelfHostedRunnerForRepo(params), "administration: read")).data
    } catch (error) {
      if (!(error instanceof RunnerApiError) || error.status !== 404) throw error
      const runners = await listRepoRunners(octokit, repo)
      if (runners.some((runner) => runner.id === id)) throw new RunnerApiError("runner removal readback mismatch: GET returned 404 but runner is still listed")
      return null
    }
  }
  const runner = await read()
  const absentReadback = { single: 404, listed: false }
  if (runner === null) return { repo, id, name: null, status: null, removed: false, alreadyAbsent: true, readback: absentReadback }
  if (runner.status !== "offline" || runner.busy !== false) throw new RunnerApiError(`runner removal refused: status=${JSON.stringify(runner.status)}, busy=${JSON.stringify(runner.busy)}; requires status="offline" and busy=false; wait until offline and idle, then read again`)
  const result = { repo, id, name: runner.name, status: runner.status, removed: false, alreadyAbsent: false }
  if (dryRun) return { ...result, dry_run: true, request: { method: "DELETE", endpoint: `/repos/${ref.owner}/${ref.repo}/actions/runners/${id}` } }
  await runnerApiCall(`DELETE ${endpoint}`, () => octokit.rest.actions.deleteSelfHostedRunnerFromRepo(params), "administration: write")
  const saved = await read().catch((error: unknown) => {
    // A successful DELETE is not proof of removal if verification cannot complete.
    if (error instanceof RunnerRateLimitError) throw error
    if (error instanceof RunnerApiError) throw new RunnerApiError(`runner removal readback mismatch: ${error.endpoint}`, error.status, error.permission)
    throw new RunnerApiError("runner removal readback mismatch: request failed")
  })
  if (saved !== null) throw new RunnerApiError("runner removal readback mismatch: runner still exists")
  return { ...result, removed: true, readback: absentReadback }
}

export const listOrgRunners = async (octokit: GitHubOctokit, org: string, groupName?: string) => {
  const allGroups = await groups(octokit, org)
  const selected = groupName === undefined ? allGroups : allGroups.filter(({ name }) => name === groupName)
  if (groupName !== undefined && selected.length !== 1) throw new RunnerApiError("runner group not found or ambiguous")
  const membership = new Map<number, { id: number; name: string }>()
  for (const group of selected) {
    const runners = await runnerApiCall("GET /orgs/{org}/actions/runner-groups/{runner_group_id}/runners", () =>
      octokit.paginate("GET /orgs/{org}/actions/runner-groups/{runner_group_id}/runners", { org, runner_group_id: group.id, per_page: 100 }), "organization_self_hosted_runners: read")
    for (const runner of runners) membership.set(runner.id, { id: group.id, name: group.name })
  }
  const runners = await runnerApiCall("GET /orgs/{org}/actions/runners", () =>
    octokit.paginate(octokit.rest.actions.listSelfHostedRunnersForOrg, { org, per_page: 100 }), "organization_self_hosted_runners: read")
  return runners.filter(({ id }) => groupName === undefined || membership.has(id)).map(({ id, name, status, busy, labels }) => ({
    id, name, status, busy, labels: labels.map(({ name }) => name), group: membership.get(id) ?? null,
  }))
}
