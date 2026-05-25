#!/usr/bin/env bun

// PROTOTYPE — delete or absorb.
// Streams a cached inbox chunk as NDJSON for Pi/Codex janitor analysis.
// No Front calls. No decisions. No persistence beyond caller redirection.

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

type SnapshotItem = {
  providerId: string
  laneId: string
  laneLabel: string
  itemId: string
  threadId: string
  subject?: string
  sender?: { name?: string; email?: string }
  status?: string
  statusCategory?: string
  assignedTo?: string
  createdAt?: string
  updatedAt?: string
  latestMessageId?: string
  latestMessageAt?: string
  url?: string
}

type Snapshot = {
  profileId: string
  generatedAt: string
  metadataOnly: boolean
  requestBudget?: unknown
  rateLimit?: unknown
  items: SnapshotItem[]
}

const argValue = (name: string, fallback?: string) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const limit = Number(argValue("--limit", "20"))
const source = argValue(
  "--source",
  path.join(homedir(), ".shitrat", "inbox", "joel-combined", "latest.json"),
)

if (!source) throw new Error("missing source")

const snapshot = JSON.parse(await readFile(source, "utf8")) as Snapshot
const runId = `stream-${new Date().toISOString()}`

const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`)

write({
  type: "run.started",
  runId,
  profileId: snapshot.profileId,
  source,
  snapshotGeneratedAt: snapshot.generatedAt,
  metadataOnly: snapshot.metadataOnly,
  limit,
})

write({
  type: "snapshot.receipt",
  runId,
  requestBudget: snapshot.requestBudget,
  rateLimit: snapshot.rateLimit,
  itemCount: snapshot.items.length,
})

for (const item of snapshot.items.slice(0, limit)) {
  write({
    type: "item.metadata",
    runId,
    item: {
      providerId: item.providerId,
      laneId: item.laneId,
      laneLabel: item.laneLabel,
      itemId: item.itemId,
      threadId: item.threadId,
      subject: item.subject,
      sender: item.sender,
      status: item.status,
      statusCategory: item.statusCategory,
      assignedTo: item.assignedTo,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      latestMessageId: item.latestMessageId,
      latestMessageAt: item.latestMessageAt,
      url: item.url,
    },
  })
}

write({
  type: "run.completed",
  runId,
  emittedItems: Math.min(limit, snapshot.items.length),
  totalItems: snapshot.items.length,
  next: {
    instruction: "Pi/Codex specialist should analyze this NDJSON chunk and propose actions. CLI makes no decisions.",
    expectedOutput: {
      dealWithFirst: [],
      summarizeStreams: [],
      archiveCandidates: [],
      needsRule: [],
      fetchThreadBodies: [],
    },
  },
})
