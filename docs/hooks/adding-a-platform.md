# Adding a Platform Adapter

> **Which clients have hooks, and how:** the dated [compatibility matrix](../../README.md#compatibility-matrix) in the README, one row per client: its hook events, the documentation checked, its mode, and whether capture there is verified live or documented only.

Source of truth: `src/hooks/README.md` (the verification rule and the
per-adapter status table). This page describes the mechanics.

## The model

The reference hooks (`src/hooks/*.ts`, Claude Code payload shape) own
all capture semantics. A platform adapter is a directory
`src/hooks/<platform>/` whose entry points **normalize the platform's
payload and delegate to the reference hooks** — never a copy of them.
The `vscode/` adapter is the worked example: `normalize.ts` folds the
platform's field names into the internal shape, each entry point calls
the reference hook's `main(preParsed)`, and platform-only events (e.g.
Copilot's inline `agentStop` text) get the minimal extra handling.

Copying capture logic is how adapters rot: the pre-rewrite copies had
drifted off the capture charter — they dropped repo-reading tool
invocations the charter says must be kept, and had no assistant-turn
capture at all (`src/hooks/vscode/normalize.ts` header).

## What a new adapter needs

1. **`src/hooks/<platform>/normalize.ts`** — map the platform's real
   payload shapes (all of them — Copilot has two) onto the fields the
   reference hooks read: `session_id`, `cwd`, `user_message`/`prompt`,
   `tool_name`, `tool_input`, `tool_output`, `transcript_path`,
   `source`.
2. **Entry points** for the events the platform actually exposes —
   user-prompt, post-tool, session-start, pre-compact, a turn-end
   event if one exists, and subagent start/stop if the platform reports
   them (they register subagents so the store can stamp each row's
   writer; without them nothing is registered and every row reads as
   the session's own agent's until its echo drains). Not every platform has a Stop equivalent; user
   and tool capture stand alone (`src/hooks/README.md`).
3. **Tests** in `tests/hooks/` exercising the documented payloads
   (`tests/hooks/copilot-adapter.test.ts` is the template).
4. **Installer wiring** in `src/server/agents.ts` (config paths and
   hook format) and `src/server/installer.ts` (an
   `upsert<Platform>Hooks` writer), gated behind
   `--experimental-capture` until verified.
5. **Every hook exits 0, always.** DB unreachable, malformed input —
   stderr at most. A hook must never crash the agent loop.

## Verification — the part that cannot be skipped

Reading hook source is **not** verification (that method missed
Claude Code's `tool_response` field four times). An adapter joins
`CAPTURE_PLATFORMS` — and only then does `treecontext install` write
its hook config without `--experimental-capture` — after someone runs
the real platform and inspects the staged rows. Until then the
installer registers MCP tools only and says plainly that nothing is
being captured.

Current status of the shipped scaffolding (`codex/`, `cursor/`,
`gemini/`, `opencode/`): **unverified**, and the first three still hold
their own copies of capture logic that predate the charter. Bringing
each one onto the delegate-to-reference pattern is part of its
verification pass.

Codex CLI and Gemini CLI no longer need theirs to be wired: they keep
their own hook configuration, so `install --agent codex|gemini
--experimental-capture` writes a **copy of the Claude Code block** there
— verbatim into `~/.codex/hooks.json` for Codex, whose documented
contract is Claude Code's (all seven events, `SubagentStart` and
`SubagentStop` and the four `SessionStart` matchers included), and translated to Gemini's renamed events
(`BeforeAgent`, `BeforeTool`, `AfterTool`, `PreCompress`; no subagent
events, and no `AfterAgent` for Claude's `Stop` until a live probe, since
Gemini treats a `deny` there as a forced retry) in `~/.gemini/settings.json` — running the same
`~/.claude/hooks/tc-*` scripts (D154, D208). `treecontext doctor` grades
each copy against the block this build would write: present and
consistent, or present and inconsistent with the events it differs on
and the same command as the way to rewrite it (D161). Codex's `[hooks]`
table in `~/.codex/config.toml` is graded, cleared by that command and by
uninstall the same way; a copy in two places reads inconsistent because
it would fire twice. Ownership is anchored to treecontext's own hooks
directory, so a `tc-*` hook of yours elsewhere is never touched, and
`uninstall --agent claude` keeps the scripts while a copy still runs them. A new copying
client is a row in `CLIENT_HOOK_MODES` and, if its events are renamed, a
translation table like `GEMINI_EVENT_FOR` (`src/server/installer.ts`).

VS Code and Cursor are the as-is clients (`AS_IS_CLIENTS`): they read
the Claude settings file themselves (VS Code only with
`chat.useClaudeHooks` on, off by default; Cursor by default), so install
writes nothing for them, with or without `--experimental-capture`, and
the flagged install prints one line saying so. Their adapters (`vscode/`,
`cursor/`) stay in source, unwired; a hook file an earlier build wrote
for them is a second route that doctor warns about, removed by
`treecontext uninstall --agent vscode|cursor --hooks-only`. OpenCode
offers no shell hooks, so the tools are its whole surface. Doctor's row
for each of the five ends in one clause, `the client <mode>; state:
<state>; remedy: <remedy>`, and no row calls capture verified.
