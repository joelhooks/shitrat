import { Effect } from "effect"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { readSecret } from "../secrets.js"
import { annotateInterest, readInterestMap } from "./interest-map.js"

const FRONT_API_BASE = "https://api2.frontapp.com"
const FRONT_SECRET = process.env.SHITRAT_FRONT_SECRET_NAME ?? "shitrat_front_private"
const JOEL_COMBINED_PROFILE_ID = "joel-combined" as const

type FrontInboxLane = { laneId: string; label: string }
type FrontInboxProfile = {
  profileId: typeof JOEL_COMBINED_PROFILE_ID
  providerId: "front"
  lanes: FrontInboxLane[]
  excludeLanes: string[]
}

type RateLimitState = {
  limit?: string | undefined
  remaining?: string | undefined
  reset?: string | undefined
  burstLimit?: string | undefined
  burstRemaining?: string | undefined
  retryAfter?: string | undefined
  frontTier?: string | undefined
  cooldownUntil?: string | undefined
}

type RequestReceipt = {
  name: string
  url: string
  startedAt: string
  completedAt: string
  httpCode: number
  rateLimit: RateLimitState
  bodyPath: string
}

export type InboxPullEvent = Record<string, unknown>

type EventSink = (event: InboxPullEvent) => Promise<void>

const noopEventSink: EventSink = async () => {}

type SnapshotItem = {
  providerId: "front"
  laneId: string
  laneLabel: string
  itemId: string
  threadId: string
  subject?: string | undefined
  sender?: { name?: string | undefined; email?: string | undefined } | undefined
  status?: string | undefined
  statusCategory?: string | undefined
  assignedTo?: string | undefined
  createdAt?: string | undefined
  updatedAt?: string | undefined
  latestMessageId?: string | undefined
  latestMessageAt?: string | undefined
  url: string
}

type LanePageState = {
  laneId: string
  laneLabel: string
  pagesFetched: number
  itemsFetched: number
  stoppedBecause: "complete" | "window_exhausted" | "request_budget" | "page_cap" | "rate_limited"
  nextPageUrl?: string | undefined
  oldestLatestMessageAt?: string | undefined
}

type Snapshot = {
  schemaVersion: 1
  kind: "shitrat.inbox.front.metadata-snapshot"
  profileId: typeof JOEL_COMBINED_PROFILE_ID
  generatedAt: string
  metadataOnly: true
  window: { since?: string | undefined; sinceHours?: number | undefined }
  requestBudget: { max: number; used: number; remaining: number }
  lanes: FrontInboxLane[]
  excludeLanes: readonly string[]
  lanePages: LanePageState[]
  items: SnapshotItem[]
  receipts: RequestReceipt[]
  rateLimit: RateLimitState
  cooldownUntil?: string | undefined
  errors: string[]
}

const nowIso = () => new Date().toISOString()
const dataRoot = () => path.join(homedir(), ".shitrat", "inbox")
const profileRoot = () => path.join(dataRoot(), JOEL_COMBINED_PROFILE_ID)
const frontRoot = () => path.join(dataRoot(), "front")
const profileConfigPath = () => path.join(profileRoot(), "profile.json")
const compactTimestamp = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")

const ensureDirs = async () => {
  await mkdir(path.join(profileRoot(), "snapshots"), { recursive: true })
  await mkdir(path.join(profileRoot(), "receipts"), { recursive: true })
  await mkdir(frontRoot(), { recursive: true })
}

const readProfile = async (): Promise<FrontInboxProfile> => {
  const configured = process.env.SHITRAT_FRONT_PROFILE_JSON
  const raw = configured ?? await readFile(profileConfigPath(), "utf8")
  const profile = JSON.parse(raw) as FrontInboxProfile
  if (profile.profileId !== JOEL_COMBINED_PROFILE_ID || profile.providerId !== "front" || !Array.isArray(profile.lanes)) {
    throw new Error(`Invalid Front inbox profile config at ${configured ? "SHITRAT_FRONT_PROFILE_JSON" : profileConfigPath()}`)
  }
  return { ...profile, excludeLanes: Array.isArray(profile.excludeLanes) ? profile.excludeLanes : [] }
}

const readCooldown = async (): Promise<{ cooldownUntil?: string } | null> => {
  const cooldownPath = path.join(frontRoot(), "cooldown.json")
  if (!existsSync(cooldownPath)) return null
  return JSON.parse(await readFile(cooldownPath, "utf8")) as { cooldownUntil?: string }
}

