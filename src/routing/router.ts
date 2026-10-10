// Retrieval legs behind one Router interface: LexicalRouter (field-weighted term
// overlap), Bm25Router (the same fields scored with BM25) and VectorRouter (a local
// embedding model), fused with Reciprocal Rank Fusion. HybridDiscovery
// (./discovery.ts) runs them as find_tools' fallback ladder.

import { EmbeddingStore } from "./index-store.js";

export interface RoutableTool {
  server: string;
  tool: string;
  description: string;
  examples: string[];
  category?: string[];
  inputSchema?: unknown;
}

export interface ScoredTool extends RoutableTool {
  score: number;
}

export interface Router {
  rank(query: string, tools: RoutableTool[], k: number): Promise<ScoredTool[]>;
}

// Field weights: what a term is worth toward the score depending on where it
// matched. A hit in the tool name is stronger evidence than one in prose.
const W_NAME = 3;
const W_EXAMPLE = 2;
const W_CATEGORY = 2;
const W_DESC = 1;

export class LexicalRouter implements Router {
  async rank(query: string, tools: RoutableTool[], k: number): Promise<ScoredTool[]> {
    const qTerms = [...new Set(terms(query))];
    if (qTerms.length === 0) return [];
    const qNorm = norm(query);

    const qStems = qTerms.map(stem);
    const scored = tools.map((t) => {
      const weights = new Map<string, number>();
      add(weights, terms(t.tool), W_NAME);
      for (const ex of t.examples) add(weights, terms(ex), W_EXAMPLE);
      add(weights, terms((t.category ?? []).join(" ")), W_CATEGORY);
      add(weights, terms(t.description), W_DESC);

      let score = qStems.reduce((s, term) => s + (weights.get(term) ?? 0), 0);
      // Strong signal: the query is (almost) one of the tool's example utterances.
      if (t.examples.some((ex) => norm(ex) === qNorm)) score += 10;
      return { ...t, score };
    });

    return scored.filter((t) => t.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
  }
}

// The sparse leg of hybrid retrieval. Same field weighting as LexicalRouter, but
// scored with Okapi BM25 so a term's worth is discounted by how common it is across
// the catalog (IDF) and by document length — which fixes the cases where a generic
// term shared by many tools ("table", "file") drowns out the rare discriminating one
// ("rows", "search"). Research: hybrid tool retrieval, BM25 sparse leg (see
// projects/one-stop-mcp-routing-research.md; Bruch et al. TOIS 2023, BEIR).
const K1 = 1.5; // term-frequency saturation
const B = 0.75; // length-normalization strength (standard defaults)

/** Field-weighted term-frequency bag for one tool: high-value fields contribute
 *  their terms multiple times, so BM25's tf term carries the same name>example>
 *  category>desc emphasis as LexicalRouter, now with IDF and length normalization. */
function docBag(t: RoutableTool): Map<string, number> {
  const bag = new Map<string, number>();
  add(bag, terms(t.tool), W_NAME);
  for (const ex of t.examples) add(bag, terms(ex), W_EXAMPLE);
  add(bag, terms((t.category ?? []).join(" ")), W_CATEGORY);
  add(bag, terms(t.description), W_DESC);
  return bag;
}

export class Bm25Router implements Router {
  async rank(query: string, tools: RoutableTool[], k: number): Promise<ScoredTool[]> {
    const qStems = [...new Set(terms(query).map(stem))];
    if (qStems.length === 0) return [];
    const qNorm = norm(query);

    const bags = tools.map(docBag);
    const dl = bags.map((b) => [...b.values()].reduce((s, c) => s + c, 0));
    const N = tools.length;
    const avgdl = dl.reduce((s, c) => s + c, 0) / N || 1;

    const df = new Map<string, number>();
    for (const b of bags) for (const term of b.keys()) df.set(term, (df.get(term) ?? 0) + 1);

    const scored = tools.map((t, i) => {
      let score = 0;
      for (const q of qStems) {
        const f = bags[i].get(q) ?? 0;
        if (f === 0) continue;
        const n = df.get(q) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        score += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * dl[i] / avgdl));
      }
      if (t.examples.some((ex) => norm(ex) === qNorm)) score += 10; // query ≈ an example utterance
      return { ...t, score };
    });

    return scored.filter((t) => t.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
  }
}

// The dense leg's plug point. LocalEmbedder (./embedder.ts) runs a local
// sentence-embedding model through ONNX; tests use deterministic fakes. No hosted
// embedding API is wired (D5): one would implement this same interface.
export interface Embedder {
  /** One vector per input text. Same dimensionality across calls. */
  embed(texts: string[]): Promise<number[][]>;
  /** Prepended to queries (never to tool documents) for models trained with an
   *  asymmetric retrieval instruction. */
  readonly queryPrefix?: string;
}

// Dense retrieval: cosine similarity between the query vector and each tool's
// document vector. Brute-force (exact) — correct, perfect recall, and milliseconds
// at our scale. ponytail: exact scan is O(tools) per query; past ~50k tools swap in
// an ANN index (hnswlib) behind this same class (D5).
// Document vectors live in an EmbeddingStore (on disk when given a dir), so only
// tools whose text changed are embedded, and a restart re-embeds nothing.
export class VectorRouter implements Router {
  private filling: Promise<void> = Promise.resolve();

