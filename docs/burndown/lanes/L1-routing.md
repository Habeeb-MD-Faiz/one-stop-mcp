# L1 · routing — PDR §4.2 (Layer A/B, fallback ladder) and §4.4 compression

Branch `OneStop-MCP-routing`, worktree `.wt/routing`. Read PLAN.md (rules, ownership) and
DECISIONS.md D5, D8, D22 first. Contracts: `src/contracts.ts` (Discovery, DiscoveryResult),
`src/routing/router.ts` (Router, Embedder, RoutableTool, ScoredTool — you own this file).

Owns: `src/routing/**`, `bench/**` except `bench/seed/**`, `scripts/routing-bench.ts`,
`test/router*.test.ts`, `test/routing*.test.ts`, `test/compress*.test.ts`.

## Build

1. **`src/routing/embedder.ts` — `LocalEmbedder implements Embedder`.** Dynamic
   `import("@huggingface/transformers")` (it is an optionalDependency, already installed).
   `feature-extraction` pipeline, mean pooling, L2-normalized. Constructor
   `{ model?: string; cacheDir?: string }`; default model chosen by the bench (step 5) between
   `Xenova/all-MiniLM-L6-v2` and `Xenova/bge-small-en-v1.5` (bge expects no query prefix for
   symmetric use — check its card). Batch embedding. First use downloads the model from the HF
   hub (free, public; allowed). Never call any hosted embedding API.
2. **`src/routing/index-store.ts` — on-disk embedding cache.** Keyed by
   `sha256(model + "\0" + docText)`, stored under `cacheDir` (one JSON or Float32 binary file per
   model; atomic write via tmp + rename). Re-embeds only changed tool documents. Exact cosine
   search (already in VectorRouter); leave a `ponytail:` note that ANN (hnswlib) is the upgrade
   past ~50k tools. VectorRouter should use the store so restart does not re-embed.
3. **`src/routing/discovery.ts` — `HybridDiscovery implements Discovery`** — the fallback ladder:
   1. *Exact*: query equals a tool name or `server/tool` (case/sep-insensitive) → that tool first,
      confidence high.
   2. *Hybrid*: RRF over lexical + BM25 (+ dense when available).
   3. *Low confidence* (define it from leg agreement and/or score margin; justify in a comment and
      test it): widen the shortlist to `2k` (`widened: true`) and return `browse`: the top
      categories among the candidates, so the model can fall back to `list_servers(category)`.
   Hits keep their `inputSchema` untouched; compression is applied by the caller.
4. **`src/routing/index.ts`** exports `createDiscovery(opts: { embeddings: "on" | "off"; model?: string;
   cacheDir: string }): Promise<Discovery>`. With `"on"` it tries LocalEmbedder; on any load failure it
   logs one line to stderr and returns lexical+BM25 only. Also re-export Router types.
5. **Bench.** `scripts/routing-bench.ts`: flags `--dense` (add the dense leg), `--model <id>`,
   `--catalog-dir <dir> --servers <dir> --queries <file>` (to run against the seed catalog:
   `catalog/*.json` snapshots + `servers/*.yaml` routing examples incl. `routing.tools`, queries
   from `bench/seed/*.jsonl` — those files are being written now by other lanes; your harness must
   work once they exist and must handle them missing), `--compress` (report schema tokens
   off/light/aggressive over whatever schemas the catalog has). Run the bench on `bench/` with and
   without dense for both models; pick the default model on top-3 and latency; record numbers in
   your report. Goal: ≥ 90% top-3 on `bench/` with dense.
   Build a `RoutableTool` from manifest + snapshot in one exported helper
   (`toRoutable(manifest, snapshot)` in `src/routing/index.ts`) so the registry and bench share it:
   examples = manifest `routing.tools[tool]` ?? [] plus server-level `routing.examples`.
6. **Compression (D8).** `src/routing/compress.ts`: make sure `aggressive` never drops `type`,
   `required`, `enum`, or property names; add tests for that.
7. Tests for each piece with deterministic fake embedders (no model download in `npm test`;
   gate any real-model test behind `OSMCP_TEST_EMBEDDINGS=1`).

## Done when

`npx tsc --noEmit && npm test` green in your worktree, bench numbers recorded, branch pushed.
Final message: a short report — what you built, bench numbers (lexical+BM25 vs +dense, per model),
the default model and why, anything you needed but could not touch.
