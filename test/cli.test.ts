import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adminRequest, main, parseCli, UsageError } from "../src/cli.js";
import { startHttp } from "../src/server/http.js";
import { Metrics } from "../src/server/metrics.js";
import { UserStore } from "../src/tenancy/users.js";
import type { App } from "../src/server/app.js";

const dir = mkdtempSync(join(tmpdir(), "osmcp-cli-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const req = (argv: string) => adminRequest(parseCli(argv.split(" ").filter(Boolean)));

test("every admin command maps to its admin API route", () => {
  const cases: Array<[string, unknown]> = [
    ["user add ana --org acme --admin", { method: "POST", path: "users", body: { id: "ana", org: "acme", admin: true } }],
    ["user list", { method: "GET", path: "users" }],
    ["user token ana", { method: "POST", path: "users/ana/token" }],
    ["user revoke ana t1", { method: "DELETE", path: "users/ana/token/t1" }],
    ["user remove ana", { method: "DELETE", path: "users/ana" }],
    ["kill all", { method: "POST", path: "kill/all" }],
    ["kill server github", { method: "POST", path: "kill/server/github" }],
    ["kill user acme/ana", { method: "POST", path: "kill/user/acme/ana" }],
    ["enable server github", { method: "POST", path: "enable/server/github" }],
    ["enable user acme/ana", { method: "POST", path: "enable/user/acme/ana" }],
    ["lockdown end", { method: "POST", path: "lockdown/end" }],
    ["rotate due", { method: "GET", path: "rotation/due" }],
    ["rotate github", { method: "POST", path: "rotate", body: { group: { server: "github" } } }],
    ["rotate github --user ana --org acme", { method: "POST", path: "rotate", body: { scope: { org: "acme", user: "ana", server: "github" } } }],
    ["rotate --category crm", { method: "POST", path: "rotate", body: { group: { category: "crm" } } }],
    ["rotate --all", { method: "POST", path: "rotate", body: { all: true } }],
    ["incident --user ana --since 2026-10-10T00:00:00Z", { method: "POST", path: "incident", body: { since: "2026-10-10T00:00:00Z", user: "ana", server: undefined } }],
    ["ledger tail -n 5", { method: "GET", path: "ledger", query: { limit: "5" } }],
    ["ledger verify", { method: "GET", path: "ledger/verify" }],
    ["ledger flagged", { method: "GET", path: "ledger/flagged" }],
    ["health echo github", { method: "GET", path: "health", query: { ids: "echo,github" } }],
  ];
  for (const [argv, want] of cases) assert.deepEqual(req(argv), want, argv);
});

test("local-only commands parse; bad input is a usage error", () => {
  for (const argv of ["serve", "serve --http", "init", "servers list", "connect github --user ana --org acme", "catalog refresh a b c", "sync --registry https://r.example", "validate"]) {
    const c = parseCli(argv.split(" "));
    assert.equal(adminRequest(c), undefined, argv);
  }
  assert.equal(parseCli([]).name, "serve", "no command serves");
  assert.deepEqual(parseCli(["catalog", "refresh", "a", "b"]).args, ["a", "b"]);
  for (const argv of ["frobnicate", "kill", "kill server", "user add", "connect", "serve --bogus", "validate extra"]) {
    assert.throws(() => parseCli(argv.split(" ")), UsageError, argv);
  }
  assert.throws(() => req("user add ana"), /--org/);
  assert.throws(() => req("kill user ana"), /org\/user/);
  assert.throws(() => req("rotate"), /--all/);
  assert.throws(() => req("ledger tail -n 0"), /-n/);
});

test("--remote sends the command to a team gateway's MFA-gated admin API", async () => {
  const users = new UserStore(join(dir, "users.json"));
  users.add("root", "ops", true);
  const { token } = users.issueToken("root");
  const ledger: unknown[] = [];
  const app = {
    cfg: { mode: "team", http: { host: "127.0.0.1", port: 0, publicUrl: "http://127.0.0.1:1" }, metrics: {} },
    users,
    metrics: new Metrics(),
    scrub: (t: string) => t,
    ledger: { record: (e: unknown) => (ledger.push(e), e) },
    verifyTotp: async (_p: unknown, code: string) => code === "123456",
    kill: { revokeServer: (id: string, by: string) => ({ revoked: id, by }) },
  } as unknown as App;
  const http = await startHttp(app);
  const lines: string[] = [];
  const env = {};
  try {
    const code = await main(["kill", "server", "github", "--remote", http.url, "--token", token, "--totp", "123456"], env, (s) => lines.push(s));
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(lines[0]), { revoked: "github", by: "ops/root" });
    assert.equal(await main(["kill", "server", "github", "--remote", http.url, "--token", token, "--totp", "000000"], env, () => {}), 1, "wrong TOTP fails");
    assert.equal(await main(["kill", "all", "--remote", "http://gateway.example.com"], { OSMCP_ADMIN_TOKEN: "t", OSMCP_TOTP: "1" }, () => {}), 2, "plain http to a non-loopback host refused");
    assert.equal(await main(["servers", "list", "--remote", http.url, "--token", token, "--totp", "123456"], env, () => {}), 2, "local-only command refused remotely");
    assert.equal(await main(["kill", "all", "--remote", http.url], env, () => {}), 2, "token and code required");
  } finally {
    await http.close();
  }
});

test("validate: manifests load and each has a non-empty snapshot", async () => {
  const servers = join(dir, "servers");
  const catalog = join(dir, "catalog");
  mkdirSync(servers);
  mkdirSync(catalog);
  writeFileSync(join(servers, "echo.yaml"), "id: echo\nname: Echo\ncategory: [dev]\ndescription: echo\ntransport:\n  type: stdio\n  command: node\nauth:\n  type: none\n");
  const env = { OSMCP_HOME: dir, OSMCP_SERVERS_DIR: servers, OSMCP_CATALOG_DIR: catalog };
  const lines: string[] = [];
  assert.equal(await main(["validate"], env, (s) => lines.push(s)), 1, "missing snapshot fails");
  assert.match(lines[0], /FAIL\s+echo/);
  writeFileSync(join(catalog, "echo.json"), JSON.stringify({ server: "echo", source: "docs", fetchedAt: "2026-10-10T00:00:00Z", tools: [{ name: "echo", inputSchema: {} }] }));
  assert.equal(await main(["validate"], env, (s) => lines.push(s)), 0);
  assert.match(lines[1], /ok\s+echo \(1 tools\)/);
});
