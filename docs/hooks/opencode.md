# OpenCode — tools only

> **Which clients have hooks, and how:** the dated [compatibility matrix](../../README.md#compatibility-matrix) in the README, one row per client: its hook events, the documentation checked, its mode, and whether capture there is verified live or documented only.

> **Status: tools only.** OpenCode offers no shell hooks, so treecontext
> captures nothing of an OpenCode session: only what the agent inserts is
> kept. The plugin scaffolding earlier builds carried
> (`src/hooks/opencode/plugin.ts`) was never run against a live OpenCode
> session and left the build in 0.1.0-beta.4 with the
> `--experimental-capture` flag (D406).

`treecontext doctor` says this on its OpenCode row: the client offers no
shell hooks, so the tools are its whole surface; state, MCP tools only;
remedy, nothing to do (D161).

What works today on opencode: the **MCP tools**. `treecontext install`
registers the treecontext MCP server in opencode's config, and the
agent gets the full toolset (`treecontext_query`, `_insert`, `_status`,
…) — see README §3 and §6.

Capture on OpenCode would need a plugin written against its plugin
interface and a recording of a live session to hold it to
(`docs/hooks/adding-a-platform.md`). If you want it, say so at
[bingh0/treecontext-mcp/issues](https://github.com/bingh0/treecontext-mcp/issues).
