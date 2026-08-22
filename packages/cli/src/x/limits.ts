export interface ArticleLimitHeaders {
  readonly userLimit?: number
  readonly userRemaining?: number
  readonly userResetAt?: string
  readonly rateRemaining?: number
  readonly exhausted: boolean
}

const readNumber = (headers: Record<string, string>, name: string): number | undefined => {
  const raw = headers[name] ?? headers[name.toLowerCase()]
  if (raw === undefined || raw === "") return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

export const normalizeHeaderMap = (headers: Headers | Record<string, string>): Record<string, string> => {
  if (!(headers instanceof Headers)) {
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value
    return out
  }
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value
  })
  return out
}

export const parseArticleLimitHeaders = (
  headers: Headers | Record<string, string>,
): ArticleLimitHeaders => {
  const map = normalizeHeaderMap(headers)
  const userLimit = readNumber(map, "x-user-limit-24hour-limit")
  const userRemaining = readNumber(map, "x-user-limit-24hour-remaining")
  const resetEpoch = readNumber(map, "x-user-limit-24hour-reset")
  const rateRemaining = readNumber(map, "x-rate-limit-remaining")
  return {
    ...(userLimit !== undefined ? { userLimit } : {}),
    ...(userRemaining !== undefined ? { userRemaining } : {}),
    ...(resetEpoch !== undefined ? { userResetAt: new Date(resetEpoch * 1000).toISOString() } : {}),
    ...(rateRemaining !== undefined ? { rateRemaining } : {}),
    exhausted: userRemaining === 0,
  }
}
