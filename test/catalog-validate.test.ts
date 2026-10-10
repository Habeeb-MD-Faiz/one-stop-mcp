// Catalog-wide checks (`npm run validate`) over fixture trees, plus the script's exit code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCatalog } from "../src/catalog/validate.js";

const script = fileURLToPath(new URL("../scripts/validate-manifests.ts", import.meta.url));
const manifest = (id: string, extra = "") => `id: ${id}\nname: ${id}\ncategory: [dev]\ndescription: d\ntransport: {type: stdio, command: node}\n${extra}`;
const snapshot = (id: string, tools: string[]) =>
  JSON.stringify({ server: id, source: "docs", fetchedAt: "2026-10-10T00:00:00Z", tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })) });

/** servers/<id>.yaml + catalog/<id>.json (+ bench/seed/<id>.jsonl) from a spec. */
function tree(spec: Record<string, { yaml: string; json?: string; bench?: string }>) {
  const root = mkdtempSync(join(tmpdir(), "osmcp-validate-"));
  for (const d of ["servers", "catalog", "bench/seed"]) mkdirSync(join(root, d), { recursive: true });
  for (const [id, s] of Object.entries(spec)) {
    writeFileSync(join(root, "servers", `${id}.yaml`), s.yaml);
    if (s.json !== undefined) writeFileSync(join(root, "catalog", `${id}.json`), s.json);
    if (s.bench !== undefined) writeFileSync(join(root, "bench", "seed", `${id}.jsonl`), s.bench);
  }
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("a consistent server passes and is counted", () => {
  const t = tree({ a: { yaml: manifest("a", "routing:\n  tools:\n    go: [go now]\n"), json: snapshot("a", ["go", "stop"]), bench: '{"query":"q","server":"a","tool":"stop"}\n\n' } });
  try {
    const r = validateCatalog(t.root);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.rows.map((x) => [x.id, x.transport, x.auth, x.tools, x.bench]), [["a", "stdio", "none", 2, 1]]);
  } finally {
    t.done();
  }
});

test("every kind of inconsistency is reported with the file that needs fixing", () => {
  const t = tree({
    nosnap: { yaml: manifest("nosnap") },
    badjson: { yaml: manifest("badjson"), json: "{ nope" },
    empty: { yaml: manifest("empty"), json: snapshot("empty", []) },
    wrongid: { yaml: manifest("wrongid"), json: snapshot("other", ["t"]) },
    routing: { yaml: manifest("routing", "routing:\n  tools:\n    ghost: [boo]\n"), json: snapshot("routing", ["real"]) },
    bench: {
      yaml: manifest("bench"),
      json: snapshot("bench", ["real"]),
      bench: ['{"query":"q","server":"bench","tool":"ghost"}', "not json", '{"query":" ","tool":"real"}', '{"query":"q","server":"zzz","tool":"real"}'].join("\n"),
    },
    invalid: { yaml: manifest("invalid").replace("[dev]", "[nope]"), json: snapshot("invalid", ["t"]) },
  });
  try {
    const msg = validateCatalog(t.root).errors.join("\n");
    for (const want of [
      "catalog/nosnap.json: missing",
      "catalog/badjson.json: invalid JSON",
      "catalog/empty.json: tools: empty",
      "catalog/wrongid.json: server: must equal the file name (wrongid)",
      "routing.yaml: routing.tools.ghost: no such tool in catalog/routing.json",
      'bench/seed/bench.jsonl:1: tool: "ghost" is not in catalog/bench.json',
      "bench/seed/bench.jsonl:2: invalid JSON",
      "bench/seed/bench.jsonl:3: query: must be a non-empty string",
      'bench/seed/bench.jsonl:4: server: "zzz" is not bench',
      'invalid.yaml: category: unknown category "nope"',
    ]) assert.ok(msg.includes(want), `missing "${want}" in:\n${msg}`);
  } finally {
    t.done();
  }
});

test("duplicate ids across files are an error", () => {
  const t = tree({ a: { yaml: manifest("a"), json: snapshot("a", ["t"]) } });
  writeFileSync(join(t.root, "servers", "a.yml"), manifest("a"));
  try {
    assert.match(validateCatalog(t.root).errors.join("\n"), /a\.yml: id: duplicate of a\.yaml/);
  } finally {
    t.done();
  }
});

test("the script prints a table and exits 0 / 1", () => {
  const ok = tree({ a: { yaml: manifest("a"), json: snapshot("a", ["t"]) } });
  const bad = tree({ a: { yaml: manifest("a") } });
  try {
    const run = (root: string) => spawnSync(process.execPath, ["--import", "tsx", script, root], { encoding: "utf8" });
    const good = run(ok.root);
    assert.equal(good.status, 0, good.stderr);
    assert.match(good.stdout, /id\s+transport\s+auth\s+tools\s+bench\s+status\na\s+stdio\s+none\s+1\s+-\s+ok/);
    const fail = run(bad.root);
    assert.equal(fail.status, 1);
    assert.match(fail.stderr, /catalog\/a\.json: missing/);
  } finally {
    ok.done();
    bad.done();
  }
});
