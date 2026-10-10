import { randomBytes } from "node:crypto";
import { auth, exchangeAuthorization, refreshAuthorization, startAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthBroker, ConnectResult, Ledger, OutboundAuth, Principal, SecretScope, SecretStore } from "../contracts.js";
import type { Manifest, ManifestAuth } from "../types.js";
import { clientScope, VaultOAuthProvider, withExpiry, type StoredTokens } from "./vault-oauth-provider.js";

// The auth broker behind connect_server (PDR §4.3). It turns "connect X" into a
// URL the user opens — an OAuth authorization page, or the gateway's own
// key-entry page — lands the result in the vault, and builds what each outbound
// call needs. Secrets travel vault -> transport only: nothing here returns a
// credential to anything that could hand it to a model (D18).
//
// Three flows:
//  - api_key: a one-time ticket URL to the key-entry page.
//  - oauth2 on an HTTP server without explicit endpoints: the MCP authorization
//    spec (RFC 9728 -> 8414 -> 7591 -> PKCE) entirely through the SDK's auth().
//  - oauth2 with explicit authorizationUrl/tokenUrl (stdio servers): plain OAuth
//    2.1 code + PKCE S256 + state, still through the SDK's building blocks.

const TICKET_TTL_MS = 15 * 60_000;
const FLOW_TTL_MS = 10 * 60_000;
const REFRESH_SKEW_MS = 60_000; // refresh a little before expiry, not after a failed call

/** Tells the model what to do instead of how it failed. Never carries a secret. */
export class NotConnectedError extends Error {
  constructor(m: Manifest, why = "is not connected for you yet") {
    super(`${m.name} ${why}: call connect_server with server "${m.id}" and have the user open the link it returns.`);
    this.name = "NotConnectedError";
  }
}

/** Where an HTTP server's credential goes: header name and value prefix. */
export function credentialHeader(a: ManifestAuth | undefined): { name: string; prefix: string } {
  const name = a?.header ?? "Authorization";
  return { name, prefix: a?.prefix ?? (name.toLowerCase() === "authorization" ? "Bearer " : "") };
}

/** HTTP oauth2 servers without explicit endpoints do MCP-spec discovery. */
const isMcpOAuth = (m: Manifest): boolean => m.transport.type === "streamable-http" && !m.auth?.authorizationUrl;

const random = (): string => randomBytes(32).toString("base64url");
const scopeOf = (p: Principal, server: string): SecretScope => ({ org: p.org, user: p.user, server });

interface Ticket {
  scope: SecretScope;
  kind: "api_key" | "client";
  expires: number;
  /** client tickets: who to start the sign-in for once the operator has pasted the client. */
  principal?: Principal;
}

interface Flow {
  scope: SecretScope;
  m: Manifest;
  expires: number;
  provider?: VaultOAuthProvider; // MCP-spec flow
  verifier?: string; // explicit-endpoint flow
}

export class GatewayAuthBroker implements AuthBroker {
  // ponytail: in-memory, so a gateway restart drops logins in flight; the user just runs connect_server again.
  private tickets = new Map<string, Ticket>();
  private flows = new Map<string, Flow>();
  private store: SecretStore;
  private ledger: Ledger;
  private manifest: (id: string) => Manifest | undefined;
  private publicUrl: string;
  private now: () => number;

  constructor(opts: { store: SecretStore; ledger: Ledger; manifest: (id: string) => Manifest | undefined; publicUrl: string; now?: () => number }) {
    this.store = opts.store;
    this.ledger = opts.ledger;
    this.manifest = opts.manifest;
    this.publicUrl = opts.publicUrl.replace(/\/+$/, "");
    this.now = opts.now ?? Date.now;
  }

  private get redirectUrl(): string {
    return `${this.publicUrl}/oauth/callback`;
  }

