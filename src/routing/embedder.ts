// Layer A's dense leg: a local sentence-embedding model run through ONNX by
// @huggingface/transformers (D5). No API, no key: the model is downloaded once
// from the Hugging Face hub into `cacheDir` and runs on CPU after that. The
// package is an optionalDependency, so it is imported dynamically and every
// caller must survive it being absent (createDiscovery falls back to lexical).
//
// Models: Sentence-BERT-style bi-encoders (Reimers & Gurevych, arXiv:1908.10084).
// MiniLM is trained for mean pooling (arXiv:2002.10957); BGE for the [CLS] token
// (arXiv:2309.07597, model card BAAI/bge-small-en-v1.5).

import type { Embedder } from "./router.js";

/** Chosen by `npm run bench -- --dense` (2026-10-11, fused with lexical + BM25):
 *  top-3 on bench/ 94.1% vs MiniLM 91.2%; on the 33-server seed draft 44.5% vs
 *  41.4%. Costs ~15 ms more per query and ~1.5x the first-index time. BGE's
 *  query instruction changed nothing here, so queries are embedded as-is. */
export const DEFAULT_MODEL = "Xenova/bge-small-en-v1.5";

type Pooling = "mean" | "cls";
// Pooling each model was trained with; unknown models get mean, the common default.
const POOLING: Record<string, Pooling> = {
  "Xenova/all-MiniLM-L6-v2": "mean",
  "Xenova/bge-small-en-v1.5": "cls",
};

const BATCH = 32; // texts per forward pass: bounds padding waste and peak memory

type Extractor = (texts: string[], o: { pooling: Pooling; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

export class LocalEmbedder implements Embedder {
  readonly model: string;
  private cacheDir?: string;
  private extractor?: Promise<Extractor>;

  constructor(opts: { model?: string; cacheDir?: string } = {}) {
    this.model = opts.model ?? DEFAULT_MODEL;
    this.cacheDir = opts.cacheDir;
  }

  /** Import the runtime and load the model (downloading it on first use). Call
   *  up front to surface a missing package or model as one early failure. */
  load(): Promise<Extractor> {
    this.extractor ??= (async () => {
      const spec = "@huggingface/transformers"; // a variable keeps tsc from requiring the optional package
      const { pipeline } = await import(spec);
      return (await pipeline("feature-extraction", this.model, { cache_dir: this.cacheDir, dtype: "fp32" })) as Extractor;
    })();
    // A failed load must not stick: the next call retries instead of replaying the error forever.
    this.extractor.catch(() => (this.extractor = undefined));
    return this.extractor;
  }

  /** Unit-length vectors (L2-normalized), so cosine is a dot product. */
  async embed(texts: string[]): Promise<number[][]> {
    const extract = await this.load();
    const pooling = POOLING[this.model] ?? "mean";
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      out.push(...(await extract(texts.slice(i, i + BATCH), { pooling, normalize: true })).tolist());
    }
    return out;
  }
}
