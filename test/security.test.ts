import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Vault, VaultFrozenError, secretEquals } from "../src/vault.js";
import { UsageLedger } from "../src/ledger.js";
import { KillSwitch } from "../src/security.js";
import { Registry } from "../src/registry.js";
import type { Manifest } from "../src/types.js";

test("vault round-trips a secret and scopes it to (user, server)", () => {
  const v = new Vault("master-pass");
  v.put("alice", "github", { access_token: "gho_secret" });
  assert.deepEqual(v.get("alice", "github"), { access_token: "gho_secret" });
  assert.equal(v.get("bob", "github"), undefined, "another user must not see alice's token");
  assert.equal(v.get("alice", "notion"), undefined, "another server scope is separate");
});

test("secrets are actually encrypted at rest (not plaintext in the snapshot)", () => {
  const v = new Vault("master-pass");
  v.put("alice", "github", { access_token: "gho_PLAINTEXT_CANARY" });
  assert.ok(!v.serialize().includes("gho_PLAINTEXT_CANARY"), "snapshot must not contain the plaintext");
});

test("vault reopens from an encrypted snapshot with the right passphrase", () => {
  const v = new Vault("master-pass");
  v.put("alice", "github", { k: 1 });
  const reopened = Vault.load("master-pass", v.serialize());
  assert.deepEqual(reopened.get("alice", "github"), { k: 1 });
});

test("wrong passphrase cannot decrypt (auth tag / key mismatch throws)", () => {
  const v = new Vault("right-pass");
  v.put("alice", "github", { k: 1 });
  const wrong = Vault.load("wrong-pass", v.serialize());
  assert.throws(() => wrong.get("alice", "github"));
});

test("freeze blocks access until unfreeze (kill switch semantics)", () => {
  const v = new Vault("master-pass");
  v.put("alice", "github", { k: 1 });
  v.freeze();
  assert.throws(() => v.get("alice", "github"), VaultFrozenError);
  v.unfreeze();
  assert.deepEqual(v.get("alice", "github"), { k: 1 });
});

test("ledger flags anomalous bulk access, leaves normal use unflagged", () => {
  const l = new UsageLedger({ burstMax: 3, windowMs: 1000 });
  const base = 10_000;
  for (let i = 0; i < 3; i++) assert.equal(l.record({ ts: base + i, user: "u", server: "crm", tool: "export", result: "authorized" }).flagged, false);
  assert.equal(l.record({ ts: base + 3, user: "u", server: "crm", tool: "export", result: "authorized" }).flagged, true, "4th call in-window exceeds burstMax");
  assert.equal(l.flagged().length, 1);
  // A different tool is its own bucket — not dragged into the flag.
  assert.equal(l.record({ ts: base + 4, user: "u", server: "crm", tool: "read", result: "authorized" }).flagged, false);
});

test("kill switch closes sessions, freezes the vault, and audits the action", async () => {
  const echoPath = fileURLToPath(new URL("../examples/echo-server.mjs", import.meta.url));
  const manifest: Manifest = {
    id: "echo", name: "Echo", category: ["dev"], description: "echo",
    transport: { type: "stdio", command: process.execPath, args: [echoPath] },
    auth: { type: "none" }, routing: {},
  };
  const registry = new Registry([manifest]);
  const vault = new Vault("m");
  const ledger = new UsageLedger();
  const kill = new KillSwitch(registry, vault, ledger);

  await registry.invoke("echo", "echo", { message: "hi" }); // spins up a session
  assert.equal(registry.runningServers().length, 1);

  const res = await kill.revokeAll("alice");
  assert.equal(res.closedSessions, 1);
  assert.equal(registry.runningServers().length, 0, "all sessions cut");
  assert.ok(vault.isFrozen, "vault frozen");
  assert.equal(ledger.all({ tool: "kill.revoke_all" }).length, 1, "kill action is audited");
  await registry.closeAll();
});

test("secretEquals is length-safe and correct", () => {
  assert.ok(secretEquals("abc", "abc"));
  assert.ok(!secretEquals("abc", "abd"));
  assert.ok(!secretEquals("abc", "abcd"));
});
