import { appendFile } from "node:fs/promises"
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
