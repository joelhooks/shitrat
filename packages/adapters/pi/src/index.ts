import { compilePrompt, validateProfile, type FamiliarProfile } from "@joelhooks/shitrat-core"

export const planPiInstall = (profile: FamiliarProfile, piHome = "~/.pi/agent") => {
  const compiled = compilePrompt(profile, "pi")
  return {
    target: "pi" as const,
    files: [{ path: `${piHome}/APPEND_SYSTEM.md`, action: "update" as const, content: compiled.text }],
    issues: validateProfile(profile).map((issue) => issue.message),
    receipts: compiled.receipts,
  }
}
