# pi-notes brain

Use pi-notes as an agent-connected project brain, not a generic notes site.

## Where the Brain lives

This repo is public, so `.brain/` is not committed here. It lives in the private dev repo `joelhooks/shitrat-dev` on the internal git server (not GitHub), with its full history. Check it out as `.brain/` in your working copy; `.gitignore` keeps it out of this repo, and `shitrat push` refuses `.brain/` paths bound for a public repo.

Only `BRAIN.md` stays here. Keep it free of secrets, raw Slack content, private hostnames, personal details, customer/user data, private screenshots and sensitive operational receipts.

Private durable context belongs in the global/system Brain outside this repo. It may be backed by a separate private repo; treat it as the private memory layer, not local scratch. Reference private context here only in sanitized form.

Local operators may keep an ignored `.brain-private.svx` symlink to the private global Brain project note. It is a private input, not committed repo memory.

## Brain practice

- Organize by usefulness: Projects, Areas, Resources, Archives.
- Ask: Where will this be useful next?
- Keep notes atomic, linked, and source-grounded.
- Capture only durable decisions, terms, tradeoffs, gotchas, sources, questions, and review feedback.
- Refine captures into graph edges, backlinks, summaries, and canonical concepts.
- Express knowledge as code, docs, decisions, UI, issues, or plans. Storage is not the goal; output is.
- Browser pages are read/review surfaces. Agents own source edits and must leave receipts.
- Avoid bloated PKM ceremony, append-only logs as truth, Obsidian cloning, and generic static-site sludge.
