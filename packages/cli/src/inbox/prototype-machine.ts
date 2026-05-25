#!/usr/bin/env bun

// PROTOTYPE — delete or absorb.
// Question: does the provider-neutral inbox lifecycle, request economy,
// cached-thread analysis pack, and approval-gated archive path feel right?
// No live Front calls. No persistence. State is fully surfaced after each action.

import { createActor, setup, assign } from "xstate"
import { createInterface } from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"

type ProviderId = "front:joel" | "github:notifications"
type ItemStatus = "open" | "archived"
type Classification = "deal_with_first" | "aggregate" | "archive" | "unknown"

type InboxItem = {
  providerId: ProviderId
  laneId: string
  itemId: string
  threadId: string
  subject: string
  sender: string
  status: ItemStatus
  latestMessageId: string
  cachedLatestMessageId?: string
}

type InboxThread = {
  providerId: ProviderId
  threadId: string
  latestMessageId: string
  messages: string[]
  fingerprint: string
}

type AnalysisFinding = {
  itemId: string
  providerId: ProviderId
  classification: Classification
  reason: string
  summary?: string
}

type ArchivePlanItem = {
  itemId: string
  providerId: ProviderId
  reason: string
  expected: { status: ItemStatus; latestMessageId: string }
}

type PrototypeContext = {
  profileId: "joel-combined"
  runId: string
  requestBudget: { remaining: number; used: number; max: number }
  cooldownUntil?: string
  items: InboxItem[]
  fetchedThreads: InboxThread[]
  analysisPack: Array<{ item: InboxItem; thread: InboxThread }>
  findings: AnalysisFinding[]
  archivePlan: ArchivePlanItem[]
  archived: ArchivePlanItem[]
  receipts: string[]
  errors: string[]
}

type PrototypeEvent =
  | { type: "start" }
  | { type: "cooldown.detected"; until: string }
  | { type: "cache.loaded" }
  | { type: "metadata.listed"; items: InboxItem[]; requests: number }
  | { type: "threads.fetched"; threads: InboxThread[]; requests: number }
  | { type: "analysis.pack.emitted" }
  | { type: "analysis.findings.ingested"; findings: AnalysisFinding[] }
  | { type: "archive.plan.built" }
  | { type: "archive.approved" }
  | { type: "archive.completed" }
  | { type: "rate_limited"; error: string; until: string }
  | { type: "provider.error"; error: string }
  | { type: "reset" }

const initialContext = (): PrototypeContext => ({
  profileId: "joel-combined",
  runId: `prototype-${new Date().toISOString()}`,
  requestBudget: { remaining: 30, used: 0, max: 30 },
  items: [],
  fetchedThreads: [],
  analysisPack: [],
  findings: [],
  archivePlan: [],
  archived: [],
  receipts: [],
  errors: [],
})

const spendRequests = (context: PrototypeContext, requests: number) => ({
  requestBudget: {
    ...context.requestBudget,
    used: context.requestBudget.used + requests,
    remaining: Math.max(0, context.requestBudget.remaining - requests),
  },
})

