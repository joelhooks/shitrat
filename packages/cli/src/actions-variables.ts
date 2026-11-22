import { parseRepo, type GitHubOctokit } from "./github-app.js"
import { runnerApiCall, RunnerApiError } from "./org-runners.js"

export type VariableScope = { owner: string; repo?: never } | { owner: string; repo: string }
export type VariableChange = { action: "set"; name: string; value: string } | { action: "delete"; name: string }

export const variableScope = (org: string | undefined, repo: string | undefined): VariableScope => {
  if ((org === undefined) === (repo === undefined)) throw new RunnerApiError("provide exactly one of <owner/repo> or --org <org>")
  const ref = repo === undefined ? undefined : parseRepo(repo)
  const owner = ref?.owner ?? org ?? ""
  if (!/^[a-z\d][a-z\d-]*$/i.test(owner) || (ref && (!/^[a-z\d_.-]+$/i.test(ref.repo) || ref.repo === "." || ref.repo === ".."))) {
    throw new RunnerApiError("invalid Actions variables scope")
  }
  return ref ? { owner, repo: ref.repo } : { owner }
}

export const variableName = (input: string) => {
  if (!/^[a-z_][a-z\d_]*$/i.test(input) || /^github_/i.test(input)) throw new RunnerApiError("invalid Actions variable name")
  return input.toUpperCase()
}

const repoPath = "/repos/{owner}/{repo}/actions/variables"
const orgPath = "/orgs/{org}/actions/variables"
const permission = (scope: VariableScope, access: "read" | "write") =>
  `${scope.repo === undefined ? "organization_variables" : "actions_variables"}: ${access}`

export const listVariables = async (octokit: GitHubOctokit, scope: VariableScope) => {
  const { owner, repo } = scope
  const variables = repo === undefined
    ? await runnerApiCall(`GET ${orgPath}`, () => octokit.paginate(`GET ${orgPath}`, { org: owner, per_page: 100 }), permission(scope, "read"))
    : await runnerApiCall(`GET ${repoPath}`, () => octokit.paginate(`GET ${repoPath}`, { owner, repo, per_page: 100 }), permission(scope, "read"))
  return variables.map((variable) => {
    if (typeof variable?.name !== "string" || typeof variable.value !== "string" || typeof variable.updated_at !== "string") {
      throw new RunnerApiError("invalid Actions variable response")
    }
    return { name: variable.name, value: variable.value, updated_at: variable.updated_at }
  })
}

export const changeVariable = async (octokit: GitHubOctokit, { scope, change, yes }: { scope: VariableScope; change: VariableChange; yes?: boolean }) => {
  const name = variableName(change.name)
  // Use the list to establish absence; a per-variable 404 could hide a permission error.
  const read = async () => (await listVariables(octokit, scope)).find((item) => item.name.toUpperCase() === name) ?? null
  const before = await read()
  const { owner, repo } = scope
  const path = repo === undefined ? orgPath : repoPath
  const base = (repo === undefined ? `/orgs/${owner}` : `/repos/${owner}/${repo}`) + "/actions/variables"
  const method = change.action === "delete" ? "DELETE" : before ? "PATCH" : "POST"
  const createVisibility = "private"
  const body = change.action === "delete" ? undefined : before ? { value: change.value }
    : { name, value: change.value, ...(repo === undefined ? { visibility: createVisibility } : {}) }
  const receipt = { scope, name, before, request: change.action === "delete" && !before ? null : {
    method, endpoint: method === "POST" ? base : `${base}/${name}`, ...(body ? { body } : {}),
  } }
  if (!yes) return { ...receipt, dry_run: true }

  const writePermission = permission(scope, "write")
  const api = octokit.rest.actions
  if (change.action === "delete") {
    if (before) await runnerApiCall(`DELETE ${path}/{name}`, () => repo === undefined
      ? api.deleteOrgVariable({ org: owner, name }) : api.deleteRepoVariable({ owner, repo, name }), writePermission)
  } else if (before) {
    const value = change.value
    await runnerApiCall(`PATCH ${path}/{name}`, () => repo === undefined
      ? api.updateOrgVariable({ org: owner, name, value }) : api.updateRepoVariable({ owner, repo, name, value }), writePermission)
  } else {
    const value = change.value
    await runnerApiCall(`POST ${path}`, () => repo === undefined
      ? api.createOrgVariable({ org: owner, name, value, visibility: createVisibility }) : api.createRepoVariable({ owner, repo, name, value }), writePermission)
  }
  const after = await read()
  if (change.action === "delete" ? after !== null : after?.value !== change.value) {
    throw new RunnerApiError("Actions variable readback mismatch; inspect the current value before retrying")
  }
  return { ...receipt, dry_run: false, after }
}
