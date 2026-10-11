# Routing

How `find_tools` turns a sentence like "open an issue for this bug" into five tool schemas out of thousands, without starting a single server. Related: [architecture](architecture.md) · [adding a server](adding-a-server.md) · [configuration](configuration.md).

## Two layers

The design brief (PDR section 4.2) splits discovery into two cooperating layers:

- **Layer A, retrieval.** Every tool is indexed by its name, description, category and example utterances. A query is scored against the whole index and the top `k` (default 5) are kept. This runs inside the gateway; no schema has reached the model yet.
- **Layer B, just-in-time schemas.** Only the shortlisted tools' input schemas are returned, compressed. The model makes the final pick from a clean list and calls `invoke`. Recall comes from retrieval, precision from the model.

The index is built from **snapshots on disk** (`catalog/<id>.json`) joined with each manifest's routing examples. `find_tools` never spawns a downstream server ([architecture](architecture.md#the-snapshot-catalog)). A server with no snapshot is skipped until one exists.

## What is indexed

For each tool, one document made of:

| Field | From |
|---|---|
| name | the snapshot (`github/create_issue` style ids are matched too) |
| description | the snapshot |
| category | `category` in the manifest |
| example utterances | `routing.tools[<tool>]` if present, plus the server-level `routing.examples` |

The helper `toRoutable(manifest, snapshot)` in `src/routing/index.ts` builds this. The registry and the benchmark both use it, so what is measured is what runs.

## The fallback ladder

`HybridDiscovery` (in `src/routing/discovery.ts`) works down three rungs:

1. **Exact.** If the query equals a tool name or `server/tool` (ignoring case and separators), that tool goes first with high confidence.
2. **Hybrid.** Three legs rank the catalog independently, and their lists are fused with **Reciprocal Rank Fusion** (Cormack et al., 2009):
   - a keyword leg: field-weighted term overlap with light stemming;
   - an **Okapi BM25** leg (Robertson and Zaragoza, 2009), also field-weighted. A match in the tool name counts most, then example utterances and category, then the description;
   - a **dense** leg: cosine similarity between sentence embeddings, when an embedder is available.
3. **Low confidence.** When the legs disagree, or the top score barely beats the runner-up, the gateway does not guess. It widens the shortlist to `2k`, sets `widened: true`, and returns `browse`: the top categories among the candidates, so the model can call `list_servers` with a category and look around.

The result is `{ tools, confidence, widened, browse? }`.

**How "low confidence" is decided.** Confidence is high when the query matched exactly one tool name, or when every leg that returned anything puts the fused top hit in its own top three. If the legs split, the query is ambiguous or synonym-heavy, so the gateway returns the wider list instead of a confident guess. Agreement was chosen over a score margin because RRF scores have no absolute scale, so a margin would need re-tuning for every catalog size. A bare name shared by several servers (`search`) is not an exact match. Each leg contributes a pool of `max(4k, 20)` candidates to the fusion, `k` is capped at 50, and `browse` lists up to three categories weighted by fused score. The fusion constant is `k = 30` (smaller than the textbook 60, because a small catalog flattens at 60). If one leg throws (say the embedder runs out of memory), `find_tools` continues on the remaining legs and logs one line.

RRF fuses ranks, not raw scores, so BM25 scores and cosine similarities never need to be put on one scale.

## Embeddings and the degrade path

Dense routing uses a **local** model through `@huggingface/transformers` (ONNX runtime). No embedding API is called, ever ([D5](burndown/DECISIONS.md)).

- **Default model: `Xenova/bge-small-en-v1.5`.** With the dense leg fused in, top-3 on `bench/` was 94.1%, against 91.2% for `Xenova/all-MiniLM-L6-v2` (recorded in `src/routing/embedder.ts`, 2026-10-11), at about 15 ms more per query. Override with `routing.model` or `OSMCP_MODEL`.
- The model is downloaded once from the Hugging Face hub on first use (free, public) into `$OSMCP_HOME/embeddings/models` and runs on CPU afterwards.
- Embeddings are L2-normalised, so cosine similarity is a dot product. Pooling follows how each model was trained: the `[CLS]` token for BGE, mean pooling for MiniLM.
- **On-disk cache.** Vectors are keyed by `sha256(model + "\0" + document text)`, one file per model, written atomically. A restart does not re-embed, and an edited tool re-embeds only itself.
- **Exact search.** The index is searched exhaustively. For a catalog of a few thousand tools that takes milliseconds, builds instantly and has perfect recall. An approximate index (hnswlib) is the upgrade for catalogs past roughly 50,000 tools, not before.
- **Remote providers** could plug in behind the same `Embedder` interface. None is built.

The package is an **optional dependency**, and the model download can fail. In either case the gateway logs one line to stderr and continues with the keyword and BM25 legs (the message reads `local embeddings unavailable (...); routing uses lexical + BM25 only`); `find_tools` still works, just with lower recall on synonyms. Turn dense routing off explicitly with `routing.embeddings: off`. CI installs with `npm ci --omit=optional`, so CI exercises the lexical path and tests the dense leg with a deterministic fake embedder.

On Windows the ONNX runtime needs the Microsoft Visual C++ 2015-2022 x64 redistributable; without it you get exactly that fallback message ("The specified module could not be found") and routing runs on the lexical legs.

## Schema compression

Shortlisted schemas pass through a compressor before they enter context. This is the third context defence after the constant meta-tool surface and the shortlist itself.

