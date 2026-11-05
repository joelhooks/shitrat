#!/usr/bin/env bun
import { appendFile } from "node:fs/promises"
import { createServer } from "node:http"

const args = process.argv.slice(2)
if (process.env.CELL_TEST_ARGV) await appendFile(process.env.CELL_TEST_ARGV, `${JSON.stringify(args)}\n`)
const value = (name: string) => args[args.indexOf(name) + 1]
const origin = process.env.SC_URL!
const nonce = process.env.SC_FORWARD_NONCE
if (process.env.CELL_TEST_NONCES) await appendFile(process.env.CELL_TEST_NONCES, `${JSON.stringify({ command: args[0], nonce: nonce ?? null })}\n`)
if (process.env.CELL_TEST_FORWARD_FAIL === "1" && args.includes("forward")) {
  process.stdout.write(nonce ?? "")
  process.stderr.write((nonce ?? "") + (process.env.SC_IDENTITY_JSON ?? ""))
  process.exit(3)
}
const headers = { "x-sc-auth": "fixture-caller-token" }
if (args.includes("describe")) {
  const response = await fetch(`${origin}/v1/describe?name=shitrat-github`, { headers, redirect: "manual" })
  process.exit(response.ok ? 0 : 1)
}
if (args.includes("forward")) {
  const listen = value("--listen")!
  const port = Number(listen.split(":")[1])
  const host = value("--upstream-host")!
  const server = createServer(async (request, response) => {
    try {
      const token = request.headers["x-sc-forward-token"]
      if (process.env.CELL_TEST_FORWARD_REQUESTS) await appendFile(process.env.CELL_TEST_FORWARD_REQUESTS, `${JSON.stringify({ token, nonce })}\n`)
      if (!nonce || token !== nonce || process.env.CELL_TEST_NONCE_REFUSAL === "1") {
        response.writeHead(403, { "content-type": "application/json" })
        response.end(JSON.stringify({ what: "forward nonce refused", why: "This listener requires a matching per-run nonce.", next: "Send the x-sc-forward-token header with this run's SC_FORWARD_NONCE." }))
        return
      }
      if (process.env.CELL_TEST_ECHO_NONCE === "1") {
        response.writeHead(400, { "content-type": "application/json", "x-sc-forward-token": nonce, "x-echo": nonce })
        response.end(JSON.stringify({ headers: { "x-sc-forward-token": nonce } }))
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const forwarded = new Headers(headers)
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined && !name.startsWith("x-sc-")) forwarded.set(name, Array.isArray(value) ? value.join(", ") : value)
      }
      forwarded.set("host", new URL(origin).host)
      const upstream = await fetch(`${origin}/v1/u/${host}${request.url}`, {
        method: request.method ?? "GET",
        headers: forwarded,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : Buffer.concat(chunks),
        redirect: "manual",
      })
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers))
      response.end(Buffer.from(await upstream.arrayBuffer()))
    } catch {
      response.writeHead(502)
      response.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve))
  process.stderr.write(`sc forward listening on 127.0.0.1:${port}\n`)
} else process.exit(2)
