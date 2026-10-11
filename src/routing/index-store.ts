// On-disk embedding cache for Layer A, so a restart (or an unchanged catalog)
// never re-embeds a tool. One file per model under `dir`; each vector is keyed by
// sha256(model + "\0" + docText), so editing a tool's description or examples
// changes its key and only that tool is re-embedded. Vectors are stored as
// base64 Float32 (half the size of JSON number arrays). Without a `dir` the store
// is memory-only, which is what tests and one-shot runs want.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface StoreFile {
  model: string;
  vectors: Record<string, string>;
}

export class EmbeddingStore {
  private vectors = new Map<string, number[]>();
  private file?: string;

  constructor(readonly model: string, dir?: string) {
    if (!dir) return;
    this.file = join(dir, `embeddings-${model.replace(/[^a-zA-Z0-9.-]+/g, "_")}.json`);
    try {
      const data: StoreFile = JSON.parse(readFileSync(this.file, "utf8"));
      if (data.model !== model) return;
      // Copy into a fresh Uint8Array: Buffer.from may sit at an unaligned offset of
      // Node's shared pool, which a Float32Array view rejects.
      for (const [key, b64] of Object.entries(data.vectors)) this.vectors.set(key, [...new Float32Array(new Uint8Array(Buffer.from(b64, "base64")).buffer)]);
    } catch {
      this.vectors.clear(); // missing or corrupt: start empty, the next save rewrites it whole
    }
  }

  key(text: string): string {
    return createHash("sha256").update(this.model + "\0" + text).digest("hex");
  }

  get(key: string): number[] | undefined {
    return this.vectors.get(key);
  }

  set(key: string, vec: number[]): void {
    this.vectors.set(key, vec);
  }

  get size(): number {
    return this.vectors.size;
  }

  /** Persist atomically: write a temp file, then rename over the old one, so a
   *  crash mid-write leaves the previous cache intact rather than a torn file.
   *  ponytail: never prunes vectors of tools that left the catalog; the file grows
   *  only with catalog churn. Prune to the live key set if that ever matters. */
  save(): void {
    if (!this.file) return;
    const vectors: Record<string, string> = {};
    for (const [k, v] of this.vectors) vectors[k] = Buffer.from(new Float32Array(v).buffer).toString("base64");
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ model: this.model, vectors } satisfies StoreFile));
    renameSync(tmp, this.file);
  }
}
