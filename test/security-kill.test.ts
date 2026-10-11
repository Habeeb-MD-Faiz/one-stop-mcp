import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { AccessDeniedError, type Principal, type SecretScope, type SessionControl } from "../src/contracts.js";
import type { Manifest } from "../src/types.js";
import { FileSecretStore, KillSwitch, RotationService, UsageLedger, cloudflareRotator, type KeyProvider } from "../src/security/index.js";

const root = mkdtempSync(join(tmpdir(), "osmcp-kill-"));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const dir = (): string => join(root, `t${n++}`);
const key: KeyProvider = { rootKey: async () => KEY };
const KEY = randomBytes(32);
const alice: Principal = { org: "acme", user: "alice", admin: false };
const bob: Principal = { org: "acme", user: "bob", admin: false };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeSessions() {
  const calls: string[] = [];
  const s: SessionControl = {
    closeAll: async () => (calls.push("all"), 3),
    closeServer: async (id) => (calls.push(`server:${id}`), 1),
    closeUser: async (user, org) => (calls.push(`user:${org}/${user}`), 1),
  };
  return { s, calls };
}

function setup(d = dir()) {
  const store = new FileSecretStore(d, key);
  const ledger = new UsageLedger();
  const kill = new KillSwitch({ statePath: join(d, "kill.json"), store, ledger });
  const { s, calls } = fakeSessions();
  kill.attachSessions(s);
  return { d, store, ledger, kill, calls };
}

const denied = (fn: () => void, re: RegExp) => assert.throws(fn, (e: Error) => e instanceof AccessDeniedError && re.test(e.message));

test("revoke all: closes every session, freezes the vault, denies and ledgers every call", async () => {
  const { store, ledger, kill, calls } = setup();
  kill.check(alice, "github"); // allowed before
  assert.deepEqual(await kill.revokeAll("admin"), { closedSessions: 3 });
  assert.deepEqual(calls, ["all"]);
  assert.ok(store.isFrozen);
  denied(() => kill.check(alice, "github"), /lockdown/);
  assert.equal(ledger.all({ tool: "kill.revoke_all", user: "admin" }).length, 1, "the action is audited");
  assert.equal(ledger.all({ result: "denied", user: "alice", server: "github" }).length, 1, "the denial is audited");
});

test("after a lockdown, servers come back one at a time; endLockdown restores the rest", async () => {
  const { store, kill } = setup();
  await kill.revokeAll("admin");
  await kill.enableServer("github", "admin");
  assert.ok(!store.isFrozen, "the vault unfreezes for the re-enabled connector");
  kill.check(alice, "github");
  denied(() => kill.check(alice, "slack"), /lockdown/);
  assert.deepEqual(kill.status().reenabled, ["github"]);
  await kill.endLockdown("admin");
  kill.check(alice, "slack");
  assert.equal(kill.status().lockdown, false);
});

test("scoped: revoke one server or one user, and enable them again", async () => {
  const { kill, calls } = setup();
  await kill.revokeServer("slack", "admin");
  denied(() => kill.check(alice, "slack"), /server slack is revoked/);
  kill.check(alice, "github");
  await kill.revokeUser("bob", "acme", "admin");
  denied(() => kill.check(bob, "github"), /user acme\/bob is revoked/);
  kill.check(alice, "github");
  assert.deepEqual(calls, ["server:slack", "user:acme/bob"]);
  await kill.enableServer("slack", "admin");
  await kill.enableUser("bob", "acme", "admin");
  kill.check(bob, "slack");
});

test("D30: a kill from another process (the CLI) bites on the gateway's next check", async () => {
  const gw = setup();
  const cli = new KillSwitch({ statePath: join(gw.d, "kill.json"), store: new FileSecretStore(gw.d, key), ledger: new UsageLedger() });
  await cli.revokeAll("operator");
  assert.ok(!gw.store.isFrozen, "nothing changes until the gateway looks");
  denied(() => gw.kill.check(alice, "github"), /lockdown/);
  assert.ok(gw.store.isFrozen, "the gateway's own vault froze");
  await sleep(0);
  assert.deepEqual(gw.calls, ["all"], "the gateway closed its sessions on the transition");
  // A gateway restarted mid-lockdown comes up locked.
  const restarted = setup(gw.d);
  assert.ok(restarted.store.isFrozen);
});

