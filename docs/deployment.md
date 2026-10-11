# Deployment

Run One-Stop MCP on a laptop for yourself, or as a shared gateway for a team. Related: [configuration](configuration.md) · [security](security.md) · [architecture](architecture.md).

Nothing is published yet: there is no npm package or container image to pull. Every command below builds from a clone of the repository. Where a command will change once packages exist, it says so.

| | Local (one person) | Team (shared gateway) |
|---|---|---|
| Client connects by | stdio, started by the client | Streamable HTTP + bearer token |
| Runs as | a child process of the MCP client | a long-lived service (Docker, systemd, ...) |
| Credentials | yours, in `~/.one-stop-mcp` | per user, in a shared state directory or HashiCorp Vault |

## Local: from a clone

Requires Node.js 22.

```bash
git clone https://github.com/Habeeb-MD-Faiz/one-stop-mcp.git
cd one-stop-mcp
npm ci
npm run build          # compiles to dist/
node dist/index.js     # serves MCP on stdio; waits for a client
```

State (generated key file, vault, ledger) goes to `~/.one-stop-mcp`. Set `OSMCP_HOME` to move it. Loading `servers/` and `catalog/` happens from the clone, so keep the clone where it is, or point `serversDir` and `catalogDir` elsewhere ([configuration](configuration.md)).

> Once the package is published, `node /path/to/dist/index.js` becomes `npx -y one-stop-mcp`. Until then `package.json` keeps `"private": true`, so `npm publish` refuses; `npm pack` builds the tarball, which contains `dist`, `servers`, `catalog`, `schema`, `examples` and the license.

**Windows.** Local embeddings run on the ONNX runtime, which needs the Microsoft Visual C++ 2015-2022 x64 redistributable. Without it the gateway prints one line (`local embeddings unavailable`) at start-up and routing uses keyword + BM25 only; everything else works.

Use an absolute path in every client config below; clients do not start in your repository directory.

### Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "one-stop": {
      "command": "node",
      "args": ["/absolute/path/to/one-stop-mcp/dist/index.js"]
    }
  }
}
```

This is the only server entry you need. Every other server in the catalog is reached through it.

### Claude Code

```bash
claude mcp add one-stop -- node /absolute/path/to/one-stop-mcp/dist/index.js
```

### Connecting a first server

Ask the model for something a catalog server does, for example "list my Notion pages". The model calls `find_tools`, then `connect_server("notion")`. You get a link:

- **OAuth servers**: open the link, approve in the browser, and the redirect lands on the gateway's loopback listener (`http://127.0.0.1:8420/oauth/callback`). Tokens go into the vault.
- **API-key servers**: the link is a key-entry page on the gateway. Type the key there. It never goes through the chat.

After that, calls to the server are authenticated by the gateway. Run `node dist/index.js servers list` to see what is connected.

If port 8420 is already taken (for example by a second gateway), set `http.port` in the config file.

## Docker

The image is multi-stage on `node:22-bookworm-slim`, runs as the non-root `node` user, keeps state in the `/data` volume, and listens on 8420 with a health check on `/healthz`.

```bash
docker build -t one-stop-mcp .

# Keep the optional local-embedding dependencies (dense routing):
docker build --build-arg EMBEDDINGS=1 -t one-stop-mcp:embeddings .
```

The default command is `node dist/index.js serve --http` (team mode), which refuses to start without a master key. Use an env file so the key is not in your shell history:

```bash
openssl rand -base64 32                      # generate a key
printf 'OSMCP_MASTER_KEY=%s\n' '<paste key>' > team.env
chmod 600 team.env

# One-off: create the state directory and the first admin user
docker run --rm -it --env-file team.env -v osmcp-data:/data one-stop-mcp node dist/index.js init

# Run it (team mode: binds 0.0.0.0 inside the container)
docker run -d --name one-stop-mcp --restart unless-stopped \
  --env-file team.env -v osmcp-data:/data \
  -e OSMCP_PUBLIC_URL=https://mcp.example.com \
  -p 127.0.0.1:8420:8420 one-stop-mcp
```

Team mode binds `0.0.0.0` by default (`OSMCP_HOST` or `http.host` change it), which is what a container needs; the published port (`-p 127.0.0.1:8420:8420`) decides who can reach it. Set `OSMCP_PUBLIC_URL` to the address browsers use, since OAuth redirects and key-entry links are built from it. If you change the listen port with `OSMCP_PORT`, change the `-p` mapping to match; the image's health check follows `OSMCP_PORT`.

