// Composition root: the one place every lane's piece is built and wired. The
// HTTP faces and the CLI depend only on the `App` shape below (structural, built
// from src/contracts.ts), never on the concrete classes, so they are testable
// with fakes and the wiring can change here alone.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { LOCAL_PRINCIPAL, type AccessGuard, type AuthBroker, type CatalogStore, type Ledger, type Principal, type RotationOutcome, type SecretScope, type SecretStore, type SessionControl } from "../contracts.js";
import type { Manifest } from "../types.js";
import type { Config } from "../config.js";
import type { GatewayRegistry } from "./gateway.js";
import { Metrics } from "./metrics.js";
import { UserStore } from "../tenancy/users.js";
// Other lanes (L1–L4). Signatures per docs/burndown/lanes/*.md.
import { loadManifests } from "../manifest.js";
import { FileCatalogStore } from "../catalog/store.js";
import { importCandidates, refreshSnapshots } from "../catalog/sync.js";
import { createDiscovery } from "../routing/index.js";
import { GatewayAuthBroker } from "../auth/broker.js";
import { Registry } from "../downstream/registry.js";
import { KillSwitch, RotationService, UsageLedger, generateTotpSecret, openSecretStore, scrub, totpUri, verifyLedger, verifyTotp } from "../security/index.js";

export interface HealthResult {
  server: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/** The Registry as the server uses it (src/downstream). */
export interface AppRegistry extends GatewayRegistry, SessionControl {
  manifests(): Manifest[];
  health(p: Principal, id: string): Promise<HealthResult>;
}

/** The kill switch as the admin surface uses it (src/security). Every method is ledgered there. */
export interface KillControl extends AccessGuard {
  status(): unknown;
  revokeAll(by: string): unknown;
  revokeServer(id: string, by: string): unknown;
  enableServer(id: string, by: string): unknown;
  revokeUser(user: string, org: string, by: string): unknown;
  enableUser(user: string, org: string, by: string): unknown;
  endLockdown(by: string): unknown;
}

export interface RotationGroup {
  server?: string;
  category?: string;
  org?: string;
  user?: string;
}

export interface RotationControl {
  due(now?: number): unknown;
  rotate(scope: SecretScope): Promise<RotationOutcome>;
  rotateGroup(filter: RotationGroup): Promise<RotationOutcome[]>;
  rotateAll(): Promise<RotationOutcome[]>;
  incident(opts: { since?: number; user?: string; server?: string; by: string }): Promise<unknown>;
}

export interface App {
  cfg: Config;
  store: SecretStore;
  ledger: Ledger;
  kill: KillControl;
  rotation: RotationControl;
  registry: AppRegistry;
  auth: AuthBroker;
  catalog: CatalogStore;
  users: UserStore;
  metrics: Metrics;
  /** Last-line scrub for any text bound for a model or a log. */
  scrub(text: string): string;
  verifyLedger(): Promise<unknown>;
  /** Create (or replace) an admin's TOTP secret; returns the otpauth:// URI, shown once. */
  enrollTotp(p: Principal): Promise<string>;
  verifyTotp(p: Principal, code: string): Promise<boolean>;
  refreshCatalog(ids: string[]): Promise<unknown>;
  sync(registryUrl?: string): Promise<unknown>;
  close(): Promise<void>;
}

const totpScope = (p: Principal): SecretScope => ({ org: p.org, user: p.user, server: "_totp" });

/** `schedule: false` for one-shot CLI commands, so they never start rotation timers. */
export async function createApp(cfg: Config, opts: { schedule?: boolean } = {}): Promise<App> {
  mkdirSync(cfg.home, { recursive: true, mode: 0o700 });
  const at = (f: string) => join(cfg.home, f);

  const store: SecretStore = await openSecretStore({ ...cfg.vault, passphrase: cfg.masterKey }, cfg.home);
  const users = new UserStore(at("users.json"));
  // Admin TOTP secrets live in the vault, but the kill switch freezes the vault —
  // and admins must still be able to authenticate to end a lockdown. So they are
  // read before the kill switch can freeze anything and cached in memory.
  const totpCache = new Map<string, string>();
  for (const u of users.list().filter((x) => x.admin)) {
    const rec = await store.get<{ secret: string }>(totpScope({ user: u.id, org: u.org, admin: true })).catch(() => undefined);
    if (rec) totpCache.set(`${u.org}/${u.id}`, rec.secret);
  }
  const ledgerPath = at("ledger.jsonl");
  const ledger = new UsageLedger({ path: ledgerPath, signingKeyPath: at("ledger-signing.pem"), burstMax: cfg.ledger.burstMax, windowMs: cfg.ledger.windowMs });
  const kill = new KillSwitch({ statePath: at("killswitch.json"), store, ledger });

  const manifests = loadManifests(cfg.serversDir);
  const byId = new Map(manifests.map((m) => [m.id, m]));
  const manifest = (id: string) => byId.get(id);
  const catalog = new FileCatalogStore({ shippedDir: cfg.catalogDir, stateDir: at("catalog") });
  const discovery = await createDiscovery({ embeddings: cfg.routing.embeddings, model: cfg.routing.model, cacheDir: at("embeddings") });
  const auth = new GatewayAuthBroker({ store, ledger, manifest, publicUrl: cfg.http.publicUrl });
  const registry = new Registry(manifests, { catalog, discovery, auth, guard: kill, ledger, secrets: store, ttlMs: cfg.ttlMs, compress: cfg.compress });
  kill.attachSessions(registry);
  const rotation = new RotationService({ store, ledger, broker: auth, manifest, days: cfg.rotation.days });
  const stopRotation = opts.schedule === false ? () => {} : rotation.startSchedule(cfg.rotation.checkEveryMs);

  const metrics = new Metrics();
  metrics.gauge("osmcp_vault_frozen", "1 while the vault is frozen by the kill switch.", () => (store.isFrozen ? 1 : 0));
  metrics.gauge("osmcp_ledger_flagged_total", "Ledger entries flagged by anomaly detection.", () => ledger.flagged().length, "counter");

  const app: App = {
    cfg, store, ledger, kill, rotation, registry, auth, catalog, metrics, users,
    scrub,
    verifyLedger: async () => verifyLedger(ledgerPath, ledger.publicKeyPem),
    async enrollTotp(p) {
      const secret = generateTotpSecret();
      await store.put(totpScope(p), { secret }, "client");
      totpCache.set(`${p.org}/${p.user}`, secret);
      return totpUri(secret, `${p.org}/${p.user}`, "one-stop-mcp");
    },
    async verifyTotp(p, code) {
      // Fresh read first (another process may have re-enrolled); the cache covers a frozen vault.
      const rec = await store.get<{ secret: string }>(totpScope(p)).catch(() => undefined);
      if (rec) totpCache.set(`${p.org}/${p.user}`, rec.secret);
      const secret = rec?.secret ?? totpCache.get(`${p.org}/${p.user}`);
      return !!secret && verifyTotp(secret, code);
    },
    // Catalog snapshots are tool lists, not user data: refresh runs as the local operator.
    refreshCatalog: (ids) => refreshSnapshots(ids.length ? ids : manifests.map((m) => m.id), (id) => registry.refreshCatalog(LOCAL_PRINCIPAL, id).then(() => {})),
    sync: (registryUrl) => importCandidates({ registryUrl, candidatesDir: join(cfg.serversDir, "_candidates"), existingIds: byId.keys() }),
    async close() {
      stopRotation();
      await registry.closeAll();
    },
  };
  return app;
}
