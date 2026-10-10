import type { AuthBroker, Ledger, LedgerEntry, RotationOutcome, SecretMeta, SecretScope, SecretStore } from "../contracts.js";
import type { Manifest } from "../types.js";
import type { KillSwitch } from "./killswitch.js";
import { scrub } from "./redact.js";
import { scopeId } from "./vault.js";

// Credential rotation (PDR §5, D10): one, a group, or all; on demand or on a
// schedule (90-day default policy). OAuth rotates fully automatically with a
// refresh-token grant. API keys rotate through a provider adapter where the
// provider has a key-management API (Cloudflare first), otherwise by a guided
// re-issue: a fresh key-entry URL for the user. `incident` is the "after a
// scare" flow: lock everything down, find what was exposed, rotate it.
// OAuth client registrations and TOTP seeds (kind "client") are not rotated here.

export interface ApiKeyRotator {
  /** Issue a replacement for `current` (the stored secret) and return the value to store. */
  rotate(current: unknown, scope: SecretScope): Promise<unknown>;
}

export interface RotationOptions {
  store: SecretStore;
  ledger: Ledger;
  broker: Pick<AuthBroker, "refresh" | "keyEntryUrl">;
  manifest: (id: string) => Manifest | undefined;
  /** By manifest `auth.rotation` id. Default: { cloudflare }. */
  adapters?: Record<string, ApiKeyRotator>;
  /** Rotation policy age. Default 90. */
  days?: number;
  /** Needed by incident(). */
  kill?: Pick<KillSwitch, "revokeAll">;
}

export interface RotationGroup {
  server?: string;
  category?: string;
  org?: string;
  user?: string;
}

export interface IncidentReport {
  at: number;
  by: string;
  closedSessions: number;
  /** Flagged entries, plus every entry matching the filter when one was given. */
  suspects: LedgerEntry[];
  /** The credentials rotated: everything when there was no filter. */
  scopes: SecretScope[];
  outcomes: RotationOutcome[];
}

const DAY = 86_400_000;
const errMsg = (err: unknown): string => scrub(err instanceof Error ? err.message : String(err));

export class RotationService {
  private adapters: Record<string, ApiKeyRotator>;
  private days: number;

  constructor(private o: RotationOptions) {
    this.adapters = o.adapters ?? { cloudflare: cloudflareRotator() };
    this.days = o.days ?? 90;
  }

  /** Credentials older than the policy. */
  async due(now = Date.now()): Promise<SecretMeta[]> {
    return (await this.o.store.list()).filter((m) => m.kind !== "client" && now - m.rotatedAt >= this.days * DAY);
  }

  async rotate(scope: SecretScope): Promise<RotationOutcome> {
    const meta = (await this.o.store.list(scope)).find((m) => scopeId(m.scope) === scopeId(scope));
    return meta ? this.rotateMeta(meta) : this.log({ scope, status: "skipped", message: "no credential stored" });
  }

  async rotateGroup(g: RotationGroup = {}): Promise<RotationOutcome[]> {
    const metas = (await this.o.store.list({ org: g.org, user: g.user, server: g.server })).filter(
      (m) => m.kind !== "client" && (g.category === undefined || (this.o.manifest(m.scope.server)?.category ?? []).includes(g.category)),
    );
    const out: RotationOutcome[] = [];
    for (const m of metas) out.push(await this.rotateMeta(m)); // sequential: provider rate limits
    return out;
  }

  rotateAll(): Promise<RotationOutcome[]> {
    return this.rotateGroup({});
  }

