# GitHub Copilot (VS Code) Hooks — experimental capture

> **Which clients have hooks, and how:** the dated [compatibility matrix](../../README.md#compatibility-matrix) in the README, one row per client: its hook events, the documentation checked, its mode, and whether capture there is verified live or documented only.

> **Status: charter-aligned, awaiting a live verification pass.** The
> adapter (`src/hooks/vscode/`) was rewritten to delegate to the
> reference Claude Code hooks, so capture semantics cannot drift, and it
> is exercised against Copilot's *documented* payload shapes
> (`tests/hooks/copilot-adapter.test.ts`) — but it has **not** been run
> against a live Copilot session, which is what verification requires
> (`src/hooks/README.md`). MCP tools work regardless; capture is opt-in.

## Two routes, and what doctor says about them

VS Code (Copilot agent mode) can run hooks two ways. Its documented
route reads the **Claude settings file as-is** — the Claude Code hooks
block `treecontext install` writes into `~/.claude/settings.json` — when
its `chat.useClaudeHooks` setting is on. That setting is **off by
default**, and treecontext writes nothing into VS Code for this route:
turning it on is yours to do. The adapter below is the second route, and
it is no longer installed (D226): VS Code reads the Claude settings file,
so `install --agent vscode --experimental-capture` writes nothing and says
so in one line. A copy an earlier build wrote in
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

## The adapter (in source, not installed)

What follows describes the adapter as earlier builds installed it, kept
for whoever runs the live verification pass by hand. The installer no
longer writes it, with or without the flag.

Earlier builds, with the flag, wrote **`~/.copilot/hooks/treecontext.json`**
(user-level, all platforms — see `src/server/agents.ts`). The generated
config looks like this (`buildVscodeHooksConfig`,
`src/server/installer.ts`):

```json
{
  "version": 1,
  "hooks": {
    "sessionStart":        [{ "type": "command", "bash": "…", "powershell": "…", "timeoutSec": 10 }],
    "userPromptSubmitted": [{ "type": "command", "bash": "…", "powershell": "…", "timeoutSec": 10 }],
    "postToolUse":         [{ "type": "command", "bash": "…", "powershell": "…", "timeoutSec": 10 }],
    "agentStop":           [{ "type": "command", "bash": "…", "powershell": "…", "timeoutSec": 10 }],
    "preCompact":          [{ "type": "command", "bash": "…", "powershell": "…", "timeoutSec": 10 }]
  }
}
```

Three details are load-bearing (a previous version of this adapter got
all three wrong): `version: 1` is required or the file is silently
ignored; the timeout key is `timeoutSec`, not `timeout`; and the
command is given as separate `bash` and `powershell` fields, not a
single `command` string. The commands point at the installed adapter
entry points, `…/dist/hooks/vscode/<event>.js` (installed package:
`node_modules/treecontext-mcp/dist/hooks/vscode/`; release candidates
before 0.1.0-beta.1 installed under the legacy `node_modules/treecontext`).

## What the adapter does

Each entry point normalizes Copilot's payload shape (camelCase fields,
`agentStop`'s response location) and then calls the corresponding
reference hook from `src/hooks/` — capture semantics, priorities, and
the no-filtering charter are the reference implementation's, not a
copy. `agentStop` is what gives Copilot assistant-turn capture.

## Verifying — and reporting

After a few Copilot agent-mode turns, check the node count grows
(README §4), or inspect staging directly:

```bash
sqlite3 ~/.treecontext/stores/<store>/treecontext.db \
  "SELECT COUNT(*) AS total, SUM(processed=0) AS pending FROM staging;"
```

**Please report either outcome** — working or not — at
[bingh0/treecontext-mcp/issues](https://github.com/bingh0/treecontext-mcp/issues).
A live-session report is exactly what promotes this adapter to
verified. If capture doesn't work, nothing else breaks: MCP tools keep
working, and `treecontext uninstall` removes the hook file.
