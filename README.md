# ShitRat

Deployable agent familiar for Codex Desktop, Pi, Claude, and future harnesses.

ShitRat is not just a prompt blob. It is a semantic context system for building a consistent agent familiar from public defaults, private overlays, typed prompt modules, harness adapters, and dry-run-first install tooling.

## Shape

```text
packages/
  cli/                       # shitrat / sr CLI, GitHub App actor, installer, doctor
  core/                      # semantic context graph, validation, compilation, parity
  defaults/                  # public ShitRat default profile
    assets/codex-pets/       # Codex Desktop pet manifests and spritesheets
  slack-agent/               # Slack-native ShitRat Cloudflare Agent
  adapters/
    codex-desktop/           # Codex Desktop install/doctor planning
    pi/                      # Pi install/doctor planning
    claude/                  # Claude install/doctor planning
system/
  APPENDIX.md                # small always-on hard-law appendix
skills/
  shitrat-maintain/          # concise maintenance skill
docs/
  concepts/
  components/
  adapters/
```

## Install for Development

```bash
pnpm install
pnpm turbo run check
pnpm turbo run test
pnpm turbo run build
```

## CLI

```bash
pnpm --filter @joelhooks/shitrat-cli run dev
pnpm --filter @joelhooks/shitrat-cli run build:binary
```

The CLI keeps JSON-only output:

```bash
packages/cli/dist/shitrat doctor --dry-run
packages/cli/dist/shitrat compile --target codex-desktop --dry-run
packages/cli/dist/shitrat install codex-desktop --dry-run
packages/cli/dist/shitrat update pi --dry-run
packages/cli/dist/shitrat merge joelhooks/shitrat-cli --base main --head feature-branch --dry-run
packages/cli/dist/shitrat parity
```

Real install/update writes require `--yes`; dry-run output and receipts come first.

## Public Defaults and Private Overlays

The public repo ships real ShitRat defaults. Users can rename the familiar, change emoji/assets/tone, and add their own semantic components.

The default Codex Desktop pet lives at `packages/defaults/assets/codex-pets/shitrat`. It ships a Codex-compatible `pet.json`, `spritesheet.webp`, and QA contact sheet for visual review.

Private/local configuration belongs in `.shitrat`, usually as a private repo or local checkout. Private overlays are for personal facts, machine wiring, secrets references, paid/private corpus references, and private skills.

The current overlay manifest shape is intentionally small:

```json
{
  "identity": {
    "name": "DeskRat",
    "emoji": "desk",
    "voice": "sharp and quiet"
  }
}
```

## Semantic Context

Prompt modules can be Markdown, MDX, or SVX. Components such as `Identity`, `Rule`, `ToolPolicy`, `BrainPolicy`, `PrivateOverlay`, and `Receipt` are semantic prompt primitives. They are validated and composed before compiling to harness-specific prompt text.

SVX is the example/review-surface format because it fits pi-notes. The runtime contract is compiled prompt text for each harness.

## Release Target

First release target is modern macOS, arm64-first. GitHub Releases should ship a Bun-compiled standalone binary plus checksum so end users do not need Bun installed.

## Current Hard Laws

See `system/APPENDIX.md`.
