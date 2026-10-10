// FileCatalogStore: shipped snapshot, live overlay in the state dir, atomic save,
// and the shape checks (which `npm run validate` reuses).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogSnapshot } from "../src/contracts.js";
import { FileCatalogStore, validateSnapshot } from "../src/catalog/store.js";

const snap = (server: string, over: Partial<CatalogSnapshot> = {}): CatalogSnapshot => ({
  server,
  source: "docs",
  fetchedAt: "2026-10-10T00:00:00Z",
  tools: [{ name: "echo", description: "Echo.", inputSchema: { type: "object" } }],
  ...over,
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "osmcp-store-"));
  const shippedDir = join(root, "catalog");
  const stateDir = join(root, "state", "catalog");
  mkdirSync(shippedDir, { recursive: true });
  writeFileSync(join(shippedDir, "echo.json"), JSON.stringify(snap("echo")));
  return { root, shippedDir, stateDir, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("load: shipped snapshot, undefined when unknown, ids that could escape the dir are just unknown", () => {
  const f = fixture();
  try {
    const store = new FileCatalogStore({ shippedDir: f.shippedDir });
    assert.deepEqual(store.load("echo"), snap("echo"));
    assert.equal(store.load("nope"), undefined);
    assert.equal(store.load("../catalog/echo"), undefined);
  } finally {
    f.done();
  }
});

test("save writes the state dir (atomically, no tmp left), shadows the shipped snapshot, never touches the shipped dir", () => {
  const f = fixture();
  try {
    const store = new FileCatalogStore({ shippedDir: f.shippedDir, stateDir: f.stateDir });
    const live = snap("echo", { source: "live", fetchedAt: "2026-10-11T00:00:00Z", tools: [{ name: "echo2", inputSchema: { type: "object" } }] });
    store.save(live);
    assert.deepEqual(store.load("echo"), live);
    assert.deepEqual(readdirSync(f.stateDir), ["echo.json"]);
    assert.deepEqual(JSON.parse(readFileSync(join(f.shippedDir, "echo.json"), "utf8")), snap("echo"));
    // a server with no shipped snapshot can still be refreshed live
    store.save(snap("newcomer", { source: "live" }));
    assert.equal(new FileCatalogStore({ shippedDir: f.shippedDir, stateDir: f.stateDir }).load("newcomer")?.source, "live");
    // overwrite replaces
    store.save(snap("echo", { source: "live", tools: [] }));
    assert.deepEqual(store.load("echo")?.tools, []);
  } finally {
    f.done();
  }
});

test("save refuses without a stateDir, with an invalid snapshot, and when stateDir is the shipped dir", () => {
  const f = fixture();
  try {
    assert.throws(() => new FileCatalogStore({ shippedDir: f.shippedDir }).save(snap("echo")), /no stateDir/);
    assert.throws(() => new FileCatalogStore({ shippedDir: f.shippedDir, stateDir: f.shippedDir }), /must differ/);
    const store = new FileCatalogStore({ shippedDir: f.shippedDir, stateDir: f.stateDir });
    assert.throws(() => store.save(snap("../evil")), /server: must be a lowercase-kebab/);
    assert.throws(() => store.save(snap("echo", { tools: [{ name: "", inputSchema: {} }] })), /tools\[0\]/);
  } finally {
    f.done();
  }
});

test("a corrupt state snapshot is ignored (shipped is used); a corrupt shipped snapshot throws", () => {
  const f = fixture();
  try {
    mkdirSync(f.stateDir, { recursive: true });
    writeFileSync(join(f.stateDir, "echo.json"), "{ not json");
    const store = new FileCatalogStore({ shippedDir: f.shippedDir, stateDir: f.stateDir });
    const warn = console.error;
    console.error = () => {};
    try {
      assert.deepEqual(store.load("echo"), snap("echo"));
    } finally {
      console.error = warn;
    }
    writeFileSync(join(f.shippedDir, "broken.json"), JSON.stringify({ server: "broken", source: "docs" }));
    assert.throws(() => store.load("broken"), /broken\.json: fetchedAt/);
    writeFileSync(join(f.shippedDir, "wrongid.json"), JSON.stringify(snap("other")));
    assert.throws(() => store.load("wrongid"), /server: must equal the file name \(wrongid\)/);
  } finally {
    f.done();
  }
});

test("validateSnapshot: names the field for every shape error", () => {
  const bad = (over: object) => validateSnapshot({ ...snap("echo"), ...over }, "echo.json").join("\n");
  assert.match(bad({ source: "web" }), /echo\.json: source/);
  assert.match(bad({ fetchedAt: "yesterday" }), /fetchedAt/);
  assert.match(bad({ tools: "x" }), /tools: must be a list/);
  assert.match(bad({ tools: [{ name: "a", inputSchema: {} }, { name: "a", inputSchema: {} }] }), /tools\[1\]\.name: duplicate/);
  assert.match(bad({ tools: [{ name: "a", description: 1, inputSchema: {} }] }), /tools\[0\]\.description/);
  assert.match(bad({ tools: [{ name: "a" }] }), /tools\[0\]\.inputSchema/);
  assert.deepEqual(validateSnapshot(snap("echo"), "echo.json"), []);
  assert.deepEqual(validateSnapshot([], "x.json"), ["x.json: (root): must be a JSON object"]);
});
