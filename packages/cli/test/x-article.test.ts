import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { oauth2SecretNames } from "../src/x/accounts.js"
import {
  articleStats,
  convertHtmlToContentState,
  convertMarkdownToContentState,
  utf16Len,
} from "../src/x/draftjs.js"
import { parseArticleLimitHeaders } from "../src/x/limits.js"

const runCli = async (...args: string[]) => {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    cwd: new URL("../", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

describe("utf16Len", () => {
  test("counts a rat emoji as two UTF-16 code units", () => {
    expect(utf16Len("SR 🐀")).toBe(5)
  })
})

describe("convertHtmlToContentState", () => {
  test("maps headings, links, lists, quotes, and code", () => {
    const html = `
      <html><head><title>skip</title></head>
      <body>
        <p>Originally published on <a href="https://shitrat.ai/log/hold">shitrat.ai</a>.</p>
        <h2>what actually broke</h2>
        <p>The status was <strong>held</strong>.</p>
        <ul><li>contract</li><li>time</li></ul>
        <blockquote>A fact is not a place.</blockquote>
        <pre><code>if (pollState.status === "held") return</code></pre>
        <svg><text>diagram</text></svg>
        <iframe src="https://www.youtube.com/embed/nope"></iframe>
      </body></html>
    `
    const state = convertHtmlToContentState(html)
    const types = state.blocks.map((block) => block.type)
    expect(types).toEqual([
      "unstyled",
      "header-two",
      "unstyled",
      "unordered-list-item",
      "unordered-list-item",
      "blockquote",
      "atomic",
    ])
    expect(state.blocks[0]?.text).toContain("Originally published on shitrat.ai.")
    expect(state.blocks[0]?.entity_ranges?.length).toBe(1)
    expect(state.entities[0]?.value.type).toBe("link")
    expect(state.entities[0]?.value.data.url).toBe("https://shitrat.ai/log/hold")
    expect(state.blocks[2]?.inline_style_ranges).toEqual([
      { offset: 15, length: 4, style: "bold" },
    ])
    expect(state.blocks.at(-1)?.type).toBe("atomic")
    expect(state.entities.some((entity) => entity.value.type === "markdown")).toBe(true)
    expect(state.blocks.some((block) => block.text.includes("diagram"))).toBe(false)
  })
})

describe("convertMarkdownToContentState", () => {
  test("maps a short article shape", () => {
    const md = `Originally published on [shitrat.ai](https://shitrat.ai/log/hold).

## what actually broke

The past blocked the future.

> A fact is not a place.

- contract
- time

\`\`\`ts
if (held) return
\`\`\`
`
    const state = convertMarkdownToContentState(md)
    expect(state.blocks.map((block) => block.type)).toEqual([
      "unstyled",
      "header-two",
      "unstyled",
      "blockquote",
      "unordered-list-item",
      "unordered-list-item",
      "atomic",
    ])
    expect(articleStats(state).blocks).toBe(7)
  })
})

describe("parseArticleLimitHeaders", () => {
  test("reads the 24h user draft cap and reset", () => {
    const limits = parseArticleLimitHeaders({
      "x-user-limit-24hour-limit": "10",
      "x-user-limit-24hour-remaining": "0",
      "x-user-limit-24hour-reset": "1787428191",
      "x-rate-limit-remaining": "39989",
    })
    expect(limits.userLimit).toBe(10)
    expect(limits.userRemaining).toBe(0)
    expect(limits.userResetAt).toBe("2026-08-22T19:49:51.000Z")
    expect(limits.exhausted).toBe(true)
  })
})

describe("oauth2SecretNames", () => {
  test("namespaces account secrets without printing values", () => {
    expect(oauth2SecretNames("@JoelHooks")).toEqual({
      accessToken: "x_joelhooks_oauth2_access_token",
      refreshToken: "x_joelhooks_oauth2_refresh_token",
      clientId: "x_joelhooks_oauth2_client_id",
      clientSecret: "x_joelhooks_oauth2_client_secret",
    })
  })
})

describe("shitrat x article draft --dry-run", () => {
  test("returns payload stats without contacting X", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shitrat-x-"))
    const htmlPath = join(dir, "hold.html")
    await writeFile(
      htmlPath,
      "<p>A true fact from yesterday had become a command.</p><h2>what actually broke</h2><p>The hold trapped itself.</p>",
      "utf8",
    )
    const { stdout, exitCode } = await runCli(
      "x",
      "article",
      "draft",
      "--title",
      "The past blocked the future",
      "--html-file",
      htmlPath,
      "--dry-run",
    )
    await rm(dir, { recursive: true, force: true })
    expect(exitCode).toBe(0)
    const envelope = JSON.parse(stdout) as {
      ok: boolean
      result: {
        dry_run: boolean
        title: string
        stats: { blocks: number }
        x_write: boolean
        composer_hint: string
      }
    }
    expect(envelope.ok).toBe(true)
    expect(envelope.result.dry_run).toBe(true)
    expect(envelope.result.x_write).toBe(false)
    expect(envelope.result.title).toBe("The past blocked the future")
    expect(envelope.result.stats.blocks).toBe(3)
    expect(envelope.result.composer_hint).toContain("compose/articles")
  })
})
