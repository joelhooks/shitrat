export type DraftStyle = "bold" | "italic" | "strikethrough"

export interface DraftStyleRange {
  readonly offset: number
  readonly length: number
  readonly style: DraftStyle
}

export interface DraftEntityRange {
  readonly offset: number
  readonly length: number
  readonly key: number
}

export interface DraftBlock {
  readonly key: string
  readonly text: string
  readonly type: string
  readonly inline_style_ranges?: readonly DraftStyleRange[]
  readonly entity_ranges?: readonly DraftEntityRange[]
}

export interface DraftEntity {
  readonly key: string
  readonly value: {
    readonly type: string
    readonly mutability: "mutable" | "immutable"
    readonly data: Record<string, string>
  }
}

export interface ContentState {
  readonly blocks: readonly DraftBlock[]
  readonly entities: readonly DraftEntity[]
}

export interface ArticleStats {
  readonly blocks: number
  readonly entities: number
  readonly chars: number
}

const SKIP_TAGS = new Set(["svg", "iframe", "script", "style", "head", "noscript"])
const VOID_TAGS = new Set(["br", "img", "hr", "meta", "link", "input", "source"])

export const utf16Len = (text: string): number => text.length

export const articleStats = (state: ContentState): ArticleStats => ({
  blocks: state.blocks.length,
  entities: state.entities.length,
  chars: state.blocks.reduce((sum, block) => sum + block.text.length, 0),
})

class ArticleBuilder {
  blocks: DraftBlock[] = []
  entities: DraftEntity[] = []
  private n = 0

  private nextKey(): string {
    this.n += 1
    return this.n.toString(16)
  }

  addEntity(type: string, mutability: "mutable" | "immutable", data: Record<string, string>): number {
    const idx = this.entities.length
    this.entities.push({
      key: String(idx),
      value: { type, mutability, data },
    })
    return idx
  }

  addBlock(
    type: string,
    parts: ReadonlyArray<string | readonly [string, DraftStyle | "link", string?]>,
  ): void {
    let text = ""
    const styles: DraftStyleRange[] = []
    const ranges: DraftEntityRange[] = []
    for (const part of parts) {
      if (typeof part === "string") {
        text += part
        continue
      }
      const [chunk, kind, url] = part
      const start = utf16Len(text)
      const length = utf16Len(chunk)
      text += chunk
      if (kind === "bold" || kind === "italic" || kind === "strikethrough") {
        styles.push({ offset: start, length, style: kind })
      } else if (kind === "link" && url) {
        const key = this.addEntity("link", "mutable", { url })
        ranges.push({ offset: start, length, key })
      }
    }
    const block: DraftBlock = {
      key: this.nextKey(),
      text,
      type,
      ...(styles.length > 0 ? { inline_style_ranges: styles } : {}),
      ...(ranges.length > 0 ? { entity_ranges: ranges } : {}),
    }
    this.blocks.push(block)
  }

  atomicMarkdown(body: string, lang = ""): void {
    const fence = lang ? `\`\`\`${lang}\n${body}\n\`\`\`` : `\`\`\`\n${body}\n\`\`\``
    const key = this.addEntity("markdown", "mutable", { markdown: fence })
    this.blocks.push({
      key: this.nextKey(),
      text: " ",
      type: "atomic",
      entity_ranges: [{ offset: 0, length: 1, key }],
    })
  }

  payload(): ContentState {
    return { blocks: this.blocks, entities: this.entities }
  }
}

interface HtmlNode {
  readonly tag: string
  readonly attrs: Record<string, string>
  readonly children: Array<HtmlNode | string>
}

const parseAttrs = (raw: string): Record<string, string> => {
  const attrs: Record<string, string> = {}
  const re = /([:@A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g
  for (const match of raw.matchAll(re)) {
    attrs[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? ""
  }
  return attrs
}

const parseHtml = (source: string): HtmlNode => {
  const root: HtmlNode = { tag: "root", attrs: {}, children: [] }
  const stack: HtmlNode[] = [root]
  let skipUntil: string | null = null
  const re = /<!--[\s\S]*?-->|<\/?([A-Za-z][A-Za-z0-9:-]*)([^>]*)>|([^<]+)/g
  for (const match of source.matchAll(re)) {
    const token = match[0]
    if (token.startsWith("<!--")) continue
    if (skipUntil) {
      if (token.startsWith("</") && (match[1] ?? "").toLowerCase() === skipUntil) skipUntil = null
      continue
    }
    if (token.startsWith("</")) {
      const tag = (match[1] ?? "").toLowerCase()
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i]?.tag === tag) {
          stack.length = i
          break
        }
      }
      continue
    }
    if (token.startsWith("<")) {
      const tag = (match[1] ?? "").toLowerCase()
      if (SKIP_TAGS.has(tag)) {
        skipUntil = tag
        continue
      }
      const node: HtmlNode = { tag, attrs: parseAttrs(match[2] ?? ""), children: [] }
      stack.at(-1)?.children.push(node)
      if (!VOID_TAGS.has(tag) && !token.endsWith("/>")) stack.push(node)
      continue
    }
    const text = match[3]
    if (text) stack.at(-1)?.children.push(text)
  }
  return root
}

type InlinePart = string | readonly [string, DraftStyle | "link", string?]

const decodeEntities = (text: string): string =>
  text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")

const collapseWs = (text: string): string => decodeEntities(text).replace(/\s+/g, " ")

