import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { readOutgoingPatches, resolvePushPlan, type PushRepository } from "../src/git-push.js"
import {
  GuardConfigError,
  judge,
  loadGuardConfig,
  logWaivers,
  rulesFor,
  scanMessage,
  scanPatch,
  type GuardFinding,
} from "../src/public-push-guard.js"

// Secret shapes, home paths and tailnet names are assembled at runtime so this file,
// which ships in a public repo, never carries one literally.
const ghToken = ["gh", "p_", "Ab3".repeat(12)].join("")
const homePath = ["", "Us" + "ers", "someone", "Code", "x"].join("/")
const tailnetName = ["box", "tailabcde", "ts", "net"].join(".")
const tailnetIp = [100, 99, 1, 2].join(".")
const pemHeader = ["-----BEGIN", "OPENSSH", "PRIVATE", "KEY-----"].join(" ")

const bot = ["-c", "user.name=shitratgit[bot]", "-c", "user.email=286405550+shitratgit[bot]@users.noreply.github.com"]
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const git = async (cwd: string, ...args: string[]) => {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`)
  return out.trim()
}

/** A real repo whose first commit counts as already pushed (refs/remotes/origin/main). */
const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shitrat-guard-"))
  dirs.push(root)
  await git(root, "init", "-q", "-b", "main")
  await writeFile(path.join(root, "README.md"), "# demo\n")
  await git(root, "add", "README.md")
  await git(root, ...bot, "commit", "-q", "-m", "init")
  await git(root, "update-ref", "refs/remotes/origin/main", "HEAD")
  const commit = async (files: Record<string, string | Uint8Array>, message = "change", remove: string[] = []) => {
    for (const [name, body] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true })
      await writeFile(path.join(root, name), body)
      await git(root, "add", "--", name)
    }
    for (const name of remove) await git(root, "rm", "-q", "--", name)
    await git(root, ...bot, "commit", "-q", "-m", message)
  }
  const scan = async (config = { privateHostnames: [] as string[] }) => {
    const repository: PushRepository = { repo: "example/public", gitRoot: root, branch: "main", localSha: await git(root, "rev-parse", "HEAD") }
    const plan = await resolvePushPlan(repository, false)
    const rules = rulesFor(config)
    const patches = await readOutgoingPatches(repository, plan)
    return patches.flatMap((p) => [...scanMessage(p.commit, p.message, rules), ...scanPatch({ commit: p.commit, patch: p.patch }, rules)])
  }
  return { root, commit, scan, git: (...a: string[]) => git(root, ...a) }
}

const rulesOf = (findings: readonly GuardFinding[]) => findings.map((f) => `${f.rule} ${f.file}${f.line ? `:${f.line}` : ""}`).sort()

describe("public push guard on real git fixtures", () => {
  test("a clean push has no findings", async () => {
    const f = await fixture()
    await f.commit({ "src/index.ts": "export const add = (a: number, b: number) => a + b\n", "docs/usage.md": "Run `shitrat push owner/repo`.\n" })
    expect(await f.scan()).toEqual([])
  })

  test("a planted .brain file is refused, and Muster state is named as such", async () => {
    const f = await fixture()
    await f.commit({ ".brain/projects/plan.svx": "# plan\n", ".brain/data/muster/project.json": "{}\n" })
    expect(rulesOf(await f.scan())).toEqual(["brain-path .brain/data/muster/project.json", "brain-path .brain/projects/plan.svx", "muster-state .brain/data/muster/project.json"])
  })

  test("Pi and agent state paths are refused", async () => {
    const f = await fixture()
    await f.commit({ ".pi/mcp.json": "{}\n", "tools/.agent/state.json": "{}\n" })
    expect(rulesOf(await f.scan())).toEqual(["agent-state .pi/mcp.json", "agent-state tools/.agent/state.json"])
  })

  test("a token is found with its line, redacted, and cannot be waived", async () => {
    const f = await fixture()
    await f.commit({ "src/config.ts": `export const a = 1\nexport const token = "${ghToken}"\n` })
    const findings = await f.scan()
    expect(rulesOf(findings)).toEqual(["github-token src/config.ts:2"])
    expect(JSON.stringify(findings)).not.toContain(ghToken)
    const verdict = judge(findings, ["**", "src/config.ts"])
    expect(verdict.blocking).toHaveLength(1)
    expect(verdict.waived).toHaveLength(0)
  })

  test("a secret added and removed again before the push is still refused", async () => {
    const f = await fixture()
    await f.commit({ "notes.txt": `${pemHeader}\n` })
    await f.commit({}, "remove it", ["notes.txt"])
    expect(rulesOf(await f.scan())).toEqual(["private-key notes.txt:1"])
  })

  test("other secret shapes", async () => {
    const f = await fixture()
    const lines = [
      ["sk", "-ant-", "x".repeat(30)].join(""),
      ["xo", "xb-", "1234567890-abc"].join(""),
      ["AK", "IA", "ABCDEFGHIJKLMNOP"].join(""),
      ["np", "m_", "a".repeat(36)].join(""),
      ["ey", "JhbGciOiJIUzI1NiJ9", ".ey", "JzdWIiOiIxMjM0In0", ".", "s1gnatureXYZ12"].join(""),
    ]
    await f.commit({ "leak.txt": `${lines.join("\n")}\n` })
    expect(rulesOf(await f.scan())).toEqual(["aws-key leak.txt:3", "jwt leak.txt:5", "npm-token leak.txt:4", "sk-key leak.txt:1", "slack-token leak.txt:2"])
  })

  test("home paths, tailnet names and IPs, and configured hostnames are found", async () => {
    const f = await fixture()
    await f.commit({ "docs/setup.md": `clone into ${homePath}\nopen https://${tailnetName}/\nssh ${tailnetIp}\nask zorbhost about it\n` })
    expect(rulesOf(await f.scan({ privateHostnames: ["zorbhost"] }))).toEqual([
      "home-path docs/setup.md:1",
      "tailnet-domain docs/setup.md:2",
      "tailnet-hostname docs/setup.md:4",
      "tailnet-ip docs/setup.md:3",
    ])
    expect(rulesOf(await f.scan())).not.toContain("tailnet-hostname docs/setup.md:4")
  })

  test("commit messages are scanned too", async () => {
    const f = await fixture()
    await f.commit({ "a.txt": "a\n" }, `deploy to ${tailnetName}`)
    expect(rulesOf(await f.scan())).toEqual(["tailnet-domain (commit message)"])
  })

  test("a rename into .brain and a binary file in .brain are both caught", async () => {
    const f = await fixture()
    await f.commit({ "plan.md": "# plan\n" })
    await f.git("update-ref", "refs/remotes/origin/main", "HEAD")
    await mkdir(path.join(f.root, ".brain"), { recursive: true })
    await f.git("mv", "plan.md", ".brain/plan.md")
    await f.commit({ ".brain/data/blob.bin": new Uint8Array([0, 1, 2, 0, 255]) }, "move")
    expect(rulesOf(await f.scan())).toEqual(["brain-path .brain/data/blob.bin", "brain-path .brain/plan.md"])
  })

  test("deleting a private file from a public repo is allowed", async () => {
    const f = await fixture()
    await f.commit({ ".brain/old.svx": "x\n" })
    await f.git("update-ref", "refs/remotes/origin/main", "HEAD")
    await f.commit({}, "drop the brain", [".brain/old.svx"])
    expect(await f.scan()).toEqual([])
  })

  test("--allow-public-path waives a known-safe finding and logs it without the line", async () => {
    const f = await fixture()
    await f.commit({ "docs/setup.md": `see ${homePath}\n` })
    const findings = await f.scan()
    expect(judge(findings, []).blocking).toHaveLength(1)
    const verdict = judge(findings, ["docs/**"])
    expect(verdict.blocking).toEqual([])
    expect(verdict.waived.map((w) => w.rule)).toEqual(["home-path"])

    const home = await mkdtemp(path.join(tmpdir(), "shitrat-guard-log-"))
    dirs.push(home)
    process.env.SHITRAT_PUBLIC_PUSH_ALLOW_LOG = path.join(home, "state", "public-push-allow.jsonl")
    try {
      const logPath = await logWaivers({ repo: "example/public", branch: "main", range: "a..b", allow: ["docs/**"], waived: verdict.waived, dryRun: false })
      const raw = await readFile(logPath, "utf8")
      expect(JSON.parse(raw)).toMatchObject({ repo: "example/public", allow: ["docs/**"], waived: [{ rule: "home-path", file: "docs/setup.md", line: 1 }] })
      expect(raw).not.toContain("someone")
      expect(raw).not.toContain("excerpt")
      expect((await stat(logPath)).mode & 0o777).toBe(0o600)
    } finally {
      delete process.env.SHITRAT_PUBLIC_PUSH_ALLOW_LOG
    }
  })
})

describe("guard config", () => {
  test("missing config means no hostname list; malformed config fails closed", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "shitrat-guard-config-"))
    dirs.push(dir)
    expect(await loadGuardConfig(path.join(dir, "absent.json"))).toEqual({ privateHostnames: [] })
    await writeFile(path.join(dir, "ok.json"), JSON.stringify({ privateHostnames: ["zorbhost"] }))
    expect(await loadGuardConfig(path.join(dir, "ok.json"))).toEqual({ privateHostnames: ["zorbhost"] })
    await writeFile(path.join(dir, "bad.json"), "{ nope")
    await expect(loadGuardConfig(path.join(dir, "bad.json"))).rejects.toBeInstanceOf(GuardConfigError)
    await writeFile(path.join(dir, "unreadable.json"), "{}")
    await chmod(path.join(dir, "unreadable.json"), 0o000)
    await expect(loadGuardConfig(path.join(dir, "unreadable.json"))).rejects.toBeInstanceOf(GuardConfigError)
  })
})
