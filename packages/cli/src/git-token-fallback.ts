import { constants } from "node:fs"
import { lstat, mkdir, open } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

// Temporary GitHub git-over-HTTPS workaround, observed 2026-10-27.
// Remove/recheck after 2026-11-10 (inclusive, UTC); never silently extend it.
export const GIT_TOKEN_FALLBACK_END = Date.parse("2026-11-11T00:00:00.000Z")
export const gitTokenFallbackEnabled = (now = Date.now()): boolean =>
  Number.isFinite(now) && now < GIT_TOKEN_FALLBACK_END

export const githubGitUrl = (repo: string): string => {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("Refusing unsafe GitHub repository target; use owner/repo, without credentials or a URL.")
  }
  const url = new URL(`https://github.com/${repo}.git`)
  if (url.protocol !== "https:" || url.host !== "github.com" || url.username || url.password) {
    throw new Error("Refusing credentialed or non-github.com Git target.")
  }
  return url.href
}

export const isGitHubTokenRefusal = (error: unknown, repo: string): boolean => {
  const message = error instanceof Error ? error.message : String(error)
  // Match GitHub's auth refusals, not a general HTTP 403 or arbitrary git failure.
  return /(?:remote: |fatal: )Repository not found\.?\s*(?:\n|$)/i.test(message) ||
    (message.toLowerCase().includes(`permission to ${repo.toLowerCase()}.git denied to shitratgit[bot].`) && /\b403\b/.test(message))
}

export interface GitTokenScopeResult {
  tokenScope: "repository" | "installation"
  fallbackUsed: boolean
  note?: string
  warnings?: string[]
}

export class GitTokenFallbackError extends Error {
  constructor(message: string, readonly auth: GitTokenScopeResult) { super(message) }
}

const headers = (token: string) => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
})

export const createGitTokenFallback = (
  repo: string,
  scopedToken: { readonly token: string; readonly permissions: Record<string, string> },
  mintInstallationToken: () => Promise<{ readonly token: string }>,
) => {
  const state: GitTokenScopeResult = { tokenScope: "repository", fallbackUsed: false }
  const warn = (message: string) => { (state.warnings ??= []).push(message) }
  const result = (): GitTokenScopeResult => ({ ...state, ...(state.warnings ? { warnings: [...state.warnings] } : {}) })

  // Lifecycle: scoped -> refused -> REST verified -> minted -> git -> revoke -> receipt.
  // Non-matching errors/expired window/failed verification terminate before minting.
  // Each child starts scoped; a full token belongs to exactly one child, never the next.
  const run = async <A>(operation: (token: string, checkedRepo: string) => Promise<A>): Promise<A> => {
    githubGitUrl(repo)
    try {
      return await operation(scopedToken.token, repo)
    } catch (first) {
      if (!isGitHubTokenRefusal(first, repo)) {
        throw new GitTokenFallbackError(first instanceof Error ? first.message : String(first), result())
      }
      if (!gitTokenFallbackEnabled()) {
        throw new GitTokenFallbackError("GitHub refused the repository token. The temporary fallback expired after 2026-11-10; recheck GitHub git authentication before extending it.", result())
      }
      // Do not follow a REST redirect to a renamed/different repository.
      let verified: { full_name?: string; owner?: { login?: string }; name?: string; permissions?: { push?: boolean } }
      try {
        const response = await fetch(`https://api.github.com/repos/${repo}`, { headers: headers(scopedToken.token), redirect: "error", signal: AbortSignal.timeout(10_000) })
        if (!response.ok) throw new Error()
        verified = await response.json() as typeof verified
      } catch {
        throw new GitTokenFallbackError("Cannot verify the named repository with the scoped token; refusing broader git credentials.", result())
      }
      const checkedRepo = `${verified.owner?.login}/${verified.name}`
      if (checkedRepo.toLowerCase() !== repo.toLowerCase() || verified.full_name?.toLowerCase() !== repo.toLowerCase() ||
        !(verified.permissions?.push === true || scopedToken.permissions.contents === "write")) {
        throw new GitTokenFallbackError("Scoped REST repository identity or push permission did not match; refusing broader git credentials.", result())
      }
      githubGitUrl(checkedRepo)
      const full = await mintInstallationToken()
      state.tokenScope = "installation"
      state.fallbackUsed = true
      state.note = "GitHub refused a repository-scoped git token; retried once with a verified-target installation token (temporary through 2026-11-10)."
      let outcome = "failed"
      try {
        const value = await operation(full.token, checkedRepo)
        outcome = "succeeded"
        return value
      } catch {
        // Never include arbitrary token-bearing API/child exceptions here.
        throw new GitTokenFallbackError("Both repository-scoped and installation-token git attempts failed. Inspect GitHub access and branch protection before retrying.", state)
      } finally {
        // Revoke before logging or returning, including when the child fails/spawn throws.
        try {
          const response = await fetch("https://api.github.com/installation/token", { method: "DELETE", headers: headers(full.token), redirect: "error", signal: AbortSignal.timeout(10_000) })
          if (!response.ok) throw new Error()
        } catch {
          warn("Installation token revocation failed; it may remain valid until its GitHub expiry.")
        }
        try {
          const dir = path.join(process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state"), "shitrat")
          await mkdir(dir, { recursive: true, mode: 0o700 })
          const directory = await lstat(dir)
          if (!directory.isDirectory() || (directory.mode & 0o777) !== 0o700) throw new Error()
          const log = await open(path.join(dir, "git-token-fallback.jsonl"), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
          try {
            if (!(await log.stat()).isFile()) throw new Error()
            await log.chmod(0o600)
            await log.writeFile(JSON.stringify({ timestamp: new Date().toISOString(), repo: checkedRepo, outcome }) + "\n")
          } finally { await log.close() }
        } catch {
          warn("Could not append the local git token fallback counter.")
        }
      }
    }
  }
  return { run, result }
}
