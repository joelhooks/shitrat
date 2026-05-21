import { compilePrompt, validateProfile, type FamiliarProfile } from "@joelhooks/shitrat-core"

export interface CodexDesktopPlan {
  readonly target: "codex-desktop"
  readonly files: readonly {
    readonly path: string
    readonly action: "write" | "update"
    readonly content: string
  }[]
  readonly issues: readonly string[]
  readonly receipts: readonly string[]
}

export const planCodexDesktopInstall = (
  profile: FamiliarProfile,
  codexHome = "~/.codex",
): CodexDesktopPlan => {
  const compiled = compilePrompt(profile, "codex-desktop")
  const issues = validateProfile(profile).map((issue) => issue.message)

  return {
    target: "codex-desktop",
    files: [
      {
        path: `${codexHome}/AGENTS.md`,
        action: "update",
        content: compiled.text,
      },
    ],
    issues,
    receipts: compiled.receipts,
  }
}
