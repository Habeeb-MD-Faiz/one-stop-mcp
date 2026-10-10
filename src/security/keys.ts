import { createHash, createHmac, hkdfSync, randomBytes, scrypt } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import { writeOnce } from "./files.js";

// Key hierarchy (D7, D14, D29). One 32-byte root key comes from a KeyProvider;
// org keys are HKDF(root, "org:"+org) and user keys HKDF(orgKey, "user:"+user)
// (RFC 5869), so every user's secrets sit under a key of their own. Providers:
// a local key file (default, SSH-key model), a scrypt passphrase
// (OSMCP_MASTER_KEY), or a random root key kept on disk only *wrapped* by
// HashiCorp Vault Transit or AWS KMS - unwrapping needs the KMS every start.

export interface KeyProvider {
  rootKey(): Promise<Buffer>;
}

const KEY_LEN = 32;
const NO_SALT = Buffer.alloc(0);

const hkdf = (key: Buffer, info: string): Buffer => Buffer.from(hkdfSync("sha256", key, NO_SALT, info, KEY_LEN));
export const orgKey = (root: Buffer, org: string): Buffer => hkdf(root, `org:${org}`);
export const userKey = (root: Buffer, org: string, user: string): Buffer => hkdf(orgKey(root, org), `user:${user}`);

/** Memoize a key load, but forget a failure so a transient KMS outage can be retried. */
function once(load: () => Promise<Buffer>): () => Promise<Buffer> {
  let p: Promise<Buffer> | undefined;
  return () => (p ??= load().catch((err) => { p = undefined; throw err; }));
}

function checkLen(key: Buffer, what: string): Buffer {
  if (key.length !== KEY_LEN) throw new Error(`${what}: root key must be ${KEY_LEN} bytes, got ${key.length}`);
  return key;
}

/** 32 random bytes in a 0600 file, created on first use (D29). */
export class KeyFileProvider implements KeyProvider {
  constructor(private path: string) {}
  rootKey = once(async () => {
    writeOnce(this.path, randomBytes(KEY_LEN));
    return checkLen(readFileSync(this.path), this.path);
  });
}

// OWASP Password Storage Cheat Sheet scrypt floor: N=2^17, r=8, p=1.
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: typeof SCRYPT) => Promise<Buffer>;

/** Root key = scrypt(passphrase, salt). The salt file is random, not secret. */
export class PassphraseKeyProvider implements KeyProvider {
  constructor(private passphrase: string, private saltFile: string) {
    if (!passphrase) throw new Error("empty master passphrase");
  }
  rootKey = once(async () => {
    writeOnce(this.saltFile, randomBytes(16));
    return scryptAsync(this.passphrase, readFileSync(this.saltFile), KEY_LEN, SCRYPT);
  });
}

/** Make a root key and persist only its wrapped form; later starts unwrap the file. */
async function wrappedRoot(
  file: string,
  create: () => Promise<{ key: Buffer; wrapped: string }>,
  unwrap: (wrapped: string) => Promise<Buffer>,
): Promise<Buffer> {
  if (!existsSync(file)) {
    const { key, wrapped } = await create();
    if (writeOnce(file, wrapped)) return checkLen(key, file);
  }
  return checkLen(await unwrap(readFileSync(file, "utf8").trim()), file);
}

// --- HashiCorp Vault -------------------------------------------------------------

/** One Vault HTTP API call. 404 is returned (callers treat it as "absent");
 *  any other non-2xx throws. The token never appears in an error. */
