# ShitRat Monorepo Agent Notes

ShitRat is a deployable agent familiar monorepo. This repo can commit its local Brain, but that Brain is **public/project memory only**.

## Committed Brain boundary

Use `BRAIN.md` and `.brain/` for durable, source-grounded project knowledge that is safe to commit with the repo.

Do **not** put sensitive, personal, or private operational details in this repo Brain, including:

- secret values, auth tokens, private keys, OAuth cookies, or credential dumps
- exact private secret-store names when they reveal personal infrastructure
- private machine names, private hostnames, Tailscale details, or local network topology
- raw Slack messages, channel IDs, user IDs, customer/user data, or private workspace screenshots
- personal details about the operator, family, finances, accounts, health, home, or private logistics
- private URLs, internal incident data, or anything that should not survive a public repo push

If the knowledge is durable but private, write it to the global/system Brain outside this repo instead, using the `second-brain-execution` workflow when useful. That Brain may be backed by a separate private repo; treat it as the private memory layer, not as local scratch. In this repo Brain, reference it only in sanitized form, e.g. "private global Brain note exists" or "private executor host".

A local ignored convenience symlink may exist at `.brain-private.svx`, pointing to the private global Brain project note. Treat it as private input only. Never copy its contents into committed `.brain/` without sanitizing first.

Avoid an ignored private subtree inside committed `.brain/`; mixed public/private branches are too easy to leak through rendering, search, or forced git adds.

Before committing Brain changes:

```bash
pi-notes brain check .
rg -n 'xox|token|secret|private key|joel@|panda|C[0-9A-Z]{8,}|U[0-9A-Z]{8,}|slack-edge.com/T' .brain BRAIN.md AGENTS.md || true
```

False positives are fine. Leaked private detail is not.

## Local package notes

Package-local `AGENTS.md` files may add stricter instructions for a package. They do not loosen this committed-Brain boundary.
