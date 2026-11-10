# Recorded Codex CLI hook events

Each directory is named for the Codex CLI version its files were recorded
from. Each `.ndjson` file is one recorded set: every hook event the client
fired, one JSON payload per line, in the order the client fired them,
exactly as the client wrote it to a hook's stdin. A dump hook was registered
in `~/.codex/hooks.json` on every event name, trusted by the developer with
`/hooks` in Codex (never with the flag that bypasses hook trust, D409); it
wrote each payload to a file and printed nothing, so no turn was changed by
it. Nothing here was written by hand.

The only edits are substitutions made after recording, done on the raw text
of each payload so that the rest of the line is byte for byte what the
client sent (field names, their order, types and every id are the
client's):

| Recorded | Committed |
| --- | --- |
| the probe project's directory (a scratch directory under the recording machine's temporary directory) | `/probe/work` |
| the recording account's home directory | `/home/dev` (so a transcript path reads `/home/dev/.codex/sessions/...`, and the interactive set's directory `/home/dev/Downloads`) |
| the repository checkout another Codex session ran in (`other-session`) | `/home/dev/project` |
| the store names treecontext derived from those directories, quoted in two status replies | `Downloads-5e1f04` and `work-7c1e05`, the same shape (a name and six hex digits) |
| the encrypted message of Codex's spawn tool (`collaborationspawn_agent`'s `tool_input.message`, an opaque blob only the model's provider can read) | a same-length placeholder that keeps the blob's `gAAAAAB` head and its `==` padding |

Session ids, turn ids, agent ids, tool-call ids and treecontext node ids are
the client's and the store's own. Free text was read before it was
committed: the prompts (the probe's, and in the interactive set the
developer's own short questions, kept as typed), every tool output (the
status replies, the shell outputs, the web search tool's pages, which are
the National Archives' public transcription of the U.S. Constitution and
its search results), and every assistant message; then `npm run
release-scan` was run over it.

These files are the ground truth for any charter step that says an event is
"as Codex sends it" or "the events Codex CLI sent, as recorded" (D402, D409).
A binding replays them through the hooks install writes for Codex
(`replayRecordedSession` in tests/journal/standins.ts); it never edits a
payload's shape. When a scenario needs a payload these files do not hold,
record a new session; do not write one.

## 0.167.0 (recorded 2026-11-09, Linux)

The hooks ran outside Codex's sandbox (their process 1 was the machine's
init, their parent `codex`); their environment named
`CODEX_MANAGED_PACKAGE_ROOT` and `CODEX_MANAGED_BY_NPM`, and in the
`worker` set also `TREECONTEXT_TICKET` and `TREECONTEXT_WORKER_SESSION`. No
hook's environment carried a Codex session id. The headless sets ran
`codex exec` (`permission_mode` `bypassPermissions`, the sandbox read-only),
the interactive set Codex's own interface (`permission_mode` `default`).

`headless-session.ndjson` (`codex exec`), one prompt asking for six steps in
order:

| Call | Events the client fired for it |
| --- | --- |
| Bash `head -c 13 notes.txt` (succeeds) | PreToolUse, PostToolUse (`tool_response` the plain string printed) |
| Bash `ls /no-such-path-fixture` (exits 2) | PreToolUse, PostToolUse, its `tool_response` the error text, no exit code |
| Bash `touch /etc/tc-fixture-probe` (refused by the read-only sandbox) | PreToolUse, PostToolUse, `tool_response` "Read-only file system" |
| `mcp__treecontext__treecontext_insert` (succeeds) | PreToolUse, PostToolUse (`{content:[{type:"text",text}]}`) |
| `mcp__treecontext__treecontext_query` (succeeds) | PreToolUse, PostToolUse |
| `mcp__treecontext__treecontext_export` of a missing node (an error reply) | PreToolUse only, no PostToolUse |

Then Stop (`last_assistant_message`) and SessionEnd (`reason` `other`). The
store the calls reached was a recording store; its node ids are quoted in
the replies.

`file-edit.ndjson` (`codex exec`): the treecontext status and query calls of
the session-start routine (each PreToolUse, PostToolUse), then an
`apply_patch` whose context did not match the file: PreToolUse only, no
PostToolUse. The model stopped after that failure, so the prompt's second
edit was never attempted. Then Stop and SessionEnd.

