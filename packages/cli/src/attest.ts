import { access, appendFile, constants, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
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
// What fleet-compute did, before deciding what belongs in the JSON result.
type Outcome =
  | { fleetCompute: "missing" }
  | { fleetCompute: "present"; exit: number | null; reason?: string; stderr?: string }

// Read what a pipe has, but never wait long: a killed wrapper's children can hold it open.
const drain = (stream: ReadableStream<Uint8Array>) => {
  const text = new Response(stream).text().catch(() => "")
  return () => Promise.race([text, new Promise<string>((resolve) => setTimeout(() => resolve(""), 250))]).then((value) => value.trim().slice(0, STDERR_LIMIT))
}

const runAttest = async (repo: string, sha: string, options: AttestOptions): Promise<Outcome> => {
  const binary = await findOnPath("fleet-compute", options.pathEnv ?? process.env.PATH ?? "")
  if (!binary) return { fleetCompute: "missing" }
  if (!FULL_SHA.test(sha)) return { fleetCompute: "present", exit: null, reason: `refused to attest ${JSON.stringify(sha)}: not a full 40-hex sha` }

  const proc = Bun.spawn([binary, "attest", "--github", repo, "--sha", sha], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...(options.pathEnv !== undefined ? { PATH: options.pathEnv } : {}) },
  })
  const timer = setTimeout(() => proc.kill("SIGKILL"), options.timeoutMs ?? 20_000)
  const stdout = drain(proc.stdout)
  const stderr = drain(proc.stderr)
  // Wait on the process, not its pipes.
  const exit = await proc.exited.finally(() => clearTimeout(timer))
  if (exit === 0 || exit === 3) return { fleetCompute: "present", exit, reason: await stdout() }
  return { fleetCompute: "present", exit, stderr: (await stderr()) || (proc.signalCode ? `killed by ${proc.signalCode}` : "") }
}

const toRecord = (outcome: Outcome): AttestRecord | undefined => {
  if (outcome.fleetCompute === "missing" || outcome.exit === 3) return undefined
  if (outcome.exit === 0) return { exit: 0, status: "posted" }
  if (outcome.exit === null) return { exit: null, reason: outcome.reason ?? "" }
  return { exit: outcome.exit, stderr: outcome.stderr ?? "" }
}

declare const SHITRAT_BUILD_SHA: string | undefined
// Injected by build:binary with --define; source runs report "dev".
export const shitratBuild = typeof SHITRAT_BUILD_SHA === "string" ? SHITRAT_BUILD_SHA : "dev"

export const defaultAttestLog = () => path.join(homedir(), ".shitrat", "log", "attest.jsonl")

// The readback for every attest attempt, including exit 3 and a missing fleet-compute, which the JSON keeps silent.
// Append-only, named fields only: never the token or the environment. A failed write never fails the push.
const logOutcome = async (logPath: string, entry: Record<string, unknown>) => {
  try {
    await mkdir(path.dirname(logPath), { recursive: true })
    await appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8")
  } catch {
    // best-effort by contract
  }
}

// Returns undefined when nothing belongs in the JSON result: fleet-compute is missing or answered exit 3.
export const attestPushedSha = async (
  repo: string,
  sha: string,
  options: AttestOptions & { command?: "push" | "create-pr"; logPath?: string } = {},
): Promise<AttestRecord | undefined> => {
  let outcome: Outcome
  try {
    outcome = await runAttest(repo, sha, options)
  } catch (error) {
    outcome = { fleetCompute: "present", exit: null, reason: error instanceof Error ? error.message : String(error) }
  }
  const { fleetCompute, ...result } = outcome
  await logOutcome(options.logPath ?? defaultAttestLog(), {
    ts: new Date().toISOString(),
    command: options.command ?? null,
    repo,
    sha,
    shitrat_build: shitratBuild,
    "fleet-compute": fleetCompute,
    ...result,
  })
  return toRecord(outcome)
}

export const withAttest = (attest: AttestRecord | undefined) => (attest ? { attest } : {})
