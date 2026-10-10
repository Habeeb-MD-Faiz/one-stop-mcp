// In-memory stand-ins for the contracts other lanes implement, so the registry
// and broker are tested against the interfaces, not against L2/L4/L1 code.
import {
  AccessDeniedError,
  type AccessGuard,
  type CatalogSnapshot,
  type CatalogStore,
  type Discovery,
  type Ledger,
  type LedgerEntry,
  type LedgerInput,
  type Principal,
  type SecretKind,
  type SecretMeta,
  type SecretScope,
  type SecretStore,
} from "../../src/contracts.js";
import { LexicalRouter } from "../../src/routing/router.js";

const cell = (s: SecretScope) => `${s.org}\u0000${s.user}\u0000${s.server}`;

export class MemoryStore implements SecretStore {
  private cells = new Map<string, { value: unknown; meta: SecretMeta }>();
  isFrozen = false;
  async get<T>(scope: SecretScope): Promise<T | undefined> {
    this.thaw();
    const c = this.cells.get(cell(scope));
    return c && (structuredClone(c.value) as T);
  }
  async put(scope: SecretScope, secret: unknown, kind: SecretKind): Promise<void> {
    this.thaw();
    const now = Date.now();
    this.cells.set(cell(scope), { value: structuredClone(secret), meta: { scope, kind, createdAt: now, rotatedAt: now } });
  }
  async delete(scope: SecretScope): Promise<boolean> {
    return this.cells.delete(cell(scope));
  }
  async list(f: Partial<SecretScope> = {}): Promise<SecretMeta[]> {
    return [...this.cells.values()]
      .map((c) => c.meta)
      .filter((m) => (!f.org || m.scope.org === f.org) && (!f.user || m.scope.user === f.user) && (!f.server || m.scope.server === f.server));
  }
  freeze() {
    this.isFrozen = true;
  }
  unfreeze() {
    this.isFrozen = false;
  }
  private thaw() {
    if (this.isFrozen) throw new Error("vault is frozen");
  }
}

export class MemoryLedger implements Ledger {
  entries: LedgerEntry[] = [];
  record(e: LedgerInput): LedgerEntry {
    const entry = { ...e, org: e.org ?? "local" };
    this.entries.push(entry);
    return entry;
  }
  all() {
    return [...this.entries];
  }
  flagged() {
    return [];
  }
}

export class MemoryCatalog implements CatalogStore {
  snaps = new Map<string, CatalogSnapshot>();
  load(server: string) {
    return this.snaps.get(server);
  }
  save(s: CatalogSnapshot) {
    this.snaps.set(s.server, s);
  }
}

/** Denies any server/user listed in `revoked`. */
export class FakeGuard implements AccessGuard {
  revoked = new Set<string>();
  check(p: Principal, server: string) {
    if (this.revoked.has(server) || this.revoked.has(p.user)) throw new AccessDeniedError(`${server} revoked`);
  }
}

export const lexicalDiscovery: Discovery = {
  async discover(query, tools, k) {
    return { hits: await new LexicalRouter().rank(query, tools, k), confidence: "high", widened: false };
  },
};
