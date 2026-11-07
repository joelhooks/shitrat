import { createServer } from "node:net"
import { AsyncLocalStorage } from "node:async_hooks"
import { constants } from "node:fs"
import { open, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { trustedExecutable, secretsExecutable } from "./executable-trust.js"
import { leaseEnvironment } from "./child-environment.js"

export class GitHubCellError extends Error {
  readonly code = "GITHUB_CELL_ERROR"
  constructor(readonly reason: "configuration" | "client" | "refused" | "unsupported", detail?: string) {
    super(detail ? `Cell route failed (${reason}). ${detail}` : `Cell route failed (${reason}). Check SC_URL, SC_AUDIENCE, the sc executable, caller identity/pass and SHITRAT_CELL_CALLER_DOCUMENT_FILE. ${process.env.SHITRAT_GITHUB_VIA === undefined || process.env.SHITRAT_GITHUB_VIA === "auto" ? "Auto mode falls back to direct on setup failures only." : "No automatic direct-key fallback; SHITRAT_GITHUB_CELL_FALLBACK=direct explicitly permits setup fallback."}`)
  }
}

// Only these bounded reasons may describe pre-request setup failures. New
// reasons must be reviewed explicitly instead of inheriting fallback permission.
const setupFallbackReasons: ReadonlySet<GitHubCellError["reason"]> = new Set(["configuration", "client", "refused"])

export const logGitHubPath = (path: "cell" | "direct", reason: string): void => {
  process.stderr.write(`${JSON.stringify({ event: "github-route", path, reason })}\n`)
}

const autoRoute = (): boolean => process.env.SHITRAT_GITHUB_VIA === undefined || process.env.SHITRAT_GITHUB_VIA === "auto"
const setupFallbackEnabled = (): boolean => autoRoute() || process.env.SHITRAT_GITHUB_CELL_FALLBACK === "direct"

export const githubViaCell = (): boolean => {
  const via = process.env.SHITRAT_GITHUB_VIA
  if (via !== undefined && via !== "auto" && via !== "direct" && via !== "cell") throw new GitHubCellError("configuration")
  const fallback = process.env.SHITRAT_GITHUB_CELL_FALLBACK
  if (fallback !== undefined && fallback !== "direct") throw new GitHubCellError("configuration")
  // An explicit identity plus URL expresses cell intent even outside Rat King.
  // RATKING_NAME=off is an explicit auto-mode opt-out, including that case.
  return autoRoute()
    ? process.env.RATKING_NAME !== "off" && (!!process.env.RATKING_NAME || !!(process.env.SC_URL && (process.env.SC_IDENTITY_JSON || process.env.SHITRAT_CELL_IDENTITY_FILE)))
    : via !== "direct"
}

const clientEnvironment = (): NodeJS.ProcessEnv => {
  const env = { ...process.env }
  for (const key of ["SHITRAT_GITHUB_PRIVATE_KEY", "SHITRAT_PUSH_TOKEN", "SHITRAT_GITHUB_TOKEN", "SC_FORWARD_NONCE"]) delete env[key]
  return env
}

const objectValue = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new GitHubCellError("configuration")
  return Object.fromEntries(Object.entries(value))
}

export const verifyProtectedFile = (stat: { isFile(): boolean; mode: number; uid: number }): void => {
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw new GitHubCellError("configuration")
}

const protectedIdentity = async (file: string): Promise<string> => {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    verifyProtectedFile(stat)
    return await handle.readFile("utf8")
  } finally {
    await handle.close()
  }
}

export const verifyCallerDocument = (identityJson: string, callerDocument: unknown): void => {
  const identity = objectValue(JSON.parse(identityJson))
  const document = objectValue(callerDocument)
  const signing = objectValue(identity.signing)
  if (typeof identity.did !== "string" || identity.did !== document.id || signing.kty !== "EC" || signing.crv !== "P-256") {
    throw new GitHubCellError("configuration")
  }
  const kid = identity.kid ?? "#atproto"
  if (typeof kid !== "string" || !Array.isArray(document.verificationMethod) || !Array.isArray(document.authentication)) {
    throw new GitHubCellError("configuration")
  }
  const id = kid.startsWith("#") ? `${identity.did}${kid}` : kid
  const method = document.verificationMethod.map(objectValue).find((entry) => entry.id === id)
  if (!method || method.controller !== identity.did || !document.authentication.includes(id)) throw new GitHubCellError("configuration")
  const publicKey = objectValue(method.publicKeyJwk)
  if ("d" in publicKey || !["kty", "crv", "x", "y"].every((field) => typeof signing[field] === "string" && signing[field] === publicKey[field])) {
    throw new GitHubCellError("configuration")
  }
}

