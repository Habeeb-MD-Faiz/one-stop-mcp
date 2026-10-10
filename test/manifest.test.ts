// Manifest validator: one table of good and bad manifests, plus the loader
// (directory rules) and a check that schema/manifest.schema.json agrees with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { ALLOWED_KEYS, CATEGORIES, checkManifests, loadManifests, parseManifest, validateManifest } from "../src/manifest.js";

type M = Record<string, any>;
const base = (): M => ({
  id: "demo",
  name: "Demo",
  category: ["dev"],
  description: "A demo server.",
  transport: { type: "stdio", command: "npx", args: ["-y", "demo@1.0.0"] },
});
const http = (m: M) => (m.transport = { type: "streamable-http", url: "https://mcp.example.com/mcp" });
const SCHEMA = JSON.parse(readFileSync(new URL("../schema/manifest.schema.json", import.meta.url), "utf8"));
const PDR_EXAMPLE = `
id: notion
name: Notion
category: [productivity, docs, knowledge-base]
description: >
  Read, search, and write Notion pages, databases, comments.
transport:
  type: streamable-http
  url: https://mcp.notion.com/mcp
auth:
  type: oauth2
  scopes: [read_content, update_content]
routing:
  examples:
    - "find my meeting notes in notion"
health:
  check: initialize
`;

// [label, edit, expected error substring (undefined = valid), expressible in the JSON Schema?]
const cases: Array<[string, (m: M) => void, string | undefined, boolean?]> = [
  ["minimal stdio", () => {}, undefined],
  ["http, no auth", http, undefined],
  ["http api_key defaults header", (m) => (http(m), (m.auth = { type: "api_key", keyUrl: "https://example.com/keys" })), undefined],
  ["http api_key with header + empty prefix", (m) => (http(m), (m.auth = { type: "api_key", header: "X-Api-Key", prefix: "" })), undefined],
  ["http oauth2 discovery", (m) => (http(m), (m.auth = { type: "oauth2", scopes: ["read"] })), undefined],
  ["http oauth2 explicit endpoints", (m) => (http(m), (m.auth = { type: "oauth2", authorizationUrl: "https://a.example.com/auth", tokenUrl: "https://a.example.com/token", clientId: "abc" })), undefined],
  ["stdio api_key with env", (m) => (m.auth = { type: "api_key", env: "DEMO_KEY", rotation: "cloudflare" }), undefined],
  ["stdio oauth2 full", (m) => (m.auth = { type: "oauth2", env: "DEMO_TOKEN", authorizationUrl: "https://a.example.com/auth", tokenUrl: "https://a.example.com/token" }), undefined],
  ["everything optional present", (m) => Object.assign(m, { tags: ["official"], homepage: "https://example.com", health: { check: "tools/list" }, routing: { examples: ["do a demo"], tools: { go: ["go now"] } } }), undefined],

  ["missing name", (m) => delete m.name, "name: required"],
  ["blank description", (m) => (m.description = "  "), "description: must be a non-empty string"],
  ["id not kebab", (m) => (m.id = "My_Demo"), "id: must be lowercase-kebab"],
  ["id with double hyphen", (m) => (m.id = "a--b"), "id: must be lowercase-kebab"],
  ["id differs from file name", (m) => (m.id = "other"), "id: must equal the file name (demo)", false],
  ["no category", (m) => delete m.category, "category: required"],
  ["empty category", (m) => (m.category = []), "category: must be a non-empty list"],
  ["unknown category", (m) => (m.category = ["dev", "stuff"]), 'unknown category "stuff"'],
  ["duplicate category", (m) => (m.category = ["dev", "dev"]), 'duplicate "dev"'],
  ["typo'd top-level key", (m) => (m.tranport = {}), "tranport: unknown key"],

  ["no transport", (m) => delete m.transport, "transport: required"],
  ["bad transport type", (m) => (m.transport = { type: "sse", url: "https://x.example.com" }), 'transport.type: must be "stdio"'],
  ["stdio without command", (m) => delete m.transport.command, "stdio transport needs command"],
  ["stdio blank command", (m) => (m.transport.command = ""), "stdio transport needs command"],
  ["stdio with url", (m) => (m.transport.url = "https://x.example.com"), "transport.url: unknown key"],
  ["stdio args not strings", (m) => (m.transport.args = [1]), "transport.args: must be a list of strings"],
  ["stdio env not strings", (m) => (m.transport.env = { A: 1 }), "transport.env: must be a mapping of strings"],
  ["http without url", (m) => (http(m), delete m.transport.url), "streamable-http transport needs url"],
  ["http ftp url", (m) => (m.transport = { type: "streamable-http", url: "ftp://x.example.com" }), "streamable-http transport needs url"],
  ["http with command", (m) => (http(m), (m.transport.command = "x")), "transport.command: unknown key"],

  ["unknown auth type", (m) => (m.auth = { type: "basic" }), "auth.type: must be one of"],
  ["auth none with env", (m) => (m.auth = { type: "none", env: "X" }), "auth.env: not valid for auth.type none"],
  ["stdio api_key without env", (m) => (m.auth = { type: "api_key" }), "auth.env: api_key on a stdio transport needs env"],
  ["stdio api_key with header", (m) => (m.auth = { type: "api_key", env: "K", header: "X-Key" }), "auth.header: only valid on a streamable-http"],
  ["http api_key with env", (m) => (http(m), (m.auth = { type: "api_key", env: "K" })), "auth.env: only valid on a stdio"],
  ["stdio oauth2 without endpoints", (m) => (m.auth = { type: "oauth2" }), "auth.authorizationUrl: oauth2 on a stdio transport needs"],
  ["http oauth2 half the endpoints", (m) => (http(m), (m.auth = { type: "oauth2", tokenUrl: "https://a.example.com/token" })), "authorizationUrl and tokenUrl must be given together"],
  ["scopes on api_key", (m) => (m.auth = { type: "api_key", env: "K", scopes: ["x"] }), "auth.scopes: not valid for auth.type api_key"],
  ["keyUrl on oauth2", (m) => (http(m), (m.auth = { type: "oauth2", keyUrl: "https://x.example.com" })), "auth.keyUrl: not valid for auth.type oauth2"],
  ["bad env name", (m) => (m.auth = { type: "api_key", env: "1BAD" }), "auth.env: must be an environment variable name"],
  ["bad header name", (m) => (http(m), (m.auth = { type: "api_key", header: "Bad Header" })), "auth.header: must be an HTTP header name"],
  ["keyUrl not a url", (m) => (http(m), (m.auth = { type: "api_key", keyUrl: "not a url" })), "auth.keyUrl: must be an http(s) URL"],

  ["routing typo", (m) => (m.routing = { example: [] }), "routing.example: unknown key"],
  ["routing example not string", (m) => (m.routing = { examples: [1] }), "routing.examples: must be a list"],
  ["routing.tools value not a list", (m) => (m.routing = { tools: { go: "go now" } }), "routing.tools.go: must be a list"],
  ["bad health check", (m) => (m.health = { check: "ping" }), "health.check: must be one of"],
  ["health without check", (m) => (m.health = {}), "health.check: must be one of"],
  ["tags not strings", (m) => (m.tags = [1]), "tags: must be a list"],
  ["homepage not a url", (m) => (m.homepage = "example"), "homepage: must be an http(s) URL"],
];