const isCoolingDown = (cooldown: { cooldownUntil?: string } | null) => {
  if (!cooldown?.cooldownUntil) return false
  return new Date(cooldown.cooldownUntil).getTime() > Date.now()
}

const writeJson = async (filePath: string, value: unknown) => {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

const headerValue = (headers: Headers, name: string) => headers.get(name) ?? undefined

const rateLimitFromHeaders = (headers: Headers): RateLimitState => {
  const retryAfter = headerValue(headers, "retry-after")
  const cooldownUntil = retryAfter && /^\d+$/.test(retryAfter)
    ? new Date(Date.now() + Number(retryAfter) * 1000).toISOString()
    : retryAfter
  return {
    limit: headerValue(headers, "x-ratelimit-limit"),
    remaining: headerValue(headers, "x-ratelimit-remaining"),
    reset: headerValue(headers, "x-ratelimit-reset"),
    burstLimit: headerValue(headers, "x-ratelimit-burst-limit"),
    burstRemaining: headerValue(headers, "x-ratelimit-burst-remaining"),
    retryAfter,
    frontTier: headerValue(headers, "x-front-tier"),
    cooldownUntil,
  }
}

const writeCooldown = async (rateLimit: RateLimitState, source: string) => {
  if (!rateLimit.cooldownUntil) return
  await writeJson(path.join(frontRoot(), "cooldown.json"), {
    provider: "front",
    cooldownUntil: rateLimit.cooldownUntil,
    reason: "retry-after-or-429",
    source,
    writtenAt: nowIso(),
  })
}

const frontUrl = (conversationId: string) => `https://app.frontapp.com/open/${conversationId}`

const toIso = (value: unknown): string | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value * 1000).toISOString()
  if (typeof value === "string" && value.length > 0) {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  return undefined
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}

const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const asString = (value: unknown): string | undefined => typeof value === "string" ? value : undefined

const conversationArray = (payload: unknown): Record<string, unknown>[] => {
  const record = asRecord(payload)
  return asArray(record._results ?? record.results ?? record.conversations ?? record.items)
    .map(asRecord)
    .filter((item) => typeof item.id === "string")
}

const nextPageUrl = (payload: unknown): string | undefined => {
  const pagination = asRecord(asRecord(payload)._pagination)
  return asString(pagination.next)
}

const latestMessageId = (conversation: Record<string, unknown>): string | undefined => {
  const links = asRecord(conversation._links)
  const related = asRecord(links.related)
  const last = asString(related.last_message)
  if (!last) return undefined
  const match = last.match(/messages\/([^/?]+)/)
  return match?.[1]
}

const normalizeConversation = (
  lane: FrontInboxLane,
  conversation: Record<string, unknown>,
): SnapshotItem => {
  const id = asString(conversation.id) ?? "unknown"
  const recipient = asRecord(conversation.recipient)
  const assignee = asRecord(conversation.assignee)
  const senderEmail = asString(recipient.handle)
  const senderName = asString(recipient.name)
  return {
    providerId: "front",
    laneId: lane.laneId,
    laneLabel: lane.label,
    itemId: id,
    threadId: id,
    subject: asString(conversation.subject),
    sender: senderEmail || senderName ? { name: senderName, email: senderEmail } : undefined,
    status: asString(conversation.status),
    statusCategory: asString(conversation.status_category),
    assignedTo: asString(assignee.id) ?? asString(assignee.name),
    createdAt: toIso(conversation.created_at),
    updatedAt: toIso(conversation.updated_at),
    latestMessageId: latestMessageId(conversation),
    latestMessageAt: toIso(conversation.waiting_since) ?? toIso(conversation.updated_at),
    url: frontUrl(id),
  }
}

class FrontRateLimitStop extends Error {
  constructor(readonly rateLimit: RateLimitState, message: string) {
    super(message)
  }
}

