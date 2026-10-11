import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageLedger, verifyLedger } from "../src/security/index.js";

const root = mkdtempSync(join(tmpdir(), "osmcp-ledger-"));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const file = (): string => join(root, `ledger${n++}.jsonl`);
const call = (ts: number, over: Record<string, unknown> = {}) => ({ ts, user: "u", server: "crm", tool: "read", result: "authorized" as const, ...over });

test("entries are hash-chained, Ed25519-signed, and verify with the public key alone", () => {
  const path = file();
  const l = new UsageLedger({ path });
  for (let i = 0; i < 5; i++) l.record(call(1000 + i, { org: "acme" }));
  const pub = readFileSync(`${path}.key.pub`, "utf8");
  assert.equal(pub, l.publicKeyPem);
  assert.deepEqual(verifyLedger(path, pub), { ok: true, entries: 5 });
  const [e0, e1] = l.all();
  assert.equal(e0.seq, 0);
  assert.equal(e1.prev, e0.hash);
  assert.equal(e0.org, "acme");
});

test("any edit, deletion or re-signing with another key is caught at the right line", () => {
  const path = file();
  const l = new UsageLedger({ path });
  for (let i = 0; i < 4; i++) l.record(call(1000 + i));
  const good = readFileSync(path, "utf8");
  const lines = good.trim().split("\n");

  writeFileSync(path, good.replace('"result":"authorized"', '"result":"denied"'));
  assert.deepEqual(verifyLedger(path, l.publicKeyPem), { ok: false, entries: 4, brokenAt: 0, reason: "hash mismatch: entry was altered" });

  writeFileSync(path, [lines[0], lines[2], lines[3]].join("\n") + "\n");
  assert.equal(verifyLedger(path, l.publicKeyPem).brokenAt, 1, "a removed entry breaks seq/chain");

  // An attacker rebuilding the whole chain with their own key still fails the signature check.
  const forger = new UsageLedger({ path: file() });
  for (let i = 0; i < 4; i++) forger.record(call(1000 + i, { tool: "forged" }));
  writeFileSync(path, readFileSync(join(root, `ledger${n - 1}.jsonl`)));
  assert.equal(verifyLedger(path, l.publicKeyPem).reason, "bad signature");
});

test("a reopened ledger continues the chain, and appends from another process are picked up", () => {
  const path = file();
  new UsageLedger({ path }).record(call(1000));
  const a = new UsageLedger({ path });
  const b = new UsageLedger({ path }); // e.g. the CLI, sharing the key file
  a.record(call(1001));
  b.record(call(1002)); // b syncs a's line before appending
  a.record(call(1003));
  assert.equal(a.all().length, 4);
  assert.deepEqual(a.all().map((e) => e.seq), [0, 1, 2, 3]);
  assert.deepEqual(verifyLedger(path, a.publicKeyPem), { ok: true, entries: 4 });
});

test("all() filters including since; flagged() lists flagged entries", () => {
  const l = new UsageLedger({ burstMax: 2 });
  l.record(call(1000));
  l.record(call(2000, { user: "v" }));
  l.record(call(3000));
  l.record(call(4000)); // third read by u in 60 s -> burst
  assert.equal(l.all({ user: "u", since: 2500 }).length, 2);
  assert.equal(l.all({ result: "denied" }).length, 0);
  assert.equal(l.flagged().length, 1);
  assert.match(l.flagged()[0].reason!, /^burst: 3 calls to crm\/read/);
});

test("rules: burst per (user, server, tool), bulk-shaped tools sooner, denied rate per user", () => {
  const l = new UsageLedger({ burstMax: 3, bulkMax: 2, deniedMax: 2, windowMs: 1000 });
  const base = 10_000;
  for (let i = 0; i < 3; i++) assert.equal(l.record(call(base + i)).flagged, undefined);
  assert.equal(l.record(call(base + 3)).flagged, true, "4th call in-window exceeds burstMax");
  assert.equal(l.record(call(base + 4, { tool: "other" })).flagged, undefined, "another tool is its own bucket");
  assert.equal(l.record(call(base + 5000)).flagged, undefined, "outside the window resets");

  assert.equal(l.record(call(base + 6000, { tool: "export_contacts" })).flagged, undefined);
  assert.equal(l.record(call(base + 6001, { tool: "export_contacts" })).flagged, undefined);
  assert.match(l.record(call(base + 6002, { tool: "export_contacts" })).reason!, /bulk-shaped/);

  const d = (ts: number) => l.record(call(ts, { user: "mallory", server: `s${ts}`, result: "denied", reason: "server revoked" }));
  d(base + 9000);
  d(base + 9001);
  const third = d(base + 9002);
  assert.equal(third.flagged, true);
  assert.match(third.reason!, /^server revoked; denied rate: 3 denied/);
});

test("baseline: a steady connector stays quiet; a sudden rate jump is flagged after warm-up", () => {
  const l = new UsageLedger({ baseline: { warmupMinutes: 5 } });
  const minute = 60_000;
  let t = 100 * minute;
  // 12 minutes of 4-6 calls/minute, spread across the minute.
  for (let m = 0; m < 12; m++) {
    const calls = 4 + (m % 3);
    for (let i = 0; i < calls; i++) assert.equal(l.record(call(t + i * 9000, { tool: `t${i}` })).flagged, undefined, `steady minute ${m}`);
    t += minute;
  }
  // Then 40 calls in one minute: still under the 100/min burst rule, far above baseline.
  const out = Array.from({ length: 40 }, (_, i) => l.record(call(t + i * 1000, { tool: `t${i}` })));
  const first = out.findIndex((e) => e.flagged);
  assert.ok(first > 5 && first < 20, `flagged once the minute ran well past ~5/min (at call ${first + 1})`);
  assert.match(out[first].reason!, /rate above baseline: \d+\/min on crm/);
  // Another connector has its own baseline and is not dragged in.
  assert.equal(l.record(call(t + 59_000, { server: "wiki" })).flagged, undefined);
});
