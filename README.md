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

> **This is a public beta (`0.1.0-beta.4`).** It installs from npm under
> the `beta` dist-tag, as `treecontext-mcp@beta`. The store schema may still change between beta
> releases; migrations are additive, but treat your journal as replaceable
> for now.

---

## 1. Requirements

| | |
| --- | --- |
| **Node.js** | 24.16 or newer — check with `node -v` |
| **Claude Code** | the CLI, the VS Code extension, or both |

`treecontext` has no native dependency and no install script: the
database is Node's built-in `node:sqlite`, so installation needs no
compiler on any platform, and nothing to approve under npm's
install-scripts policy. The floor is 24.16 because that is the first Node
whose `node:sqlite` loads without an experimental warning and reads text
with an embedded NUL intact. A Node built against a system SQLite without
FTS5 (some distribution packages) cannot run treecontext; `treecontext
doctor` says so on its SQLite row — install Node from nodejs.org or a
version manager instead.

## 2. Install

Two commands. The first puts the `treecontext` command on your PATH; the
second wires it into your agent. Run both before you check anything:
`doctor` reports the agent as not set up until the second has run.

### macOS / Linux

```bash
npm install -g treecontext-mcp@beta
treecontext install
```

### Windows (PowerShell)

```powershell
npm install -g treecontext-mcp@beta
treecontext install
```

`treecontext install` also turns Claude Code's idle compaction off, because
the client summarising an idle session throws away the prompt cache the
journal exists to keep; turn it back on in the client's `/config` row
(Idle compaction, Claude Code 2.1.302 and later) or with
`"idleCompaction": true` in `~/.claude/settings.json`.

Section 3 says what `treecontext install` writes and how to audit or
restrict it; section 4 checks that it all landed.

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

First, **quit every running session** — every Claude Code session and
every VS Code window with an agent in it — and only then upgrade. A
server from the older release keeps running against your store until
its session ends, and the new release migrates the store the first time
it opens it. From `0.1.0-beta.2` on, a server that finds its store
migrated past it steps aside: it stops draining and tells the agent to
restart the session, so a `0.1.0-beta.2` server left running beside a
store `0.1.0-beta.3` has migrated stops draining until you restart it. A
`0.1.0-beta.1` server has no such step-aside: left running beside a store
`0.1.0-beta.2` migrated, it kept draining, but without beta.2's
re-indexing of treecontext's own echoes, so the echoes it drained were
indexed with their results until a beta.2 server healed them. Quit first
and none of it happens.

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
and any stale interpreter paths. In each agent's treecontext entry it
rewrites only what install owns (the command, its own flags, Codex's
worker variables) and keeps what you added — a pinned `--store`,
`--instructions none`, approvals, an `env` block — and `--force` keeps
them too: it rewrites what install owns even when it is valid, nothing
more. To start from the default entry, run `treecontext uninstall
--agent <name>` and then `treecontext install`. Before rewriting a Codex
`config.toml` it keeps the file as it was beside it
(`config.toml.treecontext-bak-<UTC timestamp>`), since the rewrite does not keep comments. Store migrations run automatically the
next time the server opens your store and are additive — but per the
beta caveat above, treat the journal as replaceable between beta
releases anyway. The re-run also refreshes the installed reference skill
text (`doctor` says "skill outdated" until it does). Coming from
`0.1.0-beta.2`, the re-run is also what writes `"idleCompaction": false`
(§3), refreshes the skill's lane and key-lookup sections, and adds the
worker variables (`env_vars`) to an existing Codex CLI entry; until you
re-run it, Claude Code keeps summarising idle sessions.

**Upgrading to `0.1.0-beta.4`.** Re-run `treecontext install`. What an
upgrade changes:

- The store's schema moves from v32 to v36 (migration 033: a headless
  worker's notes dedup within its own lane; migration 034: a staged tool
  call carries the client's id for it and how it ended; migration 035: a
  worker's registration records which numbering of processes its process
  id belongs to; migration 036: a staged tool call carries the client that
  stated it succeeded) the first time a beta.4 server opens it, after the
  automatic copy of the store as it was,
  `treecontext.db.pre-migration-v32.bak` beside it. All four migrations are
  additive and change no existing row. `0.1.0-beta.3.1` then refuses the
  store (`SchemaVersionError`: the store is newer than the build), so going
  back to beta.3.1 means restoring that copy, without what was written
  after the upgrade.
- It wires two more Claude Code hook events, `PostToolUseFailure` and
  `PostToolBatch`, so a failed call and a call the client resolved without
  running it are journaled (before beta.4 neither was journaled at all);
  until you re-run install, doctor's "capture events" row names them, with
  `treecontext install --force --agent claude`. Between the re-run and the
  first time a beta.4 server opens the store, a failed call is journaled
  without its `outcome` and `tool_use_id` marks, and a call the client
  resolved without running it is not journaled.
