# GitHub Copilot (VS Code) Hooks — documented only

> **Which clients have hooks, and how:** the dated [compatibility matrix](../../README.md#compatibility-matrix) in the README, one row per client: its hook events, the documentation checked, its mode, and whether capture there is verified live or documented only.

> **Status: documented only.** VS Code can run the Claude Code hooks block
> itself, and treecontext writes nothing of its own into VS Code. Capture
> there has **not** been checked against a live Copilot session, so no row
> of the README or of doctor calls it verified. The MCP tools work
> regardless. The adapter earlier builds shipped (`src/hooks/vscode/`) left
> the build in 0.1.0-beta.4 with the `--experimental-capture` flag (D406).

## Two routes, and what doctor says about them

VS Code (Copilot agent mode) can run hooks two ways. Its documented
route reads the **Claude settings file as-is** — the Claude Code hooks
block `treecontext install` writes into `~/.claude/settings.json` — when
its `chat.useClaudeHooks` setting is on. That setting is **off by
default**, and treecontext writes nothing into VS Code for this route:
turning it on is yours to do. The second route was a hook file of
treecontext's own, which no build installs any more (D226) and whose
adapter is gone (D406). A copy an earlier build wrote in
`~/.copilot/hooks/treecontext.json` runs beside the Claude route; doctor
warns about it with the remedy `treecontext uninstall --agent vscode
--hooks-only`, which removes it and keeps the tools.

`treecontext doctor` prints one row for VS Code with its mode, the state
it found and the remedy (D161): it reads `chat.useClaudeHooks` from VS
Code's user `settings.json` (`~/.config/Code/User/settings.json` on Linux,
`~/Library/Application Support/Code/User/settings.json` on macOS,
`%APPDATA%\Code\User\settings.json` on Windows; comments and trailing
commas are fine), checks the Claude Code hooks block against the one this
build installs, and names the remedy — turn the setting on, or install the
block with `treecontext install --agent claude`. Capture through either
route stays documented-only; doctor never calls it verified.

## What a hook run through VS Code is taken for

The hooks VS Code runs are Claude Code's block, so each command ends in
`--client claude-code` and an event arriving through VS Code is read as
Claude Code's (D404): a call that arrives by `PostToolUse` is classed a
success and one that arrives by `PostToolUseFailure` an error. Whether VS
Code fires those events as Claude Code does is unrecorded; it needs a
recording of a live Copilot session before it is promised.

## Verifying — and reporting

After a few Copilot agent-mode turns with `chat.useClaudeHooks` on, check
that the node count grows (README §4), or inspect staging directly:

```bash
sqlite3 ~/.treecontext/stores/<store>/treecontext.db \
  "SELECT COUNT(*) AS total, SUM(processed=0) AS pending FROM staging;"
```

**Please report either outcome**, working or not, at
[bingh0/treecontext-mcp/issues](https://github.com/bingh0/treecontext-mcp/issues).
A live-session report is what moves VS Code's row from documented only to
verified. If capture does not work, nothing else breaks: the MCP tools
keep working.
