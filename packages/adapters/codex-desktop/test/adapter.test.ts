import { describe, expect, test } from "bun:test"
import { createShitRatDefaultProfile } from "@joelhooks/shitrat-defaults"
import { planCodexDesktopInstall } from "../src/index.js"

describe("Codex Desktop adapter", () => {
  test("plans an AGENTS.md update without writing files", () => {
    const plan = planCodexDesktopInstall(createShitRatDefaultProfile(), "/tmp/codex")

    expect(plan.files[0]?.path).toBe("/tmp/codex/AGENTS.md")
    expect(plan.files[0]?.content).toContain("TOOLS: Codex Desktop")
    expect(plan.issues).toEqual([])
  })
})
