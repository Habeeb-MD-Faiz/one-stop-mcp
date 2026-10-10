// Manifest CI (PDR §9 P5): validates servers/*.yaml against the manifest rules,
// checks each has a non-empty tool snapshot in catalog/, that routing.tools keys
// and bench gold tools exist in it, and prints one row per server. Exits 1 on any
// error.
//
// Run: npm run validate            (the repo this script lives in)
//      npm run validate -- <root>  (any folder with servers/ and catalog/)
import { fileURLToPath } from "node:url";
import { validateCatalog } from "../src/catalog/validate.js";
import { formatTable } from "../src/catalog/table.js";

const root = process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url));
const { rows, errors } = validateCatalog(root);

console.log(formatTable(["id", "transport", "auth", "tools", "bench", "status"], rows.map((r) => [r.id, r.transport, r.auth, String(r.tools ?? "-"), String(r.bench ?? "-"), r.errors.length ? `${r.errors.length} error(s)` : "ok"])));
if (errors.length) {
  console.error(`\n${errors.length} problem(s):\n${errors.map((e) => `  ${e}`).join("\n")}`);
  process.exit(1);
}
console.log(`\n${rows.length} server(s) valid.`);
