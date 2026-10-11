# Adding a server

A server is one manifest in `servers/`, one tool snapshot in `catalog/`, and four routing queries in `bench/seed/`. No gateway code changes. The step-by-step is in [CONTRIBUTING.md](../CONTRIBUTING.md#1-add-a-server); this page is the field reference. Related: [routing](routing.md) · [architecture](architecture.md).

## Minimal manifest

```yaml
# yaml-language-server: $schema=../schema/manifest.schema.json
# Source: https://github.com/modelcontextprotocol/servers (reference)
id: filesystem
name: Filesystem
category: [dev, code]
description: Read, write and search files under an allowed directory.
transport:
  type: stdio
  command: npx
  args: ["-y", "@modelcontextprotocol/server-filesystem@1.2.3", "/path/to/allowed/dir"]
auth:
  type: none
routing:
  examples:
    - "read the config file in my project"
    - "list the files in the docs folder"
health:
  check: initialize
```

The first line makes editors that use the YAML language server offer completion and errors from the JSON Schema. The `Source:` comment records what you verified, so a reviewer can check it. (`1.2.3` is a placeholder; use the exact version you checked.)

## The PDR example

The manifest from section 6 of the [design brief](PDR.md#06--the-server-manifest), extended with the optional fields this implementation accepts:

```yaml
# yaml-language-server: $schema=../schema/manifest.schema.json
# one file. one PR. the gateway derives the rest.
id: notion
name: Notion
category: [productivity, docs]
tags: [official, remote]
description: >
  Read, search, and write Notion pages, databases, comments.
homepage: https://www.notion.so

transport:
  type: streamable-http        # or: stdio
  url: https://mcp.notion.com/mcp

auth:
  type: oauth2                 # none | api_key | oauth2
  scopes: [read_content, update_content]

routing:                       # powers the semantic index
  examples:
    - "find my meeting notes in notion"
    - "create a page in my workspace"
    - "search the docs database"
  tools:                       # optional: utterances for one tool
    search: ["search my workspace for the onboarding doc"]

health:
  check: initialize
```

The PDR's original example (without `tags`, `homepage` and `routing.tools`) stays valid. The tool list, the embeddings and the OAuth configuration are derived; the contributor does not write them.

## Field reference

Unknown top-level keys are an error, which catches typos. Every error names the file and the field.

### Identity

| Field | Required | Rule |
|---|---|---|
| `id` | yes | Lowercase kebab-case (`google-calendar`) and **equal to the file name** (`servers/google-calendar.yaml`). Unique across the catalog. Permanent: it is how users, the vault and the ledger refer to the server. |
| `name` | yes | Display name, non-empty. |
| `description` | yes | One or two sentences: what it reads and writes. Indexed for routing, so be concrete. |
| `category` | yes | A list. Each entry must come from the allowed set: `dev`, `code`, `data`, `database`, `productivity`, `docs`, `knowledge-base`, `communication`, `search`, `web`, `browser`, `cloud`, `infra`, `ai`, `memory`, `crm`, `sales`, `marketing`, `payments`, `design`, `testing`, `utility`. Categories feed `list_servers` filtering and the "browse" fallback. |
| `tags` | no | Free labels for `list_servers` filtering, e.g. `official`, `remote`, `community`. |
| `homepage` | no | Documentation or repository URL. |


### `transport`

Either a local process or a remote endpoint.

```yaml
transport:                      # stdio
  type: stdio
  command: npx                  # required
  args: ["-y", "some-mcp-server@2.4.1"]
  env:                          # fixed, non-secret variables for the child
    LOG_LEVEL: warn
```

```yaml
transport:                      # streamable-http
  type: streamable-http
  url: https://mcp.example.com/mcp     # required
  headers:                             # fixed, non-secret headers
    X-Client: one-stop-mcp
```

- **Pin versions.** An `npx` or `uvx` package must carry an exact version (`pkg@2.4.1`). The gateway runs this command on the user's machine, with their credentials, so a floating version is a supply-chain hole.
- **Never put a credential in `transport`.** Keys belong to `auth`; the gateway injects them from the vault.
- Prefer the vendor's hosted Streamable HTTP endpoint when one exists. The gateway falls back to legacy SSE if the server rejects Streamable HTTP.
- A stdio child gets a minimal environment: the MCP SDK's default safe variables (on Linux and macOS `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`), `transport.env`, and the injected credential. It does not inherit the gateway's environment. `HOME` lets tools such as `aws` and `kubectl` find `~/.aws` and `~/.kube`; if a server needs `AWS_PROFILE` or `KUBECONFIG`, set it in `transport.env`.

### `auth`

```yaml
auth:
  type: none | api_key | oauth2
```

| Field | Applies to | Meaning |
|---|---|---|
| `scopes` | `oauth2` | Scopes to request. |
| `env` | stdio | Environment variable the credential (API key or OAuth access token) is injected into. |
| `header` | HTTP | Header carrying the credential. Default `Authorization`. |
| `prefix` | HTTP | Value prefix. Default `Bearer ` for `Authorization`, otherwise empty. |
| `keyUrl` | `api_key` | The provider page where a user creates or re-issues a key. Shown on the key-entry page and used by guided rotation. |
| `rotation` | `api_key` | Id of a provider adapter that can rotate the key by API (today: `cloudflare`). Leave it out for guided rotation. |
| `authorizationUrl`, `tokenUrl` | `oauth2` | Explicit OAuth endpoints, for servers that do not do MCP authorization discovery (most stdio servers). |
| `clientId` | `oauth2` | Public OAuth client id (PKCE). A client **secret**, if the provider needs one, is entered by the operator and kept in the vault, never in this file. |

Rules the validator enforces:

- Each auth type accepts only its own keys. `none`: just `type`. `api_key`: `env`, `header`, `prefix`, `keyUrl`, `rotation`. `oauth2`: `scopes`, `env`, `header`, `prefix`, `authorizationUrl`, `tokenUrl`, `clientId`. Anything else is an error that names the field.
- `env` is only valid on a stdio transport; `header` and `prefix` only on streamable-http.
- `api_key` on a stdio server needs `env`. On an HTTP server `header` defaults as above.
- `oauth2` on a stdio server needs `authorizationUrl`, `tokenUrl` **and** `env`. `authorizationUrl` and `tokenUrl` must be given together.
- `oauth2` on an HTTP server with **no** endpoints uses MCP authorization discovery (RFC 9728, RFC 8414, dynamic client registration RFC 7591). Most hosted remote servers need nothing more than `type: oauth2`.

Examples:

```yaml
auth:                           # API key in an environment variable, stdio
  type: api_key
  env: EXAMPLE_API_KEY
  keyUrl: https://example.com/settings/api-keys
```

```yaml
auth:                           # API key in a header, HTTP
  type: api_key
  header: X-API-Key
  prefix: ""
  keyUrl: https://example.com/settings/api-keys
```

```yaml
auth:                           # OAuth for a stdio server
  type: oauth2
  scopes: [read, write]
  authorizationUrl: https://example.com/oauth/authorize
  tokenUrl: https://example.com/oauth/token
  clientId: your-public-client-id
  env: EXAMPLE_ACCESS_TOKEN
```

### `routing`

```yaml
routing:
  examples:                     # whole server: 3-5 requests a user might type
    - "find my meeting notes in notion"
  tools:                        # optional, per tool: utterances for that tool only
    search: ["search my workspace for the onboarding doc"]
```

`routing.tools` keys are tool names and must exist in the snapshot; values are lists of strings. See [routing](routing.md#improving-routing) for how to write utterances that help.

### `health`

```yaml
health:
  check: initialize | tools/list | none
```

What `one-stop-mcp health` does for the server: `initialize` connects and handshakes; `tools/list` also lists tools; `none` skips it (use for servers that cannot be checked without credentials).

## The snapshot: `catalog/<id>.json`

Discovery uses a stored copy of the server's tool list, so it never has to start the server.

```json
{
  "server": "notion",
  "source": "docs",
  "fetchedAt": "2026-10-10T00:00:00Z",
  "tools": [
    {
      "name": "search",
      "description": "Search the workspace for pages and databases.",
      "inputSchema": {
        "type": "object",
        "properties": { "query": { "type": "string", "description": "Text to search for." } },
        "required": ["query"]
      }
    }
  ]
}
```

- Get it from the running server: `one-stop-mcp catalog refresh <id>` writes a `source: "live"` snapshot to the state directory. Copy that file into `catalog/` for the PR. (Servers that need credentials to start cannot be captured this way.)
- Or write it by hand from the server's documentation with `source: "docs"`. Use the real tool names and the vendor's wording for descriptions, trimmed to one or two sentences; routing scores on them. Where the docs give no schema use `{ "type": "object" }`.
- `server` must equal the manifest `id`. The snapshot must be non-empty.

## Bench queries: `bench/seed/<id>.jsonl`

Four lines, one JSON object each. They test that a user's sentence reaches the right tool:

```json
{"query": "what did we decide about pricing last week", "server": "notion", "tool": "search"}
```

Write them the way people talk, vary them, make at least one a little ambiguous, and **do not reuse the wording of the manifest's examples**. The `tool` must exist in the snapshot.

## Check it

```bash
npm run validate           # every manifest, every snapshot, every bench query's gold tool
npm run bench              # top-3 must not drop
npm run probe -- <id>      # MCP initialize against the real endpoint
```

`validate` checks: schema rules above, id equals file name, ids unique, the snapshot exists and parses, every `routing.tools` key is in the snapshot, and every bench query's gold tool exists. `probe` treats an HTTP server that answers 2xx, or 401 with a `WWW-Authenticate` header, as reachable; a stdio server with `auth: none` is spawned and initialized; one that needs credentials is skipped with a note. CI runs the same on every PR that touches `servers/` or `catalog/` ([`manifests.yml`](../.github/workflows/manifests.yml)).

## Candidates from the MCP Registry

`one-stop-mcp sync` pulls entries from the official MCP Registry and writes **draft** manifests to `servers/_candidates/<id>.yaml` with a header saying they are unreviewed and `# TODO review auth`. Nothing in that directory is loaded. To promote one, move it to `servers/`, fix the TODOs, pin the version, add a snapshot and bench queries, and open a PR. Nothing enters the live catalog automatically ([D9](burndown/DECISIONS.md)).
