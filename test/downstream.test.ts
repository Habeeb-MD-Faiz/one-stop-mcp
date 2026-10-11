import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AccessDeniedError, type Principal } from "../src/contracts.js";
import { GatewayAuthBroker } from "../src/auth/broker.js";
import { Registry } from "../src/downstream/registry.js";
import { hostSafe } from "../src/server/app.js";
import type { Manifest } from "../src/types.js";
import { FakeGuard, lexicalDiscovery, MemoryCatalog, MemoryLedger, MemoryStore } from "./fixtures/fakes.js";
import { startLegacySse, startMcpHttp } from "./fixtures/oauth-server.js";

const envServer = fileURLToPath(new URL("./fixtures/env-server.mjs", import.meta.url));
const ANN: Principal = { org: "acme", user: "ann", admin: false };
const BOB: Principal = { org: "acme", user: "bob", admin: false };
const PUBLIC = "http://127.0.0.1:1"; // the gateway's own URL; never fetched in these tests

function rig(manifests: Manifest[], home?: string) {
  const store = new MemoryStore();
  const ledger = new MemoryLedger();
  const catalog = new MemoryCatalog();
  const guard = new FakeGuard();
  const byId = new Map(manifests.map((m) => [m.id, m]));
  const broker = new GatewayAuthBroker({ store, ledger, manifest: (id) => byId.get(id), publicUrl: PUBLIC });
  const registry = new Registry(manifests, { catalog, discovery: lexicalDiscovery, auth: broker, guard, ledger, secrets: store, home });
  return { store, ledger, catalog, guard, broker, registry };
}

const text = (res: unknown) => (res as { content: { text: string }[] }).content[0].text;

/** connect -> ticket URL -> key-entry submit, as the gateway's page would. */
async function connectKey(broker: GatewayAuthBroker, p: Principal, server: string, key: string) {
  const c = await broker.connect(p, server);
  assert.equal(c.status, "pending");
  const ticket = c.url!.slice(`${PUBLIC}/connect/`.length);
  assert.ok(ticket.length >= 40, "ticket is 32 random bytes");
  const r = await broker.submitApiKey(ticket, key);
  assert.ok(r.ok, r.message);
  return ticket;
}

test("find_tools over 50 servers spawns nothing and skips unindexed servers", async () => {
  const manifests: Manifest[] = Array.from({ length: 50 }, (_, i) => ({
    id: `s${i}`,
    name: `Server ${i}`,
    category: ["misc"],
    description: `fake server ${i}`,
    transport: { type: "stdio", command: "osmcp-definitely-not-installed" }, // spawning would fail loudly
  }));
  const { registry, catalog } = rig(manifests);
  for (const m of manifests.slice(0, 49)) {
    catalog.save({ server: m.id, source: "docs", fetchedAt: "2026-10-10T00:00:00Z", tools: [{ name: `frob_${m.id}`, description: `frobnicate widgets ${m.id}`, inputSchema: { type: "object", title: "x" } }] });
  }
  const r = await registry.findTools(ANN, "frob_s7", 3);
  assert.equal(r.hits[0].tool, "frob_s7");
  assert.deepEqual(r.hits[0].inputSchema, { type: "object" }, "schemas are compressed (light)");
  assert.ok(!(await registry.findTools(ANN, "frob_s49", 50)).hits.some((h) => h.server === "s49"), "no snapshot -> not routable");
  assert.deepEqual(registry.runningServers(), []);
});

test("api_key over stdio: ticket, env injection, env isolation, redaction, pooling, kill switch", async () => {
  const keyed: Manifest = {
    id: "keyed",
    name: "Keyed",
    category: ["dev"],
    description: "needs a key",
    transport: { type: "stdio", command: process.execPath, args: [envServer] },
    auth: { type: "api_key", env: "FIXTURE_TOKEN", keyUrl: "https://example.invalid/keys" },
  };
  const { registry, broker, ledger, catalog, guard } = rig([keyed]);
  process.env.OSMCP_MASTER_KEY = "master-key-must-not-leak";
  try {
    await assert.rejects(registry.invoke(ANN, "keyed", "has_env", { name: "FIXTURE_TOKEN" }), /connect_server/);

    const c = await broker.connect(ANN, "keyed");
    const ticket = c.url!.slice(`${PUBLIC}/connect/`.length);
    assert.deepEqual(broker.ticketInfo(ticket), { server: "keyed", name: "Keyed", keyUrl: "https://example.invalid/keys", kind: "api_key", account: "acme/ann" });
    assert.equal((await broker.submitApiKey(ticket, "   ")).ok, false, "empty key rejected, ticket kept");
    assert.ok((await broker.submitApiKey(ticket, "sk-ann-123")).ok);
    assert.equal((await broker.submitApiKey(ticket, "sk-again")).ok, false, "tickets are one-time");
    assert.equal(broker.ticketInfo(ticket), undefined);
    assert.equal((await broker.connect(ANN, "keyed")).status, "connected");

    assert.deepEqual(JSON.parse(text(await registry.invoke(ANN, "keyed", "has_env", { name: "FIXTURE_TOKEN" }))), { present: true });
    assert.deepEqual(JSON.parse(text(await registry.invoke(ANN, "keyed", "has_env", { name: "OSMCP_MASTER_KEY" }))), { present: false }, "D31");
    assert.equal(text(await registry.invoke(ANN, "keyed", "leak", { name: "FIXTURE_TOKEN" })), "value=[REDACTED]");
    assert.equal(catalog.load("keyed")?.source, "live", "first session open snapshots the tool list");

    const [ann] = await registry.listServers(ANN);
    assert.equal(ann.connected && ann.running, true);
    assert.deepEqual((await registry.listServers(BOB, { auth: "not_connected" })).map((s) => s.id), ["keyed"]);
    assert.equal((await registry.listServers(BOB))[0].running, false, "sessions are per principal");

    await connectKey(broker, BOB, "keyed", "sk-bob-456");
    await registry.invoke(BOB, "keyed", "has_env", { name: "FIXTURE_TOKEN" });
    assert.equal(await registry.closeUser("ann", "acme"), 1);
    assert.deepEqual(registry.runningServers(), ["keyed"], "bob's session survives");
    assert.equal(await registry.closeServer("keyed"), 1);
    assert.equal(await registry.closeAll(), 0);

    guard.revoked.add("keyed");
    await assert.rejects(registry.invoke(ANN, "keyed", "has_env", { name: "X" }), AccessDeniedError);
    assert.ok(ledger.entries.some((e) => e.result === "denied" && e.server === "keyed"));
    assert.ok(ledger.entries.some((e) => e.tool === "auth.connect" && e.user === "ann"));
    assert.ok(!JSON.stringify(ledger.entries).includes("sk-ann-123"), "the ledger never holds a secret");
  } finally {
    delete process.env.OSMCP_MASTER_KEY;
    await registry.closeAll();
  }
});