export const deriveCallerDocument = (identityJson: string): unknown => {
  const identity = objectValue(JSON.parse(identityJson))
  const signing = objectValue(identity.signing)
  const kid = identity.kid ?? "#atproto"
  if (typeof identity.did !== "string" || typeof kid !== "string" || !kid.startsWith("#")) throw new GitHubCellError("configuration")
  const id = `${identity.did}${kid}`
  // This derived document is a consistency self-check, not an independent pin.
  // Project public fields explicitly. Never spread a private JWK into this document.
  const publicKeyJwk = { kty: signing.kty, crv: signing.crv, x: signing.x, y: signing.y }
  const document = { id: identity.did, verificationMethod: [{ id, controller: identity.did, publicKeyJwk }], authentication: [id] }
  verifyCallerDocument(identityJson, document)
  return document
}

type ClientConfiguration = { args: string[]; env: NodeJS.ProcessEnv }

const autoClientConfiguration = async (): Promise<ClientConfiguration> => {
  try {
    let local: Record<string, unknown> = {}
    try {
      local = objectValue(JSON.parse(await protectedIdentity(process.env.SHITRAT_CELL_CONFIG ?? join(homedir(), ".config/shitrat/cell.json"))))
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
    }
    const url = process.env.SC_URL ?? local.url
    const audience = process.env.SC_AUDIENCE ?? local.audience
    if (typeof url !== "string" || !url || typeof audience !== "string" || !audience) throw new GitHubCellError("configuration")
    const bin = trustedExecutable(process.env.SHITRAT_SC_BIN ?? local.scBin)
    const env = clientEnvironment()
    const file = process.env.SHITRAT_CELL_IDENTITY_FILE
    if (file && process.env.SC_IDENTITY_JSON) throw new GitHubCellError("configuration")
    let identity = file ? await protectedIdentity(file) : process.env.SC_IDENTITY_JSON
    if (!identity) {
      const name = process.env.RATKING_NAME
      if (!name || !/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(name)) throw new GitHubCellError("configuration")
      const secretsBin = secretsExecutable(local.secretsBin)
      const proc = Bun.spawn([secretsBin, "lease", `rat_king_fleet_agent_${name.replaceAll("/", ".")}_identity`, "--client-id", "shitrat-cell", "--ttl", "5m"], {
        env: leaseEnvironment(), detached: true, stdin: "ignore", stdout: "pipe", stderr: "ignore",
      })
      let timer: ReturnType<typeof setTimeout> | undefined
      let timedOut = false
      try {
        const [value, exit] = await Promise.race([
          Promise.all([new Response(proc.stdout).text(), proc.exited]),
          new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(new GitHubCellError("configuration")) }, 10_000) }),
        ])
        if (exit !== 0 || !value.trim()) throw new GitHubCellError("configuration")
        identity = value.trim()
      } finally {
        clearTimeout(timer)
        // A grandchild may outlive the lease executable while holding stdout.
        // Kill only this detached, owned process group; never wait on that pipe.
        if (timedOut || proc.exitCode === null) {
          try { process.kill(-proc.pid, "SIGKILL") } catch { try { proc.kill("SIGKILL") } catch { /* Already exited. */ } }
        }
      }
    }
    const document = process.env.SHITRAT_CELL_CALLER_DOCUMENT_FILE
    verifyCallerDocument(identity, document ? JSON.parse(await readFile(document, "utf8")) : deriveCallerDocument(identity))
    env.SC_URL = url
    env.SC_AUDIENCE = audience
    env.SC_IDENTITY_JSON = identity
    return { args: [bin], env }
  } catch {
    // Never reflect parser errors, secret CLI output, or identity material.
    throw new GitHubCellError("configuration")
  }
}