  async connect(p: Principal, server: string): Promise<ConnectResult> {
    const m = this.must(server);
    const type = m.auth?.type ?? "none";
    const result = (status: ConnectResult["status"], message: string, url?: string): ConnectResult => ({ server, auth: type, status, url, message });
    if (type === "none") return result("ready", `${m.name} needs no credentials; call invoke directly.`);
    const scope = scopeOf(p, server);
    if (await this.store.get(scope)) return result("connected", `${m.name} is already connected.`);

    if (type === "api_key") {
      return result("pending", `Ask the user to open this link and paste their ${m.name} API key there — never into the chat.`, this.mint(scope, "api_key"));
    }
    try {
      if (isMcpOAuth(m)) {
        const state = random();
        const provider = this.provider(scope, m, state);
        if ((await auth(provider, { serverUrl: this.httpUrl(m) })) === "AUTHORIZED") return result("connected", `${m.name} is connected.`);
        this.remember(this.flows, state, { scope, m, expires: this.now() + FLOW_TTL_MS, provider });
        return result("pending", `Ask the user to open this link and sign in to ${m.name}.`, provider.authorizationUrl!.href);
      }
      const client = await this.client(m);
      if (!client) {
        const url = this.mint(clientScope(server), "client", p);
        return result("pending", `${m.name} needs an OAuth client set up once by the operator: open this link, paste the client id and secret, then sign in.`, url);
      }
      return result("pending", `Ask the user to open this link and sign in to ${m.name}.`, await this.startExplicit(p, m, client));
    } catch (err) {
      return result("error", `Could not start sign-in for ${m.name}: ${(err as Error).message}`);
    }
  }

  async handleOAuthCallback(query: URLSearchParams): Promise<{ server: string; ok: boolean; message: string }> {
    const state = query.get("state") ?? "";
    const flow = this.flows.get(state);
    this.flows.delete(state); // single use, whatever happens next
    if (!flow || flow.expires < this.now()) return { server: flow?.m.id ?? "", ok: false, message: "This sign-in link is unknown or expired. Run connect_server again." };
    const { m, scope } = flow;
    const code = query.get("code");
    if (!code) {
      this.audit(scope, "auth.connect", "error", `authorization denied: ${query.get("error") ?? "no code"}`);
      return { server: m.id, ok: false, message: `${m.name} sign-in was not completed (${query.get("error") ?? "no code returned"}).` };
    }
    try {
      if (flow.provider) {
        if ((await auth(flow.provider, { serverUrl: this.httpUrl(m), authorizationCode: code })) !== "AUTHORIZED") throw new Error("authorization server did not issue tokens");
      } else {
        const client = await this.client(m);
        if (!client) throw new Error("OAuth client is no longer configured");
        const tokens = await exchangeAuthorization(m.auth!.tokenUrl!, {
          metadata: explicitMetadata(m),
          clientInformation: client,
          authorizationCode: code,
          codeVerifier: flow.verifier!,
          redirectUri: this.redirectUrl,
        });
        await this.store.put(scope, withExpiry(tokens, this.now()), "oauth2");
      }
    } catch (err) {
      this.audit(scope, "auth.connect", "error", `token exchange failed (${(err as Error).name})`);
      return { server: m.id, ok: false, message: `${m.name} sign-in failed: ${(err as Error).message}` };
    }
    this.audit(scope, "auth.connect", "authorized");
    return { server: m.id, ok: true, message: `${m.name} is connected. You can close this tab.` };
  }

