import { describe, expect, test } from "bun:test"
import { collectComponents, compilePrompt, validateProfile } from "@joelhooks/shitrat-core"
import { createShitRatDefaultProfile, shitratCodexPetAsset } from "../src/index.js"

describe("public ShitRat defaults", () => {
  test("compile for Codex Desktop without hard-law gaps", () => {
    const profile = createShitRatDefaultProfile()
    const issues = validateProfile(profile)
    const compiled = compilePrompt(profile, "codex-desktop")

    expect(issues).toEqual([])
    expect(compiled.text).toContain("ShitRat")
    expect(compiled.text).toContain("TOOLS: Codex Desktop")
    expect(compiled.text).not.toContain("Joel")
  })

  test("allow familiar identity customization", () => {
    const profile = createShitRatDefaultProfile({ name: "ClawRat", emoji: "claw" })
    const compiled = compilePrompt(profile, "pi")

    expect(compiled.text).toContain("claw ClawRat")
  })

  test("ship semantic components", () => {
    const components = collectComponents(createShitRatDefaultProfile())
    const types = new Set(components.map((component) => component.type))

    expect(types.has("Identity")).toBe(true)
    expect(types.has("Rule")).toBe(true)
    expect(types.has("ToolPolicy")).toBe(true)
    expect(types.has("BrainPolicy")).toBe(true)
  })

  test("publish the Codex Desktop pet asset contract", () => {
    expect(shitratCodexPetAsset.id).toBe("shitrat")
    expect(shitratCodexPetAsset.manifestPath).toBe("assets/codex-pets/shitrat/pet.json")
    expect(shitratCodexPetAsset.spritesheetPath).toBe("assets/codex-pets/shitrat/spritesheet.webp")
  })
})
