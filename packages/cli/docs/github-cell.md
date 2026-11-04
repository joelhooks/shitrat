# Opt-in GitHub routing through Lockjaw

`SHITRAT_GITHUB_VIA=cell` routes repository and organization GitHub API calls and Git smart-HTTP fetch/push through the configured Lockjaw cell. Without it, ShitRat uses its existing direct GitHub App credential path. `SHITRAT_GITHUB_VIA=direct` explicitly selects the same default.

Cell mode does not load the App private key or mint an installation token locally. It sends `{{secret:shitrat-github/<owner>}}` placeholders. The cell resolves the owner to an installation and fills the authorization header server-side.

## Configuration

Configure these environment variables in the process running ShitRat:

| Variable | Meaning |
| --- | --- |
| `SHITRAT_GITHUB_VIA` | `cell` to opt in; absent or `direct` retains direct authentication. Unknown values refuse. |
| `SC_URL` | Cell origin supplied by the operator. No default URL is compiled into ShitRat. |
| `SC_AUDIENCE` | Cell audience DID, not the calling agent's DID. |
| `SC_IDENTITY_JSON` | Caller identity injected into the child environment by an authorized runtime. Never place its value in a shell command, argv or output. |
| `SHITRAT_CELL_IDENTITY_FILE` | Alternative to `SC_IDENTITY_JSON`: an explicit regular, non-symlink mode-0600 identity file. The two identity sources are mutually exclusive. ShitRat validates the opened descriptor and passes the bytes to `sc` through its environment, never argv or a new file. |
| `SHITRAT_CELL_CALLER_DOCUMENT_FILE` | Externally resolved public caller DID document. Required for desk identities. ShitRat checks the identity DID, authenticated verification method, controller and P-256 public JWK coordinates against it before invoking `sc`. Do not put private JWK fields in this document. |
| `SHITRAT_SC_BIN` | Executable `sc` path. Defaults to `sc` on PATH. This is one executable, not a shell command or argument string. |
| `SC_PASS_FILE` | Optional runtime-owned worker pass file, read and checked by `sc` before each request. |
| `SHITRAT_GITHUB_CELL_FALLBACK` | `direct` explicitly permits setup fallback. Absent means refuse. No other value is accepted. |

Use the documented Lockjaw client with `describe`, `forward`, `SC_IDENTITY_JSON`, `SC_PASS_FILE` and the `sc forward listening on <address>` readiness line. Its Node runtime must be installed. If invoking a non-executable built `sc.js`, point `SHITRAT_SC_BIN` at an executable wrapper that uses `exec node /path/to/sc.js "$@"`. No identity or credential belongs in that wrapper.

For an agent-secrets identity, the authorized parent uses the `secrets_exec` tool to inject the configured identity into `SC_IDENTITY_JSON` while executing ShitRat. ShitRat does not discover a secret-store name, lease a value, mint a caller identity or default to another agent's identity. The operator must supply an admitted caller identity and resolve its public caller document through the owning Rat King directory into the configured document file. The launcher reads and compares them in memory before the signer starts. It does not resolve a name over the network or self-register a caller. No secret-store name, private DID or gateway address is built in. Ordinary direct mode still uses the existing secret-reading implementation.

Worker runtimes supply their ephemeral identity through `SC_IDENTITY_JSON` and their protected pass through `SC_PASS_FILE`. They omit the desk caller-document file: an ephemeral worker key is not the desk signing key. The owning `sc` client checks the worker identity against the signed pass and any name ticket before each request. The runtime owns pass renewal; ShitRat and `sc` never renew it. Setup currently requires permission to describe the root `shitrat-github` credential, in addition to permission to fetch the owner's credential. A fetch-only or owner-only worker pass cannot satisfy this preflight. Give an appropriate describe scope or use a desk identity; ShitRat will not widen a pass or borrow a desk key.