The master key is the one thing you cannot recover: lose it and the vault is unreadable. Store a copy in a password manager, apart from the volume backups.

The embedding model is not baked into the image. With `EMBEDDINGS=1` it downloads from the Hugging Face hub the first time routing needs it, into `$OSMCP_HOME/embeddings/models`, which is inside the `/data` volume and so survives container replacement. Without `EMBEDDINGS=1`, or if the download fails, routing uses keyword + BM25 only (one line on stderr says so).

## Docker Compose (team mode)

`docker-compose.yml` runs the gateway with a named volume and a config file, and has an optional dev-mode HashiCorp Vault.

```bash
cp docs/examples/team.env.example .env        # set OSMCP_MASTER_KEY in .env
$EDITOR docs/examples/team.config.yaml         # set http.publicUrl for your host
docker compose run --rm gateway node dist/index.js init
docker compose up -d
curl http://127.0.0.1:8420/healthz
```

Variables you can set in `.env` or the shell:

| Variable | Default | Effect |
|---|---|---|
| `OSMCP_PUBLISH_PORT` | `8420` | Host port the container's 8420 is published on. (`OSMCP_PORT`, by contrast, is the gateway's own listen port inside the container.) |
| `OSMCP_BIND` | `127.0.0.1` | Host address the port is published on. `0.0.0.0` exposes **plain HTTP** to the network; put TLS in front first. |
| `OSMCP_ENV_FILE` | `.env` | Env file holding `OSMCP_MASTER_KEY`. |
| `OSMCP_CONFIG_FILE` | `docs/examples/team.config.yaml` | Config file mounted into the container. |
| `EMBEDDINGS` | `0` | `1` builds the image with the optional embedding dependencies. |

### Trying the HashiCorp Vault backend

```bash
docker compose --profile vault up -d
```

This starts `hashicorp/vault` in **dev mode**: in-memory, auto-unsealed, root token `dev-only-token`, published on `127.0.0.1:8200`. Switch the gateway to it by replacing the `vault` block in `docs/examples/team.config.yaml` with the commented one at the bottom, add `OSMCP_VAULT_TOKEN=dev-only-token` to `.env` (the token is read from the environment, never from the config file), then `docker compose up -d`. Team mode still wants `OSMCP_MASTER_KEY` set. Dev mode is for trying the integration only. For real use, point `vault.hashicorp.addr` at a production Vault with a properly scoped token.

## Team-mode bootstrap

