// Measures find_tools routing against the PDR target (>=90% top-3): the full
// fallback ladder (HybridDiscovery), no servers spawned, no network except the
// one-time model download from the Hugging Face hub with --dense.
//
// Informational: it reports numbers and exits 0 (1 only on bad input).
//
//   npm run bench                         bench/catalog.json + bench/queries.jsonl
//   npm run bench -- --dense [--model id] add the local-embedding leg
//   npm run bench -- --catalog-dir catalog --servers servers --queries bench/seed
//                                         the seed catalog: snapshots + manifests (routing.tools)
//   npm run bench -- --compress           schema tokens off/light/aggressive over the catalog
//   --cache-dir <dir>                     model + embedding cache (default $OSMCP_HOME/cache)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import type { CatalogSnapshot } from "../src/contracts.js";
import type { Manifest } from "../src/types.js";
import { compressSchema, createDiscovery, DEFAULT_MODEL, estTokens, toRoutable, type RoutableTool } from "../src/routing/index.js";

const TARGET_TOP3 = 0.9;
const K = 3;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const { values: args } = parseArgs({
  options: {
    dense: { type: "boolean", default: false },
    model: { type: "string" },
    "catalog-dir": { type: "string" },
    servers: { type: "string" },
    queries: { type: "string" },
    compress: { type: "boolean", default: false },
    "cache-dir": { type: "string" },
  },
});

type Query = { query: string; server: string; tool: string };

const catalog = args["catalog-dir"] ? seedCatalog(args["catalog-dir"], args.servers ?? join(args["catalog-dir"], "..", "servers")) : benchCatalog();
const queries = readQueries(args.queries ?? (args["catalog-dir"] ? join(root, "bench", "seed") : join(root, "bench", "queries.jsonl")));

// Guard: a labeled target missing from the catalog would silently count as a miss.
const known = new Set(catalog.map((t) => `${t.server}/${t.tool}`));
const unknown = queries.filter((q) => !known.has(`${q.server}/${q.tool}`));
if (unknown.length) {
  console.error(`skipping ${unknown.length} query target(s) not in the catalog:`);
  for (const m of unknown) console.error(`  ${m.server}/${m.tool}  ("${m.query}")`);
}
const labeled = queries.filter((q) => known.has(`${q.server}/${q.tool}`));

console.log(`catalog: ${catalog.length} tools across ${new Set(catalog.map((t) => t.server)).size} servers`);
if (args.compress) reportCompression(catalog);
if (!labeled.length) {
  console.log("no labeled queries to run");
  process.exit(0);
}

const cacheDir = args["cache-dir"] ?? join(process.env.OSMCP_HOME ?? join(homedir(), ".one-stop-mcp"), "cache");
const discovery = await createDiscovery({ embeddings: args.dense ? "on" : "off", model: args.model, cacheDir });
const legs = (discovery as { legs?: unknown[] }).legs?.length ?? 0;
console.log(`legs: ${legs === 3 ? `lexical + BM25 + dense (${args.model ?? DEFAULT_MODEL})` : "lexical + BM25"}`);

// The first query embeds every tool not yet in the on-disk cache; time it apart.
let t = performance.now();
await discovery.discover(labeled[0].query, catalog, K);
const firstMs = performance.now() - t;

let top1 = 0, top3 = 0;
const bucket = { high: { n: 0, top3: 0 }, low: { n: 0, top3: 0, wide: 0 } };
const ms: number[] = [];
const misses: string[] = [];
for (const q of labeled) {
  t = performance.now();
  const r = await discovery.discover(q.query, catalog, K);
  ms.push(performance.now() - t);
  const gold = `${q.server}/${q.tool}`;
  const ids = r.hits.map((h) => `${h.server}/${h.tool}`);
  const hit3 = ids.slice(0, K).includes(gold);
  if (ids[0] === gold) top1++;
  if (hit3) top3++;
  if (r.confidence === "high") {
    bucket.high.n++;
    bucket.high.top3 += +hit3;
  } else {
    bucket.low.n++;
    bucket.low.top3 += +hit3;
    bucket.low.wide += +ids.includes(gold);
  }
  if (!hit3) misses.push(`  MISS${r.confidence === "low" ? (ids.includes(gold) ? " (in widened list)" : " (low)") : ""}  "${q.query}"  want ${gold}  got [${ids.slice(0, K).join(", ") || "-"}]`);
}

