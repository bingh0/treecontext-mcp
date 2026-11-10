# Recorded Antigravity CLI hook events

Each directory is named for the Antigravity CLI (`agy`) version its files
were recorded from. Each `.ndjson` file is one recorded set: every hook event
the client fired, one line per event, in the order the client fired them.

agy's payloads carry no event name (a PreInvocation and a PostInvocation
payload have the same keys), so each line wraps the payload:

```json
{"event": "<the hook the client ran>", "transcript_lines": <n or null>, "payload": { ...exactly as agy wrote it to the hook's stdin... }}
```

- `event` is the event name the dump hook was registered under in
  `~/.gemini/config/hooks.json` (one named hook holding every event), read
  from the dump's own command line, never guessed from the payload.
- `transcript_lines` is how many lines agy's transcript of that conversation
  (`transcriptPath`, `transcript_full.jsonl`) held when the hook ran: the dump
  hook copied the transcript at every event. `null` where the file did not
  exist yet (a subagent's first events) or was not copied (the refusal set).
- `payload` is the client's text, byte for byte but for the substitutions
  below.

`transcripts/<conversationId>.jsonl` is each conversation's transcript as it
stood at its last recorded event. Every copy taken at an earlier event was a
prefix of it (checked over every set before committing), so the transcript
as it stood at any event is its first `transcript_lines` lines. A binding
replays a set by writing that prefix where `transcriptPath` points before
each event (`replayRecordedSession` in tests/journal/standins.ts).

A dump hook was registered on SessionStart, PreInvocation, PostInvocation,
Stop and PostToolUse (matcher `*`); it wrote each payload, the hook's process
facts and the names (never the values) of its agy and treecontext
environment variables, copied the transcript, and printed `{}`, deciding
nothing. PreToolUse was not hooked: its hook answers a permission question
(events.json). Nothing here was written by hand.

| Recorded | Committed |
| --- | --- |
| the repository checkout the headless sets ran in | `/probe/work` |
| the recording account's home directory | `/home/dev` (so a transcript path reads `/home/dev/.gemini/antigravity-cli/brain/<conversation>/...`) |
| the account's user and group in an `ls -la` listing the model ran (`subagent`) | `dev  dev ` (the same width) |

Conversation ids, step indexes, tool names, arguments and treecontext node
ids are the client's and the store's own. Free text was read before it was
committed: every prompt, every tool output (shell outputs, treecontext's
replies and its tool schemas as agy reads them, a `git status` and `git diff`
of this repository at the time, a listing of agy's conversation directory),
every model reply and every model "thinking" text; then `npm run
release-scan` was run over it.

These files are the ground truth for any charter step that says an event is
"as Antigravity sends it" (D417). A binding replays them through the named
hook install writes for agy; it never edits a payload's shape. When a
scenario needs a payload these files do not hold, record a new session; do
not write one.

## 1.5.3 (recorded 2026-11-09, Linux)

The hooks ran through `sh` (their parent process `sh`), with the hooks
file's directory as their working directory; their environment named
`ANTIGRAVITY_CONVERSATION_ID`, and in the `worker` set also
`TREECONTEXT_TICKET` and `TREECONTEXT_WORKER_SESSION`. Every headless set ran
`agy -p` with agy's permission preset `always-proceed`, except the refusal.

`headless-session.ndjson`: one prompt asking for five steps. Calls, each a
PostToolUse whose `error` is empty unless said: `run_command` `head -c 13
package.json` (exit 0), `run_command` `head -c 13 no-such-file-fixture.json`
(exit 1, `error` empty: the code is only in the transcript), `read_file` of
treecontext_insert's schema, `call_mcp_tool` treecontext_insert, `read_file`
of treecontext_export's schema, `call_mcp_tool` treecontext_export of a
missing node (`error` the server's reply, the transcript's step `ERROR`). A
PreInvocation and a PostInvocation around each of seven model calls
(`invocationNum` 0 to 6), then Stop (`terminationReason` `NO_TOOL_CALL`). At
each PostToolUse the transcript ends at the response that made the call
(`transcript_lines` equals `stepIdx`); its result is there at the
PostInvocation that follows.

`shell-nonzero-ls.ndjson`: one `run_command` `ls /no-such-path-fixture`
(exit 2, `error` empty), the reply, Stop.

`two-turns.ndjson`: `agy -p`, then `agy -c -p` with the same prompt, neither
calling a tool. The second turn fires no SessionStart; it opens with a
PreInvocation whose `invocationNum` is 0 again, every event of it repeating
`lastUserInput`.

`subagent.ndjson`: the parent calls `invoke_subagent` (`Prompt`, `Role`,
`TypeName`); the child's conversation fires its own SessionStart (a new
`conversationId`, `lastUserInput` empty, its transcript not yet written)
before the parent's PostInvocation; the child runs one `run_command` and
answers with `send_message` (`Recipient` the parent's conversation), and
stops. The parent's turn ends (Stop, `fullyIdle` false), then the child's
message opens another parent turn (a PreInvocation numbered 0 with the same
`lastUserInput`), in which the parent's model ran five more shell commands
(`head`, an `ls -la` of agy's conversation directory, a `cat` and a `tail` of
the `headless-session` transcript, `git status`, `git diff`, whose long
output agy wrote to a file and truncated in the transcript) before its
reply. Nothing in the child's payloads names its parent.

`worker.ndjson`: `agy -p` started by `treecontext run` (run `fx-run`, key
`fx-key`, role `fixture-worker`), so its prompt is the ticket door's first
message. Calls: `run_command` `head -c 13 package.json`, `read_file` of
treecontext_insert's schema, three `run_command` `git grep` (two exit 1 with
no output), a `read_file` of a source file, `call_mcp_tool`
treecontext_insert of a checkpoint; reply `done`.

`headless-refusal.ndjson` with `headless-refusal.stderr.txt`: `agy -p` under
agy's default, `toolPermission` absent, asked to run a shell command: agy
fired SessionStart and PreInvocation and nothing more, printed nothing on
stdout, wrote the one line in the `.stderr.txt` on stderr, and exited 0. Its
transcript was not copied (an earlier dump hook that kept payloads only).

What these sets do not hold, and why: the developer's interactive session of
the same day (recorded; not committed, since its tool replies are the
developer's own journal, an export and a search of it); a call refused in an
interactive session; a compaction; agy's MCP server process's environment.
