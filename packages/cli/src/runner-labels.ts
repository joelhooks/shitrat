import type { GitHubOctokit } from "./github-app.js"
import { runnerApiCall, RunnerApiError } from "./org-runners.js"

const endpoint = "/orgs/{org}/actions/runners/{runner_id}/labels"
const readPermission = "organization_self_hosted_runners: read"

export const validateRunnerTarget = ({ org, id }: { org: string; id: number }) => {
  if (!/^[a-z\d][a-z\d-]*$/i.test(org)) throw new RunnerApiError("invalid --org")
  if (!Number.isSafeInteger(id) || id <= 0) throw new RunnerApiError("runner id must be a positive safe integer")
}

type Target = { org: string; id: number }
type Change = Target & { action: "add" | "remove" | "set"; labels: readonly string[]; yes?: boolean }

export const readRunnerLabels = async (octokit: GitHubOctokit, target: Target) => {
  validateRunnerTarget(target)
  const { org, id } = target
  const { data } = await runnerApiCall(`GET ${endpoint}`, () =>
    octokit.rest.actions.listLabelsForSelfHostedRunnerForOrg({ org, runner_id: id }), readPermission)
  if (!Array.isArray(data.labels) || data.labels.some((label) => typeof label?.name !== "string" || (label.type !== "custom" && label.type !== "read-only"))) {
    throw new RunnerApiError("invalid runner label response")
  }
  return data.labels
}

export const changeRunnerLabels = async (octokit: GitHubOctokit, input: Change) => {
  validateRunnerTarget(input)
  const { org, id, action } = input
  if (!input.labels.length || input.labels.some((label) => !label.trim() || label !== label.trim() || /[\x00-\x1f\x7f]/.test(label))) {
    throw new RunnerApiError("provide at least one nonblank label without surrounding whitespace or control characters")
  }
  // Dot segments can be normalized away by the HTTP client. Never let a label
  // name turn DELETE /labels/{name} into a request against the runner itself.
  if (input.labels.some((label) => label === "." || label === "..")) throw new RunnerApiError("dot-segment runner labels are not supported")
  const labels = [...new Map(input.labels.map((label) => [label.toLowerCase(), label])).values()]
  const before = await readRunnerLabels(octokit, input)
  const builtIn = new Set(before.filter(({ type }) => type === "read-only").map(({ name }) => name.toLowerCase()))
  if (labels.some((label) => builtIn.has(label.toLowerCase()))) throw new RunnerApiError("cannot change a read-only runner label")
  const url = `/orgs/${org}/actions/runners/${id}/labels`
  const requests = action === "remove"
    ? labels.map((label) => ({ method: "DELETE", endpoint: `${url}/${encodeURIComponent(label)}` }))
    : [{ method: action === "add" ? "POST" : "PUT", endpoint: url, body: { labels } }]
  const receipt = { org, id, action, before, requests }
  if (!input.yes) return { ...receipt, dry_run: true }

  const target = { org, runner_id: id }
  switch (action) {
    case "add":
      await runnerApiCall(`POST ${endpoint}`, () => octokit.rest.actions.addCustomLabelsToSelfHostedRunnerForOrg({ ...target, labels }))
      break
    case "remove":
      for (const label of labels) {
        await runnerApiCall(`DELETE ${endpoint}/{name}`, () => octokit.rest.actions.removeCustomLabelFromSelfHostedRunnerForOrg({ ...target, name: label }))
      }
      break
    case "set":
      await runnerApiCall(`PUT ${endpoint}`, () => octokit.rest.actions.setCustomLabelsForSelfHostedRunnerForOrg({ ...target, labels }))
      break
  }
  const after = await readRunnerLabels(octokit, input)
  const custom = new Set(after.filter(({ type }) => type === "custom").map(({ name }) => name.toLowerCase()))
  const matches = action === "remove"
    ? labels.every((label) => !custom.has(label.toLowerCase()))
    : labels.every((label) => custom.has(label.toLowerCase())) && (action !== "set" || custom.size === labels.length)
  if (!matches) throw new RunnerApiError("runner label readback mismatch; inspect current labels before retrying")
  return { ...receipt, dry_run: false, after }
}