const machine = setup({
  types: {} as { context: PrototypeContext; events: PrototypeEvent },
  guards: {
    hasArchivePlan: ({ context }) => context.archivePlan.length > 0,
  },
  actions: {
    setCooldown: assign(({ context, event }) => {
      if (event.type !== "cooldown.detected" && event.type !== "rate_limited") return {}
      return {
        cooldownUntil: event.until,
        receipts: [...context.receipts, `cooldown:${event.until}`],
        errors: event.type === "rate_limited" ? [...context.errors, event.error] : context.errors,
      }
    }),
    loadCacheReceipt: assign(({ context }) => ({
      receipts: [...context.receipts, "cache:loaded ~/.shitrat/inbox/joel-combined/latest.json"],
    })),
    setMetadata: assign(({ context, event }) => {
      if (event.type !== "metadata.listed") return {}
      return {
        ...spendRequests(context, event.requests),
        items: event.items,
        receipts: [...context.receipts, `metadata:${event.items.length} items:${event.requests} request(s)`],
      }
    }),
    setThreads: assign(({ context, event }) => {
      if (event.type !== "threads.fetched") return {}
      return {
        ...spendRequests(context, event.requests),
        fetchedThreads: event.threads,
        receipts: [...context.receipts, `threads:${event.threads.length} fetched:${event.requests} request(s)`],
      }
    }),
    emitAnalysisPack: assign(({ context }) => {
      const threadById = new Map(context.fetchedThreads.map((thread) => [thread.threadId, thread]))
      const analysisPack = context.items
        .map((item) => ({ item, thread: threadById.get(item.threadId) }))
        .filter((entry): entry is { item: InboxItem; thread: InboxThread } => Boolean(entry.thread))
      return {
        analysisPack,
        receipts: [
          ...context.receipts,
          `analysis-pack:${analysisPack.length} cached threads emitted for Pi/Codex specialist`,
        ],
      }
    }),
    ingestFindings: assign(({ context, event }) => {
      if (event.type !== "analysis.findings.ingested") return {}
      return {
        findings: event.findings,
        receipts: [...context.receipts, `findings:${event.findings.length} ingested`],
      }
    }),
    buildArchivePlan: assign(({ context }) => {
      const itemById = new Map(context.items.map((item) => [item.itemId, item]))
      const archivePlan = context.findings
        .filter((finding) => finding.classification === "archive")
        .flatMap((finding): ArchivePlanItem[] => {
          const item = itemById.get(finding.itemId)
          if (!item) return []
          return [{
            itemId: item.itemId,
            providerId: item.providerId,
            reason: finding.reason,
            expected: { status: item.status, latestMessageId: item.latestMessageId },
          }]
        })
      return {
        archivePlan,
        receipts: [...context.receipts, `archive-plan:${archivePlan.length} candidate(s)`],
      }
    }),
    archiveApproved: assign(({ context }) => ({
      receipts: [...context.receipts, `approval:${context.archivePlan.length} archive mutation(s) approved`],
    })),
    archiveCompleted: assign(({ context }) => ({
      archived: context.archivePlan,
      items: context.items.map((item) =>
        context.archivePlan.some((plan) => plan.itemId === item.itemId && plan.providerId === item.providerId)
          ? { ...item, status: "archived" as const }
          : item,
      ),
      receipts: [...context.receipts, `mutations:${context.archivePlan.length} archived concurrency=1`],
    })),
    recordProviderError: assign(({ context, event }) => ({
      errors: event.type === "provider.error" ? [...context.errors, event.error] : context.errors,
    })),
    resetContext: assign(() => initialContext()),
  },
}).createMachine({
  id: "shitrat-inbox-prototype",
  initial: "idle",
  context: initialContext(),
  states: {
    idle: { on: { start: "checkingCooldown", reset: { actions: ["resetContext"] } } },
    checkingCooldown: {
      on: {
        "cooldown.detected": { target: "coolingDown", actions: ["setCooldown"] },
        "cache.loaded": { target: "loadingCache", actions: ["loadCacheReceipt"] },
      },
    },
    coolingDown: { tags: ["blocked"] },
    loadingCache: { on: { "metadata.listed": { target: "listingItems", actions: ["setMetadata"] } } },
    listingItems: { on: { "threads.fetched": { target: "fetchingThreads", actions: ["setThreads"] } } },
    fetchingThreads: {
      on: {
        "analysis.pack.emitted": { target: "awaitingSpecialist", actions: ["emitAnalysisPack"] },
        rate_limited: { target: "rateLimited", actions: ["setCooldown"] },
      },
    },
    awaitingSpecialist: {
      tags: ["waiting-for-agent"],
      on: { "analysis.findings.ingested": { target: "buildingSignalBox", actions: ["ingestFindings"] } },
    },
    buildingSignalBox: { on: { "archive.plan.built": { target: "awaitingApproval", actions: ["buildArchivePlan"] } } },
    awaitingApproval: {
      tags: ["needs-approval"],
      on: {
        "archive.approved": [
          { guard: "hasArchivePlan", target: "archivingApproved", actions: ["archiveApproved"] },
          { target: "done" },
        ],
      },
    },
    archivingApproved: {
      on: {
        "archive.completed": { target: "done", actions: ["archiveCompleted"] },
        rate_limited: { target: "rateLimited", actions: ["setCooldown"] },
        "provider.error": { target: "partial", actions: ["recordProviderError"] },
      },
    },
    rateLimited: { tags: ["blocked"] },
    partial: { tags: ["error"] },
    done: { type: "final" },
  },
})

const sampleItems: InboxItem[] = [
  {
    providerId: "front:joel",
    laneId: "inb_1c70n",
    itemId: "cnv_promo_1",
    threadId: "thr_promo_1",
    subject: "Don’t reach for the takeout apps",
    sender: "hello@g.hellofresh.com",
    status: "open",
    latestMessageId: "msg_promo_2",
    cachedLatestMessageId: "msg_promo_1",
  },
  {
    providerId: "front:joel",
    laneId: "inb_34ocn",
    itemId: "cnv_mercury_1",
    threadId: "thr_mercury_1",
    subject: "Stripe payout of $46,513.60 deposited",
    sender: "notifications@mercury.com",
    status: "open",
    latestMessageId: "msg_mercury_1",
    cachedLatestMessageId: "msg_mercury_1",
  },
  {
    providerId: "front:joel",
    laneId: "inb_3l96v",
    itemId: "cnv_aihero_1",
    threadId: "thr_aihero_1",
    subject: "Re: [aih] Matt Answers Needed for Monday Email (FAQ)",
    sender: "alex@indyhall.org",
    status: "open",
    latestMessageId: "msg_aihero_3",
  },
  {
    providerId: "github:notifications",
    laneId: "joelhooks/shitrat-cli",
    itemId: "gh_17",
    threadId: "thr_gh_17",
    subject: "CI failed on inbox prototype branch",
    sender: "notifications@github.com",
    status: "open",
    latestMessageId: "msg_gh_1",
  },
]

