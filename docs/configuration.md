# Configuration

Every setting, with its default, for both modes. Related: [deployment](deployment.md) · [security](security.md) · [architecture](architecture.md).

A working team-mode example is in [`examples/team.config.yaml`](examples/team.config.yaml).

## Where settings come from

From lowest to highest priority:

1. Built-in defaults.
2. The config file `one-stop-mcp.config.yaml`. Its path is `--config <path>`, else the `OSMCP_CONFIG` environment variable, else `$OSMCP_HOME/config.yaml` if that file exists. With none of these the gateway runs on defaults.
3. `OSMCP_*` environment variables.

<!-- verify: order of CLI flags vs env vs file; the brief says "file + OSMCP_* env overrides + defaults". -->

Config is validated at start-up and the gateway **fails loudly** on a bad value, naming the field. Unknown keys are errors.

The one thing that is never read from the file is the master key. It comes only from `OSMCP_MASTER_KEY`, so it cannot be committed by accident ([D29](burndown/DECISIONS.md)).

## Modes

`mode: local | team` ([D23](burndown/DECISIONS.md)).

| | `local` | `team` |
|---|---|---|
| Started by | `one-stop-mcp serve` (default command) | `one-stop-mcp serve --http` |
| Clients connect over | stdio | Streamable HTTP at `/mcp` |
| HTTP listener | `127.0.0.1` only (forced); serves `/oauth/callback`, `/connect/*`, `/healthz` | `http.host`; serves everything in [Routes](#http-routes) |
| Gateway authentication | none; the single principal is `local` | bearer token per user |
| Master key | `OSMCP_MASTER_KEY` if set, else a generated key file `$OSMCP_HOME/master.key` (mode 0600) | `OSMCP_MASTER_KEY` or a KMS key provider; **refuses to start** without one |

## Config file reference

```yaml
mode: local                 # local | team
home: ~/.one-stop-mcp       # state directory (same as OSMCP_HOME)
serversDir: ./servers       # manifests; default is the repo's servers/
catalogDir: ./catalog       # shipped tool snapshots; default is the repo's catalog/

http:
  host: 127.0.0.1           # local mode forces 127.0.0.1
  port: 8420
  publicUrl: http://127.0.0.1:8420   # base for OAuth redirects and key-entry links

vault:
  backend: file             # file | hashicorp
  keyProvider: keyfile      # keyfile | passphrase | vault-transit | aws-kms
  hashicorp:                # when backend: hashicorp
    addr: http://127.0.0.1:8200
    token: ...
    mount: secret
  transit:                  # when keyProvider: vault-transit
    addr: ...
    token: ...
    keyName: one-stop-mcp
  awsKms:                   # when keyProvider: aws-kms
    region: eu-west-1
    keyId: alias/one-stop-mcp

routing:
  embeddings: on            # on | off
  model: Xenova/all-MiniLM-L6-v2

compress: light             # off | light | aggressive
ttlMs: 60000                # idle downstream sessions are closed after this

rotation:
  days: 90
  checkEveryMs: 3600000

ledger:
  burstMax: 100
  windowMs: 60000

metrics:
  token: ...                # optional bearer token for /metrics
```

<!-- verify: key names and defaults inside vault.hashicorp / vault.transit / vault.awsKms, rotation.checkEveryMs, the per-mode vault.keyProvider defaults, the routing.embeddings default and the routing.model default are inferred from the lane briefs (L2, L7); reconcile with src/config.ts. -->

### Fields

| Field | Default | Meaning |
|---|---|---|
| `mode` | `local` | See [Modes](#modes). |
| `home` | `~/.one-stop-mcp` | State directory: vault, users, ledger, kill-switch state, key files, refreshed snapshots, embedding cache. Overridden by `OSMCP_HOME`. |
| `serversDir` | repo `servers/` | Where `*.yaml` manifests are loaded from. `servers/_candidates/` is never loaded. |
| `catalogDir` | repo `catalog/` | Shipped tool snapshots. Read-only; refreshed snapshots go to `home`. |
| `http.host` | `127.0.0.1` | Bind address. In `local` mode it is forced to `127.0.0.1`. In a container set `0.0.0.0` and control exposure with the published port. |
| `http.port` | `8420` | Listen port ([D32](burndown/DECISIONS.md)). |
| `http.publicUrl` | `http://<host>:<port>` | The URL a **browser** uses to reach the gateway. OAuth redirect URIs (`{publicUrl}/oauth/callback`) and key-entry links (`{publicUrl}/connect/{ticket}`) are built from it. Behind a reverse proxy set it to the public HTTPS address. |
| `vault.backend` | `file` | `file`: encrypted `vault.json` in `home`. `hashicorp`: HashiCorp Vault KV v2. |
| `vault.keyProvider` | `keyfile` (local), `passphrase` (team) | Where the root key comes from. See [Key providers](#key-providers). |
| `vault.hashicorp` | none | `addr`, `token`, `mount` for the KV v2 backend. |
| `vault.transit` | none | `addr`, `token`, `keyName` for the Vault Transit key provider. |
| `vault.awsKms` | none | `region`, `keyId` for the AWS KMS key provider. AWS credentials come from the standard environment. |
| `routing.embeddings` | `on` | `on` tries the local embedding model and falls back to lexical + BM25 if it cannot load. `off` never loads it. |
| `routing.model` | chosen by the routing bench | Embedding model id. Candidates: `Xenova/all-MiniLM-L6-v2`, `Xenova/bge-small-en-v1.5`. |
| `compress` | `light` | Schema compression for `find_tools` results. `off`, `light`, or `aggressive`. See [routing](routing.md#schema-compression). |
| `ttlMs` | `60000` | Idle time before a pooled downstream session is closed. |
| `rotation.days` | `90` | Credentials older than this are reported by `rotate due` and rotated by the scheduler. |
| `rotation.checkEveryMs` | one hour | How often the rotation scheduler looks for due credentials. |
| `ledger.burstMax` | `100` | More than this many calls to one (user, server, tool) inside `windowMs` is flagged. |
| `ledger.windowMs` | `60000` | Window for the burst rule. |
| `metrics.token` | none | If set, `/metrics` requires `Authorization: Bearer <token>`. |

### Key providers

All of them produce the 32-byte root key from which per-org and per-user keys are derived ([security](security.md#key-hierarchy)).

| `keyProvider` | Root key comes from | Use for |
|---|---|---|
| `keyfile` | A random 32-byte file, `$OSMCP_HOME/master.key`, created with mode 0600 on first use. | Local desktop use. No passphrase prompt; the protection is file permissions, the same model as an SSH key. |
| `passphrase` | `OSMCP_MASTER_KEY`, stretched with scrypt using a salt file in `home`. | Team mode and Docker. |
| `vault-transit` | A random data key stored wrapped by HashiCorp Vault Transit; unwrapped at start. | Team mode when Vault is the key authority. |
| `aws-kms` | A random data key stored wrapped by an AWS KMS key (`GenerateDataKey` / `Decrypt`). | Team mode on AWS. |

GCP and Azure KMS sit behind the same `KeyProvider` interface but are not built.

## Environment variables

| Variable | Meaning |
|---|---|
| `OSMCP_MASTER_KEY` | Passphrase for the vault root key. **Required in team mode** unless a KMS key provider is configured. Never put it in the config file, a Dockerfile, or a command line. If you lose or change it, stored credentials become unreadable. |
| `OSMCP_HOME` | State directory. Default `~/.one-stop-mcp`. In the Docker image it is `/data`. |
| `OSMCP_CONFIG` | Path to the config file. |
| `OSMCP_SERVERS_DIR` | Override for `serversDir`. |

Every other config field can be overridden with an `OSMCP_` variable <!-- verify: exact names, e.g. OSMCP_MODE, OSMCP_HTTP_PORT, OSMCP_HTTP_PUBLIC_URL, OSMCP_ROUTING_EMBEDDINGS, OSMCP_COMPRESS; list them from src/config.ts -->. Where an override is missing, use the config file.

Downstream stdio servers do **not** inherit the gateway's environment. A child process gets only the SDK's default safe variables, the manifest's `transport.env`, and the injected credential, so `OSMCP_MASTER_KEY` cannot leak into a downstream server ([D31](burndown/DECISIONS.md)).

## State directory

Everything the gateway writes lives under `home`. Back it up; protect it like a password database.

| What | File | Notes |
|---|---|---|
| Encrypted secrets | `vault.json` | Mode 0600, written atomically. Absent with the `hashicorp` backend. |
| Local root key | `master.key` | Local mode without `OSMCP_MASTER_KEY`. Mode 0600. |
| Users and token hashes | `users.json` | Mode 0600. Only SHA-256 hashes of tokens. |
| Kill-switch state | a small state file | Re-read whenever it changes, so `one-stop-mcp kill all` takes effect inside a running gateway immediately ([D30](burndown/DECISIONS.md)). |
| Usage ledger | append-only JSONL | Hash-chained and signed. The signing key is a PEM file with mode 0600. |
| Refreshed snapshots | a `catalog/` subdirectory | Override the shipped snapshots. |
| Embedding cache | a subdirectory | Keyed by model and document text; safe to delete. |

<!-- verify: file names other than vault.json, master.key and users.json are not fixed in the briefs; fill in from src/config.ts and src/security/. -->

## HTTP routes

| Route | Mode | Auth | Purpose |
|---|---|---|---|
| `POST/GET/DELETE /mcp` | team | `Authorization: Bearer osmcp_...` | MCP Streamable HTTP endpoint. 401 with `WWW-Authenticate: Bearer` otherwise. One gateway session per client session, bound to the caller's principal. |
| `GET /oauth/callback` | both | state parameter | OAuth redirect target. |
| `GET/POST /connect/:ticket` | both | one-time ticket | Key-entry form. Cross-origin POSTs are rejected. |
| `/admin/api/*` | team | admin bearer **and** `X-OSMCP-TOTP` | Admin API. 1 MB body limit. Every call is ledgered. |
| `GET /admin` | team | token entered in the page | Self-contained admin page. |
| `GET /metrics` | team | optional bearer (`metrics.token`) | Prometheus text format. |
| `GET /healthz` | both | none | Liveness. |

### Metrics

`osmcp_invocations_total{server,result}`, `osmcp_find_tools_total{confidence}`, `osmcp_sessions_active`, `osmcp_ledger_flagged_total`, `osmcp_vault_frozen`, and the histogram `osmcp_invoke_duration_seconds`.

## CLI

`one-stop-mcp <command>` (`npm run cli -- <command>` from a clone). In local mode the CLI works on the state directory directly; the operator at the terminal is the admin. Against a team gateway add `--remote <url> --token <admin token> --totp <code>` and the command goes to the admin API.

| Command | What it does |
|---|---|
| `serve` | Local mode: stdio for the client plus the loopback HTTP listener. The default command. |
| `serve --http` | Team mode: Streamable HTTP for clients. |
| `init` | Creates the state directory and key file, creates the first admin user, prints their token once and an `otpauth://` URI for the authenticator app. |
| `user add <id> --org <org> [--admin]` | Add a user. |
| `user list` / `user remove <id>` | List or remove users. |
| `user token <id>` | Issue a new bearer token (printed once). |
| `servers list` | List registered servers. |
| `connect <server> [--user u --org o]` | Start auth for a server from the terminal. |
| `kill all` / `kill server <id>` / `kill user <org/user>` | [Kill switch](security.md#kill-switch). |
| `enable server <id>` / `enable user <org/user>` | Re-enable one at a time. |
| `lockdown end` | Leave lockdown. |
| `rotate <server>` / `rotate --category <c>` / `rotate --all` | [Rotate](security.md#rotation) credentials. |
| `rotate due` | List credentials past `rotation.days`. |
| `incident [--user u] [--server s] [--since ISO]` | The "after a scare" flow. |
| `ledger tail [-n N]` / `ledger verify` / `ledger flagged` | Read the ledger, check its chain and signatures, list flagged entries. |
| `catalog refresh [ids...]` | Capture live tool lists into the state directory. |
| `sync [--registry URL]` | Import candidate manifests from the MCP Registry into `servers/_candidates/`. |
| `health [ids...]` | Run each server's health check. |
| `validate` | Validate manifests and snapshots. |

<!-- verify: command list is from the L7 brief; run `one-stop-mcp --help` on the integrated build and reconcile. -->
