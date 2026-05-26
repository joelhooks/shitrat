import { Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { frontMetadataSnapshot } from "../inbox/front-snapshot.js"
import { annotateInterest, exportInterestMap, readInterestMap } from "../inbox/interest-map.js"
import { errorMessage, failure, json, success } from "../response.js"

const profileOption = Options.text("profile").pipe(
  Options.withDescription("Inbox profile to use"),
  Options.withDefault("joel-combined"),
)

const limitPerLaneOption = Options.integer("limit-per-lane").pipe(
  Options.withDescription("Max conversations to read per configured lane"),
  Options.withDefault(10),
)

const maxRequestsOption = Options.integer("max-requests").pipe(
  Options.withDescription("Hard cap for Front requests in this run"),
  Options.withDefault(6),
)

const maxPagesPerLaneOption = Options.integer("max-pages-per-lane").pipe(
  Options.withDescription("Hard cap for paginated Front pages per lane"),
  Options.withDefault(3),
)

const sinceHoursOption = Options.integer("since-hours").pipe(
  Options.withDescription("Only keep conversations whose latest activity is within this many hours"),
  Options.withDefault(24),
)

const refreshOption = Options.boolean("refresh").pipe(
  Options.withDescription("Allow live provider requests instead of cache-only behavior"),
)

const metadataOnlyOption = Options.boolean("metadata-only").pipe(
  Options.withDescription("Only fetch conversation metadata; never fetch full message bodies"),
)

const formatOption = Options.choice("format", ["json", "ndjson"] as const).pipe(
  Options.withDescription("Output format"),
  Options.withDefault("ndjson" as const),
)

const outOption = Options.text("out").pipe(
  Options.withDescription("Append NDJSON events to this file as they are produced"),
  Options.optional,
)

const headlessOption = Options.boolean("headless").pipe(
  Options.withDescription("Headless run mode; best used with --out for durable event logs"),
)

const printResult = (command: string, result: unknown) => Console.log(json(success(command, result)))

const printNdjson = (value: unknown) => Console.log(JSON.stringify(value))

const printError = (command: string, error: unknown) =>
  Console.log(
    json(
      failure(
        command,
        errorMessage(error),
        "INBOX_COMMAND_FAILED",
        "Check ~/.shitrat/inbox receipts and rerun with a smaller --max-requests if Front is cooling down.",
      ),
    ),
  )

type PullSnapshot = {
  profileId: string
  generatedAt: string
  metadataOnly: boolean
  window?: unknown
  requestBudget?: unknown
  rateLimit?: unknown
  lanePages?: unknown
  items: Array<Record<string, unknown>>
}

const streamSnapshot = (source: string, snapshot: PullSnapshot, writeEvent: (value: unknown) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const interestMap = yield* Effect.promise(() => readInterestMap())
    const runId = `pull-${new Date().toISOString()}`
    yield* writeEvent({
      type: "run.started",
      runId,
      profileId: snapshot.profileId,
      source,
      snapshotGeneratedAt: snapshot.generatedAt,
      window: snapshot.window,
      metadataOnly: snapshot.metadataOnly,
    })
    yield* writeEvent({
      type: "snapshot.receipt",
      runId,
      requestBudget: snapshot.requestBudget,
      rateLimit: snapshot.rateLimit,
      lanePages: snapshot.lanePages,
      itemCount: snapshot.items.length,
    })
    const seen = new Set<string>()
    let duplicates = 0
    for (const item of snapshot.items) {
      const providerId = String(item.providerId ?? "unknown")
      const itemId = String(item.itemId ?? item.threadId ?? "unknown")
      const key = `${providerId}:${itemId}`
      const duplicate = seen.has(key)
      if (duplicate) duplicates += 1
      seen.add(key)
      yield* writeEvent({ type: "item.metadata", runId, duplicate, ...annotateInterest(item, interestMap), item })
    }
    yield* writeEvent({
      type: "run.completed",
      runId,
      emittedItems: snapshot.items.length,
      duplicates,
      uniqueItems: seen.size,
      window: snapshot.window,
      expectedOutput: {
        dealWithFirst: [],
        summarizeStreams: [],
        archiveCandidates: [],
        needsRule: [],
        fetchThreadBodies: [],
      },
    })
  })

