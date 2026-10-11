import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agree,
  createDiscovery,
  EmbeddingStore,
  HybridDiscovery,
  LocalEmbedder,
  terms,
  toRoutable,
  VectorRouter,
  type Embedder,
  type RoutableTool,
  type Router,
  type ScoredTool,
} from "../src/routing/index.js";
import type { CatalogSnapshot } from "../src/contracts.js";

const schema = { type: "object", title: "kept as-is", properties: { q: { type: "string" } } };
const catalog: RoutableTool[] = [
  { server: "github", tool: "create_issue", description: "Open a new issue on a repository.", examples: ["file a bug on the repo"], category: ["dev"], inputSchema: schema },
  { server: "gitlab", tool: "create_issue", description: "Open a new issue in a GitLab project.", examples: [], category: ["dev"] },
  { server: "github", tool: "search_repositories", description: "Search for repositories.", examples: ["find a repo"], category: ["dev"] },
  { server: "postgres", tool: "run_query", description: "Run a read-only SQL query.", examples: ["query the database"], category: ["data", "database"] },
  { server: "calendar", tool: "create_event", description: "Schedule a meeting on the calendar.", examples: [], category: ["productivity"] },
];

// Deterministic fake: bag of known words. Counts the texts it was asked to embed.
function fakeEmbedder(vocab = ["issue", "repository", "query", "sql", "meeting", "book", "schedule"]): Embedder & { calls: number; texts: number } {
  const e = {
    calls: 0,
    texts: 0,
    async embed(texts: string[]) {
      e.calls++;
      e.texts += texts.length;
      // "book" is a synonym the lexical legs cannot see; the fake maps it onto "schedule".
      return texts.map((t) => {
        const ws = new Set(terms(t).map((w) => (w === "book" ? "schedule" : w.replace(/ies$/, "y").replace(/s$/, ""))));
        return vocab.map((v) => (ws.has(v) ? 1 : 0));
      });
    },
  };
  return e;
}

const leg = (ids: string[]): Router => ({
  rank: async (_q, tools) => ids.map((id, i) => ({ ...tools.find((t) => `${t.server}/${t.tool}` === id)!, score: 10 - i })),
});

// --- the fallback ladder ------------------------------------------------------

test("exact: a tool or server/tool name, any case or separator, goes first with high confidence", async () => {
  const d = new HybridDiscovery();
  for (const q of ["search_repositories", "Search-Repositories", "github/search_repositories", "GitHub.Search Repositories"]) {
    const r = await d.discover(q, catalog, 3);
    assert.equal(`${r.hits[0].server}/${r.hits[0].tool}`, "github/search_repositories", q);
    assert.equal(r.confidence, "high", q);
    assert.equal(r.widened, false);
  }
  const qualified = await d.discover("gitlab/create_issue", catalog, 3);
  assert.equal(qualified.hits[0].server, "gitlab", "server-qualified name picks that server");
});

test("exact: a bare name shared by several servers puts them all first but is not an identification", async () => {
  const r = await new HybridDiscovery([leg(["postgres/run_query"]), leg(["calendar/create_event"])]).discover("create_issue", catalog, 3);
  assert.deepEqual(r.hits.slice(0, 2).map((h) => h.server).sort(), ["github", "gitlab"]);
  assert.equal(r.confidence, "low");
});

test("hybrid: legs agreeing on the top hit -> high confidence, k hits, schema untouched", async () => {
  const r = await new HybridDiscovery().discover("open a new issue on the repository", catalog, 2);
  assert.equal(r.confidence, "high");
  assert.equal(r.widened, false);
  assert.equal(r.hits.length, 2);
  assert.equal(r.hits[0].tool, "create_issue");
  assert.equal(r.hits.find((h) => h.server === "github" && h.tool === "create_issue")!.inputSchema, schema, "compression is the caller's job");
});

