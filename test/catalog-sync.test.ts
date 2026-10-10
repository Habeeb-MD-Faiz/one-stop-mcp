// Sync worker: bounded-concurrency refresh, and the registry candidate import
// against an in-process fake of the documented registry response shape
// (GET /v0.1/servers -> { servers: [{ server, _meta }], metadata: { nextCursor, count } }).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { importCandidates, refreshSnapshots } from "../src/catalog/sync.js";
import { validateManifest } from "../src/manifest.js";

test("refreshSnapshots: bounded concurrency, order kept, failures are rows not exceptions", async () => {
  let inflight = 0;
  let peak = 0;
  const ids = ["a", "b", "c", "d", "e", "f"];
  const res = await refreshSnapshots(
    ids,
    async (id) => {
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 10));
      inflight--;
      if (id === "c") throw new Error("boom");
      if (id === "e") throw "plain string";
    },
    2,
  );
  assert.equal(peak, 2);
  assert.deepEqual(res.map((r) => r.id), ids);
  assert.deepEqual(res.filter((r) => !r.ok), [{ id: "c", ok: false, error: "boom" }, { id: "e", ok: false, error: "plain string" }]);
  assert.deepEqual(await refreshSnapshots([], async () => {}), []);
  // a refresher that throws synchronously is still just a failed row
  const sync = await refreshSnapshots(["x"], (() => { throw new Error("sync"); }) as any);
  assert.deepEqual(sync, [{ id: "x", ok: false, error: "sync" }]);
});

// --- fake registry ---------------------------------------------------------------

const srv = (name: string, rest: object) => ({ server: { name, description: `${name} description`, version: "1.0.0", ...rest }, _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } } });
const stdio = { type: "stdio" };

const PAGE1 = {
  servers: [
    srv("io.github.acme/notes", {
      title: "Notes",
      websiteUrl: "https://notes.example.com",
      remotes: [{ type: "streamable-http", url: "https://notes.example.com/mcp/{tenant_id}", headers: [{ name: "X-Api-Key", isSecret: true, isRequired: true }] }],
      packages: [{ registryType: "npm", identifier: "@acme/ignored", version: "9.9.9", transport: stdio }],
    }),
    srv("io.github.acme/pkg-only", {
      repository: { url: "https://github.com/acme/pkg-only", source: "github" },
      packages: [{ registryType: "npm", identifier: "@acme/pkg-only", version: "1.2.3", transport: stdio, environmentVariables: [{ name: "PKG_TOKEN", isSecret: true, isRequired: true }, { name: "PKG_LOG" }] }],
    }),
    srv("io.github.acme/py-server", { packages: [{ registryType: "pypi", identifier: "py-server", version: "0.4.0", runtimeHint: "uvx", transport: stdio }] }),
    srv("io.github.acme/docker-only", { packages: [{ registryType: "oci", identifier: "docker.io/acme/x:1", transport: stdio }] }),
  ],
  metadata: { count: 4, nextCursor: "page2" },
};
const PAGE2 = {
  servers: [
    srv("io.github.acme/sse-only", { remotes: [{ type: "sse", url: "https://sse.example.com/sse" }] }),
    { ...srv("io.github.acme/old", { remotes: [{ type: "streamable-http", url: "https://old.example.com/mcp" }] }), _meta: { "io.modelcontextprotocol.registry/official": { status: "deprecated" } } },
    srv("io.github.acme/already", { remotes: [{ type: "streamable-http", url: "https://already.example.com/mcp" }] }),
    srv("io.github.acme/optioninject", { packages: [{ registryType: "npm", identifier: "--registry=http://evil.example.com", version: "1.0.0", transport: stdio }] }),
    srv("io.github.acme/evil", {
      description: "line1\n# comment\nid: hacked: [",
      remotes: [{ type: "streamable-http", url: "https://evil.example.com/mcp", headers: [{ name: "X-Key\nid: pwned", isSecret: true }] }],
    }),
    srv("io.github.acme/unpinned", { packages: [{ registryType: "npm", identifier: "unpinned-mcp", transport: stdio }] }),
    { not: "a server entry" },
  ],
  metadata: { count: 7 },
};

async function withRegistry<T>(fn: (url: string, requests: string[]) => Promise<T>, status = 200): Promise<T> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    requests.push(req.url!);
    if (status !== 200) return void res.writeHead(status).end("nope");
    const u = new URL(req.url!, "http://x");
    const body = u.pathname !== "/v0.1/servers" ? undefined : u.searchParams.get("cursor") === "page2" ? PAGE2 : PAGE1;
    if (!body) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests);
  } finally {
    server.close();
  }
}

const tmp = () => mkdtempSync(join(tmpdir(), "osmcp-sync-"));
const read = (dir: string, id: string) => readFileSync(join(dir, `${id}.yaml`), "utf8");

