# L7 · server, tenancy, CLI, config, metrics, admin — PDR §4.1, §4.3 (callback on the gateway), §5 (admin MFA), §8, §9 P4

Branch `OneStop-MCP-server`, worktree `.wt/server`. Read PLAN.md and DECISIONS.md D16, D17, D18,
D23, D24, D29, D30, D32 first, then skim the other lane briefs in `docs/burndown/lanes/` — you wire
their pieces, so code against the constructor signatures they specify (L1 `createDiscovery`, L2
`openSecretStore`/`UsageLedger`/`KillSwitch`/`RotationService`/totp, L3 `Registry`/`GatewayAuthBroker`,
L4 `loadManifests`/`FileCatalogStore`/`importCandidates`). Those land on other branches in parallel:
in your worktree, where an import does not exist yet, keep wiring confined to `src/server/app.ts`
and test your own code against small fakes of the `src/contracts.ts` interfaces. The orchestrator
fixes the wiring at integration.

Owns: `src/server/**`, `src/tenancy/**`, `src/cli.ts`, `src/config.ts`, `src/index.ts`,
`scripts/token-budget.ts`, `test/server*.test.ts`, `test/gateway*.test.ts`, `test/cli*.test.ts`,
`test/config*.test.ts`, `test/tenancy*.test.ts`.

## Build (node:http, node:util parseArgs — no express, no commander, no prom-client)

1. **`src/config.ts`** — `loadConfig({ argv?, env? }): Config`. File `one-stop-mcp.config.yaml`
   (path from `--config` or `OSMCP_CONFIG`, else `$OSMCP_HOME/config.yaml` if present) + `OSMCP_*` env
   overrides + defaults. Fields: `mode: local | team`, `home` (`OSMCP_HOME`, default `~/.one-stop-mcp`),
   `serversDir` (default repo `servers/`), `catalogDir` (repo `catalog/`), `http { host, port (8420),
   publicUrl }` (local mode host forced to 127.0.0.1), `vault { backend, keyProvider, hashicorp?,
   transit?, awsKms? }`, `routing { embeddings: on|off, model? }`, `compress`, `ttlMs`,
   `rotation { days: 90, checkEveryMs }`, `ledger { burstMax, windowMs }`, `metrics { token? }`.
   The master key is **only** from `OSMCP_MASTER_KEY`; never from the file (D29). Team mode without
   it (and without a KMS key provider) → refuse to start with a clear message. Validate and fail loud.
2. **`src/tenancy/users.ts`** — `UserStore` persisted at `$OSMCP_HOME/users.json` (atomic write,
   0600): users `{ id, org, admin, tokens: [{ id, hash (sha256 hex), createdAt, lastUsedAt? }] }`.
   `add`, `remove`, `list`, `issueToken(user)` → plaintext `osmcp_<base64url 32 bytes>` returned once,
   `revokeToken`, `authenticate(bearer)` → `Principal | undefined` (hash lookup). TOTP secrets for
   admins are stored in the SecretStore (scope `{ org, user, server: "_totp" }`, kind `client`), not
   in users.json.
3. **`src/server/gateway.ts`** — `buildGateway(deps, principal)` → SDK `Server` advertising exactly
   the four `META_TOOLS`. Dispatch with the principal: `find_tools` → `registry.findTools(p, query, k)`
   returning `{ tools: [...], confidence, widened, browse? }`; `list_servers(filter)` — extend the
   input schema minimally with optional `category`, `tag`, `auth` while keeping the whole surface
   well under 2k tokens (`npm run budget` must pass; update `scripts/token-budget.ts` if needed);
   `invoke`; `connect_server` → `auth.connect(p, server)`. Errors become `isError` results with
   messages that never contain secrets.
