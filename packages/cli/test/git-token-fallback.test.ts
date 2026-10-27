import { describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { GIT_TOKEN_FALLBACK_END, githubGitUrl, gitTokenFallbackEnabled, isGitHubTokenRefusal } from "../src/git-token-fallback.js"

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } })
const realGit = Bun.which("git")!
const fakeGit = `#!/bin/sh
for arg in "$@"; do
  case "$arg" in *FAKE-*) echo 'Token in argv' >&2; exit 98;; esac
done
while [ "$1" = -c ]; do shift; shift; done
op=$1
case "$op" in
  fetch|push)
    scope=repository
    [ "$SHITRAT_PUSH_TOKEN" = FAKE-FULL-TOKEN ] && scope=installation
    printf 'git %s %s\\n' "$op" "$scope" >> "$GIT_TOKEN_TEST_AUDIT"
    case " $* " in *' https://github.com/example/project.git '*) ;; *) echo 'Unsafe target' >&2; exit 97;; esac
    if [ "$op" = fetch ]; then
      case "$GIT_TOKEN_TEST_SCENARIO" in push-*|empty-*|repository) exit 0;; esac
    fi
    if [ "$op" = push ]; then
      case "$GIT_TOKEN_TEST_SCENARIO" in push-*|empty-*|both-stages) ;; *) exit 0;; esac
    fi
    case "$GIT_TOKEN_TEST_SCENARIO" in
      repository) exit 0;;
      *non-fast-forward) echo 'rejected (non-fast-forward)' >&2; exit 1;;
      network) echo 'Could not resolve host: github.com' >&2; exit 1;;
      generic-403) echo 'The requested URL returned error: 403' >&2; exit 1;;
      wrong-bot) echo 'remote: Permission to example/project.git denied to someone-else.' >&2; echo 'fatal: The requested URL returned error: 403' >&2; exit 1;;
    esac
    if [ "$scope" = installation ]; then
      # Deliberately emit the dummy token to prove redaction in both streams.
      printf '%s\\n' "$SHITRAT_PUSH_TOKEN" >&2
      printf '%s\\n' "$SHITRAT_PUSH_TOKEN"
      case "$GIT_TOKEN_TEST_SCENARIO" in *-both|*-both-revoke-fails) exit 1;; *) exit 0;; esac
    fi
    case "$GIT_TOKEN_TEST_SCENARIO" in
      push-*|empty-*) echo 'remote: Permission to example/project.git denied to shitratgit[bot].' >&2; echo 'fatal: The requested URL returned error: 403' >&2;;
      *) echo 'remote: Repository not found.' >&2;;
    esac
    echo "$SHITRAT_PUSH_TOKEN" >&2
    exit 1;;
esac
exec "$GIT_TOKEN_TEST_REAL_GIT" "$@"
`