  constructor(
    private embedder: Embedder,
    private store = new EmbeddingStore(""),
  ) {}

  async rank(query: string, tools: RoutableTool[], k: number): Promise<ScoredTool[]> {
    if (tools.length === 0) return [];
    const docVecs = await this.docVectors(tools);
    const [qVec] = await this.embedder.embed([(this.embedder.queryPrefix ?? "") + query]);
    return tools
      .map((t, i) => ({ ...t, score: cosine(qVec, docVecs[i]) }))
      .filter((t) => t.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  private async docVectors(tools: RoutableTool[]): Promise<number[][]> {
    const texts = tools.map(docText);
    const keys = texts.map((t) => this.store.key(t));
    if (keys.some((key) => !this.store.get(key))) {
      // Serialized: concurrent first queries must not each embed the whole catalog.
      // The chain swallows a failure so one bad fill does not poison later calls.
      const run = this.filling.then(async () => {
        const miss = new Map<string, string>();
        keys.forEach((key, i) => this.store.get(key) || miss.set(key, texts[i]));
        if (!miss.size) return;
        const vecs = await this.embedder.embed([...miss.values()]);
        [...miss.keys()].forEach((key, i) => this.store.set(key, vecs[i]));
        this.store.save();
      });
      this.filling = run.catch(() => {});
      await run;
    }
    return keys.map((key) => this.store.get(key)!);
  }
}

// Hybrid retrieval: run several retrieval legs and fuse their rank lists with
// Reciprocal Rank Fusion. RRF consumes ranks, not scores, so it needs no
// normalization across the incompatible BM25-vs-cosine scales — the reason
// Elasticsearch/OpenSearch/Azure ship it as the default hybrid combiner (Cormack
// 2009; research doc). The legs are diverse retrievers that make different errors,
// so fusing them recalls tools any single leg drops.
//
// Default legs are the two lexical scorers (field-weighted overlap + BM25): they
// already miss different queries, so fusing them lifts top-3 with no model. The
// dense leg is just one more leg — `new HybridRouter([lex, bm25, new
// VectorRouter(embedder)])` — added when a local embedding model is wired, with no
// change above this class.
const RRF_K = 30; // smaller than the standard 60: our catalog is small and 60 flattens rank gaps at low N (research doc)

export class HybridRouter implements Router {
  constructor(
    private legs: Router[] = [new LexicalRouter(), new Bm25Router()],
    private rrfK = RRF_K,
  ) {}

  async rank(query: string, tools: RoutableTool[], k: number): Promise<ScoredTool[]> {
    if (this.legs.length === 1) return this.legs[0].rank(query, tools, k);
    // Retrieve a deeper pool from each leg than we return, so a tool that a single
    // leg ranks just outside top-k can still be rescued by fusion (recall lever).
    const pool = Math.max(k * 4, 20);
    const lists = await Promise.all(this.legs.map((r) => r.rank(query, tools, pool)));
    return rrfFuse(lists, this.rrfK).slice(0, k);
  }
}

/** Reciprocal Rank Fusion: score(d) = Σ_leg 1/(k + rank_leg(d)), rank 1-based.
 *  A tool ranked well by any leg accumulates; tools ranked well by several win. */
export function rrfFuse(lists: ScoredTool[][], k = RRF_K): ScoredTool[] {
  const acc = new Map<string, { tool: RoutableTool; score: number }>();
  for (const list of lists) {
    list.forEach((t, i) => {
      const id = `${t.server}/${t.tool}`;
      const cur = acc.get(id) ?? { tool: t, score: 0 };
      cur.score += 1 / (k + i + 1); // i is 0-based -> rank i+1
      acc.set(id, cur);
    });
  }
  return [...acc.values()].map((v) => ({ ...v.tool, score: v.score })).sort((a, b) => b.score - a.score);
}

/** Flattened document text for embedding: the same fields the sparse leg weights,
 *  concatenated. Name and examples lead because they carry the most intent. */
function docText(t: RoutableTool): string {
  return [t.tool, ...t.examples, (t.category ?? []).join(" "), t.description].join(". ");
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** Tokenize to lowercase alphanumeric terms, splitting snake_case, kebab, and
 *  camelCase (searchRepositories -> search, repositories) so tool names match. */
export function terms(s: string): string[] {
  return (s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !STOP.has(w));
}

function norm(s: string): string {
  return terms(s).join(" ");
}

function add(map: Map<string, number>, ts: string[], weight: number): void {
  for (const t of ts) map.set(stem(t), (map.get(stem(t)) ?? 0) + weight);
}

/** Crude suffix stemmer — collapses plurals and verb tense so "rows"/"row" and
 *  "meetings"/"meeting" match. Applied to both query and catalog, so even wrong
 *  stems still align. Not a real morphological stemmer; it only needs to make
 *  the two sides agree. */
function stem(w: string): string {
  if (w.length <= 4) return w;
  if (w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.endsWith("es")) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  if (w.endsWith("ing")) return w.slice(0, -3);
  if (w.endsWith("ed")) return w.slice(0, -2);
  return w;
}

// A tiny stoplist — filler that would otherwise reward every tool equally.
const STOP = new Set(["the", "a", "an", "my", "me", "to", "of", "in", "on", "for", "and", "or", "is", "it", "this", "that", "with", "please", "can", "you", "i", "want", "need"]);