const fileEventWriter = (out: string) => {
  let initialized = false
  return (value: unknown) => Effect.promise(async () => {
    if (!initialized) {
      await mkdir(path.dirname(out), { recursive: true })
      await writeFile(out, "", "utf8")
      initialized = true
    }
    await appendFile(out, `${JSON.stringify(value)}\n`, "utf8")
  })
}

const stdoutEventWriter = (value: unknown) => printNdjson(value)

const janitorPrompt = (mode: "daily" | "dumpster", events: string) => {
  const operatorFormat = "Return an executive summary first, then context, reasoning, grouped items, and Front thread links for every actionable/archive group. Joel prefers grouped decisions with receipts over flat ticket dumps."
  if (mode === "dumpster") {
    return `Analyze ${events}. Metadata-only inbox dumpster pack. Default stance: archive old sludge unless there is a concrete keep reason. Do not mutate. ${operatorFormat} Return JSON with executiveSummary, context, reasoning, groupedItems, archiveByDefault, keepReasons, fetchBeforeArchive, ruleCandidates. Keep/fetch money, tax, legal, account/security, school/family, active human/work threads, unresolved failures/incidents.`
  }
  return `Analyze ${events}. Metadata-only daily inbox janitor pack. Do not mutate. ${operatorFormat} Return JSON with executiveSummary, context, reasoning, groupedItems, dealWithFirst, summarizeStreams, highConfidenceArchiveCandidates, needsRule, fetchThreadBodies. Be conservative around money/security/account/school/family/legal/work; archive only obvious trash from metadata.`
}

const janitorModeOption = Options.choice("mode", ["daily", "dumpster"] as const).pipe(
  Options.withDescription("Janitor specialist prompt mode"),
  Options.withDefault("daily" as const),
)

const eventsOption = Options.text("events").pipe(
  Options.withDescription("NDJSON event log path to analyze"),
)

const sourceOption = Options.text("source").pipe(
  Options.withDescription("Source Brain SVX file"),
  Options.optional,
)

const rulesOutOption = Options.text("out").pipe(
  Options.withDescription("Generated runtime interest-map JSON path"),
  Options.optional,
)

const rulesExportCmd = Command.make(
  "export",
  { source: sourceOption, out: rulesOutOption },
  ({ source, out }) =>
    Effect.gen(function* () {
      const input: { source?: string; out?: string } = {}
      if (source._tag === "Some") input.source = source.value
      if (out._tag === "Some") input.out = out.value
      const result = yield* Effect.promise(() => exportInterestMap(input))
      yield* printResult("inbox rules export", result)
    }).pipe(Effect.catchAll((error) => printError("inbox rules export", error))),
).pipe(Command.withDescription("Export deterministic/guidance inbox interest rules from Brain SVX to runtime JSON"))

const rulesCmd = Command.make("rules", {}, () =>
  Console.log(json(success("inbox rules", {
    description: "Inbox interest map rule helpers.",
    commands: {
      export: "shitrat inbox rules export [--source <brain.svx>] [--out <interest-map.json>]",
    },
  }))),
).pipe(Command.withSubcommands([rulesExportCmd]))

const janitorPromptCmd = Command.make(
  "prompt",
  { mode: janitorModeOption, events: eventsOption },
  ({ mode, events }) =>
    printResult(`inbox janitor prompt --mode ${mode}`, {
      mode,
      events,
      prompt: janitorPrompt(mode, events),
      expectedOutput: mode === "dumpster"
        ? { archiveByDefault: [], keepReasons: [], fetchBeforeArchive: [], ruleCandidates: [] }
        : { dealWithFirst: [], summarizeStreams: [], highConfidenceArchiveCandidates: [], needsRule: [], fetchThreadBodies: [] },
    }),
).pipe(Command.withDescription("Emit the Pi/Codex specialist prompt for a janitor event log"))

