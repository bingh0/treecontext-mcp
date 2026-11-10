# Recorded Claude Code hook events

Each directory is named for the Claude Code version its files were recorded
from. Each `.ndjson` file is one real headless session (`claude -p`): every
hook event the client fired, one JSON payload per line, in the order the
client fired them, exactly as the client wrote it to a hook's stdin. A dump
hook was registered on every event name; nothing here was written by hand.

The only edits are substitutions made after recording, so no machine,
account or person is committed: the probe's working directory reads
`/probe/work`, the home directory `/home/dev` (and the account name `dev`
wherever a command printed it), and the one email address the
client's own compaction summary quoted reads `user@example.com`. Free text the
model wrote (a compaction summary, a final message) is read before it is
committed, and `npm run release-scan` is run over it: a path scrub alone
missed that address. Session ids, prompt ids, agent ids and
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

`manual-compaction.ndjson` (model: haiku), two runs of one session: a first
run with one Bash call, then `claude -p '/compact' --resume <session>`:

| Step | Events the client fired, in order |
| --- | --- |
| First run | SessionStart (`source` startup), UserPromptSubmit, PreToolUse, PostToolUse, PostToolBatch, Stop, SessionEnd |
| The resumed run compacting | SessionStart (`source` resume), PreCompact (`trigger` manual), SessionStart (`source` compact), PostCompact (carrying `compact_summary`), SessionEnd |

All under the one session id. No UserPromptSubmit and no Stop fired for the
`/compact` run.

`repo-reading-and-long-output.ndjson` (model: haiku), one call per turn:

| Call | What it shows |
| --- | --- |
| Bash `ls -la`, Glob `src/*.ts`, Grep `retentionSweep`, Read `README.md`, Bash `echo building && echo built` | the ordinary repo-reading calls of a working session, each PreToolUse, PostToolUse, PostToolBatch; Glob, Grep and Read hand their result over as an object, not a string (this client has no `LS` tool) |
| Bash `seq 1 30000; exit 3` (fails after 168,894 bytes of output) | PostToolUseFailure's `error` is 10,040 characters: the client keeps the head and the tail of the first 30,000 characters and cuts the middle (`... [20012 characters truncated] ...`); nothing in the payload points to the rest |
| Bash `seq 1 30000` (succeeds, same output) | PostToolUse's `tool_response.stdout` is the first 30,000 characters; `persistedOutputPath` and `persistedOutputSize` name the file under the client's project directory where it kept all 168,894 bytes; PostToolBatch's account of the call is a 2 KB preview naming that file |

So a hook never receives more than 30,000 characters of a shell command's
output from this client, and no more than about 10,000 of a failed one's.

What these sessions do not hold: a developer's interrupt (`is_interrupt`
true), an interactive denial, an auto-mode classifier denial
(`PermissionDenied`), and a compaction the client starts by itself
(`trigger` auto).

## 2.1.321 (recorded 2026-11-09, Linux)

`success-reading-like-trouble.ndjson` (model: haiku), one call per turn,
for D404: calls that succeeded whose output reads like trouble. The run
loaded only the probe's own settings (`--setting-sources project` with the
dump hooks in `--settings`) and only the probe's MCP server
(`--strict-mcp-config`), a stdio server whose one tool, `seen`, succeeds
answering the text `failed call seen`; the tools were allowed with
`--allowedTools`, so no call waited on a permission.

| Call | Events the client fired for it |
| --- | --- |
| Bash `printf "error: 0 found, 0 failed\n"` (succeeds) | PreToolUse, PostToolUse, PostToolBatch |
| Bash `echo "warning: deprecated"` (succeeds) | PreToolUse, PostToolUse, PostToolBatch |
| ToolSearch for the probe's tool (succeeds) | PreToolUse, PostToolUse, PostToolBatch |
| MCP tool `mcp__probe__seen` answering `failed call seen` (succeeds) | PreToolUse, PostToolUse, PostToolBatch |
| Read `traceback.txt`, a file holding a Python traceback (succeeds) | PreToolUse, PostToolUse, PostToolBatch |

Each arrived by `PostToolUse`, never `PostToolUseFailure`, whatever its
output says. The session also fired `MessageDisplay` once, for its final
message (`done`), before `Stop` and `SessionEnd`. The traceback file was
written for the probe; its paths read `/probe/work` like the rest.
