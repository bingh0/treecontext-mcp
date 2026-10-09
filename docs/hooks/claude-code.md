# Claude Code Hooks (Layers 2 + 3)

> **Which clients have hooks, and how:** the dated [compatibility matrix](../../README.md#compatibility-matrix) in the README, one row per client: its hook events, the documentation checked, its mode, and whether capture there is verified live or documented only.

Claude Code is the **verified reference platform** — the only platform
whose capture adapter has passed a live-payload verification pass
(`CAPTURE_PLATFORMS` in `src/server/installer.ts`). Seven hook events
are installed (`applyClaudeHookBlock`, `src/server/installer.ts`):

| Event | Matcher | Scripts run |
|---|---|---|
| `SessionStart` | `startup`, `resume`, `clear`, `compact` (one entry each) | `tc-session-reminder`, then `tc-session-start` |
| `PreCompact` | none | `tc-pre-compact` |
| `PostToolUse` | none | `tc-post-tool-use` |
| `UserPromptSubmit` | none | `tc-user-prompt-submit` |
| `Stop` | none | `tc-stop` |
| `SubagentStart` | none | `tc-subagent-start` |
| `SubagentStop` | none | `tc-subagent-stop` |

Eight wrapper scripts back them (`CLAUDE_HOOK_SCRIPTS`): the seven
dispatcher events plus the static `tc-session-reminder`.

**Existing installs must re-run `treecontext install`** to receive
`SubagentStart`, `SubagentStop` and the `clear`/`resume` wiring of
`session-start`. Installs from before 0.1.0-beta.1 wired `session-start`
on `startup` and `compact` only and had no subagent hooks; until they
reinstall, a /clear gets no re-orientation packet and no subagent is
registered. `treecontext doctor` says so: "hooks incomplete (missing:
subagent-start, subagent-stop)" while those scripts are absent, and a
"re-orientation hooks" warning naming the unwired matchers, both with
the fix `treecontext install`.

## Setup

```bash
treecontext install
```

That is the whole setup. The installer (`src/server/installer.ts`):

- writes wrapper scripts to `~/.claude/hooks/tc-*` (`.cmd` on Windows)
  that prefer an interpreter `install` verified can load the native
  binding, falling back to runtime resolution (PATH → nvm/fnm → the
  install-time interpreter) if that one ever disappears, and dispatch
  `treecontext hook <event>`;
- registers all seven events in `~/.claude/settings.json`, merging with
  your existing hooks rather than overwriting them (treecontext's own
  entries are rewritten to this build's form; yours are kept);
- registers the MCP server in `~/.claude.json` — the file Claude Code
  reads for user-scope servers, or `$CLAUDE_CONFIG_DIR/.claude.json` when a
  launcher relocates the config directory — with
  `serve --transport stdio --capture` (plus `--lexical` by default).

Restart Claude Code afterwards — hooks and MCP servers are read at
startup. Re-running `treecontext install` is idempotent and refreshes
stale paths (e.g. after a Node version switch).

If you are running from a checkout and want to wire a hook manually,
the built entry points are `dist/hooks/<name>.js` at the repository
root (installed package: `node_modules/treecontext-mcp/dist/hooks/<name>.js`;
the package was published as `treecontext-mcp` at 0.1.0-beta.1, and
every release candidate before it installed as `node_modules/treecontext`).
The installer-generated wrappers are still the recommended path — they
handle `node` resolution that a bare command string cannot. Each wrapper
runs the CLI path `install` baked in; if that file is gone (a version
manager upgrade deletes it), its fallback searches the global
`node_modules` layouts (`/opt/homebrew/lib` and `/usr/local/lib`, every
nvm and fnm node version, and on Windows `%APPDATA%\npm` and
`%ProgramFiles%\nodejs`) under
`node_modules/treecontext-mcp` first and then the legacy
`node_modules/treecontext`, preferring the current name wherever both
are found (`PACKAGE_DIRS`, `posixModuleGlobs`).

## What each hook does

### Layer 2 — journaling (see [journaling.md](journaling.md))

- **`user-prompt-submit`** — captures every user prompt in full into the
  staging table, and refreshes the pid-keyed session beacon.
- **`post-tool-use`** — captures **every** tool call (no tool is ever
  skipped — the capture charter forbids it). Repo-reading tools keep a
  bounded output preview; execution/external tools keep full input and
  output up to the safety cap. Priorities: Edit/Write/NotebookEdit = 1,
  Bash = 2, others = 3.
- **`stop`** — captures the assistant's final response of the turn by
  reading the last assistant text block from `transcript_path`
  (`src/hooks/stop.ts`). Duplicate fires are deduped. Its second duty,
  after the capture: when the session's newest checkpoint (chapter
  summary or bookmark) or the previous ask is older than the store's
  checkpoint interval (default 20 rounds or 45 minutes, whichever comes
  first, `DEFAULT_CHECKPOINT_INTERVAL` in `src/checkpoints.ts`; set per
  store with `treecontext config checkpoint-interval "<value>"`), it
  answers `decision: "block"` once and asks the agent for a one-line
  bookmark (`metadata.kind = "bookmark"`). It never asks when
  `stop_hook_active` is set, records each ask so it does not ask twice
  in one interval, and when the store cannot take the write it reports
  that once per session in a `systemMessage` and lets the agent stop.