const inlineParts = (node: HtmlNode): InlinePart[] => {
  const parts: InlinePart[] = []
  for (const child of node.children) {
    if (typeof child === "string") {
      const text = collapseWs(child)
      if (text && text !== " ") parts.push(text)
      else if (text === " " && parts.length > 0) parts.push(" ")
      continue
    }
    if (child.tag === "br") {
      parts.push("\n")
      continue
    }
    if (child.tag === "a") {
      const label = inlineText(child) || child.attrs.href || ""
      if (label) parts.push([label, "link", child.attrs.href ?? ""])
      continue
    }
    if (child.tag === "strong" || child.tag === "b") {
      const label = inlineText(child)
      if (label) parts.push([label, "bold"])
      continue
    }
    if (child.tag === "em" || child.tag === "i") {
      const label = inlineText(child)
      if (label) parts.push([label, "italic"])
      continue
    }
    if (child.tag === "code") {
      const label = inlineText(child)
      if (label) parts.push(label)
      continue
    }
    parts.push(...inlineParts(child))
  }
  return parts
}

const inlineText = (node: HtmlNode): string =>
  inlineParts(node)
    .map((part) => (typeof part === "string" ? part : part[0]))
    .join("")
    .replace(/\s+/g, " ")
    .trim()

const joinParts = (parts: InlinePart[]): InlinePart[] => {
  const out: InlinePart[] = []
  for (const part of parts) {
    if (typeof part === "string") {
      const prev = out.at(-1)
      if (typeof prev === "string") {
        out[out.length - 1] = prev + part
        continue
      }
    }
    out.push(part)
  }
  return out
}

const walkHtml = (node: HtmlNode, article: ArticleBuilder): void => {
  const tag = node.tag
  if (tag === "h2") {
    article.addBlock("header-two", [inlineText(node)])
    return
  }
  if (tag === "h3") {
    article.addBlock("header-three", [inlineText(node)])
    return
  }
  if (tag === "p") {
    const parts = joinParts(inlineParts(node))
    if (inlineText(node)) article.addBlock("unstyled", parts)
    return
  }
  if (tag === "blockquote") {
    const parts = joinParts(inlineParts(node))
    if (inlineText(node)) article.addBlock("blockquote", parts)
    return
  }
  if (tag === "pre") {
    const body = decodeEntities(node.children.map((c) => (typeof c === "string" ? c : inlineText(c))).join("")).trim()
    if (body) article.atomicMarkdown(body)
    return
  }
  if (tag === "ul" || tag === "ol") {
    const type = tag === "ul" ? "unordered-list-item" : "ordered-list-item"
    for (const child of node.children) {
      if (typeof child === "string") continue
      if (child.tag !== "li") continue
      const parts = joinParts(inlineParts(child))
      if (inlineText(child)) article.addBlock(type, parts)
    }
    return
  }
  if (tag === "figcaption") {
    const text = inlineText(node)
    if (text) article.addBlock("unstyled", [[text, "italic"]])
    return
  }
  for (const child of node.children) {
    if (typeof child === "string") continue
    walkHtml(child, article)
  }
}

export const convertHtmlToContentState = (html: string): ContentState => {
  const article = new ArticleBuilder()
  walkHtml(parseHtml(html), article)
  return article.payload()
}

const splitMarkdownBlocks = (md: string): string[] =>
  md
    .replace(/\r\n/g, "\n")
    .trim()
    .split(/\n{2,}/)

const parseInlineMarkdown = (line: string): InlinePart[] => {
  const parts: InlinePart[] = []
  const re = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|\[([^\]]+)\]\(([^)]+)\))/g
  let last = 0
  for (const match of line.matchAll(re)) {
    if (match.index === undefined) continue
    if (match.index > last) parts.push(line.slice(last, match.index))
    if (match[2]) parts.push([match[2], "bold"])
    else if (match[3]) parts.push([match[3], "italic"])
    else if (match[4]) parts.push(match[4])
    else if (match[5] && match[6]) parts.push([match[5], "link", match[6]])
    last = match.index + match[0].length
  }
  if (last < line.length) parts.push(line.slice(last))
  return parts
}

export const convertMarkdownToContentState = (md: string): ContentState => {
  const article = new ArticleBuilder()
  const chunks = splitMarkdownBlocks(md)
  for (const chunk of chunks) {
    if (chunk.startsWith("```")) {
      const lines = chunk.split("\n")
      const lang = lines[0]?.slice(3).trim() ?? ""
      const body = lines.slice(1, lines.at(-1) === "```" ? -1 : undefined).join("\n")
      article.atomicMarkdown(body, lang)
      continue
    }
    const lines = chunk.split("\n")
    if (lines.every((line) => /^[-*] /.test(line))) {
      for (const line of lines) article.addBlock("unordered-list-item", parseInlineMarkdown(line.replace(/^[-*] /, "")))
      continue
    }
    if (lines.every((line) => /^\d+\. /.test(line))) {
      for (const line of lines) article.addBlock("ordered-list-item", parseInlineMarkdown(line.replace(/^\d+\. /, "")))
      continue
    }
    if (lines.every((line) => line.startsWith("> "))) {
      article.addBlock("blockquote", parseInlineMarkdown(lines.map((line) => line.replace(/^> /, "")).join(" ")))
      continue
    }
    if (lines.length === 1 && lines[0]?.startsWith("## ")) {
      article.addBlock("header-two", [lines[0].slice(3)])
      continue
    }
    if (lines.length === 1 && lines[0]?.startsWith("### ")) {
      article.addBlock("header-three", [lines[0].slice(4)])
      continue
    }
    article.addBlock("unstyled", parseInlineMarkdown(lines.join(" ")))
  }
  return article.payload()
}
