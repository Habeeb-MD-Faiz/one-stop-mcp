import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { META_TOOLS } from "./meta-tools.js";
import type { Registry } from "./registry.js";

/** Build the gateway as an MCP server. It advertises only the four meta-tools;
 *  everything downstream is reached through `invoke`. */
export function buildGateway(registry: Registry): Server {
  const server = new Server(
    { name: "one-stop-mcp", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: META_TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      return { content: [{ type: "text", text: JSON.stringify(await dispatch(registry, name, args)) }] };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: `${name} failed: ${(err as Error).message}` }] };
    }
  });

  return server;
}

async function dispatch(registry: Registry, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "find_tools":
      return registry.findTools(String(args.query ?? ""), typeof args.k === "number" ? args.k : 5);
    case "list_servers":
      return registry.listServers(args.filter ? String(args.filter) : undefined);
    case "invoke":
      return registry.invoke(String(args.server), String(args.tool), (args.args as Record<string, unknown>) ?? {});
    case "connect_server":
      return registry.connect(String(args.server));
    default:
      throw new Error(`unknown meta-tool: ${name}`);
  }
}
