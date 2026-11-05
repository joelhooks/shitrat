# GitHub routing through Lockjaw by default

An unset `SHITRAT_GITHUB_VIA`, or `SHITRAT_GITHUB_VIA=cell`, routes repository and organization GitHub API calls and Git smart-HTTP fetch/push through the configured Lockjaw cell. `SHITRAT_GITHUB_VIA=direct` is the explicit escape hatch to the existing GitHub App credential path. Unknown values refuse with `configuration`.

Cell mode requires Bun, an installed `sc` build that supports both `SC_FORWARD_NONCE` and `sc forward --capabilities`, the configured cell URL/audience and an admitted caller identity. Desk callers also need the externally resolved public caller document described below; worker callers instead supply their signed pass. ShitRat does not install `sc`, supply an identity or discover a cell automatically.

Cell mode does not load the App private key or mint an installation token locally. It sends `{{secret:shitrat-github/<owner>}}` placeholders. The cell resolves the owner to an installation and fills the authorization header server-side.

## Configuration

Configure these environment variables in the process running ShitRat:

| Variable | Meaning |
| --- | --- |
| `SHITRAT_GITHUB_VIA` | Absent or `cell` uses the cell route. `direct` explicitly selects direct authentication. Unknown values refuse with `configuration`. |
| `SC_URL` | Cell origin supplied by the operator. No default URL is compiled into ShitRat. |
| `SC_AUDIENCE` | Cell audience DID, not the calling agent's DID. |
| `SC_IDENTITY_JSON` | Caller identity injected into the child environment by an authorized runtime. Never place its value in a shell command, argv or output. |
| `SHITRAT_CELL_IDENTITY_FILE` | Alternative to `SC_IDENTITY_JSON`: an explicit regular, non-symlink mode-0600 identity file. The two identity sources are mutually exclusive. ShitRat validates the opened descriptor and passes the bytes to `sc` through its environment, never argv or a new file. |
| `SHITRAT_CELL_CALLER_DOCUMENT_FILE` | Externally resolved public caller DID document. Required for desk identities. After the identity-free capability probe, ShitRat checks the identity DID, authenticated verification method, controller and P-256 public JWK coordinates against it before invoking authenticated `sc` commands. Do not put private JWK fields in this document. |
| `SHITRAT_SC_BIN` | Executable `sc` path. Defaults to `sc` on PATH. This is one executable, not a shell command or argument string. |
| `SC_PASS_FILE` | Optional runtime-owned worker pass file, read and checked by `sc` before each request. |
| `SHITRAT_GITHUB_CELL_FALLBACK` | `direct` explicitly permits setup fallback. Absent means refuse. No other value is accepted. |

Use the documented Lockjaw client with `describe`, `forward`, `SC_IDENTITY_JSON`, `SC_PASS_FILE`, the `sc forward listening on <address>` readiness line and the identity-free `sc forward --capabilities` probe. The probe must exit 0 with JSON containing `"forwardNonce": true`; unknown extra fields are ignored. ShitRat runs it once per command, with only PATH in the child environment and a three-second deadline, before any forward can be used. Missing support, nonzero exit, malformed output, an unavailable executable or timeout refuses with `configuration` and `sc too old for forward nonce; update sc`. No forward or request is started, and even explicit direct fallback cannot bypass this compatibility refusal. Its Node runtime must be installed. If invoking a non-executable built `sc.js`, point `SHITRAT_SC_BIN` at an executable wrapper that uses `exec node /path/to/sc.js "$@"`. No identity or credential belongs in that wrapper.

For an agent-secrets identity, the authorized parent uses the `secrets_exec` tool to inject the configured identity into `SC_IDENTITY_JSON` while executing ShitRat. ShitRat does not discover a secret-store name, lease a value, mint a caller identity or default to another agent's identity. The operator must supply an admitted caller identity and resolve its public caller document through the owning Rat King directory into the configured document file. The launcher reads and compares them in memory before the signer starts. It does not resolve a name over the network or self-register a caller. No secret-store name, private DID or gateway address is built in. Ordinary direct mode still uses the existing secret-reading implementation.

Worker runtimes supply their ephemeral identity through `SC_IDENTITY_JSON` and their protected pass through `SC_PASS_FILE`. They omit the desk caller-document file: an ephemeral worker key is not the desk signing key. The owning `sc` client checks the worker identity against the signed pass and any name ticket before each request. The runtime owns pass renewal; ShitRat and `sc` never renew it. Setup currently requires permission to describe the root `shitrat-github` credential, in addition to permission to fetch the owner's credential. A fetch-only or owner-only worker pass cannot satisfy this preflight. Give an appropriate describe scope or use a desk identity; ShitRat will not widen a pass or borrow a desk key.