const clientConfiguration = async (): Promise<ClientConfiguration> => {
  if (autoRoute()) {
    const command = commandForwards.getStore()
    return command ? command.configuration ??= autoClientConfiguration() : autoClientConfiguration()
  }
  try {
    if (!process.env.SC_URL || !process.env.SC_AUDIENCE) throw new GitHubCellError("configuration")
    const file = process.env.SHITRAT_CELL_IDENTITY_FILE
    if ((!file && !process.env.SC_IDENTITY_JSON) || (file && process.env.SC_IDENTITY_JSON)) throw new GitHubCellError("configuration")
    const env = clientEnvironment()
    const identity = file ? await protectedIdentity(file) : process.env.SC_IDENTITY_JSON
    if (!identity) throw new GitHubCellError("configuration")
    const document = process.env.SHITRAT_CELL_CALLER_DOCUMENT_FILE
    if (document) verifyCallerDocument(identity, JSON.parse(await readFile(document, "utf8")))
    else if (!env.SC_PASS_FILE) throw new GitHubCellError("configuration")
    env.SC_IDENTITY_JSON = identity
    return { args: [process.env.SHITRAT_SC_BIN ?? "sc"], env }
  } catch {
    throw new GitHubCellError("configuration")
  }
}

export const cellPlaceholder = (owner: string): string => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(owner)) throw new GitHubCellError("configuration")
  return `{{secret:shitrat-github/${owner}}}`
}

export const isCellPlaceholder = (value: string): boolean =>
  /^\{\{secret:shitrat-github\/[a-zA-Z0-9][a-zA-Z0-9-]*\}\}$/.test(value)

const requireBun = (): void => {
  if (typeof Bun === "undefined") throw new GitHubCellError("configuration", "The cell route needs Bun. Run ShitRat with Bun or explicitly select the direct route.")
}

export const prepareCell = async (owner: string): Promise<void> => {
  requireBun()
  cellPlaceholder(owner)
  const config = await clientConfiguration()
  const args = [...config.args, "describe", "shitrat-github"]
  try {
    const proc = Bun.spawn(args, { env: config.env, stdin: "ignore", stdout: "ignore", stderr: "ignore" })
    const timer = setTimeout(() => proc.kill("SIGKILL"), autoRoute() ? 8_000 : 65_000)
    const exit = await proc.exited.finally(() => clearTimeout(timer))
    if (exit !== 0) throw new GitHubCellError(exit === 1 ? "refused" : "client")
  } catch (error) {
    throw error instanceof GitHubCellError ? error : new GitHubCellError("client")
  }
}

export const selectGitHubPath = async <T>(input: {
  readonly cell: () => Promise<T>
  readonly direct: () => Promise<T>
}): Promise<T> => withCellCommand(async () => {
  if (!githubViaCell()) {
    decideGitHubPath("direct", "selected")
    return input.direct()
  }
  // Explicit cell keeps its fail-closed compatibility gate outside fallback.
  if (!autoRoute()) {
    try { await requireForwardNonceSupport() } catch (error) {
      decideGitHubPath("cell", "requested")
      throw error
    }
  }
  try {
    if (autoRoute()) {
      await clientConfiguration()
      await requireForwardNonceSupport()
    }
    const result = await input.cell()
    decideGitHubPath("cell", "requested")
    return result
  } catch (error) {
    // Fallback is legal only for bounded setup failures before *any* forwarded
    // operation in this command. Never replay an uncertain write over direct.
    if (!setupFallbackEnabled() ||
      commandForwards.getStore()?.phase !== "setup" ||
      !(error instanceof GitHubCellError) || !setupFallbackReasons.has(error.reason)) {
      decideGitHubPath("cell", "requested")
      throw error
    }
    decideGitHubPath("direct", `cell-${error.reason}`)
    return input.direct()
  }
})

const decideGitHubPath = (path: "cell" | "direct", reason: string): void => {
  const command = commandForwards.getStore()
  if (command) command.route = path
  logGitHubPath(path, reason)
}

export const requireDirectGitHub = (): void => {
  const command = commandForwards.getStore()
  if (command?.route === "direct" && command.phase === "setup") return
  if (!githubViaCell()) {
    decideGitHubPath("direct", autoRoute() ? "app-operation" : "selected")
    return
  }
  if (!setupFallbackEnabled() || commandForwards.getStore()?.phase !== "setup") {
    decideGitHubPath("cell", "unsupported-app-operation")
    throw new GitHubCellError("unsupported")
  }
  decideGitHubPath("direct", "app-operation")
}

const availablePort = async (): Promise<number> => {
  const server = createServer()
  return new Promise((resolve, reject) => {
    server.once("error", () => reject(new GitHubCellError("client")))
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address !== "string") resolve(address.port)
        else reject(new GitHubCellError("client"))
      })
    })
  })
}

