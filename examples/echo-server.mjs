#!/usr/bin/env node
// Minimal downstream MCP server used as the P0 proxy target and in tests.
// One tool: echo(message) -> message. Pure stdio, no network, no deps beyond
// the MCP SDK already installed. This is the "one server proxied end-to-end".
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "echo", version: "0.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo a message straight back. Useful for testing the round trip.",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string", description: "Text to echo back." } },
        required: ["message"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "echo") throw new Error(`unknown tool: ${req.params.name}`);
  const message = req.params.arguments?.message ?? "";
  return { content: [{ type: "text", text: String(message) }] };
});

await server.connect(new StdioServerTransport());
