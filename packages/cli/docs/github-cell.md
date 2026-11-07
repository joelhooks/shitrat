# GitHub routing: three contracts

`SHITRAT_GITHUB_VIA` selects one of three contracts. An unset selector means **auto**, not strict cell. Unknown selector values refuse with `configuration`. Hosts that must never load a local GitHub App key must explicitly set `SHITRAT_GITHUB_VIA=cell` and leave `SHITRAT_GITHUB_CELL_FALLBACK` unset.

## 1. Auto: unset selector or `SHITRAT_GITHUB_VIA=auto`

Auto tries the cell for a named fleet caller, or for an explicit identity plus `SC_URL`. With no caller name or explicit identity it selects direct authentication. `RATKING_NAME=off` explicitly opts out, even when an identity and cell URL are present.

Auto reads `~/.config/shitrat/cell.json`, or the file named by `SHITRAT_CELL_CONFIG`. The opened file must be regular, owned by the current uid, exactly mode `0600`, and not a final-component symlink. Its fields are:

| Field | Meaning |
| --- | --- |
| `url` | Cell origin. No operational URL is compiled into ShitRat. |
| `audience` | Cell audience DID, not the caller DID. |
| `scBin` | Absolute executable client path. |
| `secretsBin` | Optional absolute secrets executable for the identity lease. |

`SC_URL`, `SC_AUDIENCE`, and `SHITRAT_SC_BIN` override their corresponding file fields. Auto requires a trusted absolute client path. ShitRat resolves the executable target and checks its owner, executable bits, and write permissions. It walks every directory from the resolved parent to `/`. Owners must be root or the current uid. Group/world write access is forbidden, except on sticky root-owned directories such as `/tmp`. The executable itself has no sticky exception.

The same check applies to the secrets executable before an identity lease. Without `secretsBin`, the resolver searches only absolute, nonempty PATH entries. A secrets executable resolved under the current working directory is refused, even through an absolute entry or symlink. PATH resolution is cached per filtered search path; trust and working-directory checks run on every use. This trusts same-user programs. It does not check interpreter chains or bind the checked inode to the later execution.

### Identity and setup

An explicit `SC_IDENTITY_JSON` or `SHITRAT_CELL_IDENTITY_FILE` supplies the identity without a lease. The sources are mutually exclusive. An identity file must satisfy the protected-file checks above. Its bytes stay in memory and enter only the authenticated client environment, never argv or a new production file.

Otherwise a name of the form `<project>/<row>` selects the identity secret `rat_king_fleet_agent_<project>.<row>_identity`. ShitRat leases it using client ID `shitrat-cell` and TTL `5m`. The child receives only PATH, HOME, and variables prefixed with `AGENT_SECRETS`, `XDG`, or `OTEL_EMIT_`. Lease stdout remains in memory; stderr is ignored. A 10-second deadline covers both process exit and stdout completion, including inherited pipes. Cleanup signals the owned detached process group only after timeout or while the lease process still has no exit code.

With no supplied caller-document file, auto derives a public-only document from the identity. This is a consistency self-check, not an independent identity pin. If `SHITRAT_CELL_CALLER_DOCUMENT_FILE` is supplied, its DID, authentication method, controller and public P-256 coordinates must match. Private JWK fields are refused. The admitted identity and cell policy remain the authorization boundary.

Auto checks client compatibility and runs `sc describe shitrat-github` before choosing the cell for an owner. The capability probe has a three-second deadline; auto describe has an eight-second deadline. The probe is identity-free and runs once per command with only PATH. It must return JSON containing `"forwardNonce": true`.

### Implied direct fallback and App-wide operations

Auto permits direct fallback without setting `SHITRAT_GITHUB_CELL_FALLBACK`. Only typed `configuration`, `client`, and `refused` failures during setup qualify. This includes automatic configuration, trust, identity-lease and compatibility failures. The fallback loads the existing direct GitHub App credentials; it can therefore lease the App private key. Direct credentials must still be available for fallback to succeed.

The first API or Git operation through a forward permanently changes the command from setup to requested, before transport starts. A later typed client error, timeout, abort, upstream error or uncertain write does not fall back or replay through direct. Missing command state is not setup. Unknown errors are not on the fallback allow-list.

