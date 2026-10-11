// The gateway's HTTP face, node:http only (D15, D23).
//   local mode: loopback only, and only what a stdio gateway needs a browser for —
//               /oauth/callback, /connect/:ticket (key entry), /healthz.
//   team mode:  also /mcp (Streamable HTTP, one gateway Server per session, bound to
//               the bearer's principal), /admin + /admin/api/* (admin bearer AND a
//               TOTP code, D16), /metrics (Prometheus, D24).
// Secrets are typed into the gateway's own page, never into the chat (D18).
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Principal } from "../contracts.js";
import { ADMIN_CSP, ADMIN_PAGE, HttpError, adminCall } from "./admin.js";
import type { App } from "./app.js";
import { buildGateway } from "./gateway.js";

export interface HttpHandle {
  server: HttpServer;
  url: string;
  close(): Promise<void>;
}

const BODY_MAX = 1 << 20; // 1 MB: admin JSON, key-entry forms
const MCP_BODY_MAX = 4 << 20; // tool arguments can be larger
const SESSION_IDLE_MS = 30 * 60_000;
const TOTP_MAX_FAILS = 5; // per admin, per window (RFC 4226 §7.3 throttling)
const TOTP_LOCK_MS = 5 * 60_000;
const ADMIN_SESSION_MS = 15 * 60_000; // how long one TOTP code unlocks the admin API
const TICKET = /^[A-Za-z0-9_-]{16,128}$/;