type CellHost = "api.github.com" | "github.com"
type CellForward = { readonly origin: string; readonly proc: Bun.Subprocess; readonly stop: () => Promise<void> }
type CachedForward = Promise<CellForward> | GitHubCellError
// Monotonic fallback boundary: setup -> requested. It never resets in a run.
type CellCommand = { readonly nonce: string; readonly forwards: Map<CellHost, CachedForward>; capability?: Promise<void>; configuration?: Promise<ClientConfiguration>; route?: "cell" | "direct"; phase: "setup" | "requested" }
const commandForwards = new AsyncLocalStorage<CellCommand>()

const probeForwardNonceSupport = async (): Promise<void> => {
  requireBun()
  const unsupported = () => new GitHubCellError("configuration", "sc too old for forward nonce; update sc")
  let proc: Bun.Subprocess<"ignore", "pipe", "ignore">
  try {
    const bin = autoRoute() ? (await clientConfiguration()).args[0]! : process.env.SHITRAT_SC_BIN ?? "sc"
    proc = Bun.spawn([bin, "forward", "--capabilities"], {
      // This probe needs no identity, pass, cell address or nonce.
      env: { PATH: process.env.PATH }, stdin: "ignore", stdout: "pipe", stderr: "ignore",
    })
  } catch {
    throw unsupported()
  }
  const reader = proc.stdout.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      (async () => {
        let output = ""
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          output += new TextDecoder().decode(value)
          if (output.length > 8192) throw unsupported()
        }
        const exit = await proc.exited
        const capability: unknown = JSON.parse(output)
        if (exit !== 0 || typeof capability !== "object" || capability === null || !("forwardNonce" in capability) || capability.forwardNonce !== true) throw unsupported()
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(unsupported()), 3_000) }),
    ])
  } catch {
    throw unsupported()
  } finally {
    clearTimeout(timer)
    proc.kill("SIGKILL")
    await proc.exited
    await reader.cancel().catch(() => {})
  }
}

const requireForwardNonceSupport = (): Promise<void> => {
  const command = commandForwards.getStore()
  if (!command) return probeForwardNonceSupport()
  return command.capability ??= probeForwardNonceSupport()
}

const transportFailure = (error: unknown): Error => {
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    // Retain the kind without reflecting an arbitrary abort reason or request headers.
    return new DOMException(error.name === "AbortError" ? "cell forward request aborted" : "cell forward request timed out", error.name)
  }
  return new GitHubCellError("client")
}

// Lifecycle: absent -> starting (shared promise) -> ready or failed -> stopped.
// Retain failed starts and terminal refusals until command exit: never replay an uncertain operation.
export const withCellCommand = async <T>(run: () => Promise<T>): Promise<T> => {
  if (commandForwards.getStore()) return run()
  const forwards = new Map<CellHost, CachedForward>()
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
  return commandForwards.run({ nonce, forwards, phase: "setup" }, async () => {
    try {
      return await run()
    } finally {
      await Promise.all([...forwards.values()].map(async (forward) => {
        if (forward instanceof GitHubCellError) return
        const ready = await forward.catch(() => undefined)
        await ready?.stop()
      }))
    }
  })
}

