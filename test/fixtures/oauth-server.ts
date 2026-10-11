// Offline fakes for the OAuth tests, all on 127.0.0.1 with ephemeral ports — no
// real provider is ever contacted.
//  - startAuthServer: RFC 8414 metadata, RFC 7591 /register, /authorize that
//    302s straight back with code + state, /token that verifies PKCE S256 and
//    rotates refresh tokens.
//  - startMcpHttp: a Streamable HTTP MCP server (SDK Server + transport on
//    node:http) behind a pluggable credential check; with an AS it serves RFC
//    9728 protected-resource metadata and answers 401 + WWW-Authenticate.
//  - startLegacySse: an HTTP+SSE (2024-11-05) server that rejects Streamable POSTs.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => unknown;

async function listen(handler: Handler): Promise<{ url: string; close(): Promise<void> }> {
  const http: HttpServer = createServer((req, res) => {
    Promise.resolve(handler(req, res, new URL(req.url ?? "/", "http://127.0.0.1"))).catch((err) => {
      if (!res.headersSent) res.writeHead(500).end(String(err));
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return {
    url,
    close: () =>
      new Promise<void>((r) => {
        http.closeAllConnections();
        http.close(() => r());
      }),
  };
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));

async function body(req: IncomingMessage): Promise<string> {
  let s = "";
  for await (const chunk of req) s += chunk;
  return s;
}

const b64url = (buf: Buffer) => buf.toString("base64url");
const token = () => b64url(randomBytes(24));

export interface FakeAuthServer {
  url: string;
  /** Grant types the token endpoint has honoured, in order. */
  grants: string[];
  valid(accessToken: string | undefined): boolean;
  /** Invalidate every access token issued so far (simulates expiry). */
  expireAll(): void;
  close(): Promise<void>;
}

export async function startAuthServer(opts: { staticClients?: { client_id: string; client_secret?: string }[]; ttlSec?: number } = {}): Promise<FakeAuthServer> {
  const clients = new Map<string, { secret?: string; redirects?: string[] }>();
  for (const c of opts.staticClients ?? []) clients.set(c.client_id, { secret: c.client_secret });
  const codes = new Map<string, { client: string; redirect: string; challenge: string }>();
  const access = new Set<string>();
  const refresh = new Map<string, string>(); // refresh token -> client id
  const grants: string[] = [];

  const issue = (client: string) => {
    const t = { access_token: token(), token_type: "Bearer", expires_in: opts.ttlSec ?? 3600, refresh_token: token() };
    access.add(t.access_token);
    refresh.set(t.refresh_token, client);
    return t;
  };

  const srv = await listen(async (req, res, url) => {
    const base = srv.url;
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
      });
    }
    if (url.pathname === "/register" && req.method === "POST") {
      const meta = JSON.parse(await body(req)) as { redirect_uris?: string[] };
      if (!meta.redirect_uris?.length) return json(res, 400, { error: "invalid_redirect_uri" });
      const client_id = token();
      clients.set(client_id, { redirects: meta.redirect_uris });
      return json(res, 201, { ...meta, client_id, client_id_issued_at: Math.floor(Date.now() / 1000) });
    }
    if (url.pathname === "/authorize") {
      const q = url.searchParams;
      const client = clients.get(q.get("client_id") ?? "");
      const redirect = q.get("redirect_uri") ?? "";
      if (!client || (client.redirects && !client.redirects.includes(redirect))) return json(res, 400, { error: "invalid_client" });
      if (q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) return json(res, 400, { error: "invalid_request" });
      const code = token();
      codes.set(code, { client: q.get("client_id")!, redirect, challenge: q.get("code_challenge")! });
      const back = new URL(redirect);
      back.searchParams.set("code", code);
      if (q.get("state")) back.searchParams.set("state", q.get("state")!);
      return void res.writeHead(302, { location: back.href }).end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const f = new URLSearchParams(await body(req));
      let [id, secret] = [f.get("client_id") ?? "", f.get("client_secret") ?? undefined];
      const basic = req.headers.authorization?.match(/^Basic (.+)$/)?.[1];
      if (basic) [id, secret] = Buffer.from(basic, "base64").toString().split(":").map(decodeURIComponent);
      const client = clients.get(id);
      if (!client || (client.secret !== undefined && client.secret !== secret)) return json(res, 401, { error: "invalid_client" });
      const grant = f.get("grant_type") ?? "";
      if (grant === "authorization_code") {
        const c = codes.get(f.get("code") ?? "");
        codes.delete(f.get("code") ?? "");
        const verifier = f.get("code_verifier") ?? "";
        if (!c || c.client !== id || c.redirect !== f.get("redirect_uri") || b64url(createHash("sha256").update(verifier).digest()) !== c.challenge) {
          return json(res, 400, { error: "invalid_grant" });
        }
      } else if (grant === "refresh_token") {
        const rt = f.get("refresh_token") ?? "";
        if (refresh.get(rt) !== id) return json(res, 400, { error: "invalid_grant" });
        refresh.delete(rt);
      } else return json(res, 400, { error: "unsupported_grant_type" });
      grants.push(grant);
      return json(res, 200, issue(id));
    }
    json(res, 404, { error: "not_found" });
  });

  return { url: srv.url, grants, valid: (t) => !!t && access.has(t), expireAll: () => access.clear(), close: srv.close };
}

