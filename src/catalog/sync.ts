// Registry sync worker (PDR §9 P3, D9). Two jobs, and neither touches the live
// catalog (servers/ or catalog/):
//   refreshSnapshots - re-capture tool lists through a caller-supplied refresher.
//   importCandidates - pull the official MCP Registry into servers/_candidates/
//                      as unreviewed draft manifests for a human to adopt or bin.
// Auto-ingest is a supply-chain risk for the component that holds every
// credential, so a candidate is only ever a file for review.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";

// --- snapshot refresh ----------------------------------------------------------

export interface RefreshResult {
  id: string;
  ok: boolean;
  error?: string;
}

/** Run `refresh(id)` for every id with at most `concurrency` in flight. Never
 *  rejects: a failing server is a result row, not an exception. Results are in
 *  the order of `ids`. */
export async function refreshSnapshots(ids: string[], refresh: (id: string) => Promise<void>, concurrency = 4): Promise<RefreshResult[]> {
  const out: RefreshResult[] = new Array(ids.length);
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const i = next++;
      try {
        await refresh(ids[i]);
        out[i] = { id: ids[i], ok: true };
      } catch (e) {
        out[i] = { id: ids[i], ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, Math.floor(concurrency)), ids.length) }, worker));
  return out;
}

// --- registry candidates -------------------------------------------------------

/** The slice of a registry `server.json` we read (registry.modelcontextprotocol.io,
 *  GET /v0.1/servers -> servers[].server). Everything is treated as untrusted. */
interface RegistryServer {
  name?: string;
  title?: string;
  description?: string;
  version?: string;
  websiteUrl?: string;
  repository?: { url?: string };
  remotes?: Array<{ type?: string; url?: string; headers?: Array<KeyValue> }>;
  packages?: Array<{ registryType?: string; identifier?: string; version?: string; transport?: { type?: string }; environmentVariables?: Array<KeyValue> }>;
}
interface KeyValue {
  name?: string;
  isSecret?: boolean;
  isRequired?: boolean;
}

export interface ImportOptions {
  registryUrl?: string;
  candidatesDir: string;
  /** Ids already in the live catalog; those are skipped. */
  existingIds: Iterable<string>;
  fetch?: typeof globalThis.fetch;
  /** Stop after writing this many candidates. */
  limit?: number;
  /** v0.1 is the registry's frozen API; v0 was the preview. */
  apiPath?: string;
}

