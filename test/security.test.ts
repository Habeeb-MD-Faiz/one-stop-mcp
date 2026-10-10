import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  AwsKmsKeyProvider, FileSecretStore, HashiCorpVaultStore, KeyFileProvider, PassphraseKeyProvider, VaultFrozenError,
  VaultTransitKeyProvider, openSecretStore, orgKey, secretEquals, signV4, userKey, type KeyProvider,
} from "../src/security/index.js";

// Vault, key hierarchy and the pluggable backends. HashiCorp Vault (KV v2 +
// Transit) and AWS KMS are in-process fakes on 127.0.0.1 - never the real APIs.

const root = mkdtempSync(join(tmpdir(), "osmcp-sec-"));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const dir = (): string => join(root, `t${n++}`);
const fixedKey = (key = randomBytes(32)): KeyProvider => ({ rootKey: async () => key });
const A = { org: "acme", user: "alice", server: "github" };

async function listen(handler: (req: IncomingMessage, body: string) => { status: number; json?: unknown }): Promise<{ url: string; server: Server }> {
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const out = handler(req, body);
    res.writeHead(out.status, { "content-type": "application/json" });
    res.end(out.json === undefined ? "" : JSON.stringify(out.json));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

test("HKDF hierarchy: distinct, deterministic keys per org and per user", () => {
  const r = randomBytes(32);
  assert.deepEqual(userKey(r, "acme", "alice"), userKey(r, "acme", "alice"));
  assert.notDeepEqual(userKey(r, "acme", "alice"), userKey(r, "acme", "bob"));
  assert.notDeepEqual(userKey(r, "acme", "alice"), userKey(r, "other", "alice"));
  assert.notDeepEqual(orgKey(r, "acme"), userKey(r, "acme", "alice"));
});

test("file store round-trips, scopes per cell, and is encrypted at rest", async () => {
  const s = new FileSecretStore(dir(), fixedKey());
  await s.put(A, { access_token: "gho_PLAINTEXT_CANARY" }, "oauth2");
  assert.deepEqual(await s.get(A), { access_token: "gho_PLAINTEXT_CANARY" });
  assert.equal(await s.get({ ...A, user: "bob" }), undefined, "another user must not see alice's token");
  assert.equal(await s.get({ ...A, server: "notion" }), undefined);
  assert.ok(!readFileSync(s.path, "utf8").includes("PLAINTEXT_CANARY"), "vault.json must not contain the plaintext");
  const [meta] = await s.list({ org: "acme" });
  assert.deepEqual(meta.scope, A);
  assert.equal(meta.kind, "oauth2");
  assert.ok(!JSON.stringify(await s.list()).includes("CANARY"), "list is metadata only");
  assert.equal(await s.delete(A), true);
  assert.equal(await s.delete(A), false);
  assert.equal(await s.get(A), undefined);
});

test("ciphertext moved to another cell fails to decrypt (AAD + per-user key)", async () => {
  const d = dir();
  const s = new FileSecretStore(d, fixedKey());
  const B = { ...A, user: "bob" };
  await s.put(A, "alice-secret", "api_key");
  await s.put(B, "bob-secret", "api_key");
  const doc = JSON.parse(readFileSync(s.path, "utf8"));
  const ida = JSON.stringify([A.org, A.user, A.server]);
  const idb = JSON.stringify([B.org, B.user, B.server]);
  doc.records[idb] = { ...doc.records[ida], scope: B }; // attacker copies alice's record into bob's cell
  writeFileSync(s.path, JSON.stringify(doc));
  await assert.rejects(s.get(B), /auth|unable|Unsupported state/i);
  // Same user, other server: the AAD alone stops it.
  const C = { ...A, server: "notion" };
  doc.records[JSON.stringify([C.org, C.user, C.server])] = { ...doc.records[ida], scope: C };
  writeFileSync(s.path, JSON.stringify(doc));
  await assert.rejects(s.get(C));
  assert.equal(await s.get(A), "alice-secret");
});

test("file store persists, sees another process's writes, and refuses a wrong master key", async () => {
  const d = dir();
  const key = randomBytes(32);
  const one = new FileSecretStore(d, fixedKey(key));
  const two = new FileSecretStore(d, fixedKey(key));
  await one.put(A, { k: 1 }, "api_key");
  assert.deepEqual(await two.get(A), { k: 1 });
  await two.put(A, { k: 2 }, "api_key");
  assert.deepEqual(await one.get(A), { k: 2 }, "re-read after the file changed");
  const created = (await one.list())[0].createdAt;
  assert.ok((await one.list())[0].rotatedAt >= created);
  const wrong = new FileSecretStore(d, fixedKey());
  await assert.rejects(wrong.put({ ...A, server: "x" }, 1, "api_key"), /master key does not match/);
});

test("frozen store throws VaultFrozenError on get/put/delete; list still works", async () => {
  const s = new FileSecretStore(dir(), fixedKey());
  await s.put(A, 1, "api_key");
  s.freeze();
  assert.ok(s.isFrozen);
  await assert.rejects(s.get(A), VaultFrozenError);
  await assert.rejects(s.put(A, 2, "api_key"), VaultFrozenError);
  await assert.rejects(s.delete(A), VaultFrozenError);
  assert.equal((await s.list()).length, 1);
  s.unfreeze();
  assert.equal(await s.get(A), 1);
});

test("scope parts that could escape their cell are rejected", async () => {
  const s = new FileSecretStore(dir(), fixedKey());
  for (const bad of ["a/b", "..", "", "x\\y"]) await assert.rejects(s.put({ ...A, user: bad }, 1, "api_key"), /invalid secret scope/);
});

test("key file and passphrase providers persist and agree across instances", async () => {
  const d = dir();
  const k1 = await new KeyFileProvider(join(d, "master.key")).rootKey();
  assert.equal(k1.length, 32);
  assert.deepEqual(await new KeyFileProvider(join(d, "master.key")).rootKey(), k1);
  const p1 = await new PassphraseKeyProvider("correct horse", join(d, "salt")).rootKey();
  assert.deepEqual(await new PassphraseKeyProvider("correct horse", join(d, "salt")).rootKey(), p1);
  assert.notDeepEqual(await new PassphraseKeyProvider("wrong horse", join(d, "salt")).rootKey(), p1);
});

test("openSecretStore: keyfile default, passphrase from the caller, wrong passphrase fails at open", async () => {
  const d = dir();
  const s = await openSecretStore({ backend: "file" }, d);
  await s.put(A, "x", "api_key");
  assert.equal(await (await openSecretStore({ backend: "file" }, d)).get(A), "x");
  const d2 = dir();
  await (await openSecretStore({ backend: "file", passphrase: "pw-one" }, d2)).put(A, "y", "api_key");
  await assert.rejects(openSecretStore({ backend: "file", passphrase: "pw-two" }, d2), /master key does not match/);
  await assert.rejects(openSecretStore({ backend: "file", keyProvider: "passphrase" }, dir()), /OSMCP_MASTER_KEY/);
});

// --- fake HashiCorp Vault: KV v2 + Transit ---------------------------------------

async function fakeVault() {
  const kv = new Map<string, { value?: unknown; custom?: Record<string, string> }>();
  const transit = new Map<string, string>();
  const log: string[] = [];
  const { url } = await listen((req, body) => {
    const u = new URL(req.url!, "http://x");
    log.push(`${req.method} ${u.pathname}${u.search}`);
    if (req.headers["x-vault-token"] !== "s.test") return { status: 403, json: { errors: ["permission denied"] } };
    const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent); // v1, mount, api, ...path
    const [, mount, api, ...rest] = parts;
    const b = body ? JSON.parse(body) : {};
    if (mount === "transit") {
      if (api === "encrypt") {
        const ct = `vault:v1:${randomBytes(12).toString("base64")}`;
        transit.set(ct, b.plaintext);
        return { status: 200, json: { data: { ciphertext: ct, key_version: 1 } } };
      }
      const pt = transit.get(b.ciphertext);
      return pt ? { status: 200, json: { data: { plaintext: pt } } } : { status: 400, json: { errors: ["invalid ciphertext"] } };
    }
    const path = rest.join("/");
    if (u.searchParams.get("list") === "true") {
      const prefix = path ? `${path}/` : "";
      const keys = new Set<string>();
      for (const k of kv.keys()) if (k.startsWith(prefix)) { const tail = k.slice(prefix.length).split("/"); keys.add(tail.length > 1 ? `${tail[0]}/` : tail[0]); }
      return keys.size ? { status: 200, json: { data: { keys: [...keys] } } } : { status: 404, json: { errors: [] } };
    }
    const cell = kv.get(path);
    if (req.method === "GET" && api === "data") return cell?.value !== undefined ? { status: 200, json: { data: { data: cell.value, metadata: {} } } } : { status: 404, json: { errors: [] } };
    if (req.method === "GET") return cell ? { status: 200, json: { data: { custom_metadata: cell.custom ?? null, created_time: "2026-01-01T00:00:00Z", updated_time: "2026-01-01T00:00:00Z" } } } : { status: 404, json: { errors: [] } };
    if (req.method === "POST" && api === "data") { kv.set(path, { ...cell, value: b.data }); return { status: 200, json: { data: { version: 1 } } }; }
    if (req.method === "POST") { kv.set(path, { ...cell, custom: b.custom_metadata }); return { status: 204 }; }
    if (req.method === "DELETE") { kv.delete(path); return { status: 204 }; }
    return { status: 405 };
  });
  return { url, kv, log };
}

