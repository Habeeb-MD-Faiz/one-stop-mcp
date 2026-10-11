// OAuth end to end through the real gateway (burn-down S3): the composition root
// (createApp) in team mode, the node:http server, a bearer-authenticated MCP client
// on /mcp, connect_server, a "browser" that follows the authorization URL and lands
// on the gateway's own /oauth/callback, then invoke with the stored token. The
// authorization server and the downstream MCP server are the offline fakes L3 built.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server/app.js";
import { startHttp } from "../src/server/http.js";
import { startAuthServer, startMcpHttp } from "./fixtures/oauth-server.js";

const freePort = () =>
  new Promise<number>((ok) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
  });

type Result = { content: Array<{ text: string }>; isError?: boolean };

test("team gateway: connect_server -> authorize -> /oauth/callback on the gateway -> invoke", { timeout: 60_000 }, async () => {
  const as = await startAuthServer();
  const mcp = await startMcpHttp({ authServer: as.url, authorize: (req) => as.valid(req.headers.authorization?.replace(/^Bearer /, "")) });
  const home = mkdtempSync(join(tmpdir(), "osmcp-oauth-"));
  const servers = join(home, "servers");
  mkdirSync(servers);
  writeFileSync(join(servers, "remote.yaml"), `id: remote\nname: Remote\ncategory: [dev]\ndescription: Fake OAuth-protected MCP server.\ntransport:\n  type: streamable-http\n  url: ${mcp.url}\nauth:\n  type: oauth2\n`);
  const port = await freePort();
  const cfg = loadConfig({
    argv: ["serve", "--http"],
    env: { OSMCP_HOME: home, OSMCP_MASTER_KEY: "test-master-key-not-secret", OSMCP_SERVERS_DIR: servers, OSMCP_CATALOG_DIR: join(home, "shipped-catalog"), OSMCP_HOST: "127.0.0.1", OSMCP_PORT: String(port), OSMCP_EMBEDDINGS: "off" },
  });
  const app = await createApp(cfg, { schedule: false });
  const http = await startHttp(app);
  app.users.add("ann", "acme");
  const token = app.users.issueToken("ann").token;
  const client = new Client({ name: "oauth-e2e", version: "0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${http.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as Result;

    const before = await call("invoke", { server: "remote", tool: "whoami" });
    assert.ok(before.isError, "not connected yet");
    assert.match(before.content[0].text, /connect_server/);

    const c = JSON.parse((await call("connect_server", { server: "remote" })).content[0].text);
    assert.equal(c.status, "pending");
    assert.ok(c.url.startsWith(`${as.url}/authorize?`), c.url);

    const redirect = await fetch(c.url, { redirect: "manual" });
    assert.equal(redirect.status, 302);
    const callback = new URL(redirect.headers.get("location")!);
    assert.equal(`${callback.origin}${callback.pathname}`, `${http.url}/oauth/callback`, "the AS sends the browser back to this gateway");
    const landed = await fetch(callback);
    assert.equal(landed.status, 200);
    assert.match(await landed.text(), /close this tab/);

    const after = await call("invoke", { server: "remote", tool: "whoami" });
    assert.ok(!after.isError, after.content[0].text);
    assert.equal(after.content[0].text, "ok");
    assert.ok(app.ledger.all({ user: "ann" }).some((e) => e.tool === "auth.connect" && e.result === "authorized"));
  } finally {
    await client.close();
    await http.close();
    await app.close();
    await mcp.close();
    await as.close();
    rmSync(home, { recursive: true, force: true });
  }
});