4. **`src/server/http.ts`** — `startHttp(app, cfg)`:
   - `/mcp` (team mode): Streamable HTTP per the SDK (`StreamableHTTPServerTransport`, session ids,
     one gateway `Server` per session bound to the principal from `Authorization: Bearer`; 401 with
     `WWW-Authenticate: Bearer` otherwise). Stateless GET/DELETE handling per SDK docs.
   - `GET /oauth/callback` → `auth.handleOAuthCallback(url.searchParams)` → small HTML result page.
   - `GET /connect/:ticket` → key-entry HTML form (shows server name + "get a key" link from
     `ticketInfo`; for kind `client`, fields for client id + secret). `POST /connect/:ticket`
     (urlencoded) → `auth.submitApiKey`. Reject cross-origin POSTs (check `Origin`/`Sec-Fetch-Site`).
     `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, a strict CSP, `X-Frame-Options: DENY`.
   - `/admin/api/*` — admin bearer **and** `X-OSMCP-TOTP` code (D16), every call ledgered:
     `GET ledger?user&server&since&limit`, `GET ledger/verify`, `GET ledger/flagged`,
     `GET kill`, `POST kill/all`, `POST kill/server/:id`, `POST kill/user/:org/:user`,
     `POST enable/server/:id`, `POST enable/user/:org/:user`, `POST lockdown/end`,
     `GET rotation/due`, `POST rotate` (`{ scope }` | `{ group }` | `{ all: true }`),
     `POST incident` (`{ since?, user?, server? }`), `GET users`, `POST users`,
     `POST users/:id/token`, `GET health?ids`. JSON in/out, 1 MB body limit.
   - `GET /admin` — one self-contained HTML page (no external assets) that asks for the admin token and
     TOTP, keeps them in memory only, and drives the admin API: ledger table with flagged rows,
     kill-switch panel (revoke all / server / user, re-enable one at a time), rotation (due list,
     rotate one/group/all), incident button.
   - `GET /metrics` — Prometheus text format (D24), optional bearer `metrics.token`:
     `osmcp_invocations_total{server,result}`, `osmcp_find_tools_total{confidence}`,
     `osmcp_sessions_active`, `osmcp_ledger_flagged_total`, `osmcp_vault_frozen`,
     `osmcp_invoke_duration_seconds` histogram. `src/server/metrics.ts` is a tiny registry.
   - `GET /healthz`.
   Local mode serves only `/oauth/callback`, `/connect/*` and `/healthz`, bound to 127.0.0.1.
5. **`src/server/app.ts`** — `createApp(cfg): Promise<App>`: the composition root that builds store,
   ledger, kill switch, catalog store, discovery, broker, registry, rotation (schedule started),
   user store, and returns them plus `close()`.
6. **`src/cli.ts`** (bin; `src/index.ts` just calls it) — commands:
   `serve` (default; local stdio + loopback HTTP), `serve --http` (team), `init` (state dir, key file,
   first admin user, prints token once + `otpauth://` URI), `user add <id> --org <org> [--admin]`,
   `user list`, `user token <id>`, `user remove <id>`, `servers list`, `connect <server> [--user u --org o]`,
   `kill all | server <id> | user <org/user>`, `enable server <id> | user <org/user>`, `lockdown end`,
   `rotate <server> | --category <c> | --all`, `rotate due`, `incident [--user u] [--server s] [--since ISO]`,
   `ledger tail [-n N] | verify | flagged`, `catalog refresh [ids…]`, `sync [--registry URL]`,
   `health [ids…]`, `validate`. Local mode: CLI acts on the state dir directly (operator = admin; the
   kill-switch file is re-read by a running gateway, D30). `--remote <url> --token <t> --totp <code>`
   sends admin commands to a team gateway's admin API instead.
7. Tests: config precedence + team-mode refusal; user tokens (hash only on disk); gateway meta-tool
   surface + dispatch with a principal (fakes); HTTP: 401 on `/mcp` without token, MCP round trip
   with a token through a real `StreamableHTTPClientTransport`, admin API rejects missing/wrong TOTP,
   cross-origin POST rejected, `/metrics` format; CLI arg parsing for each command. Ephemeral ports.

## Done when

`npx tsc --noEmit` green (or only failing on imports from lanes not yet merged — list them) and your
tests green. Branch pushed. Final message: short report — files, exported signatures, every place
you assumed another lane's API.
