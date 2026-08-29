# one-stop-mcp

An open-source gateway that puts hundreds or thousands of MCP servers behind one endpoint without the tool definitions ever flooding the client's context window. Startup surface stays under ~2k tokens whether 5 or 5,000 servers are registered.

Record, decisions, roadmap and open questions live in **[Habeeb-MD-Faiz/brain](https://github.com/Habeeb-MD-Faiz/brain)** → `projects/one-stop-mcp.md`.
Original brief: `initial-briefs/one-stop-mcp.html` in that repo — frozen, never edited.

Code only here. Anything about *why* belongs in brain.

## Status — P0 (core facade) working

The client sees **four fixed meta-tools**, no matter how many servers are registered:

| meta-tool | what it does |
|---|---|
| `find_tools(query, k?)` | ranked shortlist of relevant tools **with schemas**, injected just for that turn |
| `list_servers(filter?)` | enumerate registered servers — lightweight, no schemas |
| `invoke(server, tool, args)` | run one tool on one downstream server, return its result |
| `connect_server(server)` | start auth for a server (P0: reports auth status; broker is P2) |

Downstream servers are **lazy**: registered ≠ running. A server is spawned only on the
first discovery/invoke that needs it, the session is pooled and reaped on a TTL, and its
tool catalog is cached so later searches don't respawn it. Startup cost is just the four
meta-tools — **~341 tokens**, flat at any catalog size.

## Quickstart

```bash
npm install
npm run build
npm start          # boots the gateway on stdio, loads manifests from servers/
```

Point an MCP client (Claude Desktop, Cursor, …) at `node dist/index.js`. It ships with one
demo server (`servers/echo.yaml`) so the round trip works out of the box.

```bash
npm test           # integration tests: client -> gateway -> echo over stdio
npm run budget     # asserts the startup surface stays under the 2k-token target
npm run typecheck
```

## Adding a server

One declarative manifest under `servers/`, no gateway code. See `servers/echo.yaml`.
The gateway derives the tool list via MCP `initialize` + `tools/list`.

```yaml
id: notion
name: Notion
category: [productivity, docs]
description: Read, search, and write Notion pages and databases.
transport:
  type: stdio            # streamable-http lands in P1
  command: npx
  args: ["-y", "@notionhq/notion-mcp-server"]
auth:
  type: oauth2           # brokered inside the gateway in P2
routing:
  examples:
    - "find my meeting notes in notion"
    - "create a page in my workspace"
```

## Roadmap

P0 core facade ✓ · P1 registry + vector router · P2 vault/OAuth broker + audit/kill/rotate ·
P3 50-server seed catalog · P4 multi-tenant · P5 community. Full table in the brain project file.

License: Apache-2.0 (proposed).
