import { test } from "node:test";
import assert from "node:assert/strict";
import { compressSchema, estTokens } from "../src/routing/compress.js";

// A realistically verbose downstream tool schema — the kind that bloats context.
const verbose = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "CreateIssueInput",
  type: "object",
  additionalProperties: false,
  properties: {
    repo: { type: "string", title: "Repository", description: "owner/name of the repo." },
    title: { type: "string", description: "Issue title." },
    labels: { type: "array", items: { type: "string", title: "Label" }, additionalProperties: false },
    priority: { type: "string", enum: ["low", "med", "high"], description: "Triage priority." },
  },
  required: ["repo", "title"],
  examples: [{ repo: "a/b", title: "bug" }],
};

test("light compression drops boilerplate but preserves the schema's shape", () => {
  const c = compressSchema(verbose, "light") as any;
  assert.equal(c.$schema, undefined);
  assert.equal(c.title, undefined);
  assert.equal(c.examples, undefined);
  assert.equal("additionalProperties" in c, false, "additionalProperties:false is noise");
  // shape a caller needs is intact
  assert.equal(c.type, "object");
  assert.deepEqual(c.required, ["repo", "title"]);
  assert.deepEqual(c.properties.priority.enum, ["low", "med", "high"]);
  assert.equal(c.properties.repo.type, "string");
  assert.equal(c.properties.repo.title, undefined, "nested boilerplate stripped too");
  assert.equal(c.properties.repo.description, "owner/name of the repo.", "descriptions kept in light mode");
  assert.equal(c.properties.labels.items.type, "string", "recurses into items");
});

test("aggressive compression also drops descriptions and saves more tokens", () => {
  const light = compressSchema(verbose, "light");
  const aggressive = compressSchema(verbose, "aggressive") as any;
  assert.equal(aggressive.properties.repo.description, undefined);
  assert.ok(estTokens(aggressive) < estTokens(light), "aggressive is smaller than light");
});

test("compression measurably shrinks the schema", () => {
  const before = estTokens(verbose);
  const after = estTokens(compressSchema(verbose, "light"));
  assert.ok(after < before, `expected reduction, got ${before} -> ${after}`);
});

test("off returns the schema untouched", () => {
  assert.deepEqual(compressSchema(verbose, "off"), verbose);
});

// D8: aggressive may only cut prose. Selection and argument construction depend on
// every type, required list, enum and property name, so all of them must survive,
// including properties literally named like the keywords being stripped.
test("aggressive keeps every type, required, enum, property name and $ref", () => {
  const schema = {
    type: "object",
    description: "drop me",
    properties: {
      description: { type: "string", description: "a property named description" },
      title: { type: "string", title: "a property named title" },
      mode: { anyOf: [{ type: "string", enum: ["a", "b"], description: "x" }, { type: "null" }] },
      tags: { type: "array", items: { type: "object", properties: { examples: { type: "integer" } }, required: ["examples"] } },
      owner: { $ref: "#/$defs/User" },
    },
    required: ["description", "title"],
    $defs: { User: { type: "object", properties: { login: { type: "string" } }, required: ["login"] } },
  };
  const c = compressSchema(schema, "aggressive") as any;
  const skeleton = (s: any): any =>
    s === null || typeof s !== "object"
      ? s
      : Array.isArray(s)
        ? s.map(skeleton)
        : Object.fromEntries(Object.entries(s).filter(([k]) => k !== "description" && k !== "title").map(([k, v]) => [k, k === "properties" || k === "$defs" ? Object.fromEntries(Object.entries(v as object).map(([p, ps]) => [p, skeleton(ps)])) : skeleton(v)]));
  assert.deepEqual(c, skeleton(schema), "only description/title keywords removed");
  assert.deepEqual(Object.keys(c.properties), ["description", "title", "mode", "tags", "owner"]);
  assert.equal(c.properties.owner.$ref, "#/$defs/User");
  assert.deepEqual(c.properties.mode.anyOf[0].enum, ["a", "b"]);
  assert.deepEqual(c.properties.tags.items.required, ["examples"]);
});
