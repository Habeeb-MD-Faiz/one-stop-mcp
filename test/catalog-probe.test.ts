// PR probe against an in-process fake streamable-http MCP server on 127.0.0.1 and
// the real stdio echo example.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { probeManifest } from "../src/catalog/probe.js";
import type { Manifest } from "../src/types.js";

const echoPath = fileURLToPath(new URL("../examples/echo-server.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const base = (over: Partial<Manifest>): Manifest => ({ id: "t", name: "T", category: ["dev"], description: "d", transport: { type: "stdio", command: "node" }, auth: { type: "none" }, ...over });
const stdio = (over: Partial<Manifest> = {}) => base({ transport: { type: "stdio", command: process.execPath, args: [echoPath] }, ...over });
const http = (url: string, over: Partial<Manifest> = {}) => base({ transport: { type: "streamable-http", url }, ...over });

/** /ok speaks just enough MCP (initialize, tools/list, 202 for notifications);
 *  /auth answers 401 + WWW-Authenticate; /bare401 and everything else do not. */
async function withFake<T>(fn: (origin: string) => Promise<T>): Promise<T> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/auth") return void res.writeHead(401, { "www-authenticate": 'Bearer resource_metadata="http://x/.well-known"' }).end();
      if (req.url === "/bare401") return void res.writeHead(401).end();
      if (req.url !== "/ok" || req.method !== "POST") return void res.writeHead(req.url === "/ok" ? 405 : 404).end();
      const msg = JSON.parse(body);
      if (msg.id === undefined) return void res.writeHead(202).end();
      const result =
        msg.method === "initialize"
          ? { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "9" } }
          : msg.method === "tools/list"
            ? { tools: [{ name: "a", inputSchema: { type: "object" } }, { name: "b", inputSchema: { type: "object" } }] }
            : {};
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

test("http: initialize ok, tools/list counted, 401 + WWW-Authenticate is reachable, anything else fails", async () => {
  await withFake(async (o) => {
    const t = { timeoutMs: 5000 };
    assert.deepEqual(await probeManifest(http(`${o}/ok`), t), { id: "t", status: "ok", note: "initialize ok (fake 9)" });
    assert.equal((await probeManifest(http(`${o}/ok`, { health: { check: "tools/list" } }), t)).note, "initialize ok (fake 9), 2 tool(s)");
    const auth = await probeManifest(http(`${o}/auth`, { auth: { type: "oauth2" } }), t);
    assert.deepEqual([auth.status, auth.note], ["ok", "reachable, requires auth (401 + WWW-Authenticate)"]);
    const bare = await probeManifest(http(`${o}/bare401`), t);
    assert.equal(bare.status, "fail");
    assert.match(bare.note, /HTTP 401/);
    assert.equal((await probeManifest(http(`${o}/missing`), t)).status, "fail");
  });
  // nothing listening: fails fast rather than hanging
  const dead = await probeManifest(http("http://127.0.0.1:1/mcp"), { timeoutMs: 5000 });
  assert.equal(dead.status, "fail");
});

test("stdio: auth none is spawned and initialized; credentials, no-spawn and health none are skipped", async () => {
  const ok = await probeManifest(stdio(), { cwd: repoRoot, timeoutMs: 15000 });
  assert.deepEqual([ok.status, ok.note], ["ok", "initialize ok (echo 0.0.0)"]);
  assert.match((await probeManifest(stdio({ health: { check: "tools/list" } }), { cwd: repoRoot, timeoutMs: 15000 })).note, /1 tool\(s\)$/);

  const keyed = await probeManifest(stdio({ auth: { type: "api_key", env: "K" } }));
  assert.deepEqual([keyed.status, keyed.note], ["skip", "needs credentials (auth api_key); not probed"]);
  assert.equal((await probeManifest(stdio(), { spawn: false })).note, "stdio spawn disabled");
  assert.equal((await probeManifest(stdio({ health: { check: "none" } }))).status, "skip");

  const missing = await probeManifest(base({ transport: { type: "stdio", command: "definitely-not-a-real-command-xyz" } }), { timeoutMs: 5000 });
  assert.equal(missing.status, "fail");
});
