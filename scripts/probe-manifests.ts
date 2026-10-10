// PR probe (PDR §11): for each manifest, open an MCP session and check it answers.
// HTTP: initialize, or a 401 with WWW-Authenticate (alive, wants credentials).
// stdio with auth none: spawn it and initialize. stdio needing credentials: skipped.
// Exits 1 if any probe fails.
//
// Run: npm run probe -- [--no-spawn] [id ...]
//   default ids: servers/ manifests changed vs origin/master (committed or not).
//   --no-spawn:  never run a manifest's command (use on untrusted PRs; HTTP only).
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkManifests } from "../src/manifest.js";
import { probeManifest, type ProbeResult } from "../src/catalog/probe.js";
import { formatTable } from "../src/catalog/table.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const spawn = !args.includes("--no-spawn");
let ids = args.filter((a) => !a.startsWith("--"));

if (!ids.length) {
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
  try {
    const files = [...git("diff", "--name-only", "--diff-filter=d", "origin/master", "--", "servers"), ...git("ls-files", "--others", "--exclude-standard", "--", "servers")];
    ids = [...new Set(files.filter((f) => /^servers\/[^/]+\.ya?ml$/.test(f)).map((f) => basename(f).replace(/\.ya?ml$/, "")))];
  } catch (e) {
    console.error(`could not diff against origin/master (${(e as Error).message.split("\n")[0]}); pass ids explicitly: npm run probe -- <id> ...`);
    process.exit(1);
  }
  if (!ids.length) {
    console.log("no changed manifests vs origin/master; nothing to probe.");
    process.exit(0);
  }
}

const files = checkManifests(join(root, "servers"));
const results: ProbeResult[] = [];
for (const id of ids) {
  const file = files.find((f) => (f.manifest?.id ?? f.source.replace(/\.ya?ml$/, "")) === id);
  if (!file) results.push({ id, status: "fail", note: "no such manifest in servers/" });
  else if (!file.manifest) results.push({ id, status: "fail", note: `invalid manifest (run npm run validate): ${file.errors[0]}` });
  else results.push(await probeManifest(file.manifest, { spawn, cwd: root }));
}

const type = (id: string) => files.find((f) => f.manifest?.id === id)?.manifest?.transport.type ?? "?";
console.log(formatTable(["id", "transport", "result", "note"], results.map((r) => [r.id, type(r.id), r.status, r.note])));
if (results.some((r) => r.status === "fail")) process.exit(1);
