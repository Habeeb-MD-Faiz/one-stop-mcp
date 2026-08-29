#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildGateway } from "./gateway.js";
import { loadManifests } from "./manifest.js";
import { Registry } from "./registry.js";

const here = dirname(fileURLToPath(import.meta.url));
// servers/ sits at the repo root, one level up from dist/ (or src/ under tsx).
const serversDir = process.env.OSMCP_SERVERS_DIR ?? join(here, "..", "servers");

async function main(): Promise<void> {
  const registry = new Registry(loadManifests(serversDir));
  const server = buildGateway(registry);
  const shutdown = async () => {
    await registry.closeAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await server.connect(new StdioServerTransport());
  // stderr is safe for logs; stdout is the MCP channel.
  console.error(`one-stop-mcp: ${registry.listServers().length} server(s) registered, 4 meta-tools exposed.`);
}

main().catch((err) => {
  console.error("one-stop-mcp failed to start:", err);
  process.exit(1);
});