const startCellForward = async (host: CellHost, nonce: string): Promise<CellForward> => {
  requireBun()
  await requireForwardNonceSupport()
  const port = await availablePort()
  const config = await clientConfiguration()
  const args = [...config.args, "forward", "--listen", `127.0.0.1:${port}`, "--upstream-host", host]
  let proc
  try {
    proc = Bun.spawn(args, { env: { ...config.env, SC_FORWARD_NONCE: nonce }, stdin: "ignore", stdout: "ignore", stderr: "pipe" })
  } catch {
    throw new GitHubCellError("client")
  }
  const reader = proc.stderr.getReader()
  // Synchronous exit also covers callers that terminate before their finally runs.
  const kill = () => { proc.kill("SIGKILL") }
  process.once("exit", kill)
  const stop = async () => {
    process.off("exit", kill)
    kill()
    await proc.exited
    await reader.cancel().catch(() => {})
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      (async () => {
        let pending = ""
        const expected = `sc forward listening on 127.0.0.1:${port}\n`
        while (true) {
          const { done, value } = await reader.read()
          if (done) throw new GitHubCellError("client")
          pending += new TextDecoder().decode(value)
          if (pending.split("\n").includes(expected.trimEnd())) return
          if (pending.length > 8192) throw new GitHubCellError("client")
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new GitHubCellError("client")), 10_000)
      }),
    ])
    clearTimeout(timer)
    void (async () => { while (!(await reader.read()).done) {} })().catch(() => {})
    return { origin: `http://127.0.0.1:${port}`, proc, stop }
  } catch (error) {
    await stop()
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export const withCellForward = <T>(input: {
  readonly host: CellHost
  readonly run: (origin: string, nonce: string) => Promise<T>
}): Promise<T> => withCellCommand(async () => {
  const command = commandForwards.getStore()
  if (!command) throw new GitHubCellError("client")
  const { forwards, nonce } = command
  let forward = forwards.get(input.host)
  if (!forward) {
    forward = startCellForward(input.host, nonce)
    forwards.set(input.host, forward)
  }
  if (forward instanceof GitHubCellError) throw forward
  const ready = await forward
  // A dead child's port can belong to someone else. Never send credentials or
  // trust a response there, and never restart an uncertain write mid-command.
  if (ready.proc.exitCode !== null || ready.proc.killed) {
    const error = new GitHubCellError("client", "cell forward exited mid-command; rerun")
    forwards.set(input.host, error)
    await ready.stop()
    throw error
  }
  // Both API fetch and smart-HTTP Git cross this boundary. Mark before invoking
  // the transport, even if it fails before a response can prove what happened.
  command.phase = "requested"
  return input.run(ready.origin, nonce)
})

export const cellFetch: typeof fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  let url: URL
  try {
    url = new URL(input instanceof Request ? input.url : input)
  } catch {
    throw new GitHubCellError("unsupported", "The cell route requires an absolute HTTPS api.github.com URL.")
  }
  if (url.protocol !== "https:" || url.hostname !== "api.github.com" || url.port || url.username || url.password) {
    throw new GitHubCellError("unsupported")
  }
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  const authorization = headers.get("authorization") ?? ""
  const placeholder = authorization.replace(/^(?:token|Bearer) /, "")
  if (!isCellPlaceholder(placeholder)) throw new GitHubCellError("configuration")
  headers.set("authorization", `Bearer ${placeholder}`)
  return withCellForward({
    host: "api.github.com",
    run: async (origin, nonce) => {
      headers.set("x-sc-forward-token", nonce)
      const response = await fetch(`${origin}${url.pathname}${url.search}`, {
        ...(input instanceof Request ? { method: input.method, headers: input.headers, body: input.body } : {}),
        ...init,
        headers,
        redirect: "manual",
        signal: init?.signal ?? AbortSignal.timeout(60_000),
      }).catch((error: unknown) => { throw transportFailure(error) })
      const body = await response.arrayBuffer().catch((error: unknown) => { throw transportFailure(error) })
      if (response.status === 403) {
        let refusal: unknown
        try { refusal = JSON.parse(new TextDecoder().decode(body)) } catch { /* Not a forward refusal. */ }
        if (typeof refusal === "object" && refusal !== null && "what" in refusal && refusal.what === "forward nonce refused") {
          const error = new GitHubCellError("client", "cell forward rejected the run nonce; rerun")
          const forwards = commandForwards.getStore()?.forwards
          const forward = forwards?.get("api.github.com")
          forwards?.set("api.github.com", error)
          if (forward && !(forward instanceof GitHubCellError)) await (await forward).stop()
          throw error
        }
      }
      if (response.status >= 300 && response.status < 400) throw new GitHubCellError("refused")
      // Do not expose an echoed transport token to Octokit's responses/errors.
      // latin1 preserves arbitrary bytes while replacing the ASCII nonce.
      const bytes = Buffer.from(body)
      const safeBody = bytes.includes(nonce) ? Buffer.from(bytes.toString("latin1").replaceAll(nonce, "[REDACTED]"), "latin1") : body
      const buffered = new Response(response.status === 204 || response.status === 205 || response.status === 304 ? null : safeBody, {
        status: response.status,
        statusText: response.statusText.replaceAll(nonce, "[REDACTED]"),
        headers: (() => {
          const safe = new Headers(response.headers)
          safe.delete("x-sc-forward-token")
          for (const [name, value] of safe) safe.set(name, value.replaceAll(nonce, "[REDACTED]"))
          return safe
        })(),
      })
      // A constructed Response has url="". Octokit pagination parses response.url,
      // even on a final page. Expose the logical GitHub URL, never the loopback URL.
      Object.defineProperty(buffered, "url", { value: url.href })
      return buffered
    },
  })
}, { preconnect: fetch.preconnect })
