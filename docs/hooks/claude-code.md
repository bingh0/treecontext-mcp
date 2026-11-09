# Claude Code Hooks (Layers 2 + 3)

> **Which clients have hooks, and how:** the dated [compatibility matrix](../../README.md#compatibility-matrix) in the README, one row per client: its hook events, the documentation checked, its mode, and whether capture there is verified live or documented only.

Claude Code is the **verified reference platform** — the only platform
whose capture adapter has passed a live-payload verification pass
(`CAPTURE_PLATFORMS` in `src/server/installer.ts`). Nine hook events
are installed (`applyClaudeHookBlock`, `src/server/installer.ts`):

| Event | Matcher | Scripts run |
|---|---|---|
| `SessionStart` | `startup`, `resume`, `clear`, `compact` (one entry each) | `tc-session-reminder`, then `tc-session-start` |
| `PreCompact` | none | `tc-pre-compact` |
| `PostToolUse` | none | `tc-post-tool-use` |
| `PostToolUseFailure` | none | `tc-post-tool-use` |
| `PostToolBatch` | none | `tc-post-tool-use` |
| `UserPromptSubmit` | none | `tc-user-prompt-submit` |
| `Stop` | none | `tc-stop` |
| `SubagentStart` | none | `tc-subagent-start` |
| `SubagentStop` | none | `tc-subagent-stop` |

Eight wrapper scripts back them (`CLAUDE_HOOK_SCRIPTS`): seven
dispatchers plus the static `tc-session-reminder`; `tc-post-tool-use`
serves the three tool events, by the payload's `hook_event_name`.

**Existing installs must re-run `treecontext install`** to receive
`SubagentStart`, `SubagentStop` and the `clear`/`resume` wiring of
`session-start`. Installs from before 0.1.0-beta.1 wired `session-start`
on `startup` and `compact` only and had no subagent hooks; until they
reinstall, a /clear gets no re-orientation packet and no subagent is
registered. `treecontext doctor` says so: "hooks incomplete (missing:
subagent-start, subagent-stop)" while those scripts are absent, and a
"re-orientation hooks" warning naming the unwired matchers, both with
the fix `treecontext install`. Installs from before beta.4 have no
`PostToolUseFailure` or `PostToolBatch`; doctor's "capture events" row
names each event an install's settings lack and what is not journaled
without it, with the fix `treecontext install --force --agent claude`.

## Setup

```bash
treecontext install
```

That is the whole setup. The installer (`src/server/installer.ts`):

- writes wrapper scripts to `~/.claude/hooks/tc-*` (`.cmd` on Windows)
  that prefer the interpreter `install` verified (one proven to meet the
  Node floor and run this package), falling back to runtime resolution (PATH → nvm/fnm → the
  install-time interpreter) if that one ever disappears, and dispatch
  `treecontext hook <event>`;
- registers all nine events in `~/.claude/settings.json`, merging with
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
  Bash = 2, others = 3. On the Agent tool's result, when the subagent it
  spawned was a leg, it adds one line beside the result as
  `additionalContext`: the leg's return, its summary row with writer, run
  and key (D284, D285, D330). A background launch (`status:
  "async_launched"`) carries no pointer: its return is the platform's
  task notification (D369). It serves two more events (D400, D401):
  Claude Code fires `PostToolUse` only for a call that succeeded. A call
  that fails (non-zero exit, timeout, a tool's error, an MCP tool's
  `isError` or protocol error) fires `PostToolUseFailure`, captured the
  same way with the client's `error` text as the Output section and
  marked `outcome` `failed` (`interrupted` when `is_interrupt` is true).
  A call the client resolves without running (input rejected, permission
  denied, blocked by a PreToolUse hook) fires no event of its own; the
  batch's account, `PostToolBatch`, lists every call of the batch after
  their own hooks have finished, and the hook stages each call this
  session has not already staged, told by `tool_use_id`, with the
  client's `tool_response` as its Output and marked `captured_from`
  `batch`. Every captured call carries `tool_use_id`. On a store below
  schema 034 a failure stages unmarked and the batch adds nothing. The
  live payloads are recorded under `tests/fixtures/claude-code-hooks/`.
