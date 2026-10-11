import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildGateway, type GatewayDeps } from "../src/server/gateway.js";
import { META_TOOLS } from "../src/server/meta-tools.js";
import { Metrics } from "../src/server/metrics.js";
import { AccessDeniedError, type Principal } from "../src/contracts.js";
import type { Manifest } from "../src/types.js";

const ana: Principal = { user: "ana", org: "acme", admin: false };
const echo = { id: "echo", name: "Echo", category: ["dev"], description: "echo", transport: { type: "stdio", command: "node" } } as Manifest;

/** A fake registry + broker that record who called them with what. */
function fakes() {
  const calls: Array<[string, ...unknown[]]> = [];
  const deps: GatewayDeps = {
    registry: {
      manifest: (id) => (id === "echo" ? echo : undefined),
      listServers: (p, filter) => (calls.push(["listServers", p, filter]), [{ id: "echo", connected: false }]),
      findTools: async (p, query, k) => {
        calls.push(["findTools", p, query, k]);
        const hit = { server: "echo", tool: "echo", description: "Echo it", examples: ["x"], category: ["dev"], inputSchema: { type: "object" }, score: 0.123456 };
        return { hits: [hit], confidence: "low", widened: true, browse: ["dev"] };
      },
      invoke: async (p, server, tool, args) => {
        calls.push(["invoke", p, server, tool, args]);
        if (tool === "boom") throw new Error("upstream said: Bearer sk-live-SECRET123");
        if (server === "locked") throw new AccessDeniedError("server locked is revoked");
        return { content: [{ type: "text", text: String(args.message) }] };
      },
    },
    auth: { connect: async (p, server) => (calls.push(["connect", p, server]), { server, auth: "api_key", status: "pending", url: "http://127.0.0.1:8420/connect/t", message: "open the link" }) },
    metrics: new Metrics(),
    scrub: (t) => t.replace(/sk-live-\w+/g, "[REDACTED]"),
  };
  return { deps, calls };
}

async function connect(deps: GatewayDeps, p = ana) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildGateway(deps, p).connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as any;
  return { client, call, json: async (name: string, args: Record<string, unknown>) => JSON.parse((await call(name, args)).content[0].text) };
}

test("client sees exactly the four meta-tools; list_servers filters by category, tag, auth", async () => {
  const { client } = await connect(fakes().deps);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["connect_server", "find_tools", "invoke", "list_servers"]);
  const props = tools.find((t) => t.name === "list_servers")!.inputSchema.properties!;
  assert.deepEqual(Object.keys(props).sort(), ["auth", "category", "filter", "tag"]);
  await client.close();
});

test("every meta-tool dispatches with the caller's principal", async () => {
  const { deps, calls } = fakes();
  const { json, call } = await connect(deps);

  const found = await json("find_tools", { query: "echo a message", k: 500 });
  assert.deepEqual(calls.at(-1), ["findTools", ana, "echo a message", 25], "k is clamped");
  assert.deepEqual(found, { tools: [{ server: "echo", tool: "echo", description: "Echo it", inputSchema: { type: "object" }, score: 0.123 }], confidence: "low", widened: true, browse: ["dev"] });

  await json("list_servers", { category: "dev", auth: "not_connected" });
  assert.deepEqual(calls.at(-1), ["listServers", ana, { text: undefined, category: "dev", tag: undefined, auth: "not_connected" }]);

  const res = await call("invoke", { server: "echo", tool: "echo", args: { message: "round trip" } });
  assert.deepEqual(res.content, [{ type: "text", text: "round trip" }], "downstream result passes through unwrapped");
  assert.deepEqual(calls.at(-1), ["invoke", ana, "echo", "echo", { message: "round trip" }]);

  const conn = await json("connect_server", { server: "github" });
  assert.equal(conn.status, "pending");
  assert.deepEqual(calls.at(-1), ["connect", ana, "github"]);
});

test("errors become isError results, scrubbed, and bad input is rejected", async () => {
  const { deps } = fakes();
  const { call } = await connect(deps);
  const boom = await call("invoke", { server: "echo", tool: "boom" });
  assert.equal(boom.isError, true);
  assert.match(boom.content[0].text, /invoke failed: upstream said: Bearer \[REDACTED\]/);
  assert.ok(!boom.content[0].text.includes("SECRET123"));

  assert.equal((await call("find_tools", {})).isError, true);
  assert.equal((await call("invoke", { server: "echo", tool: "echo", args: [1] })).isError, true);
  assert.equal((await call("list_servers", { auth: "everything" })).isError, true);
  assert.equal((await call("nope", {})).isError, true);
});

test("metrics: invocations by server/result, unknown ids collapsed, latency observed", async () => {
  const { deps } = fakes();
  const { call } = await connect(deps);
  await call("invoke", { server: "echo", tool: "echo", args: { message: "a" } });
  await call("invoke", { server: "echo", tool: "boom" });
  await call("invoke", { server: "locked", tool: "x" });
  await call("find_tools", { query: "q" });
  const text = deps.metrics!.render();
  assert.match(text, /osmcp_invocations_total\{result="ok",server="echo"\} 1/);
  assert.match(text, /osmcp_invocations_total\{result="error",server="echo"\} 1/);
  assert.match(text, /osmcp_invocations_total\{result="denied",server="unknown"\} 1/);
  assert.match(text, /osmcp_find_tools_total\{confidence="low"\} 1/);
  assert.match(text, /osmcp_invoke_duration_seconds_count 3/);
});

test("startup surface stays under the 2k-token budget", () => {
  const estTokens = Math.ceil(JSON.stringify({ tools: META_TOOLS }).length / 4);
  assert.ok(estTokens < 2000, `startup surface ~${estTokens} tokens exceeds budget`);
});
