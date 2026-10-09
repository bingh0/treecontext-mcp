# treecontext

**Context for your working tree: a searchable chat-session journal for AI
coding agents.**

Install once, forget it exists. Your agent's sessions — your messages, its
tool calls, its own curated notes — land in a local SQLite journal, one per
working tree, that it searches at the next cold start. Recall replaces
context compaction: instead of trusting a lossy summary (and paying the
prompt-cache invalidation that comes with it), the agent asks the journal
what it was doing and reads the answer.

No embedding model, no LLM calls, no network, no telemetry. Retrieval is
lexical — SQLite FTS5 BM25 with per-role weights.

New here? [features/DESIGN.md](features/DESIGN.md) is the orienting document — what this
is and why it is shaped this way; [ARCHITECTURE.md](ARCHITECTURE.md) is
how it hangs together; [docs/security.md](docs/security.md) is the
trust contract.

> **This is a public beta (`0.1.0-beta.1`).** It installs from npm under
> the `beta` dist-tag, as `treecontext-mcp@beta`. The store schema may still change between beta
> releases; migrations are additive, but treat your journal as replaceable
> for now.

---

## 1. Requirements

| | |
| --- | --- |
| **Node.js** | 22 or newer — check with `node -v` |
| **Claude Code** | the CLI, the VS Code extension, or both |

`treecontext` has one native dependency (`better-sqlite3`). It ships
prebuilt binaries for mainstream platforms, so installation normally needs
no compiler. If your platform has no prebuild, npm falls back to compiling
it, which needs:

- **Windows** — [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/) with the "Desktop development with C++" workload, plus Python 3
- **macOS** — Xcode Command Line Tools (`xcode-select --install`)
- **Linux** — `build-essential` and `python3`

## 2. Install

### macOS / Linux

```bash
npm install -g treecontext-mcp@beta
```

### Windows (PowerShell)

```powershell
npm install -g treecontext-mcp@beta
```

Check it landed:

```bash
treecontext doctor
```

<details>
<summary><b>Alternative: clone and build</b> (if you want to patch or debug)</summary>

```bash
git clone https://github.com/bingh0/treecontext-mcp.git
cd treecontext-mcp
npm install
npm run build
npm test          # the full test suite, including the charter suite
node dist/server/cli.js doctor
```

With a checkout you run the CLI as `node dist/server/cli.js <command>`
everywhere this README says `treecontext <command>`. A checkout puts
nothing on PATH: `doctor` run from it says so on its `Command on PATH`
row, and if a `treecontext` is already on PATH, names the build it
belongs to. To make the checkout the command, `npm install -g .` from
its root after `npm run build` — npm links the folder rather than
copying it, so the command follows your checkout.
</details>

### Upgrading between beta releases

Install the new beta over the old one:

```bash
npm install -g treecontext-mcp@beta
```

Coming from a release-candidate tarball (`0.1.0-rc.N` or earlier)? Those
installed under the old package name `treecontext`, and npm refuses to
let two packages own the `treecontext` command (`EEXIST`). Remove the
old one first — your journals are untouched:

```bash
npm uninstall -g treecontext
npm install -g treecontext-mcp@beta
```

Then **re-run `treecontext install`**. The hook set grew in `0.1.0-beta.1`
(the clear/resume matchers, and SubagentStart/SubagentStop) and the hooks'
commands changed (on macOS and Linux each now execs its wrapper, which
keeps session identity where `/bin/sh` is dash), and `doctor` reports
"hooks incomplete" or "degraded session identity" until you do (a plain
re-run repairs both; doctor's fix line names the forced form,
`treecontext install --force --agent claude`). The re-run is idempotent — it merges rather than overwrites,
skips anything already correct, and refreshes the hook wrapper scripts
and any stale interpreter paths. Store migrations run automatically the
next time the server opens your store and are additive — but per the
beta caveat above, treat the journal as replaceable between beta
releases anyway.

## 3. Set up your agent

```bash
treecontext install
```

This detects your installed agents and wires treecontext into them. Add
`--dry-run` first if you want to see the plan without writing anything, or
`--agent claude` to restrict it to one agent.

