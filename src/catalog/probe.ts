// The PR probe (PDR §11: "CI validates it and probes the endpoint"). Opens an MCP
// session to one manifest's server and reports whether it answers. It never has a
// credential, so a server that wants one counts as reachable when it says so.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Manifest } from "../types.js";

export interface ProbeResult {
  id: string;
  status: "ok" | "skip" | "fail";
  note: string;
}

export interface ProbeOptions {
  timeoutMs?: number;
  /** false = never run a manifest's command (CI on untrusted PRs). */
  spawn?: boolean;
  /** Working directory for stdio servers, so repo-relative args resolve. */
  cwd?: string;
}

const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0];
const INFO = { name: "one-stop-mcp-probe", version: "0" };

export async function probeManifest(m: Manifest, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const timeout = opts.timeoutMs ?? 30_000;
  const done = (status: ProbeResult["status"], note: string): ProbeResult => ({ id: m.id, status, note });
  const check = m.health?.check ?? "initialize";
  if (check === "none") return done("skip", "health.check is none");

  const t = m.transport;
  if (t.type === "stdio" && (m.auth?.type ?? "none") !== "none") return done("skip", `needs credentials (auth ${m.auth!.type}); not probed`);
  if (t.type === "stdio" && opts.spawn === false) return done("skip", "stdio spawn disabled");

  const client = new Client(INFO);
  try {
    const transport =
      t.type === "stdio"
        ? new StdioClientTransport({ command: t.command, args: t.args, env: t.env, cwd: opts.cwd, stderr: "ignore" }) // env undefined = SDK safe defaults, never the gateway's own (D31)
        : new StreamableHTTPClientTransport(new URL(t.url), { requestInit: { headers: t.headers } });
    await client.connect(transport, { timeout });
    const v = client.getServerVersion();
    let note = `initialize ok (${v?.name} ${v?.version})`;
    if (check === "tools/list") note += `, ${(await client.listTools(undefined, { timeout })).tools.length} tool(s)`;
    return done("ok", note);
  } catch (e) {
    // The SDK throws away response headers on a 401, so ask once more by hand:
    // 401 + WWW-Authenticate is a live server that wants credentials we don't have.
    if (t.type === "streamable-http") {
      try {
        const res = await fetch(t.url, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...t.headers },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: INFO } }),
          signal: AbortSignal.timeout(timeout),
        });
        void res.body?.cancel();
        if (res.status === 401 && res.headers.get("www-authenticate")) return done("ok", "reachable, requires auth (401 + WWW-Authenticate)");
        return done("fail", `${firstLine(e)} (raw initialize: HTTP ${res.status})`);
      } catch {
        // fall through to the original error
      }
    }
    return done("fail", firstLine(e));
  } finally {
    await client.close().catch(() => {});
  }
}
