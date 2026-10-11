import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  AccessDeniedError,
  type AccessGuard,
  type AuthBroker,
  type CatalogSnapshot,
  type CatalogStore,
  type Discovery,
  type DiscoveryResult,
  type Ledger,
  type LedgerResult,
  type OutboundAuth,
  type Principal,
  type SecretStore,
  type SessionControl,
} from "../contracts.js";
import type { AuthType, Manifest } from "../types.js";
import type { RoutableTool } from "../routing/router.js";
import { compressSchema, type CompressLevel } from "../routing/compress.js";
import { toRoutable } from "../routing/index.js";
import { redact } from "../security/redact.js";
import { credentialHeader, NotConnectedError } from "../auth/broker.js";

// Holds the catalog and brokers downstream MCP sessions (PDR §4.4).
//
// Lazy: nothing downstream runs at startup, and discovery never spawns a server
// — find_tools ranks on-disk tool snapshots (D25). A server starts only on the
// first invoke that needs it; its session is pooled per (org, user, server) —
// or shared when the server takes no credential — and reaped on a TTL.
// Every outbound call goes guard -> vault -> transport -> ledger, and whatever
// comes back has the injected secret values scrubbed before a model sees it.

export interface ServerInfo {
  id: string;
  name: string;
  category: string[];
  tags: string[];
  description: string;
  auth: AuthType;
  /** Usable without connect_server: no auth needed, or a credential is stored for this principal. */
  connected: boolean;
  running: boolean;
}

export interface ServerFilter {
  text?: string;
  category?: string;
  tag?: string;
  auth?: AuthType | "connected" | "not_connected";
}

export interface HealthResult {
  server: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
  /** health.check is "none": nothing was contacted. */
  skipped?: boolean;
}

export interface RegistryDeps {
  catalog: CatalogStore;
  discovery: Discovery;
  auth: AuthBroker;
  guard: AccessGuard;
  ledger: Ledger;
  /** Metadata only (SecretStore.list) — to report which servers a principal has connected. */
  secrets: SecretStore;
  ttlMs?: number;
  compress?: CompressLevel;
  /** The gateway's state directory: no stdio server is started with it in reach of a path argument. */
  home?: string;
}

interface Session {
  server: string;
  owner: { org: string; user: string };
  /** Hash of the injected env/headers: a refreshed or rotated credential means a new session. */
  fp: string;
  ready: Promise<Client>;
  timer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_TTL_MS = 60_000;

export class Registry implements SessionControl {
  private byId = new Map<string, Manifest>();
  private sessions = new Map<string, Session>();
  private deps: RegistryDeps;
  private ttlMs: number;
  private compress: CompressLevel;

  constructor(manifests: Manifest[], deps: RegistryDeps) {
    for (const m of manifests) this.byId.set(m.id, m);
    this.deps = deps;
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    this.compress = deps.compress ?? "light"; // strip schema boilerplate from shortlists by default (D8)
  }

  manifest(id: string): Manifest | undefined {
    return this.byId.get(id);
  }

  manifests(): Manifest[] {
    return [...this.byId.values()];
  }

  async listServers(p: Principal, filter: ServerFilter = {}): Promise<ServerInfo[]> {
    const held = new Set((await this.deps.secrets.list({ org: p.org, user: p.user })).map((s) => s.scope.server));
    const text = filter.text?.toLowerCase();
    const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    return this.manifests()
      .map((m): ServerInfo => {
        const auth = m.auth?.type ?? "none";
        return {
          id: m.id,
          name: m.name,
          category: m.category,
          tags: m.tags ?? [],
          description: m.description,
          auth,
          connected: auth === "none" || held.has(m.id),
          running: this.sessions.has(this.key(p, m)),
        };
      })
      .filter(
        (s) =>
          (!text || [s.id, s.name, s.description, ...s.category, ...s.tags].some((f) => f.toLowerCase().includes(text))) &&
          (!filter.category || s.category.some((c) => eq(c, filter.category!))) &&
          (!filter.tag || s.tags.some((t) => eq(t, filter.tag!))) &&
          (!filter.auth ||
            (filter.auth === "connected" ? s.connected : filter.auth === "not_connected" ? !s.connected : s.auth === filter.auth)),
      );
  }

  /** Ranks tools from catalog snapshots only — never spawns a server. Servers
   *  without a snapshot, or revoked for this principal, are left out. */
  async findTools(p: Principal, query: string, k = 5): Promise<DiscoveryResult> {
    const tools: RoutableTool[] = [];
    for (const m of this.byId.values()) {
      const snap = this.deps.catalog.load(m.id);
      if (snap && this.allowed(p, m.id)) tools.push(...toRoutable(m, snap));
    }
    const r = await this.deps.discovery.discover(query, tools, k);
    return { ...r, hits: r.hits.map((h) => ({ ...h, inputSchema: compressSchema(h.inputSchema, this.compress) })) };
  }