- Claude Code's hook commands now name their client (`--client
  claude-code`), and a call Claude Code says succeeded is classed a success
  whatever its output says ("error: 0 found, 0 failed", a traceback in a
  file it read, an MCP reply saying "failed"); each classified entry says
  what decided its class (`exit_by` `client` or `text`), and the trail
  pane's exit rows say how many of their events each decided. A command
  that names no client states nothing, and its calls are classed by their
  text as before: until you re-run install, doctor's "exit classes" row
  names the commands an earlier build wrote. Entries drained before the
  upgrade keep their class.
- A headless worker run inside a sandbox that numbers its own processes
  (Codex CLI's on Linux, bwrap, `unshare --pid`) is no longer taken for
  gone by a reader outside it, nor a worker outside by a reader inside
  one: a reader that cannot see the worker's process leaves it live and
  the key lookup says so. That holds whether or not the sandbox mounts a
  /proc of its own, and a door in a sandbox with no /proc at all records
  that it could not read its numbering, so no reader judges its worker; a
  reader with no /proc judges no worker at all. A start moment read in a
  time namespace whose clock since boot is shifted (`unshare --time`) is
  never compared with one read outside it: such a worker is judged only
  by whether its process exists. A
  worker registered by beta.3.1 or an earlier beta.4 records no numbering
  and is judged only by a reader in the machine's own numbering. A worker
  this build's door started that a reader took for gone is set right when
  the door reports how it ended (or when it is sent back, or when a
  damaged ticket's worker writes its one row), keeping when and by what it
  was taken for gone. A worker an earlier build's door started is not: if
  a sandboxed worker of beta.3.1 or an earlier beta.4 is still running
  when you upgrade, a beta.4 reader outside its sandbox can take it for
  gone, and its own door, which never sets a phantom right, then writes
  its summary row beside a registration that keeps reading `phantom`.
  Let such workers finish before upgrading.
- Known limit: a reader decides that a sandbox has ended (and retires its
  worker as a phantom) only when its own numbering of processes is the
  machine's and its /proc is that numbering's. A reader whose processes
  are numbered apart from the machine's (WSL2, whose distributions run in
  a numbering of their own, or any container that does not share the
  host's) never sees a sandbox end, so a worker whose sandbox was killed
  together with its door stays live there until a reader in the machine's
  own numbering looks. A reader whose /proc hides other users' processes
  (mounted `hidepid`, and the reader not root) is treated the same way:
  it reads the mount's options and takes no sandbox's end from what it
  does not see (read from the mount table; a machine /proc mounted
  `hidepid` was not tried, as that needs root). A worker whose start was
  read in another time namespace, or on a kernel with no time namespaces
  (before 5.6), is never told from a successor that took its process id
  while that id is held, so it stays live until the id is free. It errs
  toward leaving a gone worker live, never toward retiring a running one.
  Reused namespace numbers err the same way.
- It writes tool approvals into Claude Code, Codex CLI and Antigravity CLI
  (§3), so a headless worker can read and write the journal. The way back:
  `treecontext config tool-approvals off|on [--agent claude|codex|agy]`, or
  `treecontext install --no-tool-approvals`. A chosen off is kept by every
  later install.
- It rewrites Codex's `config.toml`, which does not keep comments, after
  keeping the file as it was beside it, as
  `config.toml.treecontext-bak-<UTC timestamp>`.
- It writes Codex CLI's own hooks into `~/.codex/hooks.json` from Codex CLI
  0.167.0, beside your own hooks, and starts Codex's server in capture mode
  (§6, "Codex CLI capture"); Codex runs them once you trust them with
  `/hooks` in Codex. Below 0.167.0, or where `codex --version` cannot be
  read, Codex stays tools-only and its entry carries `--no-capture`. One
  rule holds for Codex: treecontext's hooks are in `~/.codex/hooks.json` if
  and only if Codex's entry starts the server in capture mode, since hooks
  that are written can run and only a capture-mode server drains what they
  stage. Install asks Codex about that file from an empty directory, so a
  project whose own `.codex/config.toml` turns hooks off decides nothing for
  your other projects; where Codex itself loads none of treecontext's hooks
  (`[features] hooks = false`, a managed policy), the hooks stay, install
  says Codex runs none of them now and what turns them on, and never says
  capture is running. A take-back the file refuses (read-only) leaves the
  entry in capture mode, at install and at uninstall, which then fails and
  says so. Install changes `hooks.json` by inserting its own groups and
  taking out its own, never by rewriting the file: every hook of yours
  keeps its text (a large number, an escape, your spacing and key order),
  so Codex keeps trusting it. A `config.toml` you made read-only is a
  refusal before anything of Codex's is written; a symlinked one is written
  through to its target, the link and mode kept. Where `CODEX_HOME` is set,
  install, uninstall and doctor use that directory and name it; one that
  does not exist (Codex itself refuses to start then) gets nothing written
  and is said. Cursor and VS Code keep capture where they run the Claude
  Code hooks.
- `--experimental-capture` is gone: install refuses it in any form, before
  writing anything, since each captured client is now wired by default from
  its version floor. A reinstall turns the copy of the Claude Code block an
  earlier build wrote under that flag into Codex's own block, and uninstall
  still takes that copy back.
- `--force` keeps your additions to an entry; it rewrites what install
  owns and nothing more. To start over, run `treecontext uninstall --agent
  <name>`, then `treecontext install`.
- Gemini CLI is retired (Google deprecated it for Antigravity CLI): install
  no longer detects or wires it, and doctor gives it no client row. `treecontext uninstall --agent gemini`
  removes the entry, the copied hooks and the `tc-gemini-*` wrappers an
  earlier install left (a full `treecontext uninstall` does too), keeping
  every other key of `~/.gemini/settings.json`; doctor names them while
  they are there. `~/.gemini/GEMINI.md` is Antigravity CLI's.
- Claude Code is detected by its `claude` command or its own files, no
  longer by the `~/.claude` directory alone (install's own launcher lives
  there). `treecontext doctor` reports a Claude Code wiring an earlier
  install left where Claude Code is not present, and names
  `treecontext uninstall --agent claude`.

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
| `~/.claude/settings.json` | registers 9 hooks: `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Stop`, `PreCompact`, `SubagentStart`, `SubagentStop` (the three tool events run one script, `tc-post-tool-use`); and sets `"idleCompaction": false` when the key is absent (see below) |
| `~/.claude/hooks/tc-*` | the hook wrapper scripts themselves (`.cmd` on Windows) |
| `~/.claude/skills/treecontext-reference/SKILL.md` | the reference skill your agent loads on demand |
| `~/.claude/settings.json` (again) | `permissions.allow` gets `mcp__treecontext__treecontext_status`, `_query`, `_export` and `_insert`, the tool approvals below |
| `~/.codex/config.toml` | where Codex CLI is detected (or on its own with `--agent codex`): the treecontext MCP entry, with `[mcp_servers.treecontext.tools.<tool>] approval_mode = "approve"` for status, query, export and insert |
| `~/.codex/hooks.json` | from Codex CLI 0.167.0: Codex's own hooks, in groups of their own after yours, for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `Interrupt`, `PreCompact`, `SubagentStart` and `SubagentStop`, each running the `~/.claude/hooks/tc-*` scripts with `--client codex`; Codex runs none of them until you trust them with `/hooks` in Codex |
| `~/.gemini/config/mcp_config.json` | where Antigravity CLI is detected (or on its own with `--agent agy`): Antigravity CLI's MCP entry |
| `~/.gemini/antigravity-cli/settings.json` | where Antigravity CLI is detected (or on its own with `--agent agy`): `permissions.allow` gets `mcp(treecontext/<tool>)` for status, query, export and insert |
| `~/.gemini/GEMINI.md` | the instruction block of Antigravity CLI |
| `~/.treecontext/config.toml` | treecontext's own settings |
| `~/.treecontext/install-state.json` | install's record: the `idleCompaction` key it wrote and in which settings file, the tool approvals it wrote in each client's file, your choice to turn them off, and the files it created (Antigravity CLI's), so uninstall and `config tool-approvals` remove only what install wrote |

For each other agent it detects (or the one `--agent` names) install
writes that client's MCP entry; Codex CLI's, in `~/.codex/config.toml`, also
lists `env_vars = ["TREECONTEXT_TICKET", "TREECONTEXT_WORKER_SESSION"]`,
so a `codex exec` worker's rows reach its lane (§5, "Running work as
legs").

**Tool approvals.** A headless worker cannot answer a prompt, so install
approves the four tools that read and write the journal (`treecontext_status`,
`_query`, `_export`, `_insert`) in Claude Code, Codex CLI and Antigravity
CLI, and says so in one line. The four that remove or bring in rows
(`_clear`, `_delete`, `_import`, `_merge_from_agent`) keep asking, so a
headless worker is refused them. A rule of your own, allow, ask or deny, or
a default for the server, always wins: install never writes over one and
never removes one. To take the approvals back and put them back:

```bash
treecontext config tool-approvals off [--agent claude|codex|agy]
treecontext config tool-approvals on  [--agent claude|codex|agy]
treecontext install --no-tool-approvals
```

`off` removes exactly what install wrote. A chosen off is kept by every
later install until you say `on`.

On Windows, `~` means `%USERPROFILE%`. Existing config is merged, not
overwritten — your other MCP servers and hooks are left alone, and a
corrupt config file is kept beside itself as `<file>.bak` (a dated
`<file>.bak-<UTC timestamp>` where that name is taken, never over an
earlier backup) before a fresh one is written; a dry run moves nothing,
and a backup that cannot be made refuses the write.

**Idle compaction.** `treecontext install` turns Claude Code's idle
compaction off, by writing `"idleCompaction": false` into
`~/.claude/settings.json`, and says so in one line. The client otherwise
summarises a long conversation while the session sits idle; that replaces
the checkpoint-then-`/clear` boundary and throws away the prompt cache the
journal exists to keep. To turn it back on, change the **Idle compaction**
row in the client's `/config` (Claude Code 2.1.302 and later), or set
`"idleCompaction": true` in that file (the only way on 2.1.290 to 2.1.301,
which read the key but have no row). Install writes the key only when it is
absent and the client reads it (2.1.290 and later), so a value you set,
on or off, is never touched; on an older client, or one whose version
cannot be read, it writes nothing and says the setting is not applicable,
and an install run after you upgrade writes it then. Install says nothing
about a key you set, on any run. `treecontext uninstall` takes out the key
install wrote, only while the file still holds that value. `treecontext doctor`
carries the setting on its own row, and warns while it is on.

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

First, from any directory:

```bash
treecontext doctor
```

Every row should be `[ok]`. A `[warn]` row carries the command that
fixes it; on a machine where nothing is wired yet, the first line after
the header says so and names `treecontext install`.

Then start a new session in any project and ask your agent to run
`treecontext_status`. You should see a store name, a path, and a node
count. Do a few turns of ordinary work, then run it again — **the node
count should have grown**. That is capture working.

Then confirm recall: ask the agent something like *"search your journal for
what we did earlier."* It should call `treecontext_query` and come back
with your own earlier messages.

**Checking capture against the client.** `treecontext doctor` reports a
Claude Code wired by an older build (a capture event added since) with the
command that wires it. To check what was actually journaled, run
`npm run dogfood:census -- --transcript <session.jsonl>` from a checkout of
this repository: it counts a real Claude Code session's tool calls (its
transcript, subagents included) against the store. A call matched by the
client's call id is observed; one matched by session, tool, time and input
text (a call from before ids were stored, or a deduplicated one) is inferred
and unverified. It exits 0 only when every call is observed, 1 when a call is
missing, 3 when some are only inferred. `--live` runs one headless session
with a success, a failure and a refusal of each kind against the installed
build (it writes a store and a binding under `~/.treecontext` and a
transcript under `~/.claude/projects`; `--help` names the command that
removes the store). The repository's list of Claude Code's hook events
(`tests/fixtures/claude-code-hooks/events.json`) is held against what install
wires and what the recordings show, but nothing mechanical sees an event the
client has that neither names, so the hooks reference is re-read at every
client upgrade; `--live` prints a reminder when the client's version differs
from the list's.

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
  treecontext"* works and is a good habit. The stop hook also asks it
  for a short bookmark now and then; `treecontext config
  checkpoint-interval "30 minutes"` sets how often, for this directory's
  store (`"20 rounds or 45 minutes"` is the default, `"off"` stops it).
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
- **Capture is verified live on Claude Code, and on Codex CLI from 0.167.0
  with its hooks trusted.** A teammate on Antigravity CLI, Cursor, VS Code
  or OpenCode, or on an older Codex, gets the tools: they can search and
  write notes, but nothing of their session is captured for them (§6).
- **The main checkout is a lane like any worktree.** In the main checkout
  or a linked worktree, `treecontext_status`, the fresh-start packet and
  the orientation search are scoped to the session's own lane: its own
  chapters and bookmarks, its helpers' reports (a subagent's summary, a
  worker's return) and the handoffs imported there, never a helper's tool
  calls. Other lanes are counted (`other_lane_count`) and at most three are
  named, never their text; `scope: "all"` widens a search or the status.
  After a restart your own chapter is among the orientation search's
  results (it may be given the last place of a page of two or more), not
  promised first. A row belongs to the checkout its session ran in,
  stamped or not, rows a program writes through the library under that
  session's id included; a program writing with no session writes into
  main's lane, an unstamped row under a session that ran in no checkout
  (a headless worker's) shows as "writer unknown", and a session run
  outside any git checkout counts as the main checkout. A caller the server cannot place, such as a client
  without hooks, is stamped `unregistered` and shows as "writer unknown":
  a lane of its own, never main's. While no session has run in the main
  checkout, such a client may retire a pre-stamp chapter of main: a live
  chapter summary naming no writer (no stamp, no `agent_type`) from a
  session the registry never held, whoever wrote it; never a bookmark, an
  import or a read-only entry. Each retirement is recorded on the entry
  (who, what, when, how) and listed in the reply as `retired_across`. A
  headless worker started by `treecontext run` searches the whole store.
  The recovery snapshot is claimed only in the lane it was written for. A
  client running the Claude Code hooks registers its sessions and claims
  in its own lane, and so does a Codex CLI main running the hooks install
  writes for Codex.

### Running work as legs

When a task is split across subagents or headless workers, treecontext
can journal it as one unit, so each new worker starts from where the last
one stopped.

- A **run** is one piece of work, under a name you choose (`login`).
- A **key** is one strand of work inside a run, handed from one worker
  to the next (`parser`).
- A **leg** is one subagent or headless worker doing part of a run under
  a key.
- A **checkpoint** is the state of a key's work as it now stands, written
  by a leg so that the next leg starts from it. The store numbers each one
  as it lands (1, 2, 3, …), and refuses one longer than 16000 characters
  the first time.

**Write a brief first.** The main agent writes it with `treecontext_insert`:

```json
{
  "content": "Write the token parser for the login form. Checkpoint what is done and what is next.",
  "metadata": { "kind": "brief", "run": "login", "key": "parser",
                "brief_for": "parser-dev", "checkpointer": "parser-dev" }
}
```

`brief_for` is the role the brief is for: a Claude Code subagent type, or
the `--role` of a headless worker. `checkpointer` is the role that writes
the key's checkpoint at the end. A brief stays in effect until a newer
brief for the same role and key names it in `supersedes`, or until the run
closes (`treecontext_insert` with metadata `kind: "run-close"`, `run` and
`reason`). The run opens by itself when its first leg starts.

**A subagent leg (Claude Code).** When a subagent starts, the SubagentStart
hook looks for a brief in effect for its role. With none, no leg is made:
the subagent runs exactly as before. With one, it is a leg of that brief's
run and key, and it starts with the brief, the checkpoint(s) in effect,
each one whole with its number, writer and time, and a line saying that a
checkpoint is state, not history. (With two or more, its key stays open
until its first write under one of them.) It writes its checkpoint with
`treecontext_insert`, metadata `kind: "checkpoint"`, `run` and `key`; the
store links it to the checkpoint the leg started from. When the leg
stops, its report is kept as its summary row, and the Agent tool's result
gains one line naming that row. A background launch
(`run_in_background`) gets no such line: its return arrives as Claude
Code's task notification. A leg named as the checkpointer that wrote under
its key and stops without a new checkpoint is sent back once to write it,
never twice.

**A headless worker (`treecontext run`).** The ticket door spawns any
command as a worker, with its run, role and key in its environment:

```bash
treecontext run --run login --role parser-dev --key parser \
  --parent build-script --checkpointer parser-dev \
  --prompt "Start with the tokenizer." \
  -- claude -p --model sonnet
