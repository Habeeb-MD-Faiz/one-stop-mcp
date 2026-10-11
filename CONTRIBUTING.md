# Contributing

Thanks for helping. One-Stop MCP is built in the open, and the highest-volume contribution, adding a server, is deliberately the easiest. By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Contributions are licensed under [Apache-2.0](LICENSE) (section 5 of the license: anything you submit is under the same terms; there is no CLA).

Security problem? Do not open an issue. See [SECURITY.md](SECURITY.md).

## Four ways to contribute

| Way | Effort | Where to start |
|---|---|---|
| [1. Add a server](#1-add-a-server) `good first issue` | A YAML file, a JSON file, four test queries | issues labelled `add-server` |
| [2. Sharpen routing](#2-sharpen-routing) `good first issue` | Better example utterances | [docs/routing.md](docs/routing.md#improving-routing) |
| [3. Core work](#3-core-work) | Gateway internals, transports, vault backends | issues labelled `core` |
| [4. Shape the RFC](#4-shape-the-rfc) | Read and comment | [docs/rfcs/](docs/rfcs/README.md) |

## Development setup

Requires Node.js 22 and npm.

```bash
git clone https://github.com/Habeeb-MD-Faiz/one-stop-mcp.git
cd one-stop-mcp
npm ci
```

`npm ci` also installs the optional local-embedding dependency (large, ONNX runtime). If you only work on manifests or docs you can skip it with `npm ci --omit=optional`; routing then runs keyword + BM25 only, which is what CI does.

| Command | What it does |
|---|---|
| `npm run typecheck` | Type-check `src/`, `test/` and `scripts/`. |
| `npm test` | All tests (`node:test` run through `tsx`). |
| `npm run budget` | Fails if the four meta-tools exceed 2,000 tokens. |
| `npm run bench` | Routing accuracy (top-1, top-3). Informational: it prints numbers and exits 0, so compare before and after yourself. |
| `npm run validate` | Every manifest and snapshot, and the bench queries' gold tools. |
| `npm run probe -- <id>` | MCP `initialize` against a server's real endpoint. |
| `npm run build` / `npm start` | Compile to `dist/`; run the gateway. |
| `npm run dev` | Run from source with `tsx`. |
| `npm run cli -- <command>` | The `one-stop-mcp` CLI from source ([commands](docs/configuration.md#cli)). |

Before you open a PR, run `npm run typecheck && npm test && npm run validate`. CI runs the same plus `budget` and `bench` ([`ci.yml`](.github/workflows/ci.yml)); `typecheck`, `test`, `budget` and `validate` fail the build, `bench` only reports.

### Test rules

- Tests are `test/*.test.ts` using `node:test`.
- **No network beyond `127.0.0.1`.** Servers in tests listen on port 0 (ephemeral) and are in-process fakes, including fake OAuth authorization servers and fake Vault/KMS endpoints.
- **No real credentials, ever.** Never read a real token into a test or a process. Use in-process fakes behind the real interface.
- **No model download.** Use the deterministic fake embedder; tests that need the real model are gated behind `OSMCP_TEST_EMBEDDINGS=1`.
- Security-relevant code needs a test for the failure path (what is denied, what is rejected), not only the success path.

## 1. Add a server

You need: the server's documentation or repository, and ten minutes. No gateway code changes. The full field reference is [docs/adding-a-server.md](docs/adding-a-server.md).

1. **Pick the implementation.** Prefer, in order: the vendor's official server (and its hosted Streamable HTTP endpoint if it has one), then the `modelcontextprotocol` reference servers, then the most adopted, maintained community server. Check the real source: the vendor docs, the README, the npm or PyPI page. Do not guess a package name or endpoint. If you cannot verify something, say so in a YAML comment.
2. **Write `servers/<id>.yaml`.** The id is lowercase-kebab and equals the file name. Start with the editor line `# yaml-language-server: $schema=../schema/manifest.schema.json`, then a `# Source: <url> (official | reference | community)` comment. Pin `npx` / `uvx` packages to an exact version (`npm view <pkg> version`). Set `auth` correctly, with `keyUrl` for API-key servers. Add 3-5 `routing.examples` and, for the main tools, `routing.tools`.
3. **Write `catalog/<id>.json`**, the tool snapshot. Either run `npm run cli -- catalog refresh <id>` against the live server and copy the result, or write it by hand from the docs (`"source": "docs"`) using the real tool names and the vendor's wording.
4. **Write `bench/seed/<id>.jsonl`**: four lines of `{"query": "...", "server": "<id>", "tool": "<tool in the snapshot>"}`. Phrase them like a user, vary them, and do not reuse the manifest's example wording.
5. **Run `npm run validate`.** It must be green. Then `npm run bench` (note top-3 before and after; it must not drop) and `npm run probe -- <id>`.
6. **Open a PR** with the template filled in. Commit message: `servers: add <id>`.

Never put a real key, token or account id in any of these files.

## 2. Sharpen routing

Routing finds the right tool from a sentence. Better example utterances are the cheapest improvement and need no code.

1. Run `npm run bench` and note top-3.
2. Add or reword utterances in a manifest's `routing.examples` or `routing.tools` ([guidelines](docs/routing.md#improving-routing)). Think of how a user would say it, including synonyms the description does not use.
3. Run `npm run bench` again and `npm run validate`.
4. Open a PR with the before and after numbers. Commit message: `routing: sharpen <id> utterances`.

Held-out bench queries written by someone who has not seen the manifests are especially valuable ([why](docs/routing.md#the-benchmark)).

## 3. Core work

Gateway internals, transports, vault backends, compression and so on are tracked as issues labelled `core`. Read [docs/architecture.md](docs/architecture.md) first; it maps each feature to its directory.

Ground rules, in order of importance:

1. **Context is the scarcest resource.** A change that adds startup tokens, or anything that grows with the number of servers, is wrong by default. `npm run budget` must stay green.
2. **Secrets never leave the vault except in the outbound call they authenticate.** Not in logs, errors, tool results or the client's configuration.
3. **Stay inside the MCP spec** on both faces. No extensions the ecosystem cannot adopt.
4. **Lean dependencies.** Standard library first. Add a runtime dependency only for something that cannot reasonably be written in a few lines, and only a widely used, trusted one; say why in the PR. Dependencies are reviewed more strictly than code, because this component holds every credential.
5. **Match the existing style.** A short header comment saying why the file exists; comments only where the code cannot say it; `ponytail:` comments mark deliberate ceilings (a naive algorithm or a known limit, and what the upgrade would be).

Work on a feature branch, keep commits small, and open the PR early. The interfaces between subsystems are in `src/contracts.ts`; if your change needs one to change, call that out in the PR, since several parts depend on it.

For any non-trivial technical choice, link the basis for it in the PR or code comment: a standard, a paper, or the vendor's documentation. Prefer the boring, widely adopted method.

## 4. Shape the RFC

Design changes go through the [RFC process](docs/rfcs/README.md). The most useful thing a newcomer can do is read [RFC 0001](docs/rfcs/0001-v1-open-questions.md), which records the nine v1 open questions and the answers taken, and comment on the ones you disagree with, with evidence.

## Commits and PRs

- Commit messages: `<area>: <what changed>`, imperative, lowercase area. Areas follow the tree: `servers`, `routing`, `security`, `auth`, `downstream`, `server`, `catalog`, `cli`, `docs`, `ci`, `docker`. Explain *why* in the body when it is not obvious.
- One logical change per PR. Small PRs get reviewed faster.
- Fill in the PR template; the manifest checklist is there to save a review round.
- CI must be green. A failing probe on a server that needs credentials to start is expected to be skipped, not failed; if it fails for another reason, fix it or explain it.
- A maintainer reviews every PR ([CODEOWNERS](.github/CODEOWNERS)). Changes in `src/security/`, `src/auth/` and the admin API get a closer look and may take longer.

## Questions

Open a discussion or an issue with the right template. For a design question that is bigger than a bug, start with the "RFC" template.
