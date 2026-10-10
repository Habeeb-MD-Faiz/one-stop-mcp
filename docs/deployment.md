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

> Once the package is published, `node /path/to/dist/index.js` becomes `npx -y one-stop-mcp`. <!-- verify: package.json is still private: true and has no "files" list; the npx form does not work until that changes. -->

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

# Run it
docker run -d --name one-stop-mcp --restart unless-stopped \
  --env-file team.env -v osmcp-data:/data \
  -v "$PWD/team.config.yaml:/config/one-stop-mcp.config.yaml:ro" \
  -e OSMCP_CONFIG=/config/one-stop-mcp.config.yaml \
  -p 127.0.0.1:8420:8420 one-stop-mcp
```

Inside a container the gateway must bind `0.0.0.0`, so the config needs `http.host: 0.0.0.0`; the example in [`examples/team.config.yaml`](examples/team.config.yaml) has it. <!-- verify: default http.host in team mode; if it is already 0.0.0.0 this note can go. -->

The master key is the one thing you cannot recover: lose it and the vault is unreadable. Store a copy in a password manager, apart from the volume backups.

The embedding model is not baked into the image. With `EMBEDDINGS=1` it downloads from the Hugging Face hub the first time routing needs it. Without it, or if the download fails, routing uses lexical + BM25 only. <!-- verify: the model cache directory should sit under /data so it survives container replacement. -->

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
| `OSMCP_PORT` | `8420` | Host port. |
| `OSMCP_BIND` | `127.0.0.1` | Host address the port is published on. `0.0.0.0` exposes **plain HTTP** to the network; put TLS in front first. |
| `OSMCP_ENV_FILE` | `.env` | Env file holding `OSMCP_MASTER_KEY`. |
| `OSMCP_CONFIG_FILE` | `docs/examples/team.config.yaml` | Config file mounted into the container. |
| `EMBEDDINGS` | `0` | `1` builds the image with the optional embedding dependencies. |

### Trying the HashiCorp Vault backend

```bash
docker compose --profile vault up -d
```

This starts `hashicorp/vault` in **dev mode**: in-memory, auto-unsealed, root token `dev-only-token`, published on `127.0.0.1:8200`. Switch the gateway to it with the `vault` block commented at the bottom of `docs/examples/team.config.yaml`, then `docker compose up -d`. Dev mode is for trying the integration only. For real use, point `vault.hashicorp.addr` at a production Vault with a properly scoped token.

## Team-mode bootstrap

1. **Set the master key** (`OSMCP_MASTER_KEY`), or configure a KMS key provider ([configuration](configuration.md#key-providers)).
2. **`init`** creates the state directory, the first admin user, and prints, once:
   - the admin's bearer token (`osmcp_...`), and
   - an `otpauth://` URI. Add it to an authenticator app (scan it as a QR code, or paste the secret). The admin API needs a code from it on every request.
3. **Start the gateway** (`serve --http`, or `docker compose up -d`).
4. **Add users.** Each user belongs to an org. Keys are separated per org and per user, so one user cannot read another's credentials.
   ```bash
   one-stop-mcp user add alice --org acme
   one-stop-mcp user token alice     # prints the token once; send it over a private channel
   one-stop-mcp user list
   ```
   Tokens are stored only as SHA-256 hashes, so a lost token cannot be recovered, only replaced with `user token`. `user remove` deletes a user and with them every token. <!-- verify: the token store can revoke a single token, but the CLI and admin API in the brief do not expose it. -->
5. **Connect clients** with that token (below).
6. **Each user connects their own servers** by asking the model to use them; `connect_server` runs the OAuth or key-entry flow for that user. Credentials are stored under that user's key.

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

<!-- verify: mcp-remote flags and Claude Desktop's current remote-server support change often; re-check before release. -->

Any client that supports Streamable HTTP with custom headers works the same way: URL `https://<host>/mcp`, header `Authorization: Bearer <token>`.

### Admin access

- **Admin page**: `https://<host>/admin`. Enter the admin token and a current TOTP code; they live in page memory only. Ledger, kill switch, rotation and incident controls are there.
- **Admin API**: `/admin/api/*`, e.g.
  ```bash
  curl -H "Authorization: Bearer $OSMCP_ADMIN_TOKEN" -H "X-OSMCP-TOTP: 123456" \
    https://mcp.example.com/admin/api/ledger/flagged
  ```
- **CLI against a remote gateway**: add `--remote https://mcp.example.com --token <admin token> --totp <code>` to any admin command.

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
- `GET /metrics` in Prometheus text format. Set `metrics.token` to require a bearer token:
  ```yaml
  scrape_configs:
    - job_name: one-stop-mcp
      authorization:
        credentials: <metrics.token>
      static_configs:
        - targets: ["gateway:8420"]
  ```
  Useful alerts: `osmcp_vault_frozen == 1` (someone hit the kill switch), a rising `osmcp_ledger_flagged_total`, and `osmcp_sessions_active` against your expected load.

## Backup, upgrade, recovery

- **Back up** the state directory (`/data` in Docker) and keep `OSMCP_MASTER_KEY` separately. The ledger is append-only; keep copies of it and of its public key so `ledger verify` can still prove nothing was changed.
- **Upgrade** by rebuilding the image or pulling the new commit and restarting. Run `one-stop-mcp validate` after pulling to check the catalog.
- **Restore** by putting the state directory back with the same master key.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Gateway exits at start-up naming `OSMCP_MASTER_KEY` | Team mode needs a master key or a KMS key provider. Set it in the env file. |
| `/mcp` returns 401 | Missing or wrong bearer token. Issue a new one with `user token`. |
| OAuth finishes but the provider says the redirect URI is invalid | `http.publicUrl` does not match what the browser used, or the provider's registered redirect URI is not `{publicUrl}/oauth/callback`. |
| Container is "unhealthy" | The port was changed: the built-in health check probes 8420. Override the health check. |
| Every call returns an access-denied message | The kill switch is active. Check the kill-switch panel in the admin page (or `GET /admin/api/kill`); re-enable servers one at a time. |
| `ledger verify` reports a broken entry | The ledger file was edited or truncated. Compare with a backup; see [security](security.md#usage-ledger). |