The cell must approve `api.github.com` and `github.com`, support the GitHub App owner-token credential, and approve Basic authentication with literal user `x-access-token` for smart HTTP. Git sends `{{secret-basic:user=x-access-token,password=shitrat-github/<owner>}}`. The cell, not Git or ShitRat, constructs the Basic value.

## Path selection and errors

Each authentication attempt writes a JSON line to stderr:

```json
{"event":"github-route","path":"cell","reason":"requested"}
```

Default cell mode logs `path=cell` with reason `requested`, as above. Explicit direct mode logs `path=direct` with reason `selected`. A refused setup with explicit fallback logs:

```json
{"event":"github-route","path":"direct","reason":"cell-refused"}
```

The identity-free `sc forward --capabilities` probe runs first. A missing or mismatched public caller-document pin then fails before `sc describe` or a signing forward starts. Setup reasons are bounded labels (`cell-configuration`, `cell-client`, `cell-refused`), never child stderr, response bodies, environment values or native exception messages. An incompatible or unavailable executable refuses before setup without any fallback. An invalid identity, stale pass, transport failure or cell refusal fails without silent fallback. The CLI's normal JSON envelope stays on stdout. GitHub commands sharing the failure wrapper exit nonzero for `ok: false`; typed cell errors retain `GITHUB_CELL_ERROR`, their reason and their bounded message through Effect and Octokit cause wrappers. Adapter aborts and timeouts retain distinguishable `AbortError` and `TimeoutError` names with bounded messages rather than reflecting arbitrary transport diagnostics.

Fallback applies only to bounded setup failures (`configuration`, `client` or preflight `refused`) before any API or Git operation starts. Setup invokes `sc describe shitrat-github` without returning any value. Capability refusal never permits fallback. The first operation through a ready forward permanently closes the fallback window for that command, before the transport runs. API/Git failures, aborts, timeouts, upstream errors and later setup failures cannot trigger direct fallback, even when the fallback variable is set. Unknown errors are not treated as safe setup failures. This avoids retrying a write whose outcome may be uncertain. To retry directly, explicitly select `SHITRAT_GITHUB_VIA=direct` after checking the operation's outcome.

App-JWT operations such as `shitrat installations` and installation-ID discovery are not supported by the owner installation-token route. They refuse in cell mode, unless explicit direct fallback is permitted; then they log `cell-unsupported-app-operation` before using the original path. Installation ID, token expiry and permission metadata are not returned by this cell contract, so cell-mode command results omit the ID/expiry and report an empty permission map. Do not interpret that map as proof that the installation has no permissions.

## Client boundary and Git protocol

ShitRat depends on the documented external `sc` executable rather than copying its signing implementation or importing its Effect runtime. This keeps JWT claims, identity validation, worker passes, freshness checks, host rules and signing keys inside the owning client. It also avoids coupling this Effect-3 CLI to the client's Effect-4 implementation. Install a compatible Lockjaw client separately; ShitRat does not download it.

ShitRat needs Bun to run the cell route; a non-Bun runtime refuses with `configuration` before starting `sc`. Within a command run, ShitRat lazily starts one owned `sc forward` per upstream host on literal loopback and waits for its readiness event. Later requests reuse that forward, including concurrent API calls. Before invoking each operation, ShitRat checks the owned child's exit/killed state. A dead forward refuses with `client` and `cell forward exited mid-command; rerun`, without fetching the old port or silently restarting the forward. Further attempts in the same command keep that refusal. Command cleanup stops owned forwards in `finally`; a process-exit hook also kills them on synchronous exit. Standalone adapter calls outside a command scope own a forward for that call. A temporary port reservation selects the port; another process can win the release/bind race, which causes a setup failure rather than a connection to an unverified listener. There is no polling or fixed startup sleep. Startup has a 10-second deadline, and API/cell transport requests have 60-second deadlines.

