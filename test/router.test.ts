import { test } from "node:test";
import assert from "node:assert/strict";
import { LexicalRouter, terms, type RoutableTool } from "../src/router.js";

const catalog: RoutableTool[] = [
  { server: "github", tool: "create_issue", description: "Open a new issue on a repository.", examples: ["file a bug on the repo"], category: ["dev"] },
  { server: "github", tool: "search_repositories", description: "Search for repositories.", examples: ["find a repo"], category: ["dev"] },
  { server: "postgres", tool: "run_query", description: "Run a read-only SQL query.", examples: ["query the database"], category: ["data"] },
];

test("terms() splits camelCase, snake_case, and kebab", () => {
  assert.deepEqual(terms("searchRepositories"), ["search", "repositories"]);
  assert.deepEqual(terms("run_query"), ["run", "query"]);
  assert.deepEqual(terms("brave-search"), ["brave", "search"]);
});

test("router ranks the on-topic tool first and drops zero-score tools", () => {
  const r = new LexicalRouter();
  const hits = r.rank("open a new issue", catalog, 3);
  assert.equal(hits[0].tool, "create_issue");
  assert.ok(!hits.some((h) => h.tool === "run_query"), "unrelated tool should score 0 and be excluded");
});

test("stoplist prevents filler words from matching everything", () => {
  const r = new LexicalRouter();
  // "the" is a stopword; only "sql"/"query" carry signal -> postgres.
  const hits = r.rank("run the sql query", catalog, 3);
  assert.equal(hits[0].tool, "run_query");
});

test("empty query returns nothing", () => {
  assert.deepEqual(new LexicalRouter().rank("   ", catalog, 3), []);
});