const sampleThreads: InboxThread[] = [
  {
    providerId: "front:joel",
    threadId: "thr_promo_1",
    latestMessageId: "msg_promo_2",
    fingerprint: "sha256:promo",
    messages: ["Limited time meal kit offer. No human ask. No decision."],
  },
  {
    providerId: "front:joel",
    threadId: "thr_aihero_1",
    latestMessageId: "msg_aihero_3",
    fingerprint: "sha256:aihero",
    messages: ["Alex needs Matt answers for Monday FAQ email. Joel is copied for launch decision visibility."],
  },
  {
    providerId: "github:notifications",
    threadId: "thr_gh_17",
    latestMessageId: "msg_gh_1",
    fingerprint: "sha256:gh",
    messages: ["CI failed on main for ShitRat CLI. Needs repo owner attention before merge."],
  },
]

const sampleFindings: AnalysisFinding[] = [
  {
    itemId: "cnv_promo_1",
    providerId: "front:joel",
    classification: "archive",
    reason: "Generic meal-kit promo with no human ask or decision.",
  },
  {
    itemId: "cnv_mercury_1",
    providerId: "front:joel",
    classification: "aggregate",
    reason: "Finance notification stream; summarize as revenue/payout signal, do not treat as individual top item.",
    summary: "Large Stripe payout deposited via Mercury.",
  },
  {
    itemId: "cnv_aihero_1",
    providerId: "front:joel",
    classification: "deal_with_first",
    reason: "Human project thread tied to Monday launch email decisions.",
  },
  {
    itemId: "gh_17",
    providerId: "github:notifications",
    classification: "deal_with_first",
    reason: "CI failure may block active ShitRat inbox work.",
  },
]

const visibleState = (snapshot: ReturnType<typeof actor.getSnapshot>) => ({
  state: snapshot.value,
  tags: [...snapshot.tags],
  context: snapshot.context,
  signalBox: buildSignalBox(snapshot.context),
})

function buildSignalBox(context: PrototypeContext) {
  const byClass = (classification: Classification) =>
    context.findings.filter((finding) => finding.classification === classification)
  return {
    dealWithThisFirst: byClass("deal_with_first"),
    executiveSummary: byClass("aggregate").map((finding) => finding.summary ?? finding.reason),
    archivePlan: context.archivePlan,
    sleepingCandidates: [] as string[],
    unknownNeedsRule: byClass("unknown"),
  }
}

const actor = createActor(machine)
actor.start()

function printState(label: string) {
  console.log(`\n## ${label}`)
  console.log(JSON.stringify(visibleState(actor.getSnapshot()), null, 2))
}

function send(event: PrototypeEvent, label = event.type) {
  actor.send(event)
  printState(label)
}

async function main() {
  console.log("ShitRat inbox state prototype — no Front calls, no persistence. 🐀")
  printState("initial")

  const rl = createInterface({ input, output })
  const answer = await rl.question(
    "\nChoose scenario: [happy] full loop, [cooldown] stop before network, [rate] stop during fetch: ",
  )
  rl.close()

  const scenario = answer.trim() || "happy"
  send({ type: "start" })

  if (scenario === "cooldown") {
    send({ type: "cooldown.detected", until: new Date(Date.now() + 10 * 60_000).toISOString() })
    return
  }

  send({ type: "cache.loaded" })
  send({ type: "metadata.listed", items: sampleItems, requests: 2 })

  if (scenario === "rate") {
    send({ type: "threads.fetched", threads: sampleThreads.slice(0, 1), requests: 1 })
    send({ type: "rate_limited", error: "Front 429 while fetching selected changed thread", until: new Date(Date.now() + 15 * 60_000).toISOString() })
    return
  }

  send({ type: "threads.fetched", threads: sampleThreads, requests: 3 })
  send({ type: "analysis.pack.emitted" })
  send({ type: "analysis.findings.ingested", findings: sampleFindings })
  send({ type: "archive.plan.built" })
  send({ type: "archive.approved" })
  send({ type: "archive.completed" })
}

await main()
