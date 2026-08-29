# graphify — install note

graphify turns a codebase (or docs/papers) into a queryable knowledge graph via local tree-sitter AST parsing — deterministic, no LLM, no vector store, nothing leaves the machine.

**This directory holds the skill pointer only.** The `skill.md` here is vendored verbatim from the upstream repo. The actual tool (~11 MB Python package + tree-sitter grammars) is **installed separately, not vendored into this repo.**

## Install the tool

PyPI package name is `graphifyy` (double y); the CLI command it installs is `graphify`.

```
uv tool install graphifyy      # preferred
# or: pipx install graphifyy
```

Requires Python >=3.10. (No-install run: `uvx --from graphifyy graphify install` — plain `uvx graphify` fails because the package is `graphifyy`.)

## Use

CLI command: **`graphify`** (e.g. `graphify query ...`). MCP server entry point: `graphify-mcp`.

## Facts

- License: **Apache-2.0** (dual-licensed, also MIT).
- Runs **fully locally, no paid API** — burndown-safe.
- Source: https://github.com/Graphify-Labs/graphify