### Subagents

- **`subagent-start`** — registers the subagent (`agent_id`,
  `agent_type`) in the store's `session_registry` under the parent's
  session id, inheriting where the session runs. Emits nothing.
- **`subagent-stop`** — stages the subagent's `last_assistant_message`
  (or, absent that, the last assistant text of `agent_transcript_path`)
  as an assistant row of kind `subagent-summary`, stamped with the
  subagent as its writer, then retires the registration.

The server reads that registry to stamp the writer of every row written
through the tools; `post-tool-use` also stages the payload's `agent_id`
and `agent_type`, so a subagent's captured tool calls drain stamped with
its role. See ARCHITECTURE.md §8.

### Layer 3 — compaction lifecycle

- **`pre-compact`** — fires on context pressure (auto) or `/compact`
  (manual). Silently writes a snapshot of recovery queries to the store
  (`src/hooks/pre-compact.ts`). No stdout — compaction proceeds and
  `SessionStart` handles recovery.
- **`session-start`** — fires on every start: `startup`, `resume`,
  `clear` and `compact`. On a `clear` it first reads the predecessor
  session id from the pid beacon (a /clear mints a new session id), then
  rewrites the beacon. It registers the session's self (worktree,
  branch, directory, as git reports them) in `session_registry`, and on
  every source but `compact` retires any subagent still registered live
  under the session (and, on a clear, under its predecessor). It emits a
  `systemMessage` naming the store it journals into (or that the session
  is not being journaled, and why) and a source-appropriate payload as
  `additionalContext` (`src/hooks/session-start.ts`). The static
  orientation reminder (`tc-session-reminder`) runs before it on all
  four matchers.

## Source-based rehydration

`SessionStart` receives a `source` field; each source gets a budget
(`SOURCE_BUDGETS`, `src/hooks/shared.ts`):

| Source | Budget | Content |
|---|---|---|
| `startup` | 5000 chars | Snapshot claim from a prior session + recent staging activity |
| `clear` | 3000 chars (`PACKET_BUDGET_CHARS`) | The re-orientation packet (below), not the rehydration payload |
| `compact` | 2000 chars | Preserves the active thread the compaction summary may have collapsed |
| `resume` | 500 chars | Pointer only — snapshot ID and a nudge to call `treecontext_query` |
| unknown | 3000 chars | Continuation — recent messages and tool activity |

On a fresh start (any source but `clear`) in a linked git worktree, the
payload opens with the worktree's own lines (`worktreeSelfLines`,
`src/checkpoints.ts`): its newest live chapter summary written in that
worktree's lane (`_writer` `worktree:<name>`), whatever its session id,
and the newest entry whose `brief_for` names the worktree.

### The /clear packet

On `clear` the hook records the link to the predecessor session in the
store (`session_chain:<id>` in `store_config`) and walks the chain of ids
linked through clears. It emits one packet (`buildClearPacket`,
`src/checkpoints.ts`) of at most 3000 characters, in this order: the
newest live chapter summary with its age and its "referenced by" line;
the newest live bookmark with its age, the entries between it and the
chapter, and its "referenced by" line; the developer's newest five turns
since the newer checkpoint (`PACKET_TURNS`), each cut to its first line
with its length, and the omitted count; one line per handoff (at most
two, "Handoff claimed from <sender>"); and the one-line reminder of how
to leave a chapter summary, or, for a session with no chapter, a nudge
shown once per local day. Rows stamped as a subagent's
(`_writer_agent_id` present) never stand in for the session's own
checkpoints. When no beacon named the predecessor the packet says so
rather than claiming no checkpoint exists. A clear's store reads are
bounded by `CLEAR_READ_TIMEOUT_MS` (1500 ms): a store locked by another
process costs at most that, and the packet says what it could not
read.

## Why not block compaction?

`decision: "block"` on PreCompact causes hard failures: PreCompact can
fire *reactively* (after the API already returned a context-limit
error), where blocking surfaces the error and fails the request.
Built-in compaction is the safety net; treecontext lets it proceed and
recovers via `SessionStart` rehydration.

## Verifying the setup

Start a fresh session, do a few turns of work, and ask the agent to run
`treecontext_status` — the node count should grow (README §4).
`treecontext doctor` grades the installed scripts, the commands in
`~/.claude/settings.json`, and the `clear`/`resume` wiring. Hook
stderr is suppressed in normal operation; `treecontext doctor
--dump-logs` prints recent hook activity, and `session-start` logs a
line like `[treecontext-hook] session-start: source=startup,
payload=1247 chars` when debug logging is enabled
(`TREECONTEXT_DEBUG=1`). The MCP server is the other way round (D258):
serving Claude Code, it writes its diagnostics to the log file under
`~/.treecontext/logs/` only, because Claude Code records every stderr
line a server writes as an error; a server line on stderr is a warning
or an error.
