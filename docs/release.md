# Release

First release target: modern macOS arm64.

Build locally:

```bash
pnpm install
pnpm turbo run check
pnpm turbo run test
pnpm --filter @joelhooks/shitrat-cli run build:binary
shasum -a 256 packages/cli/dist/shitrat > packages/cli/dist/shitrat-darwin-arm64.sha256
packages/cli/dist/shitrat doctor --dry-run
```

The release workflow uploads:

- `shitrat`
- `shitrat-darwin-arm64.sha256`

Real install writes are disabled until backup and receipt behavior lands.
