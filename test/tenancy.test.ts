import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserStore } from "../src/tenancy/users.js";
import { adminCall } from "../src/server/admin.js";
import type { App } from "../src/server/app.js";
import { LOCAL_PRINCIPAL } from "../src/contracts.js";
import { MemoryStore } from "./fixtures/fakes.js";

const dir = mkdtempSync(join(tmpdir(), "osmcp-users-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("tokens: plaintext returned once, only the hash on disk, revocable", () => {
  const path = join(dir, "users.json");
  const users = new UserStore(path);
  users.add("ana", "acme", true);
  const { id, token } = users.issueToken("ana");
  assert.match(token, /^osmcp_[A-Za-z0-9_-]{43}$/);

  const disk = readFileSync(path, "utf8");
  assert.ok(!disk.includes(token) && !disk.includes(token.slice(6)), "plaintext token must never be written");
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);

  assert.deepEqual(users.authenticate(token), { user: "ana", org: "acme", admin: true });
  assert.equal(users.authenticate(token + "x"), undefined);
  assert.equal(users.authenticate("osmcp_" + "A".repeat(43)), undefined);
  assert.equal(users.authenticate(undefined), undefined);
  assert.ok(users.list()[0].tokens[0].lastUsedAt, "use is stamped");
  assert.ok(!("hash" in users.list()[0].tokens[0]), "views never carry hashes");

  assert.equal(users.revokeToken("ana", id), true);
  assert.equal(users.authenticate(token), undefined);
});

test("a second process's write is seen without restart (CLI vs running gateway)", () => {
  const path = join(dir, "shared.json");
  const gateway = new UserStore(path);
  const cli = new UserStore(path);
  cli.add("bo", "acme");
  const { token } = cli.issueToken("bo");
  assert.equal(gateway.authenticate(token)?.user, "bo");
  cli.remove("bo");
  assert.equal(gateway.authenticate(token), undefined, "removal takes effect on the next request");
});

test("ids are validated; duplicates and unknown users rejected", () => {
  const users = new UserStore(join(dir, "v.json"));
  assert.throws(() => users.add("../x", "acme"), /invalid user id/);
  assert.throws(() => users.add("_gateway", "acme"), /invalid user id/);
  assert.throws(() => users.add("ok", "a/b"), /invalid org/);
  users.add("cy", "acme");
  assert.throws(() => users.add("cy", "other"), /already exists/);
  assert.throws(() => users.issueToken("nobody"), /unknown user/);
  assert.equal(users.remove("nobody"), false);
});

test("removing a user removes every credential, so a new user with the same id inherits nothing", async () => {
  const users = new UserStore(join(dir, "users-remove.json"));
  users.add("ana", "acme");
  const store = new MemoryStore();
  await store.put({ org: "acme", user: "ana", server: "gmail" }, { access_token: "t" }, "oauth2");
  await store.put({ org: "acme", user: "ana", server: "_totp" }, { secret: "s" }, "api_key");
  await store.put({ org: "acme", user: "bob", server: "gmail" }, { access_token: "b" }, "oauth2");
  const app = { users, store, ledger: { record: (e: unknown) => e } } as unknown as App;
  assert.deepEqual(await adminCall(app, LOCAL_PRINCIPAL, "DELETE", "users/ana"), { removed: "ana", credentials: 1 });
  assert.deepEqual((await store.list({ org: "acme" })).map((c) => c.scope.user), ["bob"]);
});
