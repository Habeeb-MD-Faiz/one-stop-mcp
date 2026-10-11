import { randomBytes } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { SecretScope, SecretStore } from "../contracts.js";

// The SDK's OAuth client (discovery, dynamic client registration, PKCE, code
// exchange, refresh) does the protocol; this adapter only decides where its
// state lives. Tokens go to the vault cell of the user who signed in; the
// dynamically registered client is shared per server, since every user of this
// gateway redirects back to the same callback. PKCE verifier and the
// authorization URL stay in memory for the one flow that made them.

/** What the vault holds for kind "oauth2": the token response plus an absolute expiry. */
export type StoredTokens = OAuthTokens & { expires_at?: number };

/** The vault cell for a server's OAuth client (DCR result or operator-pasted id/secret). */
export const clientScope = (server: string): SecretScope => ({ org: "_gateway", user: "_client", server });

export const withExpiry = (t: OAuthTokens, now: number): StoredTokens =>
  t.expires_in === undefined ? { ...t } : { ...t, expires_at: now + t.expires_in * 1000 };

export class VaultOAuthProvider implements OAuthClientProvider {
  /** Set when the SDK starts an authorization: where the user has to go. */
  authorizationUrl?: URL;
  private verifier?: string;

  constructor(
    private store: SecretStore,
    private scope: SecretScope,
    private opts: { redirectUrl: string; state?: string; scopes?: string[]; clientId?: string; now?: () => number },
  ) {}

  get redirectUrl(): string {
    return this.opts.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "one-stop-mcp",
      redirect_uris: [this.opts.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none", // public client: PKCE instead of a secret
      ...(this.opts.scopes?.length ? { scope: this.opts.scopes.join(" ") } : {}),
    };
  }

  state(): string {
    return this.opts.state ?? randomBytes(32).toString("base64url");
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const stored = await this.store.get<OAuthClientInformationMixed>(clientScope(this.scope.server));
    return stored ?? (this.opts.clientId ? { client_id: this.opts.clientId } : undefined);
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await this.store.put(clientScope(this.scope.server), info, "client");
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const t = await this.store.get<StoredTokens>(this.scope);
    if (!t) return undefined;
    const { expires_at: _, ...tokens } = t;
    return tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.store.put(this.scope, withExpiry(tokens, (this.opts.now ?? Date.now)()), "oauth2");
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url; // the broker hands this to the user; nothing is opened here
  }

  saveCodeVerifier(v: string): void {
    this.verifier = v;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error("no PKCE verifier for this login (expired or restarted); run connect_server again");
    return this.verifier;
  }

  /** The SDK calls this when the server says a credential is dead (invalid_grant, invalid_client). */
  async invalidateCredentials(what: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (what === "all" || what === "tokens") await this.store.delete(this.scope);
    if (what === "all" || what === "client") await this.store.delete(clientScope(this.scope.server));
    if (what === "all" || what === "verifier") this.verifier = undefined;
  }
}