API requests and buffered responses retain their logical GitHub URL, including query parameters, for Octokit pagination but use a custom fetch adapter to forward through `sc`. The response URL is never the loopback transport URL. Malformed or non-GitHub adapter URLs refuse with `unsupported`; redirects are refused. Responses are buffered before returning to Octokit. Git uses smart HTTP, not the REST Git-data API: the authenticated Git URL points at loopback and the client forwards the binary body to `/v1/u/github.com/...`. Credential helpers and redirects are disabled for these Git invocations. The existing checkout, authorship and fast-forward checks remain in place. Empty-repository commits also use this route for their final Git push.

SSH, CONNECT tunnelling, WebSockets, Git LFS and unbounded streaming uploads are not supported. API endpoints that redirect to a separate download host, including Actions job-log downloads, currently refuse rather than bypassing the cell or following a signed URL. Forwarded request bodies and API responses are buffered. Large pushes remain subject to the cell/client's body and transport limits. There is no local or cell retry loop in this adapter.

## Known limits

Cell mode is the default; use `SHITRAT_GITHUB_VIA=direct` when these limits require the direct route. The loopback-listener authentication gap is closed by a per-command nonce: ShitRat generates 32 random bytes with `crypto.getRandomValues`, encodes them as base64url and shares the value across that command's cached forwards. Only `sc forward` receives it as `SC_FORWARD_NONCE`; API requests send `x-sc-forward-token`, and Git supplies the same header through environment-backed Git config, never argv. The compatible `sc` client checks the nonce before forwarding and strips the header before the cell or GitHub sees it. Install a client that supports `SC_FORWARD_NONCE` and reports it through `sc forward --capabilities`; ShitRat refuses older clients before sending the header.

ShitRat strips echoed nonce headers and redacts the nonce from API response bodies, headers and Git output before returning them to callers. The Git child does not receive `SC_FORWARD_NONCE`; its environment also strips all `GIT_TRACE*`, `GIT_CURL_VERBOSE` and `GIT_REDACT_COOKIES` overrides so tracing cannot write the header to a log. A 403 with `what: "forward nonce refused"` refuses with `client` and `cell forward rejected the run nonce; rerun`. Later API attempts in the same command retain that refusal without retrying or restarting the forward. The nonce never appears in argv, logs or error text. This authenticates possession of the run nonce, not the loopback address itself; it does not protect against a process that can read the command's environment or memory.

A Git push refused by the forward nonce reports as `refused`; the API path reports `client`. Git does not expose the JSON refusal body, so ShitRat cannot distinguish a local nonce refusal from an upstream policy 403 without guessing. API response header sanitization still uses `Headers` iteration, which can collapse multiple `Set-Cookie` values; this behavior is unchanged.

Git over the cell is refused until the Basic-auth policy lands and a live push is proven. The local smart-HTTP fixture below proves adapter behavior, not live Git admission. Permission-gated `cancel-runs` and `delete-branch` also refuse with `unsupported` in cell mode: the cell contract does not return permission metadata. Select the direct route explicitly to use those commands.

## Local proof

```sh
bun run --cwd packages/cli check
bun run --cwd packages/cli test
```

`test/github-cell.test.ts` uses a fixture HTTP cell, an executable client-contract fixture, generated test identities and a local Git HTTP backend. It checks default cell routing, explicit direct routing, unknown selectors, cell success, refusal, explicit setup fallback, refusal to replay writes after timeout/abort/upstream errors, log content, redirect refusal, unsupported App operations, argv/log secret scans and binary smart-HTTP push/fetch. End-to-end `checks` and repository `runners` tests cover pagination through the fake cell, including next links and the final page's response URL. Direct GitHub requests are intercepted locally. Nonce tests compare every forward request header against the child environment, check reuse and different values across command runs, reject inherited nonce values, scan argv/stdout/stderr/error text, exercise terminal nonce refusal without retry and verify echoed values are redacted. The fake cell also asserts that the forward token never reaches upstream.

The capability fixtures cover support, extra JSON fields, an old client rejecting the flag, malformed or missing capability data, timeout and cached refusals before any forward starts. End-to-end `status` and `comment` tests check typed cell errors and nonzero exits. A pre-aborted request checks both abort and timeout kinds.

To exercise the same tests with an installed real client, set `SHITRAT_TEST_SC_BIN=/absolute/path/to/sc` when running that test file. Optionally set `SHITRAT_TEST_OLD_SC_BIN=/absolute/path/to/old/sc` to check a real old build's compatibility refusal; this test is skipped when that variable is unset. It still calls only the fake cell, never GitHub. This verifies compatibility with the installed signer and forwarder, not live admission or deployment.