test("importCandidates: maps remotes and packages to drafts, skips what it should, writes only the candidates dir", async () => {
  const root = tmp();
  const candidatesDir = join(root, "servers", "_candidates");
  mkdirSync(join(root, "servers"), { recursive: true });
  try {
    await withRegistry(async (registryUrl, requests) => {
      const r = await importCandidates({ registryUrl, candidatesDir, existingIds: ["io-github-acme-already", "echo"] });
      assert.deepEqual(requests.map((u) => new URL(u, "http://x").search), ["?limit=100&version=latest", "?limit=100&version=latest&cursor=page2"]);
      assert.equal(r.scanned, 11);
      assert.deepEqual(r.written.sort(), ["io-github-acme-evil", "io-github-acme-notes", "io-github-acme-pkg-only", "io-github-acme-py-server", "io-github-acme-unpinned"]);
      const reasons = Object.fromEntries(r.skipped.map((s) => [s.id, s.reason]));
      assert.match(reasons["io-github-acme-docker-only"], /no supported transport/);
      assert.match(reasons["io-github-acme-sse-only"], /no supported transport/);
      assert.match(reasons["io-github-acme-optioninject"], /no supported transport/);
      assert.match(reasons["io-github-acme-old"], /status deprecated/);
      assert.match(reasons["io-github-acme-already"], /already in the catalog/);
      assert.equal(r.skipped.find((s) => s.reason === "malformed entry")?.id, "");
    });

    // nothing outside _candidates/ was written (D9)
    assert.deepEqual(readdirSync(join(root, "servers")), ["_candidates"]);

    // every draft is a valid manifest, so a reviewer only fixes the TODOs
    for (const f of readdirSync(candidatesDir)) {
      assert.deepEqual(validateManifest(parse(readFileSync(join(candidatesDir, f), "utf8")), f), [], f);
    }

    const notes = read(candidatesDir, "io-github-acme-notes");
    assert.match(notes, /^# UNREVIEWED CANDIDATE/);
    assert.match(notes, /# TODO review auth/);
    assert.match(notes, /# registry hints: header X-Api-Key \(secret, required\)/);
    assert.match(notes, /# TODO the url has \{variables\}/);
    assert.deepEqual(parse(notes), {
      id: "io-github-acme-notes", name: "Notes", category: ["utility"], description: "io.github.acme/notes description", homepage: "https://notes.example.com",
      transport: { type: "streamable-http", url: "https://notes.example.com/mcp/{tenant_id}" },
      auth: { type: "none" }, routing: { examples: [] }, health: { check: "initialize" },
    });

    const pkg = parse(read(candidatesDir, "io-github-acme-pkg-only"));
    assert.deepEqual(pkg.transport, { type: "stdio", command: "npx", args: ["-y", "@acme/pkg-only@1.2.3"] });
    assert.equal(pkg.name, "pkg-only");
    assert.equal(pkg.homepage, "https://github.com/acme/pkg-only");
    assert.match(read(candidatesDir, "io-github-acme-pkg-only"), /# registry hints: env PKG_TOKEN \(secret, required\)\n/);

    assert.deepEqual(parse(read(candidatesDir, "io-github-acme-py-server")).transport, { type: "stdio", command: "uvx", args: ["py-server@0.4.0"] });
    assert.match(read(candidatesDir, "io-github-acme-unpinned"), /# TODO pin an exact package version/);

    // registry text cannot break out of a comment or a scalar
    const evil = read(candidatesDir, "io-github-acme-evil");
    assert.equal(parse(evil).id, "io-github-acme-evil");
    assert.equal(parse(evil).description, "line1 # comment id: hacked: [");
    assert.match(evil, /# registry hints: header X-Key id: pwned \(secret\)\n/);

    // a second run never overwrites a (possibly reviewed) candidate
    await withRegistry(async (registryUrl) => {
      const again = await importCandidates({ registryUrl, candidatesDir, existingIds: [] });
      assert.deepEqual(again.written, ["io-github-acme-already"]);
      assert.equal(again.skipped.filter((s) => s.reason === "candidate already exists").length, 5);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("importCandidates: limit stops early; a registry error or odd shape throws", async () => {
  const root = tmp();
  try {
    await withRegistry(async (registryUrl, requests) => {
      const r = await importCandidates({ registryUrl, candidatesDir: join(root, "c"), existingIds: [], limit: 2 });
      assert.equal(r.written.length, 2);
      assert.equal(requests.length, 1, "second page never fetched");
    });
    await withRegistry(async (registryUrl) => {
      await assert.rejects(importCandidates({ registryUrl, candidatesDir: join(root, "d"), existingIds: [] }), /HTTP 503/);
    }, 503);
    const odd = (async () => new Response(JSON.stringify({ nope: 1 }))) as unknown as typeof fetch;
    await assert.rejects(importCandidates({ candidatesDir: join(root, "e"), existingIds: [], fetch: odd }), /no servers\[\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
