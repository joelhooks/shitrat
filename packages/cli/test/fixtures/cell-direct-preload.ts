import { appendFile } from "node:fs/promises"
import { appendFileSync } from "node:fs"
import fs from "node:fs/promises"

if (process.env.CELL_TEST_FOREIGN_OWNER_FILE) {
  // Open a real 0600 file, but simulate foreign ownership at the fstat boundary.
  // No privileged chown or unrelated root-owned credential file is needed.
  const originalOpen = fs.open
  const checkedOpen = async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args)
    if (String(args[0]) === process.env.CELL_TEST_FOREIGN_OWNER_FILE) {
      const stat = handle.stat.bind(handle)
      handle.stat = (async (...params: Parameters<typeof handle.stat>) => {
        const value = await stat(...params)
        Object.defineProperty(value, "uid", { value: process.getuid!() + 1 })
        return value
      }) as typeof handle.stat
    }
    return handle
  }
  const { mock } = await import("bun:test")
  mock.module("node:fs/promises", () => ({ ...fs, open: checkedOpen }))
}

if (process.env.CELL_TEST_CLI_ENVELOPE_DEFECT === "1") {
  // Fail rendering the command-level error once, so cli.ts's outer .catch must
  // build the envelope from captured stderr after the actual forward failure.
  let log = console.log
  let failed = false
  Object.defineProperty(console, "log", {
    configurable: true,
    get: () => log,
    set: (next: typeof console.log) => {
      log = (...args: unknown[]) => {
        let envelope: unknown
        try { envelope = JSON.parse(String(args[0])) } catch { /* Not JSON. */ }
        if (!failed && typeof envelope === "object" && envelope !== null && "ok" in envelope && envelope.ok === false) {
          failed = true
          throw new Error("fixture command envelope failure")
        }
        next(...args)
      }
    },
  })
}

const spawn = Bun.spawn
Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
  const [command, options] = args
  if (Array.isArray(command) && command[0] === process.env.CELL_TEST_REAL_SC_BIN && process.env.CELL_TEST_NONCES) {
    const env = options?.env ?? process.env
    appendFileSync(process.env.CELL_TEST_ARGV!, `${JSON.stringify(command.slice(1))}\n`)
    appendFileSync(process.env.CELL_TEST_NONCES, `${JSON.stringify({ command: command.includes("--capabilities") ? "capabilities" : command[1], nonce: env.SC_FORWARD_NONCE ?? null, identityPresent: !!env.SC_IDENTITY_JSON, privateKeyPresent: !!env.SHITRAT_GITHUB_PRIVATE_KEY })}\n`)
  }
  if (Array.isArray(command) && command[0] === "git" && process.env.CELL_TEST_ALL_GIT_CHILDREN) {
    const env = options?.env ?? process.env
    appendFileSync(process.env.CELL_TEST_ALL_GIT_CHILDREN, `${JSON.stringify({
      args: command, nonceEnv: env.SC_FORWARD_NONCE ?? null, identityPresent: !!env.SC_IDENTITY_JSON,
      privateKeyPresent: !!env.SHITRAT_GITHUB_PRIVATE_KEY,
      passPresent: !!env.SC_PASS_FILE,
      inheritedTokenPresent: [env.SHITRAT_PUSH_TOKEN, env.SHITRAT_GITHUB_TOKEN, env.GITHUB_TOKEN, env.GH_TOKEN].includes("inherited-fixture-token"),
      traceKeys: Object.keys(env).filter((key) => key.startsWith("GIT_TRACE") || key === "GIT_CURL_VERBOSE" || key === "GIT_REDACT_COOKIES"),
    })}\n`)
  }
  if (Array.isArray(command) && command[0] === "git" && (options?.env?.GIT_CONFIG_COUNT === "3" || !!options?.env?.SHITRAT_PUSH_TOKEN) && process.env.CELL_TEST_GIT_CHILDREN) {
    const env = options.env
    appendFileSync(process.env.CELL_TEST_GIT_CHILDREN, `${JSON.stringify({
      args: command,
      nonceEnv: env.SC_FORWARD_NONCE ?? null,
      identityPresent: !!env.SC_IDENTITY_JSON,
      privateKeyPresent: !!env.SHITRAT_GITHUB_PRIVATE_KEY,
      traceKeys: Object.keys(env).filter((key) => key.startsWith("GIT_TRACE") || key === "GIT_CURL_VERBOSE" || key === "GIT_REDACT_COOKIES"),
    })}\n`)
  }
  if (Array.isArray(command) && command[0] === "git" && options?.env?.SHITRAT_PUSH_TOKEN && process.env.CELL_TEST_DIRECT_GIT_REMOTE) {
    // Test-only direct transport goes to a local bare fixture, never GitHub.
    const local = command.map((arg) => arg === "https://github.com/example/project.git" ? process.env.CELL_TEST_DIRECT_GIT_REMOTE! : arg)
    return Reflect.apply(spawn, Bun, [[local[0]!, "-c", "protocol.file.allow=always", ...local.slice(1)], options])
  }
  return Reflect.apply(spawn, Bun, args)
}) as typeof Bun.spawn
const original = globalThis.fetch
const replacement: typeof fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input)
  if (url.hostname !== "api.github.com") return original(input, init)
  await appendFile(process.env.CELL_TEST_DIRECT!, `${url.pathname}\n`)
  if (url.pathname === "/app/installations") return Response.json([{ id: 123, account: { login: "example" }, repository_selection: "all", target_type: "Organization" }])
  if (url.pathname === "/app/installations/123/access_tokens") {
    return Response.json({ token: "FAKE-INSTALLATION-TOKEN", expires_at: "2030-01-01T00:00:00Z", permissions: { contents: "write" } })
  }
  return Response.json({ full_name: "example/project", direct: true })
}, { preconnect: original.preconnect })
globalThis.fetch = replacement