  async submitApiKey(ticket: string, key: string): Promise<{ server: string; ok: boolean; message: string }> {
    const t = this.live(ticket);
    if (!t) return { server: "", ok: false, message: "This link is unknown or expired. Run connect_server again." };
    const m = this.must(t.scope.server);
    const value = key.trim();
    const client = t.kind === "client" ? parseClient(value) : undefined;
    if (!value || (t.kind === "client" && !client)) return { server: m.id, ok: false, message: "That value is empty or malformed; nothing was saved." };
    this.tickets.delete(ticket); // one-time: consumed only by a well-formed submission

    if (t.kind === "api_key") {
      await this.store.put(t.scope, { key: value }, "api_key");
      this.audit(t.scope, "auth.connect", "authorized");
      return { server: m.id, ok: true, message: `${m.name} is connected. You can close this tab.` };
    }
    await this.store.put(t.scope, client, "client");
    this.audit(t.scope, "auth.client", "authorized");
    const next = t.principal ? await this.startExplicit(t.principal, m, client!) : undefined;
    return { server: m.id, ok: true, message: next ? `OAuth client saved. Now sign in: ${next}` : "OAuth client saved." };
  }

  async outbound(p: Principal, m: Manifest): Promise<OutboundAuth> {
    const a = m.auth;
    if (!a || a.type === "none") return {};
    const scope = scopeOf(p, m.id);
    if (a.type === "oauth2" && isMcpOAuth(m)) {
      if (!(await this.store.get(scope))) throw new NotConnectedError(m);
      return { authProvider: this.provider(scope, m) }; // the SDK reads tokens and refreshes on 401 itself
    }
    const secret = a.type === "api_key" ? (await this.store.get<{ key: string }>(scope))?.key : await this.accessToken(scope, m);
    if (!secret) throw new NotConnectedError(m);
    if (m.transport.type === "stdio") {
      if (!a.env) throw new Error(`manifest ${m.id}: auth.env must name the variable the credential is injected into`);
      return { env: { [a.env]: secret } };
    }
    const h = credentialHeader(a);
    return { headers: { [h.name]: h.prefix + secret } };
  }

  async refresh(scope: SecretScope): Promise<boolean> {
    const m = this.manifest(scope.server);
    if (m?.auth?.type !== "oauth2") return false;
    const t = await this.store.get<StoredTokens>(scope);
    if (!t?.refresh_token) return false;
    if (isMcpOAuth(m)) {
      // auth() always spends the refresh token when one is stored; REDIRECT means it was rejected.
      if ((await auth(this.provider(scope, m), { serverUrl: this.httpUrl(m) })) !== "AUTHORIZED") return false;
    } else {
      const client = await this.client(m);
      if (!client) return false;
      const fresh = await refreshAuthorization(m.auth.tokenUrl!, { metadata: explicitMetadata(m), clientInformation: client, refreshToken: t.refresh_token });
      await this.store.put(scope, withExpiry(fresh, this.now()), "oauth2");
    }
    this.audit(scope, "auth.refresh", "authorized");
    return true;
  }

  ticketInfo(ticket: string): { server: string; name: string; keyUrl?: string; kind: "api_key" | "client" } | undefined {
    const t = this.live(ticket);
    if (!t) return undefined;
    const m = this.manifest(t.scope.server);
    return m && { server: m.id, name: m.name, keyUrl: m.auth?.keyUrl, kind: t.kind };
  }

  async keyEntryUrl(scope: SecretScope): Promise<string> {
    this.must(scope.server);
    return this.mint(scope, "api_key");
  }

  // --- internals -----------------------------------------------------------

  /** Explicit-endpoint flows: an access token from the vault, refreshed first when (nearly) expired. */
  private async accessToken(scope: SecretScope, m: Manifest): Promise<string | undefined> {
    const t = await this.store.get<StoredTokens>(scope);
    if (!t) return undefined;
    if (t.expires_at === undefined || t.expires_at - REFRESH_SKEW_MS > this.now()) return t.access_token;
    if (!(await this.refresh(scope))) throw new NotConnectedError(m, "sign-in has expired");
    return (await this.store.get<StoredTokens>(scope))?.access_token;
  }

