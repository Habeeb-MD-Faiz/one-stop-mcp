import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import type { Ledger, LedgerEntry, LedgerFilter, LedgerInput } from "../contracts.js";
import { writeOnce } from "./files.js";

// Usage ledger - every time a credential leaves the vault, and every admin
// action, is logged: who, which server, which tool, when, the result. This is
// what makes centralizing secrets defensible (PDR §5): total visibility, and
// bulk/anomalous access surfaced rather than silently trusted.
//
// Tamper evidence (D19): append-only JSONL; each entry carries seq, the previous
// entry's hash, its own SHA-256 over canonical JSON, and an Ed25519 signature of
// that hash, so `verifyLedger` needs only the public key. A chain cannot show a
// truncated tail by itself - anchor the last hash elsewhere if that matters.
//
// Anomaly flags (D11): rules first - burst per (user, server, tool), bulk-shaped
// tools at a lower threshold, denied-rate per user - plus a per-server EWMA of
// calls/minute that flags z > 3 once it has warmed up.

export interface LedgerOptions {
  /** JSONL file. Absent = in memory only. */
  path?: string;
  /** Ed25519 private key PEM (0600, created on first use, public key beside it
   *  as `.pub`). Default `<path>.key`; ephemeral when there is no path. */
  signingKeyPath?: string;
  /** Calls per (user, server, tool) per window before flagging. Default 100. */
  burstMax?: number;
  /** Same, for export/dump/download/bulk/list_all/backup-shaped tools. Default 20. */
  bulkMax?: number;
  /** Denied calls per user per window before flagging. Default 10. */
  deniedMax?: number;
  /** Default 60 s. */
  windowMs?: number;
  /** Per-server calls/minute baseline. Defaults: alpha 0.1, z 3, warm-up 10 minutes. */
  baseline?: { alpha?: number; z?: number; warmupMinutes?: number };
}

export interface LedgerVerification {
  ok: boolean;
  entries: number;
  /** seq (line index) of the first bad entry. */
  brokenAt?: number;
  reason?: string;
}

const GENESIS = "0".repeat(64);
const BULK = /export|dump|download|bulk|list_all|backup/i;
const MINUTE = 60_000;

/** SHA-256 over the entry minus hash/sig, keys sorted (entries are flat). */
export function hashEntry(e: LedgerEntry): string {
  const { hash: _h, sig: _s, ...rest } = e;
  return createHash("sha256").update(JSON.stringify(rest, Object.keys(rest).sort())).digest("hex");
}

/** Check seq, chain and every signature of a ledger file with the public key alone. */
export function verifyLedger(path: string, publicKeyPem: string): LedgerVerification {
  const key = createPublicKey(publicKeyPem);
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l.trim()) : [];
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    const bad = (reason: string): LedgerVerification => ({ ok: false, entries: lines.length, brokenAt: i, reason });
    let e: LedgerEntry;
    try {
      e = JSON.parse(lines[i]);
    } catch {
      return bad("unparseable line");
    }
    if (e.seq !== i) return bad("sequence gap");
    if (e.prev !== prev) return bad("chain broken: prev does not match the previous hash");
    if (e.hash !== hashEntry(e)) return bad("hash mismatch: entry was altered");
    if (!e.sig || !verify(null, Buffer.from(e.hash, "hex"), key, Buffer.from(e.sig, "base64"))) return bad("bad signature");
    prev = e.hash;
  }
  return { ok: true, entries: lines.length };
}

function loadSigningKey(path?: string): KeyObject {
  if (!path) return generateKeyPairSync("ed25519").privateKey;
  if (!existsSync(path)) {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    if (writeOnce(path, privateKey.export({ type: "pkcs8", format: "pem" }))) {
      writeFileSync(`${path}.pub`, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644 });
    }
  }
  return createPrivateKey(readFileSync(path));
}

interface Rate {
  minute: number;
  count: number;
  mean: number;
  var: number;
  n: number;
}

/** ponytail: whole ledger held in memory; window or rotate the file past ~1M entries.
 *  ponytail: no file lock across processes - a CLI append is picked up by size
 *  change before our next write, but two appends in the same instant can fork the chain. */
export class UsageLedger implements Ledger {
  readonly publicKeyPem: string;
  private entries: LedgerEntry[] = [];
  private last = GENESIS;
  private size = 0;
  private rates = new Map<string, Rate>();
  private key: KeyObject;
  private path?: string;
  private burstMax: number;
  private bulkMax: number;
  private deniedMax: number;
  private windowMs: number;
  private alpha: number;
  private zMax: number;
  private warmup: number;

  constructor(opts: LedgerOptions = {}) {
    this.path = opts.path;
    this.burstMax = opts.burstMax ?? 100;
    this.bulkMax = opts.bulkMax ?? 20;
    this.deniedMax = opts.deniedMax ?? 10;
    this.windowMs = opts.windowMs ?? 60_000;
    this.alpha = opts.baseline?.alpha ?? 0.1;
    this.zMax = opts.baseline?.z ?? 3;
    this.warmup = opts.baseline?.warmupMinutes ?? 10;
    this.key = loadSigningKey(opts.signingKeyPath ?? (opts.path && `${opts.path}.key`));
    this.publicKeyPem = createPublicKey(this.key).export({ type: "spki", format: "pem" }).toString();
    this.sync();
  }