// --- rotation ------------------------------------------------------------------------

const manifests: Record<string, Manifest> = {
  github: { id: "github", name: "GitHub", category: ["dev"], description: "", transport: { type: "stdio", command: "x" }, auth: { type: "oauth2" } },
  cloudflare: { id: "cloudflare", name: "Cloudflare", category: ["infra"], description: "", transport: { type: "stdio", command: "x" }, auth: { type: "api_key", rotation: "cloudflare" } },
  linear: { id: "linear", name: "Linear", category: ["dev"], description: "", transport: { type: "stdio", command: "x" }, auth: { type: "api_key" } },
};

async function fakeCloudflare() {
  let valid = "cf-old";
  const server = createServer((req, res) => {
    const ok = req.headers.authorization === `Bearer ${valid}`;
    const send = (status: number, body: unknown) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(body)));
    if (!ok) return send(403, { success: false, errors: [{ code: 9109, message: "Invalid access token" }], result: null });
    if (req.method === "GET" && req.url === "/user/tokens/verify") return send(200, { success: true, errors: [], result: { id: "tok123", status: "active" } });
    if (req.method === "PUT" && req.url === "/user/tokens/tok123/value") {
      valid = "cf-new-" + randomBytes(4).toString("hex");
      return send(200, { success: true, errors: [], result: valid });
    }
    send(404, { success: false, errors: [{ message: "not found" }] });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, current: () => valid };
}

async function rotationSetup() {
  const cf = await fakeCloudflare();
  const ctx = setup();
  const refreshed: string[] = [];
  const service = new RotationService({
    store: ctx.store,
    ledger: ctx.ledger,
    manifest: (id) => manifests[id],
    adapters: { cloudflare: cloudflareRotator(cf.url) },
    kill: ctx.kill,
    broker: {
      refresh: async (s: SecretScope) => {
        const cur = await ctx.store.get<{ refresh_token?: string }>(s);
        if (!cur?.refresh_token) return false;
        await ctx.store.put(s, { access_token: "new", refresh_token: cur.refresh_token }, "oauth2");
        refreshed.push(`${s.user}/${s.server}`);
        return true;
      },
      keyEntryUrl: async (s: SecretScope) => `http://127.0.0.1:8420/connect/ticket-${s.user}-${s.server}`,
    },
  });
  const put = (user: string, server: string, secret: unknown, kind: "oauth2" | "api_key" | "client") => ctx.store.put({ org: "acme", user, server }, secret, kind);
  await put("alice", "github", { access_token: "a", refresh_token: "r" }, "oauth2");
  await put("alice", "cloudflare", { key: "cf-old" }, "api_key");
  await put("alice", "linear", "lin_api_x", "api_key");
  await put("bob", "github", { access_token: "b" }, "oauth2"); // no refresh token
  await put("_client", "github", { client_id: "c" }, "client");
  return { ...ctx, cf, service, refreshed };
}

