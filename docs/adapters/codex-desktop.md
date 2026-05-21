# Codex Desktop Adapter

The Codex Desktop adapter compiles a ShitRat profile into Codex-compatible instruction surfaces.

Current v1 behavior is dry-run first:

```bash
shitrat doctor codex-desktop --dry-run
shitrat install codex-desktop --dry-run
shitrat compile --target codex-desktop --dry-run
```

Real writes stay disabled until backup and receipt behavior is implemented.

## Default Pet Asset

The public defaults package includes a Codex-compatible Shitrat pet at:

```text
packages/defaults/assets/codex-pets/shitrat/
  pet.json
  spritesheet.webp
  qa/contact-sheet.png
  qa/validation.json
```

`pet.json` is the install manifest expected by Codex Desktop custom pets. `spritesheet.webp` is a `1536x1872` RGBA atlas using `192x208` cells across the nine Codex app states.