```

- `--run`, `--role` and `--parent` are required, and so is `--key` (or
  `--no-key` for a one-off worker). `--parent` names who spawned it: a
  session the store has registered is linked, and any other name is
  recorded as declared. `--checkpointer` is optional when a brief names
  one.
- The worker's first message (the brief, the checkpoint(s) in effect,
  then `--prompt`) goes to its stdin. `--message-arg` puts the message
  last among the worker's arguments instead, for a CLI that takes its
  prompt as an argument (see "Headless workers" below).
- The worker writes its checkpoint through its own treecontext tools, as
  a subagent does. Its stdout passes through unchanged. When it exits,
  that output becomes its summary row, and one line on stderr, starting
  `treecontext:`, says how it ended. The exit code is the worker's own.
  A worker that owes a checkpoint and exits without one is run once more
  to write it. `--timeout <seconds>` ends the worker and its process
  group (Linux, macOS; see the limits under "Headless workers").
- Codex CLI (`-- codex exec`) and Antigravity CLI (`-- agy -p`) run
  as workers too; see "Headless workers" below.

**Ask the store where a key stands.** `treecontext_query` with
`key_lookup: { "run": "login", "key": "parser" }` returns, instead of
search hits: the checkpoint(s) in effect, each whole with its number and
writer; a flag in words when the writer is not the checkpointer the brief
named, or the checkpoint was imported; a pointer to the summary row of the
leg that wrote it; the run's facts (legs run, keyless legs, checkpoints
under the key, the run's age, the latest sizes); and each leg, live or how
it ended. The store judges none of it. A harness gets the same reply from
the library, `FlatStore.lookupKeyReply({ run, key })`.

**Export a run as a unit.** `treecontext export handoffs/login-run.json
--run login` writes that run's skeleton: the open and close, every brief,
every checkpoint, each leg's first moment and summary, and the legs'
registrations, with no captured tool output. The one exception is a
worker that failed or printed nothing: its summary row holds the end of
its error stream, where a CLI may write command output, and the export's
reply and the file's head name each such leg, nothing redacted.
`--run login --whole --yes`
adds every row of every leg, after the same secrets warning. The agent
does the same with `treecontext_export` and `run` (`form: "whole"` with
`secrets_acknowledged: true`). Importing the file puts the run in a lane
of its own as a record of what happened elsewhere, never a replay: an
imported brief steers no role, and an imported checkpoint takes no number
in your sequence.

### Headless workers

`treecontext run` starts any command as a worker. The line is the same for
every CLI; only what follows `--` changes:

```bash
treecontext run --run R --role ROLE (--key K | --no-key) --parent <session> \
  [--checkpointer ROLE] [--timeout S] [--prompt-file F] -- <command>