  private async startExplicit(p: Principal, m: Manifest, client: OAuthClientInformationMixed): Promise<string> {
    const state = random();
    const { authorizationUrl, codeVerifier } = await startAuthorization(m.auth!.authorizationUrl!, {
      metadata: explicitMetadata(m),
      clientInformation: client,
      redirectUrl: this.redirectUrl,
      scope: m.auth!.scopes?.join(" ") || undefined,
      state,
    });
    this.remember(this.flows, state, { scope: scopeOf(p, m.id), m, expires: this.now() + FLOW_TTL_MS, verifier: codeVerifier });
    return authorizationUrl.href;
  }

  /** Explicit-endpoint client: operator-pasted (vault) first, else the manifest's public client id. */
  private async client(m: Manifest): Promise<OAuthClientInformationMixed | undefined> {
    const stored = await this.store.get<OAuthClientInformationMixed>(clientScope(m.id));
    return stored ?? (m.auth?.clientId ? { client_id: m.auth.clientId } : undefined);
  }

  private provider(scope: SecretScope, m: Manifest, state?: string): VaultOAuthProvider {
    return new VaultOAuthProvider(this.store, scope, { redirectUrl: this.redirectUrl, state, scopes: m.auth?.scopes, clientId: m.auth?.clientId, now: this.now });
  }

  private mint(scope: SecretScope, kind: Ticket["kind"], principal?: Principal): string {
    const ticket = random();
    this.remember(this.tickets, ticket, { scope, kind, expires: this.now() + TICKET_TTL_MS, principal });
    return `${this.publicUrl}/connect/${ticket}`;
  }

  private live(ticket: string): Ticket | undefined {
    const t = this.tickets.get(ticket);
    return t && t.expires >= this.now() ? t : undefined;
  }

  /** Insert, pruning expired entries so abandoned logins don't accumulate. */
  private remember<T extends { expires: number }>(map: Map<string, T>, key: string, value: T): void {
    const now = this.now();
    for (const [k, v] of map) if (v.expires < now) map.delete(k);
    map.set(key, value);
  }

  private httpUrl(m: Manifest): string {
    if (m.transport.type !== "streamable-http") throw new Error(`server ${m.id} is not an HTTP server`);
    return m.transport.url;
  }

  private audit(scope: SecretScope, tool: string, result: "authorized" | "error", reason?: string): void {
    this.ledger.record({ ts: this.now(), org: scope.org, user: scope.user, server: scope.server, tool, result, reason });
  }

  private must(id: string): Manifest {
    const m = this.manifest(id);
    if (!m) throw new Error(`unknown server: ${id}`);
    return m;
  }
}

/** Authorization-server metadata assembled from a manifest's explicit endpoints. */
function explicitMetadata(m: Manifest): OAuthMetadata {
  const a = m.auth;
  if (!a?.authorizationUrl || !a.tokenUrl) throw new Error(`manifest ${m.id}: oauth2 without MCP discovery needs auth.authorizationUrl and auth.tokenUrl`);
  return {
    issuer: new URL(a.authorizationUrl).origin,
    authorization_endpoint: a.authorizationUrl,
    token_endpoint: a.tokenUrl,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
  };
}

/** Operator-pasted OAuth client: JSON {"client_id","client_secret"?}, or "id:secret", or a bare id. */
function parseClient(value: string): OAuthClientInformationMixed | undefined {
  if (value.startsWith("{")) {
    try {
      const j = JSON.parse(value) as { client_id?: unknown; client_secret?: unknown };
      if (typeof j.client_id !== "string" || !j.client_id) return undefined;
      return typeof j.client_secret === "string" && j.client_secret ? { client_id: j.client_id, client_secret: j.client_secret } : { client_id: j.client_id };
    } catch {
      return undefined;
    }
  }
  const i = value.indexOf(":"); // RFC 7617 style: an id cannot contain ':', a secret can
  if (i < 0) return { client_id: value };
  const [id, secret] = [value.slice(0, i), value.slice(i + 1)];
  return id ? (secret ? { client_id: id, client_secret: secret } : { client_id: id }) : undefined;
}