App-JWT operations, including `installations` and installation-ID discovery, deliberately select direct during setup because the owner-token cell cannot serve them. They emit reason `app-operation` and do not lease a cell identity. This is an intended auto contract, not a failed cell attempt. A prior direct App-wide choice cannot authorize direct after a forwarded cell request.

## 2. Explicit cell: `SHITRAT_GITHUB_VIA=cell`

Explicit cell retains its environment-driven, fail-closed contract. It ignores the automatic config file and does not discover or lease a fleet identity. Supply `SC_URL`, `SC_AUDIENCE`, and an admitted identity or runtime-owned worker pass. `SHITRAT_SC_BIN` selects the client executable; this explicit contract retains its original `sc` PATH default and does not apply the automatic executable trust policy to that client.

Desk identities require `SHITRAT_CELL_CALLER_DOCUMENT_FILE` with a matching externally resolved public caller document. Alternatively, worker runtimes provide their ephemeral identity through `SC_IDENTITY_JSON` and their protected signed pass through `SC_PASS_FILE`. ShitRat rejects conflicting identity sources. The owning client validates worker identity, pass and name ticket before requests. The runtime owns renewal; ShitRat does not widen passes or borrow another caller's identity.

Setup needs permission to describe the root `shitrat-github` credential in addition to permission to fetch an owner's credential. A fetch-only or owner-only worker pass cannot satisfy that preflight. The runtime must provide the required scope; ShitRat does not widen a pass.

The identity-free nonce compatibility gate runs before the fallback block. An old or unavailable client, malformed capability response, or probe timeout refuses with `configuration` and `sc too old for forward nonce; update sc`. Explicit fallback cannot bypass this gate. Describe keeps its 65-second deadline.

With `SHITRAT_GITHUB_CELL_FALLBACK` unset, explicit cell does not silently load the App private key or mint a local installation token. An invalid identity, missing caller document, stale pass, setup refusal or unsupported App-wide operation refuses instead of switching authentication.

Setting `SHITRAT_GITHUB_CELL_FALLBACK=direct` explicitly permits only allow-listed setup fallback after the compatibility gate. It also permits setup-time App-wide direct operations, now logged as `app-operation`. No other fallback value is accepted. Even with this flag, a request that has left the forward closes the direct fallback window permanently. Check a write's outcome before explicitly retrying it through direct.

## 3. Explicit direct: `SHITRAT_GITHUB_VIA=direct`

Direct ignores automatic cell config and does not lease a cell identity or start a cell client. It uses the existing GitHub App credential path, including local installation-token minting. This contract remains the explicit choice for operations the cell cannot serve.

The shared secret provider checks its secrets executable even in direct mode. Missing or untrusted executables raise `UNTRUSTED_SECRETS_EXECUTABLE`, with the path and failed trust rule, rather than claiming the requested secret is missing. A trusted provider that returns no value still produces `MISSING_SECRET` for required reads. Optional reads propagate executable trust failures too. Direct credential leases use the same minimal environment, including `OTEL_EMIT_*` for telemetry.

## Routing events and errors

Each authentication decision emits one bounded JSON line on stderr. Cell selection is logged after the cell selection callback returns or fails, not before the attempt. A process killed mid-setup may therefore leave no event. The CLI replays these route lines from captured diagnostics; its normal JSON envelope stays on stdout. The token-only runner command retains its separate output contract.

| Decision | Path | Reason |
| --- | --- | --- |
| Cell selection succeeds, or a cell error is rethrown | `cell` | `requested` |
| Explicit direct, no-name auto, or auto opt-out | `direct` | `selected` |
| Allowed setup fallback | `direct` | `cell-configuration`, `cell-client`, or `cell-refused` |
| App-wide direct operation permitted by the selected contract | `direct` | `app-operation` |
| App-wide operation refused by explicit cell, or after a forwarded request | `cell` | `unsupported-app-operation` |

For example:

```json
{"event":"github-route","path":"direct","reason":"cell-client"}
```

Fallback emits the final direct event, not an initial cell event followed by direct. Direct credential helpers reuse a setup-time direct decision instead of logging another event. Explicit direct consequently emits one event where older versions emitted two. App-wide operations with explicit cell plus fallback now use `app-operation`, replacing `cell-unsupported-app-operation`. A command making separate decisions can still emit separate events.

