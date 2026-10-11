import { test } from "node:test";
import assert from "node:assert/strict";
import { base32Decode, base32Encode, generateTotpSecret, matchTotp, redact, scrub, totp, totpUri, verifyTotp } from "../src/security/index.js";

// RFC 6238 Appendix B, SHA-1 seed "12345678901234567890".
const SEED = base32Encode(Buffer.from("12345678901234567890"));
const VECTORS: Array<[number, string]> = [
  [59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"],
  [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"],
];

test("TOTP matches the RFC 6238 Appendix B vectors (8 digits, and their 6-digit tails)", () => {
  assert.equal(SEED, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  for (const [t, code] of VECTORS) {
    assert.equal(totp(SEED, t * 1000, 8), code, `T=${t}`);
    assert.equal(totp(SEED, t * 1000), code.slice(2));
    assert.ok(verifyTotp(SEED, code.slice(2), t * 1000));
  }
});

test("TOTP accepts ±1 step of drift, returns the step for replay checks, rejects the rest", () => {
  const now = 1111111111_000;
  const step = Math.floor(now / 30_000);
  assert.equal(matchTotp(SEED, totp(SEED, now - 30_000), now), step - 1);
  assert.equal(matchTotp(SEED, totp(SEED, now + 30_000), now), step + 1);
  assert.equal(matchTotp(SEED, totp(SEED, now - 60_000), now), undefined);
  assert.ok(!verifyTotp(SEED, "12345", now));
  assert.ok(!verifyTotp(SEED, "abcdef", now));
  const s = generateTotpSecret();
  assert.equal(base32Decode(s).length, 20);
  assert.ok(verifyTotp(s, totp(s)));
  assert.equal(totpUri(s, "alice@acme", "One-Stop MCP"), `otpauth://totp/One-Stop%20MCP:alice%40acme?secret=${s}&issuer=One-Stop%20MCP&algorithm=SHA1&digits=6&period=30`);
  assert.throws(() => base32Decode("not base32!"), /invalid base32/);
});

test("redact deep-replaces known secrets in results and errors, leaves the rest alone", () => {
  const result = { content: [{ type: "text", text: "your key is sk_live_abc123 and abc123" }], meta: { n: 1, ok: true, nil: null } };
  assert.deepEqual(redact(result, ["abc123", "sk_live_abc123", ""]), {
    content: [{ type: "text", text: "your key is [REDACTED] and [REDACTED]" }],
    meta: { n: 1, ok: true, nil: null },
  });
  const err = redact(new TypeError("401 for token tok-999"), ["tok-999"]);
  assert.ok(err instanceof Error);
  assert.equal(err.name, "TypeError");
  assert.equal(err.message, "401 for token [REDACTED]");
  const cyclic: any = { a: "x-secret" };
  cyclic.self = cyclic;
  assert.deepEqual(redact(cyclic, ["x-secret"]), { a: "[REDACTED]", self: "[Circular]" });
  assert.equal(redact("nothing to hide", []), "nothing to hide");
});

test("scrub removes credential-shaped text it was not told about", () => {
  const cases: Array<[string, string]> = [
    ["Authorization: Bearer abcdefgh12345678", "Bearer [REDACTED]"],
    ["token ghp_" + "a".repeat(36) + " leaked", "token [REDACTED] leaked"],
    ["xoxb-123456789012-abcdef", "[REDACTED]"],
    ["key AKIAIOSFODNN7EXAMPLE here", "key [REDACTED] here"],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_part", "jwt [REDACTED]"],
    ["fetch https://user:hunter2@example.com/x failed", "fetch https://[REDACTED]@example.com/x failed"],
    ['{"access_token":"s3cr3t-value","n":1}', '{"access_token":"[REDACTED]","n":1}'],
    ["GET /cb?code=x&client_secret=abcd1234&state=y", "client_secret=[REDACTED]&state=y"],
    ["-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----", "[REDACTED]"],
  ];
  for (const [input, expected] of cases) {
    const out = scrub(input);
    assert.ok(out.includes(expected), `${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
  }
  assert.equal(scrub("max_tokens: 500, 40 tokens used"), "max_tokens: 500, 40 tokens used", "ordinary text survives");
});
