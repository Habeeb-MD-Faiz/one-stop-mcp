# Burn-down 2026-10-10 — build every PDR feature

Started 17:59 IST, target ~00:00 IST. Branch `OneStop-MCP` (master untouched).
Goal from Habeeb: "a completely working one-stop MCP … every single feature in the
PDR doc". Decisions are logged in [DECISIONS.md](DECISIONS.md); each lane's full
brief is in [lanes/](lanes/).

**Resume point for any session that picks this up:** read this file top to
bottom, then the Status table, then continue from the first lane/stage that is
not `merged`.

## Feature map — PDR section → where it is built

| PDR | Feature | Lane |
|---|---|---|
| §4.1 | 4 meta-tools, constant surface (<2k tokens) | L7 server |
| §4.2 | Layer A local embeddings + on-disk index; Layer B JIT schemas; fallback ladder exact → vector → category browse; widen on low confidence | L1 routing |
| §4.3 | `connect_server` → OAuth redirect / key entry, callback on the gateway, tokens encrypted per user+server, transparent auth on later calls | L3 downstream+auth, L7 HTTP routes |
| §4.4 | Lazy sessions, pooling, TTL reaping; schema compression | L3, L1 |
| §5 | Encrypted at rest, per-user/per-org key scoping | L2 security |
| §5 | Least-privilege injection (outbound only; never context or logs) | L3 + L2 redaction |
| §5 | Admin MFA (TOTP) + signed, timestamped audit trail | L2, L7 |
| §5 | Pluggable backend: HashiCorp Vault KV, Vault Transit, AWS KMS | L2 |
| §5 | Usage ledger with anomaly flagging (rules + per-connector baseline) | L2 |
| §5 | Kill switch: all / per server / per user; re-enable one at a time | L2, L7 |
| §5 | Rotation: one / group / all; on demand or scheduled; OAuth auto-refresh; API keys by provider API or guided; "after a scare" incident flow | L2, L3 |
| §6 | Manifest (incl. `health.check`), JSON Schema, validation | L4 catalog-core |
| §7 | 50-server seed catalog with tool snapshots | L5, L6 |
| §8 | stdio + Streamable HTTP both faces; npx + Docker | L3, L7, L8 |
| §9 P3 | Registry sync worker (snapshot refresh + official registry candidates) | L4 |
| §9 P4 | Multi-tenant orgs/users, per-user secrets, audit logs, metrics | L7, L2 |
| §9 P5 | Docs, manifest CI validation + probe, RFC process, governance | L8, L4 |
| §10 | Q1–Q9 answered | DECISIONS.md, L8 writes docs/rfcs/0001 |
| §11 | Contributing: add-a-server, sharpen routing, core work, RFC | L8 |

## Lanes — disjoint ownership (docs/MULTIAGENT.md)

Each lane works in its own worktree `.wt/<lane>` on branch `OneStop-MCP-<lane>`,
pushes that branch after every commit, and never writes outside its paths.
The orchestrator merges lane branches into `OneStop-MCP` at gates.

