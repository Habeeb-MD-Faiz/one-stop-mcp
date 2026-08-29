// Measures routing accuracy against the P1 target (>=90% top-3), over a
// hand-written offline catalog — no servers spawned, no model, no network.
//
// Informational: it reports the number and always exits 0. The current default
// (LexicalRouter) is a baseline; closing the last stretch to 90% is a semantic
// problem (synonymy), which the embedding router — same Router interface —
// exists to solve. This is the harness that will prove it when it lands.
//
// Run: npm run bench
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { LexicalRouter, type RoutableTool } from "../src/router.js";

const TARGET_TOP3 = 0.9;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const catalog: RoutableTool[] = JSON.parse(readFileSync(join(root, "bench", "catalog.json"), "utf8"));
const queries: Array<{ query: string; server: string; tool: string }> = readFileSync(join(root, "bench", "queries.jsonl"), "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => JSON.parse(l));

// Guard: every labeled target must exist in the catalog, or the benchmark lies.
const known = new Set(catalog.map((t) => `${t.server}/${t.tool}`));
const missing = queries.filter((q) => !known.has(`${q.server}/${q.tool}`));
if (missing.length) {
  console.error(`benchmark is inconsistent — ${missing.length} query target(s) not in catalog:`);
  for (const m of missing) console.error(`  ${m.server}/${m.tool}  ("${m.query}")`);
  process.exit(1);
}

const router = new LexicalRouter();
let top1 = 0;
let top3 = 0;
const misses: string[] = [];

for (const q of queries) {
  const ranked = router.rank(q.query, catalog, 3);
  const gold = `${q.server}/${q.tool}`;
  const ids = ranked.map((r) => `${r.server}/${r.tool}`);
  if (ids[0] === gold) top1++;
  if (ids.includes(gold)) top3++;
  else misses.push(`  MISS  "${q.query}"  want ${gold}  got [${ids.join(", ") || "—"}]`);
}

const n = queries.length;
const p3 = top3 / n;
console.log(`catalog: ${catalog.length} tools across ${new Set(catalog.map((t) => t.server)).size} servers`);
console.log(`queries: ${n}`);
console.log(`top-1: ${top1}/${n} (${(top1 / n * 100).toFixed(1)}%)`);
console.log(`top-3: ${top3}/${n} (${(p3 * 100).toFixed(1)}%)  target ${(TARGET_TOP3 * 100).toFixed(0)}%`);
if (misses.length) {
  console.log("misses:");
  for (const m of misses) console.log(m);
}
console.log(
  p3 >= TARGET_TOP3
    ? `\nP1 routing target met.`
    : `\nbaseline below target by ${((TARGET_TOP3 - p3) * 100).toFixed(1)} pts — remaining misses are synonymy (semantic router territory, same interface).`,
);