  /** Record one call or admin action. `flagged` + `reason` are set when a rule or the baseline trips. */
  record(e: LedgerInput): LedgerEntry {
    this.sync();
    const base = { ts: e.ts, org: e.org ?? "local", user: e.user, server: e.server, tool: e.tool, result: e.result };
    const flags = this.detect(base);
    const reason = [e.reason, ...flags].filter(Boolean).join("; ");
    const entry: LedgerEntry = {
      ...base,
      ...(reason && { reason }),
      ...(flags.length > 0 && { flagged: true }),
      seq: this.entries.length,
      prev: this.last,
    };
    entry.hash = hashEntry(entry);
    entry.sig = sign(null, Buffer.from(entry.hash, "hex"), this.key).toString("base64");
    if (this.path) {
      // Disk first: an entry that failed to persist is never in the chain.
      const line = `${JSON.stringify(entry)}\n`;
      appendFileSync(this.path, line, { mode: 0o600 });
      this.size += Buffer.byteLength(line);
    }
    this.entries.push(entry);
    this.last = entry.hash;
    return entry;
  }

  all(filter: LedgerFilter = {}): LedgerEntry[] {
    this.sync();
    return this.entries.filter((e) =>
      (filter.org === undefined || e.org === filter.org) &&
      (filter.user === undefined || e.user === filter.user) &&
      (filter.server === undefined || e.server === filter.server) &&
      (filter.tool === undefined || e.tool === filter.tool) &&
      (filter.result === undefined || e.result === filter.result) &&
      (filter.since === undefined || e.ts >= filter.since),
    );
  }

  /** Everything the ledger has flagged as anomalous. */
  flagged(): LedgerEntry[] {
    this.sync();
    return this.entries.filter((e) => e.flagged);
  }

  private detect(e: Omit<LedgerEntry, "org"> & { org: string }): string[] {
    let same = 0;
    let denied = 0;
    // ponytail: scans back until the window ends, assuming roughly time-ordered entries.
    for (let i = this.entries.length - 1; i >= 0 && this.entries[i].ts >= e.ts - this.windowMs; i--) {
      const x = this.entries[i];
      if (x.user !== e.user || x.org !== e.org) continue;
      if (x.server === e.server && x.tool === e.tool) same++;
      if (x.result === "denied") denied++;
    }
    const secs = Math.round(this.windowMs / 1000);
    const flags: string[] = [];
    if (same + 1 > this.burstMax) flags.push(`burst: ${same + 1} calls to ${e.server}/${e.tool} in ${secs}s`);
    else if (BULK.test(e.tool) && same + 1 > this.bulkMax) flags.push(`bulk-shaped tool at volume: ${same + 1} calls to ${e.server}/${e.tool} in ${secs}s`);
    if (e.result === "denied" && denied + 1 > this.deniedMax) flags.push(`denied rate: ${denied + 1} denied calls for ${e.org}/${e.user} in ${secs}s`);
    const z = this.observe(e);
    if (z > this.zMax) {
      const r = this.rates.get(e.server)!;
      flags.push(`rate above baseline: ${r.count}/min on ${e.server} vs ~${r.mean.toFixed(1)}/min (z=${z.toFixed(1)})`);
    }
    return flags;
  }

  /** Count the call into its server's current minute; z-score of that minute so far (0 while warming up). */
  private observe(e: { ts: number; server: string }): number {
    const minute = Math.floor(e.ts / MINUTE);
    let r = this.rates.get(e.server);
    if (!r) this.rates.set(e.server, (r = { minute, count: 0, mean: 0, var: 0, n: 0 }));
    if (minute > r.minute) {
      this.fold(r, r.count);
      // Idle minutes count as zeros; after an hour the old mean has decayed away anyway.
      for (let i = 1; i < Math.min(minute - r.minute, 60); i++) this.fold(r, 0);
      r.minute = minute;
      r.count = 0;
    }
    r.count++; // ponytail: an out-of-order (older) ts is counted in the current minute
    if (r.n < this.warmup) return 0;
    // Floor the spread at Poisson noise so a perfectly steady rate doesn't flag +1.
    return (r.count - r.mean) / Math.max(Math.sqrt(r.var), Math.sqrt(r.mean), 1);
  }

  private fold(r: Rate, x: number): void {
    if (r.n++ === 0) {
      r.mean = x;
      return;
    }
    const d = x - r.mean;
    const inc = this.alpha * d;
    r.mean += inc;
    r.var = (1 - this.alpha) * (r.var + d * inc);
  }

  /** Pick up lines appended since we last looked (start-up, or another process). */
  private sync(): void {
    if (!this.path) return;
    const size = statSync(this.path, { throwIfNoEntry: false })?.size ?? 0;
    if (size === this.size) return;
    if (size < this.size) {
      // Shrunk under us: rebuild from scratch; verifyLedger will say what happened.
      this.entries = [];
      this.last = GENESIS;
      this.size = 0;
      this.rates.clear();
    }
    const buf = Buffer.alloc(size - this.size);
    const fd = openSync(this.path, "r");
    try {
      readSync(fd, buf, 0, buf.length, this.size);
    } finally {
      closeSync(fd);
    }
    const end = buf.lastIndexOf(0x0a) + 1; // a half-written last line waits for the next sync
    for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      let e: LedgerEntry;
      try {
        e = JSON.parse(line);
      } catch {
        throw new Error(`ledger ${this.path}: entry ${this.entries.length} is corrupt - run ledger verify`);
      }
      this.entries.push(e);
      this.last = e.hash ?? this.last;
      this.observe(e);
    }
    this.size += end;
  }
}
