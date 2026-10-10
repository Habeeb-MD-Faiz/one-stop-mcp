// Whole-catalog checks behind `npm run validate` (PDR §9 P5, manifest CI): every
// manifest valid and unique, every manifest backed by a non-empty tool snapshot,
// every per-tool routing utterance and every bench gold tool pointing at a tool
// that really exists. Pure function over a repo root so tests can use fixtures.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkManifests } from "../manifest.js";
import { validateSnapshot } from "./store.js";

export interface ServerRow {
  id: string;
  transport: string;
  auth: string;
  /** Tools in the snapshot; undefined when there is no usable snapshot. */
  tools?: number;
  /** Bench queries checked; undefined when the server has no bench file. */
  bench?: number;
  errors: string[];
}

export interface CatalogReport {
  rows: ServerRow[];
  errors: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `root` holds servers/, catalog/ and (optionally) bench/seed/. */
export function validateCatalog(root: string): CatalogReport {
  const rows: ServerRow[] = checkManifests(join(root, "servers")).map(({ source, manifest, errors }) => {
    const row: ServerRow = { id: manifest?.id ?? source.replace(/\.ya?ml$/, ""), transport: manifest?.transport.type ?? "?", auth: manifest?.auth?.type ?? "?", errors };
    if (!manifest) return row;

    // snapshot
    const snapFile = `catalog/${manifest.id}.json`;
    const snapPath = join(root, snapFile);
    if (!existsSync(snapPath)) {
      errors.push(`${snapFile}: missing (every manifest needs a tool snapshot)`);
      return row;
    }
    let snap: unknown;
    try {
      snap = JSON.parse(readFileSync(snapPath, "utf8"));
    } catch (e) {
      errors.push(`${snapFile}: invalid JSON: ${(e as Error).message}`);
      return row;
    }
    const snapErrors = validateSnapshot(snap, snapFile, manifest.id);
    errors.push(...snapErrors);
    if (snapErrors.length) return row;
    const tools = new Set((snap as { tools: Array<{ name: string }> }).tools.map((t) => t.name));
    row.tools = tools.size;
    if (tools.size === 0) errors.push(`${snapFile}: tools: empty (a snapshot with no tools can never be routed to)`);

    // per-tool routing utterances must name real tools
    for (const tool of Object.keys(manifest.routing?.tools ?? {})) {
      if (!tools.has(tool)) errors.push(`${source}: routing.tools.${tool}: no such tool in ${snapFile}`);
    }

    // bench gold tools
    const benchFile = `bench/seed/${manifest.id}.jsonl`;
    const benchPath = join(root, benchFile);
    if (existsSync(benchPath)) {
      row.bench = 0;
      readFileSync(benchPath, "utf8").split(/\r?\n/).forEach((line, i) => {
        if (!line.trim()) return;
        row.bench!++;
        const where = `${benchFile}:${i + 1}`;
        let q: unknown;
        try {
          q = JSON.parse(line);
        } catch (e) {
          return void errors.push(`${where}: invalid JSON: ${(e as Error).message}`);
        }
        if (!isObj(q) || typeof q.query !== "string" || !q.query.trim()) return void errors.push(`${where}: query: must be a non-empty string`);
        if (q.server !== undefined && q.server !== manifest.id) errors.push(`${where}: server: ${JSON.stringify(q.server)} is not ${manifest.id}`);
        if (typeof q.tool !== "string" || !tools.has(q.tool)) errors.push(`${where}: tool: ${JSON.stringify(q.tool)} is not in ${snapFile}`);
      });
    }
    return row;
  });
  return { rows, errors: rows.flatMap((r) => r.errors) };
}
