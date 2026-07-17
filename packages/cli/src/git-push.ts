import path from "node:path"

export const SHITRAT_GIT_AUTHOR = {
  name: "shitratgit[bot]",
  id: 286405550,
  email: "286405550+shitratgit[bot]@users.noreply.github.com",
} as const

const ZERO_SHA = "0000000000000000000000000000000000000000"
const PUSH_TOKEN_ENV = "SHITRAT_PUSH_TOKEN"
const AUTHENTICATED_GIT_CONFIG_ENV = {
  GIT_CONFIG_COUNT: "0",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_SSL_NO_VERIFY: "0",
} as const
const GITHUB_CREDENTIAL_HELPER =
  "!f() { test \"$1\" = get || exit 0; protocol=; host=; while IFS='=' read -r key value; do case \"$key\" in protocol) protocol=$value ;; host) host=$value ;; esac; done; test \"$protocol\" = https && test \"$host\" = github.com || exit 0; printf '%s\\n' 'username=x-access-token' \"password=$SHITRAT_PUSH_TOKEN\"; }; f"

export class ShitRatPushError extends Error {
  readonly code: string
  readonly fix: string

  constructor(message: string, code: string, fix: string) {
    super(message)
    this.name = "ShitRatPushError"
    this.code = code
    this.fix = fix
  }
}

export interface GitResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

interface GitRunOptions {
  readonly cwd: string
  readonly env?: Record<string, string>
  readonly sensitiveValues?: readonly string[]
}

const redact = (text: string, sensitiveValues: readonly string[]): string =>
  sensitiveValues.reduce(
    (result, value) => (value.length > 0 ? result.replaceAll(value, "[REDACTED]") : result),
    text,
  )

const runGitResult = async (
  args: readonly string[],
  options: GitRunOptions,
): Promise<GitResult> => {
  const proc = Bun.spawn(["git", ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  })

  const [rawStdout, rawStderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const sensitiveValues = options.sensitiveValues ?? []

  return {
    stdout: redact(rawStdout, sensitiveValues),
    stderr: redact(rawStderr, sensitiveValues),
    exitCode,
  }
}

const runGit = async (args: readonly string[], options: GitRunOptions): Promise<string> => {
  const result = await runGitResult(args, options)
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim()
    throw new Error(`git ${args[0] ?? "command"} failed${detail ? `: ${detail}` : ""}`)
  }
  return result.stdout.trim()
}

export interface AuthenticatedGitInvocation {
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

export const buildAuthenticatedGitInvocation = (
  args: readonly string[],
  installationToken: string,
): AuthenticatedGitInvocation => ({
  args: [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.https.allow=always",
    "-c",
    "credential.helper=",
    "-c",
    `credential.helper=${GITHUB_CREDENTIAL_HELPER}`,
    ...args,
  ],
  env: {
    ...AUTHENTICATED_GIT_CONFIG_ENV,
    [PUSH_TOKEN_ENV]: installationToken,
  },
})

const runAuthenticatedGit = async (
  args: readonly string[],
  cwd: string,
  installationToken: string,
): Promise<GitResult> => {
  const invocation = buildAuthenticatedGitInvocation(args, installationToken)
  const result = await runGitResult(invocation.args, {
    cwd,
    env: invocation.env,
    sensitiveValues: [installationToken],
  })
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim()
    throw new Error(`git ${args[0] ?? "command"} failed${detail ? `: ${detail}` : ""}`)
  }
  return result
}

const validateBranch = (value: string): string => {
  const branch = value.trim()
  if (
    branch.length === 0 ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.includes("//") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.endsWith(".lock") ||
    /[\u0000-\u001f\u007f\s~^:?*[\\]/.test(branch)
  ) {
    throw new ShitRatPushError(
      `Invalid branch '${value}'.`,
      "INVALID_BRANCH",
      "Use a normal local branch name such as main or shitrat/update-notes.",
    )
  }
  return branch
}

const repositoryFromRemoteUrl = (remoteUrl: string): string | undefined => {
  const trimmed = remoteUrl.trim()
  const scpMatch = trimmed.match(/^(?:[^@]+@)?github\.com:([^/]+)\/(.+?)(?:\.git)?$/i)
  if (scpMatch) return `${scpMatch[1]}/${scpMatch[2]?.replace(/\.git$/i, "")}`

  try {
    const parsed = new URL(trimmed)
    if (parsed.hostname.toLowerCase() !== "github.com") return undefined
    const pathname = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "")
    return pathname.split("/").length === 2 ? pathname : undefined
  } catch {
    return undefined
  }
}