  async invoke(p: Principal, server: string, tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const { m, out, secrets } = await this.outbound(p, server, tool);
    const s = await this.session(p, m, out, secrets);
    try {
      const res = (await (await s.ready).callTool({ name: tool, arguments: args })) as { isError?: boolean };
      this.record(p, server, tool, res.isError ? "error" : "authorized");
      return redact(res, [...secrets, ...(await providerSecrets(out))]); // OAuth tokens may have been refreshed mid-call
    } catch (err) {
      throw await this.failed(p, m, tool, s, out, secrets, err);
    }
  }

  /** Live tools/list -> catalog snapshot. For `catalog refresh` and the sync worker. */
  async refreshCatalog(p: Principal, id: string): Promise<CatalogSnapshot> {
    const tool = "tools/list";
    const { m, out, secrets } = await this.outbound(p, id, tool);
    const s = await this.session(p, m, out, secrets);
    try {
      const snap = await this.snapshot(m.id, await s.ready, secrets);
      this.record(p, id, tool, "authorized");
      return snap;
    } catch (err) {
      throw await this.failed(p, m, tool, s, out, secrets, err);
    }
  }

  /** Per manifest health.check: initialize = connect, tools/list = connect + list, none = skip.
   *  Uses its own short-lived connection so a pooled session can't mask a dead server. */
  async health(p: Principal, id: string): Promise<HealthResult> {
    const m = this.must(id);
    const check = m.health?.check ?? "initialize";
    if (check === "none") return { server: id, ok: true, latencyMs: 0, skipped: true };
    const t0 = performance.now();
    const ms = () => Math.round(performance.now() - t0);
    let secrets: string[] = [];
    let client: Client | undefined;
    try {
      const o = await this.outbound(p, id, "health");
      secrets = o.secrets;
      client = await this.open(o.m, o.out, secrets);
      if (check === "tools/list") await client.listTools();
      this.record(p, id, "health", "authorized");
      return { server: id, ok: true, latencyMs: ms() };
    } catch (err) {
      return { server: id, ok: false, latencyMs: ms(), error: redact((err as Error).message, secrets) };
    } finally {
      await client?.close().catch(() => {});
    }
  }

  // --- SessionControl: the kill switch cuts through these ------------------------

  closeAll(): Promise<number> {
    return this.closeWhere(() => true);
  }

  closeServer(server: string): Promise<number> {
    return this.closeWhere((s) => s.server === server);
  }

  closeUser(user: string, org?: string): Promise<number> {
    return this.closeWhere((s) => s.owner.user === user && (org === undefined || s.owner.org === org));
  }

  runningServers(): string[] {
    return [...new Set([...this.sessions.values()].map((s) => s.server))];
  }

  // --- outbound path -------------------------------------------------------------

  /** Guard, then credentials. A denial is ledgered; a missing credential tells the model to connect. */
  private async outbound(p: Principal, server: string, tool: string): Promise<{ m: Manifest; out: OutboundAuth; secrets: string[] }> {
    const m = this.must(server);
    try {
      this.deps.guard.check(p, server);
    } catch (err) {
      if (err instanceof AccessDeniedError) this.record(p, server, tool, "denied", err.message);
      throw err;
    }
    const out = await this.deps.auth.outbound(p, m);
    return { m, out, secrets: await secretsOf(m, out) };
  }

  private async failed(p: Principal, m: Manifest, tool: string, s: Session, out: OutboundAuth, secrets: string[], err: unknown): Promise<Error> {
    if (!(err instanceof McpError)) await this.drop(s); // transport or auth failure: the session is suspect
    if (err instanceof UnauthorizedError) {
      this.record(p, m.id, tool, "error", "downstream rejected the stored credential");
      return new NotConnectedError(m, "sign-in is no longer valid");
    }
    const all = [...secrets, ...(await providerSecrets(out).catch(() => []))];
    const message = redact(err instanceof Error ? err.message : String(err), all);
    this.record(p, m.id, tool, "error", message.slice(0, 200));
    return new Error(message);
  }

  private record(p: Principal, server: string, tool: string, result: LedgerResult, reason?: string): void {
    this.deps.ledger.record({ ts: Date.now(), org: p.org, user: p.user, server, tool, result, reason });
  }

  private allowed(p: Principal, server: string): boolean {
    try {
      this.deps.guard.check(p, server);
      return true;
    } catch (err) {
      if (err instanceof AccessDeniedError) return false;
      throw err;
    }
  }

  // --- session pooling -----------------------------------------------------------

  // Per user even without credentials: a server's in-process state (memory, browser tabs) must not cross tenants.
  private key(p: Principal, m: Manifest): string {
    return `${p.org}/${p.user}/${m.id}`;
  }

  private async session(p: Principal, m: Manifest, out: OutboundAuth, secrets: string[]): Promise<Session> {
    const key = this.key(p, m);
    const fp = fingerprint(out);
    const existing = this.sessions.get(key);
    if (existing && existing.fp === fp) {
      this.arm(key, existing);
      await existing.ready;
      return existing;
    }
    if (existing) await this.drop(existing); // credential changed (refresh, rotation): respawn with the new one

    const s: Session = { server: m.id, owner: { org: p.org, user: p.user }, fp, ready: this.open(m, out, secrets) };
    this.sessions.set(key, s); // concurrent callers for the same key await the same connect
    let client: Client;
    try {
      client = await s.ready;
    } catch (err) {
      if (this.sessions.get(key) === s) this.sessions.delete(key);
      throw err;
    }
    client.onclose = () => {
      if (this.sessions.get(key) !== s) return;
      clearTimeout(s.timer);
      this.sessions.delete(key);
    };
    this.arm(key, s);
    if (!this.deps.catalog.load(m.id)) await this.snapshot(m.id, client, secrets).catch(() => {}); // first open: index it for find_tools
    return s;
  }