const n = labeled.length;
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
ms.sort((a, b) => a - b);
console.log(`queries: ${n}`);
console.log(`top-1: ${top1}/${n} (${pct(top1, n)})`);
console.log(`top-3: ${top3}/${n} (${pct(top3, n)})  target ${TARGET_TOP3 * 100}%`);
console.log(`confidence high: ${bucket.high.n} queries, top-3 ${pct(bucket.high.top3, bucket.high.n)}`);
console.log(`confidence low:  ${bucket.low.n} queries, top-3 ${pct(bucket.low.top3, bucket.low.n)}, in widened top-${2 * K} ${pct(bucket.low.wide, bucket.low.n)}`);
console.log(`latency: first query ${firstMs.toFixed(0)} ms (index build), then p50 ${ms[n >> 1].toFixed(1)} ms, p95 ${ms[Math.floor(n * 0.95)].toFixed(1)} ms`);
if (misses.length) console.log(`misses:\n${misses.join("\n")}`);
console.log(top3 / n >= TARGET_TOP3 ? "\nrouting target met." : `\nbelow target by ${((TARGET_TOP3 - top3 / n) * 100).toFixed(1)} pts.`);

// --- inputs -------------------------------------------------------------------

function benchCatalog(): RoutableTool[] {
  return JSON.parse(readFileSync(join(root, "bench", "catalog.json"), "utf8"));
}

/** Snapshots joined to manifests by id, through the same toRoutable the registry
 *  uses. Tolerant on purpose: seed files are written in parallel, so a missing
 *  manifest or an unparseable file is reported and skipped, not fatal. */
function seedCatalog(catalogDir: string, serversDir: string): RoutableTool[] {
  const manifests = new Map<string, Manifest>();
  for (const f of list(serversDir, /\.ya?ml$/)) {
    try {
      const m = parseYaml(readFileSync(f, "utf8")) as Manifest;
      if (m?.id) manifests.set(m.id, m);
    } catch (err) {
      console.error(`skip ${f}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  const tools: RoutableTool[] = [];
  for (const f of list(catalogDir, /\.json$/)) {
    try {
      const snap = JSON.parse(readFileSync(f, "utf8")) as CatalogSnapshot;
      const m = manifests.get(snap.server);
      if (!m) console.error(`no manifest for snapshot ${snap.server}: routing without examples or categories`);
      tools.push(...toRoutable(m ?? { id: snap.server, category: [] }, snap));
    } catch (err) {
      console.error(`skip ${f}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  return tools;
}

/** A .jsonl file, or every .jsonl in a directory. Missing = no queries. */
function readQueries(path: string): Query[] {
  const files = !existsSync(path) ? [] : statSync(path).isDirectory() ? list(path, /\.jsonl$/) : [path];
  if (!files.length) console.error(`no queries at ${path}`);
  const out: Query[] = [];
  for (const f of files) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (!line.trim()) return;
      try {
        const q = JSON.parse(line);
        if (typeof q.query === "string" && typeof q.server === "string" && typeof q.tool === "string") return void out.push(q);
      } catch {}
      console.error(`skip ${f}:${i + 1}: not a {query, server, tool} line`);
    });
  }
  return out;
}

function list(dir: string, re: RegExp): string[] {
  try {
    return readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => join(dir, f));
  } catch {
    return [];
  }
}

function reportCompression(tools: RoutableTool[]): void {
  const schemas = tools.map((t) => t.inputSchema).filter((s) => s !== undefined);
  if (!schemas.length) return console.log("compress: catalog has no input schemas");
  const total = (level: "off" | "light" | "aggressive") => schemas.reduce((s: number, x) => s + estTokens(compressSchema(x, level)), 0);
  const off = total("off");
  for (const level of ["off", "light", "aggressive"] as const) {
    const n = total(level);
    console.log(`compress ${level.padEnd(10)} ${String(n).padStart(7)} tokens over ${schemas.length} schemas (${((1 - n / off) * 100).toFixed(1)}% saved, ~${(n / schemas.length).toFixed(0)}/tool)`);
  }
}
