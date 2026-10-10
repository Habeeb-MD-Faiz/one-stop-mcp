# RFC 0001: Answers to the v1 open questions (Q1-Q9)

| | |
|---|---|
| **Status** | Accepted provisionally; open for comment |
| **Author(s)** | @Habeeb-MD-Faiz (decisions made on his behalf during the 2026-10-10 build session) |
| **Created** | 2026-10-10 |
| **Comment period ends** | open: the maintainer can reverse any item below, and any of them can be reopened with a new RFC |
| **Supersedes / superseded by** | none |

## Summary

The design brief ([PDR section 10](../PDR.md#10--open-questions--for-the-rfc)) left nine questions open. This RFC records the answer taken for each so that the v1 build could proceed, why, what was rejected, and how hard each is to undo. It is the first RFC and doubles as a worked example of the format.

## How these were decided

The maintainer instructed the build session to decide everything itself and log every decision, including reversible ones. The decisions were made by the session (Claude, working for the maintainer), not by a community comment period, and the maintainer has not yet reviewed them. They are therefore **provisional**: the repository is private and nothing built on them is public. Each item is tagged:

- **sticky**: other work builds on it and it is costly to undo later;
- **reversible**: cheap to change.

The full decision log with the other 24 build decisions is in [`docs/burndown/DECISIONS.md`](../burndown/DECISIONS.md) (decision numbers in brackets below).

## Q1. Core language: TypeScript or Go? (D4, sticky)

**Decision.** Stay with TypeScript on Node.

**Why.** The working code, the official MCP SDK and the contributor pool are all TypeScript. Moving to Go would discard that to win memory use and a single static binary, which do not matter at the scale of a gateway: its time goes to waiting on downstream servers and the model, not to CPU. The first design tenet is context cost, and language choice does not affect it.

**Rejected.** Go core with a TypeScript manifest layer: a second toolchain and a rewrite for a benefit this workload does not need.

**Sources.** [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).

**Open for comment.** Reconsider if the gateway is ever embedded as a single binary or has to run at memory budgets Node cannot meet.

## Q2. The 50: which servers ship in the seed catalog? (D6, reversible)

**Decision.** The list in PDR section 7, filled out per category. For each: the official vendor server first (preferring the vendor's hosted Streamable HTTP endpoint), then the `modelcontextprotocol` reference servers, then the most adopted maintained community server. The list is in `servers/`.

**Why.** Official servers track the vendor's API and have the clearest ownership. Hosted remote servers need no local install and no pinned package. Selection weighs popularity, maintenance activity, breadth and clean spec compliance, as the brief asked.

**Rejected.** Ranking purely by stars: it favours old, unmaintained projects.

**Open for comment.** Any server can be swapped or added by a one-file PR; this is the question most easily settled by contribution.

## Q3. Embeddings: local small model or pluggable remote? (D5, reversible)

**Decision.** Local embeddings through `@huggingface/transformers` (ONNX runtime). No embedding API is called. Candidates are `all-MiniLM-L6-v2` and `bge-small-en-v1.5`; the routing benchmark chooses the default. Vectors are searched exactly (cosine) over an on-disk cache; an approximate index (hnswlib) only past about 50,000 tools. If the package or the model is unavailable, routing falls back to keyword + BM25 rather than failing. Remote providers can plug in behind the `Embedder` interface, but none is wired.

**Why.** Local keeps the product's privacy story intact (tool queries never leave the machine) and costs nothing to run. At catalog sizes of thousands of tools, exact search builds instantly, has perfect recall and takes milliseconds, so an approximate index would add complexity for no gain. The fallback makes the optional model an enhancement, not a point of failure.

**Rejected.** A hosted embedding API as the default: ongoing cost, a network dependency on the hot path, and queries sent to a third party.

**Sources.** Reimers and Gurevych, *Sentence-BERT*, EMNLP 2019, [arXiv:1908.10084](https://arxiv.org/abs/1908.10084). Wang et al., *MiniLM*, [arXiv:2002.10957](https://arxiv.org/abs/2002.10957). Xiao et al., *C-Pack (BGE)*, [arXiv:2309.07597](https://arxiv.org/abs/2309.07597). Thakur et al., *BEIR*, [arXiv:2104.08663](https://arxiv.org/abs/2104.08663).

**Open for comment.** Whether a larger model or a remote option is worth offering for users who want maximum accuracy and accept the cost. Detail in [routing](../routing.md).

## Q4. Secret isolation: per-user keys or per-org partitions? (D7, sticky)

**Decision.** Both, layered. One root key; the org key is `HKDF(root, org)`; the user key is `HKDF(org key, user)`. Every record is also bound to its (org, user, server) cell as AES-GCM additional authenticated data, so a ciphertext copied to another cell fails to decrypt.

**Why.** Isolation is then cryptographic, not only a database filter: a bug that returns the wrong row still cannot return a usable secret. Org partitions give teams a boundary for backup, export and revocation; per-user keys give each person their own. The cost is one key derivation per access, which is negligible.

**Rejected.** Per-org only: one user's bug or compromise reaches a colleague's tokens. Per-user only: no org-level boundary to hang administration on.

**Sources.** RFC 5869 (HKDF). NIST SP 800-38D (GCM). Detail in [security](../security.md#key-hierarchy).

**Open for comment.** Whether the root key should additionally be split (for example Shamir shares) for high-assurance deployments.

## Q5. Compression: how aggressive before it hurts? (D8, reversible)

**Decision.** The default stays `light`: strip boilerplate only (`$schema`, `additionalProperties: false`, titles, examples). `aggressive` also trims descriptions, is measured in the benchmark for token savings, and must keep every `type`, `required`, `enum` and property name.

**Why.** Those fields are exactly what tool selection and argument construction depend on; boilerplate is not. The conservative default costs a few tokens and risks nothing; the aggressive level is opt-in with a measured trade-off.

**Rejected.** Defaulting to `aggressive`: the saving is small next to the risk of a model building a wrong call from a truncated description.

**Open for comment.** The benchmark's `--compress` numbers should decide whether the default can move.

## Q6. Registry sync: auto-ingest or curated only? (D9, reversible)

**Decision.** Curated only. The sync worker refreshes tool snapshots for servers already in the catalog and imports candidates from the official MCP Registry into `servers/_candidates/` for human review. Nothing is added to the live catalog automatically.

**Why.** The gateway holds every credential a user connects. A server that arrives automatically is a server that can receive those credentials, so auto-ingest turns a registry compromise or a typosquatted entry into a credential-theft path. Review is the control.

**Sources.** [MCP Registry](https://registry.modelcontextprotocol.io).

**Open for comment.** A trust-tiered model (auto-listed but needs explicit user opt-in per server) could be proposed in a later RFC.

## Q7. Rotation policy: default cadence, and providers with no rotation API? (D10, reversible)

**Decision.** A 90-day default, checked on a schedule (`rotation.days`). OAuth: the refresh-token grant, fully automated. API keys: a provider adapter where the provider has a key-management API (Cloudflare's token roll ships first); otherwise a **guided** flow that opens the key-entry page together with the provider's key page (`auth.keyUrl`). No credential is left as a blind spot.

**Why.** 90 days is a common baseline and cheap for OAuth, where rotation costs nothing. Guided rotation is honest about providers that offer no API, and keeps rotation a single action from one place, as the brief set out.

**Open for comment.** Per-provider cadences, and which provider adapters to build next.

## Q8. Anomaly detection: rules or a learned baseline? (D11, reversible)

**Decision.** Both, in that order. Rules first: bursts per (user, server, tool), bulk-export-shaped tool names at volume, and denied rate. Then a per-connector exponentially weighted moving average of call rate with a z-score threshold after a warm-up period. No learned model.

**Why.** Rules are explainable and work from the first call, when there is no history. The baseline covers connectors whose normal is very different from the defaults, without the opacity, training data or maintenance of a model. Each flag carries a human-readable reason.

**Rejected.** A learned model: unexplainable flags are hard to trust or act on, and there is no data to train it on at launch.

**Open for comment.** Thresholds and the bulk-tool name list are tunable and will need real-world data.

## Q9. Governance: BDFL, core-team consensus or foundation? (D12, sticky)

**Decision.** A benevolent dictator (the maintainer, Habeeb) plus maintainers, with a lightweight public RFC process for design changes. Revisit a foundation once there are several regular outside maintainers. Written up in [GOVERNANCE.md](../../GOVERNANCE.md).

**Why.** A single decision-maker is the fastest way to a coherent v1, and the project has no outside maintainers yet for consensus to mean anything. The RFC process keeps decisions written down and open to comment from day one, so moving to a broader model later does not require reconstructing the reasoning.

**Rejected.** Foundation-style from day one: heavy process with no community to govern. Core-team consensus: there is no team yet.

**Open for comment.** The conditions under which governance should change are listed in GOVERNANCE.md. Governance is an outward-facing choice; it was recorded while the repository is private and takes effect when the maintainer makes it public.

## Decision

*Pending the maintainer's review.* Until then, the build proceeds on these answers.
