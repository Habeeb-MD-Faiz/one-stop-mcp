// The constant surface the client sees — four meta-tools, regardless of whether
// 5 or 5,000 servers are registered. This is the single mechanism that keeps
// startup context flat (see the design tenet in the brief). Every downstream
// schema stays out of context until find_tools pulls it in for one turn.
//
// Keep these lean: their serialized size IS the startup token cost that
// scripts/token-budget.ts asserts against the <2k target.

export interface MetaTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const META_TOOLS: MetaTool[] = [
  {
    name: "find_tools",
    description: "Search the full catalog for tools relevant to a task. Returns a ranked shortlist with schemas, injected just for this turn.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you want to do, in natural language." },
        k: { type: "number", description: "Max results (default 5)." },
      },
      required: ["query"],
    },
  },
  {
    name: "list_servers",
    description: "List registered downstream servers by category, tag, or auth status. Lightweight — no tool schemas.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Optional substring over id, name, or category." },
      },
    },
  },
  {
    name: "invoke",
    description: "Call a specific tool on a specific downstream server. The gateway routes the call and returns its result.",
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string", description: "Server id from list_servers/find_tools." },
        tool: { type: "string", description: "Tool name on that server." },
        args: { type: "object", description: "Arguments matching the tool's schema." },
      },
      required: ["server", "tool"],
    },
  },
  {
    name: "connect_server",
    description: "Start auth (OAuth redirect or key entry) for a server you want to activate.",
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string", description: "Server id to connect." },
      },
      required: ["server"],
    },
  },
];