```

**Claude Code (`claude -p`).**

```bash
treecontext run --run login --role parser-dev --key parser --parent build-script \
  --prompt-file task.md -- claude -p --model sonnet
```

- Install approves the four tools in `~/.claude/settings.json`, so the line
  needs no `--allowedTools`. If you use that flag anyway, it takes several
  values and swallows a prompt that follows it: put the prompt first, or
  use `--prompt-file` (the prompt then travels on stdin and nothing follows
  the flag).
- Left to you: nothing. Doctor's Claude Code row says the worker can use the
  tools in its "tool approvals" clause.

**Codex CLI (`codex exec`).**

```bash
treecontext run --run login --role parser-dev --key parser --parent build-script \
  --prompt-file task.md -- codex exec -m <model> -s read-only -
```

- The `-` at the end makes Codex read its prompt on stdin, where
  `treecontext run` puts it.
- Install writes the MCP entry with the worker variables forwarded
  (`env_vars = ["TREECONTEXT_TICKET", "TREECONTEXT_WORKER_SESSION"]`; a
  hand-written entry needs that line too) and the four approvals
  (`approval_mode = "approve"`, §3).
- Left to you, on Linux only: Codex's sandbox runs on bubblewrap. On Ubuntu
  24.04 and later (`kernel.apparmor_restrict_unprivileged_userns=1`) it
  also needs an AppArmor profile that lets `/usr/bin/bwrap` create user
  namespaces. Write this to `/etc/apparmor.d/bwrap`:

  ```
  abi <abi/4.0>, include <tunables/global> profile bwrap /usr/bin/bwrap flags=(unconfined) { userns, include if exists <local/bwrap> }
  ```

  and load it with `sudo apparmor_parser -r /etc/apparmor.d/bwrap`.
  treecontext changes no system file. Doctor's "Codex sandbox" row runs
  `codex sandbox -- true` and says whether the sandbox is ready.
- Doctor's Codex CLI row carries a "headless workers" clause that says
  whether the entry forwards the variables and approves the tools.
- A model hint, a docs fact for Codex 0.167: the read-only sandbox is
  described to the model as a read entry `:root`, and its tools sit inside
  a JavaScript `exec` tool. A cheap model at low effort misread both until
  the prompt said "you can read any file; call `exec` and use
  `tools.exec_command` inside it".

**Antigravity CLI (`agy -p`).**

```bash
treecontext run --run login --role parser-dev --key parser --parent build-script \
  --message-arg --prompt-file task.md -- agy --model <model> --output-format text -p
