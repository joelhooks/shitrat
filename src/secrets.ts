import { Effect } from "effect"

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
  const proc = Bun.spawnSync(["secrets", "lease", secretName], {
    stdout: "pipe",
    stderr: "pipe",
  })

  if (proc.exitCode !== 0) return undefined

  const value = new TextDecoder().decode(proc.stdout).trimEnd()
  return value.length > 0 ? value : undefined
}

export const readSecret = (secretName: string): Effect.Effect<string, MissingSecretError> =>
  Effect.sync(() => readEnv(secretName) ?? leaseWithAgentSecrets(secretName)).pipe(
    Effect.flatMap((value) =>
      value ? Effect.succeed(value) : Effect.fail(new MissingSecretError(secretName)),
    ),
  )

export const readOptionalSecret = (secretName: string): Effect.Effect<string | undefined> =>
  Effect.sync(() => readEnv(secretName) ?? leaseWithAgentSecrets(secretName))