test("low confidence: legs disagree -> widened to 2k with categories to browse", async () => {
  const d = new HybridDiscovery([
    leg(["postgres/run_query", "github/search_repositories"]),
    leg(["calendar/create_event", "gitlab/create_issue"]),
  ]);
  const r = await d.discover("something vague", catalog, 2);
  assert.equal(r.confidence, "low");
  assert.equal(r.widened, true);
  assert.equal(r.hits.length, 4);
  assert.equal(r.browse![0], "dev", "the category the candidates concentrate in leads");
  assert.ok(r.browse!.length <= 3);
});

test("no candidates at all -> empty hits, low, browse the catalog's largest categories", async () => {
  const r = await new HybridDiscovery().discover("zzz qqq", catalog, 3);
  assert.deepEqual(r.hits, []);
  assert.equal(r.confidence, "low");
  assert.equal(r.browse![0], "dev");
});

test("agree(): every leg that returned anything must have the top hit in its top 3", () => {
  const t = (tool: string): ScoredTool => ({ server: "s", tool, description: "", examples: [], score: 1 });
  assert.equal(agree(t("a"), [[t("a")], [t("x"), t("y"), t("a")], []]), true);
  assert.equal(agree(t("a"), [[t("a")], [t("x"), t("y"), t("z"), t("a")]]), false);
  assert.equal(agree(undefined, [[t("a")]]), false);
  assert.equal(agree(t("a"), [[], []]), false);
});

test("a failing leg degrades discovery to the remaining legs", async () => {
  const broken: Router = { rank: async () => { throw new Error("out of memory"); } };
  const r = await new HybridDiscovery([broken, leg(["postgres/run_query"])]).discover("anything", catalog, 3);
  assert.equal(r.hits[0].tool, "run_query");
});

test("k is clamped to a sane range", async () => {
  const d = new HybridDiscovery();
  assert.equal((await d.discover("github/create_issue", catalog, 0)).hits.length, 1);
  assert.ok((await d.discover("issue", catalog, Number.NaN)).hits.length >= 1);
});

// --- dense leg + on-disk store ------------------------------------------------

test("the dense leg rescues a synonym the lexical legs miss", async () => {
  const d = new HybridDiscovery([...new HybridDiscovery().legs, new VectorRouter(fakeEmbedder())]);
  const r = await d.discover("book a slot", catalog, 3);
  assert.equal(r.hits[0].tool, "create_event");
});

