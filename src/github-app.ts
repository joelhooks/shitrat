import { Octokit } from "@octokit/rest"

export type GitHubOctokit = Octokit
import { Effect } from "effect"
import { createSign } from "node:crypto"
import { readOptionalSecret, readSecret } from "./secrets.js"

export interface RepoRef {
  readonly owner: string
  readonly repo: string
  readonly fullName: string
}

export interface ShitRatConfig {
  readonly appId: string
  readonly clientId?: string
  readonly privateKey: string
  readonly installations: Record<string, number>
}

export class GitHubAppError extends Error {
  readonly code = "GITHUB_APP_ERROR"
  constructor(message: string, override readonly cause?: unknown) {
    super(message)
  }
}

const b64url = (input: string | Buffer): string => Buffer.from(input).toString("base64url")

export const parseRepo = (value: string): RepoRef => {
  const match = value.trim().match(/^([^/\s]+)\/([^/\s]+)$/)
  if (!match?.[1] || !match?.[2]) {
    throw new GitHubAppError(`Invalid repo '${value}'. Use owner/repo.`)
  }
  return { owner: match[1], repo: match[2], fullName: `${match[1]}/${match[2]}` }
}

const normalizeOwnerKey = (owner: string): string =>
  owner.toLowerCase().replaceAll("-", "_").replaceAll(".", "_")

const parseInstallationsJson = (raw: string | undefined): Record<string, number> => {
  if (!raw) return {}
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const out: Record<string, number> = {}
  for (const [owner, value] of Object.entries(parsed)) {
    if (typeof value === "number") out[owner] = value
    if (typeof value === "string" && /^\d+$/.test(value)) out[owner] = Number(value)
  }
  return out
}

export const loadConfig = Effect.gen(function* () {
  const appId = yield* readSecret("shitrat_github_app_id")
  const privateKey = yield* readSecret("shitrat_github_private_key")
  const clientId = yield* readOptionalSecret("shitrat_github_client_id")
  const installationsRaw = yield* readOptionalSecret("shitrat_github_installations_json")

  return {
    appId: appId.trim(),
    clientId: clientId?.trim(),
    privateKey,
    installations: parseInstallationsJson(installationsRaw),
  } satisfies ShitRatConfig
})

export const createJwt = (config: ShitRatConfig): string => {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: "RS256", typ: "JWT" }
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: config.appId }
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(config.privateKey, "base64url")
  return `${unsigned}.${signature}`
}

const githubFetchJson = <T>(
  path: string,
  token: string,
  init: RequestInit = {},
): Effect.Effect<T, GitHubAppError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(`https://api.github.com${path}`, {
        ...init,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...init.headers,
        },
      })

      const text = await response.text()
      const body = text.length > 0 ? (JSON.parse(text) as unknown) : null
      if (!response.ok) {
        const message =
          body && typeof body === "object" && "message" in body
            ? String((body as { message?: unknown }).message)
            : `${response.status} ${response.statusText}`
        throw new GitHubAppError(message, body)
      }
      return body as T
    },
    catch: (error) =>
      error instanceof GitHubAppError
        ? error
        : new GitHubAppError(error instanceof Error ? error.message : String(error), error),
  })

export interface InstallationSummary {
  readonly id: number
  readonly account: string
  readonly repository_selection: string
  readonly target_type: string
}

interface GitHubInstallationResponse {
  readonly id: number
  readonly account: { readonly login: string }
  readonly repository_selection: string
  readonly target_type: string
}

export const listInstallations = Effect.gen(function* () {
  const config = yield* loadConfig
  const jwt = createJwt(config)
  const installations = yield* githubFetchJson<readonly GitHubInstallationResponse[]>(
    "/app/installations",
    jwt,
  )
  return installations.map((installation) => ({
    id: installation.id,
    account: installation.account.login,
    repository_selection: installation.repository_selection,
    target_type: installation.target_type,
  })) satisfies readonly InstallationSummary[]
})

export const resolveInstallationId = (owner: string) =>
  Effect.gen(function* () {
    const config = yield* loadConfig
    const direct = config.installations[owner] ?? config.installations[owner.toLowerCase()]
    if (direct) return direct

    const ownerSpecific = yield* readOptionalSecret(
      `shitrat_github_installation_id_${normalizeOwnerKey(owner)}`,
    )
    if (ownerSpecific && /^\d+$/.test(ownerSpecific.trim())) return Number(ownerSpecific.trim())

    const installations = yield* listInstallations
    const match = installations.find(
      (installation) => installation.account.toLowerCase() === owner.toLowerCase(),
    )
    if (!match) {
      return yield* Effect.fail(
        new GitHubAppError(
          `No ShitRat GitHub App installation found for '${owner}'. Install the app or add shitrat_github_installation_id_${normalizeOwnerKey(owner)}.`,
        ),
      )
    }
    return match.id
  })

interface InstallationTokenResponse {
  readonly token: string
  readonly expires_at: string
  readonly permissions?: Record<string, string>
  readonly repository_selection?: string
}

export interface InstallationTokenResult {
  readonly installationId: number
  readonly token: string
  readonly expiresAt: string
  readonly permissions: Record<string, string>
  readonly repositorySelection?: string
}

export const createInstallationToken = (owner: string, repository?: string) =>
  Effect.gen(function* () {
    const config = yield* loadConfig
    const installationId = yield* resolveInstallationId(owner)
    const jwt = createJwt(config)
    const response = yield* githubFetchJson<InstallationTokenResponse>(
      `/app/installations/${installationId}/access_tokens`,
      jwt,
      {
        method: "POST",
        body: repository ? JSON.stringify({ repositories: [repository] }) : undefined,
      },
    )

    return {
      installationId,
      token: response.token,
      expiresAt: response.expires_at,
      permissions: response.permissions ?? {},
      repositorySelection: response.repository_selection,
    }
  })

export const createRepoOctokit = (repoRef: RepoRef) =>
  Effect.gen(function* () {
    const token = yield* createInstallationToken(repoRef.owner, repoRef.repo)
    return { octokit: new Octokit({ auth: token.token }), token }
  })