1. **Set the master key** (`OSMCP_MASTER_KEY`), or configure a KMS key provider ([configuration](configuration.md#key-providers)).
2. **`init`** creates the state directory, the first admin user, and prints, once:
   - the admin's bearer token (`osmcp_...`), and
   - an `otpauth://` URI. Add it to an authenticator app (scan it as a QR code, or paste the secret). The admin API needs a code from it; a code works once, and a good one unlocks the API for 15 minutes.
3. **Choose shared servers.** Team mode does not load stdio servers that need no credential (`time`, `memory`, `filesystem`, `aws`, ...), because each one would act as the gateway host for every user. List the ones that are safe to share in `hostServers` (or `OSMCP_HOST_SERVERS=time,fetch`). The gateway prints which ones it left out at start-up ([security](security.md#threat-model)).
4. **Start the gateway** (`serve --http`, or `docker compose up -d`).
5. **Add users.** Each user belongs to an org. Keys are separated per org and per user, so one user cannot read another's credentials.
   ```bash
   one-stop-mcp user add alice --org acme
   one-stop-mcp user token alice     # prints the token once; send it over a private channel
   one-stop-mcp user list
   ```
   Tokens are stored only as SHA-256 hashes, so a lost token cannot be recovered, only replaced with `user token`. `user remove` deletes a user together with every token and stored credential they hold. `user revoke <id> <tokenId>` revokes one token and keeps the user.
6. **Connect clients** with that token (below).
7. **Each user connects their own servers** by asking the model to use them; `connect_server` runs the OAuth or key-entry flow for that user. Credentials are stored under that user's key.

### Connecting a client to a team gateway

Claude Code:

```bash
claude mcp add --transport http one-stop https://mcp.example.com/mcp \
  --header "Authorization: Bearer osmcp_YOUR_TOKEN"
```

or in a project `.mcp.json`, reading the token from the environment so it is not committed:

```json
{
  "mcpServers": {
    "one-stop": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${OSMCP_TOKEN}" }
    }
  }
}
```

Claude Desktop's config file starts local processes, so to reach an HTTP gateway from it use a stdio-to-HTTP bridge. [`mcp-remote`](https://github.com/geelen/mcp-remote) is a third-party example:

```json
{
  "mcpServers": {
    "one-stop": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.example.com/mcp", "--header", "Authorization:${OSMCP_AUTH}"],
      "env": { "OSMCP_AUTH": "Bearer osmcp_YOUR_TOKEN" }
    }
  }
}
```

<!-- verify: external tool, not checked against this repository: mcp-remote flags and Claude Desktop's remote-server support change often; re-check before release. -->

Any client that supports Streamable HTTP with custom headers works the same way: URL `https://<host>/mcp`, header `Authorization: Bearer <token>`.

### Admin access

- **Admin page**: `https://<host>/admin`. Enter the admin token and a current TOTP code; they live in page memory only. Ledger, kill switch, rotation and incident controls are there.
- **Admin API**: `/admin/api/*`. Every call needs the admin bearer token. The first call also needs a TOTP code, and its response carries an `x-osmcp-admin-session` header; send that header back on later calls (with the bearer token again) instead of another code, for the next 15 minutes:
  ```bash
  curl -i -H "Authorization: Bearer $OSMCP_ADMIN_TOKEN" -H "X-OSMCP-TOTP: 123456" \
    https://mcp.example.com/admin/api/ledger/flagged
  ```
- **CLI against a remote gateway**: add `--remote https://mcp.example.com --token <admin token> --totp <code>` to any admin command (or set `OSMCP_ADMIN_TOKEN` and `OSMCP_TOTP`). Plain `http://` is refused except to loopback.

## TLS and reverse proxies

The gateway speaks plain HTTP. For anything beyond loopback, terminate TLS in front of it and set `http.publicUrl` to the public `https://` address. OAuth redirect URIs and key-entry links are built from `publicUrl`; if it is wrong, provider redirects fail.

Caddy:

```text
mcp.example.com {
    reverse_proxy 127.0.0.1:8420
}
```

nginx (Streamable HTTP can stream responses, so disable buffering):

```nginx
location / {
    proxy_pass http://127.0.0.1:8420;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_read_timeout 1h;
}
```

If a provider needs a registered redirect URI (stdio servers using generic OAuth), register `https://mcp.example.com/oauth/callback`.

## Monitoring

- `GET /healthz` for liveness (the image's `HEALTHCHECK` uses it).
- `GET /metrics` in Prometheus text format. Set `OSMCP_METRICS_TOKEN` to require a bearer token:
  ```yaml
  scrape_configs:
    - job_name: one-stop-mcp
      authorization:
        credentials: <the value of OSMCP_METRICS_TOKEN>
      static_configs:
        - targets: ["gateway:8420"]
  ```
  Useful alerts: `osmcp_vault_frozen == 1` (someone hit the kill switch), a rising `osmcp_ledger_flagged_total`, and `osmcp_sessions_active` against your expected load.

## Backup, upgrade, recovery

- **Back up** the state directory (`/data` in Docker) and keep `OSMCP_MASTER_KEY` separately. The ledger is append-only; keep copies of `ledger.jsonl` and of the public key `ledger-signing.pem.pub` somewhere the gateway host cannot rewrite, so `ledger verify` can still prove nothing was changed (and so a truncated tail is noticed).
- **Upgrade** by rebuilding the image or pulling the new commit and restarting. Run `one-stop-mcp validate` after pulling to check the catalog.
- **Restore** by putting the state directory back with the same master key.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Gateway exits at start-up naming `OSMCP_MASTER_KEY` | Team mode needs a master key or a KMS key provider. Set it in the env file. |
| `/mcp` returns 401 | Missing or wrong bearer token. Issue a new one with `user token`. |
| OAuth finishes but the provider says the redirect URI is invalid | `http.publicUrl` does not match what the browser used, or the provider's registered redirect URI is not `{publicUrl}/oauth/callback`. |
| Container is "unhealthy" | The image's health check probes `OSMCP_PORT` (default 8420) inside the container. If you changed the port in the config file instead of the variable, set `OSMCP_PORT` as well. |
| Every call returns an access-denied message | The kill switch is active. Check the kill-switch panel in the admin page (or `GET /admin/api/kill`); re-enable servers one at a time. |
| `ledger verify` reports a broken entry | The ledger file was edited, reordered, or had entries removed from the middle. (Cutting off the newest entries does not break the chain, so compare with a backup copy.) see [security](security.md#usage-ledger). |
