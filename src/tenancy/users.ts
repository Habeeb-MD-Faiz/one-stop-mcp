// Team-mode identities (D16): users grouped into orgs, each holding bearer tokens
// for the gateway. Only SHA-256 hashes of tokens touch disk; the plaintext is
// shown once at issue time. The file is re-read whenever it changes on disk, so
// `one-stop-mcp user remove` from a terminal locks a user out of an already
// running gateway on their next request.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Principal } from "../contracts.js";

export interface TokenRecord {
  id: string;
  hash: string;
  createdAt: number;
  lastUsedAt?: number;
}

export interface UserRecord {
  id: string;
  org: string;
  admin: boolean;
  tokens: TokenRecord[];
}

/** A user as shown to operators: token ids and dates, never hashes. */
export type UserView = Omit<UserRecord, "tokens"> & { tokens: Omit<TokenRecord, "hash">[] };

// Ids end up in vault scope paths (`<org>/<user>/<server>`), so no separators, and
// a leading underscore is reserved for the gateway's own cells (`_gateway`, `_totp`).
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const TOKEN = /^osmcp_[A-Za-z0-9_-]{43}$/;
const TOUCH_EVERY_MS = 60_000; // lastUsedAt granularity; avoids a disk write per request

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export class UserStore {
  private users: UserRecord[] = [];
  private stamp = "";

  constructor(private path: string) {}

  add(id: string, org: string, admin = false): UserView {
    if (!ID.test(id)) throw new Error(`invalid user id "${id}" (letters, digits, . _ -; max 64; no leading _)`);
    if (!ID.test(org)) throw new Error(`invalid org "${org}" (letters, digits, . _ -; max 64; no leading _)`);
    const user: UserRecord = { id, org, admin, tokens: [] };
    this.mutate((users) => {
      if (users.some((u) => u.id === id)) throw new Error(`user ${id} already exists`);
      users.push(user);
    });
    return view(user);
  }

  remove(id: string): boolean {
    let found = false;
    this.mutate((users) => {
      const i = users.findIndex((u) => u.id === id);
      if ((found = i >= 0)) users.splice(i, 1);
    });
    return found;
  }

  get(id: string): UserView | undefined {
    const u = this.load().find((x) => x.id === id);
    return u && view(u);
  }

  list(): UserView[] {
    return this.load().map(view);
  }

  /** Issue a new bearer token. The plaintext is returned exactly once. */
  issueToken(userId: string): { id: string; token: string } {
    const token = `osmcp_${randomBytes(32).toString("base64url")}`;
    const rec: TokenRecord = { id: randomBytes(6).toString("hex"), hash: sha256(token), createdAt: Date.now() };
    this.mutate((users) => this.must(users, userId).tokens.push(rec));
    return { id: rec.id, token };
  }

  revokeToken(userId: string, tokenId: string): boolean {
    let found = false;
    this.mutate((users) => {
      const u = this.must(users, userId);
      const before = u.tokens.length;
      u.tokens = u.tokens.filter((t) => t.id !== tokenId);
      found = u.tokens.length < before;
    });
    return found;
  }

  /** Resolve a bearer token to its principal, or undefined. */
  authenticate(bearer: string | undefined): Principal | undefined {
    if (!bearer || !TOKEN.test(bearer)) return undefined;
    const hash = sha256(bearer);
    for (const u of this.load()) {
      const t = u.tokens.find((x) => x.hash === hash);
      if (!t) continue;
      const now = Date.now();
      if (!t.lastUsedAt || now - t.lastUsedAt > TOUCH_EVERY_MS) {
        // Re-applied to a fresh read, so a concurrent revoke is never undone.
        this.mutate((users) => {
          const fresh = users.find((x) => x.id === u.id)?.tokens.find((x) => x.hash === hash);
          if (fresh) fresh.lastUsedAt = now;
        });
      }
      return { user: u.id, org: u.org, admin: u.admin };
    }
    return undefined;
  }

  private must(users: UserRecord[], id: string): UserRecord {
    const u = users.find((x) => x.id === id);
    if (!u) throw new Error(`unknown user ${id}`);
    return u;
  }

  /** Re-read only when the file changed. Every write renames a new file into
   *  place, so the inode changes even when mtime resolution is coarse. */
  private load(): UserRecord[] {
    let st;
    try {
      st = statSync(this.path);
    } catch {
      this.users = [];
      this.stamp = "";
      return this.users;
    }
    const stamp = `${st.ino}:${st.mtimeMs}:${st.size}`;
    if (stamp !== this.stamp) {
      this.users = (JSON.parse(readFileSync(this.path, "utf8")) as { users: UserRecord[] }).users;
      this.stamp = stamp;
    }
    return this.users;
  }

  // ponytail: no cross-process lock — a mutation is applied to a fresh read and
  // renamed into place, so a CLI and a running gateway race only inside one
  // read-write window. Add a lockfile if concurrent admin writes become routine.
  private mutate(fn: (users: UserRecord[]) => void): void {
    this.stamp = ""; // force a fresh read
    const users = structuredClone(this.load());
    fn(users);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ users }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
    this.users = users;
    this.stamp = "";
  }
}

function view(u: UserRecord): UserView {
  return { id: u.id, org: u.org, admin: u.admin, tokens: u.tokens.map(({ hash: _hash, ...t }) => t) };
}
