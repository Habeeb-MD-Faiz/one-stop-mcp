#!/usr/bin/env node
// The one binary (D23). `serve` runs the gateway: local mode = MCP over stdio plus
// a loopback HTTP server for auth pages; `serve --http` = team mode. Every admin
// command maps to one admin API route (src/server/admin.ts): locally it runs
// against the state dir as the operator (a running gateway picks the change up,
// D30); with --remote it goes to a team gateway's MFA-gated admin API instead.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LOCAL_PRINCIPAL, type Principal } from "./contracts.js";
import { loadConfig, type Config } from "./config.js";
import { loadManifests } from "./manifest.js";
import { adminCall } from "./server/admin.js";
import type { App } from "./server/app.js";
import { buildGateway } from "./server/gateway.js";
import { startHttp } from "./server/http.js";

const OPTIONS = {
  config: { type: "string" },
  http: { type: "boolean" },
  remote: { type: "string" },
  token: { type: "string" },
  totp: { type: "string" },
  org: { type: "string" },
  user: { type: "string" },
  admin: { type: "boolean" },
  category: { type: "string" },
  all: { type: "boolean" },
  n: { type: "string", short: "n" },
  server: { type: "string" },
  since: { type: "string" },
  registry: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

type Flags = { [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K]["type"] extends "boolean" ? boolean : string };

// command → [min, max] positional args after the command words.
const COMMANDS: Record<string, [number, number]> = {
  serve: [0, 0], init: [0, 0], validate: [0, 0], sync: [0, 0], incident: [0, 0],
  "user add": [1, 1], "user list": [0, 0], "user token": [1, 1], "user remove": [1, 1],
  "servers list": [0, 0], connect: [1, 1],
  "kill all": [0, 0], "kill server": [1, 1], "kill user": [1, 1],
  "enable server": [1, 1], "enable user": [1, 1], "lockdown end": [0, 0],
  "rotate due": [0, 0], rotate: [0, 1],
  "ledger tail": [0, 0], "ledger verify": [0, 0], "ledger flagged": [0, 0],
  "catalog refresh": [0, Infinity], health: [0, Infinity],
};

export const USAGE = `usage: one-stop-mcp <command> [options]
  serve [--http]                         run the gateway (local stdio, or team HTTP)
  init [--user id --org org]             state dir, master key file, first admin (token + TOTP shown once)
  user add <id> --org <org> [--admin] | user list | user token <id> | user remove <id>
  servers list | connect <server> [--user u --org o] | health [ids...]
  kill all | kill server <id> | kill user <org/user> | enable server <id> | enable user <org/user> | lockdown end
  rotate <server> [--user u --org o] | rotate --category <c> | rotate --all | rotate due
  incident [--user u] [--server s] [--since ISO]
  ledger tail [-n N] | ledger verify | ledger flagged
  catalog refresh [ids...] | sync [--registry URL] | validate
options: --config <file>   --remote <url> --token <t> --totp <code>  (admin commands against a team gateway;
         token/code may also come from OSMCP_ADMIN_TOKEN / OSMCP_TOTP)`;

export class UsageError extends Error {}

export interface Command {
  name: string;
  args: string[];
  flags: Flags;
}

export function parseCli(argv: string[]): Command {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const pos = parsed.positionals;
  const flags = parsed.values as Flags;
  if (pos.length === 0) return { name: flags.help ? "help" : "serve", args: [], flags };
  const two = `${pos[0]} ${pos[1] ?? ""}`;
  const name = COMMANDS[two] ? two : pos[0];
  if (name === "help") return { name, args: [], flags };
  const range = COMMANDS[name];
  if (!range) throw new UsageError(`unknown command: ${pos.slice(0, 2).join(" ")}`);
  const args = pos.slice(name.split(" ").length);
  if (args.length < range[0] || args.length > range[1]) throw new UsageError(`wrong number of arguments for "${name}"`);
  return { name, args, flags };
}

export interface AdminRequest {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
}

const enc = encodeURIComponent;

/** The admin API request a command maps to; undefined for local-only commands. */
export function adminRequest(cmd: Command): AdminRequest | undefined {
  const [a] = cmd.args;
  const f = cmd.flags;
  const orgUser = (v: string) => {
    const parts = v.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new UsageError(`expected <org/user>, got "${v}"`);
    return `${enc(parts[0])}/${enc(parts[1])}`;
  };
  switch (cmd.name) {
    case "user add":
      if (!f.org) throw new UsageError("user add needs --org");
      return { method: "POST", path: "users", body: { id: a, org: f.org, admin: !!f.admin } };
    case "user list": return { method: "GET", path: "users" };
    case "user token": return { method: "POST", path: `users/${enc(a)}/token` };
    case "user remove": return { method: "DELETE", path: `users/${enc(a)}` };
    case "kill all": return { method: "POST", path: "kill/all" };
    case "kill server": return { method: "POST", path: `kill/server/${enc(a)}` };
    case "kill user": return { method: "POST", path: `kill/user/${orgUser(a)}` };
    case "enable server": return { method: "POST", path: `enable/server/${enc(a)}` };
    case "enable user": return { method: "POST", path: `enable/user/${orgUser(a)}` };
    case "lockdown end": return { method: "POST", path: "lockdown/end" };
    case "rotate due": return { method: "GET", path: "rotation/due" };
    case "rotate": {
      if (f.all) return { method: "POST", path: "rotate", body: { all: true } };
      if (f.category) return { method: "POST", path: "rotate", body: { group: { category: f.category } } };
      if (!a) throw new UsageError("rotate needs <server>, --category <c> or --all");
      if (f.user) return { method: "POST", path: "rotate", body: { scope: { org: f.org ?? "local", user: f.user, server: a } } };
      return { method: "POST", path: "rotate", body: { group: { server: a } } };
    }
    case "incident": return { method: "POST", path: "incident", body: { since: f.since, user: f.user, server: f.server } };
    case "ledger tail": {
      const n = f.n ?? "50";
      if (!/^\d+$/.test(n) || +n < 1 || +n > 10_000) throw new UsageError("-n must be 1..10000");
      return { method: "GET", path: "ledger", query: { limit: n } };
    }
    case "ledger verify": return { method: "GET", path: "ledger/verify" };
    case "ledger flagged": return { method: "GET", path: "ledger/flagged" };
    case "health": return { method: "GET", path: "health", query: cmd.args.length ? { ids: cmd.args.join(",") } : {} };
    default: return undefined;
  }
}

/** Send an admin request to a team gateway. */
export async function remoteAdmin(remote: string, token: string, totp: string, req: AdminRequest): Promise<unknown> {
  const base = new URL(remote.endsWith("/") ? remote : remote + "/");
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) throw new UsageError("--remote must be https:// (plain http only to loopback)");
  const url = new URL(`admin/api/${req.path}`, base);
  for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, "x-osmcp-totp": totp };
  if (req.body) headers["content-type"] = "application/json";
  const r = await fetch(url, { method: req.method, headers, body: req.body ? JSON.stringify(req.body) : undefined });
  const data = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new Error(`${r.status}: ${data.error ?? r.statusText}`);
  return data;
}

