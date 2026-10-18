import { describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const target = "a".repeat(40)
const tagSha = "b".repeat(40)
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } })
type Request = { route: string; body?: unknown }
const run = async (command: "tag" | "release", args: string[] = [], scenario = "happy", tagInput = { name: "v0.1.0", target }) => {
  const home = await mkdtemp(path.join(tmpdir(), "shitrat-releases-test-"))
  try {
    const audit = path.join(home, "audit.json")
    await writeFile(path.join(home, "notes.md"), "Release notes\n")
    const argv = command === "tag" ? ["--name", tagInput.name, "--target", tagInput.target] : ["--tag", "v0.1.0"]
    const proc = Bun.spawn([process.execPath, "--preload", path.join(import.meta.dir, "fixtures/releases-preload.ts"), path.join(import.meta.dir, "../src/cli.ts"), command, "example/project", ...argv, ...args.map((arg) => arg === "NOTES_FILE" ? path.join(home, "notes.md") : arg)], {
      env: { PATH: process.env.PATH, HOME: home, SHITRAT_GITHUB_APP_ID: "123", SHITRAT_GITHUB_PRIVATE_KEY: privateKey, SHITRAT_GITHUB_CLIENT_ID: "test-client", SHITRAT_GITHUB_INSTALLATIONS_JSON: '{"example":123}', RELEASE_TEST_AUDIT: audit, RELEASE_TEST_COMMAND: command, RELEASE_TEST_SCENARIO: scenario },
      stdout: "pipe", stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    expect(stdout + stderr).not.toContain("FAKE-INSTALLATION-TOKEN")
    expect(stdout + stderr).not.toContain(privateKey)
    const requests: Request[] = JSON.parse(await readFile(audit, "utf8"))
    const writes = requests.filter((request) => request.route.startsWith("POST /repos/"))
    return { stdout, envelope: JSON.parse(stdout), stderr, exitCode, requests, writes }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}
const tagPayload = { tag: "v0.1.0", message: "v0.1.0", object: target, type: "commit", tagger: { name: "shitratgit[bot]", email: "286405550+shitratgit[bot]@users.noreply.github.com", date: "2026-10-18T12:00:00.000Z" } }
const releasePayload = { tag_name: "v0.1.0", name: "v0.1.0", generate_release_notes: false, draft: false, prerelease: false }

for (const command of ["tag", "release"] as const) describe(`${command} CLI`, () => {
  for (const args of [[], ["--dry-run"]]) test(`defaults to preview and makes no repository writes (${args.join(" ") || "no confirmation"})`, async () => {
    const result = await run(command, args)
    expect(result.exitCode).toBe(0)
    expect(result.writes).toEqual([])
    expect(result.envelope).toMatchObject({ ok: true, command: `shitrat ${command} example/project`, result: { dry_run: true, github_write: false, created: false, actor: "shitratgit[bot]" } })
    expect(result.envelope.next_actions.length).toBeGreaterThan(0)
    if (command === "tag") {
      expect(result.envelope.result.tag_object_payload).toEqual(tagPayload)
      expect(result.envelope.result.ref_payload).toEqual({ ref: "refs/tags/v0.1.0", sha: "<created-tag-object-sha>" })
    } else expect(result.envelope.result.payload).toEqual(releasePayload)
  })
  test("refuses contradictory confirmation flags before authenticating", async () => {
    const result = await run(command, ["--yes", "--dry-run"])
    expect(result.exitCode).not.toBe(0)
    expect(result.envelope.error.code).toBe("INVALID_CONFIRMATION")
    expect(result.requests).toEqual([])
  })
})

describe("annotated tag safety", () => {
  for (const invalid of ["abc123", "main", "g".repeat(40)]) test(`refuses non-full commit SHA ${invalid}`, async () => {
    const result = await run("tag", ["--yes"], "happy", { name: "v0.1.0", target: invalid })
    expect(result.exitCode).not.toBe(0)
    expect(result.envelope.error.code).toBe("INVALID_TARGET_SHA")
    expect(result.writes).toEqual([])
  })
  for (const name of ["bad..tag", "refs/tags/v1", "bad.lock", "bad/.tag", "bad tag"]) test(`refuses invalid tag ${name}`, async () => {
    const result = await run("tag", ["--yes"], "happy", { name, target })
    expect(result.exitCode).not.toBe(0)
    expect(result.envelope.error.code).toBe("INVALID_TAG")
    expect(result.writes).toEqual([])
  })
  for (const scenario of ["existing-tag-same", "existing-tag-different", "existing-tag-annotation"]) test(`refuses ${scenario} without writing, even when confirmed`, async () => {
    const result = await run("tag", ["--yes"], scenario)
    expect(result.exitCode).not.toBe(0)
    expect(result.envelope).toMatchObject({ ok: false, error: { code: "TAG_EXISTS" } })
    expect(result.writes).toEqual([])
  })
  test("refuses unknown full target SHA", async () => {
    const result = await run("tag", ["--yes"], "unknown-target")
    expect(result.exitCode).not.toBe(0)
    expect(result.envelope.error.code).toBe("TARGET_NOT_FOUND")
    expect(result.writes).toEqual([])
  })
  test("creates exactly the annotation and create-only ref, then reads both back", async () => {
    const result = await run("tag", ["--message", "Release v0.1.0", "--yes"])
    expect(result.exitCode).toBe(0)
    expect(result.writes).toEqual([
      { route: "POST /repos/example/project/git/tags", body: { ...tagPayload, message: "Release v0.1.0" } },
      { route: "POST /repos/example/project/git/refs", body: { ref: "refs/tags/v0.1.0", sha: tagSha } },
    ])
    expect(result.requests.slice(-2).map((r) => r.route)).toEqual(["GET /repos/example/project/git/ref/tags/v0.1.0", `GET /repos/example/project/git/tags/${tagSha}`])
    expect(result.envelope.result).toMatchObject({ created: true, github_write: true, tag_object_sha: tagSha, target })
  })
  for (const scenario of ["tag-ref-mismatch", "tag-message-mismatch", "tag-target-mismatch"]) test(`reports ${scenario} without rollback`, async () => {
    const result = await run("tag", ["--yes"], scenario)
    expect(result.exitCode).not.toBe(0)
    expect(result.envelope.error.code).toBe("TAG_READBACK_MISMATCH")
    expect(result.writes).toHaveLength(2)
    expect(result.requests.some((r) => /^(PATCH|DELETE) /.test(r.route))).toBe(false)
  })
  test("a concurrent tag creator fails closed; no update or delete", async () => {
    const result = await run("tag", ["--yes"], "tag-race")
    expect(result.exitCode).not.toBe(0)
    expect(result.envelope.error.code).toBe("GITHUB_REQUEST_FAILED")
    expect(result.requests.some((r) => /^(PATCH|DELETE) /.test(r.route))).toBe(false)
  })
  test("permission failures are not mistaken for absence", async () => {
    const result = await run("tag", ["--yes"], "permission-denied")
    expect(result.exitCode).not.toBe(0)
    expect(result.envelope.error.code).toBe("GITHUB_REQUEST_FAILED")
    expect(result.writes).toEqual([])
  })
})

describe("release safety", () => {
  for (const [scenario, code] of [["missing-tag", "TAG_NOT_FOUND"], ["duplicate-release", "RELEASE_EXISTS"], ["duplicate-draft", "RELEASE_EXISTS"], ["duplicate-page-two", "RELEASE_EXISTS"], ["list-permission-denied", "GITHUB_REQUEST_FAILED"]]) test(`refuses ${scenario} without writing`, async () => {
    const result = await run("release", ["--yes"], scenario)
    expect(result.exitCode).not.toBe(0)
    expect(result.envelope.error.code).toBe(code)
    expect(result.writes).toEqual([])
  })
  for (const scenario of ["tag-deleted-during-preflight", "tag-changed-during-preflight"]) test(`refuses ${scenario}`, async () => {
    const result = await run("release", ["--yes"], scenario)
    expect(result.exitCode).not.toBe(0)
    expect(result.envelope.error.code).toBe("TAG_CHANGED")
    expect(result.writes).toEqual([])
  })
  test("creates with exact notes, title and flags, then reads by id (including drafts)", async () => {
    const result = await run("release", ["--notes-file", "NOTES_FILE", "--title", "First release", "--draft", "--prerelease", "--yes"])
    expect(result.exitCode).toBe(0)
    expect(result.writes).toEqual([{ route: "POST /repos/example/project/releases", body: { ...releasePayload, name: "First release", body: "Release notes\n", draft: true, prerelease: true } }])
    expect(result.requests.at(-1)?.route).toBe("GET /repos/example/project/releases/7")
    expect(result.envelope.result).toMatchObject({ created: true, github_write: true, id: 7 })
  })
  test("generated notes are requested only on confirmed creation", async () => {
    const preview = await run("release", ["--generate-notes"])
    expect(preview.writes).toEqual([])
    expect(preview.envelope.result.payload).toEqual({ ...releasePayload, generate_release_notes: true })
    const written = await run("release", ["--generate-notes", "--yes"])
    expect(written.exitCode).toBe(0)
    expect(written.writes).toEqual([{ route: "POST /repos/example/project/releases", body: { ...releasePayload, generate_release_notes: true } }])
  })
  test("notes-file and generated notes are mutually exclusive, before authentication", async () => {
    const result = await run("release", ["--notes-file", "NOTES_FILE", "--generate-notes", "--yes"])
    expect(result.exitCode).not.toBe(0)
    expect(result.envelope.error.code).toBe("INVALID_RELEASE_NOTES")
    expect(result.requests).toEqual([])
  })
  for (const scenario of ["release-mismatch", "release-body-mismatch", "release-draft-mismatch"]) test(`reports ${scenario}`, async () => {
    const result = await run("release", ["--yes"], scenario)
    expect(result.exitCode).not.toBe(0)
    expect(result.envelope.error.code).toBe("RELEASE_READBACK_MISMATCH")
    expect(result.writes).toHaveLength(1)
  })
})
