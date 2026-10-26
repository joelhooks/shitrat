import { Args, Command, Options } from "@effect/cli"
import { Console, Effect, Option } from "effect"
import { constants } from "node:fs"
import { lstat, mkdir, open, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import packageInfo from "../../package.json" with { type: "json" }
import { createRepoOctokit, parseRepo, type GitHubOctokit, type RepoRef } from "../github-app.js"
import { failure, json, success } from "../response.js"

class BranchDeleteError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}
type Outcome = "deleted" | "dryRun" | "alreadyAbsent" | "refused" | "failed"
type BranchResult = {
  repo: string; branch: string; sha: string | null; compare_status: string | null
  outcome: Outcome; timestamp: string; cli_version: string; delete_attempted: boolean
  error?: { code: string; message: string }
}
const fail = (code: string, message: string): never => { throw new BranchDeleteError(code, message) }
const statusOf = (error: unknown): number | undefined =>
  typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : undefined
const headersOf = (error: unknown): Record<string, string> => {
  if (typeof error !== "object" || error === null || !("response" in error)) return {}
  return (error as { response?: { headers?: Record<string, string> } }).response?.headers ?? {}
}

// Use the installation Octokit for every attempt; never retry ordinary failures or ambiguous writes.
const request = async <A>(endpoint: string, run: () => Promise<A>, absent = false): Promise<A | undefined> => {
  for (let attempt = 0; ; attempt++) {
    try { return await run() } catch (error) {
      const status = statusOf(error)
      const headers = headersOf(error)
      const limited = status === 429 || (status === 403 && (headers["retry-after"] !== undefined || headers["x-ratelimit-remaining"] === "0"))
      if (limited) {
        const retryAfter = headers["retry-after"]
        if (attempt > 0 || retryAfter === undefined) return fail("RateLimited", `${endpoint} failed (HTTP ${status}); rate limit repeated or no Retry-After supplied. Stop and retry later.`)
        const delay = /^\d+(\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()
        if (!Number.isFinite(delay)) fail("RateLimited", `${endpoint} failed (HTTP ${status}); invalid Retry-After. Stop and retry later.`)
        // Chunk long delays so Node's timer overflow cannot turn a cooldown into an immediate retry.
        let remaining = Math.max(0, delay)
        while (remaining > 0) {
          const chunk = Math.min(remaining, 2_147_483_647)
          await new Promise((resolve) => setTimeout(resolve, chunk))
          remaining -= chunk
        }
        continue
      }
      if (status === 404 && absent) return undefined
      fail("GitHubRequestFailed", `${endpoint} failed${status === undefined ? "" : ` (HTTP ${status})`}. Verify repository access and contents: write permission; inspect state before retrying.`)
    }
  }
}

const validBranch = (branch: string) => {
  if (!branch || branch.startsWith("refs/") || branch === "@" || /[\x00-\x20\x7f~^:?*\[\\]/.test(branch) ||
    branch.includes("..") || branch.includes("@{") || branch.endsWith(".") ||
    branch.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))) {
    fail("InvalidBranch", "Pass a valid branch name, not a refs/ prefixed ref.")
  }
}

