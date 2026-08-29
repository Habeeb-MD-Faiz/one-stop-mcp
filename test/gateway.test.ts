import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildGateway } from "../src/gateway.js";
import { Registry } from "../src/registry.js";
import { parseManifest } from "../src/manifest.js";
import { META_TOOLS } from "../src/meta-tools.js";
import type { Manifest } from "../src/types.js";

const echoPath = fileURLToPath(new URL("../examples/echo-server.mjs", import.meta.url));

function echoManifest(): Manifest {
  return {
    id: "echo",
    name: "Echo",
    category: ["dev", "testing"],
    description: "echo server",
    transport: { type: "stdio", command: process.execPath, args: [echoPath] },
    auth: { type: "none" },
    routing: { examples: ["echo this message back"] },
  };
}

/** Wire an in-memory client to the gateway; the gateway proxies to the echo
 *  server over real stdio. Returns the client and a JSON-unwrapping caller. */
async function connectGateway(registry: Registry) {
  const gateway = buildGateway(registry);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await gateway.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res: any = await client.callTool({ name, arguments: args });
    assert.ok(!res.isError, `${name} errored: ${res.content?.[0]?.text}`);
    return JSON.parse(res.content[0].text);
  };
  return { client, call };
}

test("client sees exactly the four meta-tools, never downstream schemas", async () => {
  const registry = new Registry([echoManifest()]);
  const { client } = await connectGateway(registry);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["connect_server", "find_tools", "invoke", "list_servers"]);
  await registry.closeAll();
  await client.close();
});

test("lazy: server registered but not running until first use", async () => {
  const registry = new Registry([echoManifest()]);
  const { call } = await connectGateway(registry);
  const before = await call("list_servers", {});
  assert.equal(before[0].id, "echo");
  assert.equal(before[0].running, false, "should not spawn at startup");

  const hits = await call("find_tools", { query: "echo a message" });
  assert.ok(hits.some((h: any) => h.tool === "echo"), "find_tools should surface echo");
  assert.ok(hits[0].inputSchema, "shortlist carries the schema JIT");

  const after = await call("list_servers", {});
  assert.equal(after[0].running, true, "discovery spawned the session");
  await registry.closeAll();
});

test("invoke proxies end-to-end over stdio and returns the downstream result", async () => {
  const registry = new Registry([echoManifest()]);
  const { call } = await connectGateway(registry);
  const result = await call("invoke", { server: "echo", tool: "echo", args: { message: "round trip" } });
  assert.equal(result.content[0].text, "round trip");
  await registry.closeAll();
});

test("connect_server reports auth status without a broker (P0 stub)", async () => {
  const registry = new Registry([echoManifest()]);
  const { call } = await connectGateway(registry);
  const r = await call("connect_server", { server: "echo" });
  assert.equal(r.status, "ready");
  assert.equal(r.auth, "none");
  await registry.closeAll();
});

test("manifest validation rejects a stdio server with no command", () => {
  assert.throws(() => parseManifest("id: x\nname: X\ntransport:\n  type: stdio\n", "x.yaml"), /needs command/);
});

test("startup surface stays under the 2k-token budget", () => {
  const estTokens = Math.ceil(JSON.stringify({ tools: META_TOOLS }).length / 4);
  assert.ok(estTokens < 2000, `startup surface ~${estTokens} tokens exceeds budget`);
});