test("validator: every case yields exactly the expected verdict, naming file and field", () => {
  for (const [label, edit, want] of cases) {
    const m = base();
    edit(m);
    const errors = validateManifest(m, "demo.yaml");
    if (want === undefined) assert.deepEqual(errors, [], `${label}: should be valid`);
    else {
      assert.ok(errors.some((e) => e.startsWith("demo.yaml: ") && e.includes(want)), `${label}: wanted "${want}", got ${JSON.stringify(errors)}`);
    }
  }
});

test("validator: non-mapping and yaml syntax errors are reported with the file name", () => {
  assert.deepEqual(validateManifest("just a string", "x.yaml"), ["x.yaml: (root): must be a YAML mapping"]);
  assert.throws(() => parseManifest("", "x.yaml"), /x\.yaml: \(root\): must be a YAML mapping/);
  assert.throws(() => parseManifest("id: [", "x.yaml"), /x\.yaml: yaml:/);
});

test("parseManifest: reports every problem at once, keeps the 'needs command' wording", () => {
  assert.throws(
    () => parseManifest("id: x\nname: X\ntransport:\n  type: stdio\n", "x.yaml"),
    (e: Error) => /needs command/.test(e.message) && /category: required/.test(e.message) && /description: required/.test(e.message) && /x\.yaml/.test(e.message),
  );
});

