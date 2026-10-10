// Server manifest — the one declarative file a contributor writes. The gateway
// derives everything else (tool list, embeddings, catalog entry) from a live
// MCP `initialize` + `tools/list`. See docs/PDR.md §6; the JSON Schema that CI
// validates against is schema/manifest.schema.json.

export type Transport =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "streamable-http"; url: string; headers?: Record<string, string> };

export type AuthType = "none" | "api_key" | "oauth2";

export interface ManifestAuth {
  type: AuthType;
  scopes?: string[];
  /** stdio: env var the credential (API key or OAuth access token) is injected into. */
  env?: string;
  /** streamable-http: header that carries the credential. Default "Authorization". */
  header?: string;
  /** Prefix for the header value. Default "Bearer " when header is Authorization, else "". */
  prefix?: string;
  /** api_key: where the user creates or re-issues a key — shown on the guided key-entry page. */
  keyUrl?: string;
  /** api_key: id of a provider adapter that can rotate the key by API. Absent = guided rotation. */
  rotation?: string;
  /** oauth2 for servers that do NOT do MCP auth discovery (most stdio servers): explicit endpoints.
   *  Absent on an HTTP server = discover per the MCP authorization spec (RFC 9728 / 8414 / 7591). */
  authorizationUrl?: string;
  tokenUrl?: string;
  /** Public OAuth client id (PKCE). A client secret, if a provider needs one, lives in the vault. */
  clientId?: string;
}

export interface Manifest {
  id: string;
  name: string;
  category: string[];
  description: string;
  transport: Transport;
  auth?: ManifestAuth;
  /** Example utterances that power routing. `tools` holds per-tool utterances keyed by tool name. */
  routing?: { examples?: string[]; tools?: Record<string, string[]> };
  health?: { check: "initialize" | "tools/list" | "none" };
  tags?: string[];
  homepage?: string;
}

/** A downstream tool as returned by MCP `tools/list`. */
export interface DownstreamTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}
