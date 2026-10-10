# Security

How the gateway protects the credentials it holds, what it does not protect, and how to respond when something looks wrong. Related: [SECURITY.md](../SECURITY.md) (how to report a vulnerability) · [architecture](architecture.md) · [configuration](configuration.md).

The gateway is a single place that holds every OAuth token and API key a user has connected. That is what makes rotation, audit and a kill switch possible, and it is also what makes the gateway a high-value target. This document says plainly where the defences are and where they stop.

> **Status.** Pre-release and unaudited. Nobody outside the project has reviewed this design or code. Do not put production credentials in it yet.

## Threat model

### What is protected

| Asset | Where it lives |
|---|---|
| OAuth access and refresh tokens, API keys, OAuth client secrets | The vault (`vault.json` or HashiCorp Vault KV) |
| The root key that unlocks the vault | `OSMCP_MASTER_KEY`, a key file, or a KMS/Transit-wrapped data key |
| Gateway bearer tokens and admin TOTP secrets | `users.json` (hashes only), the vault (TOTP secrets) |
| The record of who used which credential | The signed ledger |

### Who we defend against

| Adversary | What we do | Where it stops |
|---|---|---|
| **A confused or prompt-injected model** | Secrets never enter the model's context: `connect_server` returns a URL, keys are typed into the gateway's own page, results are redacted. Admin powers are not meta-tools, so a model cannot freeze the vault, rotate keys or read the ledger. | A model can still call `invoke` with the user's connected credentials and ask a connected server to do harm. Least privilege is the provider-side scope you granted. The ledger and anomaly flags are how you notice. |
| **Another tenant (team mode)** | Per-org and per-user keys, and every record is bound to its (org, user, server) cell, so moving a ciphertext to another cell fails to decrypt. | A bug in principal handling would break isolation; that code is the review priority. |
| **Someone who copies the state directory** | AES-256-GCM at rest; `vault.json` is mode 0600; token hashes only. | The root key is the weak point. In local mode the key file sits beside the vault (the SSH-key model): anyone who can read both can decrypt. Use `OSMCP_MASTER_KEY` or a KMS provider if that matters. |
| **A downstream server that turns out to be hostile or compromised** | It receives only the credential for its own call, and stdio children get a minimal environment, never the gateway's. Results and errors are scrubbed of known secrets. | The downstream server **does** see the credential it is sent; that is the point of calling it. Choose servers you trust, prefer official ones, and scope tokens narrowly. |
| **A network attacker** | Bearer tokens on `/mcp`, TOTP on the admin API, strict headers on the key-entry page. | The gateway speaks plain HTTP. Without TLS in front of it, tokens and admin codes cross the network in clear text. Always terminate TLS ([deployment](deployment.md#tls-and-reverse-proxies)). |
| **A leaked gateway bearer token** | It identifies one user. Only its hash is stored. Revoke the user, or cut one server or everything with the kill switch. | The token holds that user's access until revoked. |
| **A leaked admin token** | The admin API also needs a current TOTP code. | A leaked admin token plus the authenticator secret is full admin. |
| **Tampering with the audit log** | Hash chain plus an Ed25519 signature per entry; `ledger verify` needs only the public key. | Truncating the tail of the log removes the newest entries without breaking the chain; keep external copies or the latest hash. An attacker who also holds the signing key can forge a new chain. |

### Out of scope

- Root or admin on the host running the gateway. It can read process memory and the key.
- Vulnerabilities in downstream servers themselves.
- Side channels, hardware attacks, and a malicious operator of the gateway.
- Denial of service by an authenticated admin.

## Key hierarchy

```text
root key  (32 bytes)
   │  from: key file | scrypt(OSMCP_MASTER_KEY) | Vault Transit-wrapped key | AWS KMS-wrapped key
   │
   ├─ HKDF-SHA256, info = "org:" + org      → org key
   │      └─ HKDF-SHA256, info = "user:" + user  → user key
   │             └─ AES-256-GCM, random 12-byte IV, AAD = canonical (org, user, server) → one record
```

- **One root, derived keys below it** (Q4 in [RFC 0001](rfcs/0001-v1-open-questions.md)). Per-org partitions and per-user keys together, so isolation is cryptographic and not only a lookup filter.
- **AAD binding.** Each record's additional authenticated data is its own scope. A ciphertext copied into another user's or server's cell fails authentication. There is a test for it.
- **Standards.** HKDF is RFC 5869; AES-GCM is NIST SP 800-38D. The implementation uses Node's built-in `node:crypto`, not a third-party library, so there is no native dependency. The design brief named libsodium; AES-256-GCM is the same class of authenticated encryption ([D14](burndown/DECISIONS.md)).
- **Key providers** ([configuration](configuration.md#key-providers)):
  - `keyfile`: random 32 bytes in `master.key`, mode 0600, created on first use. Local mode default.
  - `passphrase`: `OSMCP_MASTER_KEY` stretched with scrypt and a salt file. Team default.
  - `vault-transit`: a random data key, stored wrapped by HashiCorp Vault Transit and unwrapped on start.
  - `aws-kms`: a random data key via `GenerateDataKey`, stored wrapped by KMS and unwrapped with `Decrypt`. Requests are signed with AWS SigV4 implemented on `node:crypto`; it is checked against AWS's published example.
- **Storage backends.** `file` (`vault.json`, written atomically through a temporary file, mode 0600) or HashiCorp Vault KV v2 at `<mount>/data/one-stop-mcp/<org>/<user>/<server>`. <!-- verify: whether values stored in Vault KV are also sealed client-side with the user key, or rely on Vault's own encryption only. -->
- **Not built:** GCP KMS and Azure Key Vault. They fit behind the `KeyProvider` interface.

The master key is only ever read from `OSMCP_MASTER_KEY` ([D29](burndown/DECISIONS.md)). Team mode refuses to start without it or a KMS provider.

## Least-privilege injection

A credential is added to an outbound call and nowhere else:

- **stdio servers**: put in the one environment variable the manifest names (`auth.env`). The child's environment is built from the SDK's default safe variables, the manifest's `transport.env`, and that credential. It is **not** a copy of the gateway's environment, so `OSMCP_MASTER_KEY` cannot reach a downstream server ([D31](burndown/DECISIONS.md)).
- **HTTP servers**: put in one header (`auth.header`, default `Authorization` with a `Bearer ` prefix), or handled by the SDK's OAuth provider.
- It is never placed in tool results, error messages, the ledger, logs, or the client's configuration.

If no credential is stored, the call fails with a message telling the model to run `connect_server`. The message contains no secret.

## Redaction

Downstream results and errors pass through redaction before they reach the model or a log:

- `redact(value, secrets)` walks a value and replaces every known secret string with `[REDACTED]`. The registry passes in the credentials it injected for that call.
- `scrub(text)` removes bearer tokens and common API-key shapes from text.

A downstream server that echoes the key it was given returns `[REDACTED]`; there is a test for this. Redaction only catches secrets the gateway knows about or recognises by shape; it is a safety net, not a substitute for choosing trustworthy servers.

## Connecting credentials: secrets never pass through the model

([D18](burndown/DECISIONS.md))

- `connect_server` returns a URL: the provider's authorization page, or the gateway's key-entry page. The user types a key into the gateway, not the chat.
- Key-entry tickets are 32 random bytes, valid 15 minutes, bound to one (org, user, server), and consumed on use.
- The key-entry page sends `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, a strict Content-Security-Policy and `X-Frame-Options: DENY`, and rejects cross-origin POSTs (`Origin` / `Sec-Fetch-Site`).
- OAuth uses PKCE (S256) and a `state` parameter. The authorization-code flow for HTTP servers follows the MCP authorization specification. An unknown or expired `state` is rejected.

## Usage ledger

Every credential use and every admin action is appended to the ledger: which user, which server, which tool, when, and the result (`authorized`, `denied`, `error`).

- **Tamper evidence** ([D19](burndown/DECISIONS.md)). Entries are JSON lines. Each has a sequence number, the hash of the previous entry, its own SHA-256 hash over its canonical JSON, and an Ed25519 signature over that hash. The signing key pair is a PEM created with mode 0600 on first use. `one-stop-mcp ledger verify` re-checks the chain and every signature using the **public** key alone; a verifier needs no secret. A reload continues the existing chain.
- **Why Ed25519 and not an HMAC:** with an HMAC the verifier must hold the secret, and then can also forge entries.
- **Anomaly flags** ([D11](burndown/DECISIONS.md)). Rules work from the first call:
  - **Burst**: more than `ledger.burstMax` calls to one (user, server, tool) within `ledger.windowMs` (default 100 in 60 s).
  - **Bulk-shaped tools**: tool names containing `export`, `dump`, `download`, `bulk`, `list_all` or `backup` are flagged at a lower threshold.
  - **Denied rate**: a user whose calls keep being denied.
  - **Baseline**: a per-server exponentially weighted moving average of calls per minute; a z-score above 3 after a warm-up period flags the call. This catches connectors whose normal is very different from the defaults.
  There is no learned model. Rules are explainable: each flagged entry has `flagged: true` and a `reason`.
- **Reading it**: `one-stop-mcp ledger tail`, `ledger flagged`, the admin page, or `GET /admin/api/ledger` with `user`, `server`, `since` and `limit` filters.

<!-- verify: anomaly thresholds for the bulk-shaped and denied-rate rules are not fixed in the briefs; fill in the defaults from src/security/ledger.ts. -->

## Kill switch

Three scopes, all ledgered with who did it ([D17](burndown/DECISIONS.md), [D30](burndown/DECISIONS.md)):

| Action | CLI | Effect |
|---|---|---|
| **Revoke all** | `kill all` | Closes every downstream session, freezes the vault (every read and write throws), and puts the gateway into **lockdown**: every outbound credential use is denied. |
| **Revoke a server** | `kill server <id>` | Closes that server's sessions and denies calls to it. |
| **Revoke a user** | `kill user <org/user>` | Closes that user's sessions and denies their calls. |

**Re-enabling is deliberate and one at a time.** During lockdown `enable server <id>` unfreezes the vault but keeps denying every other server, so you bring connectors back individually once you have found the culprit. `lockdown end` leaves lockdown entirely. `enable user <org/user>` re-enables a revoked user.

State lives in a file that the guard re-reads whenever it changes. Running `kill all` in a terminal therefore takes effect inside an already-running local gateway at once, without a restart or a network call. Denied calls raise an access-denied error with a reason and are recorded in the ledger as `denied`.

Admin powers are deliberately not meta-tools: they are available through the CLI, the TOTP-protected admin API and the admin page, never through the model.

## Rotation

([D10](burndown/DECISIONS.md))

Rotate **one** credential, a **group** (by server, category, org or user), or **everything**, on demand or on a schedule. The default policy is 90 days (`rotation.days`), checked every `rotation.checkEveryMs`.

| Credential | How it rotates |
|---|---|
| **OAuth** | Refresh-token grant against the provider; the new tokens replace the old in the vault. Fully automated. Needs a refresh token; if the provider issued none, the credential reports as not rotatable and the user reconnects. |
| **API key, provider has a key-management API** | An adapter named in the manifest (`auth.rotation`) issues a new key and retires the old one. Cloudflare's API-token roll ships first. It is written from Cloudflare's API documentation and tested against a fake, so check it against the real API before relying on it. |
| **API key, no such API** | **Guided**: the outcome is `guided` with a link to the gateway's key-entry page and the provider's key page (`auth.keyUrl`). The user issues a new key and pastes it in. |

Commands: `rotate due`, `rotate <server>`, `rotate --category <c>`, `rotate --all`. Each credential returns an outcome (`rotated`, `guided`, `failed`, `skipped`).

### After a scare: the incident flow

`one-stop-mcp incident [--user u] [--server s] [--since ISO]`, or the button in the admin page, runs one sequence from suspicion to clean slate:

1. **Revoke all**: kill every session and freeze the vault.
2. **Collect suspects** from the ledger: flagged entries, or those matching your filter.
3. **Work out the scopes** those entries could have touched.
4. **Rotate** exactly those credentials (or everything, if you gave no filter).
5. **Report** what was revoked and rotated. Credentials that could only be rotated by guidance appear with their links.

The gateway stays in lockdown afterwards. Re-enable servers one at a time once you are satisfied.

## Admin authentication and MFA

([D16](burndown/DECISIONS.md))

- Users authenticate to the gateway with a bearer token `osmcp_<base64url of 32 random bytes>`. Only the SHA-256 hash is stored.
- The admin API needs the admin's bearer token **and** a TOTP code in `X-OSMCP-TOTP`: RFC 6238, SHA-1, 30-second step, 6 digits, accepting one step either side. Secrets are stored in the vault under the admin's own scope.
- Every admin call is written to the ledger.
- In local mode the person at the terminal is the admin, with no MFA: access to the state directory is already full control. The CLI is the interface.
- Becoming a full OAuth authorization server for clients is a possible later upgrade; the MCP authorization specification makes server-side auth optional.

## Hardening checklist for a team deployment

- [ ] TLS in front of the gateway; `http.publicUrl` is `https://...`.
- [ ] `OSMCP_MASTER_KEY` comes from a secret manager or env file with mode 0600, not from a shell history or compose file. Or a KMS provider.
- [ ] The host port is published on loopback or a private network only.
- [ ] `metrics.token` is set if `/metrics` is reachable.
- [ ] Only trusted people have admin accounts; each uses their own authenticator.
- [ ] The state directory and its backups are protected like a password database; the ledger and its public key are copied somewhere the gateway host cannot rewrite.
- [ ] You have tried `kill all`, `enable server` and `ledger verify` once before you need them.
- [ ] Downstream tokens are scoped as narrowly as the provider allows.

## References

- RFC 5869, HKDF. NIST SP 800-38D, GCM. RFC 6238, TOTP. RFC 8032, Ed25519.
- MCP specification, transports and authorization (2025-06-18); RFC 9728, RFC 8414, RFC 7591, RFC 7636 (PKCE).
- HashiCorp Vault KV v2 and Transit API documentation; AWS KMS `GenerateDataKey` and `Decrypt`; AWS Signature Version 4.