test("parseManifest: defaults auth/routing, keeps health, tags and homepage", () => {
  const bare = parseManifest(`id: demo\nname: Demo\ncategory: [dev]\ndescription: d\ntransport: {type: stdio, command: node}\n`, "demo.yaml");
  assert.deepEqual(bare.auth, { type: "none" });
  assert.deepEqual(bare.routing, {});
  const full = parseManifest(PDR_EXAMPLE, "notion.yaml");
  assert.deepEqual(full.health, { check: "initialize" });
  assert.deepEqual(full.auth, { type: "oauth2", scopes: ["read_content", "update_content"] });
  const tagged = parseManifest(`id: demo\nname: Demo\ncategory: [dev]\ndescription: d\ntags: [official]\nhomepage: https://e.com\ntransport: {type: stdio, command: node}\n`, "demo.yaml");
  assert.deepEqual([tagged.tags, tagged.homepage], [["official"], "https://e.com"]);
});

test("the PDR example manifest and the shipped echo manifest are valid", () => {
  assert.doesNotThrow(() => parseManifest(PDR_EXAMPLE, "notion.yaml"));
  const echo = readFileSync(new URL("../servers/echo.yaml", import.meta.url), "utf8");
  assert.equal(parseManifest(echo, "echo.yaml").id, "echo");
});

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "osmcp-manifest-"));
}
const yamlFor = (id: string) => `id: ${id}\nname: ${id}\ncategory: [dev]\ndescription: d\ntransport: {type: stdio, command: node}\n`;

test("loadManifests: reads yaml and yml, skips subdirectories such as _candidates, sorted", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "b.yaml"), yamlFor("b"));
    writeFileSync(join(dir, "a.yml"), yamlFor("a"));
    writeFileSync(join(dir, "notes.txt"), "ignored");
    mkdirSync(join(dir, "_candidates"));
    writeFileSync(join(dir, "_candidates", "c.yaml"), "not: a manifest");
    assert.deepEqual(loadManifests(dir).map((m) => m.id), ["a", "b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadManifests: a missing directory is an empty catalog", () => {
  assert.deepEqual(loadManifests(join(tmpdir(), "osmcp-does-not-exist")), []);
});

test("loadManifests: invalid files and duplicate ids throw, naming every offender", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "a.yaml"), yamlFor("a"));
    writeFileSync(join(dir, "a.yml"), yamlFor("a"));
    writeFileSync(join(dir, "bad.yaml"), yamlFor("bad").replace("[dev]", "[nope]"));
    assert.throws(() => loadManifests(dir), (e: Error) => /a\.yml: id: duplicate of a\.yaml/.test(e.message) && /bad\.yaml: category: unknown category "nope"/.test(e.message));
    const rows = checkManifests(dir);
    assert.deepEqual(rows.map((r) => [r.source, !!r.manifest]), [["a.yaml", true], ["a.yml", false], ["bad.yaml", false]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schema: property names and enums match the validator's", () => {
  const props = (o: any) => Object.keys(o.properties).sort();
  assert.deepEqual(props(SCHEMA), [...ALLOWED_KEYS.top].sort());
  assert.deepEqual(SCHEMA.properties.category.items.enum, [...CATEGORIES]);
  const [stdio, httpT] = SCHEMA.properties.transport.oneOf;
  assert.deepEqual(props(stdio), [...ALLOWED_KEYS.stdio].sort());
  assert.deepEqual(props(httpT), [...ALLOWED_KEYS.http].sort());
  const authKeys = new Set(Object.values(ALLOWED_KEYS.auth).flat());
  assert.deepEqual(props(SCHEMA.properties.auth), [...authKeys].sort());
  assert.deepEqual(props(SCHEMA.properties.routing), [...ALLOWED_KEYS.routing].sort());
  assert.deepEqual(props(SCHEMA.properties.health), [...ALLOWED_KEYS.health].sort());
});

test("schema: agrees with the validator on every case (ajv, when present)", async (t) => {
  let Ajv: any;
  try {
    const mod: any = await import("ajv/dist/2020.js"); // ponytail: ajv is the MCP SDK's own dependency; test skips if it ever goes away
    Ajv = mod.default?.default ?? mod.default;
  } catch {
    return t.skip("ajv not installed");
  }
  const ajv = new Ajv({ strict: false, allErrors: true });
  const validate = ajv.compile(SCHEMA);
  for (const [label, edit, want, inSchema = true] of cases) {
    if (!inSchema) continue;
    const m = base();
    edit(m);
    assert.equal(validate(m), want === undefined, `${label}: schema said ${validate(m)}, validator said ${want === undefined ? "valid" : "invalid"}`);
  }
  assert.equal(validate(parse(PDR_EXAMPLE)), true, "PDR example");
});
