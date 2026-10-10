# L2 · security — PDR §5 (vault, ledger, kill switch, rotation, MFA, backends)

Branch `OneStop-MCP-security`, worktree `.wt/security`. Read PLAN.md and DECISIONS.md D7, D10,
D11, D14, D16, D17, D19, D29, D30 first. Contracts in `src/contracts.ts`: SecretStore, SecretScope,
SecretMeta, Ledger, LedgerEntry, LedgerInput, LedgerFilter, AccessGuard, AccessDeniedError,
SessionControl, RotationOutcome, AuthBroker (you consume `refresh` and `keyEntryUrl` only).

Owns: `src/security/**`, `test/security*.test.ts`. Existing files there (vault.ts, ledger.ts,
killswitch.ts) are yours to rewrite; `test/security.test.ts` too.

## Build (stdlib node:crypto only — no new deps)

1. **Key hierarchy (D7).** `KeyProvider` interface `{ rootKey(): Promise<Buffer> }` with:
   `PassphraseKeyProvider(passphrase, saltFile)` (scrypt), `KeyFileProvider(path)` (32 random bytes,
   created 0600 if missing — D29), `VaultTransitKeyProvider({ addr, token, keyName, wrappedKeyFile })`
   (generate a random DEK, persist it wrapped via Transit `encrypt`, unwrap via `decrypt`),
   `AwsKmsKeyProvider({ region, keyId, wrappedKeyFile, credentials })` (GenerateDataKey / Decrypt,
   SigV4 signed with node:crypto — verify your signer against AWS's published SigV4 example).
   HKDF-SHA256: org key = HKDF(root, info "org:"+org), user key = HKDF(orgKey, "user:"+user).
2. **`FileSecretStore implements SecretStore`.** AES-256-GCM with the user key, random 12-byte IV,
   AAD = canonical scope string. Persist to `<stateDir>/vault.json` atomically (tmp + rename,
   0600). Metadata (kind, createdAt, rotatedAt) kept beside each record. Frozen → every get/put/
   delete throws `VaultFrozenError`. Ciphertext moved to another cell must fail to decrypt — test it.
3. **`HashiCorpVaultStore implements SecretStore`** — KV v2 at
   `<mount>/data/one-stop-mcp/<org>/<user>/<server>` with `X-Vault-Token`, LIST on metadata for
   `list()`. Test against an in-process fake on 127.0.0.1. `// TODO(live)` on the real endpoint.
4. **`openSecretStore(cfg, stateDir): Promise<SecretStore>`** factory where
   `cfg = { backend: "file" | "hashicorp"; keyProvider: "keyfile" | "passphrase" | "vault-transit" | "aws-kms"; ... }`.
   Passphrase comes from `OSMCP_MASTER_KEY` only (caller passes it in; never read config files for it).
5. **`UsageLedger implements Ledger`** — ctor `{ path?: string; signingKeyPath?: string; burstMax?;
   windowMs?; baseline?: {...} }`. Append-only JSONL when `path` is set (in-memory otherwise).
   Each entry: seq, prev hash, hash = sha256(canonical JSON without hash/sig), Ed25519 sig over hash
   (keypair PEM created 0600 on first use; export the public key). `verifyLedger(path, publicKeyPem)`
   → `{ ok, entries, brokenAt? }`. Reload existing file on start and continue the chain.
   Anomaly detection (D11): rules — burst per (user, server, tool) in window; bulk-shaped tools
   (`export|dump|download|bulk|list_all|backup`) above a lower threshold; denied-rate per user;
   plus per-server EWMA of calls/minute with z-score > 3 after a warm-up. Each flag sets
   `flagged: true` and a `reason`. Keep `all(filter)` (incl. `since`) and `flagged()`.
6. **`KillSwitch implements AccessGuard`** — ctor `{ statePath, store: SecretStore, ledger: Ledger }`,
   `attachSessions(s: SessionControl)` (set after the registry exists). State file (D30) holds
   `lockdown`, `reenabled[]`, `revokedServers[]`, `revokedUsers[]` (as `org/user`); `check()` re-reads
   it when its mtime changes and closes affected sessions on a transition. Methods (all ledgered,
   all take `by`): `revokeAll` (close every session, freeze store, lockdown on), `enableServer(id)`
   (re-enable one connector during lockdown — the store unfreezes, the guard keeps denying every
   other server), `endLockdown`, `revokeServer`/`enableServer`, `revokeUser(user, org)`/`enableUser`,
   `status()`. Denials throw `AccessDeniedError` with a reason and are ledgered as `denied`.
7. **`RotationService`** — ctor `{ store, ledger, broker: Pick<AuthBroker, "refresh" | "keyEntryUrl">,
   manifest: (id: string) => Manifest | undefined, adapters?: Record<string, ApiKeyRotator>, days?: number }`.
   `due(now?)`, `rotate(scope)`, `rotateGroup(filter: { server?; category?; org?; user? })`,
   `rotateAll()`, `startSchedule(intervalMs)` → stop fn (timer `unref`). OAuth → `broker.refresh`;
   api_key with `manifest.auth.rotation` adapter → adapter; otherwise guided → `keyEntryUrl`.
   `ApiKeyRotator { rotate(current: unknown, scope): Promise<unknown> }`; ship `cloudflare`
   (API token roll, coded from Cloudflare's API docs; tested against a fake; `TODO(live)`).
   **`incident({ since?, user?, server?, by })`** — the "after a scare" flow: revokeAll, collect the
   suspect entries from the ledger (flagged or matching the filter), the scopes they could have seen,
   rotate those (or everything when no filter), return a report.
8. **`totp.ts`** — RFC 6238 (SHA-1, 30 s, 6 digits, ±1 step), base32, `generateTotpSecret()`,
   `verifyTotp(secret, code, now?)`, `totpUri(secret, label, issuer)`. Test with the RFC 6238
   Appendix B vectors.
9. **`redact.ts`** — `redact(value, secrets: string[])` deep-replaces known secret strings with
   `[REDACTED]`; `scrub(text)` removes bearer tokens / common key shapes. Used on downstream results
   and errors before they reach a model or a log.
10. Barrel `src/security/index.ts` exporting all of the above.

## Done when

`npx tsc --noEmit && npm test` green (in your worktree `npm test` runs every test file — other
lanes' old tests may break from your API changes only in `test/security.test.ts`, which is yours;
`test/gateway.test.ts` must keep passing or you report why). Branch pushed. Final message: short
report of APIs as built (exact signatures), anything needed outside your paths.
