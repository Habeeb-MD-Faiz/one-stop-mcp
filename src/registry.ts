import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport as McpTransport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { DownstreamTool, Manifest } from "./types.js";
import { LexicalRouter, type RoutableTool, type Router } from "./router.js";

interface Session {
  client: Client;
  timer: ReturnType<typeof setTimeout>;
}

export interface ToolHit {
  server: string;
  tool: string;
  description: string;
  inputSchema: unknown;
  score: number;
}

const DEFAULT_TTL_MS = 60_000;

/** Holds the catalog and brokers downstream MCP sessions.
 *
 *  Lazy: nothing downstream runs at startup. A server is spawned only on the
 *  first discovery/invoke that needs it, its session is pooled, and reaped on a
 *  TTL. Its tool catalog is cached separately, so later searches don't respawn
 *  it. This is what keeps startup cost flat regardless of catalog size. */
export class Registry {
  private manifests = new Map<string, Manifest>();
  private sessions = new Map<string, Session>();
  private catalogs = new Map<string, DownstreamTool[]>();
  private ttlMs: number;
  private router: Router;

  constructor(manifests: Manifest[], opts: { ttlMs?: number; router?: Router } = {}) {
    for (const m of manifests) this.manifests.set(m.id, m);
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.router = opts.router ?? new LexicalRouter();
  }

  listServers(filter?: string): Array<Pick<Manifest, "id" | "name" | "category" | "description"> & { auth: string; running: boolean }> {
    const f = filter?.toLowerCase();
    return [...this.manifests.values()]
      .filter((m) => !f || m.id.includes(f) || m.name.toLowerCase().includes(f) || m.category.some((c) => c.toLowerCase().includes(f)))
      .map((m) => ({
        id: m.id,
        name: m.name,
        category: m.category,
        description: m.description,
        auth: m.auth?.type ?? "none",
        running: this.sessions.has(m.id),
      }));
  }

  async findTools(query: string, k = 5): Promise<ToolHit[]> {
    const routable: RoutableTool[] = [];
    for (const m of this.manifests.values()) {
      const tools = await this.ensureCatalog(m.id);
      for (const t of tools) {
        routable.push({
          server: m.id,
          tool: t.name,
          description: t.description ?? "",
          examples: m.routing?.examples ?? [], // server-level for now; per-tool utterances are a P1 manifest extension
          category: m.category,
          inputSchema: t.inputSchema,
        });
      }
    }
    return this.router.rank(query, routable, k).map((r) => ({
      server: r.server,
      tool: r.tool,
      description: r.description,
      inputSchema: r.inputSchema,
      score: r.score,
    }));
  }

  async ensureCatalog(id: string): Promise<DownstreamTool[]> {
    const cached = this.catalogs.get(id);
    if (cached) return cached;
    const client = await this.session(id);
    const { tools } = await client.listTools();
    const catalog = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    this.catalogs.set(id, catalog);
    return catalog;
  }

  async invoke(id: string, tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const client = await this.session(id);
    return client.callTool({ name: tool, arguments: args });
  }

  /** P0 auth stub. Real OAuth/vault brokering is P2 — for now report what the
   *  manifest declares so the client knows whether a flow will be needed. */
  connect(id: string): { server: string; auth: string; status: string; message: string } {
    const m = this.must(id);
    const auth = m.auth?.type ?? "none";
    return auth === "none"
      ? { server: id, auth, status: "ready", message: `${m.name} needs no auth; call invoke directly.` }
      : { server: id, auth, status: "pending", message: `${m.name} requires ${auth}; broker lands in P2.` };
  }

  /** Close one downstream session now (scoped kill switch). Returns whether a
   *  live session was actually running. */
  async close(id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return false;
    clearTimeout(s.timer);
    this.sessions.delete(id);
    await s.client.close().catch(() => {});
    return true;
  }

  async closeAll(): Promise<void> {
    for (const [, s] of this.sessions) {
      clearTimeout(s.timer);
      await s.client.close().catch(() => {});
    }
    this.sessions.clear();
  }

  runningServers(): string[] {
    return [...this.sessions.keys()];
  }

  // --- session pooling -----------------------------------------------------

  private async session(id: string): Promise<Client> {
    const existing = this.sessions.get(id);
    if (existing) {
      this.touch(id);
      return existing.client;
    }
    const m = this.must(id);
    const transport = this.transport(m);
    const client = new Client({ name: "one-stop-mcp", version: "0.0.0" });
    await client.connect(transport);
    this.sessions.set(id, { client, timer: this.arm(id) });
    return client;
  }

  private transport(m: Manifest): McpTransport {
    if (m.transport.type === "stdio") {
      return new StdioClientTransport({
        command: m.transport.command,
        args: m.transport.args,
        env: m.transport.env,
      });
    }
    // ponytail: streamable-http downstream lands with the seed catalog (P1/P3).
    throw new Error(`transport ${m.transport.type} not supported in P0 (server ${m.id})`);
  }

  private touch(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    clearTimeout(s.timer);
    s.timer = this.arm(id);
  }

  private arm(id: string): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => {
      const s = this.sessions.get(id);
      if (!s) return;
      this.sessions.delete(id);
      s.client.close().catch(() => {});
    }, this.ttlMs);
    t.unref?.();
    return t;
  }

  private must(id: string): Manifest {
    const m = this.manifests.get(id);
    if (!m) throw new Error(`unknown server: ${id}`);
    return m;
  }
}
