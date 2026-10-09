# opencode Plugin — unverified scaffolding

> **Which clients have hooks, and how:** the dated [compatibility matrix](../../README.md#compatibility-matrix) in the README, one row per client: its hook events, the documentation checked, its mode, and whether capture there is verified live or documented only.

> **Status: unverified.** The opencode adapter
> (`src/hooks/opencode/plugin.ts`) is a TypeScript plugin rather than
> shell hooks. It has never been run against a live opencode session,
> so it is not advertised as working capture, and `treecontext install`
> does not register it (`CAPTURE_PLATFORMS`, `src/server/installer.ts`
> — and there is no installer path for opencode's plugin format at all;
> it would have to be registered manually in opencode's config). See
> `src/hooks/README.md` for the verification bar and what a pass costs.

`treecontext doctor` says this on its OpenCode row: the client offers no
shell hooks, so the tools are its whole surface; state, MCP tools only;
remedy, nothing to do (D161).

What works today on opencode: the **MCP tools**. `treecontext install`
registers the treecontext MCP server in opencode's config, and the
agent gets the full toolset (`treecontext_query`, `_insert`, `_status`,
…) — see README §3 and §6. Only automatic capture is unproven.

If you want to attempt the plugin against a real opencode session (that
attempt is exactly what verification needs), build the repo and wire
`dist/hooks/opencode/plugin.js` into `.opencode/plugin/`, then check
whether staged rows actually appear (README §4). Please report the
outcome either way at
[bingh0/treecontext-mcp/issues](https://github.com/bingh0/treecontext-mcp/issues).
