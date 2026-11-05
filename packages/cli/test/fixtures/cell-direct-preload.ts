import { appendFile } from "node:fs/promises"
import { appendFileSync } from "node:fs"

const spawn = Bun.spawn
Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
  const [command, options] = args
  if (Array.isArray(command) && command[0] === "git" && options?.env?.GIT_CONFIG_COUNT === "3" && process.env.CELL_TEST_GIT_CHILDREN) {
    const env = options.env
    appendFileSync(process.env.CELL_TEST_GIT_CHILDREN, `${JSON.stringify({
      args: command,
      nonceEnv: env.SC_FORWARD_NONCE ?? null,
      traceKeys: Object.keys(env).filter((key) => key.startsWith("GIT_TRACE") || key === "GIT_CURL_VERBOSE" || key === "GIT_REDACT_COOKIES"),
    })}\n`)
  }
  return Reflect.apply(spawn, Bun, args)
}) as typeof Bun.spawn
const original = globalThis.fetch
const replacement: typeof fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input)
  if (url.hostname !== "api.github.com") return original(input, init)
  await appendFile(process.env.CELL_TEST_DIRECT!, `${url.pathname}\n`)
  if (url.pathname === "/app/installations/123/access_tokens") {
    return Response.json({ token: "FAKE-INSTALLATION-TOKEN", expires_at: "2030-01-01T00:00:00Z", permissions: { contents: "write" } })
  }
  return Response.json({ full_name: "example/project", direct: true })
}, { preconnect: original.preconnect })
globalThis.fetch = replacement
