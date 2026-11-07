import { Effect } from "effect"
import { secretsExecutable, UntrustedSecretsExecutableError } from "./executable-trust.js"
import { leaseEnvironment } from "./child-environment.js"

export class MissingSecretError extends Error {
  readonly code = "MISSING_SECRET"
  constructor(readonly secretName: string) {
    super(`Missing required secret: ${secretName}`)
  }
}

const envNameFor = (secretName: string): string => secretName.toUpperCase()

const readEnv = (secretName: string): string | undefined => {
  const direct = process.env[envNameFor(secretName)]
  if (direct && direct.trim().length > 0) return direct
  return undefined
}

const leaseWithAgentSecrets = (secretName: string): string | undefined => {
  const bin = secretsExecutable()
  const proc = Bun.spawnSync([bin, "lease", secretName], {
    env: leaseEnvironment(), stdout: "pipe", stderr: "pipe",
  })

  if (proc.exitCode !== 0) return undefined

  const value = new TextDecoder().decode(proc.stdout).trimEnd()
  return value.length > 0 ? value : undefined
}

const readValue = (secretName: string) => Effect.try({
  try: () => readEnv(secretName) ?? leaseWithAgentSecrets(secretName),
  catch: (error) => error instanceof UntrustedSecretsExecutableError ? error : new MissingSecretError(secretName),
})

export const readSecret = (secretName: string): Effect.Effect<string, MissingSecretError | UntrustedSecretsExecutableError> =>
  readValue(secretName).pipe(
    Effect.flatMap((value) =>
      value ? Effect.succeed(value) : Effect.fail(new MissingSecretError(secretName)),
    ),
  )

export const readOptionalSecret = (secretName: string): Effect.Effect<string | undefined, MissingSecretError | UntrustedSecretsExecutableError> =>
  readValue(secretName)

export class SecretWriteError extends Error {
  readonly code = "SECRET_WRITE_FAILED"
  constructor(readonly secretName: string, detail: string) {
    super(`Could not write secret ${secretName}: ${detail}`)
  }
}

// The value goes in on stdin, never argv, and is read back from the store
// (not the env override) to prove the write landed.
export const writeAgentSecret = (secretName: string, value: string): void => {
  const bin = secretsExecutable()
  const run = (verb: "update" | "add") =>
    Bun.spawnSync([bin, verb, secretName], {
      env: leaseEnvironment(),
      stdin: new TextEncoder().encode(value),
      stdout: "pipe",
      stderr: "pipe",
    })
  let proc = run("update")
  if (proc.exitCode !== 0) proc = run("add")
  if (proc.exitCode !== 0) {
    throw new SecretWriteError(secretName, `secrets exited ${proc.exitCode}`)
  }
  if (leaseWithAgentSecrets(secretName) !== value) {
    throw new SecretWriteError(secretName, "readback did not match")
  }
}