const deleteOne = async (octokit: GitHubOctokit, repo: RepoRef, defaultBranch: string, result: BranchResult, yes: boolean) => {
  const branch = result.branch
  validBranch(branch)
  if (branch === defaultBranch) fail("DefaultBranch", "The default branch cannot be deleted.")
  const base = { owner: repo.owner, repo: repo.repo }
  const root = `/repos/${repo.owner}/${repo.repo}`
  const branchEndpoint = `GET ${root}/branches/${encodeURIComponent(branch)}`
  const metadata = await request(branchEndpoint, () => octokit.rest.repos.getBranch({ ...base, branch }), true)
  if (metadata && metadata.data.protected !== false) fail("ProtectedBranch", "Protected branches cannot be deleted (or protection could not be verified).")
  const ref = { ...base, ref: `heads/${branch}` }
  const refEndpoint = `GET ${root}/git/ref/heads/${encodeURIComponent(branch)}`
  const initial = await request(refEndpoint, () => octokit.rest.git.getRef(ref), true)
  if (!initial) { result.outcome = "alreadyAbsent"; return }
  result.sha = initial.data.object.sha
  // A missing branch GET with a present ref is not proof that protection is disabled.
  if (!metadata) fail("GitHubRequestFailed", `${branchEndpoint} failed (HTTP 404). Cannot verify protection; verify contents: write permission.`)
  if (initial.data.object.type !== "commit" || !/^[a-fA-F0-9]{40}$/.test(result.sha)) fail("InvalidRef", "Branch ref is not a full commit SHA.")
  const comparison = await request(`GET ${root}/compare/${encodeURIComponent(defaultBranch)}...${result.sha}`,
    () => octokit.rest.repos.compareCommits({ ...base, base: defaultBranch, head: result.sha! }))
  result.compare_status = comparison!.data.status
  if (result.compare_status !== "behind" && result.compare_status !== "identical") fail("NotMerged", "Branch tip is not reachable from the default branch; only behind or identical is accepted.")
  if (!yes) { result.outcome = "dryRun"; return }
  const current = await request(refEndpoint, () => octokit.rest.git.getRef(ref), true)
  if (!current || current.data.object.sha !== result.sha) fail("BranchMoved", "Branch disappeared or moved after preflight; nothing was deleted.")
  result.delete_attempted = true
  await request(`DELETE ${root}/git/refs/heads/${encodeURIComponent(branch)}`, () => octokit.rest.git.deleteRef(ref))
  try {
    const readback = await request(refEndpoint, () => octokit.rest.git.getRef(ref), true)
    if (readback) fail("ReadbackMismatch", "DELETE was sent but ref readback was not HTTP 404. Inspect state; no rollback was attempted.")
  } catch (error) {
    if (error instanceof BranchDeleteError && error.code === "RateLimited") throw error
    fail("ReadbackMismatch", error instanceof BranchDeleteError ? error.message : "Ref readback failed after DELETE. Inspect state; no rollback was attempted.")
  }
  result.outcome = "deleted"
}

const runBatch = async (octokit: GitHubOctokit, repo: RepoRef, branches: string[], yes: boolean, logPath: string, contents: string | undefined) => {
  // Open the audit sink before any DELETE. A broken audit sink stops writes, not just reporting.
  await mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 })
  const directory = await lstat(path.dirname(logPath))
  if (!directory.isDirectory() || (directory.mode & 0o777) !== 0o700) fail("AuditLogFailed", "Audit log directory must be a real directory with mode 0700. Choose a private directory; no shared directory permissions were changed.")
  const log = await open(logPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
  try {
    if (!(await log.stat()).isFile()) fail("AuditLogFailed", "Audit log must be a regular file.")
    await log.chmod(0o600)
    let defaultBranch = ""
    let stopped: BranchDeleteError | undefined
    try {
      if (contents !== "write" && (yes || contents !== "read")) fail("PermissionDenied", "Installation token lacks repository contents: write permission (previews require at least contents: read). Cannot distinguish an absent ref from concealed access denial.")
      const repository = await request(`GET /repos/${repo.owner}/${repo.repo}`, () => octokit.rest.repos.get({ owner: repo.owner, repo: repo.repo }))
      defaultBranch = repository!.data.default_branch
      if (!defaultBranch) fail("InvalidRepository", "Repository default branch could not be verified.")
    } catch (error) { stopped = error instanceof BranchDeleteError ? error : new BranchDeleteError("GitHubRequestFailed", "Could not read repository.") }
    const results: BranchResult[] = []
    for (const branch of branches) {
      const result: BranchResult = { repo: repo.fullName, branch, sha: null, compare_status: null, outcome: "failed", timestamp: new Date().toISOString(), cli_version: packageInfo.version, delete_attempted: false }
      try {
        if (stopped) throw stopped
        await deleteOne(octokit, repo, defaultBranch, result, yes)
      } catch (error) {
        const typed = error instanceof BranchDeleteError ? error : new BranchDeleteError("BranchDeleteFailed", "Branch operation failed. Inspect state before retrying.")
        result.error = { code: typed.code, message: typed.message }
        result.outcome = ["InvalidBranch", "DefaultBranch", "ProtectedBranch", "NotMerged", "BranchMoved"].includes(typed.code) ? "refused" : "failed"
        if (typed.code === "RateLimited") stopped = typed
      }
      await log.writeFile(`${JSON.stringify(result)}\n`)
      await log.sync()
      results.push(result)
    }
    const counts = { deleted: 0, dryRun: 0, alreadyAbsent: 0, refused: 0, failed: 0 }
    for (const result of results) counts[result.outcome]++
    return { results, counts }
  } finally { await log.close() }
}

