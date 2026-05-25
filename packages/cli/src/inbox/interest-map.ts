import { mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export type InterestAuthority = "deterministic" | "guidance"

export type DeterministicInterestRule = {
  id: string
  authority: "deterministic"
  match: { senderDomain?: string }
  bucket: string
  suggestedAction: string
  reason: string
}

export type GuidanceInterestRule = {
  id: string
  authority: "guidance"
  matchHints?: {
    brands?: string[]
    senderDomains?: string[]
    surfaceSubjectTerms?: string[]
  }
  bucket: string
  preferredAction: string
  guidance: string
}

export type InterestMap = {
  schemaVersion: 1
  exportedAt: string
  source: string
  deterministicRules: DeterministicInterestRule[]
  guidance: GuidanceInterestRule[]
}

export type InterestAnnotation = {
  id: string
  authority: InterestAuthority
  bucket: string
  suggestedAction?: string
  preferredAction?: string
  reason?: string
  guidance?: string
}

const defaultBrainSource = () => path.join(homedir(), ".brain", "areas", "joel-inbox-interest-map.svx")
export const defaultInterestMapPath = () => path.join(homedir(), ".shitrat", "inbox", "context", "interest-map.json")

const extractJsonBlocks = (text: string): unknown[] => {
  const blocks: unknown[] = []
  const regex = /```json\s*([\s\S]*?)```/g
  for (const match of text.matchAll(regex)) {
    const raw = match[1]?.trim()
    if (!raw) continue
    blocks.push(JSON.parse(raw))
  }
  return blocks
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)

export const exportInterestMap = async (input: { source?: string; out?: string }) => {
  const source = input.source ?? defaultBrainSource()
  const out = input.out ?? defaultInterestMapPath()
  const text = await readFile(source, "utf8")
  const blocks = extractJsonBlocks(text)
  const deterministicRules: DeterministicInterestRule[] = []
  const guidance: GuidanceInterestRule[] = []

  for (const block of blocks) {
    if (!isRecord(block)) continue
    const rules = Array.isArray(block.rules) ? block.rules : []
    const guidanceRules = Array.isArray(block.guidance) ? block.guidance : []
    for (const rule of rules) {
      if (isRecord(rule) && rule.authority === "deterministic") deterministicRules.push(rule as DeterministicInterestRule)
    }
    for (const rule of guidanceRules) {
      if (isRecord(rule) && rule.authority === "guidance") guidance.push(rule as GuidanceInterestRule)
    }
  }

  const interestMap: InterestMap = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    source,
    deterministicRules,
    guidance,
  }

  await mkdir(path.dirname(out), { recursive: true })
  await writeFile(out, `${JSON.stringify(interestMap, null, 2)}\n`, "utf8")

  return { ok: true, source, out, deterministicRules: deterministicRules.length, guidance: guidance.length }
}

export const readInterestMap = async (mapPath = defaultInterestMapPath()): Promise<InterestMap | undefined> => {
  if (!existsSync(mapPath)) return undefined
  return JSON.parse(await readFile(mapPath, "utf8")) as InterestMap
}

const domainFromEmail = (email: string | undefined): string | undefined => {
  if (!email) return undefined
  const at = email.lastIndexOf("@")
  return at >= 0 ? email.slice(at + 1).toLowerCase() : undefined
}

const includesFolded = (value: string | undefined, term: string) =>
  Boolean(value?.toLowerCase().includes(term.toLowerCase()))

const includesAnyFolded = (value: string | undefined, terms: string[] | undefined) =>
  terms?.some((term) => includesFolded(value, term)) ?? false

const domainMatches = (domain: string | undefined, expected: string | undefined) => {
  if (!domain || !expected) return false
  const normalized = expected.toLowerCase()
  return domain === normalized || domain.endsWith(`.${normalized}`)
}

export const annotateInterest = (item: Record<string, unknown>, interestMap: InterestMap | undefined) => {
  if (!interestMap) return { ruleMatches: [], guidanceMatches: [] }
  const sender = item.sender && typeof item.sender === "object" ? item.sender as { email?: string; name?: string } : {}
  const senderDomain = domainFromEmail(sender.email)
  const subject = typeof item.subject === "string" ? item.subject : undefined
  const senderName = sender.name

  const ruleMatches: InterestAnnotation[] = interestMap.deterministicRules
    .filter((rule) => domainMatches(senderDomain, rule.match.senderDomain))
    .map((rule) => ({
      id: rule.id,
      authority: rule.authority,
      bucket: rule.bucket,
      suggestedAction: rule.suggestedAction,
      reason: rule.reason,
    }))

  const guidanceMatches: InterestAnnotation[] = interestMap.guidance
    .filter((rule) => {
      const hints = rule.matchHints ?? {}
      const domainHit = hints.senderDomains?.some((domain) => domainMatches(senderDomain, domain)) ?? false
      const brandHit = hints.brands?.some((brand) => includesFolded(subject, brand) || includesFolded(senderName, brand) || includesFolded(sender.email, brand)) ?? false
      const subjectHit = includesAnyFolded(subject, hints.surfaceSubjectTerms)
      const hasBaseHints = Boolean(hints.senderDomains?.length || hints.brands?.length)
      const hasSubjectHints = Boolean(hints.surfaceSubjectTerms?.length)
      const baseHit = hasBaseHints ? domainHit || brandHit : true
      return baseHit && (!hasSubjectHints || subjectHit)
    })
    .map((rule) => ({
      id: rule.id,
      authority: rule.authority,
      bucket: rule.bucket,
      preferredAction: rule.preferredAction,
      guidance: rule.guidance,
    }))

  return { ruleMatches, guidanceMatches }
}
