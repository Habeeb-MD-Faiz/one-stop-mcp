// Gateway configuration: defaults < config file < OSMCP_* env < argv. One binary,
// two modes (D23): `local` (stdio + loopback HTTP for auth pages) and `team`
// (Streamable HTTP, bearer tokens, admin API). Credentials — the master key, the
// HashiCorp token, AWS keys, the metrics token — come from the environment only,
// never from the file (D29), so a config file is safe to commit or mount.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parse } from "yaml";

export type Mode = "local" | "team";
export type KeyProviderKind = "keyfile" | "passphrase" | "vault-transit" | "aws-kms";

export interface Config {
  mode: Mode;
  home: string;
  serversDir: string;
  catalogDir: string;
  http: { host: string; port: number; publicUrl: string };
  vault: {
    backend: "file" | "hashicorp";
    keyProvider: KeyProviderKind;
    hashicorp?: { addr: string; mount?: string; token?: string };
    transit?: { addr: string; keyName: string; mount?: string; token?: string };
    awsKms?: { region: string; keyId: string; credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } };
  };
  routing: { embeddings: "on" | "off"; model?: string };
  compress: "off" | "light" | "aggressive";
  ttlMs: number;
  rotation: { days: number; checkEveryMs: number };
  ledger: { burstMax: number; windowMs: number };
  metrics: { token?: string };
  /** OSMCP_MASTER_KEY, env only. */
  masterKey?: string;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), ".."); // src/ under tsx, dist/ when built
export const DEFAULT_PORT = 8420; // D32

// The keys a config file may set. Anything else is a typo or a credential that
// belongs in the environment — both fail loud.
const FILE_KEYS = {
  mode: 1, home: 1, serversDir: 1, catalogDir: 1, compress: 1, ttlMs: 1,
  http: { host: 1, port: 1, publicUrl: 1 },
  vault: { backend: 1, keyProvider: 1, hashicorp: { addr: 1, mount: 1 }, transit: { addr: 1, keyName: 1, mount: 1 }, awsKms: { region: 1, keyId: 1 } },
  routing: { embeddings: 1, model: 1 },
  rotation: { days: 1, checkEveryMs: 1 },
  ledger: { burstMax: 1, windowMs: 1 },
  metrics: {},
};

const ENV_KEYS: Record<string, string> = {
  OSMCP_MODE: "mode", OSMCP_HOME: "home", OSMCP_SERVERS_DIR: "serversDir", OSMCP_CATALOG_DIR: "catalogDir",
  OSMCP_HOST: "http.host", OSMCP_PORT: "http.port", OSMCP_PUBLIC_URL: "http.publicUrl",
  OSMCP_VAULT_BACKEND: "vault.backend", OSMCP_KEY_PROVIDER: "vault.keyProvider",
  OSMCP_EMBEDDINGS: "routing.embeddings", OSMCP_MODEL: "routing.model", OSMCP_COMPRESS: "compress",
  OSMCP_TTL_MS: "ttlMs", OSMCP_ROTATION_DAYS: "rotation.days",
};

type Raw = Record<string, any>;