`file-edit-ok.ndjson` (`codex exec`): one `apply_patch` adding a file, which
succeeded: PreToolUse and PostToolUse (`tool_response` "Exit code: 0 ...
Success."), then Stop and SessionEnd.

`subagent.ndjson` (`codex exec`): the main thread spawns one subagent
(`collaborationspawn_agent`, PreToolUse and PostToolUse), the subagent
starts (SubagentStart, `agent_id`, `agent_type` "default", `session_id` the
main's, `transcript_path` the subagent's own), the main waits
(`collaborationwait_agent` PreToolUse), the subagent runs a shell command
(PreToolUse and PostToolUse, each carrying `agent_id` and `agent_type`) and
stops (SubagentStop, `agent_transcript_path` and `last_assistant_message`),
the wait returns (PostToolUse), and the main's turn ends (Stop, SessionEnd).

`worker.ndjson`: a `codex exec` started by `treecontext run` (run `fx-run`,
key `fx-key`, role `fixture-worker`), so its first prompt is the ticket
door's first message: SessionStart, UserPromptSubmit, a shell command and a
`treecontext_insert` of a checkpoint (each PreToolUse and PostToolUse),
Stop, SessionEnd. Every hook's environment held the ticket and the
worker's lane.

`interactive.ndjson`: one session in Codex's own interface, one Codex
session id throughout:

| Step | Events, in order |
| --- | --- |
| Start, a turn calling treecontext status and query and a shell `pwd` | SessionStart (`source` startup), UserPromptSubmit, three PreToolUse/PostToolUse pairs, Stop |
| A turn with no tool call | UserPromptSubmit, Stop |
| A turn of two web tool calls (`webrun`), interrupted by Esc | UserPromptSubmit, two PreToolUse/PostToolUse pairs, Interrupt (no Stop; the partial reply is in no payload) |
| `/compact` | PreCompact (`trigger` manual), PostCompact (`trigger` manual, no summary), SessionStart (`source` compact) |
| Two turns, then quit | UserPromptSubmit, Stop, UserPromptSubmit, Stop, SessionEnd |
| `codex resume` of the same session, one turn, quit | SessionStart (`source` resume, the same `session_id`), UserPromptSubmit, Stop, then two SessionEnd: the first for another session id that fired in between, the second this session's |

`other-session.ndjson`: one SessionEnd for a Codex session the recording did
not start (another Codex on the same machine), which the dump hook received
while it was installed. Codex's SessionEnd is not wired (events.json).

What these sets do not hold: a call the developer denied at an approval
prompt, a compaction Codex starts by itself (`trigger` auto), a session
continued after `/clear`, and a subagent spawned from Codex's interactive
interface.

## Rollouts: Codex's own transcripts (0.167.0, recorded 2026-11-09)

`0.167.0/rollouts/` holds the transcript Codex itself wrote for two of the
sets above (`~/.codex/sessions/.../rollout-*.jsonl`), for the capture
census over a Codex session (D409): `headless-session.rollout.jsonl` (six
calls, every one made through Codex's code mode, a script that calls
tools) and `subagent.rollout.jsonl` (`spawn_agent` and `wait_agent`, called
directly). No recorded session holds both kinds, so the census scenario
reads both.

They are redacted with the same substitutions as the events (the probe
project's directory to `/probe/work`, the recording account's home to
`/home/dev`, the spawn tool's encrypted message to the same placeholder the
`subagent` set carries), and reduced to the lines a census reads, each kept
line otherwise byte for byte as Codex wrote it:

| Kept | Dropped, and why |
| --- | --- |
| `session_meta`, with only `id`, `session_id`, `timestamp`, `cwd`, `originator`, `cli_version` and `source` | its other fields: the account's identifiers (`creator_user_id`, `creator_account_id`), Codex's own base instructions and workspace roots |
| `response_item` `custom_tool_call`, `custom_tool_call_output`, `function_call`, `function_call_output` | `response_item` `message` (the developer and permission messages Codex sends the model), `additional_tools`, `reasoning` (encrypted) and `agent_message` |
| `event_msg` `item_completed`, every item but a reasoning item | `task_started`, `task_complete`, `thread_settings_applied`, `token_count` (rate limits), `world_state`, `turn_context`, `token_usage_record`, `inter_agent_communication_metadata` |

Every kept line was read before it was committed: the probe's prompts, the
code-mode scripts, the tool listings the scripts printed (treecontext's own
tool descriptions), the shell outputs, the treecontext replies and the final
answers; then `npm run release-scan` was run over them. The completed-call
records (`item_completed`) carry the ids the hooks carry (`exec-<uuid>`) for
five of the headless set's six calls; the sandbox-refused `touch` has none,
which is the call the census infers.
