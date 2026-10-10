// Least-privilege injection (PDR §5): a credential goes out on the wire and
// nowhere else. Downstream results and errors pass through here before they
// reach a model or a log. `redact` removes the exact secrets the gateway knows
// it injected; `scrub` is the net for credential-shaped text it doesn't know
// (an upstream error echoing a header, a stack trace with a URL in it).

const MASK = "[REDACTED]";

/** Deep-replace every occurrence of each known secret string with [REDACTED].
 *  Errors come back as new Errors with a redacted message (stack dropped). */
export function redact<T>(value: T, secrets: string[]): T {
  const known = [...new Set(secrets.filter((s) => typeof s === "string" && s.length > 0))].sort((a, b) => b.length - a.length);
  if (known.length === 0) return value;
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return known.reduce((s, k) => s.replaceAll(k, MASK), v);
    if (v instanceof Error) {
      const e = new Error(walk(v.message) as string);
      e.name = v.name;
      return e;
    }
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return "[Circular]";
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
  };
  return walk(value) as T;
}

// Credential shapes. Order matters: specific token formats before the generic key=value rule.
const SHAPES: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, MASK],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+/g, MASK], // JWT
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, MASK], // GitHub tokens
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, MASK], // Slack
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK], // AWS access key id
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, MASK], // Google API key
  [/\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g, MASK], // Stripe
  [/\bsk-[A-Za-z0-9_-]{20,}/g, MASK], // OpenAI / Anthropic style
  [/(\/\/)[^\s/:@]+:[^\s/@]+@/g, `$1${MASK}@`], // credentials in a URL
  [/\b((?:api[_-]?key|x-api-key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret|password|passwd|token|authorization)["']?\s*[:=]\s*["']?)(?!\[REDACTED\])[^\s"'&,;}]{4,}/gi, `$1${MASK}`],
];

/** Remove bearer tokens and common key shapes from free text. */
export function scrub(text: string): string {
  return SHAPES.reduce((s, [re, to]) => s.replace(re, to), text);
}
