// Usage ledger — every time a credential leaves the vault, it's logged: which
// user, which server, which tool, when, and the result. This is what makes
// centralizing secrets defensible: total visibility, and bulk/anomalous access
// surfaced rather than silently trusted (brief §5).

export interface LedgerEntry {
  ts: number;
  user: string;
  server: string;
  tool: string;
  result: "authorized" | "denied" | "error";
  /** Set when this call tripped the bulk-access threshold. */
  flagged?: boolean;
}

export interface LedgerOptions {
  /** Flag when the same (user, server, tool) is called more than `burstMax`
   *  times within `windowMs`. Defaults: 100 calls / 60s. */
  burstMax?: number;
  windowMs?: number;
}

export class UsageLedger {
  private entries: LedgerEntry[] = [];
  private burstMax: number;
  private windowMs: number;

  constructor(opts: LedgerOptions = {}) {
    this.burstMax = opts.burstMax ?? 100;
    this.windowMs = opts.windowMs ?? 60_000;
  }

  /** Record a credential use. Returns the entry, with `flagged` set if this call
   *  pushed the (user, server, tool) key past the burst threshold in-window. */
  record(e: Omit<LedgerEntry, "flagged">): LedgerEntry {
    const recent = this.entries.filter(
      (x) => x.user === e.user && x.server === e.server && x.tool === e.tool && e.ts - x.ts <= this.windowMs,
    ).length;
    const entry: LedgerEntry = { ...e, flagged: recent + 1 > this.burstMax };
    this.entries.push(entry);
    return entry;
  }

  all(filter?: Partial<Pick<LedgerEntry, "user" | "server" | "tool" | "result">>): LedgerEntry[] {
    if (!filter) return [...this.entries];
    return this.entries.filter((e) =>
      (filter.user === undefined || e.user === filter.user) &&
      (filter.server === undefined || e.server === filter.server) &&
      (filter.tool === undefined || e.tool === filter.tool) &&
      (filter.result === undefined || e.result === filter.result),
    );
  }

  /** Everything the ledger has flagged as anomalous bulk access. */
  flagged(): LedgerEntry[] {
    return this.entries.filter((e) => e.flagged);
  }
}