The cell must approve `api.github.com` and `github.com`, support the GitHub App owner-token credential, and approve Basic authentication with literal user `x-access-token` for smart HTTP. Git sends `{{secret-basic:user=x-access-token,password=shitrat-github/<owner>}}`. The cell, not Git or ShitRat, constructs the Basic value.

## Path selection and errors

Each authentication attempt writes a JSON line to stderr:

```json
{"event":"github-route","path":"cell","reason":"requested"}
```

Default direct mode logs `path=direct` with reason `selected`. A refused setup with explicit fallback logs:

```json
{"event":"github-route","path":"direct","reason":"cell-refused"}
```

A missing or mismatched public caller-document pin fails before starting `sc`. Setup reasons are bounded labels (`cell-configuration`, `cell-client`, `cell-refused`), never child stderr, response bodies, environment values or native exception messages. An unavailable executable, invalid identity, stale pass, transport failure or cell refusal fails without silent fallback. The CLI's normal JSON envelope stays on stdout.

Fallback applies only before repository requests begin. Setup invokes `sc describe shitrat-github` without returning any value. Once credentials have been selected, API and Git failures do not trigger direct fallback, even when the fallback variable is set. This avoids retrying a write whose outcome may be uncertain. To retry directly, explicitly select `SHITRAT_GITHUB_VIA=direct` after checking the operation's outcome.

App-JWT operations such as `shitrat installations` and installation-ID discovery are not supported by the owner installation-token route. They refuse in cell mode, unless explicit direct fallback is permitted; then they log `cell-unsupported-app-operation` before using the original path. Installation ID, token expiry and permission metadata are not returned by this cell contract, so cell-mode command results omit the ID/expiry and report an empty permission map. Do not interpret that map as proof that the installation has no permissions.

## Client boundary and Git protocol

ShitRat depends on the documented external `sc` executable rather than copying its signing implementation or importing its Effect runtime. This keeps JWT claims, identity validation, worker passes, freshness checks, host rules and signing keys inside the owning client. It also avoids coupling this Effect-3 CLI to the client's Effect-4 implementation. Install a compatible Lockjaw client separately; ShitRat does not download it.

For each API request or authenticated Git subprocess, ShitRat starts an owned `sc forward` on literal loopback, waits for its readiness event, runs the operation and stops that process in `finally`. A temporary port reservation selects the port; another process can win the release/bind race, which causes a setup failure rather than a connection to an unverified listener. There is no polling or fixed startup sleep. Startup has a 10-second deadline, and API/cell transport requests have 60-second deadlines.

API requests retain their GitHub URL for Octokit pagination but use a custom fetch adapter to forward through `sc`. Redirects are refused. Responses are buffered before the owned forwarder closes. Git uses smart HTTP, not the REST Git-data API: the authenticated Git URL points at loopback and the client forwards the binary body to `/v1/u/github.com/...`. Credential helpers and redirects are disabled for these Git invocations. The existing checkout, authorship and fast-forward checks remain in place. Empty-repository commits also use this route for their final Git push.

SSH, CONNECT tunnelling, WebSockets, Git LFS and unbounded streaming uploads are not supported. API endpoints that redirect to a separate download host, including Actions job-log downloads, currently refuse rather than bypassing the cell or following a signed URL. Forwarded request bodies and API responses are buffered. Large pushes remain subject to the cell/client's body and transport limits. There is no local or cell retry loop in this adapter.

## Local proof

```sh
bun run --cwd packages/cli check
bun run --cwd packages/cli test
```

`test/github-cell.test.ts` uses a fixture HTTP cell, an executable client-contract fixture, generated test identities and a local Git HTTP backend. It checks default direct routing, cell success, refusal, explicit setup fallback, log content, redirect refusal, unsupported App operations, argv/log secret scans and binary smart-HTTP push/fetch. Direct GitHub requests are intercepted locally.

To exercise the same tests with an installed real client, set `SHITRAT_TEST_SC_BIN=/absolute/path/to/sc` when running that test file. It still calls only the fake cell, never GitHub. This verifies compatibility with the installed signer and forwarder, not live admission or deployment.
