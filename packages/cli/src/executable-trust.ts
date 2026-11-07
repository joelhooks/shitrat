import { realpathSync, statSync } from "node:fs"
import { dirname, isAbsolute } from "node:path"

const trustedOwnerAndMode = (stat: { uid: number; mode: number }): boolean =>
  (stat.uid === 0 || stat.uid === process.getuid?.()) && (stat.mode & 0o022) === 0

// Execute the resolved target, never the replaceable alias. Trust is local:
// current-user/root ownership with no group/world write access on target and
// immediate parent. This does not attest the contents of a user-owned program.
export const trustedExecutable = (file: unknown): string => {
  if (typeof file !== "string" || !isAbsolute(file)) throw new Error("Untrusted executable")
  const resolved = realpathSync(file)
  const stat = statSync(resolved)
  const parent = statSync(dirname(resolved))
  if (!stat.isFile() || !trustedOwnerAndMode(stat) || (stat.mode & 0o111) === 0 || !parent.isDirectory() || !trustedOwnerAndMode(parent)) {
    throw new Error("Untrusted executable")
  }
  return resolved
}

let secretsPath: { path: string | null; searchPath: string | undefined } | undefined
export const secretsExecutable = (configured?: unknown): string => {
  if (configured !== undefined) return trustedExecutable(configured)
  // Resolve PATH once per search path; recheck ownership/mode before each use.
  if (!secretsPath || secretsPath.searchPath !== process.env.PATH) {
    secretsPath = { path: Bun.which("secrets"), searchPath: process.env.PATH }
  }
  return trustedExecutable(secretsPath.path)
}
