import { describe, expect, test } from "bun:test"
import {
  collectComponents,
  compilePrompt,
  composeProfiles,
  createPromptModule,
  parityReport,
  validateProfile,
} from "../src/index.js"

const hardLaws = createPromptModule({
  id: "hard-laws",
  title: "Hard Laws",
  body: `
<Rule id="receipt-first">Inspect receipts before claims.</Rule>
<Rule id="preserve-user-work">Do not overwrite unrelated user work.</Rule>
<Rule id="public-private-boundary">Do not leak private overlays.</Rule>
<Rule id="harness-honesty">Only reference available harness tools.</Rule>
<Rule id="familiar-consistency">Preserve configured identity.</Rule>
<Rule id="brain-first-context">Capture durable context in Brain when useful.</Rule>
`,
})

describe("semantic context core", () => {
  test("composes overlays with deterministic precedence", () => {
    const base = {
      identity: { name: "ShitRat", emoji: "rat" },
      modules: [hardLaws, createPromptModule({ id: "style", body: "sharp" })],
    }
    const overlay = {
      identity: { name: "DeskRat" },
      modules: [createPromptModule({ id: "style", body: "quiet" })],
    }

    const composed = composeProfiles(base, overlay)

    expect(composed.identity.name).toBe("DeskRat")
    expect(composed.identity.emoji).toBe("rat")
    expect(composed.modules.find((module) => module.id === "style")?.body).toBe("quiet")
  })

  test("validates hard-law coverage", () => {
    const issues = validateProfile({
      identity: { name: "ShitRat" },
      modules: [createPromptModule({ id: "empty", body: "hello" })],
    })

    expect(issues.some((issue) => issue.code === "MISSING_HARD_LAW")).toBe(true)
  })

  test("collects semantic components and compiles prompt text", () => {
    const profile = {
      identity: { name: "ShitRat", emoji: "rat" },
      modules: [
        hardLaws,
        createPromptModule({
          id: "tools-codex",
          title: "Codex Tools",
          scope: "codex-desktop" as const,
          sourcePath: "tools/codex-desktop.svx",
          body: '<ToolPolicy id="codex-computer-use">Use computer-use when visual truth matters.</ToolPolicy>',
        }),
      ],
    }

    const compiled = compilePrompt(profile, "codex-desktop")

    expect(collectComponents(profile).map((component) => component.type)).toContain("ToolPolicy")
    expect(compiled.text).toContain("rat ShitRat")
    expect(compiled.text).toContain("Codex Tools")
    expect(compiled.receipts).toEqual(["tools/codex-desktop.svx"])
    expect(compiled.componentTypes).toContain("Rule")
  })

  test("reports parity issues per target", () => {
    const report = parityReport(
      {
        identity: { name: "ShitRat" },
        modules: [hardLaws],
      },
      ["codex-desktop", "pi", "claude"],
    )

    expect(report["codex-desktop"]).toEqual([])
    expect(report.pi).toEqual([])
    expect(report.claude).toEqual([])
  })
})
