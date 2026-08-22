import { parseArticleLimitHeaders, type ArticleLimitHeaders } from "./limits.js"

export class XApiError extends Error {
  readonly status: number
  readonly body: string
  readonly limits: ArticleLimitHeaders

  constructor(status: number, body: string, limits: ArticleLimitHeaders) {
    super(`X API ${status}`)
    this.status = status
    this.body = body.slice(0, 2000)
    this.limits = limits
  }
}

export interface XRequest {
  readonly method: "GET" | "POST"
  readonly url: string
  readonly headers?: Record<string, string>
  readonly body?: string | FormData
}

export type XFetch = (request: XRequest) => Promise<{
  readonly status: number
  readonly ok: boolean
  readonly text: string
  readonly json: unknown
  readonly headers: Record<string, string>
}>

const headersToMap = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value
  })
  return out
}

export const defaultXFetch: XFetch = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  })
  const text = await response.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return {
    status: response.status,
    ok: response.ok,
    text,
    json,
    headers: headersToMap(response.headers),
  }
}

export const bearerHeaders = (accessToken: string): Record<string, string> => ({
  Authorization: `Bearer ${accessToken}`,
})

export const readJsonField = (payload: unknown, path: readonly string[]): unknown => {
  let current: unknown = payload
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

export const assertOk = (
  response: { status: number; ok: boolean; text: string; headers: Record<string, string> },
): void => {
  if (response.ok) return
  throw new XApiError(response.status, response.text, parseArticleLimitHeaders(response.headers))
}