/** Run one command. Resolves to an exit code, or undefined while `serve` keeps running. */
export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, out = (s: string) => console.log(s)): Promise<number | undefined> {
  let cmd: Command;
  try {
    cmd = parseCli(argv);
  } catch (err) {
    console.error(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (cmd.name === "help") {
    out(USAGE);
    return 0;
  }
  const print = (v: unknown) => out(typeof v === "string" ? v : JSON.stringify(v, null, 2));
  try {
    const req = adminRequest(cmd);
    if (cmd.flags.remote) {
      if (!req) throw new UsageError(`"${cmd.name}" runs only against the local state dir`);
      const token = cmd.flags.token ?? env.OSMCP_ADMIN_TOKEN;
      const totp = cmd.flags.totp ?? env.OSMCP_TOTP;
      if (!token || !totp) throw new UsageError("--remote needs --token and --totp (or OSMCP_ADMIN_TOKEN / OSMCP_TOTP)");
      print(await remoteAdmin(cmd.flags.remote, token, totp, req));
      return 0;
    }
    const cfg = loadConfig({ argv, env });
    if (cmd.name === "validate") return validate(cfg, print);
    if (cmd.name === "serve") return await serve(cfg);
    const { createApp } = await import("./server/app.js"); // lazy: pulls in every lane
    const app = await createApp(cfg, { schedule: false });
    try {
      if (req) print(await adminCall(app, LOCAL_PRINCIPAL, req.method, req.path, new URLSearchParams(req.query), req.body));
      else await local(app, cmd, print);
    } finally {
      await app.close();
    }
    return 0;
  } catch (err) {
    console.error(`one-stop-mcp ${cmd.name}: ${(err as Error).message}`);
    return err instanceof UsageError ? 2 : 1;
  }
}

async function local(app: App, cmd: Command, print: (v: unknown) => void): Promise<void> {
  const f = cmd.flags;
  switch (cmd.name) {
    case "init": {
      if (app.users.list().length) return print(`already initialized: ${app.cfg.home} (${app.users.list().length} user(s))`);
      const p: Principal = { user: f.user ?? "admin", org: f.org ?? "default", admin: true };
      app.users.add(p.user, p.org, true);
      const { token } = app.users.issueToken(p.user);
      const uri = await app.enrollTotp(p);
      return print(`state dir: ${app.cfg.home}\nadmin ${p.org}/${p.user} token (shown once): ${token}\nTOTP (add to your authenticator, shown once): ${uri}`);
    }
    case "servers list":
      return print(await app.registry.listServers(LOCAL_PRINCIPAL));
    case "connect":
      return connectFlow(app, cmd.args[0], f.user ? { user: f.user, org: f.org ?? "local", admin: false } : LOCAL_PRINCIPAL, print);
    case "catalog refresh":
      return print(await app.refreshCatalog(cmd.args));
    case "sync":
      return print(await app.sync(f.registry));
  }
}

/** The pending ticket lives in this process's broker, so this process serves the
 *  key-entry/callback page itself until the credential lands (or 15 minutes pass). */
async function connectFlow(app: App, server: string, p: Principal, print: (v: unknown) => void): Promise<void> {
  const http = await startHttp(app).catch((err) => {
    throw new Error((err as NodeJS.ErrnoException).code === "EADDRINUSE" ? `port ${app.cfg.http.port} is busy (a gateway is running?); use connect_server from your client instead` : (err as Error).message);
  });
  try {
    const r = await app.auth.connect(p, server);
    print(r);
    if (r.status !== "pending") return;
    console.error("waiting for you to finish in the browser...");
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if ((await app.store.list({ org: p.org, user: p.user, server })).length) return print(`${server}: connected`);
    }
    throw new Error("timed out waiting for the browser step");
  } finally {
    await http.close();
  }
}

async function serve(cfg: Config): Promise<undefined> {
  const { createApp } = await import("./server/app.js");
  const app = await createApp(cfg);
  const http = await startHttp(app);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await http.close().catch(() => {});
    await app.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // stdout is the MCP channel in local mode: logs go to stderr only.
  if (cfg.mode === "local") {
    const gateway = buildGateway(app, LOCAL_PRINCIPAL);
    gateway.onclose = shutdown; // the client went away
    await gateway.connect(new StdioServerTransport());
    console.error(`one-stop-mcp: local mode, ${app.registry.manifests().length} server(s), 4 meta-tools on stdio; auth pages on ${http.url}`);
  } else {
    console.error(`one-stop-mcp: team mode on ${http.url} (/mcp, /admin, /metrics), ${app.registry.manifests().length} server(s)`);
  }
  return undefined;
}

/** Manifests parse and validate, and each has a non-empty catalog snapshot. */
function validate(cfg: Config, print: (v: unknown) => void): number {
  let bad = 0;
  const rows = loadManifests(cfg.serversDir).map((m) => {
    try {
      const snap = JSON.parse(readFileSync(join(cfg.catalogDir, `${m.id}.json`), "utf8")) as { tools?: unknown[] };
      if (!Array.isArray(snap.tools) || !snap.tools.length) throw new Error("snapshot has no tools");
      return `ok    ${m.id} (${snap.tools.length} tools)`;
    } catch (err) {
      bad++;
      return `FAIL  ${m.id}: ${(err as Error).message}`;
    }
  });
  print(rows.join("\n") || "no manifests");
  return bad ? 1 : 0;
}

/** Entry point for the bin: run, then exit once stdout has drained (serve keeps running). */
export function run(argv = process.argv.slice(2)): void {
  main(argv).then(
    (code) => code !== undefined && process.stdout.write("", () => process.exit(code)),
    (err) => {
      console.error("one-stop-mcp failed:", err);
      process.exit(1);
    },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
