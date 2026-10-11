# U1–U4 · per-tool routing utterances (doc expansion) — PDR §6, §11 "sharpen routing"

Why: `find_tools` scores each tool on its name, description, category and the
manifest's `routing.tools.<tool>` utterances. Only 204 of 926 tools have
utterances, so most tools are found by their vendor description alone. Adding
the phrases a user would actually type is document expansion (Nogueira et al.,
"Document Expansion by Query Prediction", arXiv:1904.08375): the established way
to close the vocabulary gap between queries and short documents.

Each lane works in its own worktree `.wt/utter-<n>` on branch `OneStop-MCP-utter-<n>`
and edits only `servers/<id>.yaml` for its ids, and only the `routing.tools` map.

## Honesty rules (the benchmark is worthless otherwise)

Do NOT open, grep or cat anything under `bench/`, `src/routing/`, or
`scripts/routing-bench.ts`. You are writing data, not tuning to a test.

## For each server id you own

Read `catalog/<id>.json` (the tools) and `servers/<id>.yaml` (the manifest).
For every tool in the snapshot that has fewer than 2 utterances in
`routing.tools`, add utterances so it has 2–3. Keep every existing utterance
exactly as it is.

A good utterance:
- is what a person types to an AI assistant when they want this tool, in the first
  person and imperative or question form, 4–14 words;
- uses this product's own vocabulary where it has one, because that is what tells
  it apart from the same operation on another server (Linear "cycle", Jira
  "sprint", Todoist "karma", Supabase "project", Vercel "deployment", Redis "key").
  At most one utterance per tool names the product ("in Notion", "on GitHub");
- paraphrases rather than copies the description, and varies between the tool's
  2–3 utterances (different verbs, different objects);
- is specific to this tool, not to the server in general. "Manage my repos" is
  useless; "open a pull request from my feature branch into main" is right.

## How to edit (comments must survive)

Edit with the `yaml` package's Document API so comments and the header survive.
Run the script from the worktree; `yaml` resolves from the parent repo's
node_modules (`require('C:/Users/Faix/projects/one-stop-mcp/node_modules/yaml')`
if not). Example:

```js
const doc = YAML.parseDocument(src);
const seq = doc.createNode(["first utterance", "second utterance"]);
seq.flow = true;
doc.setIn(["routing", "tools", toolName], seq);
fs.writeFileSync(file, String(doc));
```

Keep scripts and any data files in your session scratch directory, not in the repo.

## Checks before each commit

- `npm run validate` passes for all manifests (run it from your worktree).
- Every `routing.tools` key exists in `catalog/<id>.json`.
- `git diff` shows only `routing.tools` additions in your files.

## Git

Commit every 3–5 servers with the message `routing: per-tool utterances for <ids>`,
then a blank line, then `Claude-Session: https://claude.ai/code/session_01LcFtvWtDGjqKx4nwVLzaH3`.
Push after each commit: `git push -u origin OneStop-MCP-utter-<n>`. No force-push, no PR,
no other branches.

## Final message

A short report: ids done, tools covered, utterances added, and any tool whose purpose
you could not tell from its snapshot.