test("HashiCorp KV v2 store: put/get/list/delete over the HTTP API; list never reads values", async () => {
  const v = await fakeVault();
  const s = new HashiCorpVaultStore({ addr: v.url, token: "s.test" });
  await s.put(A, { access_token: "tok" }, "oauth2");
  await s.put({ ...A, user: "bob" }, "k", "api_key");
  await s.put({ org: "other", user: "carol", server: "slack" }, "k2", "api_key");
  assert.ok(v.kv.has("one-stop-mcp/acme/alice/github"));
  assert.deepEqual(await s.get(A), { access_token: "tok" });
  assert.equal(await s.get({ ...A, server: "nope" }), undefined);
  v.log.length = 0;
  const all = await s.list();
  assert.equal(all.length, 3);
  assert.ok(!v.log.some((l) => l.includes("/data/")), "list must not touch data endpoints");
  assert.deepEqual((await s.list({ org: "acme" })).map((m) => m.scope.user).sort(), ["alice", "bob"]);
  assert.equal(all.find((m) => m.scope.user === "alice")!.kind, "oauth2");
  assert.equal(await s.delete(A), true);
  assert.equal(await s.delete(A), false);
  s.freeze();
  await assert.rejects(s.get({ ...A, user: "bob" }), VaultFrozenError);
  await assert.rejects(new HashiCorpVaultStore({ addr: v.url, token: "wrong" }).get(A), (e: Error) => /403/.test(e.message) && !e.message.includes("wrong"));
});

