#!/usr/bin/env bun

import { Command } from "@effect/cli"
import { BunContext } from "@effect/platform-bun"
import { Console, Effect } from "effect"
import { planClaudeInstall } from "@joelhooks/shitrat-adapter-claude"
import { planCodexDesktopInstall } from "@joelhooks/shitrat-adapter-codex-desktop"
import { planPiInstall } from "@joelhooks/shitrat-adapter-pi"
import {
  compilePrompt,
  composeProfiles,
  parityReport,
  type FamiliarProfile,
  type FamiliarProfileOverlay,
  type HarnessTarget,
} from "@joelhooks/shitrat-core"
import { createShitRatDefaultProfile } from "@joelhooks/shitrat-defaults"
import { existsSync } from "node:fs"
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import {
  commitFileCmd,
  commitFilesCmd,
  commentCmd,
  createPrCmd,
  installationsCmd,
  mergeCmd,
  mergePrCmd,
  pushCmd,
  reviewCmd,
  statusCmd,
} from "./commands/github.js"
import { inboxCmd } from "./commands/inbox.js"
import { errorMessage, failure, json, success } from "./response.js"

const root = Command.make("shitrat", {}, () =>
  Effect.gen(function* () {
    yield* Console.log(
      json(
        success(
          "",
          {
            description:
              "ShitRat CLI — GitHub App bot actions for agent-owned comments, PR reviews, and repo work.",
            actor: "shitratgit[bot]",
            github_app: "https://github.com/apps/shitratgit",
            commands: {
              installations: "shitrat installations",
              status: "shitrat status <owner/repo>",
              comment: "shitrat comment <owner/repo> <issue-or-pr-number> --body-file <path>",
              review:
                "shitrat review <owner/repo> <pull-number> --event APPROVE|REQUEST_CHANGES|COMMENT --body-file <path>",
              merge:
                "shitrat merge <owner/repo> --base main --head <branch> --message <message>",
              push: "shitrat push <owner/repo> [--branch <name>] [--repo-dir <local-repo>]",
              commit_file:
                "shitrat commit-file <owner/repo> --branch main --message <message> --file <local-path> [--path <repo-path>]",
              commit_files:
                "shitrat commit-files <owner/repo> --branch main --message <message> --file <path> [--file <path>...]",
              create_pr:
                "shitrat create-pr <owner/repo> --title <title> --head <branch> --base main --body-file <path>",
              merge_pr:
                "shitrat merge-pr <owner/repo> <pull-number> --method squash --dry-run",
              install:
                "shitrat install pi|claude|codex-desktop --dry-run",
              update:
                "shitrat update pi|claude|codex-desktop --dry-run",
            },
            secrets: [
              "shitrat_github_app_id",
              "shitrat_github_private_key",
              "shitrat_github_installations_json",
              "shitrat_github_installation_id_<owner_key>",
            ],
          },
          [
            {
              command: "installations",
              description: "List installed accounts for the ShitRat GitHub App",
            },
            {
              command: "status <repo>",
              description: "Verify ShitRat can access a repository",
              params: {
                repo: {
                  required: true,
                  description: "Repository in owner/repo form",
                  value: "skillrecordings/migrate-egghead",
                },
              },
            },
            {
              command: "comment <repo> <number> --body-file <path>",
              description: "Post an issue or PR conversation comment as ShitRat",
              params: {
                repo: { required: true, description: "Repository in owner/repo form" },
                number: { required: true, description: "Issue or PR number" },
                path: { required: true, description: "Markdown body file" },
              },
            },
            {
              command: "review <repo> <number> --event <event> --body-file <path>",
              description: "Create a pull request review as ShitRat",
              params: {
                repo: { required: true, description: "Repository in owner/repo form" },
                number: { required: true, description: "PR number" },
                event: {
                  enum: ["APPROVE", "REQUEST_CHANGES", "COMMENT"],
                  default: "COMMENT",
                },
                path: { required: true, description: "Markdown body file" },
              },
            },
            {
              command: "commit-file <repo> --branch <branch> --message <message> --file <file> [--path <path>] [--dry-run]",
              description: "Commit one local file to GitHub as ShitRat",
              params: {
                repo: { required: true, description: "Repository in owner/repo form" },
                branch: { default: "main", description: "Target branch" },
                message: { required: true, description: "Git commit message" },
                file: { required: true, description: "Local file to commit" },
                path: { description: "Target repository path; defaults to --file relative to cwd" },
              },
            },
            {
              command: "commit-files <repo> --branch <branch> --message <message> --file <file> [--file <file>...] [--dry-run]",
              description: "Atomically commit multiple local files to GitHub as ShitRat",
              params: {
                repo: { required: true, description: "Repository in owner/repo form" },
                branch: { default: "main", description: "Target branch" },
                message: { required: true, description: "Git commit message" },
                file: { required: true, description: "Repeat --file for each local file" },
              },
            },
            {
              command: "push <repo> [--branch <name>] [--repo-dir <path>] [--allow-any-author] [--dry-run]",
              description: "Push existing local commits with ShitRat GitHub App auth",
              params: {
                repo: { required: true, description: "Repository in owner/repo form" },
                branch: { description: "Defaults to the checked-out branch" },
                "repo-dir": { default: process.cwd(), description: "Local git worktree" },
              },
            },
            {
              command: "create-pr <repo> --title <title> --head <branch> --base <branch> --body-file <path> [--dry-run]",
              description: "Open a pull request as ShitRat",
              params: {
                repo: { required: true, description: "Repository in owner/repo form" },
                title: { required: true, description: "Pull request title" },
                head: { required: true, description: "Head branch" },
                base: { default: "main", description: "Base branch" },
                path: { description: "Markdown body file" },
              },
            },
            {
              command: "merge-pr <repo> <number> --method squash [--dry-run]",
              description: "Merge a pull request as ShitRat when policy allows",
              params: {
                repo: { required: true, description: "Repository in owner/repo form" },
                number: { required: true, description: "PR number" },
                method: { enum: ["merge", "squash", "rebase"], default: "squash" },
              },
            },
          ],
        ),
      ),
    )
  }),
).pipe(
  Command.withSubcommands([
    installationsCmd,
    statusCmd,
    commentCmd,
    reviewCmd,
    mergeCmd,
    pushCmd,
    createPrCmd,
    mergePrCmd,
    commitFileCmd,
    commitFilesCmd,
    inboxCmd,
  ]),
)

