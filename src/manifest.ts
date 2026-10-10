// Manifest loading + validation. Hand-rolled (no schema library): this is the CI
// source of truth and a contributor's first error message, so every error names
// the file and the field. schema/manifest.schema.json mirrors it for editor
// completion and test/manifest.test.ts keeps the two in step.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { Manifest } from "./types.js";

export const CATEGORIES = [
  "dev", "code", "data", "database", "productivity", "docs", "knowledge-base", "communication",
  "search", "web", "browser", "cloud", "infra", "ai", "memory", "crm", "sales", "marketing",
  "payments", "design", "testing", "utility",
] as const;

const AUTH_TYPES = ["none", "api_key", "oauth2"] as const;
const HEALTH_CHECKS = ["initialize", "tools/list", "none"] as const;

/** Every key a manifest may carry, per object. Unknown keys are errors (typos). */
export const ALLOWED_KEYS = {
  top: ["id", "name", "category", "description", "transport", "auth", "routing", "health", "tags", "homepage"],
  stdio: ["type", "command", "args", "env"],
  http: ["type", "url", "headers"],
  auth: {
    none: ["type"],
    api_key: ["type", "env", "header", "prefix", "keyUrl", "rotation"],
    oauth2: ["type", "scopes", "env", "header", "prefix", "authorizationUrl", "tokenUrl", "clientId"],
  },
  routing: ["examples", "tools"],
  health: ["check"],
} as const;

export const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const fileStem = (source: string) => /^(?:.*[\\/])?([^\\/]+)\.ya?ml$/.exec(source)?.[1];

function isHttpUrl(v: unknown): boolean {
  if (typeof v !== "string") return false;
  try {
    return /^https?:$/.test(new URL(v).protocol);
  } catch {
    return false;
  }
}

/** Every problem with a parsed manifest, as `<source>: <field>: <why>` lines.
 *  Empty array = valid. `source` is the file name; when it ends in .yaml/.yml the
 *  id must equal it. */
export function validateManifest(raw: unknown, source: string): string[] {
  const errors: string[] = [];
  const err = (field: string, why: string) => errors.push(`${source}: ${field}: ${why}`);
  if (!isObj(raw)) {
    err("(root)", "must be a YAML mapping");
    return errors;
  }

  const unknownKeys = (o: Obj, allowed: readonly string[], path: string) => {
    for (const k of Object.keys(o)) {
      if (!allowed.includes(k)) err(path ? `${path}.${k}` : k, `unknown key (allowed: ${allowed.join(", ")})`);
    }
  };
  const requireString = (k: string) => {
    if (raw[k] === undefined) err(k, "required");
    else if (!nonEmpty(raw[k])) err(k, "must be a non-empty string");
  };
  const stringList = (v: unknown, field: string) => {
    if (!Array.isArray(v) || !v.every(nonEmpty)) err(field, "must be a list of non-empty strings");
  };
  const stringMap = (v: unknown, field: string) => {
    if (!isObj(v) || !Object.values(v).every((x) => typeof x === "string")) err(field, "must be a mapping of strings");
  };

  unknownKeys(raw, ALLOWED_KEYS.top, "");

  // id, name, description, category
  requireString("id");
  if (nonEmpty(raw.id)) {
    if (!ID_PATTERN.test(raw.id)) err("id", "must be lowercase-kebab (a-z, 0-9, single hyphens)");
    const stem = fileStem(source);
    if (stem && stem !== raw.id) err("id", `must equal the file name (${stem})`);
  }
  requireString("name");
  requireString("description");
  if (raw.category === undefined) err("category", "required");
  else if (!Array.isArray(raw.category) || raw.category.length === 0) err("category", "must be a non-empty list");
  else {
    const seen = new Set<unknown>();
    for (const c of raw.category) {
      if (!(CATEGORIES as readonly unknown[]).includes(c)) err("category", `unknown category ${JSON.stringify(c)} (allowed: ${CATEGORIES.join(", ")})`);
      else if (seen.has(c)) err("category", `duplicate ${JSON.stringify(c)}`);
      seen.add(c);
    }
  }

  // transport
  let ttype: unknown;
  if (raw.transport === undefined) err("transport", "required");
  else if (!isObj(raw.transport)) err("transport", "must be a mapping");
  else {
    const t = raw.transport;
    ttype = t.type;
    if (t.type === "stdio") {
      unknownKeys(t, ALLOWED_KEYS.stdio, "transport");
      if (!nonEmpty(t.command)) err("transport.command", "stdio transport needs command (a non-empty string)");
      if (t.args !== undefined && !(Array.isArray(t.args) && t.args.every((a) => typeof a === "string"))) err("transport.args", "must be a list of strings");
      if (t.env !== undefined) stringMap(t.env, "transport.env");
    } else if (t.type === "streamable-http") {
      unknownKeys(t, ALLOWED_KEYS.http, "transport");
      if (!isHttpUrl(t.url)) err("transport.url", "streamable-http transport needs url (an http(s) URL)");
      if (t.headers !== undefined) stringMap(t.headers, "transport.headers");
    } else {
      err("transport.type", `must be "stdio" or "streamable-http"`);
    }
  }

  // auth
  if (raw.auth !== undefined) {
    const a = raw.auth;
    if (!isObj(a)) err("auth", "must be a mapping");
    else if (!(AUTH_TYPES as readonly unknown[]).includes(a.type)) err("auth.type", `must be one of ${AUTH_TYPES.join(", ")}`);
    else {
      const at = a.type as (typeof AUTH_TYPES)[number];
      const allowed: readonly string[] = ALLOWED_KEYS.auth[at];
      for (const k of Object.keys(a)) {
        if (!allowed.includes(k)) err(`auth.${k}`, `not valid for auth.type ${at} (allowed: ${allowed.join(", ")})`);
      }
      if (a.scopes !== undefined) stringList(a.scopes, "auth.scopes");
      if (a.env !== undefined && !(typeof a.env === "string" && ENV_NAME.test(a.env))) err("auth.env", "must be an environment variable name");
      if (a.header !== undefined && !(typeof a.header === "string" && HEADER_NAME.test(a.header))) err("auth.header", "must be an HTTP header name");
      if (a.prefix !== undefined && typeof a.prefix !== "string") err("auth.prefix", "must be a string");
      for (const k of ["keyUrl", "authorizationUrl", "tokenUrl"]) {
        if (a[k] !== undefined && !isHttpUrl(a[k])) err(`auth.${k}`, "must be an http(s) URL");
      }
      for (const k of ["rotation", "clientId"]) {
        if (a[k] !== undefined && !nonEmpty(a[k])) err(`auth.${k}`, "must be a non-empty string");
      }
      if (ttype === "streamable-http" && a.env !== undefined) err("auth.env", "only valid on a stdio transport (use header on streamable-http)");
      if (ttype === "stdio") {
        for (const k of ["header", "prefix"]) if (a[k] !== undefined) err(`auth.${k}`, "only valid on a streamable-http transport (use env on stdio)");
        if (at === "api_key" && a.env === undefined) err("auth.env", "api_key on a stdio transport needs env (the variable the key is injected into)");
        if (at === "oauth2") {
          for (const k of ["env", "authorizationUrl", "tokenUrl"]) {
            if (a[k] === undefined) err(`auth.${k}`, "oauth2 on a stdio transport needs env, authorizationUrl and tokenUrl (stdio servers do no MCP auth discovery)");
          }
        }
      } else if (at === "oauth2" && (a.authorizationUrl === undefined) !== (a.tokenUrl === undefined)) {
        err("auth.authorizationUrl", "authorizationUrl and tokenUrl must be given together");
      }
    }
  }

  // routing
  if (raw.routing !== undefined) {
    const r = raw.routing;
    if (!isObj(r)) err("routing", "must be a mapping");
    else {
      unknownKeys(r, ALLOWED_KEYS.routing, "routing");
      if (r.examples !== undefined) stringList(r.examples, "routing.examples");
      if (r.tools !== undefined) {
        if (!isObj(r.tools)) err("routing.tools", "must be a mapping of tool name to a list of utterances");
        else for (const [tool, u] of Object.entries(r.tools)) stringList(u, `routing.tools.${tool}`);
      }
    }
  }

  // health, tags, homepage
  if (raw.health !== undefined) {
    const h = raw.health;
    if (!isObj(h)) err("health", "must be a mapping");
    else {
      unknownKeys(h, ALLOWED_KEYS.health, "health");
      if (!(HEALTH_CHECKS as readonly unknown[]).includes(h.check)) err("health.check", `must be one of ${HEALTH_CHECKS.join(", ")}`);
    }
  }
  if (raw.tags !== undefined) stringList(raw.tags, "tags");
  if (raw.homepage !== undefined && !isHttpUrl(raw.homepage)) err("homepage", "must be an http(s) URL");

  return errors;
}

