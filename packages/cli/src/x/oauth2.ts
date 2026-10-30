import { createHash, randomBytes } from "node:crypto"
import { oauth2SecretNames } from "./accounts.js"
import { readJsonField, type XFetch, type XRequest } from "./client.js"

// dm.read is the reason this flow exists, and bookmark.read feeds the bookmark pilot.
// The write scopes keep the existing media upload and article commands working after a re-consent.
export const DEFAULT_SCOPES = [
  "tweet.read",
  "users.read",
  "dm.read",
  "offline.access",
  "tweet.write",
  "media.write",
  "bookmark.read",
] as const

export const DEFAULT_REDIRECT_URI = "http://127.0.0.1:8721/callback"

const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize"
const TOKEN_URL = "https://api.x.com/2/oauth2/token"

const base64Url = (bytes: Buffer): string =>
  bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

export const challengeFor = (verifier: string): string =>
  base64Url(createHash("sha256").update(verifier).digest())

export interface Pkce {
  readonly verifier: string
  readonly challenge: string
  readonly state: string
}

export const createPkce = (): Pkce => {
  const verifier = base64Url(randomBytes(48))
  return { verifier, challenge: challengeFor(verifier), state: base64Url(randomBytes(24)) }
}

export const authorizeUrl = (input: {
  readonly clientId: string
  readonly redirectUri: string
  readonly scopes: readonly string[]
  readonly pkce: Pkce
}): string => {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: input.scopes.join(" "),
    state: input.pkce.state,
    code_challenge: input.pkce.challenge,
    code_challenge_method: "S256",
  })
  return `${AUTHORIZE_URL}?${params.toString()}`
}

// Confidential clients authenticate with Basic; public clients send client_id in the body.
export const tokenRequest = (input: {
  readonly code: string
  readonly verifier: string
  readonly clientId: string
  readonly clientSecret?: string | undefined
  readonly redirectUri: string
}): XRequest => {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
    client_id: input.clientId,
  })
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" }
  if (input.clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString("base64")}`
  }
  return { method: "POST", url: TOKEN_URL, headers, body: body.toString() }
}

export interface TokenSet {
  readonly accessToken: string
  readonly refreshToken: string
  readonly scopes: readonly string[]
  readonly expiresIn?: number | undefined
}

export class XAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export const parseTokenResponse = (payload: unknown): TokenSet => {
  const accessToken = readJsonField(payload, ["access_token"])
  const refreshToken = readJsonField(payload, ["refresh_token"])
  const scope = readJsonField(payload, ["scope"])
  const expiresIn = readJsonField(payload, ["expires_in"])
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new XAuthError("X_TOKEN_MALFORMED", "Token response has no access_token.")
  }
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    throw new XAuthError("X_NO_REFRESH_TOKEN", "Token response has no refresh_token. Was offline.access granted?")
  }
  return {
    accessToken,
    refreshToken,
    scopes: typeof scope === "string" ? scope.split(/\s+/).filter(Boolean) : [],
    expiresIn: typeof expiresIn === "number" ? expiresIn : undefined,
  }
}

export const missingScopes = (granted: readonly string[], wanted: readonly string[]): string[] =>
  wanted.filter((scope) => !granted.includes(scope))

export interface Callback {
  readonly code?: string | undefined
  readonly state?: string | undefined
  readonly error?: string | undefined
}

export const parseCallback = (url: string): Callback => {
  const params = new URL(url).searchParams
  return {
    code: params.get("code") ?? undefined,
    state: params.get("state") ?? undefined,
    error: params.get("error") ?? undefined,
  }
}

export interface AuthDeps {
  readonly readSecret: (name: string) => Promise<string | undefined>
  readonly writeSecret: (name: string, value: string) => Promise<void>
  readonly fetch: XFetch
  readonly openUrl: (url: string) => Promise<void>
  readonly waitForCallback: () => Promise<Callback>
  readonly pkce?: Pkce
}

export interface AuthResult {
  readonly user: { readonly id: unknown; readonly username: unknown }
  readonly scopes: readonly string[]
  readonly written: readonly string[]
}

export const runAuth = async (
  input: { readonly account: string; readonly redirectUri: string; readonly scopes: readonly string[] },
  deps: AuthDeps,
): Promise<AuthResult> => {
  const names = oauth2SecretNames(input.account)
  const clientId = await deps.readSecret(names.clientId)
  if (!clientId) throw new XAuthError("MISSING_SECRET", `Missing required secret: ${names.clientId}`)
  const clientSecret = await deps.readSecret(names.clientSecret)
  const pkce = deps.pkce ?? createPkce()

  await deps.openUrl(authorizeUrl({ clientId, redirectUri: input.redirectUri, scopes: input.scopes, pkce }))
  const callback = await deps.waitForCallback()
  if (callback.error) throw new XAuthError("X_AUTH_DENIED", `X returned error=${callback.error}.`)
  if (callback.state !== pkce.state) throw new XAuthError("X_STATE_MISMATCH", "Callback state does not match.")
  if (!callback.code) throw new XAuthError("X_NO_CODE", "Callback has no code.")

  const response = await deps.fetch(
    tokenRequest({ code: callback.code, verifier: pkce.verifier, clientId, clientSecret, redirectUri: input.redirectUri }),
  )
  if (!response.ok) {
    throw new XAuthError("X_TOKEN_EXCHANGE_FAILED", `Token exchange returned ${response.status}: ${response.text.slice(0, 300)}`)
  }
  const tokens = parseTokenResponse(response.json)
  const missing = missingScopes(tokens.scopes, input.scopes)
  if (missing.length > 0) {
    throw new XAuthError("X_SCOPE_MISSING", `Granted token lacks: ${missing.join(", ")}. Nothing was written.`)
  }

  // Confirm the identity before touching the store, so a wrong account never overwrites.
  const me = await deps.fetch({
    method: "GET",
    url: "https://api.x.com/2/users/me",
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  })
  if (!me.ok) throw new XAuthError("X_ME_FAILED", `users/me returned ${me.status} with the new token. Nothing was written.`)
  const username = readJsonField(me.json, ["data", "username"])
  if (typeof username !== "string" || username.toLowerCase() !== input.account.replace(/^@/, "").toLowerCase()) {
    throw new XAuthError("X_WRONG_ACCOUNT", `Authorized @${String(username)}, expected @${input.account}. Nothing was written.`)
  }

  // The refresh token is the one that can't be recovered without a browser, so it goes first.
  await deps.writeSecret(names.refreshToken, tokens.refreshToken)
  await deps.writeSecret(names.accessToken, tokens.accessToken)

  return {
    user: { id: readJsonField(me.json, ["data", "id"]), username },
    scopes: tokens.scopes,
    written: [names.refreshToken, names.accessToken],
  }
}
