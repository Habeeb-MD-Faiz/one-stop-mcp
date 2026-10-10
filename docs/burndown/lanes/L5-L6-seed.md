# L5 / L6 · seed catalog — PDR §7 (50 servers on day one)

Two lanes, same brief, disjoint server ids. Read PLAN.md and DECISIONS.md D6, D25, D26, D33 first.

- **L5** — branch `OneStop-MCP-seed-a`, worktree `.wt/seed-a`. Ids (26):
  `github gitlab filesystem git sentry docker postgres mysql sqlite supabase redis mongodb
  brave-search fetch puppeteer playwright firecrawl apify exa aws cloudflare vercel kubernetes
  terraform azure netlify`
- **L6** — branch `OneStop-MCP-seed-b`, worktree `.wt/seed-b`. Ids (24):
  `notion google-drive google-calendar gmail slack linear clickup asana atlassian todoist
  sequential-thinking memory qdrant chroma pinecone context7 time apollo hubspot salesforce
  lemlist stripe intercom figma`

Owns, per id only: `servers/<id>.yaml`, `catalog/<id>.json`, `bench/seed/<id>.jsonl`. Nothing else.

## For each server

1. **Pick the implementation** (D6): official vendor server first (prefer the vendor's hosted
   remote Streamable HTTP endpoint when one exists), then the modelcontextprotocol reference
   servers, then the most-adopted maintained community server. Verify against the real source with
   **WebFetch** on known URLs (the vendor docs page, the GitHub README, npm/PyPI page). Do **not**
   use WebSearch. Do not run anything that needs a credential. If you cannot verify an endpoint or
   package name, say so in a YAML comment and in your report — never invent one.
2. **`servers/<id>.yaml`** — the PDR §6 format, validated against `src/types.ts`:
   ```yaml
   # yaml-language-server: $schema=../schema/manifest.schema.json
   # Source: <url you verified> (official | reference | community)
   id: notion
   name: Notion
   category: [productivity, docs]
   tags: [official, remote]
   description: >
     One or two sentences: what it reads and writes.
   homepage: https://...
   transport:
     type: streamable-http          # or stdio with command/args, e.g. npx -y <pkg>@<exact version>
     url: https://mcp.notion.com/mcp
   auth:
     type: oauth2                   # none | api_key | oauth2
     scopes: []
     # api_key: env (stdio) or header/prefix (http), keyUrl (where to create the key)
     # oauth2 for stdio/non-discovering servers: authorizationUrl, tokenUrl, env
   routing:
     examples:                      # 3-5 server-level utterances
       - "find my meeting notes in notion"
     tools:                         # 1-3 utterances for the most-used tools
       search: ["search my workspace for the onboarding doc"]
   health:
     check: initialize
   ```
   Categories must come from: dev, code, data, database, productivity, docs, communication, search,
   web, browser, cloud, infra, ai, memory, crm, sales, marketing, payments, design, testing, utility.
   Pin npx/uvx packages to an exact version you checked with `npm view <pkg> version` (or the PyPI
   page). Remote OAuth servers that implement MCP auth discovery need no endpoints in the manifest.
   API-key servers: set `keyUrl` to the provider's key page so the guided flow can link it.
3. **`catalog/<id>.json`** — the tool snapshot (`CatalogSnapshot` in `src/contracts.ts`):
   ```json
   { "server": "notion", "source": "docs", "fetchedAt": "2026-10-10T00:00:00Z",
     "tools": [ { "name": "search", "description": "…", "inputSchema": { "type": "object", "properties": { "query": { "type": "string", "description": "…" } }, "required": ["query"] } } ] }
   ```
   Use the real tool names and descriptions from the server's source/README (`source: "docs"`).
   Include every documented tool (cap ~40 for very large servers; prefer the most used). Include
   documented parameters; when the docs do not give a schema, `{ "type": "object" }`. Tool
   descriptions matter: routing scores on them — keep the vendor's wording, trimmed to one or two
   sentences.
4. **`bench/seed/<id>.jsonl`** — 4 routing queries per server, one JSON object per line:
   `{"query": "...", "server": "<id>", "tool": "<tool name from the snapshot>"}`. Write them the
   way a user would ask, varied, and **not** reusing the wording of the manifest's examples (D33).
   At least one per server should be ambiguous-sounding but still clearly belong to that tool.

## Checks before each commit

`node -e` / a quick script in your scratch dir (not committed) that parses each YAML with the
`yaml` package and each JSON, and confirms every `routing.tools` key and every bench gold tool
exists in the snapshot. When L4's `npm run validate` exists on the integration branch it will be run
over your files, so follow the rules above exactly.

Commit in batches of ~5 servers; push your branch after each commit. Final message: a short
report — the list of ids with implementation chosen (official/reference/community), transport,
auth type, tool count, and any server you could not verify.