| Level | Removes | Keeps |
|---|---|---|
| `off` | nothing | everything |
| `light` (default) | `$schema`, `$id`, `$comment`, `title`, `examples`, `additionalProperties: false` | types, descriptions, properties, `required`, `enum`, and `$ref` (it carries structure) |
| `aggressive` | everything `light` removes, and trims descriptions | **always** `type`, `required`, `enum` and every property name |

`aggressive` can never drop the fields tool selection and argument construction depend on ([D8](burndown/DECISIONS.md)); tests enforce that. `npm run bench -- --compress` reports schema tokens at each level over the catalog's real schemas. How far to go is a measured trade-off, not a fixed answer: check the numbers before switching the default.

## The benchmark

`npm run bench` ranks a set of labelled queries against a catalog and reports top-1 and top-3 accuracy. It measures ranking only: it spawns no servers and calls no network service.

| Data | Where | What |
|---|---|---|
| Original benchmark | `bench/catalog.json`, `bench/queries.jsonl` | 34 paraphrased queries over 82 hand-written tool entries from 13 servers. |
| Seed benchmark | `servers/*.yaml`, `catalog/*.json`, `bench/seed/*.jsonl` | The shipped catalog: 4 queries per server, gold = `{query, server, tool}`. |

Useful flags:

```bash
npm run bench                                   # lexical + BM25 on bench/
npm run bench -- --dense                        # add the dense leg
npm run bench -- --dense --model Xenova/bge-small-en-v1.5
npm run bench -- --compress                     # schema tokens at off / light / aggressive
npm run bench -- --dense --catalog-dir catalog --servers servers --queries bench/seed   # the seed catalog (--queries takes a file or a directory)
```

`--cache-dir <dir>` sets where `--dense` keeps the model and the embedding cache. The script prints numbers and exits 0; with `--min-top3 <fraction>` it exits 1 below that floor. CI runs the lexical legs with floors of 0.78 on `bench/` and 0.87 on the held-out set, a few points under the measured numbers, so only a real regression fails the build.

**Where it stands.** Measured on 2026-10-11 with this build. The catalog is the shipped one (926 tools across 51 servers) except for `bench/`, which has its own 82-tool catalog.

| Query set | Queries | keyword + BM25: top-1 / top-3 | + dense (`bge-small-en-v1.5`): top-1 / top-3 |
|---|---|---|---|
| `bench/heldout`, written by an author who had not seen the manifests | 153 | 79.7% / 90.8% | 82.4% / **96.1%** |
| `bench/seed`, adversarial | 200 | 33.0% / 50.5% | n/r / 61.0% |
| `bench/`, the original set | 34 | 58.8% / 82.4% | n/r / 94.1% |

(n/r: not recorded.) The target is 90% top-3. **The held-out set meets it, with or without the dense leg.** It got there through per-tool `routing.tools` utterances (every tool in the catalog now has two or three) and a vote for a server the query names; before those, the same set scored 78.4% lexically ([D38](burndown/DECISIONS.md), [D42](burndown/DECISIONS.md)). With `all-MiniLM-L6-v2` instead of `bge-small`, `bench/` scored 91.2%. Lexical ranking costs about 40 ms per query on the full catalog; the dense leg adds about 50 ms, and building its embedding cache for a fresh catalog takes about 40 s once.

The seed set stays below target by design: its queries avoid product names and were written to be ambiguous between similar services, so many misses are a reasonable answer to an underspecified question. A cross-encoder reranker was tried and not adopted ([D39](burndown/DECISIONS.md)).

**Read the seed numbers with care.** The seed queries are written by the same people who wrote each server's examples, with a rule not to reuse the examples' wording. That inflates scores somewhat. That is why the held-out set above exists and is the number to quote ([D33](burndown/DECISIONS.md)). More held-out queries are welcome.

## Improving routing

The most useful routing contribution is better example utterances. In a manifest:

```yaml
routing:
  examples:                       # whole server: 3-5 requests a user might actually type
    - "find my meeting notes in notion"
    - "create a page in my workspace"
  tools:                          # per tool: 1-3 requests that should land on exactly this tool
    search: ["search my workspace for the onboarding doc"]
    create-page: ["jot down a new page called weekly review"]
```

Good utterances:

- **Sound like a user**, not like the tool name. "jot down a note" beats "create_note".
- **Cover synonyms and verbs the description does not use**: "book" for create-event, "ping" for send-message.
- **Name the object**, since "list" alone matches everything.
- **Stay specific to this server.** Do not borrow another server's vocabulary to win queries.

Then measure:

```bash
npm run bench       # note top-3 before ...
# edit servers/<id>.yaml ...
npm run bench       # ... and after
npm run validate
```

A change that raises top-3 without dropping anything else is a good PR. Put both numbers in the PR description.

## References

- Cormack, Clarke, Buettcher. *Reciprocal rank fusion outperforms Condorcet and individual rank learning methods.* SIGIR 2009.
- Robertson, Zaragoza. *The Probabilistic Relevance Framework: BM25 and Beyond.* Foundations and Trends in Information Retrieval, 2009.
- Reimers, Gurevych. *Sentence-BERT.* EMNLP 2019. [arXiv:1908.10084](https://arxiv.org/abs/1908.10084)
- Wang et al. *MiniLM.* [arXiv:2002.10957](https://arxiv.org/abs/2002.10957)
- Xiao et al. *C-Pack (BGE).* [arXiv:2309.07597](https://arxiv.org/abs/2309.07597)
- Thakur et al. *BEIR.* [arXiv:2104.08663](https://arxiv.org/abs/2104.08663)
