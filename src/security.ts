import type { Registry } from "./registry.js";
import type { UsageLedger } from "./ledger.js";
import type { Vault } from "./vault.js";

// The master kill switch, wiring the three security surfaces together: cut every
// live downstream session AND freeze the vault in one action, or scope it to a
// single server. Every action is written to the usage ledger so the record of
// "when did we pull the plug" is as auditable as the credential uses themselves.
//
// (brief §5: "REVOKE ALL — kills every session, freezes the vault, and blocks
//  all outbound credential use in one action. Also scoped: revoke a single
//  server, or every session for one user.")

const now = (): number => Date.now();

export class KillSwitch {
  constructor(
    private registry: Registry,
    private vault: Vault,
    private ledger: UsageLedger,
  ) {}

  /** Revoke everything: close all sessions, freeze the vault. Nothing outbound
   *  can authenticate until unfreeze(). */
  async revokeAll(by = "operator"): Promise<{ closedSessions: number }> {
    const closed = this.registry.runningServers().length;
    await this.registry.closeAll();
    this.vault.freeze();
    this.ledger.record({ ts: now(), user: by, server: "*", tool: "kill.revoke_all", result: "authorized" });
    return { closedSessions: closed };
  }

  /** Scoped: cut one server's session. The vault stays live for everything else. */
  async revokeServer(server: string, by = "operator"): Promise<{ wasRunning: boolean }> {
    const wasRunning = await this.registry.close(server);
    this.ledger.record({ ts: now(), user: by, server, tool: "kill.revoke_server", result: "authorized" });
    return { wasRunning };
  }

  /** Lift a full freeze so connectors can be re-enabled one at a time. */
  unfreeze(by = "operator"): void {
    this.vault.unfreeze();
    this.ledger.record({ ts: now(), user: by, server: "*", tool: "kill.unfreeze", result: "authorized" });
  }
}
