import { access, constants } from "node:fs/promises"
import path from "node:path"

// Best-effort CI attestation after a push or a new PR. fleet-compute owns the contract and the kill
// switch (FLEET_ATTEST=off answers exit 3); this side never fails the push it follows.
//   exit 0: posted        exit 3: no-op, stdout is a one-word reason, add nothing
//   exit 2: bad args      any other exit: error
export type AttestRecord =
  | { exit: 0; status: "posted" }
  | { exit: number; stderr: string }
  | { exit: null; reason: string }

export interface AttestOptions {
  // PATH to search; tests point this at a directory of fake fleet-compute scripts.
  pathEnv?: string
  timeoutMs?: number
}

const FULL_SHA = /^[0-9a-f]{40}$/
const STDERR_LIMIT = 500

const findOnPath = async (name: string, pathEnv: string): Promise<string | undefined> => {
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name)
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // not here; keep looking
    }
  }
  return undefined
}

// Returns undefined when nothing belongs in the JSON result: fleet-compute is missing or answered exit 3.
export const attestPushedSha = async (repo: string, sha: string, options: AttestOptions = {}): Promise<AttestRecord | undefined> => {
  try {
    const binary = await findOnPath("fleet-compute", options.pathEnv ?? process.env.PATH ?? "")
    if (!binary) return undefined
    if (!FULL_SHA.test(sha)) return { exit: null, reason: `refused to attest ${JSON.stringify(sha)}: not a full 40-hex sha` }

    const proc = Bun.spawn([binary, "attest", "--github", repo, "--sha", sha], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...(options.pathEnv !== undefined ? { PATH: options.pathEnv } : {}) },
    })
    const timer = setTimeout(() => proc.kill(), options.timeoutMs ?? 20_000)
    const [, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).finally(() => clearTimeout(timer))

    if (exit === 0) return { exit: 0, status: "posted" }
    if (exit === 3) return undefined
    return { exit, stderr: stderr.trim().slice(0, STDERR_LIMIT) || (proc.signalCode ? `killed by ${proc.signalCode}` : "") }
  } catch (error) {
    return { exit: null, reason: error instanceof Error ? error.message : String(error) }
  }
}

export const withAttest = (attest: AttestRecord | undefined) => (attest ? { attest } : {})
