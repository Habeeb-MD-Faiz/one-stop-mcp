import { test } from "node:test";
import assert from "node:assert/strict";
import { compressSchema, estTokens } from "../src/compress.js";

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