```

- `--message-arg` puts the message last, because agy takes the prompt as
  the value of `-p` itself.
- Install writes the MCP entry in `~/.gemini/config/mcp_config.json` and
  the four allow rules, `mcp(treecontext/<tool>)`, in
  `~/.gemini/antigravity-cli/settings.json`. Left to you: nothing, for the
  four journal tools.
- Any other tool depends on agy's own permission preset, `toolPermission`
  in `~/.gemini/antigravity-cli/settings.json` (agy 1.5.3 names
  `always-proceed`, `request-review` and `strict`). Under `always-proceed`
  every tool runs unasked. Under any other preset, or with the key absent,
  a tool no rule of agy's allows, a shell command among them, may be
  refused in a headless run: agy then ends the turn with no reply, prints
  nothing, exits 0 and writes one line on its error stream ("no output
  produced — a tool required the ... permission"), and fires no further
  hook, so the refused call leaves no journal entry. The worker's summary
  row carries that line. Allow the tools the worker needs, or give that
  one run the preset with agy's session-only `--settings`.
- Doctor's Antigravity CLI row, in its "headless workers" clause, says
  whether the entry and the rules are there, and which permission preset
  agy has and what it means for a worker.

**What a worker may do.** A worker reads and writes the journal: status,
query, export and insert. Clear, delete, import and merge still ask, so a
headless worker's request for them is refused.

**A worker skips orientation.** Its server hands it the worker card, and
the instruction block names the door's opening lines, so the worker begins
from its first message and runs no orientation. Measured on the
dogfood machine (2026-11-08, Codex 0.167.0, gpt-6-luna at low effort, the
same one-insert task): a main `codex exec` session oriented first and used
131,852 input tokens; a ticket-door worker went straight to the insert with
62,829, about 52% fewer.

**How a failed run reads.** A worker that exits non-zero or prints nothing
gets a summary row carrying its exit code and the end of its error stream,
the last 2,000 characters, marked when cut. Codex given a model its account
does not have left this row:

```
treecontext: the worker exited with code 1 having printed nothing; its error stream, all 1200 characters of it:
…
ERROR: The 'no-such-model-xyz' model is not supported when using Codex with a ChatGPT account.
```

Abridged here: the stream was 1,200 characters, all of them in the row, and
only its end is shown.

**The environment.** The door hands a worker none of its spawner's Claude
Code session variables: `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`,
`CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_PID`, `CLAUDE_CODE_MESSAGING_TOKEN`
and `CLAUDE_CODE_MESSAGING_SOCKET`; the rest of the environment, your
configuration and credentials included, passes unchanged. A worker's
stderr is a pipe, so CLIs that colour only on a terminal write plain text.

Variables the scrub keeps by design, because they name no session and open
no channel back into one: `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_USE_BEDROCK`,
`CLAUDE_CODE_USE_VERTEX`, `CLAUDE_EFFORT`, `CLAUDE_CODE_ENTRYPOINT`,
`CLAUDE_CODE_EXECPATH` and `CLAUDE_CODE_SESSION_ATTENDED`. The scrub is the
door's rule (`treecontext run` or the library's `spawnWorker`). A spawner
that sets `TREECONTEXT_TICKET` itself and launches the CLI directly is not
the door and must scrub its own environment.

**Things to know about a worker's end.**

- Stderr is a pipe. When something the worker started still holds it, the
  door waits up to 2 s after the worker exits. After the run ends the door
  keeps passing that stderr on, so a background process the worker started
  that keeps writing there is not sent SIGPIPE, for as long as the
  spawner's process lives. `treecontext run` exits when its run ends, so
  under the wrapper such a process should still redirect its stderr.
- A worker the door itself signals (its `--timeout`, or the spawner's
  abort) is a cut whatever its exit code: no summary row, no send-back,
  and the next leg is a recovery leg.
- On Linux and macOS a cut, and any end of the worker by a signal, whoever
  sent it, also ends the worker's process group: what it started that is
  still in that group gets SIGTERM, then SIGKILL after a short grace
  (currently about a second, not a promise). On
  Windows only the worker itself is ended. A process that left the group
  (`setsid`, a detached spawn) is not reached.
- A failed run's summary row keeps the end of stderr verbatim. If a CLI
  prints secrets or tokens to stderr, they land in the journal. Note that
  `codex exec` writes its whole progress transcript to stderr.

**A dispatcher for Claude Code.** treecontext installs no skill for this.
If you want a one-word way to hand a task to a worker from inside Claude
Code, a shell function is enough. It writes the task to a file and runs the
worker read-only, with no bypass flag:

```bash
tc-worker() {   # tc-worker <run> <role> <key> "<task>"
  local f; f="$(mktemp)"; printf '%s\n' "$4" > "$f"
  treecontext run --run "$1" --role "$2" --key "$3" --parent "${CLAUDE_CODE_SESSION_ID:-dispatcher}" \
    --timeout 600 --prompt-file "$f" -- codex exec -s read-only -
  rm -f "$f"
}
```

Swap the command after `--` for `claude -p --model sonnet`, or for the agy
line above with `--message-arg`.

## 6. Platform support

Every agent that speaks MCP gets the eight tools, and through them the
whole journal: search, notes, export and import. **Automatic capture is
promised only where it has been verified live: Claude Code; Codex CLI
from 0.167.0 with its hooks trusted (§6, "Codex CLI capture"); Antigravity
CLI from 1.5.3 (§6, "Antigravity CLI capture").** Below 0.167.0 Codex CLI,
and below 1.5.3 Antigravity CLI, get the tools only.

### Support by client: main and worker

What is promised for each client, as the main session of a checkout and as
a worker. Claude Code is the main this project is built around; Codex CLI
and Antigravity CLI are supported first as workers.

| Client | As the main | As a worker (started with `treecontext run`) |
| --- | --- | --- |
| Claude Code | **full support**: capture through its hooks, the tools through MCP, the main placed in its checkout's lane, re-orientation after `/clear` and at a fresh start, bookmarks, subagents as legs, and workers of any CLI, Codex CLI and Antigravity CLI among them, started through the doors: the headless one, `treecontext run`, first; dynamic workflows and an external harness to follow | supported: `claude -p` |
| Codex CLI | **basic support**: capture through its own hooks (from 0.167.0) and the tools through MCP, with no promise of parity with a Claude Code main. Differences from a Claude Code main: no bookmark ask and no send-back at a turn's end; subagents are helpers, never legs; a packet after Codex's own clear and an automatic compaction are unrecorded (§6, "Codex CLI as a main: best effort") | supported: `codex exec` |
| Antigravity CLI | **basic support**: capture through its named hook (from 1.5.3) and the tools through MCP, with no promise of parity with a Claude Code main. Differences from a Claude Code main: an agy main is captured but placed in no checkout's lane (its rows read as writer unknown, found by a search of the whole store, and it registers no self); its subagents are captured as sessions of their own and not linked to it; it receives no re-orientation packet; a call agy refuses leaves no entry; a shell command's outcome is read from its text (§6, "Antigravity CLI capture") | supported: `agy -p` |

A Codex CLI or Antigravity CLI main starting workers through the doors is
not guaranteed, though the doors and lanes can carry it. What links
sessions to one another beyond the basic workflow below (a main's
identity, helpers linked to parents) is built no further for Codex CLI and
Antigravity CLI than this release has it.

### The basic workflow: a worker of any CLI, from a shell

Starting a worker with `treecontext run` from a shell is safe whichever
client is the main, or with none at all: it is no different from you
calling it by hand, and it needs no client's hooks.

```bash
treecontext run --run login --role parser-dev --key parser --parent my-shell \
  --prompt-file task.md -- <the worker's command: claude -p, codex exec -, agy -p (with --message-arg)>
