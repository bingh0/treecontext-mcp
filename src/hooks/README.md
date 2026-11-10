# treecontext hooks

Hooks capture conversation activity and manage compaction lifecycle for
agent platforms. See [docs/hooks/architecture.md](../../docs/hooks/architecture.md)
for the three-layer model.

## Layer 2 — Journaling hooks

- `user-prompt-submit.ts` — captures user prompts → staging table
- `post-tool-use.ts` — captures tool calls → staging table, with the
  payload's `agent_id`/`agent_type` when a subagent made the call and the
  client's `tool_use_id`; it serves three Claude Code events by
  `hook_event_name`: `PostToolUse` (a call that succeeded),
  `PostToolUseFailure` (a call that failed: the `error` text is the Output
  section, staged with `outcome` `failed` or `interrupted`, D400) and
  `PostToolBatch` (the batch's account: each call of `tool_calls` this
  session has not staged, told by `tool_use_id`, with its `tool_response`
  as the Output, `captured_from` `batch`, in one immediate transaction;
  nothing on a store below schema 034; a failure is one gap record for the
  batch before the lookup answered, one per call it was adding after,
  D401; the lookup is a plain read, and only a batch with a call to add
  takes the write lock). What the hook stages is what the client hands
  it: Claude Code 2.1.319 gives at most the first 30,000 characters of a
  shell command's output (a successful call's payload also names the
  client's own file with all of it, `persistedOutputPath` and
  `persistedOutputSize`, written into the entry as text, never read) and
  about 10,000 characters of a failed one's, its middle cut by the
  client; on the
  Agent tool's result (`tool_name` `Agent`, or `Task` before the rename),
  when the subagent it spawned (`tool_response.agentId`) was a leg, adds
  one line beside the result as `hookSpecificOutput.additionalContext`:
  the leg's return, its summary row with writer, run and key (D284, D285,
  D330). The tool's result itself, the subagent's own final message, is
  never touched. A background Agent call carries no pointer: its
  PostToolUse fires at the launch (`tool_response` `{isAsync: true,
  status: "async_launched", agentId}`), the subagent not yet finished,
  and its return arrives later as a task notification the platform owns
- `stop.ts` — captures the assistant's final response of a turn (the
  payload's `last_assistant_message`; only a payload without it falls
  back to the last assistant text of `transcript_path`, which at Stop
  time still ends at the previous turn) → staging table; then, when the store's checkpoint
  interval has passed (default 20 rounds or 45 minutes), answers
  `decision: "block"` once to ask the agent for a one-line bookmark —
  never when `stop_hook_active` is set, never twice in one interval. A
  `claude -p` worker's session (D295: one the session-start hook
  registered or linked from a ticket) is never asked for a bookmark: its
  stop is its leg's, sent back once (`decision: "block"`, the same
  message the ticket door's re-run opens on, a `send-back` row in its
  lane, `send_backs` counted) when it owes its key's checkpoint, never
  when the store refuses writes, never when either door already sent it
  back, so a wrapper that spawned it starts no run after it
- `subagent-start.ts` — registers a live subagent (`agent_id`,
  `agent_type`) in the store's `session_registry` under the parent's
  session id, and is the hooks door (D284, D305, D320, D325–D329, D332):
  with no brief in effect for its role nothing more happens; with one, it
  becomes a leg of that brief's run and key (`key_src` `inferred`), its
  start the checkpoint(s) then in effect, its run opened at this first
  registration, and its first moment (brief, checkpoint(s) whole with
  number, writer and moment, the flag, the recovery line, treecontext's
  state-not-history line) written as the first row of its lane and
  emitted as `hookSpecificOutput.additionalContext`, cut at the client's
  10,000-character cap with the checkpoint row's id and the count left
  out; with two or more, its key is `ambiguous` and the candidates kept.
  A store it cannot write starts the leg cold: nothing emitted, the start
  recorded in the gap ledger (D314)
