import { describe, expect, test } from "bun:test"
import { parseRepo } from "../src/github-app.js"
import { failure, success } from "../src/response.js"

describe("response envelope", () => {
  test("normalizes commands", () => {
    const envelope = success("status joelhooks/shitrat-cli", { ok: true })
    expect(envelope.command).toBe("shitrat status joelhooks/shitrat-cli")
    expect(envelope.ok).toBe(true)
  })

  test("normalizes next actions", () => {
    const envelope = failure("comment", "boom", "NOPE", "fix it", [
      { command: "status <repo>", description: "check repo" },
    ])
    expect(envelope.next_actions[0]?.command).toBe("shitrat status <repo>")
    expect(envelope.error.code).toBe("NOPE")
  })
})

describe("github repo parsing", () => {
  test("parses owner/repo", () => {
    expect(parseRepo("skillrecordings/migrate-egghead")).toEqual({
      owner: "skillrecordings",
      repo: "migrate-egghead",
      fullName: "skillrecordings/migrate-egghead",
    })
  })

  test("rejects loose names", () => {
    expect(() => parseRepo("migrate-egghead")).toThrow("Invalid repo")
  })
})
