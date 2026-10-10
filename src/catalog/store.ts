// On-disk tool snapshots (D25): find_tools reads these instead of spawning every
// server. Shipped snapshots (catalog/<id>.json) are read-only; a live refresh is
// written to the state dir and shadows the shipped one.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CatalogSnapshot, CatalogStore } from "../contracts.js";
import { ID_PATTERN } from "../manifest.js";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Every problem with a parsed snapshot, as `<source>: <field>: <why>` lines.
 *  Empty array = valid. `expectedServer` pins the id to the file it came from. */
export function validateSnapshot(raw: unknown, source: string, expectedServer?: string): string[] {
  const errors: string[] = [];
  const err = (field: string, why: string) => errors.push(`${source}: ${field}: ${why}`);
  if (!isObj(raw)) return [`${source}: (root): must be a JSON object`];
  if (typeof raw.server !== "string" || !ID_PATTERN.test(raw.server)) err("server", "must be a lowercase-kebab server id");
  else if (expectedServer !== undefined && raw.server !== expectedServer) err("server", `must equal the file name (${expectedServer})`);
  if (raw.source !== "live" && raw.source !== "docs") err("source", 'must be "live" or "docs"');
  if (typeof raw.fetchedAt !== "string" || Number.isNaN(Date.parse(raw.fetchedAt))) err("fetchedAt", "must be an ISO date string");
  if (!Array.isArray(raw.tools)) err("tools", "must be a list");
  else {
    const seen = new Set<string>();
    raw.tools.forEach((t, i) => {
      if (!isObj(t) || typeof t.name !== "string" || t.name === "") return err(`tools[${i}]`, "must be an object with a non-empty name");
      if (seen.has(t.name)) err(`tools[${i}].name`, `duplicate tool ${JSON.stringify(t.name)}`);
      seen.add(t.name);
      if (t.description !== undefined && typeof t.description !== "string") err(`tools[${i}].description`, "must be a string");
      if (!isObj(t.inputSchema)) err(`tools[${i}].inputSchema`, "must be a JSON Schema object (use {\"type\":\"object\"} when unknown)");
    });
  }
  return errors;
}

export class FileCatalogStore implements CatalogStore {
  private readonly shippedDir: string;
  private readonly stateDir?: string;

  constructor(opts: { shippedDir: string; stateDir?: string }) {
    if (opts.stateDir && resolve(opts.stateDir) === resolve(opts.shippedDir)) {
      throw new Error("FileCatalogStore: stateDir must differ from shippedDir (the shipped catalog is never written)");
    }
    this.shippedDir = opts.shippedDir;
    this.stateDir = opts.stateDir;
  }

  /** The state-dir snapshot if there is a readable one (a live refresh), else
   *  the shipped one. undefined when neither exists. A bad shipped file throws
   *  (CI should have caught it); a bad state file is ignored, since the next
   *  refresh rewrites it and discovery should not die on a half-broken cache. */
  load(server: string): CatalogSnapshot | undefined {
    if (!ID_PATTERN.test(server)) return undefined; // also keeps the id out of the path
    // ponytail: state wins even if the shipped snapshot is newer (after an upgrade); compare fetchedAt if that bites
    if (this.stateDir) {
      try {
        const live = this.read(this.stateDir, server);
        if (live) return live;
      } catch (e) {
        console.error(`catalog: ignoring unreadable state snapshot for ${server}, using the shipped one: ${(e as Error).message}`);
      }
    }
    return this.read(this.shippedDir, server);
  }

  /** Atomic (tmp + rename) write into the state dir. Never touches the shipped dir. */
  save(snapshot: CatalogSnapshot): void {
    if (!this.stateDir) throw new Error("FileCatalogStore: no stateDir configured; the shipped catalog is read-only");
    const errors = validateSnapshot(snapshot, "snapshot");
    if (errors.length) throw new Error(`refusing to save an invalid snapshot:\n  ${errors.join("\n  ")}`);
    mkdirSync(this.stateDir, { recursive: true });
    const file = join(this.stateDir, `${snapshot.server}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + "\n");
      renameSync(tmp, file);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }

  private read(dir: string, server: string): CatalogSnapshot | undefined {
    const file = join(dir, `${server}.json`);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new Error(`${file}: invalid JSON: ${(e as Error).message}`);
    }
    const errors = validateSnapshot(raw, file, server);
    if (errors.length) throw new Error(`invalid snapshot:\n  ${errors.join("\n  ")}`);
    return raw as CatalogSnapshot;
  }
}
