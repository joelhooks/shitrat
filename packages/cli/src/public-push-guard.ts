import { constants } from "node:fs"
import { lstat, mkdir, open, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

// Joel, 2026-11-03: "two repos one for dev and brain etc and the other clean for
// publishing". shitrat push is the one chokepoint every agent push goes through, so a
// push to a public repo is scanned here and refused when it would publish private
// state. Private repos are not scanned.

export type GuardRuleKind = "path" | "content"

export interface GuardRule {
  readonly id: string
  readonly kind: GuardRuleKind
  readonly pattern: RegExp
  /** Secrets are never waivable: once pushed public they must be rotated, a glob cannot undo that. */
  readonly waivable: boolean
  readonly secret: boolean
  readonly why: string
}

export interface GuardFinding {
  readonly rule: string
  readonly commit: string
  readonly file: string
  readonly line?: number
  readonly excerpt: string
  readonly waivable: boolean
  readonly why: string
}

export interface GuardConfig {
  readonly privateHostnames: readonly string[]
}

const rule = (
  id: string,
  kind: GuardRuleKind,
  pattern: RegExp,
  why: string,
  secret = false,
): GuardRule => ({ id, kind, pattern, why, secret, waivable: !secret })

export const BUILT_IN_RULES: readonly GuardRule[] = [
  rule("muster-state", "path", /(^|\/)\.brain\/data\/muster\//, "Muster state (rows, packets, reports) is private operating state"),
  rule("brain-path", "path", /(^|\/)\.brain(\/|-private)/, "Brain notes are dev memory and belong in the private dev repo"),
  rule("agent-state", "path", /(^|\/)\.(pi|agent)\//, "Pi and agent state is per-machine and private"),
  rule("home-path", "content", /\/Users\/[A-Za-z0-9._-]+\//, "an absolute home path reveals a private machine layout"),
  rule("tailnet-domain", "content", /\b[a-z0-9-]+\.ts\.net\b/i, "a Tailscale MagicDNS name reveals the private tailnet"),
  rule("tailnet-ip", "content", /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/, "an address in the CGNAT block Tailscale assigns is a tailnet node"),
  rule("private-key", "content", /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/, "a private key", true),
  rule("github-token", "content", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/, "a GitHub token", true),
  rule("sk-key", "content", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/, "an OpenAI or Anthropic style API key", true),
  rule("slack-token", "content", /\bxox[abposr]-[A-Za-z0-9-]{10,}/, "a Slack token", true),
  rule("aws-key", "content", /\bAKIA[0-9A-Z]{16}\b/, "an AWS access key id", true),
  rule("npm-token", "content", /\bnpm_[A-Za-z0-9]{36}\b/, "an npm token", true),
  rule("jwt", "content", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, "a JSON Web Token", true),
]

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export const rulesFor = (config: GuardConfig): readonly GuardRule[] => {
  const names = config.privateHostnames.map((name) => name.trim()).filter((name) => name.length > 0)
  if (names.length === 0) return BUILT_IN_RULES
  return [
    ...BUILT_IN_RULES,
    rule(
      "tailnet-hostname",
      "content",
      new RegExp(`\\b(?:${names.map(escapeRegExp).join("|")})\\b`, "i"),
      "a private fleet hostname (from the local guard config)",
    ),
  ]
}

export const defaultConfigPath = () =>
  process.env.SHITRAT_PUBLIC_PUSH_GUARD_CONFIG ?? path.join(homedir(), ".config/shitrat/public-push-guard.json")

export class GuardConfigError extends Error {}

/** Missing file means no private hostname list; a present but unreadable file fails closed. */
export const loadGuardConfig = async (configPath = defaultConfigPath()): Promise<GuardConfig> => {
  const raw = await readFile(configPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw new GuardConfigError(`cannot read ${configPath}: ${error.code ?? error.message}`)
  })
  if (raw === undefined) return { privateHostnames: [] }
  try {
    const parsed: unknown = JSON.parse(raw)
    const names = (parsed as { privateHostnames?: unknown }).privateHostnames
    if (names !== undefined && !(Array.isArray(names) && names.every((n) => typeof n === "string"))) {
      throw new Error("privateHostnames must be an array of strings")
    }
    return { privateHostnames: (names as string[] | undefined) ?? [] }
  } catch (error) {
    throw new GuardConfigError(`${configPath} is not valid guard config: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const redactExcerpt = (ruleDef: GuardRule, text: string): string => {
  const match = text.match(ruleDef.pattern)?.[0] ?? ""
  if (ruleDef.secret) return `${match.slice(0, 4)}… (${match.length} chars, redacted)`
  return match.length > 120 ? `${match.slice(0, 117)}...` : match
}

export interface DiffScanInput {
  readonly commit: string
  readonly patch: string
}

const unquotePath = (raw: string): string => {
  if (!raw.startsWith('"')) return raw
  try {
    return JSON.parse(raw) as string
  } catch {
    return raw.slice(1, -1)
  }
}

/** Scans one commit's `git show -p --unified=0 --no-renames` text: added paths and added lines. */
export const scanPatch = (input: DiffScanInput, rules: readonly GuardRule[]): GuardFinding[] => {
  const findings: GuardFinding[] = []
  const pathRules = rules.filter((r) => r.kind === "path")
  const contentRules = rules.filter((r) => r.kind === "content")
  const seenPaths = new Set<string>()
  let file = ""
  let newLine = 0

  const checkPath = (candidate: string) => {
    if (seenPaths.has(candidate)) return
    seenPaths.add(candidate)
    for (const r of [...pathRules, ...contentRules]) {
      if (r.pattern.test(candidate)) {
        findings.push({ rule: r.id, commit: input.commit, file: candidate, excerpt: redactExcerpt(r, candidate), waivable: r.waivable, why: r.why })
      }
    }
  }

  for (const line of input.patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = ""
      continue
    }
    if (line.startsWith("+++ ")) {
      const target = line.slice(4)
      file = target === "/dev/null" ? "" : unquotePath(target).replace(/^b\//, "")
      if (file) checkPath(file)
      continue
    }
    const binary = line.match(/^Binary files .* and (.+) differ$/)
    if (binary?.[1] && binary[1] !== "/dev/null") {
      file = unquotePath(binary[1]).replace(/^b\//, "")
      checkPath(file)
      continue
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk?.[1]) {
      newLine = Number(hunk[1])
      continue
    }
    if (file && line.startsWith("+")) {
      const added = line.slice(1)
      for (const r of contentRules) {
        if (r.pattern.test(added)) {
          findings.push({ rule: r.id, commit: input.commit, file, line: newLine, excerpt: redactExcerpt(r, added), waivable: r.waivable, why: r.why })
        }
      }
      newLine += 1
    }
  }
  return findings
}

export const scanMessage = (commit: string, message: string, rules: readonly GuardRule[]): GuardFinding[] =>
  rules
    .filter((r) => r.kind === "content" && r.pattern.test(message))
    .map((r) => ({ rule: r.id, commit, file: "(commit message)", excerpt: redactExcerpt(r, message), waivable: r.waivable, why: r.why }))

export const matchesAllow = (file: string, globs: readonly string[]): boolean =>
  globs.some((glob) => new Bun.Glob(glob).match(file))

export interface GuardVerdict {
  readonly blocking: readonly GuardFinding[]
  readonly waived: readonly GuardFinding[]
}

/** Waivable findings in allowed paths are waived; secrets and everything else block. */
export const judge = (findings: readonly GuardFinding[], allow: readonly string[]): GuardVerdict => ({
  blocking: findings.filter((f) => !(f.waivable && f.file !== "(commit message)" && matchesAllow(f.file, allow))),
  waived: findings.filter((f) => f.waivable && f.file !== "(commit message)" && matchesAllow(f.file, allow)),
})

export const describeFinding = (f: GuardFinding): string =>
  `${f.commit.slice(0, 12)} ${f.file}${f.line === undefined ? "" : `:${f.line}`} [${f.rule}] ${f.why}: ${f.excerpt}`

export const refusalFix = (verdict: GuardVerdict, repo: string): string => {
  const secrets = verdict.blocking.some((f) => !f.waivable)
  const steps = [
    `Keep private material in the private dev repo and publish only clean files to ${repo}.`,
    "Remove the flagged paths or lines from the outgoing commits (rewrite your unpushed local commits), then push again.",
  ]
  if (secrets) {
    steps.push("A secret shape cannot be waived. If it is real, rotate it now: it must not reach a public repo even once.")
  }
  if (verdict.blocking.some((f) => f.waivable)) {
    steps.push(
      `For a known-safe false positive in a path rule, home path or hostname, retry with --allow-public-path '<glob>' (logged to ${allowLogPath()}).`,
    )
  }
  return steps.join(" ")
}

export const allowLogPath = () =>
  process.env.SHITRAT_PUBLIC_PUSH_ALLOW_LOG ?? path.join(homedir(), ".local/state/shitrat/public-push-allow.jsonl")

/** Appends one waiver receipt; no excerpts, so a waived line never lands in the log. */
export const logWaivers = async (entry: {
  readonly repo: string
  readonly branch: string
  readonly range: string
  readonly allow: readonly string[]
  readonly waived: readonly GuardFinding[]
  readonly dryRun: boolean
}): Promise<string> => {
  const logPath = allowLogPath()
  await mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 })
  const directory = await lstat(path.dirname(logPath))
  if (!directory.isDirectory() || (directory.mode & 0o077) !== 0) {
    throw new Error(`waiver log directory ${path.dirname(logPath)} must be a private directory (no group or other access)`)
  }
  const handle = await open(logPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
  try {
    await handle.chmod(0o600)
    const line = {
      at: new Date().toISOString(),
      repo: entry.repo,
      branch: entry.branch,
      range: entry.range,
      dry_run: entry.dryRun,
      allow: entry.allow,
      waived: entry.waived.map((f) => ({ rule: f.rule, commit: f.commit, file: f.file, line: f.line })),
    }
    await handle.appendFile(`${JSON.stringify(line)}\n`)
  } finally {
    await handle.close()
  }
  return logPath
}
