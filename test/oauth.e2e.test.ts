// OAuth end to end, fully offline: a fake authorization server and fake MCP
// servers on 127.0.0.1. The "browser" is fetch with redirect: manual — the
// fake /authorize 302s straight back to the gateway callback with code + state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { Principal } from "../src/contracts.js";
import { GatewayAuthBroker } from "../src/auth/broker.js";
import { clientScope } from "../src/auth/vault-oauth-provider.js";
import { Registry } from "../src/downstream/registry.js";
import type { Manifest } from "../src/types.js";
import { FakeGuard, lexicalDiscovery, MemoryCatalog, MemoryLedger, MemoryStore } from "./fixtures/fakes.js";
import { startAuthServer, startMcpHttp } from "./fixtures/oauth-server.js";

const envServer = fileURLToPath(new URL("./fixtures/env-server.mjs", import.meta.url));
const ANN: Principal = { org: "acme", user: "ann", admin: false };
const PUBLIC = "http://127.0.0.1:1";
const text = (res: unknown) => (res as { content: { text: string }[] }).content[0].text;

function rig(manifests: Manifest[], now?: () => number) {
  const store = new MemoryStore();
  const ledger = new MemoryLedger();
  const byId = new Map(manifests.map((m) => [m.id, m]));
  const broker = new GatewayAuthBroker({ store, ledger, manifest: (id) => byId.get(id), publicUrl: PUBLIC, now });
  const registry = new Registry(manifests, { catalog: new MemoryCatalog(), discovery: lexicalDiscovery, auth: broker, guard: new FakeGuard(), ledger, secrets: store });
  return { store, ledger, broker, registry };
}

/** Open the authorization URL like a browser would and land on the gateway callback. */
async function signIn(broker: GatewayAuthBroker, authorizationUrl: string) {
  const res = await fetch(authorizationUrl, { redirect: "manual" });
  assert.equal(res.status, 302);
  const back = new URL(res.headers.get("location")!);
  assert.equal(`${back.origin}${back.pathname}`, `${PUBLIC}/oauth/callback`);
  const r = await broker.handleOAuthCallback(back.searchParams);
  assert.ok(r.ok, r.message);
  return back.searchParams;
}

test("MCP-spec OAuth over Streamable HTTP: discovery, DCR, PKCE, callback, invoke, refresh on 401, forced refresh", async () => {
  const as = await startAuthServer();
  const mcp = await startMcpHttp({ authServer: as.url, authorize: (req) => as.valid(req.headers.authorization?.replace(/^Bearer /, "")) });
  const remote: Manifest = { id: "remote", name: "Remote", category: [], description: "", transport: { type: "streamable-http", url: mcp.url }, auth: { type: "oauth2" } };
  const { registry, broker, store, ledger } = rig([remote]);
  try {
    await assert.rejects(registry.invoke(ANN, "remote", "whoami"), /connect_server/);
    const c = await broker.connect(ANN, "remote");
    assert.equal(c.status, "pending");
    assert.ok(c.url!.startsWith(`${as.url}/authorize?`), c.url!);
    assert.ok((await store.get(clientScope("remote"))) !== undefined, "dynamic client registration persisted");

    const query = await signIn(broker, c.url!);
    assert.equal((await broker.handleOAuthCallback(query)).ok, false, "state is single-use");
    assert.equal((await broker.handleOAuthCallback(new URLSearchParams({ state: "forged", code: "x" }))).ok, false);
    assert.equal((await broker.connect(ANN, "remote")).status, "connected");

    assert.equal(text(await registry.invoke(ANN, "remote", "whoami")), "ok");
    assert.deepEqual(as.grants, ["authorization_code"]);

    as.expireAll(); // the pooled session's token is now rejected with 401
    assert.equal(text(await registry.invoke(ANN, "remote", "whoami")), "ok");
    assert.deepEqual(as.grants, ["authorization_code", "refresh_token"], "SDK refreshed on 401 and retried");

    assert.equal(await broker.refresh({ org: "acme", user: "ann", server: "remote" }), true);
    assert.equal(as.grants.length, 3);
    assert.equal(text(await registry.invoke(ANN, "remote", "leak_header", { name: "authorization" })), "header=Bearer [REDACTED]");
    assert.ok(ledger.entries.some((e) => e.tool === "auth.connect" && e.result === "authorized"));
    assert.ok(ledger.entries.some((e) => e.tool === "auth.refresh"));
  } finally {
    await registry.closeAll();
    await mcp.close();
    await as.close();
  }
});

