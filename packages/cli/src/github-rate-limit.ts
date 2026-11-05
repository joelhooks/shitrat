// Inspect only rate-limit metadata. Never retain or reflect arbitrary API errors.
export const isGitHubRateLimit = (error: unknown): boolean => {
  const value = typeof error === "object" && error !== null ? error : {}
  const status = "status" in value && typeof value.status === "number" ? value.status : undefined
  if (status === 429) return true
  if (status !== 403) return false
  const response = "response" in value && typeof value.response === "object" && value.response !== null ? value.response : {}
  const headers = "headers" in response && typeof response.headers === "object" && response.headers !== null ? response.headers : {}
  const message = "message" in value && typeof value.message === "string" ? value.message : ""
  return "retry-after" in headers || ("x-ratelimit-remaining" in headers && String(headers["x-ratelimit-remaining"]) === "0") || /secondary rate limit/i.test(message)
}
