import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// TOTP for admin MFA (D16): RFC 6238 over RFC 4226 HOTP - HMAC-SHA1, 30 s
// steps, 6 digits, accepting one step of clock drift either side. Secrets are
// base32 (RFC 4648) so any authenticator app can scan the otpauth:// URI.

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_MS = 30_000;

export function base32Encode(buf: Buffer): string {
  let out = "";
  let bits = 0;
  let acc = 0;
  for (const byte of buf) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const bytes: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of s.toUpperCase().replace(/[\s=]/g, "")) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error("invalid base32 secret");
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bytes.push((acc >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** 160-bit secret, the RFC 4226 recommended length. */
export const generateTotpSecret = (): string => base32Encode(randomBytes(20));

function hotp(key: Buffer, counter: number, digits: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", key).update(msg).digest();
  const offset = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).padStart(digits, "0");
}

/** The code for `now`. `digits` is only for the RFC 6238 test vectors (8). */
export const totp = (secret: string, now = Date.now(), digits = 6): string => hotp(base32Decode(secret), Math.floor(now / STEP_MS), digits);

/** The time step a code matched (±1 step), else undefined. RFC 6238 §5.2 says a
 *  code must not be accepted twice: callers keep the last matched step per
 *  admin and reject a step <= it. */
export function matchTotp(secret: string, code: string, now = Date.now()): number | undefined {
  if (!/^\d{6}$/.test(code)) return undefined;
  const key = base32Decode(secret);
  const step = Math.floor(now / STEP_MS);
  let hit: number | undefined;
  for (const s of [step - 1, step, step + 1]) {
    // Check all three without early exit: timing says nothing about which matched.
    if (timingSafeEqual(Buffer.from(hotp(key, s, 6)), Buffer.from(code))) hit ??= s;
  }
  return hit;
}

export const verifyTotp = (secret: string, code: string, now = Date.now()): boolean => matchTotp(secret, code, now) !== undefined;

/** otpauth:// URI (Google Authenticator Key Uri Format) for a QR code or manual entry. */
export function totpUri(secret: string, label: string, issuer: string): string {
  const i = encodeURIComponent(issuer);
  return `otpauth://totp/${i}:${encodeURIComponent(label)}?secret=${secret}&issuer=${i}&algorithm=SHA1&digits=6&period=30`;
}