export async function vaultFetch(addr: string, token: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  // TODO(live): verified against the real API only with Habeeb present
  const res = await fetch(addr.replace(/\/+$/, "") + path, {
    method,
    headers: { "X-Vault-Token": token, ...(body !== undefined && { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = undefined; }
  if (!res.ok && res.status !== 404) {
    const errors = Array.isArray(data?.errors) ? ` ${data.errors.join("; ")}` : "";
    throw new Error(`vault ${method} ${path.split("?")[0]}: HTTP ${res.status}${errors}`);
  }
  return { status: res.status, data };
}

export interface VaultTransitOptions {
  addr: string;
  token: string;
  keyName: string;
  wrappedKeyFile: string;
  mount?: string;
}

/** Root key wrapped by Vault Transit `encrypt`, unwrapped with `decrypt`. */
export class VaultTransitKeyProvider implements KeyProvider {
  constructor(private o: VaultTransitOptions) {}
  private async call(op: "encrypt" | "decrypt", body: Record<string, string>): Promise<any> {
    const { status, data } = await vaultFetch(this.o.addr, this.o.token, "POST", `/v1/${this.o.mount ?? "transit"}/${op}/${encodeURIComponent(this.o.keyName)}`, body);
    if (status !== 200 || !data?.data) throw new Error(`vault transit ${op}: HTTP ${status}`);
    return data.data;
  }
  rootKey = once(() =>
    wrappedRoot(
      this.o.wrappedKeyFile,
      async () => {
        const key = randomBytes(KEY_LEN);
        return { key, wrapped: (await this.call("encrypt", { plaintext: key.toString("base64") })).ciphertext };
      },
      async (ciphertext) => Buffer.from((await this.call("decrypt", { ciphertext })).plaintext, "base64"),
    ),
  );
}

// --- AWS KMS + SigV4 -------------------------------------------------------------

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex");
const hmac = (key: Buffer | string, s: string): Buffer => createHmac("sha256", key).update(s).digest();
// RFC 3986 unreserved only, as SigV4 requires; encodeURIComponent leaves !'()* alone.
const uriEncode = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** AWS Signature Version 4 (header form). Returns the headers to send: the
 *  input headers plus x-amz-date, x-amz-security-token and Authorization. Host
 *  is signed from the URL and left for fetch to set. Non-S3 path rules. */
export function signV4(
  req: { method: string; url: string; headers: Record<string, string>; body: string },
  creds: AwsCredentials,
  region: string,
  service: string,
  now = new Date(),
): Record<string, string> {
  const url = new URL(req.url);
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const out: Record<string, string> = { ...req.headers, "x-amz-date": amzDate };
  if (creds.sessionToken) out["x-amz-security-token"] = creds.sessionToken;
  const canon = Object.entries({ ...out, host: url.host })
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signedHeaders = canon.map(([k]) => k).join(";");
  const query = [...url.searchParams]
    .map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`)
    .sort()
    .join("&");
  const canonicalRequest = [
    req.method.toUpperCase(),
    url.pathname.split("/").map(uriEncode).join("/") || "/",
    query,
    canon.map(([k, v]) => `${k}:${v}\n`).join(""),
    signedHeaders,
    sha256hex(req.body),
  ].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, day), region), service), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(toSign).digest("hex");
  out.Authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}

export interface AwsKmsOptions {
  region: string;
  keyId: string;
  wrappedKeyFile: string;
  credentials: AwsCredentials;
  /** Override for tests / VPC endpoints. Default https://kms.<region>.amazonaws.com/ */
  endpoint?: string;
}

// Binds the wrapped root key to this use: KMS refuses to decrypt it without the same context.
const KMS_CONTEXT = { purpose: "one-stop-mcp-root-key" };

/** Root key from KMS GenerateDataKey (AES_256); the CiphertextBlob is persisted, Decrypt unwraps it. */
export class AwsKmsKeyProvider implements KeyProvider {
  constructor(private o: AwsKmsOptions) {}
  private async kms(action: "GenerateDataKey" | "Decrypt", body: Record<string, unknown>): Promise<any> {
    // TODO(live): verified against the real API only with Habeeb present
    const url = this.o.endpoint ?? `https://kms.${this.o.region}.amazonaws.com/`;
    const payload = JSON.stringify(body);
    const headers = signV4(
      { method: "POST", url, headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": `TrentService.${action}` }, body: payload },
      this.o.credentials,
      this.o.region,
      "kms",
    );
    const res = await fetch(url, { method: "POST", headers, body: payload });
    const data = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new Error(`aws kms ${action}: HTTP ${res.status} ${data.__type ?? ""}`.trim());
    return data;
  }
  rootKey = once(() =>
    wrappedRoot(
      this.o.wrappedKeyFile,
      async () => {
        const out = await this.kms("GenerateDataKey", { KeyId: this.o.keyId, KeySpec: "AES_256", EncryptionContext: KMS_CONTEXT });
        return { key: Buffer.from(out.Plaintext, "base64"), wrapped: out.CiphertextBlob as string };
      },
      async (blob) => Buffer.from((await this.kms("Decrypt", { CiphertextBlob: blob, KeyId: this.o.keyId, EncryptionContext: KMS_CONTEXT })).Plaintext, "base64"),
    ),
  );
}