Reasons never contain child stderr, response bodies, environment values or native exception messages. Typed cell errors retain `GITHUB_CELL_ERROR` and their bounded reason/message through the command envelope. Adapter aborts and timeouts retain distinguishable `AbortError` and `TimeoutError` names without arbitrary transport diagnostics.

## Shared client and Git boundary

ShitRat invokes the installed external `sc` client rather than importing its signing implementation or runtime. It does not download the client. Cell routing requires Bun. JWT signing, worker-pass validation and host policy belong to the client and cell.

The cell must approve `api.github.com` and `github.com` and support the GitHub App owner-token credential. API authorization uses `{{secret:shitrat-github/<owner>}}`. Smart HTTP uses `{{secret-basic:user=x-access-token,password=shitrat-github/<owner>}}`; the cell constructs the Basic value. Local smart-HTTP tests establish adapter behavior, not live Git admission. Do not infer production push permission from a read-only status check.

A command lazily owns one loopback forward per upstream host, reusing it for later and concurrent requests. It waits on readiness, not a fixed sleep. Startup has a 10-second deadline; API/cell transports have 60-second deadlines. A dead forward becomes a terminal client refusal, without silently restarting or fetching its old port. Cleanup stops owned forwards at command exit. Another process winning a released-port bind race causes setup failure rather than trust in an arbitrary listener.

Each command generates a fresh random nonce shared with its forwards through `SC_FORWARD_NONCE`. API requests send `x-sc-forward-token`; Git supplies it through invocation-owned environment config, not argv. The compatible client validates and strips this header before upstream forwarding. ShitRat removes echoed nonce headers and redacts the nonce from response bodies, headers and Git output. A nonce refusal is terminal for that command. This proves nonce possession, not protection from a process able to read the command's memory or environment.

Every production Git spawn strips inherited identity bytes, pass and nonce fields, `SHITRAT_CELL_IDENTITY_FILE`, the App key, token variables, `GIT_TRACE*`, `GIT_CURL_VERBOSE`, and `GIT_REDACT_COOKIES`. It also strips inherited `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`, and all `GIT_CONFIG_KEY_*` / `GIT_CONFIG_VALUE_*`. Deliberate invocation config is then applied, including the cell header or scoped direct installation token. Invocation identity and trace overrides remain forbidden. Plain Git hook policy is unchanged.

API requests retain their logical GitHub URL and pagination query but travel through the forward. Redirects and non-GitHub targets are refused. Bodies and API responses are buffered. Git uses binary smart HTTP rather than the REST Git-data API. Authenticated Git invocations disable credential helpers and redirects and retain checkout, authorship and fast-forward checks. There is no adapter retry loop.

## Limits and local proof

Cell results omit installation ID and expiry metadata and return an empty permission map. That map does not establish that the installation lacks permissions. Permission-gated `cancel-runs` and `delete-branch` refuse through the cell because its contract does not return permission metadata. Explicit direct is available for those operations.

SSH, CONNECT, WebSockets, Git LFS and unbounded streaming uploads are unsupported. Downloads redirecting to another host, including Actions job logs, refuse rather than following a signed URL outside the cell. Large pushes remain subject to client/cell limits. API header iteration can collapse multiple `Set-Cookie` values. Git cannot distinguish a local nonce 403 from an upstream policy 403 and reports either as `refused`; the API path identifies nonce refusal as `client`.

```sh
bun run --cwd packages/cli check
bun run --cwd packages/cli test
```

The cell suite uses generated identities, a local fixture cell, a client-contract executable and a local Git HTTP backend. It covers all three routing contracts, setup-only fallback, post-request typed errors, protected identity files, executable ancestry/ownership, safe PATH resolution, lease environment/deadlines, routing event counts, Git environment isolation, pagination, nonce handling and binary push/fetch. Direct requests are intercepted locally.

Set `SHITRAT_TEST_SC_BIN` to an absolute installed client path when running `test/github-cell.test.ts` to exercise real signing and forwarding against the fixture cell, including generated file config. Set `SHITRAT_TEST_OLD_SC_BIN` for the optional old-client refusal test; otherwise that test is skipped. These tests never call GitHub and do not establish live admission or deployment.
