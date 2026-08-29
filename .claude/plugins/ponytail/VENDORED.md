# Vendored: complete ponytail plugin

This is the **complete** `@dietrichgebert/ponytail` plugin (v4.8.4, MIT — see `LICENSE`),
vendored verbatim so it travels with this repo into cloud sessions. Source:
https://github.com/dietrichgebert/ponytail (via the Claude Code plugin marketplace).

## How it's wired here

- **`.claude/skills/ponytail*`** (a level up, at the repo's `.claude/skills/`) are the six
  skills copied out so Claude Code **auto-discovers** them — this is what makes `/ponytail`,
  `/ponytail-review`, `/ponytail-audit`, etc. work out of the box in a fresh clone.
- **This folder** is the full plugin: the skills plus everything else — the activation
  **hooks** (`hooks/`, incl. the SessionStart auto-activation), the **MCP server**
  (`ponytail-mcp/`), **commands/**, **docs/**, **benchmarks/**, **tests/**, and the
  integrations for other tools (Gemini/opencode/etc.).

## To get the full plugin behavior (auto-activation, MCP) in a session

Being present in the repo does **not** auto-register a plugin — Claude Code loads repo
`.claude/skills/` automatically, but hooks/MCP only fire once the plugin is enabled. To turn
on the always-active "ponytail mode" and the MCP in a session, register/enable this plugin
per its `README.md` (or add its `hooks/` SessionStart hook to the repo's `.claude/settings.json`).
If you register the plugin, you can delete the loose `.claude/skills/ponytail*` copies to
avoid duplicate skill definitions.

No paid API; runs fully local — burndown-safe.