const failure = (errors: string[]) => new Error(`invalid manifest:\n${errors.map((e) => `  ${e}`).join("\n")}`);

/** Parse + validate one manifest; reports every problem, not just the first. */
function check(text: string, source: string): { manifest?: Manifest; errors: string[] } {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    return { errors: [`${source}: yaml: ${(e as Error).message.split("\n")[0]}`] };
  }
  const errors = validateManifest(raw, source);
  if (errors.length) return { errors };
  const { auth = { type: "none" }, routing = {}, ...rest } = raw as unknown as Manifest;
  return { manifest: { ...rest, auth, routing } as Manifest, errors };
}

export function parseManifest(text: string, source: string): Manifest {
  const { manifest, errors } = check(text, source);
  if (!manifest) throw failure(errors);
  return manifest;
}

export interface ManifestFile {
  source: string;
  manifest?: Manifest;
  errors: string[];
}

/** Check every *.yaml / *.yml directly in `dir` (subdirectories such as
 *  _candidates/ are not part of the catalog) without throwing on bad content:
 *  one row per file, a duplicate id reported on the later file. A missing dir is
 *  an empty catalog. */
export function checkManifests(dir: string): ManifestFile[] {
  let files: string[];
  try {
    files = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.ya?ml$/.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const ids = new Map<string, string>();
  return files.map((source) => {
    const row: ManifestFile = { source, ...check(readFileSync(join(dir, source), "utf8"), source) };
    const first = row.manifest && ids.get(row.manifest.id);
    if (first) {
      row.errors.push(`${source}: id: duplicate of ${first}`);
      delete row.manifest;
    } else if (row.manifest) ids.set(row.manifest.id, source);
    return row;
  });
}

/** Load every manifest in a directory; any invalid file or duplicate id throws
 *  with all problems listed, so a bad PR fails loudly rather than silently
 *  dropping a server. */
export function loadManifests(dir: string): Manifest[] {
  const rows = checkManifests(dir);
  const errors = rows.flatMap((r) => r.errors);
  if (errors.length) throw failure(errors);
  return rows.map((r) => r.manifest!);
}