test("rotate one: oauth refresh, provider adapter (Cloudflare roll), guided re-issue, failures", async () => {
  const { service, store, cf, refreshed, ledger } = await rotationSetup();
  const A = (server: string, user = "alice") => ({ org: "acme", user, server });

  assert.equal((await service.rotate(A("github"))).status, "rotated");
  assert.deepEqual(refreshed, ["alice/github"]);

  const cfOut = await service.rotate(A("cloudflare"));
  assert.equal(cfOut.status, "rotated", cfOut.message);
  assert.deepEqual(await store.get(A("cloudflare")), { key: cf.current() }, "new token stored, shape kept");
  assert.notEqual(cf.current(), "cf-old");

  const lin = await service.rotate(A("linear"));
  assert.equal(lin.status, "guided");
  assert.equal(lin.url, "http://127.0.0.1:8420/connect/ticket-alice-linear");

  assert.equal((await service.rotate(A("github", "bob"))).status, "failed", "no refresh token");
  assert.equal((await service.rotate(A("nope"))).status, "skipped");
  assert.equal((await service.rotate(A("github", "_client"))).status, "skipped", "client registrations are not rotated");

  // Adapter failure (token no longer valid at the provider) falls back to guided, and never echoes the key.
  await store.put(A("cloudflare"), { key: "cf-revoked-elsewhere" }, "api_key");
  const fb = await service.rotate(A("cloudflare"));
  assert.equal(fb.status, "guided");
  assert.match(fb.message, /cloudflare rotation failed .*Invalid access token/);
  assert.ok(!JSON.stringify(ledger.all()).includes("cf-revoked-elsewhere"), "secrets never reach the ledger");
  assert.ok(ledger.all({ tool: "rotate" }).length >= 7, "every rotation is ledgered");
});

test("due, group (by category) and all", async () => {
  const { service } = await rotationSetup();
  assert.equal((await service.due()).length, 0, "nothing is due on day one");
  const later = Date.now() + 91 * 86_400_000;
  const due = await service.due(later);
  assert.equal(due.length, 4, "client kind is excluded");
  const infra = await service.rotateGroup({ category: "infra" });
  assert.deepEqual(infra.map((o) => o.scope.server), ["cloudflare"]);
  const bobs = await service.rotateGroup({ user: "bob" });
  assert.deepEqual(bobs.map((o) => `${o.scope.user}/${o.status}`), ["bob/failed"]);
  assert.equal((await service.rotateAll()).length, 4);
});

test("schedule rotates what is due and issues a guided prompt once per key version", async () => {
  const { service } = await rotationSetup();
  const svc = new RotationService({ ...(service as any).o, days: 0 }); // everything is due immediately
  const seen: string[] = [];
  const stop = svc.startSchedule(15, (o) => seen.push(`${o.scope.user}/${o.scope.server}:${o.status}`));
  await sleep(120);
  stop();
  assert.equal(seen.filter((s) => s === "alice/linear:guided").length, 1, "guided prompt not repeated every tick");
  assert.ok(seen.filter((s) => s === "alice/github:rotated").length >= 2, "automatic rotation keeps running");
});

test("incident: revokes all, finds suspects, rotates what they could have seen, stays locked", async () => {
  const { service, store, ledger, kill, calls, refreshed } = await rotationSetup();
  const t0 = Date.now();
  ledger.record({ ts: t0, org: "acme", user: "alice", server: "github", tool: "list_repos", result: "authorized" });
  ledger.record({ ts: t0, org: "acme", user: "alice", server: "linear", tool: "search", result: "denied" });
  ledger.record({ ts: t0, org: "acme", user: "bob", server: "github", tool: "read", result: "authorized" });

  const report = await service.incident({ user: "alice", by: "admin" });
  assert.deepEqual(calls, ["all"]);
  assert.equal(report.closedSessions, 3);
  assert.deepEqual(report.suspects.map((e) => `${e.user}/${e.server}/${e.result}`), ["alice/github/authorized", "alice/linear/denied"]);
  assert.deepEqual(report.scopes, [{ org: "acme", user: "alice", server: "github" }], "a denied call exposed nothing");
  assert.deepEqual(report.outcomes.map((o) => o.status), ["rotated"]);
  assert.deepEqual(refreshed, ["alice/github"]);
  assert.ok(store.isFrozen, "the lockdown stays on after rotating");
  assert.throws(() => kill.check(alice, "github"), AccessDeniedError);
  assert.equal(ledger.all({ tool: "incident" }).length, 1);

  // No filter: rotate every credential.
  const all = await service.incident({ by: "admin" });
  assert.equal(all.scopes.length, 4);
});
