# Configuration

Every setting, with its default, for both modes. Related: [deployment](deployment.md) · [security](security.md) · [architecture](architecture.md).

A working team-mode example is in [`examples/team.config.yaml`](examples/team.config.yaml).

## Where settings come from

From lowest to highest priority:

1. Built-in defaults.
2. The config file `one-stop-mcp.config.yaml` (any name works). Its path is `--config <path>`, else the `OSMCP_CONFIG` environment variable, else `$OSMCP_HOME/config.yaml` if that file exists. With none of these the gateway runs on defaults.
3. `OSMCP_*` environment variables ([table](#environment-variables)).
4. Command-line flags (`--http` sets `mode: team`).

Config is validated at start-up and the gateway **fails loudly** on a bad value, naming the field. Unknown keys in the file are errors, so a typo is caught instead of ignored. Relative `home`, `serversDir` and `catalogDir` paths in the file are resolved against the file's own directory.

**Credentials are never read from the file.** The master key, the Vault token, AWS keys and the metrics token come only from the environment ([D29](burndown/DECISIONS.md)). A config file that contains a key like `token` or `secret` is rejected with a message saying so, which means a config file is safe to commit or mount read-only.

## Modes

`mode: local | team` ([D23](burndown/DECISIONS.md)).

| | `local` | `team` |
|---|---|---|
| Started by | `one-stop-mcp serve` (the default command) | `one-stop-mcp serve --http` (or `mode: team`) |
| Clients connect over | stdio | Streamable HTTP at `/mcp` |
| HTTP listener | `127.0.0.1` only (forced); serves `/oauth/callback`, `/connect/*`, `/healthz` | `http.host` (default `0.0.0.0`); serves everything in [HTTP routes](#http-routes) |
| Gateway authentication | none; the single principal is `local` | bearer token per user |
| Master key | `OSMCP_MASTER_KEY` if set, else a generated key file `$OSMCP_HOME/master.key` (mode 0600) | `OSMCP_MASTER_KEY` or a KMS key provider (`vault-transit`, `aws-kms`); **refuses to start** without one |

In local mode the loopback listener also rejects any request whose `Host` header is not `127.0.0.1:<port>`, `localhost:<port>` or the `publicUrl` host, which blocks DNS-rebinding attacks from a web page.

## Config file reference

```yaml
mode: local                 # local | team
home: ~/.one-stop-mcp       # state directory (same as OSMCP_HOME)
serversDir: ./servers       # manifests; default is the repo's servers/
catalogDir: ./catalog       # shipped tool snapshots; default is the repo's catalog/

http:
  host: 127.0.0.1           # team default 0.0.0.0; local mode forces 127.0.0.1
  port: 8420
  publicUrl: http://127.0.0.1:8420   # base for OAuth redirects and key-entry links

vault:
  backend: file             # file | hashicorp
  keyProvider: keyfile      # keyfile | passphrase | vault-transit | aws-kms
  hashicorp:                # when backend: hashicorp (token: VAULT_TOKEN in the environment)
    addr: http://127.0.0.1:8200
    mount: secret
  transit:                  # when keyProvider: vault-transit (token: VAULT_TOKEN)
    addr: http://127.0.0.1:8200
    keyName: one-stop-mcp
    mount: transit
  awsKms:                   # when keyProvider: aws-kms (credentials: AWS_* in the environment)
    region: eu-west-1
    keyId: alias/one-stop-mcp

routing:
  embeddings: on            # on | off
  model: Xenova/bge-small-en-v1.5

compress: light             # off | light | aggressive
ttlMs: 60000                # idle downstream sessions are closed after this

rotation:
  days: 90
  checkEveryMs: 3600000

ledger:
  burstMax: 100
  windowMs: 60000
```

### Fields

| Field | Default | Meaning |
|---|---|---|
| `mode` | `local` | See [Modes](#modes). |
| `home` | `~/.one-stop-mcp` | State directory ([contents](#state-directory)). Overridden by `OSMCP_HOME`. |
| `serversDir` | repo `servers/` | Where `*.yaml` manifests are loaded from. `servers/_candidates/` is never loaded. |
| `catalogDir` | repo `catalog/` | Shipped tool snapshots. Read-only; refreshed snapshots go to `home`. |
| `http.host` | `127.0.0.1` in local mode (forced), `0.0.0.0` in team mode | Bind address. |
| `http.port` | `8420` | Listen port ([D32](burndown/DECISIONS.md)). Integer 0-65535. |
| `http.publicUrl` | `http://127.0.0.1:<port>` (or `http://<host>:<port>` for a specific host) | The URL a **browser** uses to reach the gateway. OAuth redirect URIs (`{publicUrl}/oauth/callback`) and key-entry links (`{publicUrl}/connect/{ticket}`) are built from it. Behind a reverse proxy set it to the public HTTPS address. Must be an `http(s)` URL. |
| `vault.backend` | `file` | `file`: encrypted `vault.json` in `home`. `hashicorp`: HashiCorp Vault KV v2 (Vault encrypts at rest; the gateway adds no second layer). Needs `VAULT_TOKEN` or `OSMCP_VAULT_TOKEN`. |
| `vault.keyProvider` | `passphrase` if `OSMCP_MASTER_KEY` is set, otherwise `keyfile` | Where the file backend's root key comes from. See [Key providers](#key-providers). `passphrase` without the variable is an error. |
| `vault.hashicorp` | none | `addr` (required), `mount` (default `secret`). Secrets live at `<mount>/data/one-stop-mcp/<org>/<user>/<server>`. |
| `vault.transit` | none | `addr`, `keyName` (required), `mount` (default `transit`). Needs `VAULT_TOKEN` or `OSMCP_VAULT_TOKEN`. |
| `vault.awsKms` | none | `region`, `keyId` (required). Needs `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (and `AWS_SESSION_TOKEN` if you use temporary credentials) in the environment. |
| `routing.embeddings` | `on` | `on` tries the local embedding model and falls back to lexical + BM25 if it cannot load. `off` never loads it. |
| `routing.model` | `Xenova/bge-small-en-v1.5` | Embedding model id. The other tested model is `Xenova/all-MiniLM-L6-v2`. |
| `compress` | `light` | Schema compression for `find_tools` results. `off`, `light`, or `aggressive`. See [routing](routing.md#schema-compression). |
| `ttlMs` | `60000` | Idle time before a pooled downstream session is closed. 1000-86400000. |
| `rotation.days` | `90` | Credentials older than this are reported by `rotate due`. 1-3650. |
| `rotation.checkEveryMs` | `3600000` (one hour) | How often the rotation scheduler runs. 60000-86400000. |
| `ledger.burstMax` | `100` | More than this many calls to one (user, server, tool) inside `windowMs` is flagged. |
| `ledger.windowMs` | `60000` | Window for the anomaly rules. 1000-86400000. |

Two rules the code enforces that are easy to trip over:

- **Team mode needs a master key or a KMS key provider, whichever backend you use.** Even with `vault.backend: hashicorp`, team mode refuses to start with the default `keyfile` provider. Set `OSMCP_MASTER_KEY` (it is simply unused by the Vault KV backend) or use a KMS provider.
- **`vault.keyProvider` only affects the `file` backend.**

### Key providers

All of them produce the 32-byte root key from which per-org and per-user keys are derived ([security](security.md#key-hierarchy)).

| `keyProvider` | Root key comes from | Use for |
|---|---|---|
| `keyfile` | A random 32-byte file, `$OSMCP_HOME/master.key`, created with mode 0600 on first use. | Local desktop use. No passphrase prompt; the protection is file permissions, the same model as an SSH key. |
| `passphrase` | `OSMCP_MASTER_KEY`, stretched with scrypt using a random salt file `$OSMCP_HOME/master.salt`. | Team mode and Docker. |
| `vault-transit` | A random root key stored wrapped by HashiCorp Vault Transit (`$OSMCP_HOME/root.key.transit`) and unwrapped at start. | Team mode when Vault is the key authority. |
| `aws-kms` | A random root key from KMS `GenerateDataKey`, stored wrapped (`$OSMCP_HOME/root.key.kms`) and unwrapped with `Decrypt`. | Team mode on AWS. |

GCP and Azure KMS sit behind the same `KeyProvider` interface but are not built.

## Environment variables

| Variable | Config equivalent | Meaning |
|---|---|---|
| `OSMCP_MASTER_KEY` | none (env only) | Passphrase for the vault root key. **Required in team mode** unless a KMS key provider is configured. Never put it in the config file, a Dockerfile, or a command line. If you lose or change it, stored credentials become unreadable. |
| `OSMCP_HOME` | `home` | State directory. Default `~/.one-stop-mcp`. In the Docker image it is `/data`. |
| `OSMCP_CONFIG` | none | Path to the config file. |
| `OSMCP_MODE` | `mode` | `local` or `team`. |
| `OSMCP_HOST` | `http.host` | Bind address. |
| `OSMCP_PORT` | `http.port` | Listen port. |
| `OSMCP_PUBLIC_URL` | `http.publicUrl` | Public base URL. |
| `OSMCP_SERVERS_DIR` | `serversDir` | Manifest directory. |
| `OSMCP_CATALOG_DIR` | `catalogDir` | Shipped snapshot directory. |
| `OSMCP_VAULT_BACKEND` | `vault.backend` | `file` or `hashicorp`. |
| `OSMCP_KEY_PROVIDER` | `vault.keyProvider` | See [Key providers](#key-providers). |
| `OSMCP_EMBEDDINGS` | `routing.embeddings` | `on` or `off`. |
| `OSMCP_MODEL` | `routing.model` | Embedding model id. |
| `OSMCP_COMPRESS` | `compress` | `off`, `light` or `aggressive`. |
| `OSMCP_TTL_MS` | `ttlMs` | Idle session timeout. |
| `OSMCP_ROTATION_DAYS` | `rotation.days` | Rotation policy age. |
| `OSMCP_VAULT_TOKEN`, `VAULT_TOKEN` | none (env only) | Token for the HashiCorp KV backend and the Transit key provider. `OSMCP_VAULT_TOKEN` wins. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | none (env only) | Credentials for the `aws-kms` key provider. |
| `OSMCP_METRICS_TOKEN` | none (env only) | If set, `/metrics` requires `Authorization: Bearer <token>`. |
| `OSMCP_ADMIN_TOKEN`, `OSMCP_TOTP` | none | Used by the CLI's `--remote` mode instead of `--token` / `--totp`. |

Downstream stdio servers do **not** inherit the gateway's environment. A child process gets only the MCP SDK's default safe variables (on Linux and macOS: `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`; on Windows `APPDATA`, `USERPROFILE`, `PATH`, `TEMP` and similar), the manifest's `transport.env`, and the injected credential. So `OSMCP_MASTER_KEY` cannot leak into a downstream server ([D31](burndown/DECISIONS.md)), and tools that look in `~/.aws` or `~/.kube` find them through `HOME`. If a server needs something like `AWS_PROFILE` or `KUBECONFIG`, set it in that manifest's `transport.env`.

## State directory

Everything the gateway writes lives under `home`. Back it up; protect it like a password database.

| What | File | Notes |
|---|---|---|
| Encrypted secrets | `vault.json` | Mode 0600, written atomically. Absent with the `hashicorp` backend. |
| Local root key | `master.key` | Local mode without `OSMCP_MASTER_KEY`. Mode 0600. |
| Passphrase salt | `master.salt` | `passphrase` key provider. Random, not secret, but needed to unlock the vault. |
| Wrapped root key | `root.key.transit`, `root.key.kms` | `vault-transit` / `aws-kms` providers. |
| Users and token hashes | `users.json` | Mode 0600. Only SHA-256 hashes of tokens. |
| Kill-switch state | `killswitch.json` | Re-read whenever it changes, so `one-stop-mcp kill all` takes effect inside a running gateway immediately ([D30](burndown/DECISIONS.md)). A corrupt file makes every check fail closed. |
| Usage ledger | `ledger.jsonl` | Append-only, hash-chained, signed. |
| Ledger signing key | `ledger-signing.pem`, `ledger-signing.pem.pub` | Ed25519, private key mode 0600. Keep a copy of the `.pub` file for [verification](security.md#usage-ledger). |
| Refreshed snapshots | `catalog/` | Override the shipped snapshots. |
| Embedding cache and model | `embeddings/`, `embeddings/models/` | Safe to delete; they are rebuilt or re-downloaded. |

## HTTP routes

| Route | Mode | Auth | Purpose |
|---|---|---|---|
| `POST/GET/DELETE /mcp` | team | `Authorization: Bearer osmcp_...` | MCP Streamable HTTP endpoint. Returns 401 with `WWW-Authenticate: Bearer` without a valid token. The first request must be an `initialize` POST; later requests carry the `mcp-session-id` header, and a session only works for the user who opened it. Idle sessions are closed after 30 minutes. Request bodies up to 4 MB. |
| `GET /oauth/callback` | both | `state` parameter | OAuth redirect target. |
| `GET/POST /connect/:ticket` | both | one-time ticket in the URL | Key-entry form. Cross-origin POSTs are rejected. |
| `/admin/api/*` | team | admin bearer **and** a TOTP code (see below) | Admin API. 1 MB body limit. Every call is ledgered. |
| `GET /admin` | team | token entered in the page | Self-contained admin page. |
| `GET /metrics` | team | optional bearer (`OSMCP_METRICS_TOKEN`) | Prometheus text format. |
| `GET /healthz` | both | none | Liveness. |

### Admin API authentication

Every admin call needs the admin's bearer token. On top of that:

1. Send a current TOTP code in `X-OSMCP-TOTP`. A code is accepted **once** (RFC 6238 section 5.2), so replaying the same code fails.
2. A good code returns an `x-osmcp-admin-session` response header. Send that header back (still with the bearer token on every call) and the API stays unlocked for **15 minutes** without another code. The admin page does this for you.
3. Five wrong codes within five minutes lock that admin out for the rest of the window (HTTP 429). Failed attempts are ledgered as `admin.auth` denials.

Routes (all under `/admin/api/`): `GET ledger` (`user`, `server`, `since`, `limit` query parameters), `GET ledger/verify`, `GET ledger/flagged`, `GET kill`, `POST kill/all`, `POST kill/server/:id`, `POST kill/user/:org/:user`, `POST enable/server/:id`, `POST enable/user/:org/:user`, `POST lockdown/end`, `GET rotation/due`, `POST rotate` (body `{ scope }`, `{ group }` or `{ all: true }`), `POST incident`, `GET users`, `POST users`, `DELETE users/:id`, `POST users/:id/token`, `GET health?ids=a,b`.

### Metrics

`osmcp_invocations_total{server,result}`, `osmcp_find_tools_total{confidence}`, `osmcp_sessions_active`, `osmcp_ledger_flagged_total`, `osmcp_vault_frozen`, and the histogram `osmcp_invoke_duration_seconds`.

## CLI

`one-stop-mcp <command>` (`npm run cli -- <command>` from a clone; `one-stop-mcp --help` prints the list). In local mode the CLI works on the state directory directly; the operator at the terminal is the admin. Against a team gateway add `--remote <url> --token <admin token> --totp <code>` (or set `OSMCP_ADMIN_TOKEN` / `OSMCP_TOTP`) and the command goes to the admin API. `--remote` must be `https://`; plain `http://` is accepted only for loopback.

| Command | What it does |
|---|---|
| `serve` | Local mode: stdio for the client plus the loopback HTTP listener. The default command. |
| `serve --http` | Team mode: Streamable HTTP for clients. |
| `init [--user id --org org]` | Creates the state directory and key, creates the first admin (defaults: user `admin`, org `default`), prints their bearer token once and an `otpauth://` URI for the authenticator app. Does nothing if users already exist. |
| `user add <id> --org <org> [--admin]` | Add a user. An admin also gets a TOTP enrolment URI. |
| `user list` / `user remove <id>` | List users, or remove one with their tokens and TOTP secret. |
| `user token <id>` | Issue a new bearer token (printed once). |
| `servers list` | List registered servers: category, auth type, whether this user is connected, whether a session is running. |
| `connect <server> [--user u --org o]` | Start auth for a server from the terminal. It prints the link and serves the OAuth callback / key-entry page itself until you finish or 15 minutes pass, so the port must be free (do not run it while a gateway is up on the same port). |
| `kill all` / `kill server <id>` / `kill user <org/user>` | [Kill switch](security.md#kill-switch). |
| `enable server <id>` / `enable user <org/user>` | Re-enable one at a time. |
| `lockdown end` | Leave lockdown. |
| `rotate <server> [--user u --org o]` | Rotate that server's credentials for everyone, or for one user with `--user`. |
| `rotate --category <c>` / `rotate --all` / `rotate due` | Rotate a category or everything; list credentials older than `rotation.days`. See [rotation](security.md#rotation). |
| `incident [--user u] [--server s] [--since ISO]` | The "after a scare" flow. |
| `ledger tail [-n N]` / `ledger verify` / `ledger flagged` | Read the newest N entries (default 50), check the chain and signatures, list flagged entries. |
| `catalog refresh [ids...]` | Capture live tool lists into the state directory (starts the servers; all of them with no ids). |
| `sync [--registry URL]` | Import candidate manifests from the MCP Registry into `servers/_candidates/`. |
| `health [ids...]` | Run each server's health check. |
| `validate` | Check that every manifest parses and has a non-empty snapshot. `npm run validate` does the full check, including routing keys and bench queries. |
