# L8 · community + packaging — PDR §8 (npx + Docker), §9 P5, §11

Branch `OneStop-MCP-community`, worktree `.wt/community`. Read PLAN.md and DECISIONS.md (all of it —
you document these decisions), then the other lane briefs in `docs/burndown/lanes/` for the exact
CLI commands, config fields, HTTP routes and file layout you are documenting. Read `docs/PDR.md`.

Owns: `.github/**`, `docs/**` except `docs/PDR.*`, `docs/index.html` and `docs/burndown/**`,
`CONTRIBUTING.md`, `GOVERNANCE.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `LICENSE`, `Dockerfile`,
`.dockerignore`, `docker-compose.yml`. Not README.md (orchestrator).

## Build

1. **CI (D20)** `.github/workflows/ci.yml`: on `pull_request`, `push` to `master` and `OneStop-MCP`,
   `workflow_dispatch`; `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }`;
   ubuntu-latest, Node 22, `npm ci --omit=optional` (no embedding model in CI), `npm run typecheck`,
   `npm test`, `npm run budget`, `npm run bench`, `npm run validate`. Minimal `permissions: contents: read`.
   Pin actions to major versions of official actions only (`actions/checkout@v4`, `actions/setup-node@v4`).
2. `.github/workflows/manifests.yml`: on `pull_request` touching `servers/**` or `catalog/**`:
   validate + `npm run probe` on changed manifests (network allowed; a probe failure on an HTTP server
   that needs auth is fine — the script handles that).
3. `.github/workflows/release.yml`: `workflow_dispatch` only (never runs on its own): build, `npm pack`
   artifact, Docker build (no push step without an explicit input `push: true`, default false). D21:
   nothing is published.
4. `.github/ISSUE_TEMPLATE/`: `add-server.yml` (good first issue), `bug.yml`, `feature.yml`,
   `rfc.yml`, `config.yml`; `.github/PULL_REQUEST_TEMPLATE.md` with the manifest checklist;
   `.github/dependabot.yml` (npm + actions, weekly, grouped); `.github/CODEOWNERS` (@Habeeb-MD-Faiz).
5. `CONTRIBUTING.md` — the four ways to contribute from PDR §11: add a server (step by step: write
   `servers/<id>.yaml`, the `catalog/<id>.json` snapshot via `one-stop-mcp catalog refresh <id>` or by
   hand, 4 bench queries in `bench/seed/<id>.jsonl`, `npm run validate`), sharpen routing (add
   utterances, run `npm run bench`), core work, shape the RFC. Dev setup, test commands, commit style.
6. `GOVERNANCE.md` (D12) — BDFL + maintainers, how one becomes a maintainer, decision making, the RFC
   process (`docs/rfcs/`, numbered, comment period, BDFL decides), release cadence, revisit-foundation
   trigger. `CODE_OF_CONDUCT.md` — Contributor Covenant 2.1 (fetch the canonical text with WebFetch
   from contributor-covenant.org; contact = the maintainer email placeholder `conduct@<TBD>` marked TODO
   for Habeeb). `SECURITY.md` — private reporting via GitHub security advisories, scope, what's in the
   vault threat model. `LICENSE` — Apache-2.0 full text (fetch canonical from apache.org).
7. `docs/` (Markdown):
   - `docs/architecture.md` — the built system: components, request flow for `find_tools`, `invoke`,
     `connect_server` (sequence for OAuth), lazy sessions, snapshot catalog, where each PDR feature lives.
   - `docs/configuration.md` — every config field and env var, local vs team mode.
   - `docs/deployment.md` — npx/local with Claude Desktop/Claude Code config snippets (stdio and
     HTTP with a bearer header), Docker, compose, team-mode bootstrap (`init`, users, tokens, TOTP).
   - `docs/security.md` — threat model, vault + key hierarchy (D7, D14), least-privilege injection,
     redaction, ledger signing + verify, anomaly rules, kill switch semantics (lockdown + re-enable
     one at a time), rotation (policy, OAuth, adapters, guided), the incident flow, admin MFA.
   - `docs/routing.md` — two-layer discovery, fallback ladder, embeddings + degrade path, bench.
   - `docs/adding-a-server.md` — manifest reference (every field) with the PDR example.
   - `docs/rfcs/README.md` (process), `docs/rfcs/0000-template.md`, `docs/rfcs/0001-v1-open-questions.md`
     — Q1–Q9 each with the decision taken (from DECISIONS.md D4–D12), the reasoning, and "open for
     comment".
8. **Docker (D21)** — multi-stage `Dockerfile` on `node:22-bookworm-slim`: build stage `npm ci` +
   `npm run build`; runtime stage `npm ci --omit=dev --omit=optional` (build-arg `EMBEDDINGS=1` keeps
   optional deps), non-root `node` user, `OSMCP_HOME=/data` volume, `EXPOSE 8420`,
   `CMD ["node","dist/cli.js","serve","--http"]`, healthcheck on `/healthz`. `.dockerignore`.
   `docker-compose.yml`: the gateway in team mode with `OSMCP_MASTER_KEY` from an env file, a named
   volume, and an optional `vault` service (HashiCorp Vault dev mode, profile `vault`) for trying the
   HashiCorp backend. Do not run `docker build` if Docker is not installed — check with `docker --version`
   and say so in your report.

## Done when

Every file above exists, YAML is valid (parse with the `yaml` package), links between docs work.
Branch pushed. Final message: short report — files written, anything you documented that you could
not confirm in the briefs (the orchestrator reconciles docs with the integrated code at the end).
