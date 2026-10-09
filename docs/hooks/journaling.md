# Journaling Hooks (Layer 2)

> **Which clients have hooks, and how:** the dated [compatibility matrix](../../README.md#compatibility-matrix) in the README, one row per client: its hook events, the documentation checked, its mode, and whether capture there is verified live or documented only.

The journaling hooks passively capture conversation activity into the
`staging` table of the store's SQLite file. The MCP server, when running
with `--capture` (the installer's default configuration), drains staging
into the flat journal via its ingestion loop (`src/server/ingestion.ts`,
5-second poll). Source of truth for semantics: `src/hooks/README.md` and
the hook sources in `src/hooks/`.

## What the hooks do

| Hook | Event (Claude Code) | Captures |
|---|---|---|
| `user-prompt-submit` | `UserPromptSubmit` | User message text, in full → staging (priority 1). Also refreshes the pid-keyed session beacon. |
| `post-tool-use` | `PostToolUse` | Every tool call: name + input + output → staging (priority 1–3), with the payload's `agent_id`/`agent_type` when a subagent made the call |
| `stop` | `Stop` | The assistant's final response of the turn (`last_assistant_message`; only a payload without it falls back to the last assistant text of `transcript_path`, which at Stop time still ends at the previous turn) → staging (priority 2). May then ask once for a bookmark (see [claude-code.md](claude-code.md)) |
| `subagent-stop` | `SubagentStop` | The subagent's report (`last_assistant_message`, else the last assistant text of `agent_transcript_path`) → staging (priority 1) as kind `subagent-summary`, stamped with the subagent's agent fields |

`subagent-start` (`SubagentStart`) captures nothing: it registers the
subagent in the store's `session_registry`, which `subagent-stop`
retires. Both are Claude Code events; a platform without them still
captures, but registers no subagent.

**No invocation is ever filtered out.** This is the capture charter
(`src/hooks/README.md`, enforced by `tests/journal/`): read-only tools
are captured like every other tool. What differs is *fidelity*, not
presence (`src/hooks/post-tool-use.ts`):

- **Trail-class tools** (Read, Glob, Grep, LS, View, ListDir) keep a
  bounded preview of input (500 chars) and output (1000 chars). Their
  output is repo content at that moment, re-derivable from the working
  tree and git history.
- **Execution and external tools** (Bash, web, MCP, everything else)
  are historical facts: when the preview truncates, the *full* input
  and output are staged after the preview, up to a 256 KB per-row
  safety cap.

Priorities: Edit/Write/NotebookEdit = 1, Bash = 2, everything else = 3.

Dropped or failed events are not silent: ingestion writes explicit
`[capture gap]` tombstone entries (`src/server/ingestion.ts`).

## What gets indexed vs. stored

Constants in `src/persistence/capture-constants.ts`:

- User prompts and assistant prose are **indexed in full** by default.
- Tool events index up to **8000 chars** (preview plus tail) — measured
  (bench 2026-07-28) as statistically indistinguishable from full-text
  indexing at about a third of the query cost.
- The `TREECONTEXT_INDEX_CAP` environment variable (floor 300) caps the
  indexed view for **new** captures on slow machines. Stored text is
  unaffected; existing entries keep their view.

Hooks stamp the resolved boundaries (`index_len`, `preview_len`) into
each staging row so rows are self-describing; hooks never run schema
migrations themselves (`src/hooks/shared.ts`). On a store at schema v27
or later a row also carries the payload's `agent_id`, `agent_type` and a
row `kind`; on an older store the hook falls back to the earlier column
list and those fields are dropped. At the drain a row naming an agent is
stamped `_writer` (its role) with `_writer_src: "hook"`; a row naming
none is the session's own agent's.

## Data flow

```
Hook event (stdin JSON) → parseHookInput() → writeStaging() → staging table
                                                                  ↓
                                             MCP server --capture: IngestionLoop (5 s poll)
                                                                  ↓
                                                     flat journal (FTS5 BM25)
```

Hooks are fire-and-forget: one SQLite write, then exit 0. Every hook
exits 0 even on error, so a broken hook can never break the agent.
Duplicate captures (e.g. a re-fired Stop) are absorbed by the store's
content-fingerprint dedup within a 300 s window plus the Stop hook's
stale-recapture guard (`src/hooks/stop.ts`).

## Registration

Run `treecontext install`. It writes the wrapper scripts and hook
configuration for the verified platform (Claude Code) — see
[claude-code.md](claude-code.md). An install from before 0.1.0-beta.1
lacks `SubagentStart`, `SubagentStop` and the `clear`/`resume` wiring of
`session-start`: re-run `treecontext install` to receive them. Do not hand-edit hook config unless
you are developing; the installer is idempotent and merges with existing
settings.

## Not every platform has every event

User and tool capture stand alone: a platform with no turn-end signal
still journals user messages and tool events — its journal simply
carries no assistant-prose entries (`src/hooks/README.md`). Platform
adapter status (verified vs. unverified scaffolding) is tracked in
`src/hooks/README.md` and README §6.
