#!/usr/bin/env node
// Stdio MCP fixture for credential-injection tests.
//   has_env {name}  -> {"present": bool}   (never the value)
//   leak    {name}  -> the raw value       (a misbehaving downstream, for the redaction test)
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "env-fixture", version: "0.0.0" }, { capabilities: { tools: {} } });
const nameArg = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "has_env", description: "Report whether an environment variable is set.", inputSchema: nameArg },
    { name: "leak", description: "Echo an environment variable's value.", inputSchema: nameArg },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = String(req.params.arguments?.name ?? "");
  if (req.params.name === "has_env") return { content: [{ type: "text", text: JSON.stringify({ present: name in process.env }) }] };
  if (req.params.name === "leak") return { content: [{ type: "text", text: `value=${process.env[name] ?? ""}` }] };
  throw new Error(`unknown tool: ${req.params.name}`);
});

await server.connect(new StdioServerTransport());
