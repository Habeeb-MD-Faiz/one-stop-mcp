// The gateway as an MCP server, built once per caller: it advertises only the
// four meta-tools and dispatches every call with the caller's Principal, so
// discovery, credentials and the kill switch all know who is asking. Admin powers
// (kill switch, rotation, ledger) are deliberately not meta-tools (D17).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AuthBroker, DiscoveryResult, Principal } from "../contracts.js";
import type { Manifest } from "../types.js";
import { META_TOOLS } from "./meta-tools.js";
import type { Metrics } from "./metrics.js";

export type AuthFilter = "none" | "api_key" | "oauth2" | "connected" | "not_connected";
export interface ServerFilter {
  text?: string;
  category?: string;
  tag?: string;
  auth?: AuthFilter;
}

/** What the facade needs from the downstream Registry (src/downstream). */
export interface GatewayRegistry {
  manifest(id: string): Manifest | undefined;
  listServers(p: Principal, filter?: ServerFilter): unknown;
  findTools(p: Principal, query: string, k: number): Promise<DiscoveryResult>;
  invoke(p: Principal, server: string, tool: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface GatewayDeps {
  registry: GatewayRegistry;
  auth: Pick<AuthBroker, "connect">;
  metrics?: Metrics;
  /** Last-line scrub of error text before it reaches the model (src/security). */
  scrub?: (text: string) => string;
}

const MAX_K = 25;
const AUTH_FILTERS: AuthFilter[] = ["none", "api_key", "oauth2", "connected", "not_connected"];

export function buildGateway(deps: GatewayDeps, principal: Principal): Server {
  const server = new Server({ name: "one-stop-mcp", version: "0.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: META_TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const { name, arguments: args = {} } = req.params;
    try {
      return await dispatch(deps, principal, name, args);
    } catch (err) {
      const text = `${name} failed: ${(err as Error).message}`;
      return { isError: true, content: [{ type: "text", text: deps.scrub ? deps.scrub(text) : text }] };
    }
  });

  return server;
}

async function dispatch(deps: GatewayDeps, p: Principal, name: string, a: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "find_tools": {
      const query = str(a.query, "query");
      const k = a.k === undefined ? 5 : Math.min(MAX_K, Math.max(1, Math.trunc(Number(a.k)) || 5));
      const r = await deps.registry.findTools(p, query, k);
      deps.metrics?.inc("osmcp_find_tools_total", { confidence: r.confidence });
      return json({
        tools: r.hits.map((h) => ({ server: h.server, tool: h.tool, description: h.description, inputSchema: h.inputSchema, score: Math.round(h.score * 1000) / 1000 })),
        confidence: r.confidence,
        widened: r.widened,
        ...(r.browse?.length ? { browse: r.browse } : {}),
      });
    }
    case "list_servers": {
      const auth = opt(a.auth, "auth");
      if (auth !== undefined && !AUTH_FILTERS.includes(auth as AuthFilter)) throw new Error(`auth must be one of ${AUTH_FILTERS.join(", ")}`);
      const filter = { text: opt(a.filter, "filter"), category: opt(a.category, "category"), tag: opt(a.tag, "tag"), auth: auth as AuthFilter | undefined };
      return json(await deps.registry.listServers(p, filter));
    }
    case "invoke": {
      const server = str(a.server, "server");
      const tool = str(a.tool, "tool");
      const args = a.args ?? {};
      if (typeof args !== "object" || args === null || Array.isArray(args)) throw new Error("args must be an object");
      // Only known ids become label values, so callers cannot blow up metric cardinality.
      const label = deps.registry.manifest(server) ? server : "unknown";
      const start = performance.now();
      try {
        const res = await deps.registry.invoke(p, server, tool, args as Record<string, unknown>);
        const isError = (res as CallToolResult)?.isError === true;
        deps.metrics?.inc("osmcp_invocations_total", { server: label, result: isError ? "error" : "ok" });
        // Pass the downstream result through as-is (text, images, structured content);
        // anything that is not a tool result is wrapped as JSON text.
        return Array.isArray((res as CallToolResult)?.content) ? (res as CallToolResult) : json(res);
      } catch (err) {
        const denied = (err as Error)?.name === "AccessDeniedError";
        deps.metrics?.inc("osmcp_invocations_total", { server: label, result: denied ? "denied" : "error" });
        throw err;
      } finally {
        deps.metrics?.observeInvoke((performance.now() - start) / 1000);
      }
    }
    case "connect_server":
      return json(await deps.auth.connect(p, str(a.server, "server")));
    default:
      throw new Error(`unknown meta-tool: ${name}`);
  }
}

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function str(v: unknown, name: string): string {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${name} is required (non-empty string)`);
  return v;
}

function opt(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new Error(`${name} must be a string`);
  return v;
}
