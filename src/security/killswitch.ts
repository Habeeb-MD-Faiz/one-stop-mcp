import { readFileSync } from "node:fs";
import { AccessDeniedError, type AccessGuard, type Ledger, type Principal, type SecretStore, type SessionControl } from "../contracts.js";
import { stampOf, writeAtomic } from "./files.js";

// The kill switch (PDR §5): REVOKE ALL cuts every live session, freezes the
// vault and blocks all outbound credential use in one action; scoped variants
// revoke one server or one user. After a lockdown, connectors come back one at
// a time (enableServer): the vault unfreezes but the guard keeps denying every
// server not yet re-enabled. Every action and every denial is ledgered.
//
// State is a small JSON file (D30) re-read whenever it changes, so
// `one-stop-mcp kill all` from a terminal bites inside a running gateway on its
// very next check - which also closes the sessions that state change affects.

export interface KillState {
  lockdown: boolean;
  /** Servers re-enabled during the lockdown. */
  reenabled: string[];
  revokedServers: string[];
  /** As "org/user". */
  revokedUsers: string[];
}

export interface KillOptions {
  statePath: string;
  store: SecretStore;
  ledger: Ledger;
}

const EMPTY: KillState = { lockdown: false, reenabled: [], revokedServers: [], revokedUsers: [] };
const userId = (user: string, org: string): string => `${org}/${user}`;
const add = (xs: string[], x: string): string[] => (xs.includes(x) ? xs : [...xs, x]);
const drop = (xs: string[], x: string): string[] => xs.filter((y) => y !== x);

export class KillSwitch implements AccessGuard {
  private state: KillState;
  private stamp: string;
  private sessions?: SessionControl;

  constructor(private o: KillOptions) {
    this.stamp = stampOf(o.statePath);
    this.state = this.read();
    this.applyFreeze(); // a gateway restarted mid-lockdown comes up locked
  }

  /** Wire the live sessions once the registry exists. */
  attachSessions(s: SessionControl): void {
    this.sessions = s;
  }

  /** Consulted before every outbound call. */
  check(p: Principal, server: string): void {
    this.refresh();
    const s = this.state;
    const reason =
      s.lockdown && !s.reenabled.includes(server) ? "lockdown: all outbound credential use is revoked"
      : this.o.store.isFrozen ? "vault is frozen"
      : s.revokedServers.includes(server) ? `server ${server} is revoked`
      : s.revokedUsers.includes(userId(p.user, p.org)) ? `user ${userId(p.user, p.org)} is revoked`
      : undefined;
    if (!reason) return;
    this.o.ledger.record({ ts: Date.now(), org: p.org, user: p.user, server, tool: "*", result: "denied", reason });
    throw new AccessDeniedError(reason);
  }

  status(): KillState & { frozen: boolean } {
    this.refresh();
    return { ...structuredClone(this.state), frozen: this.o.store.isFrozen };
  }

  /** Close every session, freeze the vault, deny every server. */
  revokeAll(by: string) {
    return this.change(by, "kill.revoke_all", "*", (s) => ({ ...s, lockdown: true, reenabled: [] }));
  }

  /** Lift a server's revocation; during a lockdown, re-enable just this one. */
  enableServer(id: string, by: string) {
    return this.change(by, "kill.enable_server", id, (s) => ({
      ...s,
      revokedServers: drop(s.revokedServers, id),
      reenabled: s.lockdown ? add(s.reenabled, id) : s.reenabled,
    }));
  }

  /** Back to normal: every server not individually revoked works again. */
  endLockdown(by: string) {
    return this.change(by, "kill.end_lockdown", "*", (s) => ({ ...s, lockdown: false, reenabled: [] }));
  }

  revokeServer(id: string, by: string) {
    return this.change(by, "kill.revoke_server", id, (s) => ({ ...s, revokedServers: add(s.revokedServers, id), reenabled: drop(s.reenabled, id) }));
  }

  revokeUser(user: string, org: string, by: string) {
    return this.change(by, "kill.revoke_user", "*", (s) => ({ ...s, revokedUsers: add(s.revokedUsers, userId(user, org)) }), userId(user, org));
  }

  enableUser(user: string, org: string, by: string) {
    return this.change(by, "kill.enable_user", "*", (s) => ({ ...s, revokedUsers: drop(s.revokedUsers, userId(user, org)) }), userId(user, org));
  }

  private async change(by: string, tool: string, server: string, edit: (s: KillState) => KillState, reason?: string): Promise<{ closedSessions: number }> {
    this.refresh(); // build on whatever another process last wrote
    const prev = this.state;
    const next = edit(prev);
    writeAtomic(this.o.statePath, JSON.stringify(next, null, 2));
    this.stamp = stampOf(this.o.statePath);
    this.state = next;
    this.applyFreeze();
    this.o.ledger.record({ ts: Date.now(), user: by, server, tool, result: "authorized", ...(reason && { reason }) });
    return { closedSessions: await this.cut(prev, next) };
  }

  /** Re-read the state file if it changed; apply the transition. */
  private refresh(): void {
    const stamp = stampOf(this.o.statePath);
    if (stamp === this.stamp) return;
    const prev = this.state;
    this.state = this.read();
    this.stamp = stamp;
    this.applyFreeze();
    this.cut(prev, this.state).catch(() => {}); // sessions are already unusable: check() denies first
  }

  private read(): KillState {
    let raw: string;
    try {
      raw = readFileSync(this.o.statePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY);
      throw err;
    }
    // A corrupt file throws here, so every check fails closed until it is fixed.
    return { ...structuredClone(EMPTY), ...(JSON.parse(raw) as Partial<KillState>) };
  }

  private applyFreeze(): void {
    if (this.state.lockdown && this.state.reenabled.length === 0) this.o.store.freeze();
    else this.o.store.unfreeze();
  }

  /** Close the sessions that lost access between two states. */
  private async cut(prev: KillState, next: KillState): Promise<number> {
    const s = this.sessions;
    if (!s) return 0;
    const jobs: Promise<number>[] = [];
    if (next.lockdown && !prev.lockdown) jobs.push(s.closeAll());
    else if (next.lockdown) for (const id of prev.reenabled) if (!next.reenabled.includes(id)) jobs.push(s.closeServer(id));
    for (const id of next.revokedServers) if (!prev.revokedServers.includes(id)) jobs.push(s.closeServer(id));
    for (const u of next.revokedUsers) {
      if (prev.revokedUsers.includes(u)) continue;
      const slash = u.indexOf("/");
      jobs.push(s.closeUser(u.slice(slash + 1), u.slice(0, slash)));
    }
    return (await Promise.all(jobs)).reduce((a, b) => a + b, 0);
  }
}
