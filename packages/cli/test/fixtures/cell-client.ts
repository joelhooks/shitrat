#!/usr/bin/env bun
import { appendFile } from "node:fs/promises"
import { createServer } from "node:http"

const args = process.argv.slice(2)
if (process.env.CELL_TEST_ARGV) await appendFile(process.env.CELL_TEST_ARGV, `${JSON.stringify(args)}\n`)
const value = (name: string) => args[args.indexOf(name) + 1]
const origin = process.env.SC_URL!
if (process.env.CELL_TEST_FORWARD_FAIL === "1" && args.includes("forward")) {
  process.stderr.write(process.env.SC_IDENTITY_JSON ?? "")
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
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const forwarded = new Headers(headers)
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined) forwarded.set(name, Array.isArray(value) ? value.join(", ") : value)
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
