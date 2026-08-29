import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { Manifest } from "./types.js";

/** Load every *.yaml / *.yml manifest in a directory. Validates the fields the
 *  gateway actually depends on; anything malformed throws with the file name so
 *  a bad PR fails loudly rather than silently dropping a server. */
export function loadManifests(dir: string): Manifest[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  } catch {
    return []; // no servers/ dir yet — empty catalog, not an error
  }
  return files.map((f) => parseManifest(readFileSync(join(dir, f), "utf8"), f));
}

export function parseManifest(text: string, source: string): Manifest {
  const m = parse(text) as Partial<Manifest>;
  const bad = (why: string): never => {
    throw new Error(`invalid manifest ${source}: ${why}`);
  };
  if (!m || typeof m !== "object") bad("not a mapping");
  if (!m!.id) bad("missing id");
  if (!m!.name) bad("missing name");
  if (!m!.transport?.type) bad("missing transport.type");
  const t = m!.transport!;
  if (t.type === "stdio" && !t.command) bad("stdio transport needs command");
  if (t.type === "streamable-http" && !t.url) bad("streamable-http transport needs url");
  return {
    id: m!.id!,
    name: m!.name!,
    category: m!.category ?? [],
    description: m!.description ?? "",
    transport: t,
    auth: m!.auth ?? { type: "none" },
    routing: m!.routing ?? {},
  };
}
