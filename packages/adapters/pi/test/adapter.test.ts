import { describe, expect, test } from "bun:test"
import { createShitRatDefaultProfile } from "@joelhooks/shitrat-defaults"
import { planPiInstall } from "../src/index.js"

describe("Pi adapter", () => {
  test("plans an APPEND_SYSTEM.md update", () => {
    const plan = planPiInstall(createShitRatDefaultProfile(), "/tmp/pi")

    expect(plan.files[0]?.path).toBe("/tmp/pi/APPEND_SYSTEM.md")
    expect(plan.files[0]?.content).toContain("TOOLS: Pi")
    expect(plan.issues).toEqual([])
  })
})