- `subagent-stop.ts` — stages the subagent's report (the `message` of
  the newest `SubagentHandback` call in `agent_transcript_path` when it
  made one, D371; else `last_assistant_message`; else the last assistant
  text of that transcript) as kind `subagent-summary`, then retires the
  registration; an agent id nobody registered with no `agent_type` is the
  client's own internal agent (compaction, side calls), staged as kind
  `internal-summary` and stamped `_writer: "claude-code"` at the drain.
  For a leg (D279, D281, D326, D334): first settles its key from its own
  staged `treecontext_insert` echoes, as the drain would; a leg whose key
  is its own, whose brief names its own role as the checkpointer, with no
  checkpoint under its key newer than its start and no send-back spent by
  either door, is sent back once (`decision: "block"`, the reason naming
  the missing checkpoint, its first moment again, its trail), never when
  the store refuses writes; otherwise its report is written as its
  summary row in its lane, stamped with run and key, and the leg retired.
  A stop it cannot write goes to the gap ledger
- `gap-ledger.ts` — the events a hook could not write while the store
  refused them, a refused staging write's included (`hook-gaps.jsonl`
  beside the store, else in the temp directory); the drain renames the
  ledger aside, reads a claimed file once it is older than a 1 s grace,
  writes each record as a `[capture gap]` row at the moment it was
  dropped (once, by the record's id), and unlinks the file only after its
  rows landed
- `hook-store.ts` — a FlatStore over a hook's own connection
  (`migrate: false`, only at this build's schema; another schema is a
  refusal the hook records as a gap), so the rows the hooks door writes
  are the ticket door's code, column for column; the briefs are read
  from the session's resolved namespace, every namespace only when it
  does not resolve

- `hook-client.ts` — the client a hook runs for (D404), named by the
  command install wrote (`--client claude-code`, `--client codex`,
  `--client agy`) and handed on by the hook script, never read from the
  payload (Codex's payloads are Claude-shaped). `CLIENTS_STATING_OUTCOME`
  lists the clients whose own events state how a call ended (Claude Code
  alone: a call arriving by `PostToolUse` succeeded, one by
  `PostToolUseFailure` failed); every other client's calls are classed by
  their text. `CLIENTS_REGISTERING_NO_SELF` lists the clients no event of
  which registers a session's self (Antigravity CLI, D421)
- `codex-calls.ts` — Codex CLI's calls and turns (D408): a `PreToolUse`
  staged as a call's account (`captured_from` `pre-tool-use`, never an
  entry by itself), and at a turn's end (`Stop`, `Interrupt`,
  `SubagentStop`) each account with no result staged for its call id
  turned into a `no-result` entry at the call's own moment
- `agy.ts` — what one Antigravity CLI event stages (D415, D421), reached
  through `tc-agy <Event> --client agy`: the turn's prompt at the first
  `PreInvocation` of a turn, a call's account at `PostToolUse`, the call
  journaled at the `PostInvocation` whose transcript holds its output,
  the rest and the reply at `Stop`; a ticketed worker's conversation
  linked to its lane at `SessionStart`. Every answer to agy is `{}`
- `hook-deadline.ts` — a hook's waits on the store end at its deadline by
  the clock: each connection's busy timeout is a short slice, and the
  budget is a moment checked between slices

At the drain a staged row naming an agent is stamped `_writer` (its
role) with `_writer_src: "hook"`; a row naming none is the session's own
agent's. Rows written through the tools are stamped by the server from
`session_registry` and made exact by their insert's echo
(`src/persistence/session-registry.ts`, `src/persistence/writer-heal.ts`).
The writer is always the store's stamp, never the caller's claim.

Not every platform has a Stop equivalent. User and tool capture stand
alone: a platform with no turn-end signal still journals user messages
and tool events — its journal simply carries no assistant-prose entries.
The contract is turn-end capture wherever the platform can signal it,
never a dependency of the other two hooks on that signal.

## Layer 3 — Compaction lifecycle

