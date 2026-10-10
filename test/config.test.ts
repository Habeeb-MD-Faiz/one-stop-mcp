import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

const dir = mkdtempSync(join(tmpdir(), "osmcp-config-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, text: string) => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};

test("defaults: local mode, loopback, port 8420, keyfile provider", () => {
  const c = loadConfig({ env: { OSMCP_HOME: dir } });
  assert.equal(c.mode, "local");
  assert.equal(c.home, dir);
  assert.equal(c.http.host, "127.0.0.1");
  assert.equal(c.http.port, 8420);
  assert.equal(c.http.publicUrl, "http://127.0.0.1:8420");
  assert.equal(c.vault.keyProvider, "keyfile");
  assert.equal(c.rotation.days, 90);
  assert.equal(c.compress, "light");
});

test("precedence: file < env < argv; file paths resolve against the file", () => {
  const cfg = file("a.yaml", "mode: local\nttlMs: 5000\ncompress: aggressive\nserversDir: ./srv\nhttp:\n  port: 9000\n");
  const env = { OSMCP_HOME: dir, OSMCP_CONFIG: cfg, OSMCP_PORT: "9100", OSMCP_MASTER_KEY: "k" };
  const c = loadConfig({ env });
  assert.equal(c.ttlMs, 5000, "file beats default");
  assert.equal(c.compress, "aggressive");
  assert.equal(c.http.port, 9100, "env beats file");
  assert.equal(c.serversDir, join(dir, "srv"));
  assert.equal(c.vault.keyProvider, "passphrase", "master key in env selects the passphrase provider");
  const t = loadConfig({ env, argv: ["serve", "--http"] });
  assert.equal(t.mode, "team", "argv beats file");
  assert.equal(t.http.host, "0.0.0.0");
  const viaFlag = loadConfig({ env: { OSMCP_HOME: dir }, argv: ["--config", cfg] });
  assert.equal(viaFlag.http.port, 9000);
});

test("local mode forces loopback even if the file asks otherwise", () => {
  const cfg = file("b.yaml", "http:\n  host: 0.0.0.0\n");
  assert.equal(loadConfig({ env: { OSMCP_HOME: dir, OSMCP_CONFIG: cfg } }).http.host, "127.0.0.1");
});

test("team mode refuses to start without a master key or KMS", () => {
  assert.throws(() => loadConfig({ env: { OSMCP_HOME: dir, OSMCP_MODE: "team" } }), /refuses to start without OSMCP_MASTER_KEY/);
  const ok = loadConfig({ env: { OSMCP_HOME: dir, OSMCP_MODE: "team", OSMCP_MASTER_KEY: "x" } });
  assert.equal(ok.masterKey, "x");
  const kms = file("kms.yaml", "mode: team\nvault:\n  keyProvider: aws-kms\n  awsKms:\n    region: us-east-1\n    keyId: alias/osmcp\n");
  assert.throws(() => loadConfig({ env: { OSMCP_HOME: dir, OSMCP_CONFIG: kms } }), /AWS_ACCESS_KEY_ID/);
  const c = loadConfig({ env: { OSMCP_HOME: dir, OSMCP_CONFIG: kms, AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" } });
  assert.equal(c.vault.awsKms?.keyId, "alias/osmcp");
});

test("credentials and typos in the file fail loud; bad values name the field", () => {
  const secret = file("s.yaml", "masterKey: hunter2\n");
  assert.throws(() => loadConfig({ env: { OSMCP_HOME: dir, OSMCP_CONFIG: secret } }), /environment only/);
  const token = file("t.yaml", "metrics:\n  token: abc\n");
  assert.throws(() => loadConfig({ env: { OSMCP_HOME: dir, OSMCP_CONFIG: token } }), /metrics\.token.*environment only/);
  const typo = file("typo.yaml", "mdoe: team\n");
  assert.throws(() => loadConfig({ env: { OSMCP_HOME: dir, OSMCP_CONFIG: typo } }), /unknown key "mdoe"/);
  assert.throws(() => loadConfig({ env: { OSMCP_HOME: dir, OSMCP_PORT: "http" } }), /http\.port/);
  assert.throws(() => loadConfig({ env: { OSMCP_HOME: dir, OSMCP_MODE: "cloud" } }), /mode must be one of/);
  assert.throws(() => loadConfig({ env: { OSMCP_HOME: dir }, argv: ["--config", join(dir, "missing.yaml")] }), /cannot read/);
});
