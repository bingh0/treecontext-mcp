# Adding a Platform

> **Which clients have hooks, and how:** the dated [compatibility matrix](../../README.md#compatibility-matrix) in the README, one row per client: its hook events, the documentation checked, its mode, and whether capture there is verified live or documented only.

Source of truth: `src/hooks/README.md` (the verification rule and the
per-client status table). This page describes the mechanics, as Codex CLI
(D406 to D412) and Antigravity CLI (D413 to D415) were added in
0.1.0-beta.4.

## The model

There are no per-platform adapter directories. Earlier builds carried
them (`src/hooks/codex`, `cursor`, `gemini`, `opencode`, `vscode`), each
with its own copy of the capture logic, and the copies drifted off the
capture charter: they dropped repo-reading tool calls the charter keeps
and had no assistant-turn capture. They left the build with the
`--experimental-capture` flag (D399, D406).

A client is now captured one of three ways:

- **It runs the reference hooks through a block of its own.** Codex CLI's
  payloads are Claude-shaped, so install writes Codex its own block into
  `~/.codex/hooks.json` (`src/server/codex-hooks.ts`), each command running
  the same `~/.claude/hooks/tc-*` scripts with `--client codex`. What only
  Codex needs lives beside the reference hooks
  (`src/hooks/codex-calls.ts`: a `PreToolUse` held as a call's account,
  and the calls a turn's end found no result for).
- **It gets one hook of its own.** Antigravity CLI's events and payloads
  are its own, so install writes one named hook (`src/server/agy-hooks.ts`)
  whose commands run `tc-agy <Event> --client agy`, served by
  `src/hooks/agy.ts`. The event comes from the command, since two of agy's
  payloads carry the same keys.
- **It reads the Claude settings file itself.** VS Code (with
  `chat.useClaudeHooks` on) and Cursor run Claude Code's block as it is;
  install writes nothing for them (`AS_IS_CLIENTS`, D154, D226), and
  their rows stay documented only.

A client with no shell hooks (OpenCode) gets the tools alone.

## What a new client needs

1. **Recordings first.** Run the real client, record its hook payloads
   and its transcript, and commit them under
   `tests/fixtures/<client>-hooks/<version>/` with a README saying how
   they were taken. Recorded fixtures carry model-written text: read it
   and run `npm run release-scan` before committing. A payload written
   by hand is never the client's word (the stand-in guard in
   `tests/feature-guards.test.ts`).
2. **The client's event list**, `tests/fixtures/<client>-hooks/events.json`:
   every hook event the client documents, each either wired by install or
   named with what the journal does not capture because of it (D402). The
   list is re-read against the client's hooks reference at every client
   upgrade.
3. **A name in the command.** A hook takes its client from the command
   install wrote (`--client <name>`, `src/hooks/hook-client.ts`), never
   from the payload. Add the client there, and to:
   - `CLIENTS_STATING_OUTCOME` only on a recording showing its failed
     calls arrive by an event of their own (D404); otherwise its calls
     are classed by their text;
   - `CLIENTS_REGISTERING_NO_SELF` if no event of the client registers
     the session's self, so its rows outside a worker's lane are stamped
     `unregistered`, shown as "writer unknown" (D421).
4. **Install, uninstall and doctor for the client's own files**, in a
   module of its own (`codex-hooks.ts`, `agy-hooks.ts` are the two worked
   examples). The rules both follow:
   - a version floor, the version the recordings were made on; below it,
     or where the version cannot be read, the client stays tools-only and
     what install wrote is taken back;
   - the developer's file is edited as text
     (`src/server/json-text-edit.ts`), never re-serialised, and a change
     edits cannot make is a refusal that leaves the file byte for byte;
   - install records what it wrote (`src/server/install-state.ts`), and a
     take-back removes exactly that;
   - one invariant, read in one place: treecontext's hooks are in the
     client's hooks file if and only if the client's MCP entry serves in
     capture mode (D386; `codexHooksPresent`, `agyHooksPresent`,
     `captureHooksInstalled`);
   - where the client can say what it loaded, ask it instead of modelling
     its configuration grammar (Codex's `hooks/list`); where it cannot
     (agy), doctor reads the file and says so.
5. **Every hook exits 0, always**, and inside the client's own time limit.
   Store unreachable, malformed input: stderr at most, and what could not
   be written goes to the gap ledger (`src/hooks/gap-ledger.ts`), never
   silently away. A hook must never crash or stall the agent loop.
6. **Charter scenarios** in `features/`, bound through the recordings
   (`recordedSession`, `replayRecordedSession`). Feature files are owner
   review territory.

## Verification — the part that cannot be skipped

Reading hook source is **not** verification (that method missed Claude
Code's `tool_response` field four times). A client's capture is promised
only after a live run of the real client and direct inspection of the
store:

- `treecontext doctor` reads the client's row as capturing;
- a real session's tool calls are counted against the store. For Claude
  Code and Codex CLI: `npm run dogfood:census` (by the client's call id;
  `--codex <rollout.jsonl>` for a Codex rollout, D409). Antigravity CLI
  has no census yet; its calls are counted by hand against the worker's
  lane;
- the README's compatibility and orchestration matrices say "verified
  live" only with the client's version, the permission mode and the date
  of the run the cell rests on.

Until then install registers the MCP tools only and says plainly that
nothing is being captured.

## Current state

| Client | How it is captured | State |
| --- | --- | --- |
| Claude Code | the reference hooks, wired into `~/.claude/settings.json` | verified live; the reference platform |
| Codex CLI | its own block in `~/.codex/hooks.json`, from 0.167.0; Codex runs a hook only once it is trusted with `/hooks` | verified live as a worker under a Claude Code main; a Codex main is best effort |
| Antigravity CLI | one named hook in `~/.gemini/config/hooks.json`, from 1.5.3 | basic support; recorded at 1.5.3 |
| VS Code, Cursor | Claude Code's block, read by the client itself | documented only |
| OpenCode | no shell hooks | tools only |
| Gemini CLI | archived (D399) | install never wires it; uninstall sweeps what an earlier build wrote |

A hook file an earlier build wrote for VS Code or Cursor is a second
route that doctor warns about, removed by `treecontext uninstall --agent
vscode|cursor --hooks-only`. Doctor's row for each client ends in one
clause, `the client <mode>; state: <state>; remedy: <remedy>`, and no row
calls capture verified where no live run stands behind it.