const PAGE_STYLE = "body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem}label{display:block;margin:.8rem 0}input{display:block;width:100%;padding:.4rem;box-sizing:border-box}button{margin-top:1rem;padding:.4rem 1rem}";
const PAGE_CSP = `default-src 'none'; style-src 'sha256-${createHash("sha256").update(PAGE_STYLE).digest("base64")}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

interface Session {
  transport: StreamableHTTPServerTransport;
  principal: Principal;
  seen: number;
}

export async function startHttp(app: App): Promise<HttpHandle> {
  const team = app.cfg.mode === "team";
  const sessions = new Map<string, Session>();
  const totpFails = new Map<string, { n: number; until: number }>();
  const adminSessions = new Map<string, { key: string; exp: number }>(); // session id -> org/user
  let allowedHosts = new Set<string>();
  if (team) app.metrics.gauge("osmcp_sessions_active", "Live Streamable HTTP client sessions.", () => sessions.size);

  const server = createServer((req, res) => {
    route(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error("one-stop-mcp http:", app.scrub(String((err as Error)?.stack ?? err)));
      if (res.headersSent) return void res.end();
      sendJson(res, status, { error: status === 500 ? "internal error" : (err as Error).message });
    });
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    // Loopback DNS-rebinding guard: a hostile page that rebinds its name to 127.0.0.1
    // still sends its own Host header.
    if (!team && !allowedHosts.has(req.headers.host ?? "")) throw new HttpError(403, "unexpected Host header");
    const url = new URL(req.url ?? "/", "http://gateway");
    const path = url.pathname;
    const get = req.method === "GET";

    if (path === "/healthz" && get) return sendJson(res, 200, { ok: true });
    if (path === "/oauth/callback" && get) return oauthCallback(url, res);
    if (path.startsWith("/connect/")) return keyEntry(req, res, path.slice("/connect/".length));
    if (team) {
      if (path === "/mcp") return mcp(req, res);
      if (path === "/metrics" && get) return metrics(req, res);
      if (path === "/admin" && get) return html(res, 200, ADMIN_PAGE, ADMIN_CSP);
      if (path.startsWith("/admin/api/")) return admin(req, res, url);
    }
    throw new HttpError(404, "not found");
  }

  // --- /mcp: Streamable HTTP, sessions bound to the caller ---------------------

  async function mcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const principal = app.users.authenticate(bearer(req));
    if (!principal) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="one-stop-mcp"');
      throw new HttpError(401, "bearer token required");
    }
    const sid = header(req, "mcp-session-id");
    if (sid) {
      const s = sessions.get(sid);
      // A session belongs to whoever opened it; another token cannot ride it.
      if (!s || s.principal.user !== principal.user || s.principal.org !== principal.org) throw new HttpError(404, "session not found");
      s.seen = Date.now();
      return s.transport.handleRequest(req, res, req.method === "POST" ? await readJson(req, MCP_BODY_MAX) : undefined);
    }
    if (req.method !== "POST") throw new HttpError(400, "mcp-session-id header required");
    const body = await readJson(req, MCP_BODY_MAX);
    if (!isInitializeRequest(body)) throw new HttpError(400, "no session: the first request must be initialize");
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => void sessions.set(id, { transport, principal, seen: Date.now() }),
    });
    transport.onclose = () => void (transport.sessionId && sessions.delete(transport.sessionId));
    await buildGateway(app, principal).connect(transport);
    await transport.handleRequest(req, res, body);
  }

  // Clients that vanish without DELETE would otherwise hold a session forever.
  const reaper = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const s of sessions.values()) if (s.seen < cutoff) void s.transport.close();
  }, 60_000);
  reaper.unref();

  // --- admin API: admin bearer AND TOTP, every attempt ledgered ----------------

  async function admin(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const p = app.users.authenticate(bearer(req));
    const deny = (status: number, why: string): never => {
      // An unknown token is not ledgered: anyone who can reach the port could grow the ledger without bound.
      if (p) app.ledger.record({ ts: Date.now(), org: p.org, user: p.user, server: "_admin", tool: "admin.auth", result: "denied", reason: why });
      if (status === 401) res.setHeader("WWW-Authenticate", 'Bearer realm="one-stop-mcp-admin"');
      throw new HttpError(status, why);
    };
    if (!p) return deny(401, "admin bearer token required");
    if (!p.admin) return deny(403, "not an admin");
    const key = `${p.org}/${p.user}`;
    const now = Date.now();
    // A TOTP code is accepted once (RFC 6238 §5.2) and unlocks a short admin session so
    // the admin page can make several calls; the bearer is still required on every call.
    // A live session is checked first, so a lockout cannot cut off an admin already signed in.
    const sid = header(req, "x-osmcp-admin-session");
    const s = sid ? adminSessions.get(sid) : undefined;
    if (!s || s.key !== key || s.exp <= now) {
      let fails = totpFails.get(key);
      if (!fails || fails.until <= now) totpFails.set(key, (fails = { n: 0, until: now + TOTP_LOCK_MS }));
      if (fails.n >= TOTP_MAX_FAILS) return deny(429, "too many wrong TOTP codes; try again later");
      fails.n++; // counted before the await, so guesses sent in parallel each cost a strike
      const code = header(req, "x-osmcp-totp");
      if (!code || !/^\d{6}$/.test(code) || !(await app.verifyTotp(p, code))) return deny(401, "a valid X-OSMCP-TOTP code is required");
      totpFails.delete(key);
      for (const [id, x] of adminSessions) if (x.exp <= now) adminSessions.delete(id);
      const id = randomBytes(32).toString("base64url");
      adminSessions.set(id, { key, exp: now + ADMIN_SESSION_MS });
      res.setHeader("x-osmcp-admin-session", id);
    }
    const body = req.method === "POST" ? ((await readJson(req, BODY_MAX, true)) as Record<string, unknown>) : {};
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "body must be a JSON object");
    sendJson(res, 200, await adminCall(app, p, req.method ?? "GET", url.pathname.slice("/admin/api/".length), url.searchParams, body));
  }

  // --- metrics -----------------------------------------------------------------

  function metrics(req: IncomingMessage, res: ServerResponse): void {
    const token = app.cfg.metrics.token;
    if (token && !safeEqual(bearer(req) ?? "", token)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="one-stop-mcp-metrics"');
      throw new HttpError(401, "metrics token required");
    }
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" }).end(app.metrics.render());
  }

  // --- browser pages: OAuth callback and key entry ------------------------------

  async function oauthCallback(url: URL, res: ServerResponse): Promise<void> {
    const r = await app.auth.handleOAuthCallback(url.searchParams).catch((err) => ({ server: "", ok: false, message: (err as Error).message }));
    const body = `<p>${esc(app.scrub(r.message))}</p>` + (r.ok ? "<p>You can close this tab and return to your chat.</p>" : "<p>Ask your assistant to run connect_server again.</p>");
    html(res, r.ok ? 200 : 400, page(r.ok ? "Connected" : "Connection failed", body));
  }

  async function keyEntry(req: IncomingMessage, res: ServerResponse, ticket: string): Promise<void> {
    const info = TICKET.test(ticket) ? app.auth.ticketInfo(ticket) : undefined;
    if (!info) return html(res, 404, page("Link expired", "<p>This key-entry link is unknown or has expired. Ask your assistant to run connect_server again.</p>"));
    if (req.method === "GET") return html(res, 200, keyForm(info));
    if (req.method !== "POST") throw new HttpError(405, "method not allowed");
    if (!sameOrigin(req)) throw new HttpError(403, "cross-origin form posts are refused");

    const form = new URLSearchParams(await readText(req, BODY_MAX));
    let key = (form.get("key") ?? "").trim();
    if (info.kind === "client") {
      const clientId = (form.get("client_id") ?? "").trim();
      const clientSecret = (form.get("client_secret") ?? "").trim();
      key = clientId ? JSON.stringify({ client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}) }) : "";
    }
    if (!key) return html(res, 400, keyForm(info, "Nothing was entered."));
    const r = await app.auth.submitApiKey(ticket, key).catch((err) => ({ server: info.server, ok: false, message: (err as Error).message }));
    const body = `<p>${esc(app.scrub(r.message))}</p>` + (r.ok ? "<p>Saved to the gateway's encrypted vault. You can close this tab and return to your chat.</p>" : "");
    html(res, r.ok ? 200 : 400, page(r.ok ? `Connected ${info.name}` : "Not saved", body));
  }

  /** Same-origin only: Sec-Fetch-Site from modern browsers, Origin as the fallback. */
  function sameOrigin(req: IncomingMessage): boolean {
    const site = header(req, "sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") return false;
    const origin = header(req, "origin");
    if (!origin) return true; // non-browser client; the unguessable ticket is the credential
    const host = req.headers.host ?? "";
    return origin === new URL(app.cfg.http.publicUrl).origin || origin === `http://${host}` || origin === `https://${host}`;
  }

  // --- lifecycle ---------------------------------------------------------------

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(app.cfg.http.port, app.cfg.http.host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, new URL(app.cfg.http.publicUrl).host]);
  return {
    server,
    url: `http://${app.cfg.http.host === "0.0.0.0" ? "127.0.0.1" : app.cfg.http.host}:${port}`,
    async close() {
      clearInterval(reaper);
      await Promise.all([...sessions.values()].map((s) => s.transport.close().catch(() => {})));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

function keyForm(info: { server: string; name: string; keyUrl?: string; kind: "api_key" | "client"; account: string }, error?: string): string {
  const name = esc(info.name);
  let link = "";
  try {
    const u = new URL(info.keyUrl ?? "");
    if (u.protocol === "https:" || u.protocol === "http:") link = `<p><a href="${esc(u.href)}" target="_blank" rel="noopener noreferrer">Get a key from ${esc(u.host)}</a></p>`;
  } catch {
    // no link
  }
  const fields =
    info.kind === "client"
      ? `<label>OAuth client ID<input name="client_id" autocomplete="off" required></label><label>Client secret (if the provider issued one)<input name="client_secret" type="password" autocomplete="off"></label>`
      : `<label>API key<input name="key" type="password" autocomplete="off" required></label>`;
  // Naming the account lets someone sent another person's link notice before they hand over their key.
  const intro = info.kind === "client" ? `Paste the OAuth client you registered for <b>${name}</b>. It will be used by ${esc(info.account)}.` : `Paste your API key for <b>${name}</b>. It will be saved for <b>${esc(info.account)}</b>.`;
  return page(
    `Connect ${info.name}`,
    `${error ? `<p role="alert">${esc(error)}</p>` : ""}<p>${intro} It is encrypted into the gateway's vault and never shown to the model.</p>${link}<form method="post">${fields}<button>Save</button></form>`,
  );
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${PAGE_STYLE}</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`;
}

function html(res: ServerResponse, status: number, body: string, csp = PAGE_CSP): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "content-security-policy": csp }).end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function bearer(req: IncomingMessage): string | undefined {
  const m = /^Bearer\s+(\S+)$/i.exec(header(req, "authorization") ?? "");
  return m?.[1];
}

function safeEqual(a: string, b: string): boolean {
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(a), h(b));
}

async function readText(req: IncomingMessage, max: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new HttpError(413, `body over ${max} bytes`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req: IncomingMessage, max: number, emptyOk = false): Promise<unknown> {
  const text = await readText(req, max);
  if (!text && emptyOk) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}
