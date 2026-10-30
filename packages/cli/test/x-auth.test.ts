import { describe, expect, test } from "bun:test"
import type { XFetch, XRequest } from "../src/x/client.js"
import {
  authorizeUrl,
  challengeFor,
  DEFAULT_SCOPES,
  missingScopes,
  parseCallback,
  parseTokenResponse,
  runAuth,
  tokenRequest,
  type AuthDeps,
  type Callback,
} from "../src/x/oauth2.js"

const pkce = { verifier: "dBjftJeZ4CVP-mJ92IZ7aYF3HMf8V2YKwPDDN0-eGVA", challenge: "", state: "st8" }
pkce.challenge = challengeFor(pkce.verifier)

const reply = (status: number, json: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  text: JSON.stringify(json),
  json,
  headers: {},
})

const tokens = { access_token: "AT-new", refresh_token: "RT-new", scope: DEFAULT_SCOPES.join(" "), expires_in: 7200 }

const harness = (opts: { callback?: Callback; token?: unknown; tokenStatus?: number; username?: string } = {}) => {
  const writes: Array<[string, string]> = []
  const requests: XRequest[] = []
  let opened = ""
  const fetch: XFetch = async (request) => {
    requests.push(request)
    if (request.url.endsWith("/oauth2/token")) return reply(opts.tokenStatus ?? 200, opts.token ?? tokens)
    return reply(200, { data: { id: "42", username: opts.username ?? "joelhooks" } })
  }
  const deps: AuthDeps = {
    readSecret: async (name) =>
      name.endsWith("client_id") ? "cid" : name.endsWith("client_secret") ? "csecret" : undefined,
    writeSecret: async (name, value) => {
      writes.push([name, value])
    },
    fetch,
    openUrl: async (url) => {
      opened = url
    },
    waitForCallback: async () => opts.callback ?? { code: "c0de", state: "st8" },
    pkce,
  }
  return { deps, writes, requests, opened: () => opened }
}

const input = { account: "joelhooks", redirectUri: "http://127.0.0.1:8721/callback", scopes: [...DEFAULT_SCOPES] }

describe("pkce", () => {
  test("matches the RFC 7636 appendix B challenge", () => {
    expect(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    )
  })

  test("authorize URL carries S256 challenge, state and space-joined scopes", () => {
    const url = new URL(authorizeUrl({ clientId: "cid", redirectUri: input.redirectUri, scopes: ["a", "b"], pkce }))
    expect(url.origin + url.pathname).toBe("https://x.com/i/oauth2/authorize")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("code_challenge")).toBe(pkce.challenge)
    expect(url.searchParams.get("state")).toBe("st8")
    expect(url.searchParams.get("scope")).toBe("a b")
  })

  test("default scopes include dm.read and keep the article write scopes", () => {
    expect(DEFAULT_SCOPES).toContain("dm.read")
    expect(DEFAULT_SCOPES).toContain("offline.access")
    expect(DEFAULT_SCOPES).toContain("tweet.write")
    expect(DEFAULT_SCOPES).toContain("media.write")
  })
})

describe("token exchange", () => {
  test("confidential client uses Basic auth and sends the verifier", () => {
    const request = tokenRequest({ code: "c", verifier: "v", clientId: "cid", clientSecret: "s", redirectUri: "r" })
    expect(request.headers?.Authorization).toBe(`Basic ${Buffer.from("cid:s").toString("base64")}`)
    const body = new URLSearchParams(String(request.body))
    expect(body.get("grant_type")).toBe("authorization_code")
    expect(body.get("code_verifier")).toBe("v")
  })

  test("public client sends no Authorization header", () => {
    const request = tokenRequest({ code: "c", verifier: "v", clientId: "cid", redirectUri: "r" })
    expect(request.headers?.Authorization).toBeUndefined()
  })

  test("parseTokenResponse requires a refresh token", () => {
    expect(() => parseTokenResponse({ access_token: "a" })).toThrow("refresh_token")
    expect(parseTokenResponse(tokens).scopes).toContain("dm.read")
  })

  test("missingScopes and parseCallback", () => {
    expect(missingScopes(["a"], ["a", "b"])).toEqual(["b"])
    expect(parseCallback("http://127.0.0.1:8721/callback?code=x&state=y")).toEqual({
      code: "x",
      state: "y",
      error: undefined,
    })
  })
})

describe("runAuth", () => {
  test("writes refresh then access after confirming the account", async () => {
    const h = harness()
    const result = await runAuth(input, h.deps)
    expect(h.writes).toEqual([
      ["x_joelhooks_oauth2_refresh_token", "RT-new"],
      ["x_joelhooks_oauth2_access_token", "AT-new"],
    ])
    expect(result.user.username).toBe("joelhooks")
    expect(JSON.stringify(result)).not.toContain("AT-new")
    expect(JSON.stringify(result)).not.toContain("RT-new")
    expect(h.opened()).toContain("code_challenge=")
  })

  const nothingWritten = async (opts: Parameters<typeof harness>[0], code: string) => {
    const h = harness(opts)
    await expect(runAuth(input, h.deps)).rejects.toMatchObject({ code })
    expect(h.writes).toEqual([])
  }

  test("state mismatch writes nothing", () => nothingWritten({ callback: { code: "c", state: "evil" } }, "X_STATE_MISMATCH"))
  test("denied consent writes nothing", () => nothingWritten({ callback: { error: "access_denied" } }, "X_AUTH_DENIED"))
  test("failed exchange writes nothing", () => nothingWritten({ tokenStatus: 400, token: { error: "invalid_request" } }, "X_TOKEN_EXCHANGE_FAILED"))
  test("missing dm.read writes nothing", () =>
    nothingWritten({ token: { ...tokens, scope: "tweet.read users.read offline.access" } }, "X_SCOPE_MISSING"))
  test("wrong account writes nothing", () => nothingWritten({ username: "joelclaw" }, "X_WRONG_ACCOUNT"))
})
