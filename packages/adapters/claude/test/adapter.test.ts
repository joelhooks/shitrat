import { describe, expect, test } from "bun:test"
import { createShitRatDefaultProfile } from "@joelhooks/shitrat-defaults"
import { planClaudeInstall } from "../src/index.js"

describe("Claude adapter", () => {
  test("plans a CLAUDE.md update", () => {
    const plan = planClaudeInstall(createShitRatDefaultProfile(), "/tmp/claude")

    expect(plan.files[0]?.path).toBe("/tmp/claude/CLAUDE.md")
    expect(plan.files[0]?.content).toContain("TOOLS: Claude")
    expect(plan.issues).toEqual([])
  })
})