test("Vault Transit key provider wraps a random root key and unwraps it on restart", async () => {
  const v = await fakeVault();
  const d = dir();
  const opts = { addr: v.url, token: "s.test", keyName: "osmcp", wrappedKeyFile: join(d, "root.key.transit") };
  const k1 = await new VaultTransitKeyProvider(opts).rootKey();
  assert.equal(k1.length, 32);
  assert.match(readFileSync(opts.wrappedKeyFile, "utf8"), /^vault:v1:/, "only the wrapped key is on disk");
  assert.deepEqual(await new VaultTransitKeyProvider(opts).rootKey(), k1);
  const store = await openSecretStore({ backend: "file", keyProvider: "vault-transit", transit: { addr: v.url, token: "s.test", keyName: "osmcp" } }, d);
  await store.put(A, "via-transit", "api_key");
  assert.equal(await store.get(A), "via-transit");
});

// --- SigV4 + fake AWS KMS -----------------------------------------------------------

const EXAMPLE = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
const T = new Date("2015-08-30T12:36:00Z");
const sigOf = (h: Record<string, string>): string => /Signature=([0-9a-f]+)/.exec(h.Authorization)![1];

test("SigV4 signer matches AWS's published test suite (aws-c-auth aws-signing-test-suite/v4)", () => {
  const get = signV4({ method: "GET", url: "https://example.amazonaws.com/", headers: {}, body: "" }, EXAMPLE, "us-east-1", "service", T);
  assert.equal(sigOf(get), "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"); // get-vanilla
  assert.match(get.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/service\/aws4_request, SignedHeaders=host;x-amz-date, Signature=/);
  const q = signV4({ method: "GET", url: "https://example.amazonaws.com/?Param2=value2&Param1=value1", headers: {}, body: "" }, EXAMPLE, "us-east-1", "service", T);
  assert.equal(sigOf(q), "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500"); // get-vanilla-query-order-key-case
  const post = signV4({
    method: "POST", url: "https://example.amazonaws.com/", body: "Param1=value1",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": "13", "x-amz-content-sha256": "9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e" },
  }, EXAMPLE, "us-east-1", "service", T);
  assert.equal(sigOf(post), "d3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b"); // post-x-www-form-urlencoded
});

