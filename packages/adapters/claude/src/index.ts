import { compilePrompt, validateProfile, type FamiliarProfile } from "@joelhooks/shitrat-core"

export const planClaudeInstall = (profile: FamiliarProfile, claudeHome = "~/.claude") => {
  const compiled = compilePrompt(profile, "claude")
  return {
    target: "claude" as const,
    files: [{ path: `${claudeHome}/CLAUDE.md`, action: "update" as const, content: compiled.text }],
    issues: validateProfile(profile).map((issue) => issue.message),
    receipts: compiled.receipts,
  }
}
