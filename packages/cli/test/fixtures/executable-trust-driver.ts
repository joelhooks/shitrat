import fs from "node:fs"

const mode = process.argv[2]
const target = process.argv[3]
if (mode === "foreign-owner") {
  const { mock } = await import("bun:test")
  const canonical = fs.realpathSync(target!)
  const originalStat = fs.statSync
  const statSync = (...args: Parameters<typeof fs.statSync>) => {
    const stat = originalStat(...args)
    if (String(args[0]) === canonical) Object.defineProperty(stat, "uid", { value: (process.getuid?.() ?? 0) + 424242 })
    return stat
  }
  mock.module("node:fs", () => ({ ...fs, statSync }))
}

try {
  const trust = await import("../../src/executable-trust.js")
  let result: unknown
  if (mode === "foreign-owner") result = trust.trustedExecutable(target)
  else if (mode === "required" || mode === "optional") {
    const { Effect } = await import("effect")
    const secrets = await import("../../src/secrets.js")
    const outcome = await Effect.runPromise(Effect.either(mode === "required" ? secrets.readSecret("fixture_absent") : secrets.readOptionalSecret("fixture_absent")))
    if (outcome._tag === "Left") throw outcome.left
    result = outcome.right
  } else if (mode === "write") {
    const { writeAgentSecret } = await import("../../src/secrets.js")
    writeAgentSecret("fixture_absent", "synthetic-value")
  } else result = trust.secretsExecutable(target)
  console.log(JSON.stringify({ ok: true, result }))
} catch (error) {
  console.log(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : "unknown", ...(typeof error === "object" && error !== null ? error : {}) }))
}