```

With no hook at all, the journal then holds:

- **the worker's lane**: a session of its own, registered under the run,
  key and role its ticket names, never anyone's main;
- **its first message**: the first row of that lane, the brief and the
  checkpoint in effect composed by the ticket door, which is also the
  prompt the worker receives;
- **its summary row**: written when the worker exits, its last output (or,
  where it printed nothing, the end of its error stream), which the door's
  one line on stderr points at.

Everything the worker writes through the tools lands in its lane, stamped
with its role. Where the worker's client has its own hooks installed, its
captured calls land in that lane too (§5, "Headless workers").

The worker's client starts its treecontext server in the worker's
directory, so the tools write to the store that directory is bound to. Run
the worker from the project whose store `treecontext run` uses. Where the
two differ (a `--store` or `--project-dir` naming another store), the
door's store holds the worker's registration, first message and summary
row, and what the worker writes through the tools lands in its own
directory's store: in the session the door named (`worker-…`, the same id
in both stores), stamped with its ticket's role and marked `ticket-claim`,
since that store holds no registration for it. It is never filed as the
session of a client running in that directory.

### Compatibility matrix

What each client's own documentation says about its hooks, and the date
or release of the documentation it was checked against. "Documented only"
means exactly that: read in the vendor's docs, never run by us. It is not
a test result.

| Client | Hook events it offers | Documentation checked | Mode | Status |
| --- | --- | --- | --- | --- |
| Claude Code | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, PermissionRequest, Stop, PreCompact, SubagentStart, SubagentStop, SessionEnd, and more | hooks docs 2026-09-23; live probe 2026-09-25 on release 2.1.282; PostToolUseFailure and PostToolBatch rest on sessions recorded on release 2.1.319, 2026-11-09 (tests/fixtures/claude-code-hooks) | reads the Claude settings file as-is (it owns `~/.claude/settings.json`, where install writes the hooks: SessionStart, UserPromptSubmit, PostToolUse, PostToolUseFailure, PostToolBatch, Stop, PreCompact, SubagentStart, SubagentStop; reinstall to add the two subagent hooks and the two failed and refused call hooks) | verified live |
| Codex CLI | SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, SubagentStart, SubagentStop, Stop, Interrupt, PreModelRequest, PostModelRequest, SessionEnd (tests/fixtures/codex-hooks/events.json) | learn.chatgpt.com/docs/hooks (no date shown), checked 2026-11-10; sessions recorded on Codex CLI 0.167.0, 2026-11-09 (tests/fixtures/codex-hooks) | keeps its own hook configuration, where install writes Codex's own block from 0.167.0 (~/.codex/hooks.json beside the developer's hooks; Codex runs a hook only once it is trusted with /hooks) | verified live (Codex CLI 0.167.0, recorded 2026-11-09; from 0.167.0, its own hooks written by install and trusted by the developer with `/hooks`) |
| VS Code (Copilot agent mode) | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, SubagentStart, SubagentStop, Stop | code.visualstudio.com/docs/copilot/customization/hooks and /docs/agents/reference/hooks-reference (dated 2026-09-30) | reads the Claude settings file when its Claude-hooks setting is on (`chat.useClaudeHooks`, off by default; read as-is, matcher values ignored; also reads `.github/hooks/*.json`) | documented only |
| Cursor | sessionStart, sessionEnd, beforeSubmitPrompt, preToolUse, postToolUse, stop, preCompact, subagentStart, subagentStop, and more | cursor.com/docs/agent/hooks and /docs/reference/third-party-hooks (no date shown), checked 2026-10-05 | reads the Claude settings file by default (as-is, through its Include Third-Party configs setting) | documented only |
| OpenCode | none: JS/TS plugins only, no shell hooks | opencode.ai/docs/plugins (updated 2026-10-03) | offers no shell hooks, so the tools are its whole surface (the MCP tools; JS/TS plugins are not hooks) | documented only |
| Antigravity CLI | SessionStart, PreToolUse, PostToolUse, PreInvocation, PostInvocation, Stop (tests/fixtures/agy-hooks/events.json) | antigravity.google/docs/hooks (no date shown), checked 2026-11-08; sessions recorded on Antigravity CLI 1.5.3, 2026-11-09 (tests/fixtures/agy-hooks) | keeps its own hook configuration, where install writes a named hook of its own beside the developer's from 1.5.3 (~/.gemini/config/hooks.json, the named hook "treecontext") | verified live (Antigravity CLI 1.5.3, recorded 2026-11-09; from 1.5.3, its named hook written by install) |

VS Code and Cursor read the Claude
settings file, the two events included; how either treats
`PostToolUseFailure` and `PostToolBatch` (whether it fires them, and with
what payload) has not been checked, so their capture of a failed or refused
call is unknown. Because they run the block written for Claude Code, whose
commands name Claude Code, their tool events reach the hook as Claude
Code's, and a call either reports by `PostToolUse` is classed a success
(D404); whether either sends a failed call by an event of its own, as
Claude Code does, is unchecked.

Gemini CLI left the matrix on 2026-11-09, archived: Google deprecated it
for Antigravity CLI, and treecontext no longer wires it.

Claude Code in VS Code (the Claude extension, not Copilot) is Claude Code:
same configuration, nothing extra to do. Linux, macOS and Windows are all
supported targets.

**`install` will not write capture hooks for a platform we haven't
verified.** MCP tools are registered anywhere the agent speaks MCP —
those work regardless — but a hook entry sitting in your settings reads
as a promise that capture is running, and we won't make that promise on
a client or a version nobody has run. Codex CLI's hooks are written from
the version verified live, 0.167.0, and never below it; Antigravity CLI's
named hook from 1.5.3, and never below it.
`treecontext doctor` gives every documented client one row with three
halves: its mode (from the matrix above), the state it found, and the
remedy. Codex CLI's row reads Codex's own account of which of
treecontext's hooks it trusts; Antigravity CLI's row reads agy's hooks
file and its version; VS Code's row reads `chat.useClaudeHooks`
from VS Code's own `settings.json`; Cursor's and OpenCode's remedy is
nothing to do.

### Codex CLI capture

The minimum Codex CLI for capture is **0.167.0**, the oldest version a live
run verified. Below it, or where `codex --version` cannot be read, Codex
gets the tools only, and install takes back any hooks it wrote for Codex.
After upgrading Codex, run install again to write its hooks:

```bash
treecontext install --agent codex
```

- **The one step install leaves.** Install writes Codex's own hooks into
  `~/.codex/hooks.json`, after yours, and never into a group of yours.
  Codex runs a hook only once you trust it: open `/hooks` in Codex and
  trust each of treecontext's. Codex keys its trust by a hook's place and
  text, so install leaves a file it has nothing to change byte for byte,
  and names every hook it writes or moves, since Codex will ask to trust
  that hook again. Install never marks a hook trusted. `treecontext
  doctor` reads Codex's own account of each hook's trust (its app
  server's `hooks/list`) and says whether Codex runs treecontext's hooks,
  runs only some of them, or reports one modified since it was trusted.
  Doctor asks Codex from the project it runs in, so where that project's
  own `.codex/config.toml` turns hooks off, the row says so and names the
  file; and it warns where Codex's entry and the hooks in the file
  disagree (hooks there with an entry that does not drain them, or the
  reverse), with `treecontext install --agent codex` as the remedy.
- **What a Codex entry holds.** Each prompt, each tool call with Codex's
  id for it, and each turn's last reply, read from Codex's own `Stop`
  payload. A shell command's entry holds the one text Codex returned: no
  exit code, and no split between its output and its error stream, so its
  class (success, soft fail, error) is read from that text and the entry
  says so. A call of any other tool that fails (an MCP tool's error
  reply, a patch that did not apply) fires no result event on Codex; it is
  journaled at its turn's end as a call Codex reported no result for, with
  its input and no class, never a guess at why. A turn you interrupt
  (Esc) is kept as interrupted, with a capture-gap entry naming its reply
  as not captured: Codex puts the partial reply in no payload.
- **A Codex main** registers itself at its start, so the notes it writes
  through the tools are stamped with its lane, and is re-oriented at a
  fresh start and on a resume with the packet a Claude Code session gets.
  It gets no bookmark ask: treecontext's hooks print Codex nothing at a
  turn's end, since Codex honours a Stop hook's block and `codex exec`
  prints only the last reply. An Antigravity CLI agent receives no
  re-orientation packet.
- **A Codex subagent** is registered, retired at its stop and kept as a
  summary of the main that started it; it is no leg, since the message
  that spawned it is an opaque blob no hook can read. Its tool calls carry
  it as their writer where Codex's event names it.
- **A manual compaction** (`/compact`) leaves a recovery note: Codex's
  `PreCompact` takes the snapshot, and the next fresh start in the same
  lane claims it, as on Claude Code. An automatic compaction is
  unrecorded.
- **A `codex exec` worker** started by `treecontext run` is never a self:
  its hooks link its Codex session to the worker's lane, print it nothing,
  and its captured rows land in that lane with the worker's role as
  writer.

### Codex CLI as a main: best effort

The supported way to use Codex with treecontext is as a **worker**: Claude
Code as the main, Codex started headless through `treecontext run` (§5),
its first moment, lane and checkpoint handled by the ticket door. Codex
as the main session is best effort: what is written above works as
written, and the limits below are stated rather than worked around. They
are deepened only if users ask.

- **No bookmark ask and no send-back** from Codex's stop hook: treecontext's
  hooks print Codex nothing at a turn's end. A worker's send-back stays the
  ticket door's.
- **Subagents are helpers, never legs**: the message Codex's spawn tool
  carries is an opaque blob no hook can read.
- **`/clear` and a resume's packet are not promised.** What a Codex session
  is handed after Codex's own clear is unrecorded; a resume was recorded
  once and follows Claude Code's.
- **An automatic compaction is unrecorded**: only a manual `/compact` leaves
  a recovery note.
- **An interrupt while a call runs** keeps the call as one Codex reported no
  result for: Codex sends nothing that tells a call cut short from one that
  failed, and the partial reply is in no payload.
- **Hooks files install refuses.** Install changes `~/.codex/hooks.json` only
  by inserting its own groups and taking them out again, leaving every
  hook of yours byte for byte (a large number, an escape, your spacing and
  key order). Where its groups cannot be placed or taken out that way (an
  earlier build's hook inside a group of yours that also carries other
  settings, a key written twice in a part install must change), it changes
  nothing and says so, and Codex stays tools-only until you tidy the file.
  An empty `{}` or `[]` of yours may not come back byte for byte after an
  install and an uninstall: an empty `hooks` or event is dropped, and an
  emptied object keeps its inner whitespace.
- **Look-alike commands.** Where install's record names the hooks it wrote,
  uninstall takes back exactly those. A hooks file an earlier build wrote,
  with no record, is read by the shape of treecontext's commands, and a hook
  of yours whose command is the very same text is taken back with them;
  uninstall says when it took hooks back that way.
- **`CODEX_HOME`** is followed for `hooks.json` and `config.toml` (recorded
  2026-11-10); that Codex reads its global `AGENTS.md` from there too is
  from Codex's documentation, not verified by a live session.

### Antigravity CLI capture

The first Antigravity CLI version whose hooks install writes is **1.5.3**,
the version a live run recorded. Below it, or where `agy --version` cannot
be read, agy stays tools-only, and install takes back the named hook it
wrote. After upgrading agy, run install again:

```bash
treecontext install --agent agy
```

- **One named hook of its own.** agy's hooks file, `~/.gemini/config/hooks.json`,
  is keyed by hook name. Install writes the name `treecontext` beside yours
  and never writes, moves or removes another name; `enabled: false` set on it
  is your off, kept by a reinstall. A workspace's `.agents/hooks.json` is
  yours and never touched. A hook of yours already named `treecontext` is
  left as it is, and install writes none and says so. A hooks file that does
  not parse is left byte for byte (agy runs none of the hooks in it, yours
  included, until it is fixed). agy has no command that lists the hooks it
  loaded, so doctor reads the file.
- **Events wired:** SessionStart, PreInvocation, PostToolUse, PostInvocation
  and Stop. **PreToolUse is never wired:** its hook must answer with a
  permission decision, so it would change what agy permits.
- **What is captured:** each turn's prompt once (at its first model call,
  though agy repeats it on every event), each tool call with agy's tool name,
  its arguments and its output read from agy's transcript at the end of the
  model call that made it, and the turn's reply. A call whose output the
  transcript does not hold by the turn's end is kept and says its output was
  not captured. agy states no outcome for a shell command, so a command's
  ending is read from its text.
- **What it leaves out:** a call agy refuses in a headless run, under any
  permission preset but `always-proceed`, leaves no entry (no event fires for
  it or for the rest of that turn); an interactive refusal is unrecorded.
  agy has no subagent, compaction or failure event. A subagent's conversation
  is captured as a session of its own, not linked to the session that
  started it, and is never a leg; the parent keeps its `invoke_subagent` call
  with the result naming the subagent's conversation.
- **An agy main is best effort:** captured, but placed in no checkout's lane
  and registering no self, its notes stamped as a client no hook registered;
  it receives no re-orientation packet, and orients through the session-start
  routine of its instruction block. A worker started with `treecontext run`
  is never a self, and its captured calls land in its own lane.
- **The transcript is agy's file**, read in the layout recorded at 1.5.3;
  where agy's version is not 1.5.3, doctor names it beside 1.5.3. agy
  updates itself: it reads 1.5.5 on the machine these sessions were recorded
  on (2026-11-10), and no session of 1.5.5 is recorded.
- **Known limits:**
  - agy's own ERROR status on a transcript step is not read, so an MCP call
    agy reports as failed is classed by its text.
  - An identical second reply within five minutes in the same conversation
    is folded into the first by the journal's ordinary dedup.
  - A payload with no `workspacePaths` is journaled to a store bound to
    agy's config directory, where agy runs its hooks.
  - A hook of yours in the hooks file that is a plain string beside ours is
    not validated: install keeps it as it is.
  - A store another process holds locked costs each hook at most about six
    seconds; what could not be written then is kept as a capture gap, and a
    call agy reported but no later event of its turn settled is journaled
    when staging is purged, saying its output never reached the journal.

### Orchestration matrix

Orchestration (runs, legs and headless workers, beta.3) is a second
matrix, apart from the hook-support one above because it answers a
different question: not which hooks a client offers, but which part a
client can play. Claude Code is the primary client in beta.3; Codex CLI
and Antigravity CLI are secondary, headless workers through the ticket
door. Each cell is one of **verified live** (run on that client here),
**verified through a stand-in** (bound through the real door with a
stand-in where the client's model would be), **documented only** (read
in the vendor's docs, never run), or **not possible** (the client lacks
what the role needs; the gap is named), each with the date it was
checked. beta.3.1 targets every cell a client makes possible, verified
live; parity is this matrix filled, not a word.

The Codex CLI and Antigravity CLI worker and pen cells were first run on
2026-11-01 with the client's bypass flags (`--dangerously-bypass-approvals-and-sandbox`
for Codex CLI, `--dangerously-skip-permissions` for agy), so those runs
proved the door and said nothing about permissions. The cells below are the
2026-11-08 runs, each made under the permission mode it names.

| Client | Headless worker through the ticket door | The worker's pen (how the tools reach it) | The worker's own tool calls captured | A main that registers itself and spawns workers | Subagent legs through the hooks door | The pointer on the Agent tool's return |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | verified live (`claude -p --model sonnet` through `treecontext run` from inside a Claude Code session after the environment scrub, no `--allowedTools`, its checkpoint in its own lane, 2026-11-08) | install writes its MCP entry (verified live, 2026-11-01) | verified through a stand-in (its real hooks, 2026-11-01) | verified through a stand-in (its real SessionStart hook, 2026-11-01) | verified live (its real SubagentStart and SubagentStop hooks; on 2.1.271 and later in auto mode the report arrives through the `SubagentHandback` tool and is read from the subagent's transcript, 2.1.316, 2026-11-02) | verified through a stand-in (its real PostToolUse hook, 2026-11-01) |
| Codex CLI | verified live (`codex exec` 0.167.0 through `treecontext run`, default approvals with install's per-tool approvals, read-only sandbox, 2026-11-08) | install writes its MCP entry with `env_vars` and the four approvals (a hand-written entry needs those too; verified live: a worker's insert in its own lane, 2026-11-07, and bypass-free, 2026-11-08) | verified live (`codex exec` 0.167.0 through `treecontext run`, default approvals, with the hooks install writes, trusted with `/hooks`, 2026-11-10: the census found each of the worker's four calls, one of them failed, in its lane by Codex's call id) | verified live (Codex CLI 0.167.0, its interactive interface at default approvals, with the hooks install writes, trusted with `/hooks`: its SessionStart recorded 2026-11-09 registers the main, replayed through those hooks) | not possible: no spawn message a hook can read (Codex's spawn tool carries an opaque blob), so a subagent's brief, key and first moment cannot be told (a Codex subagent is a registered helper with a summary, 2026-11-09) | not possible: no spawn message a hook can read, so no leg is named and the spawn's return carries no pointer (2026-11-09) |
| Antigravity CLI | verified live (`agy -p` 1.5.1 in the default request-review preset, with install's persisted allow rules, no `--mode` or skip flag, 2026-11-08) | install writes its MCP entry and four allow rules (verified live, `agy -p` 1.5.1 in the default request-review preset: an insert in its own lane; a delete auto-denied as the negative control; with approvals off the insert is refused, 2026-11-08; the insert in its own lane again on `agy -p` 1.5.3, 2026-11-10) | verified through a stand-in (a ticketed `agy -p` 1.5.3's events and transcript recorded 2026-11-09, replayed through the named hook install writes for agy; the build's own live run is the release gate's) | not possible: no self registration of an agy main in beta.4 (deferred to beta.5; a worker names it as a parent no hook registered; agy 1.5.3, 2026-11-10) | not possible: no SubagentStart or SubagentStop event (agy 1.5.3, recorded 2026-11-09) | not possible: no event fires on a subagent's return (agy 1.5.3, recorded 2026-11-09) |

### Copilot capture (preview)

Copilot has no adapter of its own any more (the unwired adapters left the
build with the experimental flag, D406). VS Code reads the Claude settings
file itself when `chat.useClaudeHooks` is on, so treecontext writes no
Copilot hook file (D226): turn the setting on and the hooks `treecontext install` wrote for
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
preview; execution and external output is kept in full. On Claude Code a
call that fails is captured with the client's error text as its output
(marked `outcome` `failed`, or `interrupted`), and a call the client
resolved without running it (its input rejected, permission denied,
blocked by a hook) is captured from the client's account of the batch
(marked `captured_from` `batch`, with what the client told the model).
Every captured call carries the client's id for it as `tool_use_id`.
"In full" means in full as the client hands it over: Claude Code 2.1.319
gives a hook at most the first 30,000 characters of a shell command's
output, and for a successful call the entry also holds the path and size
of the client's own file with the rest (`persistedOutputPath`,
`persistedOutputSize`); a failed command's output arrives as about 10,000
characters, its middle cut by the client with its own marker. treecontext
does not read the client's file.

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
defaults, not the global figures. The project's root, for this file
and for the store it is bound to, is the root of its git repository, or
the project's own directory when it has none. A `.git` that is no
repository (an empty directory such as Codex CLI's sandbox leaves, or a
file git cannot read) is passed over wherever it lies, and doctor's
"Project root" row names each one it passed over.

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

Start with `treecontext doctor` — it checks Node against the floor, the
SQLite this Node carries (version and FTS5, read by opening a database),
the store directory, and each agent's configuration, and prints a `fix:` line
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
meet the Node floor and run this package), then `PATH`, then nvm/fnm
locations, then the interpreter that ran the install. If you switched Node
versions after installing, re-run `treecontext install --force`.

**`SQLite` row is an error.** Your Node's built-in SQLite lacks FTS5 (a
Node built against a system SQLite) or is too old. Install Node 24.16 or
newer from nodejs.org or a version manager; `treecontext doctor` names the
version it found.

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
The newest five log files are kept, counting the one a process has just
opened (every server start and every hook opens one); a log written in the
last five minutes, or by a process still running, is never removed, so
more than five files can sit on disk inside that window.
Hooks serve no client, so their diagnostics still go to stderr by design.

**What install's record cannot follow.** Install's record
(`~/.treecontext/install-state.json`) names each file it wrote by its
absolute path, so after your home directory moves (a renamed account, a
home restored on another machine) uninstall and `config tool-approvals`
no longer find what install wrote there, and you remove those rules by
hand, as uninstall lists them when the record cannot be read. Install
writes Codex CLI's entry to `~/.codex/config.toml` and does not read
`CODEX_HOME`, so if you set it, copy the treecontext entry into
`$CODEX_HOME/config.toml` yourself.

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
import { FlatStore } from 'treecontext-mcp'
import { openNodeSqlite } from 'treecontext-mcp/persistence/node'

// A file path, or a `DatabaseSync` you already hold (`node:sqlite`).
const store = await FlatStore.open({
  database: openNodeSqlite('journal.db'),
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
