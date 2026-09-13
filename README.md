# One-Stop MCP

![Status: in active build, not released](https://img.shields.io/badge/status-in%20active%20build%20%C2%B7%20not%20released-orange)

**Status: in active build. Nothing is released or published.** The proxy, router, and security modules run and are tested locally; the OAuth broker, embedding-based routing, and the seed catalog are design-stage. [Details](#status).

One-Stop MCP is a gateway between one MCP client and any number of MCP servers. Connected tool definitions are re-processed, and billed, on every model request, so the cost of a session grows with how many tools you have connected rather than how much work you do. The gateway holds the client-facing surface at four fixed meta-tools regardless of how many servers sit behind it, and injects a downstream tool's full schema only when a task needs it. Because every server is reached through the gateway, it is also the one place credentials are stored and used.

[Original design brief (PDR)](docs/PDR.md) · [Styled HTML version of this page](docs/index.html) (open it in a browser; GitHub shows HTML files as source)

---

## The problem: tool definitions are billed on every request

Every connected MCP server's tool catalog (names, descriptions, JSON schemas) goes into the model's context at session start. Connect enough servers and that is tens of thousands of tokens of schema before you type anything.

Inference re-processes the whole context on every request: system prompt, tool definitions, conversation so far. So you don't pay for tool definitions once. You pay for them on every request, for the entire session, and in an agent loop every tool call round trip is another request.

Your bill therefore scales with how many tools are connected, not with how much work is being done. Most of that spend buys nothing: any given request uses two or three tools out of a hundred.

**Where this came from.** The problem was found by profiling real Claude Code sessions with `/usage`: most of each session's token spend was going to re-processing context rather than to the work itself. Tool definitions are the part of that re-processing that grows with every server you connect.

### Worked example (illustrative)

These are assumptions, not measurements. Substitute your own numbers.

| assumption | value |
|---|---|
| Connected servers | 10 |
| Tools per server, average | 12, so 120 tools |
| Tokens per tool definition (name, description, schema) | 300, so 36,000 tokens |
| Model requests in the session, counting tool-call round trips | 50 |
| Gateway: `find_tools` calls | 5, spread through the session, each one an extra request (55 total) |
| Gateway: tools returned per `find_tools` call | 5 (the default `k`) × 300 tokens = 1,500 tokens |

**Connected directly:**

```text
36,000 tokens × 50 requests                                   = 1,800,000 tokens
```

**Through the gateway:**

```text
fixed surface   341 tokens × 55 requests                      =    18,755
shortlists      1,500 tokens × 160 re-reads                   =   240,000
                (a find_tools result stays in the conversation and is
                 re-read by every later request: 54 + 43 + 32 + 21 + 10)
total                                                         =   258,755 tokens
```

That is about 86% fewer tool-definition tokens for this session. At an assumed $3 per million input tokens and no caching, it is $5.40 versus $0.78.

The percentage matters less than the slope. Connect ten more servers and the direct figure doubles to 3,600,000. The gateway figure does not change, because neither the fixed surface nor the shortlist size depends on how many servers are registered.

Not counted in this example:

- Each `find_tools` call is an extra model request, and that request re-reads the rest of the conversation too. That overhead is real and is not in the numbers above.
- Schema compression is ignored; shortlists are counted at full size.
- 341 is a chars/4 estimate of the gateway's `tools/list` payload (`npm run budget`), not a tokenizer count.

**Prompt caching changes the rate, not the shape.** Where a provider caches the stable prefix of a request, re-reading tool definitions is billed at a discount instead of full price. It is still billed on every request, caches expire during pauses, and any change to the connected tool set invalidates the cached prefix. The gateway's four-tool surface caches as well, and it does not change when servers are added.

**Some clients already defer tool loading.** Where a client or model API has its own tool search, part of this cost is handled there. The gateway does it at the MCP layer, so it works the same with any client, and it is where the credential boundary below lives.

### What follows from fixing it: credential sprawl

A dozen directly connected servers means credentials spread across a dozen client configs, with no shared rotation, no audit trail, and no single place to revoke access. Once every server sits behind one gateway, every credential is used from one process. That is where the vault and OAuth broker go. See [Credentials](#credentials-vault-and-oauth-broker).

---

## How it works

<p align="center">
  <img src="assets/topology.svg" width="100%" alt="One-Stop MCP topology: one client connects to the gateway, which routes to many downstream servers">
</p>

<sub>Target architecture. Parts of it are design-stage; see [Status](#status).</sub>

The gateway is an MCP server to the client and an MCP client to each downstream server.

### The client-facing surface: four meta-tools

The client's `tools/list` returns these four tools and nothing else, at any catalog size. Serialized, they come to ~341 tokens (chars/4 estimate). `npm run budget` fails if the estimate exceeds 2,000.

| meta-tool | what it does |
|---|---|
| `find_tools(query, k?)` | Ranks the whole catalog against a natural-language query and returns the top `k` (default 5) tools with their input schemas. |
| `list_servers(filter?)` | Lists registered servers: id, name, category, description, auth type, and whether a session is running. No schemas. |
| `invoke(server, tool, args)` | Calls one tool on one downstream server and returns its result. |
| `connect_server(server)` | Starts auth for a server. Today it only reports the auth type declared in the manifest; the broker is design-stage. |

### Just-in-time schema injection

1. The model calls `find_tools("open an issue for this bug")`.
2. The gateway reads each server's tool list via `tools/list` (cached after the first read) and ranks every tool against the query.
3. The top `k` tools come back with their schemas, compressed to remove JSON-schema boilerplate. This is the only way downstream schemas enter context.
4. The model picks one and calls `invoke(server, tool, args)`.
5. The gateway forwards the call over a pooled session to that server and returns the result.

### Routing

**Design.** Hybrid retrieval: a sparse leg (BM25) and a dense leg (local sentence embeddings), fused with Reciprocal Rank Fusion. The model makes the final choice from the shortlist. Fallback ladder: exact or keyword match, then vector similarity, then category browse via `list_servers`; on low confidence, widen the shortlist rather than guess.

**Built.** Two lexical legs, field-weighted keyword overlap with light stemming and field-weighted Okapi BM25, fused with RRF (k = 30). Matches in the tool name count most, then example utterances and category, then description. The dense leg's interfaces (`Embedder`, `VectorRouter`) exist, but no embedding model is wired in. The widen-on-low-confidence fallback is not built.

**Measured.** 85.3% top-3 (29 of 34) and 55.9% top-1 on an offline benchmark: 34 paraphrased queries against 82 hand-written tool entries from 13 servers (`npm run bench`, last recorded 2026-09-03). The target is 90% top-3. The remaining misses are synonyms ("book" meaning create an event, "jot down" meaning append) that lexical matching cannot catch, which is the dense leg's job. The benchmark measures ranking only; it spawns no servers.

### Lazy sessions

Registered is not running. No downstream server starts when the gateway starts. A server is spawned by the first call that needs it; its session is pooled and closed after 60 seconds idle. Its tool list is cached for the life of the gateway process, so later searches do not respawn it.

Current limitation: the first `find_tools` call spawns every registered server once to read its tool list. That is acceptable for a handful of servers and not for thousands. Building the catalog at registration time, so discovery never spawns servers, is design-stage.

### Schema compression

Shortlisted schemas pass through a compressor before they are returned. `light` (the default) removes `$schema`, `$id`, `$ref`, `title`, `examples`, `$comment`, and `additionalProperties: false`, and keeps types, properties, `required`, and enums. `aggressive` also removes descriptions. That is smaller, but it can hurt tool selection; how far to go is an open question.

### What stays constant and what grows

| | connected directly | through the gateway |
|---|---|---|
| Tool definitions in every request | every tool from every server | 4 meta-tools, ~341 tokens |
| Schemas added per discovery | none (already all present) | up to `k`, default 5 |
| Client context cost of adding a server | grows | none |
| Where catalog size costs something | client context, on every request | gateway memory and ranking time |

---

## Credentials: vault and OAuth broker

With every server behind the gateway, every credential is used from the gateway. Holding them there, instead of in each client config, is what makes rotation, audit, and revocation possible from one place.

### Design

1. The client calls `connect_server("notion")`.
2. The gateway reads the server's auth type from its manifest (for example OAuth2).
3. The gateway starts the OAuth flow and returns a redirect URL to the user.
4. The user approves in the browser. The callback lands on the gateway, not the client.
5. Tokens are encrypted and stored in the vault, scoped to that user and server.
6. Later calls to that server are authenticated by the gateway.

Secrets are never written to client config, never returned to the model, and never logged; they are injected only into the outbound call they authenticate. Around the vault, the design adds a usage ledger (which server, which tool, when, and the result, with bulk access flagged), a kill switch (revoke every session and freeze the vault in one action, or scope it to a server or a user), and one-place rotation (automated for OAuth refresh and for providers with key-management APIs, guided otherwise). Team deployments get per-org scoping, admin MFA, and pluggable backends such as HashiCorp Vault or a cloud KMS.

### Built so far

| component | what exists | not yet |
|---|---|---|
| `Vault` ([`src/vault.ts`](src/vault.ts)) | AES-256-GCM with a key derived by scrypt from an operator passphrase; secrets scoped to (user, server); encrypted snapshot and reload; `freeze()`; `rotate()` replaces a stored secret | Not wired into the running gateway. Nothing injects vault secrets into outbound calls yet. |
| `UsageLedger` ([`src/ledger.ts`](src/ledger.ts)) | Records every `invoke` (user, server, tool, result). Flags more than 100 calls to the same (user, server, tool) within 60 seconds; both limits configurable. | In-memory only. No persistence and no viewer. |
| `KillSwitch` ([`src/security.ts`](src/security.ts)) | Closes all downstream sessions and freezes the vault, or closes one server's session. Each action is recorded in the ledger. | No operator command or UI triggers it. Per-user revocation is not built. |
| OAuth broker | Nothing yet; `connect_server` is a stub. | Design-stage. |
| Rotation | Manual replacement via `Vault.rotate()`. | Automated refresh and scheduled rotation are design-stage. |

The design brief names libsodium. The implementation uses Node's built-in `crypto` to avoid a dependency; heavier backends remain the plan for team deployments.

---

## Status

The gateway runs locally over stdio and proxies a demo server end to end. It is not packaged, not published, and not ready for real credentials.

| area | state | evidence |
|---|---|---|
| Four-tool facade over stdio | Built, tested | `test/gateway.test.ts` |
| Startup surface under 2,000 tokens | Built; ~341 tokens (chars/4 estimate) | `npm run budget` |
| Downstream proxy: stdio, pooled sessions, 60 s idle timeout | Built; tested against a demo echo server | `test/gateway.test.ts` |
| Streamable HTTP, client-facing or downstream | Not built. Manifests accept it; connecting throws. | `src/registry.ts` |
| Lexical hybrid router (overlap + BM25, RRF) | Built; 85.3% top-3, below the 90% target | `npm run bench` |
| Dense (embedding) routing leg | Interfaces only; no model chosen | `src/router.ts` |
| Schema compression | Built, tested | `test/compress.test.ts` |
| Vault, usage ledger, kill switch | Built as modules, tested; only the ledger is wired into the gateway | `test/security.test.ts` |
| OAuth broker, credential injection, automated rotation | Design-stage | |
| Seed catalog of 50 servers | Not started; one demo manifest (`servers/echo.yaml`) | |
| Multi-tenant deployment, observability | Not started | |
| npm and Docker packaging | Not started (`package.json` is marked private) | |

The 26 tests (`npm test`), the budget estimate, and the benchmark result were last recorded on 2026-09-03.

### Running it locally (development only)

From the repo root:

```bash
npm install
npm run build
npm start          # gateway on stdio; loads manifests from servers/
npm test           # client -> gateway -> echo server over stdio
npm run budget     # startup-surface size check
npm run bench      # routing accuracy on the offline benchmark
```

Point an MCP client at `node dist/index.js`. The only server included is `servers/echo.yaml`.

---

## Roadmap

| phase | scope | exit criterion | state |
|---|---|---|---|
| P0 Core | Four-tool facade; one server proxied over stdio | Startup surface under 2k tokens | Done |
| P1 Discovery | Manifests, router, just-in-time injection | 90% top-3 on the routing benchmark | In progress: 85.3%, dense leg pending |
| P2 Auth | Vault, `connect_server` OAuth flow, ledger, rotation, kill switch | An OAuth server activated entirely inside the gateway | In progress: vault, ledger, and kill switch built as modules; broker not started |
| P3 Seed | 50 server manifests, registry sync | Useful on first run | Not started |
| P4 Team | Multi-tenant, per-user secrets, metrics | Self-hosted multi-user deployment | Not started |
| P5 Community | Docs, manifest CI validation, RFC process, governance | External PRs merging | Not started |

Open design questions (core language, which 50 servers, embedding model, secret isolation, compression level, registry sync, rotation policy, anomaly detection, governance) are in [docs/PDR.md](docs/PDR.md#10--open-questions--for-the-rfc).

---

## Contributing: add a server with one file

Adding a server is one YAML file in `servers/` and one PR. No gateway code changes. The gateway loads every `*.yaml` in `servers/` at startup and gets the tool list from the server itself via `initialize` and `tools/list`.

```yaml
# servers/filesystem.yaml
id: filesystem
name: Filesystem
category: [dev, files]
description: Read, write, and search files under an allowed directory.
transport:
  type: stdio
  command: npx
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"]
auth:
  type: none                # none | api_key | oauth2
routing:
  examples:                 # matched against find_tools queries
    - "read the config file in my project"
    - "list the files in the docs folder"
```

Required fields are `id`, `name`, `transport.type`, and `command` for stdio or `url` for streamable-http. A malformed manifest fails at load time with the file name.

What works today:

- Only `stdio` connects. `streamable-http` passes validation but is not supported yet.
- Only `auth: none` works end to end. `api_key` and `oauth2` servers register but cannot authenticate until the broker exists.
- `routing.examples` apply to every tool on the server. Per-tool examples are planned.
- `servers/echo.yaml` is the only manifest tested end to end. Manifest CI validation is planned (P5), not built.

Other useful contributions:

- Labeled queries in `bench/queries.jsonl`, with matching entries in `bench/catalog.json`. The benchmark is the acceptance gate for routing changes.
- An `Embedder` implementation backed by a local model, for the dense routing leg.
- Streamable HTTP transport on both faces.
- Input on the open questions in [docs/PDR.md](docs/PDR.md#10--open-questions--for-the-rfc).

---

## Non-goals

- **Building MCP servers.** The gateway aggregates existing ones.
- **Changing or extending the MCP protocol.** Everything is built from standard messages.
- **A hosted service.** The target is self-hosted. The design should not rule out a hosted version, but none is planned.
- **A fine-tuned routing model.** Off-the-shelf retrieval and embeddings first.
- **Shrinking tool results.** The gateway reduces the cost of tool definitions. What a tool returns passes through.

---

## MCP spec compliance

**Conforms**

- Toward the client, the gateway is a standard MCP server built on the official TypeScript SDK (`@modelcontextprotocol/sdk` ^1.30). It declares the `tools` capability and serves `tools/list` and `tools/call`.
- Toward each downstream server, it is a standard MCP client: `initialize`, `tools/list`, and `tools/call` over stdio.
- There are no custom methods, capabilities, or message fields. The meta-tools are ordinary MCP tools.

**Where behavior differs from a direct connection.** These are conventions on top of the protocol, not extensions to it.

- Downstream tools are not registered with the client. Their schemas arrive as JSON text inside a `find_tools` result, and calls go through `invoke`. The client therefore cannot validate arguments against the downstream schema (the downstream server still does), and a client with per-tool permission prompts sees `invoke`, not the underlying tool.
- `invoke` returns the downstream result serialized as JSON in a single text content block. Image, audio, and resource content is not passed through as native content blocks, and a downstream `isError` appears inside that JSON rather than on the gateway's response.

**Not supported yet**

- Resources, prompts, sampling, elicitation, roots, and `notifications/tools/list_changed`. None are exposed to the client or proxied from downstream servers.
- Streamable HTTP on either side.
- The MCP authorization flow for HTTP servers. Credential handling is the design-stage vault and broker described above.

---

## License

`package.json` declares Apache-2.0; a LICENSE file has not been added yet. Vendored agent skills under `.claude/` carry their own licenses.

## Further reading

- [docs/PDR.md](docs/PDR.md): the original design brief (PDR v0.1, August 2026), with build principles, the full security design, the seed catalog plan, and open questions. Its styled original is [docs/PDR.html](docs/PDR.html).
- [docs/index.html](docs/index.html): this README as a styled page. Both HTML files render when opened in a browser.
- [archive/README.md](archive/README.md): the previous developer README.
