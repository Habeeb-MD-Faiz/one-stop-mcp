// Schema compression — the third context defense (brief §4.4). Before a
// downstream tool's schema is injected into a find_tools shortlist, strip the
// JSON-schema boilerplate a model doesn't need to pick or call the tool. The
// meaningful shape (types, properties, required, enums) is preserved; the
// scaffolding ($schema, titles, additionalProperties:false, …) is dropped.
//
// `aggressive` also drops descriptions — the token-heaviest part — which is
// Q5's knob: it saves the most but can cost tool-selection accuracy, so it's
// opt-in, not the default.

export type CompressLevel = "off" | "light" | "aggressive";

// Keys that are pure scaffolding for tool-selection purposes.
const BOILERPLATE = new Set(["$schema", "$id", "$ref", "title", "examples", "$comment"]);
// Keys whose value is a *map* of name -> schema.
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "definitions", "$defs"]);
// Keys whose value is a single schema.
const SCHEMA_ONE = new Set(["items", "additionalProperties", "not", "contains", "propertyNames"]);
// Keys whose value is an array of schemas.
const SCHEMA_LIST = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);

export function compressSchema(schema: unknown, level: CompressLevel = "light"): unknown {
  if (level === "off") return schema;
  return walk(schema, level === "aggressive");
}

function walk(node: unknown, aggressive: boolean): unknown {
  if (Array.isArray(node)) return node.map((n) => walk(n, aggressive));
  if (node === null || typeof node !== "object") return node;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (BOILERPLATE.has(k)) continue;
    if (k === "additionalProperties" && v === false) continue; // the common noise case
    if (aggressive && k === "description") continue;
    if (SCHEMA_MAPS.has(k) && v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = mapValues(v as Record<string, unknown>, (s) => walk(s, aggressive));
    } else if (SCHEMA_ONE.has(k)) {
      out[k] = walk(v, aggressive);
    } else if (SCHEMA_LIST.has(k) && Array.isArray(v)) {
      out[k] = v.map((s) => walk(s, aggressive));
    } else {
      out[k] = v;
    }
  }
  return out;
}

function mapValues(obj: Record<string, unknown>, fn: (v: unknown) => unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = fn(v);
  return out;
}

/** Rough token estimate for a serializable value (chars/4, the standard cheap
 *  heuristic). Enough to measure a compression ratio. */
export function estTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}