const janitorDailyCmd = Command.make(
  "daily",
  { profile: profileOption, sinceHours: sinceHoursOption, out: outOption },
  ({ profile, sinceHours, out }) => {
    const outPath = out._tag === "Some" ? out.value : `~/.shitrat/inbox/${profile}/runs/<run-id>/events.ndjson`
    return Console.log(json(success("inbox janitor daily", {
      description: "Daily janitor flow: pull recent inbox metadata, then have Pi/Codex propose clean/summarize/fetch actions.",
      profile,
      sinceHours,
      filterPack: "recent-signal",
      out: outPath,
      prompt: janitorPrompt("daily", outPath),
    }, janitorNextActions("daily", outPath))))
  },
).pipe(Command.withDescription("Plan the daily inbox janitor flow over recent items"))

const olderThanDaysOption = Options.integer("older-than-days").pipe(
  Options.withDescription("Dumpster mode: focus on items older than this many days"),
  Options.withDefault(30),
)

const janitorDumpsterCmd = Command.make(
  "dumpster",
  { profile: profileOption, olderThanDays: olderThanDaysOption, out: outOption },
  ({ profile, olderThanDays, out }) => {
    const outPath = out._tag === "Some" ? out.value : `~/.shitrat/inbox/${profile}/runs/<run-id>/events.ndjson`
    return Console.log(json(success("inbox janitor dumpster", {
      description: "Dumpster flow: pull stale inbox metadata, then have Pi/Codex find reasons not to archive the old pile.",
      profile,
      olderThanDays,
      filterPack: "stale-dumpster",
      out: outPath,
      prompt: janitorPrompt("dumpster", outPath),
    }, janitorNextActions("dumpster", outPath))))
  },
).pipe(Command.withDescription("Plan the stale dumpster archive-review flow"))

const janitorCmd = Command.make("janitor", {}, () =>
  Console.log(json(success("inbox janitor", {
    description: "Inbox janitor product flows. CLI pulls/streams; Pi/Codex decides.",
    commands: {
      daily: "shitrat inbox janitor daily --profile joel-combined --since-hours 24 --out <events.ndjson>",
      dumpster: "shitrat inbox janitor dumpster --profile joel-combined --older-than-days 30 --out <events.ndjson>",
      prompt: "shitrat inbox janitor prompt --mode daily|dumpster --events <events.ndjson>",
    },
  }))),
).pipe(Command.withSubcommands([janitorDailyCmd, janitorDumpsterCmd, janitorPromptCmd]))

const snapshotCmd = Command.make(
  "snapshot",
  {
    profile: profileOption,
    limitPerLane: limitPerLaneOption,
    maxRequests: maxRequestsOption,
    maxPagesPerLane: maxPagesPerLaneOption,
    sinceHours: sinceHoursOption,
    refresh: refreshOption,
    metadataOnly: metadataOnlyOption,
  },
  ({ profile, limitPerLane, maxRequests, maxPagesPerLane, sinceHours, refresh, metadataOnly }) => {
    const command = `inbox snapshot --profile ${profile}`
    return Effect.gen(function* () {
      if (profile !== "joel-combined") {
        yield* printError(command, new Error(`Unsupported inbox profile '${profile}'. Only joel-combined exists in this prototype slice.`))
        return
      }
      if (!metadataOnly) {
        yield* printError(command, new Error("This slice only supports --metadata-only. Full thread fetch comes next."))
        return
      }
      if (!refresh) {
        yield* printError(command, new Error("Live snapshot requires --refresh so accidental Front calls are harder."))
        return
      }
      const result = yield* frontMetadataSnapshot({ limitPerLane, maxRequests, maxPagesPerLane, sinceHours, refresh })
      yield* printResult(command, result)
    }).pipe(Effect.catchAll((error) => printError(command, error)))
  },
).pipe(Command.withDescription("Fetch a capped metadata-only inbox snapshot for Joel's combined Front lanes"))