export const deleteBranchCmd = Command.make("delete-branch", {
  repo: Args.text({ name: "repo" }),
  branches: Options.text("branch").pipe(Options.repeated),
  branchesFile: Options.text("branches-file").pipe(Options.optional),
  log: Options.text("log").pipe(Options.optional),
  dryRun: Options.boolean("dry-run"), yes: Options.boolean("yes"),
}, ({ repo, branches, branchesFile, log, dryRun, yes }) => Effect.gen(function* () {
  const fromFile = Option.getOrUndefined(branchesFile)
  if (dryRun && yes) return yield* Effect.fail(new BranchDeleteError("InvalidConfirmation", "Use either --dry-run or --yes, not both."))
  if ((branches.length > 0) === (fromFile !== undefined)) return yield* Effect.fail(new BranchDeleteError("InvalidBranches", "Supply --branch names or --branches-file, not both, and at least one branch."))
  const names = fromFile === undefined ? branches : yield* Effect.tryPromise({
    try: async () => (await readFile(fromFile, "utf8")).split(/\r?\n/).map((name) => name.trim()).filter(Boolean),
    catch: () => new BranchDeleteError("InvalidBranches", "Cannot read --branches-file."),
  })
  if (!names.length) return yield* Effect.fail(new BranchDeleteError("InvalidBranches", "The branches file contains no names."))
  const repoRef = yield* Effect.try({ try: () => parseRepo(repo), catch: () => new BranchDeleteError("InvalidRepository", "Use owner/repo.") })
  const { octokit, token } = yield* createRepoOctokit(repoRef)
  const logPath = Option.getOrElse(log, () => path.join(homedir(), ".local/state/shitrat/branch-deletes.jsonl"))
  const batch = yield* Effect.tryPromise({ try: () => runBatch(octokit, repoRef, names, yes, logPath, token.permissions.contents), catch: (error) => error instanceof BranchDeleteError ? error : new BranchDeleteError("AuditLogFailed", "Audit log could not be opened or appended. Stop and inspect branch state and log permissions before retrying.") })
  const result = { ...batch, repo: repoRef.fullName, dry_run: !yes, github_write: batch.results.some((item) => item.delete_attempted), actor: "shitratgit[bot]", installation_id: token.installationId, log: logPath }
  const actions = [{ command: "status <repo>", description: "Check repository access; inspect branch results and the audit log before retrying", params: { repo: { value: repoRef.fullName } } }]
  const command = `delete-branch ${repoRef.fullName}`
  if (batch.counts.refused || batch.counts.failed) {
    process.exitCode = 1
    yield* Console.log(JSON.stringify({ ...failure(command, "One or more branches refused or failed; inspect per-branch results.", "BranchDeleteBatchFailed", "Verify contents: write permission and branch state; do not retry blindly.", actions), result }, null, 2))
  } else yield* Console.log(json(success(command, result, actions)))
}).pipe(Effect.catchAll((error) => Effect.gen(function* () {
  process.exitCode = 1
  const typed = error instanceof BranchDeleteError ? error : new BranchDeleteError("BranchDeleteFailed", "Authentication or branch deletion failed. Verify repository access and contents: write permission.")
  yield* Console.log(json(failure(`delete-branch ${repo}`, typed.message, typed.code, "Inspect inputs, repository state and contents: write permission before retrying.", [{ command: "status <repo>", description: "Check App repository access", params: { repo: { value: repo } } }])))
})))).pipe(Command.withDescription("Delete merged, unprotected branches; dry-run by default, writes require --yes"))