export interface PushRepository {
  readonly repo: string
  readonly gitRoot: string
  readonly branch: string
  readonly localSha: string
}

export const inspectPushRepository = async (input: {
  readonly repo: string
  readonly repoDir: string
  readonly branch?: string
}): Promise<PushRepository> => {
  const resolvedDir = path.resolve(input.repoDir)
  const gitRoot = await runGit(["rev-parse", "--show-toplevel"], { cwd: resolvedDir }).catch(() => {
    throw new ShitRatPushError(
      `'${resolvedDir}' is not a git worktree.`,
      "NOT_A_GIT_REPOSITORY",
      "Pass --repo-dir <path> for the checkout you intend to push.",
    )
  })
  const checkoutUrlRewrites = await runGitResult(
    [
      "config",
      "--includes",
      "--null",
      "--get-regexp",
      "^url\\..*\\.(insteadOf|pushInsteadOf)$",
    ],
    { cwd: gitRoot, env: AUTHENTICATED_GIT_CONFIG_ENV },
  )
  if (checkoutUrlRewrites.exitCode === 0 && checkoutUrlRewrites.stdout.length > 0) {
    throw new ShitRatPushError(
      "The checkout has URL rewrite rules that could redirect authenticated Git traffic.",
      "UNSAFE_GIT_CONFIG",
      "Remove checkout-local or worktree-scoped url.*.insteadOf/pushInsteadOf rules before using shitrat push.",
    )
  }

  const originUrl = await runGit(["remote", "get-url", "origin"], { cwd: gitRoot }).catch(() => {
    throw new ShitRatPushError(
      "The checkout has no readable origin remote.",
      "REPO_MISMATCH",
      `Set origin to https://github.com/${input.repo}.git or use the matching checkout.`,
    )
  })
  const originRepo = repositoryFromRemoteUrl(originUrl)
  if (originRepo?.toLowerCase() !== input.repo.toLowerCase()) {
    throw new ShitRatPushError(
      `The checkout origin does not match '${input.repo}'.`,
      "REPO_MISMATCH",
      `Use the checkout whose origin is https://github.com/${input.repo}.git, or pass the correct owner/repo.`,
    )
  }

  const currentBranch = await runGit(["branch", "--show-current"], { cwd: gitRoot })
  const branch = validateBranch(input.branch ?? currentBranch)
  if (!input.branch && currentBranch.length === 0) {
    throw new ShitRatPushError(
      "Cannot infer a branch from detached HEAD.",
      "DETACHED_HEAD",
      "Check out a local branch or pass --branch <name>.",
    )
  }
  const localSha = await runGit(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], {
    cwd: gitRoot,
  }).catch(() => {
    throw new ShitRatPushError(
      `Local branch '${branch}' does not exist.`,
      "LOCAL_BRANCH_NOT_FOUND",
      "Check out the branch you intend to push or pass an existing --branch <name>.",
    )
  })

  return { repo: input.repo, gitRoot, branch, localSha }
}

const authenticatedRepoUrl = (repo: string): string => `https://github.com/${repo}.git`

export const buildFetchCommandArgs = (repository: PushRepository): readonly string[] => [
  "fetch",
  "--prune",
  "--no-tags",
  "--no-recurse-submodules",
  authenticatedRepoUrl(repository.repo),
  "+refs/heads/*:refs/remotes/origin/*",
]

export const fetchPushRefs = async (
  repository: PushRepository,
  installationToken: string,
): Promise<void> => {
  await runAuthenticatedGit(
    buildFetchCommandArgs(repository),
    repository.gitRoot,
    installationToken,
  )
}

export interface OutgoingCommit {
  readonly sha: string
  readonly authorName: string
  readonly authorEmail: string
}

export interface PushPlan {
  readonly oldSha: string
  readonly newSha: string
  readonly range: string
  readonly remoteBranchExists: boolean
  readonly nothingToPush: boolean
  readonly pushedCount: number
  readonly commits: readonly OutgoingCommit[]
}