test("EmbeddingStore round-trips vectors through disk and keys by model + text", () => {
  const dir = mkdtempSync(join(tmpdir(), "osmcp-emb-"));
  try {
    const a = new EmbeddingStore("m1", dir);
    const v = [0.1, -0.25, 3];
    a.set(a.key("doc"), v);
    a.save();
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), [], "no temp file left behind");
    const b = new EmbeddingStore("m1", dir);
    assert.deepEqual(b.get(b.key("doc"))!.map((x) => +x.toFixed(5)), v);
    assert.notEqual(b.key("doc"), b.key("doc2"));
    assert.notEqual(new EmbeddingStore("m2").key("doc"), b.key("doc"), "a different model never reuses a vector");
    assert.equal(new EmbeddingStore("m2", dir).size, 0, "each model has its own file");
    writeFileSync(join(dir, readdirSync(dir)[0]), "{not json");
    assert.equal(new EmbeddingStore("m1", dir).size, 0, "a corrupt cache starts empty instead of throwing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("VectorRouter embeds each tool once: not again on restart, only changed tools later", async () => {
  const dir = mkdtempSync(join(tmpdir(), "osmcp-emb-"));
  try {
    const e1 = fakeEmbedder();
    await new VectorRouter(e1, new EmbeddingStore("fake", dir)).rank("sql query", catalog, 3);
    assert.equal(e1.texts, catalog.length + 1, "every tool + the query");

    const e2 = fakeEmbedder();
    const r = new VectorRouter(e2, new EmbeddingStore("fake", dir)); // a restart
    const hits = await r.rank("sql query", catalog, 3);
    assert.equal(hits[0].tool, "run_query");
    assert.equal(e2.texts, 1, "only the query is embedded after a restart");

    const edited = catalog.map((t) => (t.tool === "run_query" ? { ...t, description: "Run any SQL query." } : t));
    await r.rank("sql query", edited, 3);
    assert.equal(e2.texts, 3, "one changed tool + the query");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("VectorRouter: concurrent first queries embed the catalog once", async () => {
  const e = fakeEmbedder();
  const r = new VectorRouter(e);
  await Promise.all([r.rank("sql", catalog, 3), r.rank("issue", catalog, 3), r.rank("meeting", catalog, 3)]);
  assert.equal(e.texts, catalog.length + 3);
});

// --- createDiscovery ----------------------------------------------------------

test("createDiscovery: off = lexical + BM25; on = + dense; a failed load falls back with one stderr line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "osmcp-disc-"));
  const write = process.stderr.write;
  const lines: string[] = [];
  try {
    const off = (await createDiscovery({ embeddings: "off", cacheDir: dir })) as HybridDiscovery;
    assert.equal(off.legs.length, 2);

    const fake = Object.assign(fakeEmbedder(), { model: "fake", load: async () => {} });
    const on = (await createDiscovery({ embeddings: "on", cacheDir: dir, embedder: fake })) as HybridDiscovery;
    assert.equal(on.legs.length, 3);
    assert.equal((await on.discover("book a slot", catalog, 3)).hits[0].tool, "create_event");

    process.stderr.write = ((s: string) => (lines.push(s), true)) as typeof process.stderr.write;
    const broken = { ...fake, load: async () => { throw new Error("Cannot find package '@huggingface/transformers'\nstack"); } };
    const fallback = (await createDiscovery({ embeddings: "on", cacheDir: dir, embedder: broken })) as HybridDiscovery;
    process.stderr.write = write;
    assert.equal(fallback.legs.length, 2);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /local embeddings unavailable \(Cannot find package '@huggingface\/transformers'\); routing uses lexical \+ BM25 only\n$/);
    assert.equal((await fallback.discover("run a sql query", catalog, 3)).hits[0].tool, "run_query", "still routes");
  } finally {
    process.stderr.write = write;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- toRoutable ---------------------------------------------------------------

test("toRoutable: per-tool utterances first, then server-level ones; schema passed through", () => {
  const snap: CatalogSnapshot = {
    server: "github",
    source: "docs",
    fetchedAt: "2026-10-10T00:00:00Z",
    tools: [
      { name: "create_issue", description: "Open an issue.", inputSchema: schema },
      { name: "constructor", inputSchema: { type: "object" } },
    ],
  };
  const [a, b] = toRoutable({ id: "github", category: ["dev"], routing: { examples: ["use github"], tools: { create_issue: ["file a bug"] } } }, snap);
  assert.deepEqual(a, { server: "github", tool: "create_issue", description: "Open an issue.", examples: ["file a bug", "use github"], category: ["dev"], inputSchema: schema });
  assert.deepEqual(b.examples, ["use github"], "a tool named like an Object.prototype key gets no phantom examples");
  assert.equal(b.description, "");
  assert.deepEqual(toRoutable({ id: "x", category: [] }, snap)[0].examples, [], "no routing block at all");
});

// --- the real model (downloads ~130 MB on first run) ---------------------------

test("LocalEmbedder: real model, unit vectors, paraphrases closer than unrelated text", { skip: process.env.OSMCP_TEST_EMBEDDINGS !== "1" && "set OSMCP_TEST_EMBEDDINGS=1" }, async () => {
  const e = new LocalEmbedder({ cacheDir: process.env.OSMCP_TEST_CACHE ?? join(tmpdir(), "osmcp-models") });
  const [a, b, c] = await e.embed(["open a bug report on the repo", "file an issue against the repository", "what is the weather in Paris"]);
  const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i], 0);
  assert.ok(Math.abs(dot(a, a) - 1) < 1e-3, "L2-normalized");
  assert.ok(dot(a, b) > dot(a, c));
});