test("api_key over Streamable HTTP: custom and Authorization headers, echoed key redacted", async () => {
  const custom = await startMcpHttp({ authorize: (req) => req.headers["x-api-key"] === "hk-456" });
  const bearer = await startMcpHttp({ authorize: (req) => req.headers.authorization === "Bearer hk-789" });
  const mk = (id: string, url: string, header?: string): Manifest => ({ id, name: id, category: [], description: "", transport: { type: "streamable-http", url }, auth: { type: "api_key", header } });
  const { registry, broker } = rig([mk("custom", custom.url, "X-Api-Key"), mk("bearer", bearer.url)]);
  try {
    await connectKey(broker, ANN, "custom", "hk-456");
    await connectKey(broker, ANN, "bearer", "hk-789");
    assert.equal(text(await registry.invoke(ANN, "custom", "whoami")), "ok");
    assert.equal(text(await registry.invoke(ANN, "custom", "leak_header", { name: "x-api-key" })), "header=[REDACTED]");
    assert.equal(text(await registry.invoke(ANN, "bearer", "leak_header", { name: "authorization" })), "header=[REDACTED]");
  } finally {
    await registry.closeAll();
    await custom.close();
    await bearer.close();
  }
});

test("legacy HTTP+SSE server: Streamable 4xx falls back to SSE; health and refreshCatalog", async () => {
  const sse = await startLegacySse();
  const legacy: Manifest = { id: "legacy", name: "Legacy", category: [], description: "", transport: { type: "streamable-http", url: sse.url }, health: { check: "tools/list" } };
  const quiet: Manifest = { ...legacy, id: "quiet", health: { check: "none" } };
  const broken: Manifest = { id: "broken", name: "Broken", category: [], description: "", transport: { type: "stdio", command: "osmcp-definitely-not-installed" } };
  const { registry, catalog } = rig([legacy, quiet, broken]);
  try {
    assert.equal(text(await registry.invoke(ANN, "legacy", "whoami")), "ok");
    const snap = await registry.refreshCatalog(ANN, "legacy");
    assert.deepEqual(snap.tools.map((t) => t.name), ["whoami", "leak_header"]);
    assert.equal(catalog.load("legacy"), snap);
    assert.equal((await registry.health(ANN, "legacy")).ok, true);
    assert.deepEqual(await registry.health(ANN, "quiet"), { server: "quiet", ok: true, latencyMs: 0, skipped: true });
    const bad = await registry.health(ANN, "broken");
    assert.equal(bad.ok, false);
    assert.ok(bad.error);
  } finally {
    await registry.closeAll();
    await sse.close();
  }
});

test("auth none: sessions per user, the state directory is never an argument, team mode loads only listed ones", async () => {
  const home = mkdtempSync(join(tmpdir(), "osmcp-home-"));
  const open: Manifest = { id: "open", name: "Open", category: [], description: "", transport: { type: "stdio", command: process.execPath, args: [envServer] }, auth: { type: "none" } };
  const exposing: Manifest = { ...open, id: "exposing", transport: { type: "stdio", command: process.execPath, args: [envServer, dirname(home)] } };
  const remote: Manifest = { ...open, id: "remote", transport: { type: "streamable-http", url: "https://mcp.example.invalid/" } };
  const { registry } = rig([open, exposing], home);
  try {
    await registry.invoke(ANN, "open", "has_env", { name: "X" });
    await registry.invoke(BOB, "open", "has_env", { name: "X" });
    assert.equal(await registry.closeUser("ann", "acme"), 1, "ann's session is hers alone");
    assert.equal(await registry.closeAll(), 1, "bob had his own");
    await assert.rejects(registry.invoke(ANN, "exposing", "has_env", { name: "X" }), /state directory/);
  } finally {
    await registry.closeAll();
  }
  const ids = (mode: "local" | "team", hostServers: string[] = []) => hostSafe({ mode, hostServers }, [open, exposing, remote]).map((m) => m.id);
  assert.deepEqual(ids("local"), ["open", "exposing", "remote"]);
  assert.deepEqual(ids("team"), ["remote"], "a no-auth stdio server would act as the host for every user");
  assert.deepEqual(ids("team", ["open"]), ["open", "remote"]);
});