test("AWS KMS key provider: GenerateDataKey then Decrypt, SigV4-signed, bound to an encryption context", async () => {
  const blobs = new Map<string, string>();
  const creds = { accessKeyId: "AKIDFAKE", secretAccessKey: "fake-secret" };
  const { url } = await listen((req, body) => {
    const h = req.headers as Record<string, string>;
    const resigned = signV4(
      { method: "POST", url: `http://${h.host}${req.url}`, headers: { "content-type": h["content-type"], "x-amz-target": h["x-amz-target"] }, body },
      creds, "eu-west-1", "kms", new Date(h["x-amz-date"].replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, "$1-$2-$3T$4:$5:$6Z")),
    );
    if (resigned.Authorization !== h.authorization) return { status: 403, json: { __type: "InvalidSignatureException" } };
    const b = JSON.parse(body);
    assert.deepEqual(b.EncryptionContext, { purpose: "one-stop-mcp-root-key" });
    assert.equal(b.KeyId, "alias/osmcp");
    if (h["x-amz-target"] === "TrentService.GenerateDataKey") {
      assert.equal(b.KeySpec, "AES_256");
      const blob = randomBytes(16).toString("base64");
      const plain = randomBytes(32).toString("base64");
      blobs.set(blob, plain);
      return { status: 200, json: { CiphertextBlob: blob, Plaintext: plain, KeyId: "arn:fake" } };
    }
    return blobs.has(b.CiphertextBlob) ? { status: 200, json: { Plaintext: blobs.get(b.CiphertextBlob), KeyId: "arn:fake" } } : { status: 400, json: { __type: "InvalidCiphertextException" } };
  });
  const d = dir();
  const opts = { region: "eu-west-1", keyId: "alias/osmcp", credentials: creds, endpoint: `${url}/`, wrappedKeyFile: join(d, "root.key.kms") };
  const k1 = await new AwsKmsKeyProvider(opts).rootKey();
  assert.equal(k1.length, 32);
  assert.deepEqual(await new AwsKmsKeyProvider(opts).rootKey(), k1, "restart unwraps the persisted blob");
  await assert.rejects(new AwsKmsKeyProvider({ ...opts, credentials: { ...creds, secretAccessKey: "other" } }).rootKey(), /InvalidSignatureException/);
});

test("secretEquals is length-safe and correct", () => {
  assert.ok(secretEquals("abc", "abc"));
  assert.ok(!secretEquals("abc", "abd"));
  assert.ok(!secretEquals("abc", "abcd"));
});
