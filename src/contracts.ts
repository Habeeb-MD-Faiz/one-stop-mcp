// The seams between subsystems. Each interface here has exactly one owner that
// implements it (named in the comment) and is consumed by the others, so the
// pieces can be built in parallel and wired in one place (src/server/app.ts).
// Change a contract here first, then its implementer and consumers.

import type { DownstreamTool, Manifest } from "./types.js";
import type { RoutableTool, ScoredTool } from "./routing/router.js";

// --- identity -----------------------------------------------------------------

/** Who is calling. Local (stdio) mode has exactly one: LOCAL_PRINCIPAL. Team
 *  mode resolves one per request from a bearer token (src/server). */
export interface Principal {
  user: string;
  org: string;
  admin: boolean;
}

export const LOCAL_PRINCIPAL: Principal = Object.freeze({ user: "local", org: "local", admin: true });

// --- secrets (implemented by src/security) -------------------------------------

/** One vault cell: a credential belongs to exactly one (org, user, server). */
export interface SecretScope {
  org: string;
  user: string;
  server: string;
}

export type SecretKind = "oauth2" | "api_key" | "client";

export interface SecretMeta {
  scope: SecretScope;
  kind: SecretKind;
  createdAt: number;
  rotatedAt: number;
}

/** Encrypted-at-rest secret storage. Backends: local file (default), HashiCorp
 *  Vault KV v2. Values are opaque JSON; never logged, never returned to a model. */
export interface SecretStore {
  get<T = unknown>(scope: SecretScope): Promise<T | undefined>;
  put(scope: SecretScope, secret: unknown, kind: SecretKind): Promise<void>;
  delete(scope: SecretScope): Promise<boolean>;
  /** Metadata only — never the secret values. */
  list(filter?: Partial<SecretScope>): Promise<SecretMeta[]>;
  /** Kill switch: while frozen every get/put throws VaultFrozenError. */
  freeze(): void;
  unfreeze(): void;
  readonly isFrozen: boolean;
}

// --- audit (implemented by src/security) ---------------------------------------

export type LedgerResult = "authorized" | "denied" | "error";

export interface LedgerEntry {
  ts: number;
  org: string;
  user: string;
  server: string;
  tool: string;
  result: LedgerResult;
  /** Why it was denied/flagged, or what an admin action did. Never a secret. */
  reason?: string;
  /** Set when anomaly detection tripped on this call. */
  flagged?: boolean;
  /** Tamper evidence: position, previous entry hash, this entry's hash, signature. */
  seq?: number;
  prev?: string;
  hash?: string;
  sig?: string;
}

export type LedgerInput = Omit<LedgerEntry, "org" | "flagged" | "seq" | "prev" | "hash" | "sig"> & { org?: string };

export interface LedgerFilter {
  org?: string;
  user?: string;
  server?: string;
  tool?: string;
  result?: LedgerResult;
  since?: number;
}

/** Every credential use and every admin action, append-only. */
export interface Ledger {
  record(e: LedgerInput): LedgerEntry;
  all(filter?: LedgerFilter): LedgerEntry[];
  flagged(): LedgerEntry[];
}

// --- access control / kill switch (implemented by src/security) ---------------

export class AccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessDeniedError";
  }
}

/** Consulted before every outbound call. Throws AccessDeniedError when the vault
 *  is frozen, the server is revoked, or the user is revoked. */
export interface AccessGuard {
  check(p: Principal, server: string): void;
}

/** Live downstream sessions, so the kill switch can cut them. Implemented by the
 *  Registry (src/downstream). Each returns how many sessions it closed. */
export interface SessionControl {
  closeAll(): Promise<number>;
  closeServer(server: string): Promise<number>;
  closeUser(user: string, org?: string): Promise<number>;
}

// --- discovery (implemented by src/routing) ------------------------------------

/** find_tools result. Fallback ladder: exact name -> hybrid (lexical + BM25 +
 *  dense) -> on low confidence, widen the shortlist and suggest categories to
 *  browse with list_servers rather than guess. */
export interface DiscoveryResult {
  hits: ScoredTool[];
  confidence: "high" | "low";
  widened: boolean;
  /** Categories worth browsing when confidence is low. */
  browse?: string[];
}

export interface Discovery {
  discover(query: string, tools: RoutableTool[], k: number): Promise<DiscoveryResult>;
}

// --- catalog (implemented by src/catalog) --------------------------------------

/** A server's tool list, captured once and kept on disk so discovery never has to
 *  spawn a server. `live` = from tools/list; `docs` = hand-written from its docs. */
export interface CatalogSnapshot {
  server: string;
  source: "live" | "docs";
  fetchedAt: string;
  tools: DownstreamTool[];
}

export interface CatalogStore {
  load(server: string): CatalogSnapshot | undefined;
  save(snapshot: CatalogSnapshot): void;
}

// --- auth broker (implemented by src/auth) -------------------------------------

export interface ConnectResult {
  server: string;
  auth: "none" | "api_key" | "oauth2";
  /** ready: nothing to do · connected: credential already stored · pending: user must open `url`. */
  status: "ready" | "connected" | "pending" | "error";
  /** OAuth authorization URL or the gateway's key-entry page. Never contains a secret. */
  url?: string;
  message: string;
}

/** What an outbound connection needs. Built per call from the vault; never
 *  serialized, never logged, never returned to the model. */
export interface OutboundAuth {
  env?: Record<string, string>;
  headers?: Record<string, string>;
  /** For HTTP servers doing MCP-spec OAuth: an SDK OAuthClientProvider. */
  authProvider?: unknown;
}

export interface AuthBroker {
  connect(p: Principal, server: string): Promise<ConnectResult>;
  /** The OAuth redirect lands here (GET /oauth/callback?code&state). */
  handleOAuthCallback(query: URLSearchParams): Promise<{ server: string; ok: boolean; message: string }>;
  /** The key-entry page posts here. `ticket` is the one-time id from the page URL. */
  submitApiKey(ticket: string, key: string): Promise<{ server: string; ok: boolean; message: string }>;
  outbound(p: Principal, m: Manifest): Promise<OutboundAuth>;
  /** Force an OAuth refresh-token grant. False when there is no refresh token. */
  refresh(scope: SecretScope): Promise<boolean>;
  /** What the key-entry page shows for a ticket; undefined when unknown/expired. */
  ticketInfo(ticket: string): { server: string; name: string; keyUrl?: string; kind: "api_key" | "client"; account: string } | undefined;
  /** A fresh key-entry URL for guided API-key rotation. */
  keyEntryUrl(scope: SecretScope): Promise<string>;
}

// --- rotation (implemented by src/security) ------------------------------------

export interface RotationOutcome {
  scope: SecretScope;
  status: "rotated" | "guided" | "failed" | "skipped";
  /** Guided: where the user re-issues the key. */
  url?: string;
  message: string;
}