/** Tools: whoami -> "ok"; leak_header {name} -> that request header's value (a misbehaving downstream). */
function toolServer(headers: IncomingMessage["headers"]): Server {
  const server = new Server({ name: "fake-http", version: "0.0.0" }, { capabilities: { tools: {} } });
  const nameArg = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "whoami", description: "Confirm the call reached the server.", inputSchema: { type: "object" } },
      { name: "leak_header", description: "Echo a request header.", inputSchema: nameArg },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === "whoami") return { content: [{ type: "text", text: "ok" }] };
    const h = headers[String(req.params.arguments?.name ?? "").toLowerCase()];
    return { content: [{ type: "text", text: `header=${h ?? ""}` }] };
  });
  return server;
}

export async function startMcpHttp(opts: { authorize: (req: IncomingMessage) => boolean; authServer?: string }): Promise<{ url: string; close(): Promise<void> }> {
  const srv = await listen(async (req, res, url) => {
    const prm = `${srv.url}/.well-known/oauth-protected-resource/mcp`;
    if (opts.authServer && url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return json(res, 200, { resource: `${srv.url}/mcp`, authorization_servers: [opts.authServer] });
    }
    if (url.pathname !== "/mcp") return json(res, 404, { error: "not_found" });
    if (!opts.authorize(req)) {
      const challenge = opts.authServer ? `Bearer resource_metadata="${prm}"` : "Bearer";
      return json(res, 401, { error: "invalid_token" }, { "www-authenticate": challenge });
    }
    if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" }); // stateless: no standalone SSE stream
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = toolServer(req.headers);
    res.on("close", () => void server.close());
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  return { url: `${srv.url}/mcp`, close: srv.close };
}

export async function startLegacySse(): Promise<{ url: string; close(): Promise<void> }> {
  const sessions = new Map<string, SSEServerTransport>();
  const srv = await listen(async (req, res, url) => {
    if (url.pathname === "/sse" && req.method === "GET") {
      const transport = new SSEServerTransport("/messages", res);
      sessions.set(transport.sessionId, transport);
      res.on("close", () => sessions.delete(transport.sessionId));
      return toolServer(req.headers).connect(transport);
    }
    if (url.pathname === "/messages" && req.method === "POST") {
      const t = sessions.get(url.searchParams.get("sessionId") ?? "");
      return t ? t.handlePostMessage(req, res) : json(res, 404, { error: "unknown session" });
    }
    json(res, 405, { error: "method_not_allowed" }); // a Streamable POST to /sse lands here
  });
  return { url: `${srv.url}/sse`, close: srv.close };
}
