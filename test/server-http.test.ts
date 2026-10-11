import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttp } from "../src/server/http.js";
import type { App } from "../src/server/app.js";
import type { Config } from "../src/config.js";
import { Metrics } from "../src/server/metrics.js";
import { UserStore } from "../src/tenancy/users.js";
import type { LedgerEntry, LedgerInput } from "../src/contracts.js";

const dir = mkdtempSync(join(tmpdir(), "osmcp-http-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A fake App: real UserStore + Metrics, recording fakes for everything else. */
function fakeApp(mode: "local" | "team", name: string) {
  const ledger: LedgerEntry[] = [];
  const calls: unknown[][] = [];
  const cfg = { mode, home: dir, http: { host: "127.0.0.1", port: 0, publicUrl: "http://127.0.0.1:1" }, metrics: { token: mode === "team" ? "metrics-secret" : undefined } } as unknown as Config;
  const app = {
    cfg,
    users: new UserStore(join(dir, `${name}.json`)),
    metrics: new Metrics(),
    scrub: (t: string) => t.replace(/sk-\w+/g, "[REDACTED]"),
    ledger: {
      record: (e: LedgerInput) => (ledger.push(e as LedgerEntry), e as LedgerEntry),
      all: () => ledger,
      flagged: () => ledger.filter((e) => e.flagged),
    },
    kill: { status: () => ({ lockdown: false }), revokeAll: (by: string) => (calls.push(["revokeAll", by]), { closed: 2 }) },
    store: { isFrozen: false },
    verifyTotp: async (_p: unknown, code: string) => code === "123456",
    registry: {
      manifest: () => undefined,
      listServers: (p: unknown) => (calls.push(["listServers", p]), [{ id: "echo" }]),
      findTools: async () => ({ hits: [], confidence: "high", widened: false }),
      invoke: async () => ({ content: [{ type: "text", text: "ok" }] }),
    },
    auth: {
      connect: async () => ({ server: "x", auth: "none", status: "ready", message: "" }),
      handleOAuthCallback: async (q: URLSearchParams) => (q.get("state") === "good" ? { server: "gh", ok: true, message: "GitHub connected" } : { server: "", ok: false, message: "<script>unknown state sk-abc</script>" }),
      ticketInfo: (t: string) => (t === "T".repeat(43) ? { server: "brave", name: "Brave <Search>", keyUrl: "javascript:alert(1)", kind: "api_key" as const, account: "acme/<ann>" } : undefined),
      submitApiKey: async (t: string, key: string) => (calls.push(["submit", t, key]), { server: "brave", ok: true, message: "Brave connected" }),
    },
  };
  return { app: app as unknown as App, ledger, calls };
}

test("team /mcp: 401 without a token; MCP round trip with one; sessions bound to their principal", async () => {
  const { app, calls } = fakeApp("team", "mcp");
  app.users.add("ana", "acme");
  app.users.add("bo", "acme");
  const ana = app.users.issueToken("ana").token;
  const bo = app.users.issueToken("bo").token;
  const http = await startHttp(app);
  try {
    const noAuth = await fetch(`${http.url}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    assert.equal(noAuth.status, 401);
    assert.match(noAuth.headers.get("www-authenticate") ?? "", /^Bearer/);

    const transport = new StreamableHTTPClientTransport(new URL(`${http.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${ana}` } } });
    const client = new Client({ name: "t", version: "0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 4);
    const res: any = await client.callTool({ name: "list_servers", arguments: {} });
    assert.deepEqual(JSON.parse(res.content[0].text), [{ id: "echo" }]);
    assert.deepEqual(calls.at(-1), ["listServers", { user: "ana", org: "acme", admin: false }], "dispatch carries the bearer's principal");

    const hijack = await fetch(`${http.url}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${bo}`, "mcp-session-id": transport.sessionId!, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
    });
    assert.equal(hijack.status, 404, "another user's token cannot ride the session");
    assert.match((await fetch(`${http.url}/metrics`, { headers: { authorization: "Bearer metrics-secret" } }).then((r) => r.text())), /osmcp_sessions_active 1/);
    await client.close();
  } finally {
    await http.close();
  }
});

test("admin API: needs an admin bearer AND a TOTP code; throttles guessing; ledgers every attempt", async () => {
  const { app, ledger, calls } = fakeApp("team", "admin");
  app.users.add("root", "ops", true);
  app.users.add("eve", "ops");
  const root = app.users.issueToken("root").token;
  const eve = app.users.issueToken("eve").token;
  const http = await startHttp(app);
  const call = (token: string | undefined, totp?: string, path = "kill/all") =>
    fetch(`${http.url}/admin/api/${path}`, { method: "POST", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(totp ? { "x-osmcp-totp": totp } : {}) } });
  try {
    assert.equal((await call(undefined, "123456")).status, 401);
    assert.equal((await call(eve, "123456")).status, 403, "non-admins refused");
    assert.equal((await call(root)).status, 401, "missing TOTP refused");
    assert.equal((await call(root, "000000")).status, 401, "wrong TOTP refused");
    assert.equal(calls.length, 0, "nothing ran");
    const ok = await call(root, "123456");
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { closed: 2 });
    assert.deepEqual(calls.at(-1), ["revokeAll", "ops/root"]);
    const sid = ok.headers.get("x-osmcp-admin-session");
    assert.ok(sid, "a good code opens a short admin session");
    const viaSession = (token?: string) =>
      fetch(`${http.url}/admin/api/kill/all`, { method: "POST", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "x-osmcp-admin-session": sid! } });
    assert.equal((await viaSession(root)).status, 200, "the session stands in for a fresh code");
    assert.equal((await viaSession()).status, 401, "but never for the bearer");
    assert.equal((await call(root, "123456", "nope/route")).status, 404);

    const burst = await Promise.all(Array.from({ length: 8 }, () => call(root, "999999")));
    assert.ok(burst.filter((r) => r.status === 401).length <= 5, "guesses sent in parallel each cost a strike");
    assert.equal((await call(root, "123456")).status, 429, "locked out after repeated wrong codes");
    assert.equal((await viaSession(root)).status, 200, "a lockout does not cut off an admin already signed in");
    assert.ok(!ledger.some((e) => e.user === "anonymous"), "requests without a known token are not ledgered");

    const denied = ledger.filter((e) => e.result === "denied").length;
    assert.ok(denied >= 9, `every refused attempt is ledgered (got ${denied})`);
    assert.ok(ledger.some((e) => e.tool === "admin.kill.all" && e.result === "authorized"));

    const page = await fetch(`${http.url}/admin`);
    assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'sha256-/);
    assert.match(await page.text(), /Revoke all/);
  } finally {
    await http.close();
  }
});

test("key entry: escaped form, no unsafe links, same-origin POST only; OAuth callback page escapes", async () => {
  const { app, calls } = fakeApp("team", "connect");
  const http = await startHttp(app);
  const ticket = "T".repeat(43);
  try {
    const form = await fetch(`${http.url}/connect/${ticket}`);
    assert.equal(form.status, 200);
    for (const [h, v] of [["referrer-policy", "no-referrer"], ["x-frame-options", "DENY"], ["cache-control", "no-store"]]) assert.equal(form.headers.get(h), v);
    assert.match(form.headers.get("content-security-policy") ?? "", /form-action 'self'/);
    const text = await form.text();
    assert.ok(text.includes("Brave &#60;Search&#62;") && !text.includes("<Search>"), "server name escaped");
    assert.ok(!text.includes("javascript:"), "non-http keyUrl dropped");
    assert.ok(text.includes("acme/&#60;ann&#62;"), "the page names the account the key is saved for, escaped");

    assert.equal((await fetch(`${http.url}/connect/${"U".repeat(43)}`)).status, 404, "unknown ticket");
    const post = (headers: Record<string, string>) =>
      fetch(`${http.url}/connect/${ticket}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: "key=sk-test-123" });
    assert.equal((await post({ origin: "https://evil.example" })).status, 403);
    assert.equal((await post({ "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal(calls.length, 0, "rejected posts never reach the broker");
    const ok = await post({ origin: http.url, "sec-fetch-site": "same-origin" });
    assert.equal(ok.status, 200);
    assert.deepEqual(calls.at(-1), ["submit", ticket, "sk-test-123"]);
    assert.ok(!(await ok.text()).includes("sk-test-123"), "the key is never echoed");

    const good = await fetch(`${http.url}/oauth/callback?code=c&state=good`);
    assert.equal(good.status, 200);
    const bad = await fetch(`${http.url}/oauth/callback?code=c&state=bad`);
    assert.equal(bad.status, 400);
    const badText = await bad.text();
    assert.ok(!badText.includes("<script>") && !badText.includes("sk-abc"), "escaped and scrubbed");
  } finally {
    await http.close();
  }
});

test("metrics need the token; local mode serves only auth pages on loopback with a Host check", async () => {
  const team = await startHttp(fakeApp("team", "m").app);
  try {
    assert.equal((await fetch(`${team.url}/metrics`)).status, 401);
    const m = await fetch(`${team.url}/metrics`, { headers: { authorization: "Bearer metrics-secret" } });
    assert.match(m.headers.get("content-type") ?? "", /^text\/plain; version=0\.0\.4/);
    const body = await m.text();
    assert.match(body, /# TYPE osmcp_invocations_total counter/);
    assert.match(body, /osmcp_invoke_duration_seconds_bucket\{le="\+Inf"\} 0/);
  } finally {
    await team.close();
  }

  const local = await startHttp(fakeApp("local", "l").app);
  try {
    assert.equal((await fetch(`${local.url}/healthz`)).status, 200);
    for (const p of ["/mcp", "/admin", "/admin/api/kill", "/metrics"]) assert.equal((await fetch(`${local.url}${p}`)).status, 404, `${p} is team-only`);
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve) => request(`${local.url}/healthz`, { headers: { host: "evil.example:80" } }, (r) => resolve(r.statusCode!)).end());
    assert.equal(status, 403, "DNS-rebinding Host refused");
  } finally {
    await local.close();
  }
});
