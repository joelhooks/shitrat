# Shitrat Codex Pet

Codex Desktop custom pet package for the default ShitRat familiar.

## Files

- `pet.json`: Codex Desktop pet manifest.
- `spritesheet.webp`: `1536x1872` RGBA atlas, arranged as `192x208` cells.
- `qa/contact-sheet.png`: visual QA sheet for the nine state rows.
- `qa/validation.json`: deterministic atlas validation output.

## State Rows

The atlas follows the Codex pet row contract:

0. `idle`
1. `running-right`
2. `running-left`
3. `waving`
4. `jumping`
5. `failed`
6. `waiting`
7. `running`
8. `review`

Generation run:

```text
/Users/joel/Documents/Codex/2026-05-21/hatch-pet-users-joel-codex-skills/shitrat-run
```

The accepted atlas passed deterministic validation with no frame inspection errors and no transparent RGB residue.