const run = async (scenario: string, origin = "https://github.com/example/project.git") => {
  const home = await mkdtemp(path.join(tmpdir(), "shitrat-token-test-"))
  const audit = path.join(home, "audit.txt")
  const env = {
    ...process.env, HOME: home, XDG_STATE_HOME: path.join(home, ".local/state"), PATH: `${home}:${process.env.PATH}`,
    GIT_TOKEN_TEST_REAL_GIT: realGit, GIT_TOKEN_TEST_SCENARIO: scenario, GIT_TOKEN_TEST_AUDIT: audit,
    SHITRAT_GITHUB_APP_ID: "123", SHITRAT_GITHUB_PRIVATE_KEY: privateKey, SHITRAT_GITHUB_INSTALLATIONS_JSON: '{"example":123}',
    FLEET_ATTEST: "off", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  }
  const git = async (...args: string[]) => {
    const proc = Bun.spawn([realGit, ...args], { cwd: home, env, stdout: "pipe", stderr: "pipe" })
    const code = await proc.exited
    if (code !== 0) throw new Error(await new Response(proc.stderr).text())
  }
  try {
    await writeFile(audit, "")
    if (scenario === "counter-symlink") {
      const dir = path.join(home, ".local/state/shitrat")
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await writeFile(path.join(home, "untouched"), "prior\n")
      await symlink(path.join(home, "untouched"), path.join(dir, "git-token-fallback.jsonl"))
    }
    await writeFile(path.join(home, "git"), fakeGit, { mode: 0o700 })
    await git("init", "-b", "main")
    await git("remote", "add", "origin", origin)
    await writeFile(path.join(home, "README.md"), "fixture\n")
    await git("add", "README.md")
    await git("-c", "user.name=shitratgit[bot]", "-c", "user.email=286405550+shitratgit[bot]@users.noreply.github.com", "commit", "-m", "fixture")
    const args = scenario.startsWith("empty-")
      ? ["commit-files", "example/project", "--branch", "main", "--message", "fixture", "--file", "README.md"]
      : ["push", "example/project", "--repo-dir", home]
    const proc = Bun.spawn([process.execPath, "--preload", path.join(import.meta.dir, "fixtures/git-token-preload.ts"), path.join(import.meta.dir, "../src/cli.ts"), ...args], { cwd: home, env, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    const events = (await readFile(audit, "utf8")).trim().split("\n").filter(Boolean)
    const log = await readFile(path.join(home, ".local/state/shitrat/git-token-fallback.jsonl"), "utf8").catch(() => "")
    for (const text of [stdout, stderr, log, events.join("\n")]) {
      expect(text).not.toContain("FAKE-SCOPED-TOKEN")
      expect(text).not.toContain("FAKE-FULL-TOKEN")
      expect(text).not.toContain(privateKey)
    }
    if (!stdout) throw new Error(`CLI emitted no JSON: ${stderr}`)
    const counterPath = path.join(home, ".local/state/shitrat/git-token-fallback.jsonl")
    const logMode = await stat(counterPath).then((s) => s.mode & 0o777).catch(() => null)
    const untouched = await readFile(path.join(home, "untouched"), "utf8").catch(() => "")
    return { envelope: JSON.parse(stdout), events, log: scenario === "counter-symlink" ? [] : log.trim() ? log.trim().split("\n").map((line) => JSON.parse(line)) : [], exitCode, stderr, logMode, untouched }
  } finally { await rm(home, { recursive: true, force: true }) }
}

describe("git repository token fallback (CLI, fake git and HTTP)", () => {
  for (const scenario of ["fetch-refusal", "push-refusal", "empty-refusal"]) test(`${scenario}: scoped first, verify target, full token once, then revoke`, async () => {
    const r = await run(scenario)
    expect(r.envelope).toMatchObject({ ok: true, result: { tokenScope: "installation", fallbackUsed: true } })
    expect(r.envelope.result.note).toContain("retried once")
    const op = scenario === "fetch-refusal" ? "fetch" : "push"
    const scoped = r.events.indexOf(`git ${op} repository`)
    expect(r.events.slice(scoped, scoped + 5)).toEqual([`git ${op} repository`, "GET /repos/example/project", "mint installation", `git ${op} installation`, "revoke installation"])
    expect(r.events.filter((e) => e === "mint installation")).toHaveLength(1)
    // Fetch's full token is revoked before the push, which starts scoped again.
    if (scenario === "fetch-refusal") expect(r.events.at(-1)).toBe("git push repository")
    expect(r.log).toEqual([{ timestamp: "2026-10-27T08:00:00.000Z", repo: "example/project", outcome: "succeeded" }])
    expect(r.logMode).toBe(0o600)
    expect(r.exitCode).toBe(0)
  })
  for (const scenario of ["fetch-both", "push-both", "empty-both", "push-both-revoke-fails"]) test(`${scenario}: both attempts fail, revoke and report`, async () => {
    const r = await run(scenario)
    expect(r.envelope.ok).toBe(false)
    if (!scenario.startsWith("empty-")) expect(r.envelope.error.code).toBe("PUSH_FAILED")
    expect(r.envelope.error.message).toContain("Both repository-scoped and installation-token git attempts failed")
    expect(r.envelope.fallbackUsed).toBe(true)
    expect(r.events.filter((e) => e === "mint installation")).toHaveLength(1)
    expect(r.events.at(-1)).toBe("revoke installation")
    expect(r.log[0].outcome).toBe("failed")
    if (scenario.includes("revoke-fails")) expect(r.envelope.warnings[0]).toContain("revocation failed")
  })
  for (const scenario of ["fetch-non-fast-forward", "push-non-fast-forward", "empty-non-fast-forward", "network", "generic-403", "wrong-bot"]) test(`${scenario}: no broader token, no retry`, async () => {
    const r = await run(scenario)
    expect(r.envelope.ok).toBe(false)
    expect(r.envelope.error.message).not.toContain("CLI_USAGE_ERROR")
    expect(r.events.some((e) => e.startsWith("git "))).toBe(true)
    expect(r.envelope.fallbackUsed).toBe(false)
    expect(r.events).not.toContain("mint installation")
    expect(r.events).not.toContain("GET /repos/example/project")
    expect(r.log).toEqual([])
  })
  for (const scenario of ["wrong-repo", "no-permission", "rest-fails", "expired"]) test(`${scenario}: refuses before broader mint`, async () => {
    const r = await run(scenario)
    expect(r.envelope.ok).toBe(false)
    expect(r.envelope.fallbackUsed).toBe(false)
    expect(r.events).not.toContain("mint installation")
    expect(r.log).toEqual([])
    if (scenario === "expired") expect(r.envelope.error.message).toContain("recheck GitHub")
  })
  test("revoke failure warns without changing push success", async () => {
    const r = await run("revoke-fails")
    expect(r.envelope.ok).toBe(true)
    expect(r.envelope.result.warnings[0]).toContain("revocation failed")
    expect(r.events).toContain("revoke installation")
    expect(r.log[0].outcome).toBe("succeeded")
  })
  test("both stages independently start scoped and revoke each full token before continuing", async () => {
    const r = await run("both-stages")
    expect(r.envelope.ok).toBe(true)
    expect(r.events).toEqual(["mint repository", "git fetch repository", "GET /repos/example/project", "mint installation", "git fetch installation", "revoke installation", "git push repository", "GET /repos/example/project", "mint installation", "git push installation", "revoke installation"])
    expect(r.log).toHaveLength(2)
  })
  test("counter refuses a symlink and warns without failing the push", async () => {
    const r = await run("counter-symlink")
    expect(r.envelope.ok).toBe(true)
    expect(r.envelope.result.warnings).toContain("Could not append the local git token fallback counter.")
    expect(r.untouched).toBe("prior\n")
    expect(r.events).toContain("revoke installation")
  })
  test("repository token success never verifies, mints broadly or logs", async () => {
    const r = await run("repository")
    expect(r.envelope).toMatchObject({ ok: true, result: { tokenScope: "repository", fallbackUsed: false } })
    expect(r.events).toEqual(["mint repository", "git fetch repository", "git push repository"])
    expect(r.log).toEqual([])
  })
  for (const origin of ["https://user:password@github.com/example/project.git", "https://not-github.com/example/project.git"]) test(`refuse unsafe origin ${new URL(origin).host}`, async () => {
    const r = await run("fetch-refusal", origin)
    expect(r.envelope.ok).toBe(false)
    expect(r.events).toEqual([])
  })
})

test("fallback expiry property: the entire UTC removal day is allowed, nothing after", () => {
  expect(new Date(GIT_TOKEN_FALLBACK_END).toISOString()).toBe("2026-11-11T00:00:00.000Z")
  expect(gitTokenFallbackEnabled(GIT_TOKEN_FALLBACK_END - 1)).toBe(true)
  expect(gitTokenFallbackEnabled(GIT_TOKEN_FALLBACK_END)).toBe(false)
  // Deterministic generated offsets across hours, days and years, on both sides.
  let seed = 42
  for (let i = 0; i < 1000; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const offset = seed * 1000 + 1
    expect(gitTokenFallbackEnabled(GIT_TOKEN_FALLBACK_END - offset)).toBe(true)
    expect(gitTokenFallbackEnabled(GIT_TOKEN_FALLBACK_END + offset)).toBe(false)
  }
  expect(gitTokenFallbackEnabled(NaN)).toBe(false)
})

test("target URL cannot carry credentials, a host, or path escapes", () => {
  expect(githubGitUrl("example/project")).toBe("https://github.com/example/project.git")
  for (const repo of ["https://evil.test/a", "user@github.com/repo", "example/..", "../project", "example/project?x", "example/project#x", "example/project/path"]) expect(() => githubGitUrl(repo)).toThrow()
})

test("auth classifier only recognizes the target bot's GitHub refusal", () => {
  expect(isGitHubTokenRefusal(new Error("remote: Repository not found."), "example/project")).toBe(true)
  expect(isGitHubTokenRefusal(new Error("remote: Permission to example/project.git denied to shitratgit[bot].\nfatal: HTTP 403"), "example/project")).toBe(true)
  for (const message of ["non-fast-forward", "HTTP 403", "remote: Permission to other/project.git denied to shitratgit[bot].\nfatal: HTTP 403", "remote: Permission to example/project.git denied to other.\nfatal: HTTP 403"]) expect(isGitHubTokenRefusal(new Error(message), "example/project")).toBe(false)
})
