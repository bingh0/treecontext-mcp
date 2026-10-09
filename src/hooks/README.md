# treecontext hooks

Hooks capture conversation activity and manage compaction lifecycle for
agent platforms. See [docs/hooks/architecture.md](../../docs/hooks/architecture.md)
for the three-layer model.

## Layer 2 — Journaling hooks

- `user-prompt-submit.ts` — captures user prompts → staging table
- `post-tool-use.ts` — captures tool calls → staging table, with the
  payload's `agent_id`/`agent_type` when a subagent made the call
- `stop.ts` — captures the assistant's final response of a turn (the
  payload's `last_assistant_message`; only a payload without it falls
  back to the last assistant text of `transcript_path`, which at Stop
  time still ends at the previous turn) → staging table; then, when the store's checkpoint
  interval has passed (default 20 rounds or 45 minutes), answers
  `decision: "block"` once to ask the agent for a one-line bookmark —
  never when `stop_hook_active` is set, never twice in one interval
- `subagent-start.ts` — registers a live subagent (`agent_id`,
  `agent_type`) in the store's `session_registry` under the parent's
  session id; captures nothing
- `subagent-stop.ts` — stages the subagent's report
  (`last_assistant_message`, else the last assistant text of
  `agent_transcript_path`) as kind `subagent-summary`, then retires the
  registration

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
  subagents left live. It emits a `systemMessage` naming the store it
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

## Platform adapters — verification status

Claude Code (the root hooks above) is the **reference platform**,
verified against live payloads and a live store. Per the capture
charter's verification rule (reading hook source is not verification —
that method missed `tool_response` four times), no other platform is
advertised as working capture until it earns a live-payload pass.

`install` enforces this rather than leaving it to documentation: it
writes hook configuration only for slugs in `CAPTURE_PLATFORMS`
(`src/server/installer.ts`). Every other agent still gets its MCP
registration — the tools work wherever the agent speaks MCP — and the
installer says plainly that nothing is being captured.

| Adapter | State |
| --- | --- |
| root (Claude Code) | **Verified.** Reference platform. In `CAPTURE_PLATFORMS`. |
| `vscode/` (GitHub Copilot) | **Charter-aligned, awaiting a live pass.** Rewritten to delegate to the reference hooks, so capture semantics can no longer drift; normalization covers both Copilot payload shapes; `agentStop` added. Exercised against the documented payloads (`tests/hooks/copilot-adapter.test.ts`) but **not** against a live Copilot session, which is what the pass requires. No longer installed: VS Code reads the Claude settings file, so the installer writes nothing for it even with the flag (D226); doctor flags a copy an earlier build left. |
| `codex/`, `cursor/`, `gemini/` | **Unverified.** Still hold their own copies of capture logic, and those copies still drop repo-reading invocations the charter says to keep. Bringing each onto the charter is part of its pass — the `vscode/` rewrite is the worked example. `install --experimental-capture` no longer wires `codex/` or `gemini/`: those two clients get a copy of the Claude Code block running the reference hooks (D154, D208; `docs/hooks/adding-a-platform.md`). |
| `opencode/` | **Unverified.** A plugin rather than hooks; registered manually in opencode's config. |

### What a verification pass costs

The `vscode/` rewrite is the template: normalize the platform's real
payload shapes, delegate to the reference hook rather than copying it,
add the events the platform actually exposes, then run the platform for
real and inspect the staged rows. Only after that last step does a slug
join `CAPTURE_PLATFORMS`.

## Registration

See [docs/hooks/claude-code.md](../../docs/hooks/claude-code.md) for
Claude Code setup. See [docs/hooks/adding-a-platform.md](../../docs/hooks/adding-a-platform.md)
for adding other platforms.