const cli = Command.run(root, {
  name: "shitrat",
  version: "0.1.0",
})

// Compatibility no-ops. JSON is the only output format.
const argv = process.argv.filter((arg) => arg !== "--json" && arg !== "--toon")

const stripAnsi = (text: string): string =>
  text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")

const isJsonEnvelope = (text: string): boolean => {
  const trimmed = text.trim()
  if (!trimmed.startsWith("{")) return false
  try {
    const parsed = JSON.parse(trimmed) as { ok?: unknown }
    return typeof parsed === "object" && parsed !== null && "ok" in parsed
  } catch {
    return false
  }
}

const commandString = () => argv.slice(2).join(" ") || "shitrat"

const harnessTargets = ["codex-desktop", "pi", "claude"] as const

const isHarnessTarget = (value: string | undefined): value is HarnessTarget =>
  harnessTargets.some((target) => target === value)

const optionValue = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const hasFlag = (args: readonly string[], name: string): boolean => args.includes(name)

const resolveConfigPath = (args: readonly string[]): string | undefined => {
  const explicit = optionValue(args, "--config")
  if (explicit) return path.resolve(explicit)
  const homeConfig = path.join(homedir(), ".shitrat")
  return existsSync(homeConfig) ? homeConfig : undefined
}

const loadOverlayProfile = async (configPath: string | undefined): Promise<FamiliarProfileOverlay | undefined> => {
  if (!configPath) return undefined
  const manifestPath = path.join(configPath, "shitrat.config.json")
  if (!existsSync(manifestPath)) return undefined

  const raw = JSON.parse(await readFile(manifestPath, "utf8")) as {
    identity?: { name?: string; emoji?: string; voice?: string }
  }

  return {
    ...(raw.identity ? { identity: raw.identity } : {}),
    modules: [],
  }
}

const createProfile = async (args: readonly string[]): Promise<{
  readonly profile: FamiliarProfile
  readonly configPath?: string
}> => {
  const configPath = resolveConfigPath(args)
  const overlay = await loadOverlayProfile(configPath)
  const result = {
    profile: composeProfiles(createShitRatDefaultProfile(), overlay),
  }
  return configPath ? { ...result, configPath } : result
}

const planInstall = (profile: FamiliarProfile, target: HarnessTarget, home?: string) => {
  if (target === "codex-desktop") return planCodexDesktopInstall(profile, home)
  if (target === "pi") return planPiInstall(profile, home)
  return planClaudeInstall(profile, home)
}

const expandHome = (value: string): string =>
  value === "~" ? homedir() : value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value

const shitRatBlockStart = "<!-- shitrat:start -->"
const shitRatBlockEnd = "<!-- shitrat:end -->"
const preservedLocalInstructionsHeading = "\n---\n\n## Existing Local Instructions Preserved"

const wrapShitRatBlock = (content: string): string =>
  `${shitRatBlockStart}\n${content.trimEnd()}\n${shitRatBlockEnd}\n`

