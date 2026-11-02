import { describe, expect, test } from "bun:test"
import type { XFetch, XRequest } from "../src/x/client.js"
import { refreshRequest, runRefresh, type RefreshDeps } from "../src/x/oauth2.js"

const reply = (status: number, json: unknown) => ({ status, ok: status >= 200 && status < 300, text: JSON.stringify(json), json, headers: {} })

const harness = (token: { status?: number; json?: unknown } = {}) => {
  const writes: Array<[string, string]> = []
  const requests: XRequest[] = []
  const store: Record<string, string> = {
    x_joelhooks_oauth2_client_id: "cid",
    x_joelhooks_oauth2_client_secret: "csecret",
    x_joelhooks_oauth2_refresh_token: "RT-old",
  }
  const fetch: XFetch = async (request) => {
    requests.push(request)
    if (request.url.endsWith("/oauth2/token")) {
      return reply(token.status ?? 200, token.json ?? { access_token: "AT-new", refresh_token: "RT-new", scope: "dm.read", expires_in: 7200 })
    }
    return reply(200, { data: { id: "42", username: "joelhooks" } })
  }
  const deps: RefreshDeps = {
    readSecret: async (name) => store[name],
    writeSecret: async (name, value) => {
      writes.push([name, value])
    },
    fetch,
  }
  return { deps, writes, requests }
}

describe("refreshRequest", () => {
  test("sends grant_type=refresh_token with Basic for a confidential client", () => {
    const request = refreshRequest({ refreshToken: "RT", clientId: "cid", clientSecret: "s" })
    const body = new URLSearchParams(String(request.body))
    expect(body.get("grant_type")).toBe("refresh_token")
    expect(body.get("refresh_token")).toBe("RT")
    expect(request.headers?.Authorization).toBe(`Basic ${Buffer.from("cid:s").toString("base64")}`)
  })
})

describe("runRefresh", () => {
  test("writes the rotated refresh token before the access token and never returns values", async () => {
    const h = harness()
    const result = await runRefresh({ account: "joelhooks" }, h.deps)
    expect(h.writes).toEqual([
      ["x_joelhooks_oauth2_refresh_token", "RT-new"],
      ["x_joelhooks_oauth2_access_token", "AT-new"],
    ])
    expect(result.rotated).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(/AT-new|RT-new|RT-old/)
  })

  test("keeps the refresh token when X does not rotate it", async () => {
    const h = harness({ json: { access_token: "AT-new", expires_in: 7200 } })
    const result = await runRefresh({ account: "joelhooks" }, h.deps)
    expect(h.writes).toEqual([["x_joelhooks_oauth2_access_token", "AT-new"]])
    expect(result.rotated).toBe(false)
  })

  test("a rejected refresh writes nothing and makes one request", async () => {
    const h = harness({ status: 400, json: { error: "invalid_request" } })
    await expect(runRefresh({ account: "joelhooks" }, h.deps)).rejects.toMatchObject({ code: "X_REFRESH_FAILED" })
    expect(h.writes).toEqual([])
    expect(h.requests.filter((r) => r.url.endsWith("/oauth2/token")).length).toBe(1)
  })

  test("a malformed response writes nothing", async () => {
    const h = harness({ json: { refresh_token: "RT-new" } })
    await expect(runRefresh({ account: "joelhooks" }, h.deps)).rejects.toMatchObject({ code: "X_TOKEN_MALFORMED" })
    expect(h.writes).toEqual([])
  })
})