| Lane | Model | Owns (writes only here) |
|---|---|---|
| L1 routing | opus | `src/routing/**`, `bench/**` except `bench/seed/**`, `scripts/routing-bench.ts`, `test/router*.test.ts`, `test/routing*.test.ts`, `test/compress*.test.ts` |
| L2 security | opus | `src/security/**`, `test/security*.test.ts` |
| L3 downstream+auth | opus | `src/downstream/**`, `src/auth/**`, `test/downstream*.test.ts`, `test/oauth*.test.ts`, `test/fixtures/**` |
| L4 catalog-core | sonnet | `src/catalog/**`, `src/manifest.ts`, `schema/**`, `scripts/validate-manifests.ts`, `scripts/probe-manifests.ts`, `test/catalog*.test.ts`, `test/manifest*.test.ts` |
| L5 seed A | sonnet | `servers/<its ids>.yaml`, `catalog/<its ids>.json`, `bench/seed/<its ids>.jsonl` |
| L6 seed B | sonnet | same, for its ids |
| L7 server | opus | `src/server/**`, `src/tenancy/**`, `src/cli.ts`, `src/config.ts`, `src/index.ts`, `scripts/token-budget.ts`, `test/server*.test.ts`, `test/gateway*.test.ts`, `test/cli*.test.ts`, `test/config*.test.ts`, `test/tenancy*.test.ts` |
| L8 community | sonnet | `.github/**`, `docs/**` except `docs/PDR.*` and `docs/burndown/**`, `CONTRIBUTING.md`, `GOVERNANCE.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `LICENSE`, `Dockerfile`, `.dockerignore`, `docker-compose.yml` |
| orchestrator | — | everything else: `package.json`, lockfile, `tsconfig*.json`, `src/contracts.ts`, `src/types.ts`, `README.md`, `docs/burndown/**`, `catalog/echo.json`, merges, brain |

Contracts every lane codes against: `src/contracts.ts` and `src/types.ts`.
A lane that needs a contract change stops and reports it instead of editing.

## Stages

| # | Stage | Exit |
|---|---|---|
| S0 | Skeleton: folders, async Router, contracts, plan | tests green, pushed |
| S1 | Wave 1: L1–L8 in parallel | each lane: its tests green, branch pushed, report returned |
| S2 | Integrate: merge lanes, wire `src/server/app.ts`, fix seams | typecheck + all tests green on `OneStop-MCP` |
| S3 | End-to-end: stdio client → gateway → 50-server catalog find_tools; OAuth E2E through the real HTTP server; seed-catalog bench ≥ 90% top-3 | numbers recorded |
| S4 | Hardening: security review pass, docs/README current, CI run green | review findings fixed or logged |
| S5 | Handoff: brain log summary, project file, arch page | pushed |

## Status

| Item | State | Note |
|---|---|---|
| S0 skeleton | done | 7606c9d, a9de974 |
| L1 routing | running — launched 22:50, cut off by the usage limit ~23:10, resumed 03:47 | |
| L2 security | running — launched 22:50, cut off by the usage limit ~23:10, resumed 03:47 | |
| L3 downstream+auth | done 9aaa4c3 — merge with L2+L7 (old Registry API callers break until then) | |
| L4 catalog-core | merged cc1b17d | |
| L5 seed A | running — launched 22:50, cut off by the usage limit ~23:10, resumed 03:47 | |
| L6 seed B | running — launched 22:50, cut off by the usage limit ~23:10, resumed 03:47 | |
| L7 server | running — launched 22:50, cut off by the usage limit ~23:10, resumed 03:47 | |
| L8 community | merged | |
| S2 integrate | pending | |
| S3 end-to-end | pending | |
| S4 hardening | pending | |
| S5 handoff | pending | |

## Rules for every agent (from brain docs/BURNDOWN.md)

- No paid API call, ever: no LLM, search, or embedding API. Fakes behind the
  real interface; mark the seam `// TODO(live): verified against the real API only with Habeeb present`.
- Never read a real credential into a process. Tests use in-process fakes.
- Nothing public. No force-push, no history rewrite, no branch deletion, no PRs.
- Trusted dependencies only, and only the orchestrator adds them (package.json is
  orchestrator-owned): a lane that needs one reports it.
- Commit small, push the lane branch after every commit. Commit messages end
  with the line `Claude-Session: https://claude.ai/code/session_01LcFtvWtDGjqKx4nwVLzaH3`.
- Tests: `node:test` via `npm test` (`tsx --test test/*.test.ts`); ephemeral ports
  (listen on 0); no network beyond 127.0.0.1 in tests.
- Code style: match the existing files — short header comment saying why,
  `ponytail:` comments on deliberate ceilings, stdlib first.

## Integration notes (reconcile at S2/S4)

- L8: Dockerfile CMD uses `dist/index.js` (the `bin`); `package.json` needs `private: false`-ready fields (`files`, `bin`) for `npm pack`/npx — keep `private: true` until Habeeb publishes.
- L8: container must bind 0.0.0.0 — needs the real env var name from L7's config; 23 `<!-- verify -->` markers in docs to reconcile against integrated code.
- L8: CI typecheck runs with `--omit=optional` — L1 must import `@huggingface/transformers` without a literal specifier tsc resolves, or typecheck fails in CI.
- L8: README must link the new docs.
- L4: `knowledge-base` added to CATEGORIES. Probe spawns stdio commands from PRs — fine under `pull_request` (no secrets, read-only token), review in S4.
- L3: Registry deps add `secrets: SecretStore` (list() only, for `connected`). Swap L3's local `toRoutable` for L1's `src/routing/index.ts` and local `redact`/`redactText` for L2's `src/security/redact.ts`. No `unindexed` in DiscoveryResult. Vault value shapes: api_key `{key}`, oauth2 token response + `expires_at`, client `{client_id, client_secret?}` (L2 rotation adapters must match).
