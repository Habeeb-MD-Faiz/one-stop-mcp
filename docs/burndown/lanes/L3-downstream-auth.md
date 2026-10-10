# L3 · downstream + auth broker — PDR §4.3 (connect_server/OAuth), §4.4 (lazy sessions), §8 transports

Branch `OneStop-MCP-downstream`, worktree `.wt/downstream`. Read PLAN.md and DECISIONS.md D15,
D18, D25, D26, D31 first. Contracts in `src/contracts.ts`: Principal, SecretStore, SecretScope,
Ledger, AccessGuard, AccessDeniedError, SessionControl, CatalogStore, CatalogSnapshot, Discovery,
DiscoveryResult, AuthBroker, ConnectResult, OutboundAuth. Manifest in `src/types.ts`.
SDK: `@modelcontextprotocol/sdk` 1.30 — read `node_modules/@modelcontextprotocol/sdk/dist/esm/client/auth.d.ts`
(OAuthClientProvider, auth(), discovery, DCR, PKCE, refresh), `client/streamableHttp.d.ts`,
`client/sse.d.ts`, `client/stdio.d.ts`, `server/streamableHttp.d.ts`, `server/auth/**`.

Owns: `src/downstream/**`, `src/auth/**`, `test/downstream*.test.ts`, `test/oauth*.test.ts`,
`test/fixtures/**`. Other lanes build the pieces you consume — code against the contracts and use
small in-test fakes for SecretStore/Ledger/AccessGuard/CatalogStore/Discovery.

## Build

1. **`Registry implements SessionControl`** (rewrite `src/downstream/registry.ts`). Ctor
   `(manifests: Manifest[], deps: { catalog: CatalogStore; discovery: Discovery; auth: AuthBroker;
   guard: AccessGuard; ledger: Ledger; ttlMs?: number; compress?: CompressLevel })`.
   - `manifest(id)`, `manifests()`.
   - `listServers(p, filter?: { text?: string; category?: string; tag?: string; auth?: "none" | "api_key" | "oauth2" | "connected" | "not_connected" })`
     → id, name, category, tags, description, auth type, connected (has a stored credential for `p`), running. No schemas.
   - `findTools(p, query, k)` → `DiscoveryResult` with compressed schemas. **Never spawns a server**:
     routable tools come from `catalog.load(id)` snapshots; build them with the shared helper
     `toRoutable(manifest, snapshot)` that L1 exports from `src/routing/index.ts` (if it is not there
     yet in your worktree, write a local equivalent and note it — examples = `routing.tools[tool]`
     plus server-level `routing.examples`). Servers with no snapshot are skipped and counted in the
     result (add `unindexed?: string[]` only if you need it — report it as a contract change).
   - `invoke(p, server, tool, args)`: `guard.check(p, server)` → `auth.outbound(p, manifest)` → pooled
     session → `callTool` → ledger `{ org, user, server, tool, result }` → result passed through a
     redaction step that removes any injected secret value (a local `redactValues(obj, secrets)`;
     L2 is also building `src/security/redact.ts` — integration will dedupe). Denials ledger `denied`.
   - `refreshCatalog(p, id)`: live `tools/list` → `catalog.save({ server, source: "live", fetchedAt, tools })`.
     Also save a snapshot automatically the first time a session for a server opens and it has none.
   - `health(p, id)`: per `manifest.health.check` (`initialize` = connect; `tools/list` = list; `none`
     = skip) → `{ server, ok, latencyMs, error? }`.
   - Pooling: key `org/user/server` for servers with auth, `shared/server` for `auth: none`. TTL reap
     as today. `closeAll/closeServer/closeUser`. `runningServers()`.
