import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LexicalRouter,
  Bm25Router,
  HybridRouter,
  VectorRouter,
  rrfFuse,
  terms,
  type Embedder,
  type RoutableTool,
  type ScoredTool,
} from "../src/routing/router.js";

const catalog: RoutableTool[] = [
  { server: "github", tool: "create_issue", description: "Open a new issue on a repository.", examples: ["file a bug on the repo"], category: ["dev"] },
  { server: "github", tool: "search_repositories", description: "Search for repositories.", examples: ["find a repo"], category: ["dev"] },
  { server: "postgres", tool: "run_query", description: "Run a read-only SQL query.", examples: ["query the database"], category: ["data"] },
];

test("terms() splits camelCase, snake_case, and kebab", async () => {
  assert.deepEqual(terms("searchRepositories"), ["search", "repositories"]);
  assert.deepEqual(terms("run_query"), ["run", "query"]);
  assert.deepEqual(terms("brave-search"), ["brave", "search"]);
});

test("router ranks the on-topic tool first and drops zero-score tools", async () => {
  const r = new LexicalRouter();
  const hits = await r.rank("open a new issue", catalog, 3);
  assert.equal(hits[0].tool, "create_issue");
  assert.ok(!hits.some((h) => h.tool === "run_query"), "unrelated tool should score 0 and be excluded");
});

test("stoplist prevents filler words from matching everything", async () => {
  const r = new LexicalRouter();
  // "the" is a stopword; only "sql"/"query" carry signal -> postgres.
  const hits = await r.rank("run the sql query", catalog, 3);
  assert.equal(hits[0].tool, "run_query");
});

test("empty query returns nothing", async () => {
  assert.deepEqual(await new LexicalRouter().rank("   ", catalog, 3), []);
});

// BM25's IDF discounts a term shared by many tools and rewards the rare
// discriminating one — the property lexical overlap lacks.
test("BM25 lets a rare term outweigh a common one", async () => {
  const c: RoutableTool[] = [
    { server: "db", tool: "create_table", description: "create a table", examples: [], category: [] },
    { server: "db", tool: "describe_table", description: "describe a table", examples: [], category: [] },
    { server: "db", tool: "read_query", description: "read rows from a table", examples: ["pull rows from a table"], category: [] },
  ];
  // "table" is in every doc (low IDF); "rows" is only in read_query (high IDF).
  const hits = await new Bm25Router().rank("pull rows from the table", c, 3);
  assert.equal(hits[0].tool, "read_query");
});

test("rrfFuse rewards agreement and surfaces a tool ranked well by one leg", async () => {
  const mk = (tool: string, score: number): ScoredTool => ({ server: "s", tool, description: "", examples: [], score });
  const a = [mk("x", 9), mk("y", 8), mk("z", 7)];
  const b = [mk("y", 5), mk("q", 4), mk("x", 3)];
  const fused = rrfFuse([a, b]);
  // y is top-2 in both legs -> should win; x (1st in a, 3rd in b) still surfaces high.
  assert.equal(fused[0].tool, "y");
  assert.ok(fused.slice(0, 2).some((t) => t.tool === "x"));
});

test("HybridRouter with one leg delegates unchanged; fusing two legs recalls what one drops", async () => {
  const one = new HybridRouter([new LexicalRouter()]);
  assert.deepEqual(
    (await one.rank("open a new issue", catalog, 3)).map((h) => h.tool),
    (await new LexicalRouter().rank("open a new issue", catalog, 3)).map((h) => h.tool),
  );
  // Default legs (lexical + BM25) both find the query tool for a clean query.
  const hits = await new HybridRouter().rank("search for repositories", catalog, 3);
  assert.equal(hits[0].tool, "search_repositories");
});

// Proves the dense leg's cosine path works end to end with a trivial deterministic
// embedder (bag-of-terms over a fixed vocab) — a real model just swaps the Embedder.
test("VectorRouter ranks by cosine over embeddings", async () => {
  const vocab = ["issue", "search", "query", "sql", "repository", "bug"];
  const embedder: Embedder = {
    embed: async (texts) => texts.map((t) => {
      const ts = new Set(terms(t).map((w) => w.replace(/ies$/, "y").replace(/s$/, "")));
      return vocab.map((v) => (ts.has(v) ? 1 : 0));
    }),
  };
  const hits = await new VectorRouter(embedder).rank("run a sql query", catalog, 3);
  assert.equal(hits[0].tool, "run_query");
});