test("explicit-endpoint OAuth on stdio: public client, token in env, proactive refresh when expired", async () => {
  const as = await startAuthServer({ staticClients: [{ client_id: "public-app" }], ttlSec: 120 });
  const local: Manifest = {
    id: "local",
    name: "Local",
    category: [],
    description: "",
    transport: { type: "stdio", command: process.execPath, args: [envServer] },
    auth: { type: "oauth2", authorizationUrl: `${as.url}/authorize`, tokenUrl: `${as.url}/token`, clientId: "public-app", env: "FIXTURE_TOKEN", scopes: ["read"] },
  };
  let clock = Date.now();
  const { registry, broker } = rig([local], () => clock);
  try {
    const c = await broker.connect(ANN, "local");
    assert.ok(new URL(c.url!).searchParams.get("code_challenge_method") === "S256");
    await signIn(broker, c.url!);
    assert.deepEqual(JSON.parse(text(await registry.invoke(ANN, "local", "has_env", { name: "FIXTURE_TOKEN" }))), { present: true });
    assert.equal(text(await registry.invoke(ANN, "local", "leak", { name: "FIXTURE_TOKEN" })), "value=[REDACTED]");

    clock += 10 * 60_000; // past expires_in: outbound refreshes first, and the session respawns with the new token
    assert.deepEqual(JSON.parse(text(await registry.invoke(ANN, "local", "has_env", { name: "FIXTURE_TOKEN" }))), { present: true });
    assert.deepEqual(as.grants, ["authorization_code", "refresh_token"]);
    assert.equal(await broker.refresh({ org: "acme", user: "ann", server: "local" }), true);
    assert.equal(as.grants.length, 3);
  } finally {
    await registry.closeAll();
    await as.close();
  }
});

test("explicit-endpoint OAuth without a client id: operator pastes client id/secret, then signs in", async () => {
  const as = await startAuthServer({ staticClients: [{ client_id: "conf-app", client_secret: "conf-secret" }] });
  const local: Manifest = {
    id: "conf",
    name: "Conf",
    category: [],
    description: "",
    transport: { type: "stdio", command: process.execPath, args: [envServer] },
    auth: { type: "oauth2", authorizationUrl: `${as.url}/authorize`, tokenUrl: `${as.url}/token`, env: "FIXTURE_TOKEN" },
  };
  const { registry, broker, store } = rig([local]);
  try {
    const c = await broker.connect(ANN, "conf");
    assert.ok(c.url!.startsWith(`${PUBLIC}/connect/`));
    const ticket = c.url!.slice(`${PUBLIC}/connect/`.length);
    assert.equal(broker.ticketInfo(ticket)?.kind, "client");
    assert.equal((await broker.submitApiKey(ticket, "{not json")).ok, false);
    const r = await broker.submitApiKey(ticket, JSON.stringify({ client_id: "conf-app", client_secret: "conf-secret" }));
    assert.ok(r.ok, r.message);
    assert.deepEqual(await store.get(clientScope("conf")), { client_id: "conf-app", client_secret: "conf-secret" });

    await signIn(broker, r.message.match(/https?:\/\/\S+/)![0]); // the token endpoint 401s unless the secret is sent
    assert.deepEqual(JSON.parse(text(await registry.invoke(ANN, "conf", "has_env", { name: "FIXTURE_TOKEN" }))), { present: true });
  } finally {
    await registry.closeAll();
    await as.close();
  }
});