**Everything it writes**, so you can audit it before or after:

| Path | What it is |
| --- | --- |
| `~/.claude.json` | registers the treecontext MCP server at user scope (the file Claude Code actually reads; `$CLAUDE_CONFIG_DIR/.claude.json` when that is set) |
| `~/.claude/settings.json` | registers 7 hooks: `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `PreCompact`, `SubagentStart`, `SubagentStop` |
| `~/.claude/hooks/tc-*` | the hook wrapper scripts themselves (`.cmd` on Windows) |
| `~/.claude/skills/treecontext-reference/SKILL.md` | the reference skill your agent loads on demand |
| `~/.treecontext/config.toml` | treecontext's own settings |

On Windows, `~` means `%USERPROFILE%`. Existing config is merged, not
overwritten — your other MCP servers and hooks are left alone, and a
corrupt config file is backed up to `.bak` rather than clobbered.

**Then restart Claude Code** (quit the CLI, or reload the VS Code window).
Hooks and MCP servers are read at startup. A hook that fires before the
server has ever run still captures: the first hook creates the store it
needs, and the server ingests the backlog when it boots.

Optionally, inside a project, add the agent-instruction block to that
repo's `AGENTS.md`:

```bash
cd ~/code/my-project
treecontext init
```

## 4. Verify it's working

Start a new session in any project and ask your agent to run
`treecontext_status`. You should see a store name, a path, and a node
count. Do a few turns of ordinary work, then run it again — **the node
count should have grown**. That is capture working.

Then confirm recall: ask the agent something like *"search your journal for
what we did earlier."* It should call `treecontext_query` and come back
with your own earlier messages.

Your data lives at:

```
~/.treecontext/stores/<project>/treecontext.db
```

One store per project, named from your git remote (or, if there isn't
one, the directory name plus a short hash of the project's identity,
such as `my-app-3f9c2a`). Clones and worktrees of the same repository share
one store. When a project's identity changes — you add a remote, or run
`git init` above a directory you'd already used — treecontext carries
the existing journal forward to the new identity and tells you it did,
rather than starting an empty one. If two journals were already split
this way before you upgraded, `treecontext doctor` names the pair and
`treecontext stores merge <src> <dst>` reunites them (backups first;
the source is never deleted for you).

## 5. Using it day to day

Mostly you don't. Capture is automatic. Two things are worth knowing:

- **At the start of a session**, a well-oriented agent calls
  `treecontext_status` and `treecontext_query` before doing anything else.
  The installed skill and the `SessionStart` hook both tell it to. If yours
  doesn't, say *"check your treecontext journal first"* — that is useful
  beta feedback, please report it.
- **The agent should write down the *why*.** Hooks capture what happened;
  decisions, rejected options and constraints only get recorded if the
  agent calls `treecontext_insert`. Prompting *"record that decision in
  treecontext"* works and is a good habit.
- **Optional: a live journal pane in ccr.** treecontext writes small
  status panes beside each store that ccr's sidecar can display. Run
  `treecontext ccr wire` in your project and it names the pane in ccr's
  own config for you — right file for your platform, merged into what
  is already there. Then cycle to it: **F3** under tmux, **Space** in a
  VS Code split, `ccr cycle-view` on Windows Terminal (which binds no
  key). If nothing appears, `treecontext doctor` walks the whole join
  and names the broken link. Details in
  [**docs/ccr-pane.md**](docs/ccr-pane.md).

The eight tools your agent gets: `treecontext_insert`, `_query`, `_status`,
`_export`, `_import`, `_merge_from_agent`, `_delete`, `_clear`. `_export`
and `_import` take a `path`: the server itself writes or reads the handoff
file, inside the project directory only, and nothing of its content enters
the conversation.

A server started with `--policy read_only` (or `--read-only`), the usual
choice for a subagent, registers only `_query`, `_status` and `_export`,
and never writes the journal: no insert, no capture ingestion, no
deletion. It is not a read-only view of your disk, though: `_export`
with a `path` still writes a handoff file into the project directory when
the agent asks, under the same rules as any other server. `contributor`
adds `_insert` and nothing that removes. Details in
[docs/security.md](docs/security.md) §5.

### Working as a team

- **One store per machine.** Each developer's journal lives on their own
  disk (§4). Nothing syncs by itself; teammates share through the
  repository.
- **Hand off through a file in the repository.** Ask your agent for a
  handoff file, say *"export a handoff to handoffs/login-plan.json"*, and
  commit it. The server writes the file itself; only its name and the
  count come back into the conversation. By default it holds your chapter
  summaries and your subagents' summaries. The whole journal is a
  deliberate choice: captured tool output can hold secrets, tokens and
  keys, so the agent is warned first and writes only once you confirm.
  The file says at its head who exported it, when, from which project,
  with which treecontext version, what it holds, and the one step that
  imports it. Your teammate pulls and asks their agent to import that
  path. Every imported entry is marked as imported from that file by
  them; importing twice lands it once. The agent can only write or read
  a handoff inside the project directory, never under `.git`, and never
  over an existing file that is not itself a handoff.
- **Or from a shell.** `treecontext export handoffs/login-plan.json`
  writes the same file the agent would (`--whole --yes` for the whole
  journal, after the same warning), and `treecontext import
  handoffs/login-plan.json` imports one.
- **Say "checkpoint", then `/clear`.** The word asks the agent to write a
  chapter summary of where you are. It will then suggest a `/clear`; after
  it, the agent's first reply shows you the re-orientation packet it was
  handed: the chapter, the latest bookmark, your recent turns. Bookmarks
  are written for you when the stop hook asks.
- **Subagents share the store, each in its own lane.** On Claude Code
  subagent captures and registered tool writes carry a writer
  (`tester`, yours `main`, `worktree:<name>`); main-agent captures
  carry none. A finished subagent's report is kept as
  its summary; `treecontext_export` with `writer: "tester"` reads its
  trail. When the store can tell it apart it searches its own role's
  trail; it can answer your chapter, never retire it (fixed at the drain
  if a note's writer was guessed wrong).
- **Something looks off?** Run `treecontext doctor` first.
- **Capture is verified only on Claude Code.** A teammate on Codex,
  Gemini, Cursor, VS Code or OpenCode gets the tools: they can search and
  write notes, but nothing of their session is captured for them (§6).

## 6. Platform support

Every agent that speaks MCP gets the eight tools, and through them the
whole journal: search, notes, export and import. **Automatic capture is
promised only where it has been verified live — Claude Code alone today.**

### Compatibility matrix

What each client's own documentation says about its hooks, and the date
or release of the documentation it was checked against. "Documented only"
means exactly that: read in the vendor's docs, never run by us. It is not
a test result.

| Client | Hook events it offers | Documentation checked | Mode | Status |
| --- | --- | --- | --- | --- |
| Claude Code | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, PreCompact, SubagentStart, SubagentStop | hooks docs 2026-09-23; live probe 2026-09-25 on release 2.1.282 | reads the Claude settings file as-is (it owns `~/.claude/settings.json`, where install writes the hooks: SessionStart, UserPromptSubmit, PostToolUse, Stop, PreCompact, SubagentStart, SubagentStop; reinstall to add the two subagent hooks) | verified live |
| Codex CLI | SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, PreCompact, PostCompact, SubagentStart, SubagentStop, Stop, Interrupt | learn.chatgpt.com/docs/hooks (no date shown), checked 2026-10-05 | copies the hooks into its own configuration (`~/.codex/hooks.json` or `[hooks]` in `~/.codex/config.toml`, repo `.codex/hooks.json`; same JSON contract as Claude Code) | documented only |
| Gemini CLI | SessionStart, SessionEnd, BeforeAgent, AfterAgent, BeforeModel, AfterModel, BeforeToolSelection, BeforeTool, AfterTool, PreCompress, Notification | geminicli.com/docs/hooks (updated 2026-04-13) and /docs/hooks/reference (updated 2026-04-10) | copies the hooks into its own translated configuration (`settings.json` under `.gemini/` or `~/.gemini/`; same stdin/stdout shapes, renamed events, no subagent events) | documented only |
| VS Code (Copilot agent mode) | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, SubagentStart, SubagentStop, Stop | code.visualstudio.com/docs/copilot/customization/hooks and /docs/agents/reference/hooks-reference (dated 2026-09-30) | reads the Claude settings file when its Claude-hooks setting is on (`chat.useClaudeHooks`, off by default; read as-is, matcher values ignored; also reads `.github/hooks/*.json`) | documented only |
| Cursor | sessionStart, sessionEnd, beforeSubmitPrompt, preToolUse, postToolUse, stop, preCompact, subagentStart, subagentStop, and more | cursor.com/docs/agent/hooks and /docs/reference/third-party-hooks (no date shown), checked 2026-10-05 | reads the Claude settings file by default (as-is, through its Include Third-Party configs setting) | documented only |
| OpenCode | none: JS/TS plugins only, no shell hooks | opencode.ai/docs/plugins (updated 2026-10-03) | offers no shell hooks, so the tools are its whole surface (the MCP tools; JS/TS plugins are not hooks) | documented only |

Claude Code in VS Code (the Claude extension, not Copilot) is Claude Code:
same configuration, nothing extra to do. Linux, macOS and Windows are all
supported targets.

**`install` will not write capture hooks for a platform we haven't
verified.** MCP tools are registered anywhere the agent speaks MCP —
those work regardless — but a hook entry sitting in your settings reads
as a promise that capture is running, and we won't make that promise on
an adapter nobody has run. For the two clients that copy hooks into their
own configuration, Codex CLI and Gemini CLI, the copy is an opt-in by
name, and `treecontext doctor` names the command on that client's row:

```bash
treecontext install --agent codex --experimental-capture
```

The copy is the Claude Code block itself, verbatim for Codex CLI and
translated to Gemini CLI's event names, running the same hook scripts.
`treecontext doctor` gives every documented client one row with three
halves: its mode (from the matrix above), the state it found, and the
remedy. A copy reads present and consistent when it matches the block
this build would write, or present and inconsistent with the events it
differs on and the same command to rewrite it; VS Code's row reads
`chat.useClaudeHooks` from VS Code's own `settings.json`; Cursor's and
OpenCode's remedy is nothing to do. No row calls capture verified.

### Copilot capture (preview)

The Copilot adapter has been rewritten against Copilot's documented
payload shapes and now shares the reference platform's capture code
rather than a copy of it, so the two cannot drift. What it has **not**
had is a run against a live Copilot session — and someone doing exactly
that is what would finish the job:

VS Code reads the Claude settings file itself when `chat.useClaudeHooks`
is on, so treecontext writes no Copilot hook file any more, flag or not
(D226): turn the setting on and the hooks `treecontext install` wrote for
Claude Code are the ones it runs. Then use Copilot normally and check
whether your node count grows (§4). **Please report either outcome** —
working or not — on the issue tracker. That report is the verification
pass.

A `~/.copilot/hooks/treecontext.json` an earlier build wrote would run
the hooks a second time; `treecontext doctor` says so on VS Code's row,
and `treecontext uninstall --agent vscode --hooks-only` removes it.

## 7. Your data

**Everything is local.** Nothing leaves your machine. There are no network
calls, no accounts, no analytics.

**What gets captured:** your prompts, your agent's tool calls *including
their inputs and outputs*, its end-of-turn responses, and any notes it
writes. Tool output that merely re-reads your repo is stored as a bounded
preview; execution and external output is kept in full.

**So treat the journal as being as sensitive as the terminal it watched.**
If a command printed a token, an environment dump or a customer record,
that text is now in the SQLite file. It is a plain file on your disk with
your user's permissions — back it up, or don't, accordingly.

**Retention:** two mechanisms, both archive-first. A session cap (100
sessions by default) evicts whole sessions: each is archived to JSON and
tombstoned before any of its rows is deleted, and the newest session is
never evicted. Behind it sits a safety net of 200 captured entries per
session the cap allows (20 000 at the default). A byte budget (128 MiB
of stored content by default) shrinks old auto-captured rows to a
bounded preview, after writing their full text to an archive file. With
no archive destination configured, both refuse rather than lose
anything. Both figures are yours to set per project in a
`treecontext.toml` at the project's root, or for every project in
`~/.treecontext/config.toml`. The global file applies only to projects
with no `treecontext.toml` of their own: the first file found is read
whole, so a project file without a `[retention]` table means the
defaults, not the global figures.

```toml
[retention]
max_store_bytes = 268435456   # 256 MiB, in bytes
max_sessions = 200
```

Restart the agent (and so the server) after changing them. Only you delete:

```bash
treecontext stores list          # what exists, and how big
treecontext stores rm <name> --yes
treecontext backup ~/journal-backup.db
```

**Migration backups:** before any store migration or schema update,
additive or destructive, your store is copied aside
(`treecontext.db.pre-migration-v<N>.bak`, inside the store's directory)
and a verdict is recorded comparing the migrated store against
the copy. `treecontext doctor` lists every backup with its verdict and
size. Reclaiming that disk is manual and opt-in — nothing ever deletes a
backup without you running the command:

```bash
treecontext stores sweep                 # dry-run: lists and verifies, deletes nothing
treecontext stores sweep --yes           # deletes the verified ones
treecontext stores sweep --store X --yes # only store X's backups; the rest untouched
```

The sweep only deletes what it can fully verify: the live store must
open, pass its integrity check, and sit at the current schema, and the
backup must carry a success verdict from migration time and be readable
itself. Everything else is refused with a stated reason and left on disk
(the run exits with a partial status when anything was refused). A
refused backup leaves only by hand — `doctor` tells you what each one
needs, and `stores rm` is the explicit path for a verified backup whose
store you have already deleted.

**Telemetry is off.** During the beta there is an *opt-in* local
instrument that appends one line per search to
`query-telemetry.jsonl` next to your store — query text, result ages, and
timing. It never leaves your machine; you'd send it to us deliberately, or
not at all. It settles one open ranking question, so opting in genuinely
helps:

```bash
export TREECONTEXT_QUERY_TELEMETRY=1     # Windows: setx TREECONTEXT_QUERY_TELEMETRY 1
```

## 8. Troubleshooting

Start with `treecontext doctor` — it checks Node, the native binding, the
store directory, and each agent's configuration, and prints a `fix:` line
for anything broken. Two rows near the top say which build is which:
`Command on PATH` names the build your shell runs as `treecontext`
against the one printing the report, and `Wired build` names the build
your agent's launcher and hooks actually point at. Versions are named,
never ranked — the retired tree-era codebase called itself 2.0.0, and
every `0.1.0-rc.N` is newer than it.

**Two treecontexts on one machine.** A global install and a checkout, or
two checkouts, each with its own `install` history. `doctor` from either
one tells you what the other is (`Command on PATH`) and which of them
your agent is wired to (`Wired build`). A `fix:` under either row leads
with the one command that clears it, and an `install --force` is spelled
through this build's own entry point whenever typing `treecontext` would
run the other one.

**The node count never grows (capture isn't running).** Confirm you
restarted Claude Code after `treecontext install`. Then check the hook
scripts exist in `~/.claude/hooks/` and that `~/.claude/settings.json`
lists them. `treecontext doctor --dump-logs` prints recent hook activity.

**`node: command not found` in hook output.** Hooks run in a minimal
environment that may not have your version manager's shims. The installed
wrappers already try the interpreter install verified (one proven to
load the native module), then `PATH`, then nvm/fnm locations, then the
interpreter that ran the install. If you switched Node versions after
installing, re-run `treecontext install --force`.

**`better-sqlite3` failed to build.** Install the platform build tools from
§1 and reinstall. `treecontext doctor` reports this explicitly.

**The MCP server doesn't appear in your agent.** Ask the agent, not the
file: `claude mcp get treecontext` should report *Connected* at user scope.
If it reports nothing, check that `~/.claude.json` contains a `treecontext`
entry under `mcpServers`, and run the command in it by hand — it should
start and wait silently on stdin. Errors there are the real cause.
(0.0.9-beta wrote this entry to `~/.claude/.mcp.json`, which Claude Code
reads at no scope; upgrading moves it and clears the dead one.)

**Claude Code's log shows treecontext lines as errors.** Claude Code
records every line an MCP server writes to stderr as an error in its own
debug log, whatever the line says. A serving treecontext is therefore
silent on stderr when it is healthy (D258): a line there *is* a warning
or an error, and worth reading. Its diagnostics — the startup facts, the
drain's ticks, the shutdown — go to the log file under
`~/.treecontext/logs/`, and `treecontext doctor --dump-logs` prints them.
Hooks serve no client, so their diagnostics still go to stderr by design.

**Entries marked `[capture gap]`.** Not a bug: the journal recording its
own holes where an event was dropped or failed to ingest. Trust them over
assuming the record is complete.

**Retrieval feels slow.** Ask the agent to run `treecontext_status` — the
`retrieval` block shows the store size and this session's query latency,
and suggests the fix when latency is genuinely high. The lever is the
`TREECONTEXT_INDEX_CAP` environment variable (set it where your agent and
its hooks run): new captures index at most that many characters per entry
— `8000` is the measured sweet spot, keeping recall within noise of full
indexing at about a third of the query cost on pathological input. Stored
text is unaffected, existing entries keep their view, and unsetting it
restores the defaults (tool events 8000, user/assistant full).

## 9. Reporting beta issues

Please open an issue at
[bingh0/treecontext-mcp/issues](https://github.com/bingh0/treecontext-mcp/issues)
and attach:

```bash
treecontext doctor              # full output
treecontext doctor --dump-logs  # recent hook/server logs
```

Redact anything sensitive first — the log dump can contain fragments of
your session. Most useful of all: what you expected the agent to remember,
and what it actually did.

## 10. Uninstall

```bash
treecontext uninstall     # removes MCP entries, hooks and skill from every agent
npm uninstall -g treecontext-mcp
```

Narrower forms, when you want to keep most of the setup:

```bash
treecontext uninstall --agent vscode              # one agent only
treecontext uninstall --agent vscode --hooks-only # drop its hooks, keep the MCP tools
```

`--hooks-only` is what `doctor` offers for hooks left behind on a platform
`install` does not manage: the stale hooks go, the working MCP registration
stays.

**Neither command touches your journals.** They stay at
`~/.treecontext/stores/`. To remove those too:

```bash
rm -rf ~/.treecontext        # Windows: rmdir /s "%USERPROFILE%\.treecontext"
```

## 11. Using it as a library

The MCP server is one consumer, not a gatekeeper — any Node program that
opens the SQLite file gets the same journal:

```ts
import BetterSqlite3 from 'better-sqlite3'
import { FlatStore } from 'treecontext-mcp'
import { wrapBetterSqlite } from 'treecontext-mcp/persistence/node'

const store = await FlatStore.open({
  database: wrapBetterSqlite(new BetterSqlite3('journal.db')),
  ownsDatabase: true,
})
await store.insert('Decision: archive before delete — see retentionSweep')
const hits = await store.query('archive delete decision', { topK: 5 })
```

The package is ESM-only — there is no CommonJS build, so `require()`
consumers are out. TypeScript consumers need `moduleResolution` set to
`node16`, `nodenext`, or `bundler` for the subpath exports
(`treecontext-mcp/persistence/node`, `treecontext-mcp/server`) to resolve.

## 12. What this deliberately isn't

The promises live in owner-language Gherkin under
[`features/`](features/), run end-to-end against a live store:
real hook payloads in, direct SQLite inspection out. Declined scope is a
first-class artifact —
[`features/OUT-OF-SCOPE.md`](features/OUT-OF-SCOPE.md) records
every option raised and ruled out, with the reasoning.

Notably absent, on purpose: semantic/vector search, a hierarchical summary
tree, and a code index. Each was built, benchmarked against this exact
workload, and deleted. What survives is the minimum that does the job.

## License

MIT — see [LICENSE](LICENSE).
