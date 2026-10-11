// Routing's public face: the Discovery the gateway wires in, and the one helper
// that turns a manifest + catalog snapshot into routable tools, shared by the
// registry and the bench so both score exactly the same documents.

import { join } from "node:path";
import type { CatalogSnapshot, Discovery } from "../contracts.js";
import type { Manifest } from "../types.js";
import { HybridDiscovery } from "./discovery.js";
import { LocalEmbedder } from "./embedder.js";
import { EmbeddingStore } from "./index-store.js";
import { Bm25Router, LexicalRouter, VectorRouter, type Embedder, type RoutableTool, type Router } from "./router.js";

export { HybridDiscovery, agree, namedServers } from "./discovery.js";
export { DEFAULT_MODEL, LocalEmbedder } from "./embedder.js";
export { EmbeddingStore } from "./index-store.js";
export { compressSchema, estTokens, type CompressLevel } from "./compress.js";
export * from "./router.js";

export interface DiscoveryOptions {
  embeddings: "on" | "off";
  /** Hugging Face model id; default DEFAULT_MODEL. */
  model?: string;
  /** State dir for the downloaded model (`models/`) and the embedding cache. */
  cacheDir: string;
  /** Test seam: replaces LocalEmbedder. */
  embedder?: Embedder & { model: string; load(): Promise<unknown> };
}

/** Lexical + BM25 always; plus the dense leg when embeddings are on and the model
 *  loads. Any load failure (package absent, no network on first run, native
 *  runtime missing) costs one stderr line and leaves routing lexical, never down. */
export async function createDiscovery(opts: DiscoveryOptions): Promise<Discovery> {
  const legs: Router[] = [new LexicalRouter(), new Bm25Router()];
  if (opts.embeddings === "on") {
    const embedder = opts.embedder ?? new LocalEmbedder({ model: opts.model, cacheDir: join(opts.cacheDir, "models") });
    try {
      await embedder.load();
      legs.push(new VectorRouter(embedder, new EmbeddingStore(embedder.model, opts.cacheDir)));
    } catch (err) {
      const why = String((err as Error)?.message ?? err).split("\n")[0];
      process.stderr.write(`one-stop-mcp: local embeddings unavailable (${why}); routing uses lexical + BM25 only\n`);
    }
  }
  return new HybridDiscovery(legs);
}

/** One RoutableTool per snapshot tool. Examples are the tool's own utterances
 *  (`routing.tools[tool]`) followed by the server-level `routing.examples`. */
export function toRoutable(m: Pick<Manifest, "id" | "category" | "routing">, snapshot: CatalogSnapshot): RoutableTool[] {
  const perTool = m.routing?.tools ?? {};
  return snapshot.tools.map((t) => ({
    server: m.id,
    tool: t.name,
    description: t.description ?? "",
    // hasOwn: a tool named `constructor` or `toString` must not pick up Object.prototype.
    examples: [...(Object.hasOwn(perTool, t.name) ? perTool[t.name] : []), ...(m.routing?.examples ?? [])],
    category: m.category,
    inputSchema: t.inputSchema,
  }));
}