export interface ImportResult {
  written: string[];
  skipped: Array<{ id: string; reason: string }>;
  scanned: number;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const oneLine = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim(); // registry text goes into YAML comments: no newlines
const NPM_ID = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;
const PYPI_ID = /^[a-z0-9][\w.-]*$/i;
const PKG_VERSION = /^[\w.+-]+$/;
const MAX_PAGES = 100; // ponytail: 100 pages x 100 = 10k servers per run; raise if the registry outgrows it

function httpUrl(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  try {
    return /^https?:$/.test(new URL(v).protocol) ? v : undefined;
  } catch {
    return undefined;
  }
}

function hints(kind: string, list: KeyValue[] | undefined): string[] {
  return (list ?? [])
    .filter((x) => typeof x?.name === "string" && (x.isSecret || x.isRequired))
    .map((x) => `${kind} ${oneLine(x.name)} (${[x.isSecret && "secret", x.isRequired && "required"].filter(Boolean).join(", ")})`);
}

/** Map one registry entry to a draft manifest, or say why it can't be one. The
 *  transport is the first streamable-http remote, else the first stdio npm
 *  (npx -y) or pypi (uvx) package; anything else (sse-only, oci, nuget...) is not
 *  something a manifest can express. Auth is never guessed: `none` + a TODO, with
 *  what the registry says about keys as comment hints. */
export function toCandidate(s: RegistryServer, registryUrl: string, today: string): { id: string; yaml: string } | { id: string; skip: string } {
  const regName = oneLine(s.name);
  const id = slug(regName);
  if (!id) return { id: "", skip: "no usable name" };

  let transport: Record<string, unknown> | undefined;
  let found: string[] = [];
  let todo = "";
  const remote = s.remotes?.find((r) => r?.type === "streamable-http" && httpUrl(r.url));
  if (remote) {
    transport = { type: "streamable-http", url: remote.url };
    found = hints("header", remote.headers);
    if (/[{}]/.test(remote.url!)) todo = "# TODO the url has {variables}; substitute a real value (the registry lists them under remotes[].variables)\n";
  } else {
    const pkg = s.packages?.find(
      (p) =>
        p?.transport?.type === "stdio" &&
        ((p.registryType === "npm" && NPM_ID.test(p.identifier ?? "")) || (p.registryType === "pypi" && PYPI_ID.test(p.identifier ?? ""))),
    );
    if (pkg) {
      const v = typeof pkg.version === "string" && PKG_VERSION.test(pkg.version) ? pkg.version : undefined;
      const spec = v ? `${pkg.identifier}@${v}` : pkg.identifier;
      transport = pkg.registryType === "npm" ? { type: "stdio", command: "npx", args: ["-y", spec] } : { type: "stdio", command: "uvx", args: [spec] };
      found = hints("env", pkg.environmentVariables);
      if (!v) todo = "# TODO pin an exact package version\n";
    }
  }
  if (!transport) return { id, skip: "no supported transport (need a streamable-http remote or a stdio npm/pypi package)" };

  const y = (o: object) => stringify(o, { lineWidth: 0 });
  const title = oneLine(s.title) || regName.split("/").pop()!;
  const homepage = httpUrl(s.websiteUrl) ?? httpUrl(s.repository?.url);
  const yaml = [
    `# UNREVIEWED CANDIDATE imported ${today} from ${oneLine(registryUrl)} (registry name ${regName}, version ${oneLine(s.version)}).`,
    `# Not part of the live catalog (D9): the gateway never loads this folder. To adopt it: resolve every TODO,`,
    `# move it to servers/<id>.yaml, add catalog/<id>.json, then run npm run validate.`,
    y({ id, name: title }),
    `# TODO review category (allowed values: CATEGORIES in src/manifest.ts)\n${y({ category: ["utility"] })}`,
    y({ description: oneLine(s.description) || title, ...(homepage && { homepage }) }),
    todo + y({ transport }),
    `# TODO review auth: the registry does not say how to authenticate, so this is "none" until someone checks.\n` +
      (found.length ? `# registry hints: ${found.join("; ")}\n` : "") +
      y({ auth: { type: "none" } }),
    `# TODO add 3-5 example utterances\n${y({ routing: { examples: [] } })}`,
    y({ health: { check: "initialize" } }),
  ].join("\n");
  return { id, yaml };
}

/** Page the official MCP Registry and write a draft manifest per new server to
 *  `candidatesDir/<id>.yaml`. Skips ids in the live catalog, candidates already
 *  on disk (a reviewer may have edited them), duplicates, deprecated entries and
 *  servers a manifest can't express. Never writes servers/ itself. */
// TODO(live): verified against the real registry only with Habeeb present; tests use an in-process fake of the documented response shape.
export async function importCandidates(opts: ImportOptions): Promise<ImportResult> {
  const registryUrl = (opts.registryUrl ?? "https://registry.modelcontextprotocol.io").replace(/\/+$/, "");
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const existing = new Set(opts.existingIds);
  const today = new Date().toISOString().slice(0, 10);
  const result: ImportResult = { written: [], skipped: [], scanned: 0 };
  const skip = (id: string, reason: string) => result.skipped.push({ id, reason });

  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(registryUrl + (opts.apiPath ?? "/v0.1/servers"));
    url.searchParams.set("limit", "100");
    url.searchParams.set("version", "latest");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetchFn(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`registry ${url.origin}: GET ${url.pathname} -> HTTP ${res.status}`);
    const body = (await res.json()) as { servers?: Array<{ server?: RegistryServer; _meta?: Record<string, { status?: string }> }>; metadata?: { nextCursor?: string; next_cursor?: string } };
    if (!Array.isArray(body?.servers)) throw new Error(`registry ${url.origin}: response has no servers[] (unexpected API shape)`);

    for (const entry of body.servers) {
      result.scanned++;
      const server = entry?.server;
      if (!server || typeof server !== "object") {
        skip("", "malformed entry");
        continue;
      }
      const status = entry._meta?.["io.modelcontextprotocol.registry/official"]?.status;
      const c = toCandidate(server, registryUrl, today);
      if (status && status !== "active") skip(c.id, `registry status ${status}`);
      else if ("skip" in c) skip(c.id, c.skip);
      else if (existing.has(c.id)) skip(c.id, "already in the catalog");
      else {
        mkdirSync(opts.candidatesDir, { recursive: true });
        try {
          writeFileSync(join(opts.candidatesDir, `${c.id}.yaml`), c.yaml, { flag: "wx" }); // wx: never overwrite a reviewed draft or a duplicate
          result.written.push(c.id);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
          skip(c.id, "candidate already exists");
        }
      }
      if (opts.limit !== undefined && result.written.length >= opts.limit) return result;
    }

    const next = body.metadata?.nextCursor ?? body.metadata?.next_cursor;
    if (!next || next === cursor) break;
    cursor = next;
  }
  return result;
}