2. **Transports.** stdio: env = SDK `getDefaultEnvironment()` + manifest `transport.env` + injected
   credential env — never `process.env` wholesale (D31). Streamable HTTP: `StreamableHTTPClientTransport`
   with `requestInit.headers` (manifest headers + injected header) and/or `authProvider`; on a
   4xx at connect, fall back to `SSEClientTransport` (the SDK's documented backwards-compat pattern).
3. **`GatewayAuthBroker implements AuthBroker`** (`src/auth/broker.ts`). Ctor `{ store: SecretStore;
   ledger: Ledger; manifest: (id) => Manifest | undefined; publicUrl: string; now?: () => number }`.
   - `connect(p, id)`: none → `ready`; stored credential → `connected`; api_key → one-time ticket
     (32 random bytes base64url, 15 min, bound to the scope) → `pending` with
     `url = ${publicUrl}/connect/${ticket}`; oauth2 → `pending` with the authorization URL:
     - HTTP server with no explicit endpoints: MCP authorization spec via the SDK — a
       `VaultOAuthProvider implements OAuthClientProvider` (`src/auth/vault-oauth-provider.ts`)
       whose `redirectToAuthorization(url)` captures the URL, `saveTokens` writes the store
       (kind `oauth2`), `saveCodeVerifier`/`codeVerifier` keep PKCE state, `clientInformation`/
       `saveClientInformation` persist the dynamic-client registration (scope
       `{ org: "_gateway", user: "_client", server }`, kind `client`). `redirectUrl` =
       `${publicUrl}/oauth/callback`.
     - Explicit `authorizationUrl`/`tokenUrl` (stdio OAuth servers): generic OAuth 2.1 auth code +
       PKCE S256 + `state`. If the manifest has no `clientId` and no stored `client` secret for the
       server, return `pending` with a key-entry URL of kind `client` (operator pastes their OAuth
       client id/secret), then continue.
   - `handleOAuthCallback(query)`: look up `state` → exchange the code (SDK `auth(provider,
     { serverUrl, authorizationCode })` or a token POST) → store → ledger `auth.connect`.
     Unknown/expired state → `ok: false`. Pending flow state is in memory with a TTL
     (`ponytail:` restart loses in-flight logins; fine).
   - `submitApiKey(ticket, key)`, `ticketInfo(ticket)`, `keyEntryUrl(scope)`.
   - `outbound(p, m)`: api_key → `{ env: { [auth.env]: key } }` (stdio) or header (`auth.header`
     default `Authorization`, prefix default `Bearer ` for Authorization); generic oauth2 → access token
     (refresh first if expired) injected the same way; MCP-spec oauth2 over HTTP → `{ authProvider }`.
     No credential → throw an error whose message tells the model to call `connect_server`.
   - `refresh(scope)`: refresh-token grant (generic) or SDK `refreshAuthorization`; store the new tokens.
4. **End-to-end tests, all offline on 127.0.0.1 (no real provider ever):**
   - `test/oauth.e2e.test.ts`: in-process fake authorization server (RFC 8414 metadata, RFC 7591
     `/register`, `/authorize` that 302s straight back with `code` + `state`, `/token` that verifies
     PKCE and supports `refresh_token`) and a protected MCP server (SDK `McpServer` +
     `StreamableHTTPServerTransport` on node:http; serves RFC 9728 protected-resource metadata;
     answers 401 with `WWW-Authenticate: Bearer resource_metadata=...` without a valid token).
     Flow: `connect` → pending URL → `fetch(url, { redirect: "manual" })` → follow the Location to the
     callback → `handleOAuthCallback` → `invoke` succeeds → expire the token → call again succeeds via
     refresh → `refresh(scope)` works directly.
   - Generic OAuth on stdio: fake AS + a fixture stdio server (`test/fixtures/`) that reports only
     whether its token env var is present (never echoes it).
   - api_key: connect → ticket → submitApiKey → invoke with env injection; HTTP header injection.
   - Laziness: `findTools` over 50 fake manifests spawns zero processes.
   - Gateway env isolation: a child never sees `OSMCP_MASTER_KEY`.
   - Redaction: a downstream that echoes its injected key returns `[REDACTED]`.

## Done when

`npx tsc --noEmit` green and your tests green. `test/gateway.test.ts` and `test/security.test.ts`
use the old Registry API — they belong to other lanes; leave them, note the break in your report.
Branch pushed. Final message: short report with the exact public signatures you built and any
contract change you needed.