- `pre-compact.ts` — writes a recovery-query snapshot on context pressure
  (no stdout)
- `session-start.ts` — runs on all four `SessionStart` matchers
  (`startup`, `resume`, `clear`, `compact`). On a clear it reads the
  predecessor session id from the pid beacon before rewriting it and
  records the link (`session_chain:<id>`). It registers the session's
  self (worktree, branch, directory, via `git-self.ts`) in
  `session_registry` and, on every source but `compact`, retires
  subagents left live: a leg as `cut` (`ended`, `noticed_at`, `noticed_by`
  `session-start hook`, no `stopped_at`, D328), a plain subagent as
  before (`stopped_at` at the start). A session holding a worker's ticket
  (`TREECONTEXT_TICKET`, D295) is a worker, never a self: no beacon, no
  self row, no packet; its Claude Code session id is linked
  (`client_sessions`) to the lane the ticket door registered when the
  lane in the environment is trusted, and it is told whose worker it is
  (its first message was its prompt); with no wrapper the hook claims the
  ticket itself, registering the worker in its own session's lane, and
  injects the first moment it composed. It emits a `systemMessage` naming the store it
  journals into, and as `additionalContext` either the /clear packet
  (`buildClearPacket`, `src/checkpoints.ts`, at most 3000 characters:
  chapter summary, bookmark, newest five developer turns, handoff lines,
  reminder) or, on the other sources, the source-branched rehydration
  payload, opened in a linked worktree by that worktree's own chapter
  and brief
- `git-self.ts` — where a session runs, as git reports it for the
  payload's cwd

## Shared primitives

- `shared.ts` — platform-agnostic operations: `writeStaging`, `writeSnapshot`,
  `buildRehydrationPayload`, `enforceCharCap`, `stripAnsi`, `normalizeSource`,
  `payloadWriter`

## Clients — verification status

Claude Code (the root hooks above) is the **reference platform**,
verified against live payloads and a live store. Per the capture
charter's verification rule (reading hook source is not verification:
that method missed `tool_response` four times), a client is advertised
as captured only after a live run of the real client and direct
inspection of the store.

There are no per-platform adapter directories any more. The copies
earlier builds carried (`codex/`, `cursor/`, `gemini/`, `opencode/`,
`vscode/`) left the build in 0.1.0-beta.4 with the
`--experimental-capture` flag (D399, D406); a client is now named by the
command that runs the hook.

`install` writes hook configuration only where capture can run, and says
plainly where nothing is being captured. Every other agent still gets its
MCP registration: the tools work wherever the agent speaks MCP.

| Client | State |
| --- | --- |
| Claude Code | **Verified live.** The reference platform; the hooks block in `~/.claude/settings.json`, every command ending in `--client claude-code`. |
| Codex CLI, from 0.167.0 | **Verified live as a worker under a Claude Code main; a Codex main is best effort.** Its own block in `~/.codex/hooks.json` running the same `tc-*` scripts with `--client codex` (`src/server/codex-hooks.ts`, D406 to D412). Codex runs a hook only once it is trusted with `/hooks`. Recordings: `tests/fixtures/codex-hooks/0.167.0`. |
| Antigravity CLI, from 1.5.3 | **Basic support.** One named hook in `~/.gemini/config/hooks.json` (`src/server/agy-hooks.ts`, D413 to D415), served by `agy.ts`. An agy main registers no self. Recordings: `tests/fixtures/agy-hooks/1.5.3`. |
| VS Code, Cursor | **Documented only.** They read the Claude settings file themselves, so install writes nothing for them and their events are taken as Claude Code's. |
| OpenCode | **Tools only.** No shell hooks. |
| Gemini CLI | **Archived (D399).** Never wired; uninstall sweeps what an earlier build wrote. |

## Registration

See [docs/hooks/claude-code.md](../../docs/hooks/claude-code.md) for
Claude Code setup. See [docs/hooks/adding-a-platform.md](../../docs/hooks/adding-a-platform.md)
for adding other platforms.