const optionalCommitSha = async (ref: string, cwd: string): Promise<string | undefined> => {
  const result = await runGitResult(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    cwd,
  })
  return result.exitCode === 0 ? result.stdout.trim() : undefined
}

const outgoingShas = async (
  repository: PushRepository,
  remoteSha: string | undefined,
): Promise<readonly string[]> => {
  const args = remoteSha
    ? ["rev-list", "--reverse", `${remoteSha}..${repository.localSha}`]
    : ["rev-list", "--reverse", repository.localSha, "--not", "--remotes=origin"]
  const output = await runGit(args, { cwd: repository.gitRoot })
  return output.length === 0 ? [] : output.split("\n").filter(Boolean)
}

const readCommitAuthor = async (sha: string, cwd: string): Promise<OutgoingCommit> => {
  const output = await runGit(["show", "-s", "--format=%an%x00%ae", sha], { cwd })
  const [authorName = "", authorEmail = ""] = output.split("\0")
  return { sha, authorName, authorEmail: authorEmail.trim() }
}

const authorFix = (repo: string): string =>
  `Create bot-authored commits with: git -c user.name='${SHITRAT_GIT_AUTHOR.name}' -c user.email='${SHITRAT_GIT_AUTHOR.email}' commit <args>. If these authors are intentional, retry with: shitrat push ${repo} --allow-any-author.`

export const resolvePushPlan = async (
  repository: PushRepository,
  allowAnyAuthor: boolean,
): Promise<PushPlan> => {
  const remoteRef = `refs/remotes/origin/${repository.branch}`
  const remoteSha = await optionalCommitSha(remoteRef, repository.gitRoot)

  if (remoteSha && remoteSha !== repository.localSha) {
    const ancestry = await runGitResult(
      ["merge-base", "--is-ancestor", remoteSha, repository.localSha],
      { cwd: repository.gitRoot },
    )
    if (ancestry.exitCode !== 0) {
      throw new ShitRatPushError(
        `Local branch '${repository.branch}' is not a fast-forward of origin/${repository.branch}.`,
        "NON_FAST_FORWARD",
        "Fetch and reconcile the branch yourself. shitrat push never rebases, amends, or force-pushes.",
      )
    }
  }

  const shas = await outgoingShas(repository, remoteSha)
  const commits = await Promise.all(shas.map((sha) => readCommitAuthor(sha, repository.gitRoot)))
  if (!allowAnyAuthor) {
    const violations = commits.filter(
      (commit) =>
        commit.authorName !== SHITRAT_GIT_AUTHOR.name ||
        commit.authorEmail !== SHITRAT_GIT_AUTHOR.email,
    )
    if (violations.length > 0) {
      const details = violations
        .map((commit) => `${commit.sha.slice(0, 12)} ${commit.authorName} <${commit.authorEmail}>`)
        .join(", ")
      throw new ShitRatPushError(
        `Outgoing commits are not authored by ${SHITRAT_GIT_AUTHOR.name}: ${details}`,
        "AUTHOR_NOT_BOT",
        authorFix(repository.repo),
      )
    }
  }

  const oldSha = remoteSha ?? ZERO_SHA
  const remoteBranchExists = remoteSha !== undefined
  const nothingToPush = remoteSha === repository.localSha

  return {
    oldSha,
    newSha: repository.localSha,
    range: `${oldSha}..${repository.localSha}`,
    remoteBranchExists,
    nothingToPush,
    pushedCount: nothingToPush ? 0 : remoteBranchExists ? commits.length : Math.max(1, commits.length),
    commits,
  }
}

export const buildPushCommandArgs = (
  repository: PushRepository,
  dryRun: boolean,
): readonly string[] => [
  "push",
  "--no-verify",
  "--recurse-submodules=no",
  ...(dryRun ? ["--dry-run"] : []),
  authenticatedRepoUrl(repository.repo),
  `${repository.localSha}:refs/heads/${repository.branch}`,
]

export const pushWithGit = async (
  repository: PushRepository,
  installationToken: string,
  dryRun: boolean,
): Promise<GitResult> =>
  runAuthenticatedGit(
    buildPushCommandArgs(repository, dryRun),
    repository.gitRoot,
    installationToken,
  )
