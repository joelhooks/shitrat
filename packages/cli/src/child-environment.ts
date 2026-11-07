// Credentials belong to the child that consumes them, not every subprocess.
export const leaseEnvironment = (): NodeJS.ProcessEnv => Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key === "PATH" || key === "HOME" || key.startsWith("AGENT_SECRETS") || key.startsWith("XDG") || key.startsWith("OTEL_EMIT_")),
)

const traceKey = (key: string): boolean => key.startsWith("GIT_TRACE") || key === "GIT_CURL_VERBOSE" || key === "GIT_REDACT_COOKIES"
const identityKeys = new Set(["SC_IDENTITY_JSON", "SC_PASS_FILE", "SC_FORWARD_NONCE", "SHITRAT_CELL_IDENTITY_FILE", "SHITRAT_GITHUB_PRIVATE_KEY"])
const gitConfigKey = (key: string): boolean => key === "GIT_CONFIG_PARAMETERS" || key === "GIT_CONFIG_COUNT" || key.startsWith("GIT_CONFIG_KEY_") || key.startsWith("GIT_CONFIG_VALUE_")
const tokenKeys = new Set(["SHITRAT_PUSH_TOKEN", "SHITRAT_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"])

export const gitEnvironment = (overrides: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv => {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (identityKeys.has(key) || tokenKeys.has(key) || traceKey(key) || gitConfigKey(key)) delete env[key]
  }
  // Only deliberately scoped credentials (the direct Git installation token or
  // cell placeholder/nonce headers) may enter through invocation overrides.
  for (const [key, value] of Object.entries(overrides)) {
    if (!identityKeys.has(key) && !traceKey(key)) env[key] = value
  }
  return env
}
