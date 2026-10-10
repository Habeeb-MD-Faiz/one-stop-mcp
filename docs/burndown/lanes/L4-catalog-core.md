# L4 · catalog-core — PDR §6 (manifest), §9 P3 (registry sync), P5 (manifest CI validation)

Branch `OneStop-MCP-catalog`, worktree `.wt/catalog`. Read PLAN.md and DECISIONS.md D9, D25, D26
first. Contracts: `src/contracts.ts` (CatalogSnapshot, CatalogStore), `src/types.ts` (Manifest —
orchestrator-owned; report needed changes, do not edit).

Owns: `src/catalog/**`, `src/manifest.ts`, `schema/**`, `scripts/validate-manifests.ts`,
`scripts/probe-manifests.ts`, `test/catalog*.test.ts`, `test/manifest*.test.ts`.
(`package.json` already has `npm run validate` and `npm run probe` pointing at your scripts.)

## Build

1. **`schema/manifest.schema.json`** — JSON Schema 2020-12 matching `src/types.ts` exactly, with
   descriptions, so contributors get editor completion via
   `# yaml-language-server: $schema=../schema/manifest.schema.json`.
2. **`src/manifest.ts`** — keep `loadManifests(dir)` / `parseManifest(text, source)`; make validation
   complete and strict (no new dependency — hand-rolled, it is the CI source of truth):
   id is lowercase-kebab and equals the file name; name/description non-empty; category non-empty
   and each from `CATEGORIES` (export it: dev, code, data, database, productivity, docs, communication,
   search, web, browser, cloud, infra, ai, memory, crm, sales, marketing, payments, design, testing, utility —
   adjust if a seed manifest needs one more and report it); transport rules; auth rules (api_key on
   stdio needs `env`; on HTTP `header` defaults; oauth2 on stdio needs `authorizationUrl` + `tokenUrl`
   + `env`); `routing.tools` keys are strings → string arrays; `health.check` enum; unknown top-level
   keys are an error (catches typos). Every error names the file and the field. Duplicate ids across
   files → error from `loadManifests`. Skip `servers/_candidates/` (subdirectory) when loading.
3. **`src/catalog/store.ts` — `FileCatalogStore implements CatalogStore`.** Ctor
   `{ shippedDir: string; stateDir?: string }`. `load(id)`: state-dir snapshot if present (refreshed
   live) else the shipped `catalog/<id>.json`; validate shape. `save()` writes the state dir
   atomically (tmp + rename); never writes the shipped dir.
4. **`src/catalog/sync.ts` — the registry sync worker.**
   - `refreshSnapshots(ids, refresh: (id) => Promise<void>)` — runs a caller-supplied refresh per id
     with bounded concurrency, collects `{ id, ok, error? }`.
   - `importCandidates({ registryUrl = "https://registry.modelcontextprotocol.io", candidatesDir,
     existingIds, fetch = globalThis.fetch, limit })` — pages `GET /v0/servers` (read the registry's
     published API docs/OpenAPI to get the exact v0 response shape: servers[].server.{name,
     description, version, remotes[], packages[]}, metadata.nextCursor), maps each to a draft
     manifest YAML (`id` from the name, transport from `remotes[0]` (streamable-http) or the first
     npm/pypi package (stdio via `npx -y` / `uvx`), auth unknown → `none` with a `# TODO review auth`
     comment, empty routing) and writes `servers/_candidates/<id>.yaml` with a header comment saying
     it is an unreviewed candidate. Skips ids already in the catalog. Never writes `servers/` itself (D9).
     Test against an in-process fake registry serving a recorded-shape fixture; `// TODO(live)`.
5. **`scripts/validate-manifests.ts`** (`npm run validate`): loads `servers/`, checks every manifest
   validates, ids are unique, each has a `catalog/<id>.json` snapshot that parses and is non-empty,
   every `routing.tools` key exists in the snapshot, and (if `bench/seed/<id>.jsonl` exists) every
   query's gold tool exists. Prints a table; exits 1 on any error.
6. **`scripts/probe-manifests.ts`** (`npm run probe -- [ids…]`, default: manifests changed vs
   `origin/master` per `git diff --name-only`): for each, MCP `initialize` using the SDK client —
   HTTP: a 2xx or a 401 with `WWW-Authenticate` counts as reachable; stdio with `auth: none`: spawn
   and initialize with a timeout; stdio needing credentials: skip with a note. This is the PR probe
   from PDR §11 ("CI validates it and probes the endpoint").
7. Tests for validator rules, store overlay, candidate import mapping.

## Done when

`npx tsc --noEmit` and your tests green; `npm run validate` works on the current `servers/echo.yaml`
(the orchestrator adds `catalog/echo.json`; create a fixture in your tests rather than relying on
it). Branch pushed. Final message: short report with exported signatures and any `types.ts`
change you need.
