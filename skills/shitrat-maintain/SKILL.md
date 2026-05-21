---
name: shitrat-maintain
description: Maintain, install, update, doctor, and release a ShitRat familiar across supported harnesses.
---

# ShitRat Maintain

Use this skill when changing ShitRat itself or installing/updating a ShitRat profile.

## Rules

- Run `shitrat doctor <target> --dry-run` before real installs.
- Preserve private `.shitrat` overlays and never print secrets.
- Keep hard laws in system appendices, not scattered across skills.
- Keep skill surface area concise; add docs before adding another skill.

## Checks

```bash
pnpm turbo run check
pnpm turbo run test
pnpm turbo run build
```
