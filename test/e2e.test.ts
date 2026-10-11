// End-to-end (burn-down S3): a real MCP client spawns the gateway over stdio the way
// Claude Desktop does, against the shipped catalog (50 seed servers + echo). It checks
// the constant four-tool surface, find_tools over every snapshot without spawning
// anything (D25), a real invoke through a spawned downstream (echo), and
// connect_server handing back a key-entry page on the loopback server (D18).
// Throwaway OSMCP_HOME, embeddings off (the D5 degrade path), no network beyond 127.0.0.1.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(import.meta.dirname, "..");

const freePort = () =>
  new Promise<number>((ok) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
  });

type Result = { content: Array<{ type: string; text: string }>; isError?: boolean };
const json = (r: unknown) => JSON.parse((r as Result).content[0].text);

test("stdio client -> gateway -> seed catalog: four tools, find, invoke, connect", { timeout: 120_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "osmcp-e2e-"));
  const port = await freePort();
  const client = new Client({ name: "e2e", version: "0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(root, "src", "index.ts"), "serve"],
    cwd: root,
    env: { OSMCP_HOME: home, OSMCP_EMBEDDINGS: "off", OSMCP_PORT: String(port) },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);

    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["connect_server", "find_tools", "invoke", "list_servers"]);

    const servers = json(await client.callTool({ name: "list_servers", arguments: {} }));
    const list = Array.isArray(servers) ? servers : servers.servers;
    assert.ok(list.length >= 51, `every shipped manifest is listed (got ${list.length})`);

    const found = json(await client.callTool({ name: "find_tools", arguments: { query: "list my open pull requests on github", k: 5 } }));
    assert.ok(found.tools.some((t: { server: string }) => t.server === "github"), "a GitHub tool is in the shortlist");
    assert.ok(found.tools.every((t: { inputSchema?: unknown }) => t.inputSchema), "shortlisted tools carry their schemas (Layer B)");

    const echoed = (await client.callTool({ name: "invoke", arguments: { server: "echo", tool: "echo", args: { message: "round trip" } } })) as Result;
    assert.ok(!echoed.isError, echoed.content[0]?.text);
    assert.match(echoed.content[0].text, /round trip/);

    const connect = json(await client.callTool({ name: "connect_server", arguments: { server: "brave-search" } }));
    assert.equal(connect.status, "pending");
    assert.match(connect.url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/connect/`));
    const page = await fetch(connect.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<form/);
  } finally {
    await client.close();
    rmSync(home, { recursive: true, force: true });
  }
});
