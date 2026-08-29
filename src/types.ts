// Server manifest — the one declarative file a contributor writes. The gateway
// derives everything else (tool list, embeddings, catalog entry) from a live
// MCP `initialize` + `tools/list`. See initial-briefs/one-stop-mcp.html §6.

export type Transport =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "streamable-http"; url: string };

export interface Manifest {
  id: string;
  name: string;
  category: string[];
  description: string;
  transport: Transport;
  auth?: { type: "none" | "api_key" | "oauth2"; scopes?: string[] };
  /** Example utterances that power routing (semantic index in P1; keyword match in P0). */
  routing?: { examples?: string[] };
}

/** A downstream tool as returned by MCP `tools/list`. */
export interface DownstreamTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}
