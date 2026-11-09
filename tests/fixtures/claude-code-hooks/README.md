# Recorded Claude Code hook events

Each directory is named for the Claude Code version its files were recorded
from. Each `.ndjson` file is one real headless session (`claude -p`): every
hook event the client fired, one JSON payload per line, in the order the
client fired them, exactly as the client wrote it to a hook's stdin. A dump
hook was registered on every event name; nothing here was written by hand.

The only edits are path substitutions made after recording, so no machine or
account name is committed: the probe's working directory reads `/probe/work`
and the home directory `/home/dev`. Session ids, prompt ids, agent ids and
tool-call ids are the client's own.

These files are the ground truth for any charter step that says an event is
"as Claude Code sent it" (D402). A binding replays them through the hooks
install wires; it never edits a payload's shape. When a scenario needs a
payload these files do not hold, record a new session; do not write one.

## 2.1.319 (recorded 2026-11-09, Linux)

`serial-failures-and-denials.ndjson` (model: haiku), one call per turn:

| Call | Events the client fired for it |
| --- | --- |
| Bash `echo probe-ok` (succeeds) | PreToolUse, PostToolUse, PostToolBatch |
| Bash `ls /nonexistent-probe-dir` (exit 2) | PreToolUse, PostToolUseFailure, PostToolBatch |
| Bash `sh -c "...; exit 7"` (stdout and stderr, exit 7) | PreToolUse, PostToolUseFailure, PostToolBatch |
| Read of a file that does not exist | PreToolUse, PostToolUseFailure, PostToolBatch |
| Read `seed.txt` (succeeds) | PreToolUse, PostToolUse, PostToolBatch |
| Edit whose string is not in the file (input rejected) | PostToolBatch only |
| Bash `sleep 20` with a 1.5 s timeout | PreToolUse, PostToolUseFailure, PostToolBatch |
| Write to `/etc` (permission denied, headless) | PreToolUse, PermissionRequest, PostToolBatch |
| WebFetch (permission denied, headless) | PreToolUse, PermissionRequest, PostToolBatch |

`parallel-batch-hook-block-mcp-errors-subagent.ndjson` (model: sonnet):

| Step | What it shows |
| --- | --- |
| One message, three parallel calls (Bash succeeds, Bash exits 2, Edit rejected) plus a ToolSearch | one PostToolBatch lists all four; the rejected Edit has no event of its own |
| Bash blocked by a PreToolUse hook (exit 2) | PreToolUse, then PostToolBatch only |
| MCP tool answering `isError` | PreToolUse, PostToolUseFailure, PostToolBatch |
| MCP tool answering a protocol error | PreToolUse, PostToolUseFailure, PostToolBatch |
| MCP tool succeeding | PreToolUse, PostToolUse, PostToolBatch |
| A foreground subagent: Bash exit 2, Bash succeeds, Write denied, Edit rejected | every event carries the subagent's `agent_id` and `agent_type`, PostToolBatch included |

In this session a second PostToolUse hook slept 3 s on the first parallel
call: the batch's PostToolBatch arrived 3 s later, after it. The settings
also registered an event name the client does not have; the client ignored
it and fired the rest.

What these sessions do not hold: a developer's interrupt (`is_interrupt`
true), an interactive denial, and an auto-mode classifier denial
(`PermissionDenied`).