- **`stop`** — captures the assistant's final response of the turn: the
  payload's `last_assistant_message`, and only for a payload without it
  the last assistant text block of `transcript_path`
  (`src/hooks/stop.ts`, D249). Duplicate fires are deduped. Its second duty,
  after the capture: when the session's newest checkpoint (chapter
  summary or bookmark) or the previous ask is older than the store's
  checkpoint interval (default 20 rounds or 45 minutes, whichever comes
  first, `DEFAULT_CHECKPOINT_INTERVAL` in `src/checkpoints.ts`; set per
  store with `treecontext config checkpoint-interval "<value>"`), it
  answers `decision: "block"` once and asks the agent for a one-line
  bookmark (`metadata.kind = "bookmark"`). It never asks when
  `stop_hook_active` is set, records each ask so it does not ask twice
  in one interval, and when the store cannot take the write it reports
  that once per session in a `systemMessage` and lets the agent stop. A
  `claude -p` worker's session is never asked for a bookmark: its stop is
  its leg's, sent back once (`decision: "block"`) when it owes its key's
  checkpoint (D295).

### Subagents

- **`subagent-start`** — registers the subagent (`agent_id`,
  `agent_type`) in the store's `session_registry` under the parent's
  session id, inheriting where the session runs. With no brief in effect
  for its role that is all, and it emits nothing. With one, it is the
  hooks door (D284, D305): the subagent becomes a leg of that brief's run
  and key, its run is opened, and its first moment (the brief, the
  checkpoint(s) in effect, treecontext's own lines) is written as the
  first row of its lane and emitted as `additionalContext`, cut at the
  client's 10,000-character cap.
- **`subagent-stop`** — takes the subagent's report from where the client
  put it (D371): the `message` of the newest `SubagentHandback` call in
  `agent_transcript_path` when it made one, else the payload's
  `last_assistant_message`, else the last assistant text of that
  transcript. It stages the report as an assistant row of kind
  `subagent-summary`, stamped with the subagent as its writer, then
  retires the registration. A leg that owes its key's checkpoint is
  instead sent back once (`decision: "block"`); otherwise its report is
  written as the leg's summary row, stamped with run and key, and the
  leg retired.

The hooks door writes a leg's own rows directly, through the library
(`src/hooks/hook-store.ts`), in one transaction with the registration;
what it cannot write goes to the gap ledger (D314).
[src/hooks/README.md](../../src/hooks/README.md) has the full rules.

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
  `additionalContext` (`src/hooks/session-start.ts`). A leg left live is
  retired as `cut` (D328). A `claude -p` child holding a worker's ticket
  (`TREECONTEXT_TICKET`) is a worker, never a self: no beacon, no self
  row, no packet (D295). The static
  orientation reminder (`tc-session-reminder`) runs before it on all
  four matchers.

## Source-based rehydration

`SessionStart` receives a `source` field; each source gets a budget
(`SOURCE_BUDGETS`, `src/hooks/shared.ts`):

| Source | Budget | Content |
|---|---|---|
| `startup` | 5000 chars | Snapshot claim from a prior session of the same lane + recent staging activity |
| `clear` | 3000 chars (`PACKET_BUDGET_CHARS`) | The re-orientation packet (below), not the rehydration payload |
| `compact` | 2000 chars | Preserves the active thread the compaction summary may have collapsed |
| `resume` | 500 chars | Pointer only — snapshot ID and a nudge to call `treecontext_query` |
| unknown | 3000 chars | Continuation — recent messages and tool activity |

A fresh session claims a recovery snapshot only when the session that
left it ran in the same lane (the main checkout, or the same worktree);
a snapshot left by another lane is left for that lane, and one whose
session the registry does not hold is claimed by no one (D375).

On a fresh start (any source but `clear`), in a linked git worktree or
the main checkout alike, the payload opens with the lane's own lines
(`selfLines`, `src/checkpoints.ts`; D373): where the session runs; the
lane's newest live chapter summary (or, with none, its live bookmark),
whatever session wrote it; the newest entry whose `brief_for` names the
worktree (or `main`); and the other lanes holding live pointers, counted
and at most three named, never their text. A row's lane is the
registry's placement of its session first, the `_writer` stamp only
where the session is unplaced (D379). When those lines are shown, the
payload no longer ends with the "No prior context available" fallback.

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