const janitorNextActions = (mode: "daily" | "dumpster", out: string) => [
  {
    command: "inbox pull --profile joel-combined --metadata-only --refresh --format ndjson --headless --out <events>",
    description: `Run the ${mode} janitor data pull and write NDJSON events`,
    params: {
      events: { value: out, description: "Durable NDJSON event log path", required: true },
    },
  },
  {
    command: "inbox janitor prompt --mode <mode> --events <events>",
    description: "Get the Pi/Codex specialist prompt for analyzing the event log",
    params: {
      mode: { value: mode, enum: ["daily", "dumpster"] },
      events: { value: out, description: "NDJSON event log to analyze" },
    },
  },
]

const pullCmd = Command.make(
  "pull",
  {
    profile: profileOption,
    limitPerLane: limitPerLaneOption,
    maxRequests: maxRequestsOption,
    maxPagesPerLane: maxPagesPerLaneOption,
    sinceHours: sinceHoursOption,
    refresh: refreshOption,
    metadataOnly: metadataOnlyOption,
    format: formatOption,
    out: outOption,
    headless: headlessOption,
  },
  ({ profile, limitPerLane, maxRequests, maxPagesPerLane, sinceHours, refresh, metadataOnly, format, out, headless }) => {
    const command = `inbox pull --profile ${profile}`
    return Effect.gen(function* () {
      if (profile !== "joel-combined") {
        yield* printError(command, new Error(`Unsupported inbox profile '${profile}'. Only joel-combined exists in this prototype slice.`))
        return
      }
      if (!metadataOnly) {
        yield* printError(command, new Error("This slice only supports --metadata-only. Full thread fetch comes next."))
        return
      }
      if (!refresh) {
        yield* printError(command, new Error("Live pull requires --refresh so accidental Front calls are harder."))
        return
      }

      const writeEvent = out._tag === "Some" ? fileEventWriter(out.value) : stdoutEventWriter
      const liveEmit = format === "ndjson" ? (event: Record<string, unknown>) => Effect.runPromise(writeEvent(event)) : undefined
      const result = yield* frontMetadataSnapshot({ limitPerLane, maxRequests, maxPagesPerLane, sinceHours, refresh, emit: liveEmit })
      if (format === "json") {
        yield* printResult(command, result)
        return
      }
      const paths = "paths" in result ? result.paths : undefined
      if (!paths) {
        yield* printNdjson({ type: "run.skipped", command, result })
        return
      }
      if (out._tag === "Some") {
        yield* printResult(command, {
          ok: true,
          mode: headless ? "headless" : "file",
          eventsPath: out.value,
          source: paths.latest,
        })
      }
    }).pipe(Effect.catchAll((error) => printError(command, error)))
  },
).pipe(Command.withDescription("Safely pull inbox metadata and stream it as NDJSON for Pi/Codex janitor analysis"))

export const inboxCmd = Command.make("inbox", {}, () =>
  Console.log(json(success("inbox", {
    description: "Provider-neutral inbox prototype commands.",
    commands: {
      snapshot: "shitrat inbox snapshot --profile joel-combined --metadata-only --refresh --since-hours 24 --limit-per-lane 100 --max-pages-per-lane 3 --max-requests 20",
      pull: "shitrat inbox pull --profile joel-combined --metadata-only --refresh --since-hours 24 --limit-per-lane 100 --max-pages-per-lane 5 --max-requests 25 --format ndjson",
    },
  }))),
).pipe(Command.withSubcommands([snapshotCmd, pullCmd, janitorCmd, rulesCmd]))