  /** Rotate whatever falls due every `intervalMs`. A guided prompt is issued
   *  once per key version, not on every tick. Returns a stop function. */
  startSchedule(intervalMs: number, onOutcome?: (o: RotationOutcome) => void): () => void {
    let running = false;
    const prompted = new Map<string, number>();
    const tick = async (): Promise<void> => {
      if (running || this.o.store.isFrozen) return; // nothing can rotate during a lockdown
      running = true;
      try {
        for (const m of await this.due()) {
          const id = scopeId(m.scope);
          if (prompted.get(id) === m.rotatedAt) continue;
          const out = await this.rotateMeta(m);
          if (out.status === "guided") prompted.set(id, m.rotatedAt);
          onOutcome?.(out);
        }
      } catch (err) {
        this.o.ledger.record({ ts: Date.now(), user: "scheduler", server: "*", tool: "rotate.schedule", result: "error", reason: errMsg(err) });
      } finally {
        running = false;
      }
    };
    const timer = setInterval(() => void tick(), intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  /** "After a scare": revoke everything, find the suspect ledger entries and the
   *  credentials they could have seen, rotate those (all of them when no filter
   *  was given). The lockdown stays on; the operator re-enables servers one at a time. */
  async incident(f: { since?: number; user?: string; server?: string; by: string }): Promise<IncidentReport> {
    if (!this.o.kill) throw new Error("incident() needs RotationOptions.kill");
    const { store, ledger } = this.o;
    const at = Date.now();
    const { closedSessions } = await this.o.kill.revokeAll(f.by);
    const filtered = f.since !== undefined || f.user !== undefined || f.server !== undefined;
    const suspects = ledger.all({ since: f.since }).filter(
      (e) => e.server !== "*" && (e.flagged || (filtered && (f.user === undefined || e.user === f.user) && (f.server === undefined || e.server === f.server))),
    );
    // A denied call never got a credential; anything else could have.
    const exposed = new Set(suspects.filter((e) => e.result !== "denied").map((e) => scopeId({ org: e.org, user: e.user, server: e.server })));
    const targets = (await store.list()).filter((m) => m.kind !== "client" && (!filtered || exposed.has(scopeId(m.scope))));
    const outcomes: RotationOutcome[] = [];
    store.unfreeze(); // writes only; the lockdown still denies every server meanwhile
    try {
      for (const m of targets) outcomes.push(await this.rotateMeta(m));
    } finally {
      store.freeze();
    }
    const rotated = outcomes.filter((o) => o.status === "rotated").length;
    ledger.record({
      ts: Date.now(), user: f.by, server: "*", tool: "incident", result: "authorized",
      reason: `${suspects.length} suspect entries; ${targets.length} credentials: ${rotated} rotated, ${outcomes.length - rotated} need attention`,
    });
    return { at, by: f.by, closedSessions, suspects, scopes: targets.map((m) => m.scope), outcomes };
  }

  private async rotateMeta(meta: SecretMeta): Promise<RotationOutcome> {
    return this.log(await this.attempt(meta));
  }

  private log(out: RotationOutcome): RotationOutcome {
    const { org, user, server } = out.scope;
    this.o.ledger.record({ ts: Date.now(), org, user, server, tool: "rotate", result: out.status === "failed" ? "error" : "authorized", reason: `${out.status}: ${out.message}` });
    return out;
  }

  private async attempt({ scope, kind }: SecretMeta): Promise<RotationOutcome> {
    if (kind === "client") return { scope, status: "skipped", message: "client registrations are not rotated" };
    if (this.o.store.isFrozen) return { scope, status: "failed", message: "vault is frozen" };
    try {
      if (kind === "oauth2") {
        return (await this.o.broker.refresh(scope))
          ? { scope, status: "rotated", message: "access token refreshed" }
          : { scope, status: "failed", message: "no refresh token - reconnect with connect_server" };
      }
      let note = "";
      const id = this.o.manifest(scope.server)?.auth?.rotation;
      const adapter = id ? this.adapters[id] : undefined;
      if (id && adapter) {
        try {
          const next = await adapter.rotate(await this.o.store.get(scope), scope);
          await this.o.store.put(scope, next, "api_key");
          return { scope, status: "rotated", message: `rolled via ${id}` };
        } catch (err) {
          // ponytail: if the provider rolled but the store write failed, the new key is lost; the guided path recovers it.
          note = `${id} rotation failed (${errMsg(err)}); `;
        }
      }
      return { scope, status: "guided", url: await this.o.broker.keyEntryUrl(scope), message: `${note}re-issue the key at the provider and paste it on the key-entry page` };
    } catch (err) {
      return { scope, status: "failed", message: errMsg(err) };
    }
  }
}

// --- provider adapters -------------------------------------------------------------

const KEY_FIELDS = ["key", "apiKey", "token"] as const;

/** The stored api_key is a bare string or an object with one of KEY_FIELDS; keep its shape. */
function apiKeyOf(current: unknown): { value: string; wrap: (next: string) => unknown } {
  if (typeof current === "string") return { value: current, wrap: (next) => next };
  if (current && typeof current === "object") {
    for (const k of KEY_FIELDS) {
      const v = (current as Record<string, unknown>)[k];
      if (typeof v === "string") return { value: v, wrap: (next) => ({ ...current, [k]: next }) };
    }
  }
  throw new Error("stored credential has no API key");
}

/** Cloudflare user API token roll: GET /user/tokens/verify for the token's id,
 *  then PUT /user/tokens/{id}/value, which invalidates the old value and returns
 *  the new one. The token needs the "API Tokens Write" permission to roll itself;
 *  without it the call fails and rotation falls back to the guided flow. */
export function cloudflareRotator(base = "https://api.cloudflare.com/client/v4"): ApiKeyRotator {
  return {
    async rotate(current) {
      const { value, wrap } = apiKeyOf(current);
      const call = async (method: string, path: string): Promise<unknown> => {
        // TODO(live): verified against the real API only with Habeeb present
        const res = await fetch(base + path, {
          method,
          headers: { Authorization: `Bearer ${value}`, ...(method === "PUT" && { "Content-Type": "application/json" }) },
          body: method === "PUT" ? "{}" : undefined,
        });
        const body = (await res.json().catch(() => ({}))) as { success?: boolean; result?: unknown; errors?: Array<{ message?: string }> };
        if (!res.ok || !body.success) throw new Error(`cloudflare ${method} ${path}: HTTP ${res.status} ${(body.errors ?? []).map((e) => e.message).join("; ")}`.trim());
        return body.result;
      };
      const id = ((await call("GET", "/user/tokens/verify")) as { id?: string } | undefined)?.id;
      if (!id) throw new Error("cloudflare verify returned no token id");
      const next = await call("PUT", `/user/tokens/${encodeURIComponent(id)}/value`);
      if (typeof next !== "string" || !next) throw new Error("cloudflare roll returned no token");
      return wrap(next);
    },
  };
}