export function loadConfig(opts: { argv?: string[]; env?: NodeJS.ProcessEnv } = {}): Config {
  const env = opts.env ?? process.env;
  const { values: flags } = parseArgs({
    args: opts.argv ?? [],
    options: { config: { type: "string" }, http: { type: "boolean" } },
    strict: false,
    allowPositionals: true,
  });

  const defaultHome = expand(env.OSMCP_HOME ?? join(homedir(), ".one-stop-mcp"));
  const explicit = (flags.config as string | undefined) ?? env.OSMCP_CONFIG;
  const file = explicit ? resolve(expand(explicit)) : existsSync(join(defaultHome, "config.yaml")) ? join(defaultHome, "config.yaml") : undefined;

  const raw: Raw = file ? readFile(file) : {};
  for (const [name, key] of Object.entries(ENV_KEYS)) {
    if (env[name] !== undefined && env[name] !== "") set(raw, key, env[name]);
  }
  if (flags.http) raw.mode = "team";

  const mode = oneOf(raw.mode ?? "local", "mode", ["local", "team"] as const);
  const port = int(raw.http?.port ?? DEFAULT_PORT, "http.port", 0, 65535);
  // Local mode never listens beyond loopback: that server only carries auth pages.
  const host = mode === "local" ? "127.0.0.1" : String(raw.http?.host ?? "0.0.0.0");
  const publicUrl = url(raw.http?.publicUrl ?? `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`, "http.publicUrl");

  const masterKey = env.OSMCP_MASTER_KEY || undefined;
  const keyProvider = oneOf(
    raw.vault?.keyProvider ?? (masterKey ? "passphrase" : "keyfile"),
    "vault.keyProvider",
    ["keyfile", "passphrase", "vault-transit", "aws-kms"] as const,
  );
  if (keyProvider === "passphrase" && !masterKey) fail("vault.keyProvider passphrase needs OSMCP_MASTER_KEY in the environment");
  if (mode === "team" && keyProvider === "keyfile") {
    fail("team mode refuses to start without OSMCP_MASTER_KEY or a KMS key provider (vault.keyProvider: vault-transit | aws-kms)");
  }

  const vaultToken = env.OSMCP_VAULT_TOKEN || env.VAULT_TOKEN || undefined;
  const vault: Config["vault"] = {
    backend: oneOf(raw.vault?.backend ?? "file", "vault.backend", ["file", "hashicorp"] as const),
    keyProvider,
  };
  if (vault.backend === "hashicorp") {
    vault.hashicorp = { addr: url(raw.vault?.hashicorp?.addr, "vault.hashicorp.addr"), mount: raw.vault?.hashicorp?.mount, token: need(vaultToken, "VAULT_TOKEN (or OSMCP_VAULT_TOKEN) for the hashicorp backend") };
  }
  if (keyProvider === "vault-transit") {
    vault.transit = {
      addr: url(raw.vault?.transit?.addr, "vault.transit.addr"),
      keyName: need(raw.vault?.transit?.keyName, "vault.transit.keyName"),
      mount: raw.vault?.transit?.mount,
      token: need(vaultToken, "VAULT_TOKEN (or OSMCP_VAULT_TOKEN) for vault-transit"),
    };
  }
  if (keyProvider === "aws-kms") {
    vault.awsKms = {
      region: need(raw.vault?.awsKms?.region, "vault.awsKms.region"),
      keyId: need(raw.vault?.awsKms?.keyId, "vault.awsKms.keyId"),
      credentials: {
        accessKeyId: need(env.AWS_ACCESS_KEY_ID, "AWS_ACCESS_KEY_ID for aws-kms"),
        secretAccessKey: need(env.AWS_SECRET_ACCESS_KEY, "AWS_SECRET_ACCESS_KEY for aws-kms"),
        sessionToken: env.AWS_SESSION_TOKEN || undefined,
      },
    };
  }

  return {
    mode,
    home: absPath(raw.home) ?? defaultHome,
    serversDir: absPath(raw.serversDir) ?? join(repoRoot, "servers"),
    catalogDir: absPath(raw.catalogDir) ?? join(repoRoot, "catalog"),
    http: { host, port, publicUrl },
    vault,
    routing: { embeddings: oneOf(raw.routing?.embeddings ?? "on", "routing.embeddings", ["on", "off"] as const), model: raw.routing?.model },
    compress: oneOf(raw.compress ?? "light", "compress", ["off", "light", "aggressive"] as const),
    ttlMs: int(raw.ttlMs ?? 60_000, "ttlMs", 1000, 86_400_000),
    rotation: {
      days: int(raw.rotation?.days ?? 90, "rotation.days", 1, 3650),
      checkEveryMs: int(raw.rotation?.checkEveryMs ?? 3_600_000, "rotation.checkEveryMs", 60_000, 86_400_000),
    },
    ledger: {
      burstMax: int(raw.ledger?.burstMax ?? 100, "ledger.burstMax", 1, 1_000_000),
      windowMs: int(raw.ledger?.windowMs ?? 60_000, "ledger.windowMs", 1000, 86_400_000),
    },
    metrics: { token: env.OSMCP_METRICS_TOKEN || undefined },
    masterKey,
  };
}

function readFile(file: string): Raw {
  let doc: unknown;
  try {
    doc = parse(readFileSync(file, "utf8")) ?? {};
  } catch (err) {
    fail(`cannot read ${file}: ${(err as Error).message}`);
  }
  if (typeof doc !== "object" || Array.isArray(doc)) fail(`${file}: expected a mapping`);
  checkKeys(doc as Raw, FILE_KEYS, "", file);
  // Paths in the file are relative to the file, not to wherever the gateway was started.
  const raw = doc as Raw;
  for (const k of ["home", "serversDir", "catalogDir"]) if (typeof raw[k] === "string") raw[k] = resolve(dirname(file), expand(raw[k]));
  return raw;
}

function checkKeys(obj: Raw, shape: Raw, prefix: string, file: string): void {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix + k;
    if (!(k in shape)) {
      const secretish = /token|key$|secret|passphrase|credential|password/i.test(k) && k !== "keyName" && k !== "keyId" && k !== "keyProvider";
      fail(`${file}: unknown key "${key}"${secretish ? " (credentials come from the environment only, never the config file)" : ""}`);
    }
    if (typeof shape[k] === "object") {
      if (typeof v !== "object" || v === null || Array.isArray(v)) fail(`${file}: "${key}" must be a mapping`);
      checkKeys(v, shape[k], key + ".", file);
    }
  }
}

function set(obj: Raw, path: string, value: unknown): void {
  const parts = path.split(".");
  let o = obj;
  for (const p of parts.slice(0, -1)) o = o[p] = typeof o[p] === "object" && o[p] ? o[p] : {};
  o[parts.at(-1)!] = value;
}

function expand(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

function absPath(v: unknown): string | undefined {
  return typeof v === "string" && v ? resolve(expand(v)) : undefined;
}

function oneOf<T extends string>(v: unknown, name: string, allowed: readonly T[]): T {
  if (!allowed.includes(v as T)) fail(`${name} must be one of ${allowed.join(" | ")} (got ${JSON.stringify(v)})`);
  return v as T;
}

function int(v: unknown, name: string, min: number, max: number): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) fail(`${name} must be an integer in ${min}..${max} (got ${JSON.stringify(v)})`);
  return n as number;
}

function url(v: unknown, name: string): string {
  try {
    const u = new URL(String(v));
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
    return u.href.replace(/\/$/, "");
  } catch {
    return fail(`${name} must be an http(s) URL (got ${JSON.stringify(v)})`);
  }
}

function need<T>(v: T | undefined | null | "", what: string): T {
  if (v === undefined || v === null || v === "") fail(`missing ${what}`);
  return v as T;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(`config: ${message}`);
    this.name = "ConfigError";
  }
}

function fail(message: string): never {
  throw new ConfigError(message);
}
