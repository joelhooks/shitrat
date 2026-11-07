import { realpathSync, statSync } from "node:fs"
import { delimiter, dirname, isAbsolute, relative, sep } from "node:path"

export class ExecutableTrustError extends Error {
  constructor(readonly path: string, readonly rule: string) {
    super(`Untrusted executable ${JSON.stringify(path)}: ${rule}`)
  }
}

export class UntrustedSecretsExecutableError extends Error {
  readonly code = "UNTRUSTED_SECRETS_EXECUTABLE"
  constructor(readonly path: string, readonly rule: string) {
    super(`untrusted secrets executable ${JSON.stringify(path)}: ${rule}`)
  }
}

const trustedOwner = (uid: number): boolean => uid === 0 || uid === process.getuid?.()

// Same-user programs are trusted. This checks every resolved ancestor, but does
// not validate interpreter chains or bind the checked inode to the executed file.
export const trustedExecutable = (file: unknown): string => {
  const label = typeof file === "string" ? file : "(not configured)"
  const refuse = (path: string, rule: string): never => { throw new ExecutableTrustError(path, rule) }
  if (typeof file !== "string" || !isAbsolute(file)) return refuse(label, "path must be absolute")
  let resolved: string
  try { resolved = realpathSync(file) } catch { return refuse(file, "path must resolve to an existing executable") }
  const stat = statSync(resolved)
  if (!stat.isFile()) return refuse(resolved, "target must be a regular file")
  if (!trustedOwner(stat.uid)) return refuse(resolved, "target owner must be root or the current uid")
  if ((stat.mode & 0o022) !== 0) return refuse(resolved, "target must not be group or world writable")
  if ((stat.mode & 0o111) === 0) return refuse(resolved, "target must be executable")
  for (let directory = dirname(resolved); ; directory = dirname(directory)) {
    const parent = statSync(directory)
    if (!parent.isDirectory()) return refuse(directory, "ancestor must be a directory")
    if (!trustedOwner(parent.uid)) return refuse(directory, "ancestor owner must be root or the current uid")
    if ((parent.mode & 0o022) !== 0 && !(parent.uid === 0 && (parent.mode & 0o1000) !== 0)) {
      return refuse(directory, "ancestor must not be group or world writable unless sticky and root owned")
    }
    if (dirname(directory) === directory) break
  }
  return resolved
}

let secretsPath: { path: string | null; searchPath: string } | undefined
export const secretsExecutable = (configured?: unknown): string => {
  let candidate: unknown = configured
  try {
    if (configured === undefined) {
      const searchPath = (process.env.PATH ?? "").split(delimiter).filter((entry) => isAbsolute(entry)).join(delimiter)
      if (!secretsPath || secretsPath.searchPath !== searchPath) {
        secretsPath = { path: searchPath ? Bun.which("secrets", { PATH: searchPath }) : null, searchPath }
      }
      candidate = secretsPath.path
      if (!candidate) throw new ExecutableTrustError("secrets (PATH)", "no secrets executable found in absolute PATH entries")
    }
    const resolved = trustedExecutable(candidate)
    const withinCwd = relative(realpathSync(process.cwd()), resolved)
    if (withinCwd === "" || (withinCwd !== ".." && !withinCwd.startsWith(`..${sep}`) && !isAbsolute(withinCwd))) {
      throw new ExecutableTrustError(resolved, "secrets executable must be outside the current working directory")
    }
    return resolved
  } catch (error) {
    if (error instanceof ExecutableTrustError) throw new UntrustedSecretsExecutableError(error.path, error.rule)
    throw new UntrustedSecretsExecutableError(typeof candidate === "string" ? candidate : "secrets (PATH)", "executable and all ancestors must be accessible for trust checks")
  }
}