  private arm(key: string, s: Session): void {
    clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      if (this.sessions.get(key) === s) void this.drop(s);
    }, this.ttlMs);
    s.timer.unref?.();
  }

  private async drop(s: Session): Promise<void> {
    clearTimeout(s.timer);
    for (const [k, v] of this.sessions) if (v === s) this.sessions.delete(k);
    const client = await s.ready.catch(() => undefined);
    await client?.close().catch(() => {});
  }

  private async closeWhere(pred: (s: Session) => boolean): Promise<number> {
    const doomed = [...this.sessions.values()].filter(pred);
    await Promise.all(doomed.map((s) => this.drop(s)));
    return doomed.length;
  }

  private async snapshot(server: string, client: Client, secrets: string[]): Promise<CatalogSnapshot> {
    const tools: CatalogSnapshot["tools"] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      for (const t of page.tools) tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
      cursor = page.nextCursor;
    } while (cursor);
    const snap: CatalogSnapshot = { server, source: "live", fetchedAt: new Date().toISOString(), tools: redact(tools, secrets) };
    this.deps.catalog.save(snap);
    return snap;
  }

  // --- transports ----------------------------------------------------------------

  private async open(m: Manifest, out: OutboundAuth, secrets: string[]): Promise<Client> {
    const t = m.transport;
    const client = new Client({ name: "one-stop-mcp", version: "0.0.0" });
    if (t.type === "stdio") {
      // ponytail: catches a path argument that contains the state directory ("." started from ~, "/").
      // A server that takes paths at call time (git) still runs as this OS user; see docs/security.md.
      const exposed = this.deps.home && (t.args ?? []).find((a) => !a.startsWith("-") && contains(resolve(a), this.deps.home!));
      if (exposed) throw new Error(`refusing to start ${m.id}: its argument "${exposed}" would give it the gateway's state directory`);
      // D31: the child gets the SDK's safe default variables + manifest env + the
      // injected credential — never the gateway's own environment (OSMCP_MASTER_KEY).
      const transport = new StdioClientTransport({ command: t.command, args: t.args, env: { ...t.env, ...out.env }, stderr: "pipe" });
      // ponytail: per-chunk scrub; a secret split across two stderr chunks slips through. Line-buffer if that ever matters.
      transport.stderr?.on("data", (chunk: Buffer) => process.stderr.write(redact(chunk.toString(), secrets)));
      await client.connect(transport);
      return client;
    }
    const url = new URL(t.url);
    const opts = { requestInit: { headers: { ...t.headers, ...out.headers } }, authProvider: out.authProvider as OAuthClientProvider | undefined };
    try {
      await client.connect(new StreamableHTTPClientTransport(url, opts));
      return client;
    } catch (err) {
      // Pre-2025-03-26 servers speak HTTP+SSE and reject the Streamable POST with a
      // 4xx; the SDK's documented backwards-compatible client retries over SSE (D15).
      await client.close().catch(() => {});
      if (!(err instanceof StreamableHTTPError) || !legacyStatus(err.code)) throw err;
      const legacy = new Client({ name: "one-stop-mcp", version: "0.0.0" });
      await legacy.connect(new SSEClientTransport(url, opts));
      return legacy;
    }
  }

  private must(id: string): Manifest {
    const m = this.byId.get(id);
    if (!m) throw new Error(`unknown server: ${id}`);
    return m;
  }
}

const legacyStatus = (code: number | undefined): boolean => code !== undefined && code >= 400 && code < 500 && code !== 401 && code !== 403;

const fingerprint = (out: OutboundAuth): string =>
  createHash("sha256").update(JSON.stringify([out.env ?? {}, out.headers ?? {}])).digest("hex");

/** Every raw secret an outbound call carries: injected env/header values (with
 *  and without the header prefix) and, for MCP-spec OAuth, the live tokens. */
export async function secretsOf(m: Manifest, out: OutboundAuth): Promise<string[]> {
  const { prefix } = credentialHeader(m.auth);
  const headerValues = Object.values(out.headers ?? {}).flatMap((v) => (prefix && v.startsWith(prefix) ? [v, v.slice(prefix.length)] : [v]));
  return [...Object.values(out.env ?? {}), ...headerValues, ...(await providerSecrets(out))].filter(Boolean);
}

async function providerSecrets(out: OutboundAuth): Promise<string[]> {
  const t = await (out.authProvider as OAuthClientProvider | undefined)?.tokens();
  return t ? [t.access_token, t.refresh_token ?? ""].filter(Boolean) : [];
}

function contains(dir: string, inner: string): boolean {
  const r = relative(dir, inner);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}