const mergeShitRatBlock = (existing: string | undefined, content: string): string => {
  const block = wrapShitRatBlock(content)
  if (!existing) return block

  const start = existing.indexOf(shitRatBlockStart)
  const end = existing.indexOf(shitRatBlockEnd)
  if (start >= 0 && end > start) {
    return `${existing.slice(0, start)}${block}${existing.slice(end + shitRatBlockEnd.length).replace(/^\n?/, "")}`
  }

  const preservedIndex = existing.indexOf(preservedLocalInstructionsHeading)
  if (preservedIndex >= 0) {
    return `${block}${existing.slice(preservedIndex)}`
  }

  return `${block}\n---\n\n## Existing Local Instructions Preserved\n\n${existing.trimEnd()}\n`
}

const shouldMergeShitRatBlock = (targetPath: string): boolean =>
  path.basename(targetPath) === "APPEND_SYSTEM.md"

const writeInstallPlan = async (
  plan: ReturnType<typeof planInstall>,
): Promise<readonly { path: string; backup_path?: string; action: string }[]> => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const written: { path: string; backup_path?: string; action: string }[] = []

  for (const file of plan.files) {
    const targetPath = expandHome(file.path)
    await mkdir(path.dirname(targetPath), { recursive: true })
    const backupPath = existsSync(targetPath) ? `${targetPath}.shitrat-backup-${timestamp}` : undefined
    const existing = existsSync(targetPath) ? await readFile(targetPath, "utf8") : undefined
    if (backupPath) await copyFile(targetPath, backupPath)
    const nextContent = shouldMergeShitRatBlock(targetPath)
      ? mergeShitRatBlock(existing, file.content)
      : file.content
    await writeFile(targetPath, nextContent, "utf8")
    written.push({
      path: targetPath,
      action: shouldMergeShitRatBlock(targetPath) ? "merge" : file.action,
      ...(backupPath ? { backup_path: backupPath } : {}),
    })
  }

  return written
}

const handleNativeShitRatCommand = async (args: readonly string[]): Promise<boolean> => {
  const subcommand = args[2]
  if (!subcommand || !["compile", "doctor", "install", "update", "profile", "parity"].includes(subcommand)) {
    return false
  }

  try {
    if (subcommand === "compile") {
      const target = optionValue(args, "--target")
      if (!isHarnessTarget(target)) {
        writeStdout(
          json(
            failure(
              args.slice(2).join(" "),
              "Missing or invalid --target. Use codex-desktop, pi, or claude.",
              "INVALID_TARGET",
              "Pass --target codex-desktop, --target pi, or --target claude.",
            ),
          ),
        )
        return true
      }

      const { profile, configPath } = await createProfile(args)
      const compiled = compilePrompt(profile, target)
      writeStdout(json(success(args.slice(2).join(" "), { ...compiled, config_path: configPath })))
      return true
    }

    if (subcommand === "doctor") {
      const maybeTarget = args[3]?.startsWith("--") ? undefined : args[3]
      const target = isHarnessTarget(maybeTarget) ? maybeTarget : "codex-desktop"
      const { profile, configPath } = await createProfile(args)
      const plan = planInstall(profile, target, optionValue(args, "--home"))
      writeStdout(
        json(
          success(args.slice(2).join(" "), {
            target,
            config_path: configPath,
            dry_run: hasFlag(args, "--dry-run"),
            ok: plan.issues.length === 0,
            issues: plan.issues,
            planned_files: plan.files.map((file) => ({ path: file.path, action: file.action })),
            receipts: plan.receipts,
          }),
        ),
      )
      return true
    }

    if (subcommand === "install" || subcommand === "update") {
      const target = args[3]
      if (!isHarnessTarget(target)) {
        writeStdout(
          json(
            failure(
              args.slice(2).join(" "),
              `Missing or invalid ${subcommand} target.`,
              "INVALID_TARGET",
              `Use \`shitrat ${subcommand} codex-desktop --dry-run\` before writing files.`,
            ),
          ),
        )
        return true
      }
      const dryRun = hasFlag(args, "--dry-run")
      const yes = hasFlag(args, "--yes")
      if (!dryRun) {
        if (!yes) {
          writeStdout(
            json(
              failure(
                args.slice(2).join(" "),
                `Real ${subcommand}s require --yes.`,
                "INSTALL_CONFIRMATION_REQUIRED",
                "Run with --dry-run first, inspect planned_files, then rerun with --yes if the plan is correct.",
              ),
            ),
          )
          return true
        }
      }
      const { profile, configPath } = await createProfile(args)
      const plan = planInstall(profile, target, optionValue(args, "--home"))
      if (dryRun) {
        writeStdout(json(success(args.slice(2).join(" "), { ...plan, config_path: configPath, dry_run: true })))
        return true
      }

      const written_files = await writeInstallPlan(plan)
      writeStdout(
        json(
          success(args.slice(2).join(" "), {
            target,
            command: subcommand,
            config_path: configPath,
            dry_run: false,
            written_files,
            receipts: plan.receipts,
          }),
        ),
      )
      return true
    }

    if (subcommand === "profile" && args[3] === "doctor") {
      const configPath = resolveConfigPath(args)
      const manifestPath = configPath ? path.join(configPath, "shitrat.config.json") : undefined
      writeStdout(
        json(
          success(args.slice(2).join(" "), {
            config_path: configPath,
            manifest_path: manifestPath,
            manifest_exists: manifestPath ? existsSync(manifestPath) : false,
            next: "Create shitrat.config.json with identity overrides to customize the familiar.",
          }),
        ),
      )
      return true
    }

    if (subcommand === "parity") {
      const { profile, configPath } = await createProfile(args)
      writeStdout(
        json(
          success(args.slice(2).join(" "), {
            config_path: configPath,
            report: parityReport(profile, harnessTargets),
          }),
        ),
      )
      return true
    }
  } catch (error) {
    writeStdout(
      json(
        failure(
          args.slice(2).join(" "),
          errorMessage(error),
          "SHITRAT_NATIVE_COMMAND_ERROR",
          "Inspect the config path and retry with --dry-run.",
        ),
      ),
    )
    process.exitCode = 1
    return true
  }

  return false
}