const frontGet = async (input: {
  token: string
  name: string
  path?: string
  url?: string
  query?: Record<string, string>
  generatedAt: string
  emit?: EventSink | undefined
}): Promise<{ payload: unknown; receipt: RequestReceipt; rateLimit: RateLimitState }> => {
  const url = new URL(input.url ?? `${FRONT_API_BASE}${input.path}`)
  for (const [key, value] of Object.entries(input.query ?? {})) url.searchParams.set(key, value)
  const startedAt = nowIso()
  await input.emit?.({ type: "provider.request", provider: "front", name: input.name, url: url.toString(), startedAt })
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${input.token}`,
      Accept: "application/json",
    },
  })
  const completedAt = nowIso()
  const text = await response.text()
  const bodyPath = path.join(profileRoot(), "receipts", `${compactTimestamp(input.generatedAt)}-${input.name}.json`)
  await writeFile(bodyPath, text.length > 0 ? text : "{}\n", "utf8")
  const rateLimit = rateLimitFromHeaders(response.headers)
  const receipt: RequestReceipt = {
    name: input.name,
    url: url.toString(),
    startedAt,
    completedAt,
    httpCode: response.status,
    rateLimit,
    bodyPath,
  }
  await input.emit?.({ type: "provider.rate_limit", provider: "front", name: input.name, httpCode: response.status, rateLimit })
  if (response.status === 429 || rateLimit.retryAfter) {
    await writeCooldown(rateLimit, bodyPath)
    throw new FrontRateLimitStop(rateLimit, `Front stopped ${input.name}: HTTP ${response.status}`)
  }
  if (!response.ok) throw new Error(`Front ${input.name} failed: HTTP ${response.status}`)
  return { payload: text ? JSON.parse(text) : {}, receipt, rateLimit }
}

const latestTime = (item: SnapshotItem): number => {
  const value = item.latestMessageAt ?? item.updatedAt ?? item.createdAt
  if (!value) return 0
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : 0
}

export const frontMetadataSnapshot = (input: {
  limitPerLane: number
  maxRequests: number
  maxPagesPerLane: number
  refresh: boolean
  sinceHours?: number | undefined
  emit?: EventSink | undefined
}) =>
  Effect.gen(function* () {
    yield* Effect.promise(ensureDirs)
    const generatedAt = nowIso()
    const emit = input.emit ?? noopEventSink
    const cooldown = yield* Effect.promise(readCooldown)
    if (isCoolingDown(cooldown)) {
      yield* Effect.promise(() => emit({ type: "run.paused", provider: "front", reason: "cooldown", cooldownUntil: cooldown?.cooldownUntil }))
      return {
        ok: false,
        status: "cooling_down" as const,
        cooldownUntil: cooldown?.cooldownUntil,
        message: "Front cooldown is active; no requests made.",
      }
    }

    const profile = yield* Effect.promise(readProfile)
    yield* Effect.promise(() => emit({ type: "run.started", provider: "front", profileId: profile.profileId, generatedAt, window: { sinceHours: input.sinceHours }, metadataOnly: true }))
    const token = yield* readSecret(FRONT_SECRET)
    const interestMap = yield* Effect.promise(() => readInterestMap())
    const receipts: RequestReceipt[] = []
    const items: SnapshotItem[] = []
    const lanePages: LanePageState[] = []
    const errors: string[] = []
    const since = input.sinceHours ? new Date(Date.now() - input.sinceHours * 60 * 60 * 1000) : undefined
    const sinceMs = since?.getTime()
    let latestRateLimit: RateLimitState = {}
    let stoppedByRateLimit = false

    try {
      for (const lane of profile.lanes) {
        let pageUrl: string | undefined
        let pagesFetched = 0
        let itemsFetched = 0
        let stoppedBecause: LanePageState["stoppedBecause"] = "complete"
        let oldestLatestMessageAt: string | undefined

        while (true) {
          if (receipts.length >= input.maxRequests) {
            stoppedBecause = "request_budget"
            break
          }
          if (pagesFetched >= input.maxPagesPerLane) {
            stoppedBecause = "page_cap"
            break
          }

          const pageNumber = pagesFetched + 1
          const result = yield* Effect.promise(() => frontGet({
            token,
            name: `front-conversations-${lane.laneId}-p${pageNumber}`,
            ...(pageUrl
              ? { url: pageUrl }
              : {
                path: `/inboxes/${lane.laneId}/conversations`,
                query: { limit: String(input.limitPerLane) },
              }),
            generatedAt,
            emit,
          }))
          receipts.push(result.receipt)
          latestRateLimit = result.rateLimit
          pagesFetched += 1

          const pageItems = conversationArray(result.payload).map((conversation) => normalizeConversation(lane, conversation))
          itemsFetched += pageItems.length
          if (pageItems.length > 0) {
            const oldest = pageItems.reduce((candidate, item) => latestTime(item) < latestTime(candidate) ? item : candidate, pageItems[0]!)
            oldestLatestMessageAt = oldest.latestMessageAt ?? oldest.updatedAt ?? oldest.createdAt
          }

          const inWindow = typeof sinceMs === "number"
            ? pageItems.filter((item) => latestTime(item) >= sinceMs)
            : pageItems
          items.push(...inWindow)
          for (const item of inWindow) {
            yield* Effect.promise(() => emit({ type: "item.metadata", provider: "front", laneId: lane.laneId, ...annotateInterest(item, interestMap), item }))
          }

          const pageOldest = pageItems.length > 0 ? Math.min(...pageItems.map(latestTime).filter((time) => time > 0)) : 0
          if (typeof sinceMs === "number" && pageOldest > 0 && pageOldest < sinceMs) {
            stoppedBecause = "window_exhausted"
            pageUrl = nextPageUrl(result.payload)
            break
          }

          pageUrl = nextPageUrl(result.payload)
          if (!pageUrl || pageItems.length === 0) {
            stoppedBecause = "complete"
            break
          }
        }

        const lanePage = {
          laneId: lane.laneId,
          laneLabel: lane.label,
          pagesFetched,
          itemsFetched,
          stoppedBecause,
          nextPageUrl: pageUrl,
          oldestLatestMessageAt,
        }
        lanePages.push(lanePage)
        yield* Effect.promise(() => emit({ type: "checkpoint.saved", provider: "front", profileId: profile.profileId, generatedAt, lanePage, requestBudget: { max: input.maxRequests, used: receipts.length, remaining: Math.max(0, input.maxRequests - receipts.length) } }))

        if (stoppedBecause === "request_budget") {
          errors.push(`request budget exhausted at lane ${lane.laneId}`)
          break
        }
      }
    } catch (error) {
      if (error instanceof FrontRateLimitStop) {
        latestRateLimit = error.rateLimit
        stoppedByRateLimit = true
        errors.push(error.message)
      } else {
        throw error
      }
    }

    if (stoppedByRateLimit && lanePages.length > 0) {
      const last = lanePages[lanePages.length - 1]
      if (last) last.stoppedBecause = "rate_limited"
    }

    const snapshot: Snapshot = {
      schemaVersion: 1,
      kind: "shitrat.inbox.front.metadata-snapshot",
      profileId: profile.profileId,
      generatedAt,
      metadataOnly: true,
      window: { since: since?.toISOString(), sinceHours: input.sinceHours },
      requestBudget: { max: input.maxRequests, used: receipts.length, remaining: Math.max(0, input.maxRequests - receipts.length) },
      lanes: profile.lanes,
      excludeLanes: profile.excludeLanes,
      lanePages,
      items,
      receipts,
      rateLimit: latestRateLimit,
      cooldownUntil: latestRateLimit.cooldownUntil,
      errors,
    }

    const snapshotPath = path.join(profileRoot(), "snapshots", `${compactTimestamp(generatedAt)}.json`)
    const latestPath = path.join(profileRoot(), "latest.json")
    yield* Effect.promise(() => writeJson(snapshotPath, snapshot))
    yield* Effect.promise(() => writeJson(latestPath, snapshot))
    yield* Effect.promise(() => emit({ type: errors.length === 0 ? "run.completed" : "run.partial", provider: "front", profileId: snapshot.profileId, generatedAt, items: snapshot.items.length, requestBudget: snapshot.requestBudget, rateLimit: snapshot.rateLimit, paths: { latest: latestPath, snapshot: snapshotPath }, errors }))

    return {
      ok: errors.length === 0,
      status: errors.length === 0 ? "ready" as const : "partial" as const,
      snapshot: {
        profileId: snapshot.profileId,
        generatedAt: snapshot.generatedAt,
        metadataOnly: true,
        lanes: snapshot.lanes.length,
        items: snapshot.items.length,
        window: snapshot.window,
        requestBudget: snapshot.requestBudget,
        lanePages: snapshot.lanePages,
        rateLimit: snapshot.rateLimit,
        cooldownUntil: snapshot.cooldownUntil,
        errors: snapshot.errors,
      },
      paths: { latest: latestPath, snapshot: snapshotPath },
    }
  })