const capturedStdout: string[] = []
const capturedStderr: string[] = []
const rawStdoutWrite = process.stdout.write.bind(process.stdout)
const rawStderrWrite = process.stderr.write.bind(process.stderr)
const rawConsoleLog = console.log.bind(console)
const rawConsoleError = console.error.bind(console)
const rawConsoleWarn = console.warn.bind(console)
const rawConsoleInfo = console.info.bind(console)

process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
  capturedStdout.push(String(chunk))
  const callback = args.find((arg) => typeof arg === "function") as
    | ((error?: Error | null) => void)
    | undefined
  callback?.()
  return true
}) as typeof process.stdout.write

process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
  capturedStderr.push(String(chunk))
  const callback = args.find((arg) => typeof arg === "function") as
    | ((error?: Error | null) => void)
    | undefined
  callback?.()
  return true
}) as typeof process.stderr.write

console.log = (...args: unknown[]) => {
  capturedStdout.push(`${args.map(String).join(" ")}\n`)
}

console.error = (...args: unknown[]) => {
  capturedStderr.push(`${args.map(String).join(" ")}\n`)
}

console.warn = (...args: unknown[]) => {
  capturedStderr.push(`${args.map(String).join(" ")}\n`)
}

console.info = (...args: unknown[]) => {
  capturedStdout.push(`${args.map(String).join(" ")}\n`)
}

const restoreOutput = () => {
  process.stdout.write = rawStdoutWrite as typeof process.stdout.write
  process.stderr.write = rawStderrWrite as typeof process.stderr.write
  console.log = rawConsoleLog
  console.error = rawConsoleError
  console.warn = rawConsoleWarn
  console.info = rawConsoleInfo
}

const writeStdout = (text: string) => {
  rawStdoutWrite(text.endsWith("\n") ? text : `${text}\n`)
}

if (await handleNativeShitRatCommand(argv)) {
  process.exit()
}

const run = cli(argv).pipe(Effect.provide(BunContext.layer))

Effect.runPromise(run)
  .then(() => {
    restoreOutput()
    const stdout = capturedStdout.join("")
    const stderr = capturedStderr.join("")
    if (isJsonEnvelope(stdout)) {
      writeStdout(stdout)
      return
    }

    if (argv[2] === "inbox" && argv[3] === "pull" && argv.includes("--format") && argv.includes("ndjson")) {
      writeStdout(stdout)
      return
    }

    writeStdout(
      json(
        success(commandString(), {
          stdout: stripAnsi(stdout).trim(),
          stderr: stripAnsi(stderr).trim() || undefined,
        }),
      ),
    )
  })
  .catch((error: unknown) => {
    restoreOutput()
    const stderr = stripAnsi(capturedStderr.join("")).trim()
    writeStdout(
      json(
        failure(
          commandString(),
          stderr || errorMessage(error),
          "CLI_USAGE_ERROR",
          "Run `shitrat` with no args for JSON command discovery, or pass valid command arguments.",
          [
            {
              command: "shitrat",
              description: "Show JSON command discovery output",
            },
          ],
        ),
      ),
    )
    process.exitCode = 1
  })
