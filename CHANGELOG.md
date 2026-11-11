# Changelog

## 0.1.0-beta.4 — unreleased

beta.4 documents headless workers and the permissions they run under (D388); the install side (tool approvals, Antigravity CLI, the worker card) is described in the entries of its other units.

- **Antigravity CLI is captured from 1.5.3, through a named hook of its own.** Install writes the hook `treecontext` into `~/.gemini/config/hooks.json` beside yours (SessionStart, PreInvocation, PostToolUse, PostInvocation, Stop; never PreToolUse, whose hook would decide a permission), by text edits that keep every byte of yours, through a symlink, never into a read-only file, and records what it wrote; `enabled: false` on it is kept. Below 1.5.3, or with an unreadable version, agy stays tools-only and what install wrote is taken back; a hooks file that does not parse is left byte for byte and said so. The prompt is journaled once per turn, each call with its output read from agy's transcript by the end of the model call that made it, the reply from the transcript; a call whose output the transcript lacks is kept and says so. An agy main is basic: captured, placed in no checkout's lane, writer unknown, no self; a subagent's conversation is its own session, never linked; an `agy -p` worker started by `treecontext run` lands in its own lane. Doctor reads agy's hooks, its version and its permission preset (`toolPermission`). Migration 037 adds `staging.client`. Each agy hook writes under one deadline from its start (about six seconds, inside the ten install writes), what it could not write going to the gap ledger, filed as agy's (a worker's lane, else writer unknown); a call no later event of its turn settled is journaled when staging is purged. The README gains a support table by client (main and worker) and the basic workflow every client shares (D413-D415, D417, D421, D423).
- **The README teaches headless workers.** A "Headless workers" section gives the `treecontext run` line for `claude -p`, `codex exec` (prompt on stdin) and `agy -p` (`--message-arg`), what install sets up for each and what is left to you, which doctor row says each is ready, what a worker may do (read and write the journal; clear, delete, import and merge still ask, so a headless worker is refused them), that a worker skips orientation (131,852 input tokens for a main Codex session against 62,829 for a ticket-door worker on the same one-insert task, 2026-11-08), how a failed run reads (exit code and the end of the error stream), the session variables the door withholds, and a short dispatcher for Claude Code. treecontext ships no skill for it. On Linux, Codex's sandbox needs bubblewrap and, on Ubuntu 24.04 and later, an AppArmor profile; the README gives the steps and doctor's "Codex sandbox" row checks them. treecontext changes no system file.
- **A worker ended by any signal takes its process group with it, on Linux and macOS.** Before, only a cut the door itself made (its `--timeout`, the spawner's abort) ended what the worker had started; a worker killed by the harness or the system left its group running. Now what is left of the group gets SIGTERM, then SIGKILL a second later (D393). On Windows only the worker itself is ended, and a process that left the group is not reached (D394).
- **The orchestration matrix names the permission mode of each live run.** The Codex CLI and Antigravity CLI cells are the 2026-11-08 runs (default approvals with install's per-tool approvals and a read-only sandbox; the default request-review preset with install's allow rules), and Claude Code's headless worker cell is verified live. The Codex CLI cell for a worker's own tool calls is the 2026-11-10 run of a ticketed `codex exec` 0.167.0 worker with Codex's hooks trusted, each of its calls found in its lane by Codex's call id. The 2026-11-01 runs had used `--dangerously-bypass-approvals-and-sandbox` (Codex) and `--dangerously-skip-permissions` (agy); the README says so.
- **§3 lists the approvals install writes** (Claude Code's `permissions.allow`, Codex's per-tool `approval_mode`, agy's two files and its `~/.gemini/GEMINI.md`) and the way back: `treecontext config tool-approvals off|on [--agent claude|codex|agy]`, or `install --no-tool-approvals`. A chosen off is kept by later installs; your own rules always win.
- **Upgrading to beta.4 is described in the README's upgrade section:** approvals written into Claude Code, Codex and agy; Codex's `config.toml` rewritten (comments are not kept; the old file stays beside it as `config.toml.treecontext-bak-<UTC timestamp>`); capture mode only where capture hooks run (a Codex or Antigravity CLI entry serves in capture mode exactly while treecontext's hooks are in that client's hooks file, from Codex CLI 0.167.0 and Antigravity CLI 1.5.3, and carries `--no-capture` otherwise; Cursor and VS Code keep capture where they run the Claude Code hooks); `--force` keeps your additions; `--experimental-capture` is refused; Gemini CLI is retired, and doctor reports what an earlier install left for it; Claude Code is detected by its `claude` command or its own files, not the `~/.claude` directory install's launcher lives in, and doctor reports a leftover Claude Code wiring.
- **Install no longer wires a Claude Code that is not there.** Claude Code is detected by its `claude` command or its own files (`~/.claude.json` with keys of its own, `projects/`, `.credentials.json`, `statsig/`, `todos/`, or a `settings.json` key treecontext did not write), never by the `~/.claude` directory install's own launcher lives in; doctor warns about a Claude Code wiring an earlier install left where Claude Code is not present and names `treecontext uninstall --agent claude`. Uninstalling Claude Code turns Cursor's and VS Code's entries to no capture, since the hooks block they read is gone.
- **Uninstall says what it cannot remove when install's record does not parse.** It moves the record aside as install does, removes none of install's approvals, its `idleCompaction` key or the files it created (only the record can tell them from yours), and lists each client's settings file with the rules install writes there, for you to remove by hand; it ends "Uninstall incomplete" and exits 0.
- **No agy grant beside a rule that may decide.** Where a rule of yours in an undocumented shape (`mcp(treecontext/treecontext_*)`, a `regex:`, a case variant) may decide a tool, install writes no allow rule for that tool and takes back one an earlier install wrote; doctor names the rule and says install left the tool alone.
- **Doctor's fix line and its approvals remedy name the same command**, and the documented `treecontext run`, `install`, `uninstall` and `config tool-approvals` lines are checked against the CLI's own parser.
- **A curated dedup hit never touches another lane's row, and a headless worker dedups in its own lane (D391).** An insert whose text another lane's entry already holds lands nothing, as before, and now arms no resume-pointer tag on that entry (`next_session`, an active status): the reply lists them under `flags_not_armed`, as it lists `refs_not_recorded`. On every curated hit the reply names the surviving entry's `writer` and `lane` (no longer the caller's stamp), the caller's `caller_lane`, `landed: false` and a `dedup_note` saying nothing landed in the caller's lane. The drain's echo heal of a hit changes the surviving entry only from its own lane. A ticket-door worker's curated entries dedup within its own session, which is its lane, so two workers, or a worker and the main session, writing the same text leave a row each; a `session_id` in a worker's own metadata is ignored for its entry, which stays in its session, and the reply says so (`session_id_ignored`). Migration 033 (additive, behind the usual pre-migration copy) adds that index; no existing row changes class or key, and a worker row written before it keeps the old dedup. It moves the store from schema v32 to v33, after which beta.3.1 refuses it: going back means restoring the pre-migration copy. A Claude Code subagent leg keeps today's dedup until beta.5 (D392).
- **A run's skeleton names the legs whose summary row holds an error stream's end (D398).** A worker that failed or printed nothing has the end of its error stream in its summary row (D384), and a CLI such as `codex exec` writes command output there; the skeleton export's reply and the file's head now carry an `error_tails` line naming each such leg, after the first-moments lines, and the export tool's description says so. Nothing is redacted.
- **Doctor's Codex row reads as two clauses.** Its approvals remedy ran straight into the hooks clause ("remedy: nothing to do, the client copies the hooks…"); the hooks clause now starts its own sentence ("… remedy: nothing to do. Hooks: the client copies …").
- **A tool call that fails, and one Claude Code refuses before running it, are journaled (D400, D401).** Claude Code fires `PostToolUse` only for a call that succeeded, and install wired nothing else, so no failed call had ever been journaled (on the first beta.4 load, 460 of 460 successful shell calls were in the store and at most 3 of 9 failed ones). Install now also wires `PostToolUseFailure` and `PostToolBatch`, served by the same `tc-post-tool-use` script. A failed call (non-zero exit, timeout, a tool's error, an MCP tool's error reply or protocol error) is journaled as a successful one is, with the client's error text as its Output section and `outcome` `failed` (`interrupted` when the developer interrupted it). A call the client resolved without running it (its input rejected, permission denied, blocked by a PreToolUse hook) is journaled from the batch's account with what the client told the model, marked `captured_from` `batch`; a call is journaled once, the batch adding only the calls no event of their own captured. Every captured tool call carries the client's id for it as `tool_use_id`. A failed call of one of treecontext's own tools heals nothing. Migration 034 (additive) gives staging the three columns; on a store below it the hooks capture a failure unmarked and the batch adds nothing until the server opens the store. Codex CLI's copy of the block carries the two events, which Codex CLI 0.167.0 does not have and skips. Doctor's new "capture events" row names an installation wired before an event was added, with `treecontext install --force --agent claude`. The capture scenarios now replay hook events recorded from a real Claude Code 2.1.319 session (`tests/fixtures/claude-code-hooks/`) through the hooks install wires. A failed call is classed an error for the drain's exit tally and error tracker whatever its text says, and a call only the batch's account names is not classed at all; the batch hook reads before it takes the write lock, so a batch whose calls were all captured never waits on a busy store. A limit of the client, not changed here: Claude Code hands a hook at most the first 30,000 characters of a shell command's output (a successful call's entry also names the client's own file holding the rest, by path and size) and about 10,000 characters of a failed one's, its middle cut; "kept in full" means in full as the client hands it over.
- **The client's hook events are listed beside what install wires, and a charter step that says "as Claude Code sends it" replays a recording (D402).** `tests/fixtures/claude-code-hooks/events.json` holds Claude Code 2.1.319's 33 hook events (read 2026-11-09), each wired by install or named with what the journal does not capture because of it; a guard fails when an event has neither, when install wires one the list lacks, or when a recording shows one the list lacks. A second guard fails a step saying what Claude Code sends or sent unless its binding replays a recorded event, and the replay refuses a payload that did not come from a recording. `npm run dogfood:census` counts a real session's tool calls against the store (observed by the client's call id, or inferred and unverified; `--live` runs one headless session of every outcome and reminds you when the client's version differs from the list's). The list cannot see an event neither it nor a recording names, so the hooks reference is re-read at each client upgrade. Tests only: no installed behaviour changes.
- **A worker in a sandbox is never taken for gone, and a worker taken for gone is set right by its door (D403).** A `treecontext run` inside a sandbox that numbers its own processes (Codex CLI's on Linux, a pid namespace of its own) registered its worker with the number the sandbox gave it, and the next reader outside looked that number up among the machine's processes, found an unrelated one and retired the running worker as a phantom; at the worker's real exit its door then wrote the summary row beside a registration still reading phantom. A registration now records which numbering of processes its process id belongs to (on Linux the pid namespace, `proc_ns`, and on each process it ran as). A reader numbered with the worker judges it as before; a reader outside the sandbox finds the worker in the sandbox's numbering and judges it there, and retires it as a phantom once the sandbox has ended with every process in it; a reader that cannot see the worker's numbering (one inside a sandbox, where the machine's processes do not exist) leaves it live, and the key lookup says the worker runs where this reader cannot see its process. A registration an earlier build wrote records no numbering: it is judged as before only by a reader in the machine's own numbering, and left live, with the same note, by any other. A door in a sandbox that numbers its own processes but keeps the machine's /proc (bwrap without `--proc`, `unshare --pid --fork` without `--mount-proc`) reads its worker's start from the process /proc lists in its own numbering, not from the machine's process that holds the same number; a door with no /proc at all records the numbering as unread (`pid:[unread]`), and no reader judges that worker, and a reader with no /proc judges no worker at all. Each process a door registers also records the time namespace its start was read in: a start read in another time namespace than the reader's (`unshare --time`), or where none could be read, is never compared, and the worker is judged by whether its process exists; a registration from before records none and is judged as before. A reader whose /proc hides other users' processes (`hidepid`) never takes a sandbox's end from what it does not see. A process a reader may not read is taken for the worker only when its id in its own numbering and its start match the worker's, so another user's container no longer keeps a gone worker live, and a process that may be the worker always keeps it live. A worker this build's door started that a reader took for a phantom is set to the ending its door reports (retired, cut or invalid) at the door's moment, with its summary row, keeping when it was taken for a phantom and by what; a send-back makes it live for its re-run, and a damaged ticket's worker is set to invalid when its one row lands. A worker an earlier build's door started is not set right: its door never corrects a phantom, so a sandboxed worker of beta.3.1 or an earlier beta.4 still running across the upgrade can be left reading `phantom` beside its summary row. Migration 035 (additive) adds the column; a registration written before it has none. macOS and Windows have no such numbering and nothing changes there. Known limit: only a reader in the machine's own numbering, with that numbering's /proc, decides that a sandbox has ended; a reader numbered apart (WSL2, a container that does not share the host's) leaves such a worker live.
- **A call Claude Code says succeeded is classed a success, whatever its output says (D404).** The drain classed a call by searching its output for words such as "error:", "failed", "traceback" or "deprecated", so a successful status call, export or doctor run, or an insert whose note said "failed call seen", was filed among the session's errors or soft fails. On Claude Code a call that fails arrives by an event of its own (D400), so a call that arrives by `PostToolUse` succeeded: its entry is now classed `success`, and an entry from `PostToolUseFailure` stays `error`, whatever either says. The hook takes its client from the command install wrote, never from the payload: Claude Code's hook commands now end in `--client claude-code` and the scripts hand their arguments on to `treecontext hook`; a command that names no client (a block an earlier build wrote, the copy written for Codex CLI under `--experimental-capture`) states nothing, and its calls are classed by their text, as before. Every classified entry now says what decided its class, `exit_by` `client` or `text`, and the trail pane's clean, soft-fail and error rows say how many of their events took their class from the client's word and how many from their text. Migration 036 (additive) gives staging the `stated_by` column; on a store below it the hook drops the mark and the call is classed by its text. Entries drained before this build keep their class. A `treecontext_insert` caller cannot pass a note off as the client's word: the tool drops a caller's `exit_by`, and on a row the caller labels `auto-capture` the capture marks too (`outcome`, `captured_from`, `tool_use_id`, `exit_type`, `stated_by`); the pane counts the client's word only on a captured tool row. Re-run `treecontext install` (or `install --force --agent claude`) to rewrite an existing block; until then doctor's "exit classes" row names the commands that name no client. The charter scenario replays a session recorded from Claude Code 2.1.321 (`tests/fixtures/claude-code-hooks/2.1.321/`).
- **A `.git` that is no repository is not a project root (D419).** A project's store binding and its `treecontext.toml` follow the root of the nearest repository git accepts, else the project's own directory. Before, when git named no repository, treecontext's own look upward took the first directory holding anything named `.git`: an empty `.git` directory (Codex CLI's sandbox leaves them in a writable root, the system temp directory among them) bound every project below it to the stub's directory's store and made each read the installation's config instead of its own; a `.git` file git cannot read between a project and its repository's root did the same. Now a `.git` counts only when it has the shape git accepts (a git directory with `HEAD`, `objects` and `refs`, or a gitfile naming one), checked on disk with no extra git call; a project with no repository keeps its own store, keyed by its own directory, as before. Every file the check reads (`HEAD`, `commondir`, a gitfile) is read only if it is a regular file, and at most 4 KiB of it; `ref:refs/...` with no space is accepted, as git accepts it. A session's placement in a checkout (main or a worktree) reads the same resolution as its binding, so a session below a `.git` file git cannot read is placed in the checkout whose store it was bound to, never taken for the main checkout's. Doctor gains a "Project root" row naming the directory the binding and config file follow, whether a repository is there, and each `.git` it passed over because it is no repository. A project that was bound to a stub's directory gets a new binding for its own directory at its next start; the old store is left as it was, and the doctor row names it with the command that merges it (`treecontext stores merge <old> <new>`). Nothing is moved or merged for you.
- **A supersession made while the store cannot tell the writer exactly is held until the call's echo, then applied (D420).** With one subagent of a session live and the session's own agent silent since it started, an insert through the tools is stamped as the subagent's `provisional`ly; with several live, `ambiguous`. Such an insert's `supersedes`, and a bookmark's retirement of its lane's earlier live bookmark of the session (D241), are now held on the new entry as pending (`_supersedes_pending`, `_bookmark_retire_pending`) instead of being sorted by the provisional stamp's lane: nothing is retired and nothing dropped, and the reply lists them under `supersession_pending` with a note, where it used to list them as `referenced` with "Written by another writer, so left live and unchanged". When the call's echo names the writer, the drain retires each held target in that writer's lane (D379) as an immediate supersession would, retires the lane's earlier live bookmark of the session, and records a target that is truly another writer's as referenced (D169), leaving it untouched. When a bookmark's own echo settles who wrote it, it retires its lane's earlier live bookmark of the session, or is retired by a newer one there, counting only bookmarks whose writer is already settled; so, whichever echo the drain reads first, a lane ends with exactly one live bookmark of the session, never two and never none, and a subagent's bookmark first read as the orchestrator's never retires the orchestrator's own. This also covers a bookmark the echo moves into a lane, which before could leave two live. Until then, and for good where no echo is captured, status lists the entry under `pending_supersessions`, naming each target; the session that made the insert sees it in its own status, and a row of another checkout's lane is listed by its lane alone, never its text or id. A `concurrent` stamp (the session's own agent active beside a live subagent) applies at once, as before; on a dedup hit nothing lands to hold the supersession, and its targets are listed as misses with reason `not_exact`. No migration.
- **A worker whose tools open another store than its door's is never filed as the main session (D424).** `treecontext run` registers its worker in the store it is given, and the worker's client starts its treecontext server in the worker's directory, which may be bound to another store (a `--store` naming one, a project bound elsewhere). That server held the worker's ticket and no registration, fell back to the session last seen in the directory, and stamped the worker's note as that session's own, writer `main`. It now keys the row to the session the door named, the same id the door's store holds the worker under, with the ticket's role as its writer and `_writer_src` `ticket-claim`, and the insert's reply says so. No registration is written in that store.
- **A configuration file that does not parse is never lost to install.** Where a client's JSON configuration (its MCP file, Claude Code's settings) does not parse, install keeps the file beside it and writes a fresh one, as before; three defects in how it kept it, in every build since 0.1.0-beta.1, are fixed. A dry run no longer moves the file (it left the client with no configuration file and wrote nothing): it changes nothing and says what a run would do. A second broken file no longer replaces the first one's backup: the backup is `<file>.bak` while that name is free and a dated `<file>.bak-<UTC timestamp>` otherwise. A backup that cannot be made is a refusal that writes nothing and fails that client's step, where install used to write over the original and still say it was backed up. Install's line names the backup, and doctor's Antigravity CLI row, for an MCP file that does not parse, names `treecontext install --agent agy` as the fix and says what install does with the file (fixing it by hand first keeps servers of yours in place).
- **On Windows, install and doctor no longer leave Codex's app server running.** They ask Codex how it reads its configuration and its hooks through its app server, and end it once it has answered. On Windows `codex` is a `.cmd` shim reached through a shell, and ending the shell left the shim's own processes alive, an app server still holding the directory it was asked from. The whole process tree under the probe is now ended (`taskkill /T`). Linux and macOS, where the probe is its own process group, are unchanged.
- **The README states three Windows limits.** A worker killed from outside reads as an exit with a code there, never as a cut, since Windows has no signals; a background process a Node-based worker started as an ordinary child ends with the worker; and Codex CLI does not follow a redirected `USERPROFILE`, so `CODEX_HOME` is the way to make install, doctor and Codex agree where the two differ.
- **Codex CLI is captured through its own hooks, from 0.167.0 (D406 to D412).** Install writes Codex its own block into `~/.codex/hooks.json` by default, with no flag: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `Interrupt`, `PreCompact`, `SubagentStart` and `SubagentStop`, each running the `~/.claude/hooks/tc-*` scripts with `--client codex`, in groups of its own after yours, never in a group of yours; Codex's entry starts the server in capture mode. Codex runs a hook only once you trust it, so install says so in one line naming `/hooks` in Codex, leaves a file it has nothing to change byte for byte, names each hook it writes or moves anew (Codex keys its trust by a hook's place and text), and never writes Codex's record of trusted hooks. Below 0.167.0, or where `codex --version` cannot be read, install takes back the hooks its record names (or an earlier build's copy, known by its commands), keeps Codex tools-only and says why; a hooks file that does not parse is left byte for byte and quoted. Uninstall takes back what install wrote and names any hook of yours the removal moved. A Codex session is journaled as a Claude Code one is: prompts, tool calls with Codex's id for each, and each turn's last reply from Codex's own `Stop` payload. A shell command's entry holds the one text Codex returned, with no exit code, and is classed by that text (`exit_by` `text`); a call of another tool that fails fires no `PostToolUse` on Codex, so its `PreToolUse` is held in staging and the call is journaled at its turn's end as one Codex reported no result for (`captured_from` `no-result`, no class); a turn you interrupt is kept as a capture-gap entry naming its reply as not captured. A Codex main registers itself at its start and is handed the re-orientation packet at a fresh start and on a resume (no bookmark ask: treecontext's hooks print Codex nothing at a turn's end); a `codex exec` worker started by `treecontext run` is never a self, its Codex session linked to its lane; a Codex subagent is a registered helper with its reply kept as its summary, never a leg. Doctor's Codex row reads Codex's own account of each hook's trust (its app server's `hooks/list`): written and trusted, untrusted, trusted in part or modified since it was trusted, naming each hook, or that it cannot tell. `tests/fixtures/codex-hooks/` holds Codex 0.167.0's recorded events (2026-11-09) and its event list, held against the block by the guard of D402. No migration.
- **Codex's hooks and its entry's capture mode are one fact.** Treecontext's hooks are in `~/.codex/hooks.json` if and only if Codex's entry starts the server in capture mode, at install, below the floor and at uninstall: hooks that are written can run, and only a capture-mode server drains what they stage. Install asks Codex about that file from an empty temporary directory, so one project's `[features] hooks = false` no longer decides capture for every project; where Codex loads none or only some of treecontext's hooks, the block stays, the entry drains, and install says Codex runs none (or only some) of them now and what turns them on, naming the file that sets `[features] hooks`. A put-back of a file Codex rejected after install's write that fails is said, with the original text saved and how to restore it, and fails the run. A read-only file that refuses the take-back keeps the entry in capture mode and the scripts the hooks run. A dry run starts no Codex app server; a read of Codex that passes a second says what install waits for. Doctor asks Codex from the project it reports on, names a project's own setting that turns hooks off there, reads only what Codex says of the user's file as treecontext's, and names an entry whose mode disagrees with the hooks in the file. A call's trace is read only from rows the capture pipeline wrote in the call's own session: a note naming a call's id, another session's call with the same id, or an imported copy no longer hides a call from its turn's end or the purge, nor is marked resolved; the insert tool drops a caller's `gap_tool_use_id` and `resolved_*` keys.
- **Your Codex files stay as you wrote them, wherever Codex reads them.** Install edits `hooks.json` by inserting and removing its own groups as text, so a hook of yours keeps every byte (a `timeout` of 9223372036854775807 is no longer rounded into one Codex's hook discovery crashes on), and Codex keeps the trust it gave it. A read-only `config.toml` is refused before anything of Codex's is written, at install and uninstall; a symlinked one is written through, the link and mode kept. `CODEX_HOME` is followed by install, uninstall, doctor and every Codex they ask, and named; a `CODEX_HOME` that does not exist is refused, as Codex refuses it. The insert tool drops a caller's `capture-gap` or `recovery-snapshot` source (said back as `source_ignored`) and `gap_id`, so a note can neither hide a real gap or recovery note nor count as a hole, and an exit class is counted only on a captured tool row.
- **The capture census reads a Codex transcript (D409).** `npm run dogfood:census -- --codex <rollout.jsonl> [--store <db>]` counts a Codex session's direct calls by Codex's id, its code-mode calls by the id the transcript's record of each completed call carries, and the rest by inference, saying how many of each and why. A worker whose ticket could not be read is retired `invalid` by its own row written through the insert tool whatever `kind` it gives it (D303, D342).
- **Codex's files: never a developer's value rewritten, never capture claimed or hidden falsely.** Install's text editor writes only treecontext's own groups as new text and refuses, changing nothing, any change it cannot make without touching a value of yours; a take-back removes exactly what install's record names (recognition by command only for a file with no record, said in the output); Codex's own reading is asked before and after a take-back as after an install, and an error from Codex after a write it answered for before puts the file back. A hooks file broken after install makes uninstall incomplete, the entry kept draining, and doctor names one remedy. Imported rows and merge copies answer no capture gate and count in no exit tally; the import keeps the sender's capture marks under its claims. Uninstall and doctor name another `CODEX_HOME` install wired. README: "Codex CLI as a main: best effort".
- **`--experimental-capture` is gone (D406).** Install refuses it in any form, before writing anything, in one line naming each client's version floor (Codex CLI 0.167.0, Antigravity CLI 1.5.3; Claude Code always). The hook adapters no install wired (`src/hooks/codex`, `cursor`, `opencode`, `vscode`) left the build with it; uninstall still knows the entries and wrappers an earlier build wrote by their commands. The handshake now says hooks capture a session on Claude Code, and on Codex CLI or Antigravity CLI where their hooks are installed and running.
- **Gemini CLI is retired as an archived platform (D399).** Google deprecated it for Antigravity CLI, so install no longer detects or wires it: no MCP entry and no translated hooks copy in `~/.gemini/settings.json`, whether its command or files are there or not, and `install --agent gemini`, with or without `--experimental-capture`, is refused in one line naming `agy` and the way to remove an old entry. `treecontext uninstall --agent gemini` (the archived sweep alone) and a full `treecontext uninstall` remove the treecontext entry, the copied hooks and the `tc-gemini-*` wrappers an earlier install left, keeping every other key and hook of the file; doctor shows no Gemini CLI client row and warns while any of it is left, naming that command. `~/.gemini/GEMINI.md` is Antigravity CLI's alone: its uninstall removes the block, which no longer stays for a wired Gemini CLI. The Gemini hook adapter (`src/hooks/gemini/`), the translated copy and Gemini CLI's presence test are gone; the README's matrix drops its row.

## 0.1.0-beta.3.1 — a hook's wait on a busy store is measured by the clock on every OS, VS Code gives a hook 15 s, and doctor on macOS names only the processes that can hold a lock (2026-11-03)

The release run's CI matrix found these after 0.1.0-beta.3 was published from the build both owner machines had dogfooded; beta.3's own changes are below, unchanged.

- **A hook's patience for a locked store is measured by the clock, on every OS.** SQLite counts a busy wait by adding up the sleeps it asked for, and a busy Mac oversleeps each one, so a hook's 7 s for a store another process holds ran to 11–14 s there (CI run 41670918705), close to the 15 s at which VS Code kills a hook and loses its diagnostic. A hook now hands SQLite 100 ms at a time and checks the clock between, so on a busy Mac a locked store costs a hook what it costs on Linux: at most 1 s for Stop's and SubagentStop's guard read, 1.5 s for a /clear's packet, 7 s for a write, then the hook gives up and the dropped event is marked as a capture gap as before. The budgets are unchanged.
- **VS Code's hooks are registered with a 15 s timeout, and the hooks are held to one wall-time rule on every OS.** At the 10 s `timeoutSec` treecontext wrote, Stop had a second to spare over its 8 s of patience for a locked store (1 s guard, 7 s write). On the macOS CI runner every hook ran past the 9 s rule against a locked store, because the waits themselves overran; the bullet on the clock-measured patience says why and what changed. The rule is now the installed kill less a second (14 s), read from the generated config, and the patience is unchanged, so a busy store's capture is as before. Claude Code's own hook timeout (60 s) is untouched. An existing VS Code install picks it up at its next `treecontext install`, which rewrites a hooks file that differs.
- **On macOS, doctor's fix for a locked store no longer names a process that only has the store memory-mapped.** macOS cannot say which process holds a store's lock, so doctor's one command stops every process with the store open, as `lsof` lists them; `lsof` also lists a process that once opened the store and still has it mapped, which holds no lock. Doctor now counts a process only through an open file descriptor. The macOS CI run found it when the doctor scenario's command stopped the test runner itself.

## 0.1.0-beta.3 — legs, workers and runs: work handed to subagents and headless workers is journaled as one unit, every checkout reads its own lane, and the store runs on Node's own SQLite (2026-11-03)

Published from the build at commit 9cc824c (the dogfooded build); the fixes the release CI found on macOS and Windows are in 0.1.0-beta.3.1, which supersedes it.

beta.3 adds legs, workers and runs: work that runs as subagents or headless workers under a run and a key is journaled as one unit. A leg enters through the hooks door (a Claude Code subagent whose role has a brief in effect) or the ticket door (`treecontext run`, or the library's `spawnWorker`, for a headless worker), and the key lookup answers the harness and the agent with the checkpoint in effect and the run's facts. A run is exported as a unit, its skeleton by default and every row of every leg behind the secrets acknowledgement; a checkpoint is state and is refused once past 16000 characters; the retention valve carries the rows the doors write and never destroys a leg's summary; install turns Claude Code's idle compaction off; and the main checkout is a lane like any worktree. Beneath it all the database driver is Node's built-in `node:sqlite`, with no native dependency.

- **The main checkout is a lane like any worktree: status, the fresh-start packet and the default search show a session its own lane (D372–D379).** On the owner's incident (a session restarted in the main checkout oriented on a linked worktree's newer chapter), the main checkout's half of D167 is closed.
  - **Scoped to the session's own lane:** in the main checkout or a worktree, `treecontext_status`, the packet's self line and the default search cover the lane's own rows, its helpers' reports (a subagent's summary, a worker's return, by the parent link) and the handoffs imported there, never a helper's tool calls. The other lanes are counted, at most three are named and their text is never shown; `scope: "all"` widens. The status block gains `other_lane_count` (the number of other lanes) while `other_lanes` keeps beta.2's meaning (pointers left out). No new query parameter (D264 stands).
  - **One lane rule for every reader (D379):** a pointer of a session's own agent whose session the registry places in a checkout is that checkout's, stamp or none, in status, the packet, supersession, the echo heal, the referrer shown and the seat the search keeps for the lane's own chapter alike; a chapter a program writes through the library under a worktree session's id is the worktree's, never main's. A row with no stamp is main's only when the registry never held its session (written before writers were recorded); one whose session the registry holds but places in no checkout, such as a headless worker's, is "writer unknown", as is an `unregistered` one. A lane's search may still find a helper's report, an import or an `ambiguous` row, and never seats one as the lane's own chapter. A helper's row stays its role's. Disclosed residual: a session that runs outside any git checkout registers as the main lane, so it shuts the pre-stamp door (D378) and may claim main's recovery snapshots (D375).
  - **A fresh start's packet no longer ends "No prior context available"** after the lane's own self lines: session-start reads them first and leaves the fallback out (adapters without self lines keep it).
  - **A lane-scoped search may give its last result place to the lane's own matching chapter**, never the first, not at `top_k` 1, not on temporal sorts; the own chapter is found after a restart, not promised first.
  - **A caller the server cannot place** (a client without hooks) is no longer folded into main: its insert replies `writer_src` `unregistered`, with `writer` `null` (beta.2 left the key out) and a `writer_note` saying why, and its rows show as "writer unknown", one lane for supersession. A ticket-door worker searches the whole store, fed by its brief and the key lookup.
  - **The pre-stamp door (D378):** while no session has run in the main checkout, such a caller may retire a pre-stamp chapter of main; each retirement is recorded on the retired entry (who, what, when, how) and listed in the reply as `retired_across`. Bookmarks, stamped rows and imports are never retired this way, and a read-only chapter is refused as any supersession refuses it (`supersede_misses`, `read_only`).
  - **The recovery snapshot is claimed only in its own lane (D375),** deduplicated per snapshot and claimant. A client running the Claude Code hooks registers its sessions and claims in its own lane, Codex CLI and Gemini CLI included once `--experimental-capture` has copied the block; the adapters' own scripts (Cursor, Codex, Gemini, opencode; unverified scaffolding) register no session and no longer claim a snapshot; the snapshots table has no retention yet.
  - **After the upgrade, a hookless client** sees its new entries as "writer unknown", its status and search unscoped to a lane (the whole store, said in the reply), and its pre-upgrade chapters stay main's; it can retire a pre-stamp chapter of main, its own or any other, only while no session has run in the main checkout. Quit every running session before upgrading, as for beta.2.
- **The handshake's handoff step names the file's path, and the README teaches running work as legs.** The handshake and the AGENTS.md block told the teammate to import a handoff "with the file's name as the label", which the import tool refuses beside a path; both now say to import it with `treecontext_import` and the file's path. The README gains "Running work as legs" (the brief, the checkpoint, `treecontext run`, the key lookup, a run's export), and the reference skill names the brief's metadata and points to it.
- **The database driver is Node's built-in `node:sqlite`; there is no native dependency.** better-sqlite3 is gone, and with it the prebuilds (17 MB of a 27 MB tarball), the stale-binding failure class doctor had rows for, the per-Node-major prebuild chase in the installer, the install script npm 12 asks every user to approve, and `@types/better-sqlite3`, which sat in production dependencies and dragged `@types/node` into every install. The production tree is three direct dependencies, four packages installed (the server's core beside it). The SQLite is the one the running Node carries, the same 3.53.4 on current Node 24, and every construct the schema uses runs on it unchanged; on the owner's store reads measured within ten percent either way, writes equal once `synchronous` is set (the driver's default FULL is twenty-five times slower per single-row transaction, so the adapter sets NORMAL as before and every raw opener sets its own), and a hook process cold-starts in 1.7 ms against 6.8 ms (D278).
  - **The Node floor is `>=24.16`**, declared in `engines` and held by doctor's Node row, which reads the floor from the manifest so the two cannot drift. Node 22's `node:sqlite` warns on every load (a stderr line per hook process that Claude Code's debug log records as an error), has an older API, and truncated text at an embedded NUL on that line, fixed in 24.16 and never on 22. A dual driver with better-sqlite3 as a fallback and a Node 22 floor are declined to the fence.
  - **A store's path keeps the caller's spelling**, as better-sqlite3's did: node:sqlite's `location()` resolves symlinks (macOS's `/var` is `/private/var`), so the opener records the path it was given, made absolute, and backups and reported paths are named from it; a wrapped `DatabaseSync` reports `location()`. The macOS CI run found it.
  - **Doctor's `better-sqlite3` row is now a `SQLite` row**: it names the SQLite version the running Node carries and says FTS5 is compiled in, both read by opening a database, never from a table of versions; a Node built against a system SQLite without FTS5 (some distribution packages) is an error on that row with the fix. Install chooses an interpreter that meets the floor and runs this package (its own `node:sqlite` opens a database with FTS5), where it chose one that loaded the binding, and the Hook interpreter row says the same.
  - **The library door changes (breaking, accepted in beta):** `treecontext-mcp/persistence/node` exports one opener, `openNodeSqlite(pathOrDb)`, which takes a file path or a `DatabaseSync` the caller already holds, in place of `wrapBetterSqlite(raw)` and `openBetterSqlite(path)`. It also exports `openRaw` (a `DatabaseSync` with `readOnly`, `mustExist` and `timeoutMs`), the pragma helpers `pragmaRows`, `pragmaValue` and `setPragma`, and `isBusyError`, which reads the primary code in SQLite's errcode (its low byte: 5 or 6, so a snapshot conflict's 517 counts) and the message, since node:sqlite errors are `ERR_SQLITE_ERROR` with an extended `errcode`, not `SQLITE_BUSY` strings.
  - Observable deltas a library consumer may notice: rows have a null prototype, a BLOB reads as a `Uint8Array` rather than a Buffer (the content codec accepts either), and an integer past 2^53 throws instead of rounding.
  - Found by the cold review of the ported call sites (2026-10-26): node:sqlite's `backup()` of a store another process holds exclusively rejected with the message `not an error` (errcode 0), so `treecontext backup` of a locked store said exactly that; the backup now reads the source first, under its busy wait, and reports the lock as `database is locked`. The raw opener waits 5 s on a busy store by default, as the old driver's constructor did (node:sqlite's own default is 0), so doctor's store rows and `stores list` no longer read a store as unreadable during a transient exclusive window such as WAL recovery after a crash; the hooks pin `synchronous = FULL` on their write handle rather than inheriting it; doctor's schema row closes its read handle on a busy throw; the merge destination is opened by the wrapped door, which closes what it opened if a default pragma throws.
- **The dependencies move to their latest releases.** `@modelcontextprotocol/server` 2.4.0 (the client it is tested with likewise), `zod` 4.6.7 and `smol-toml` 1.9.1 in the production tree, still three direct dependencies; in the dev tree vitest 5, which made vite a peer dependency so vite is now declared beside it, with oxlint, tsx, `@types/node` and the OpenCode plugin types at their current releases, and the CI actions at v7. The full suite runs unchanged under vitest 5.
- **A run is made of journal rows, and the store numbers its checkpoints.** The store and registry layer the beta.3 subagent cut rests on, unit 1 of its build; legs, workers and runs were whole-feature rulings in the register until their doors landed (units 2 to 9), and the release gate refused on them; none is open now.
  - **Migration 031 (additive) gives the session registry a leg's facts:** its run and key and where they came from (declared, inferred, ambiguous with the candidates kept, or settled as the leg's own), the door that registered it and whether its identity was registered by a hook or declared, the checkpointer its brief named, the checkpoint(s) it started from, its parent linked by id when a hook registered that parent (the ticket's own description of it kept beside the link) and carried as declared otherwise, never a row of its own; a worker's host, process id, the start moment its operating system reports and, on Linux, the exact start token (boot id and start ticks); every process a re-run adds beside the first; its one send-back; and how it ended (D281, D288, D293, D294, D297, D317, D320, D326, D329, D335). A subagent with no run or key registers and is summarised exactly as before (D305).
  - **A run's open and close are journal rows carrying the run.** It opens at its first leg's registration, in that registration's transaction so two first legs at once open it once, or explicitly; its close records who and why; the query tool finds a run by its name. An inner run's open names the outer run and the leg that opened it, and that leg's registration names it back, at any depth (D302, D309, D311).
  - **A checkpoint under a run's key is numbered by the store when it lands**, inside the insert's transaction and under a unique index, so two legs that started from one checkpoint take the next two numbers, never the same one. It supersedes what its writer names; naming nothing, the leg's own newest checkpoint under the key, else the checkpoint(s) the leg started from, marked as the store's (D331 as D353 reads it, ratified by D355); while more than one subagent of the session is live, the call's own echo names the leg before the stamp is made. The superseded checkpoint is never touched, and two in effect come back as two with a line saying so (D280, D284, D329, D331). The insert reply gains `checkpoint`: its run, key, number, what it supersedes and who named that.
  - **A leg's key is settled by its own write** under a key of the run it is registered for, at insert only when the writer is known exactly and otherwise at the call's echo, which also puts back a settle the insert made under a stamp it contradicts; a note's bare `key` never re-keys a leg (D320, D326).
  - **A brief is in effect** until a newer brief for its role and key names it as superseded or its run closes (D327). A run's rows never deduplicate by their text.
  - **Every row through the tools now carries `_door` and `_identity`**, and rows written through the library as a leg, or by a writer declaring a role no hook registered, carry the door, the identity's source, the directory, worktree and branch the door could read and the parent as declared; the insert tool drops a caller's copy of every store-only key (D293).
  - **Anyone with the file reads a run back** in the order of each row's own moment with the plain SQL the library exports as `RUN_ROWS_SQL`, a captured row reaching its run through its leg's lane (D289).
  - **A gone worker is retired as a phantom** by the next reader of the registry on its host, the harness's lookup, the session-start hook, and the status tool, which now runs the pass (a write to the registry, skipped under the read-only policy) and replies with a `workers` block when it retired a worker or could not check one: the moment it was noticed and by whom, never a guessed exit. A process holding the number with a different start is a different process; a worker on another host, or one whose start cannot be read, is left live and said to be uncheckable (D297, D317).
- **The key lookup gives the harness and the agent one reply: the checkpoint in effect, the flag, the run's facts and the leg's return.** Unit 2 of the beta.3 build, over unit 1's store; at this unit legs, workers and runs were still whole-feature rulings in the register (none is now).
  - **Beside every checkpoint in effect, the flag in words** when its writer is not the checkpointer the run named, in either of a brief's tenses, who will checkpoint the key at the end and who checkpointed the work it resumes (D281), read from the briefs of the key (a superseded brief's no longer, a closed run's still), else from its workers' tickets: nothing withheld or re-ranked, so a main agent's checkpoint under a leg's key comes back beside the leg's own, two in effect, flagged (D296). An imported checkpoint's claim that it supersedes a checkpoint of the key is believed by every read of what is in effect and flagged as arrived by import; the claim stays under the file's claims and the local checkpoint is untouched (D343).
  - **The pointer to the return of the leg that wrote it**: the summary row in that leg's lane, or a line saying the leg left none (yet, while it is live), or that no registered leg wrote it; never a guess (D336, ratified D348). The drain now stamps a subagent's summary row with the run, and the key when it is the leg's own or declared, read from its registration (D284, D309); a keyless leg's summary carries its run alone.
  - **The run's facts:** legs run, keyless legs among them (a worker declared keyless, or a leg whose key never became its own once it ended), checkpoints under the key, the run's start and age, the sizes of the last 3 checkpoints under the key, newest last, in characters counted as Unicode code points (ten emoji are ten; one exported counter, `charactersOf`, which the checkpoint cap will count with too, D299), and each leg live or how it ended, a live leg with its start and the moment of the newest row in its lane. The store judges none of it (D301, D312, D320, D326, D341, D344).
  - **The agent's door is the eight tools (D337, ratified D349):** `treecontext_query` takes `key_lookup: { run, key }` and returns the reply the library's `keyLookupReply(lookupKey(…))` gives the harness, field for field (`query` is then not needed, and is required otherwise; a read-only server reads without the phantom pass); `treecontext_insert` with `metadata.kind` `run-open` or `run-close` and `metadata.run` records the harness's own open or close row, by the writer the store stamped, a close taking `metadata.reason` or else the content, and ending the run's briefs. No ninth tool; the handshake is unchanged and the reference skill gains a paragraph on runs.
  - **The query tool gains one parameter, `key_lookup`, which is no orientation parameter:** it returns the key lookup's reply instead of hits. This amends D264's "no parameter beyond those it had", recorded as D357 for ratification. Given both `query` and `key_lookup`, the tool refuses with an error naming both rather than answering one; given neither, it refuses too.
  - **A run's open or close through the tools names its writer only when the store knows it (D283, D293, D302, D311).** When the insert-time stamp is provisional, concurrent or ambiguous, the row is written with `_by_src: "pending"`, no `opened_by` or `closed_by`, a line naming nobody ("run r1 closed: <reason>"), no parent leg and no opened run on any registration; the call's own echo then sets who, rewrites the line (its search index with it), and for an inner run names the leg that opened it and records the run on that leg's registration, `_by_src` becoming `echo`. An exact stamp writes who at insert, as before, with no `_by_src`; with no stamp to read at all (an unregistered session), the caller's own `opened_by`/`closed_by` is kept and marked `_by_src: "caller"` (D293).
  - **The key lookup's reply goes under the reply ceiling (D287)** as a search's does: over the ceiling, each checkpoint's content is cut with the export marker at a shrinking cap, and `_reply_ceiling` counts the cut entries and now names their ids (`cut_ids`, for hits too), saying `still_over` when even the shortest cut did not fit.
  - **The agent-surface check names the tree era's checkpoint machinery, never the bare word:** a checkpoint is the beta.3 contract's own term (D280), so the query and insert tools describe it in that word.
  - **The library door matches:** `lookupKey` (now in `key-lookup.ts`), `keyLookupReply`, `FlatStore.lookupKeyReply` and `FlatStore.legReturnStamp`, the flag and line builders, and `openRun`/`closeRun` taking a door's own stamp. Breaking for a library consumer of unit 1's unreleased surface: `lookupKey`, `legStateOf`, `LegState` and `KeyLookup` moved from `runs.ts` to `key-lookup.ts` (the package index re-exports them).
- **A headless worker is spawned through the ticket door: the library's `spawnWorker`, or `treecontext run` from a shell.** Unit 3 of the beta.3 build, over units 1 and 2; at this unit legs, workers and runs were still whole-feature rulings in the register, workers' for the `claude -p` child's hooks (unit 4) and the Antigravity parent, which this build has no hook for (none is open now; the Antigravity row stays a scenario-scoped entry).
  - **The ticket is one JSON object in `TREECONTEXT_TICKET`**, declared by whatever spawned the worker and never discovered: its run, its key or `no_key: true` (the words that it has none), its role, who will checkpoint the key and who checkpointed the work it resumes, whether it has a way to write (`can_write`; silence is read as one), its parent (its id and whatever the spawner declares: CLI, directory, worktree, branch) and its mint moment. `mintTicket` writes it, `readTicket` is the one reader every door uses. A ticket the door cannot read whole (truncated, hand-edited, another shape, a blank key) registers the worker in its own lane with every field it still yields, each unreadable one named absent and the raw text kept, never as a self (D288, D294, D303, D340, D341, D342).
  - **The lane the door registered the worker in travels beside the ticket in `TREECONTEXT_WORKER_SESSION`**, and is honoured only for the worker that ticket describes: a registration must exist there with the same run, key, role and parent (or the same raw text). `serve` started inside the worker then stamps its tool rows into that lane, by its role, with its parent as linked or declared and its directory, the same trace a library write carries; a process that inherited the variable with a ticket of its own is read as its own worker, and a lane nobody registered names no one, the ordinary identity ladder deciding (D288, D293).
  - **Who checkpoints is recorded at registration:** the ticket's checkpointer, else the in-effect brief's for the role and key, in each tense; the send-back and the recovery read the registration. When neither names one, the first message says no one is named and nothing is owed (D281).
  - **The first message is composed from the store, with no query:** the brief in effect for the role and key, the line saying how many checkpoints are in effect, each one whole with its number, writer and moment and, beside one whose writer is not the checkpointer the run named, the key lookup's own sentence; for a leg whose predecessor of its role was cut, found gone, or finished owing the checkpoint without writing it, the line naming that lane and its row count, so it starts as a recovery leg; treecontext's own line that a checkpoint is state, not history; then the spawner's prompt as written. It reaches the worker on its stdin (`--message-arg` puts it last in its arguments instead), never on a command line the host can read and that caps one argument at 128 KiB (D298, D315, D329, D332, D334).
  - **The first moment is the first row of the worker's lane,** written in the registration's own transaction, so neither lands without the other: the prompt as written, references to the brief and checkpoint rows and never copies, their size, the flags and the recovery the message carried, kept whole behind a bounded preview like captured tool output (an index view of 8000 characters, a display preview of 1000), as the worker's capture so the valve reaches it with its session (D298, D313, D319, D339).
  - **At exit a worker that ended on its own, whatever its code, is retired, and its last output, passed to the spawner whole, is its summary row,** stamped with its run and key from its registration, so the key lookup's pointer finds it; one line on stderr says how it ended and names the row. An exit by signal, the spawner's timeout among them, is a cut: the worker runs as its own process group, the signal reaches everything it started, and what is left of the group is killed with it, so a subprocess holding its output never keeps the spawner waiting; retired with no summary row, never sent back, and the next leg of its role recovers (D288, D292, D336).
  - **The send-back once:** a worker that exited on its own with no checkpoint under its key newer than its start, by anyone, that its registration names as the checkpointer and its ticket does not declare door-less, is run once more as the same leg in the same lane under the same registration, its second process recorded beside the first. The lane holds the first moment, the first run's rows, a row with the second run's first message, then the second run's rows: that message is the reason naming the missing checkpoint, the first moment composed again from the store as it now stands (brief, checkpoint(s) in effect whole, flag, state line, the prompt as written), and the pointer to its trail. What a run printed goes to its spawner and is not a row. Never a third time; a leg the other door already sent back is not sent back again; recording a process never undoes a cut, a phantom or an invalid ending (D279, D281, D291, D295, D316, D335, D340, D341).
  - **The faults, each visible:** a store the door cannot read after the raw opener's busy wait starts no worker and the spawner is told that nothing was written (`treecontext run` exits 75); a store that cannot be written at the exit records nothing and sends nothing back, the output still handed over whole, and the leg is left for the next reader on its host to retire as a phantom; a spawner that asks the door to check the ticket first (`--check-ticket`) gets, for one it cannot read whole, a row keeping the raw text and no worker (exit 65), each refusal its own row, written in the lane of the registered session `--spawner` names or else declared by the ticket's parent in no session's lane, never claiming a hook's identity; a worker with a damaged ticket is told its instructions were invalid and asked for one row and a stop, and its leg ends `invalid` the moment that row lands (D283, D293, D303, D307, D342). The ticket door is a reader of the registry too: it retires the run's gone workers on its host before composing.
  - **A worker that holds its ticket with no wrapper claims it itself** (`claimTicket`): registered the same way, never sent back, retired as a phantom by the next reader of its host, visibly without a checkpoint (D291, D293).
  - **`treecontext run`**: `[--run R --role ROLE (--key K | --no-key) --parent ID [--checkpointer ROLE] [--checkpointed-by ROLE] [--parent-cli CLI] [--door | --no-door] | --ticket JSON] [--prompt TEXT | --prompt-file PATH] [--timeout SECONDS] [--check-ticket] [--spawner SESSION] [--message-arg] [--store X] [--project-dir D] -- <command> [args...]`, the ticket otherwise read from the environment. The worker's stdout passes through byte for byte; the boundary is the one `treecontext:` line on stderr after it; the exit code is the worker's own (128 plus the signal's number for a signal). `--help` or `-h` before the `--` prints the usage on stdout and exits 0, starting nothing; after the `--` it is the worker's.
  - **The key lookup's legs gain `checkpoints_written`:** how many checkpoints the leg wrote in its lane under its key, so a leg that ended with none reads so, a count and never a verdict. A leg's summary row that names its run is a run row: two workers that print the same last line leave two returns, each in its own lane.
- **A Claude Code subagent whose role has a brief in effect is a leg through the hooks door, and a `claude -p` child with a ticket is a worker through its own hooks.** Unit 4 of the beta.3 build, over units 1 to 3; at this unit legs was still a whole-feature ruling for the checkpoint cap (unit 5), workers for the Antigravity parent row, runs for its export forms (unit 6); the first and last have since landed.
  - **The SubagentStart hook reads the briefs in effect for the subagent's role (D305, D320, D326, D327):** none, and it is a subagent exactly as before; one, and it is a leg of that brief's run and key, marked inferred, the brief's checkpointer in both tenses on its registration, the checkpoint(s) then in effect as its start, its run opened at this first registration; two or more, and its key is ambiguous with the candidates kept, settled by its first write under one (a candidate's run along with it when the candidates span runs). No query is made on its behalf.
  - **The leg's first moment is the hook's context (D284, D298, D325, D329, D332):** the brief, the checkpoint(s) in effect each whole with number, writer and moment, two with the line that two are in effect, the flag beside one whose writer is not the named checkpointer, the recovery line when its predecessor of the role was cut or ended without a checkpoint, and treecontext's own line that a checkpoint is state, not history; no prompt, since the Agent tool carries it. Past the client's 10,000-character cap the brief and every line around the checkpoints stay whole and each checkpoint is cut where the cap falls, ending `…[cut at the client's 10000-character hook cap: checkpoint row <id>, N characters left out; fetch it whole with treecontext_export]`. The same first moment is the first row of the leg's lane, written by the ticket door's code inside the registration's transaction, with references to the brief and checkpoint rows, the checkpoints' size and what was cut.
  - **The SubagentStop hook sends a leg back once (D279, D280, D281, D295, D326, D334):** only a key the leg made its own (the hook first settles it from the leg's own staged insert echoes, as the drain does) whose registration names its own role as the checkpointer, with no checkpoint under the key newer than its start; the stop is blocked with the reason naming the missing checkpoint, the first moment again and the pointer to its trail, the send-back counted on the registration and kept as a row in its lane. Never a second time, never by both doors, never for an inferred key, never when the brief names another role, never when the store refuses writes. Otherwise the leg's report is its summary row in its lane, stamped with its run and key, and the leg retired. A subagent whose start was dropped stops unasked and its summary lands as before.
    - **The report is read from where the client put it (D371).** Claude Code 2.1.271 and later, in auto mode, hands a subagent the `SubagentHandback` tool and its report goes through that call rather than as text; SubagentStop's `last_assistant_message` then holds only its closing words, if any. The hook now reads the newest hand-back call's `message` from the subagent's own transcript first, the payload's text second and the transcript's last text last, for a plain subagent and a leg alike, so the summary row, the pointer and the key lookup's return hold the delivered report. Found at the beta.3 smoketest on 2.1.316: the hooks-door leg retired with no summary row, its report captured only as the hand-back tool's own PostToolUse row.
  - **The pointer rides on the Agent tool's result (D284, D285, D330):** when the Agent tool returns a leg, the PostToolUse hook adds one line beside the result naming its summary row, writer, run and key; the subagent's own final message is the platform's and untouched. A background Agent launch carries no pointer: its PostToolUse fires at the launch (`status: "async_launched"`), the subagent not yet finished, and its return arrives later as a task notification the platform owns.
  - **The hooks door writes a leg's own rows itself; every platform event still stages.** The registration, the run's open at that registration, the first moment, a send-back's row and the summary row are written by the hook directly through the library, in one transaction with the registration fact each belongs to, so both doors write them with the same code and the pointer names a row that exists; the hook does this only at this build's schema, and at any other schema records the dropped start or send-back as a gap. The briefs a subagent's role is read against are its session's namespace's; every namespace's only when the session's namespace does not resolve.
  - **A leg left live is cut at its session's next start (D328):** the session-start hook records it `ended = 'cut'` with the moment it noticed and itself as what noticed it, never an exit time; a plain subagent left live is retired as before. The next leg of its role under its key starts as a recovery leg, its key inferred or not, as it does after a leg that ended without a checkpoint after its one send-back.
  - **A store a hook cannot write is a gap, marked when the store is next written (D314, D279):** every hook's refused write, a staged capture's included, is recorded in `hook-gaps.jsonl` beside the store (or in the temp directory), a leg starting cold with nothing injected; the drain writes each as a `[capture gap]` row at the moment it was dropped, once (each record carries an id), and lets go of a claimed ledger only after its rows landed, a claimed file read again on the next tick until they do.
  - **What the hooks door costs a hook (measured 2026-11-01, the built hooks, medians of 7 on Linux):** SubagentStart 82 ms for a role with no brief in effect and 89 ms for a leg; SubagentStop of a leg 81 ms; Stop 79 ms. Under a store another process holds whole, each hook waits one guard budget at most and one write budget: Stop 9.1 s (11.1 s before this build: each of its guard's reads waited the guard's budget; one probe now ends the guard), SubagentStop 9.1 s for a leg or a plain subagent (16.1 s before: a staging write, then a second write for the retirement), SubagentStart 8.1 s (these are unit 4's measurements; unit 10 lowered the write budget and measured again, see its line below).
  - **Migration 032 (additive) reconciles the leg columns:** a store a pre-release build already took to 31 gains every leg column 031 later grew (`proc_start_token`, `client_sessions`), so a `claude -p` child's link to its worker is never silently skipped.
  - **A `claude -p` child with a ticket is a worker, never a self (D295):** its session-start hook writes no beacon, no self row and no packet. Spawned by the ticket door, it is linked by its own Claude Code session id to the lane the door registered (`client_sessions`: each link with what made it, the session-start hook, and when), told whose worker it is, its first message having been its prompt; holding a ticket with no wrapper, the hook claims it, registering the worker in the child's own session's lane and injecting the first moment it composed. The drain lands the child's captured rows in the worker's lane with its role as writer and its parent as declared. Its Stop hook is its leg's stop: sent back once when it owes its key's checkpoint, so the wrapper starts no run after it; when the stop hook could not ask, the wrapper's send-back is the leg's one. A prompt the child's prompt hook captured is the door's message, never the row that retires a damaged ticket's worker as invalid.
- **A checkpoint is state, not history: one past 16000 characters is refused once, and the writer's second write is accepted and marked.** Unit 5 of the beta.3 build, over units 1 to 4; with it the four cap scenarios of `journal-legs` bind and the ruling left the register.
  - **The cap (D299, D321, D332, D359):** a checkpoint written under a run's key whose content is past `CHECKPOINT_CAP_CHARS` (16000, counted in code points by the one counter every size a run reports uses, so 16000 emoji are at the cap, not over) is refused on the first write by a writer the store identifies exactly (a leg, a worker, the session's self when no subagent is live). Nothing lands, no number is taken, and the refusal is recorded on that writer's registration (`cap_refused`: the run, key, size refused, moment, a refusal id and where it came from). The same writer's second over-cap write under the same key is accepted, numbered and stamped as any checkpoint, and marked `_over_cap: {size, cap, second}`, a store-only key a caller's copy of is dropped. Another leg, or the same leg under another key or run, is refused again. A write within the cap is never refused. **A writer with no registration behind it (an unhooked session, a library caller naming only its role) is never refused**: its over-cap checkpoint is accepted and marked `second: false`, and the store keeps no ledger of refusals outside the registry.
  - **A refusal made while the writer stamp was not exact is pending (D359):** with two subagents live, or the session's own agent working beside one, a tool insert cannot say which of them called. The refusal is recorded as pending on the registration the stamp names, with the candidates, and the reply says the writer could not be told and names them (`writer_pending`, `candidates`, `refusal_id`). The call's own PostToolUse echo names its caller exactly and carries the refusal id back: the insert reads the session's staged echoes first (so a second write normally finds the first's), the SubagentStop hook reads them before it asks, and the drain's echo heal moves the refusal to the writer the echo names, off the registration it sat on, and settles that leg's key as its own through the same settle the writer heal can undo (`key_settled_from`). A second over-cap write whose writer still cannot be told is refused again, never accepted on a guess: it is accepted only when every writer it might be has been refused once. A refusal whose call left no echo stays pending, naming nobody. An accepted over-cap row's mark follows the writer the echo names (`second`).
  - **One refusal through every door:** the library returns it on the insert result (`refused`: the run, key, size, cap, the reason, the shape asked for and the id; `nodeId` empty) and the insert tool replies with it, never an error: `refused: true`, `kind: "checkpoint-over-cap"`, the run, key, size and cap, the `reason`, the `shape` (a shorter checkpoint that is the state of the work as it now stands, names what it supersedes and what it rests on, leaves the history out; a second write past the cap is accepted and marked) and the `refusal_id`. The tool's 50,000-character content bound stays for every row but a checkpoint under a run's key, which the cap governs.
  - **A refusal is no checkpoint (D279, D295, D326):** a leg refused once that stops without writing again has written nothing under its key newer than its start; its refusal's echo settles the key as its own, and both doors send it back once. The reason names the cap and the size refused, and asks for a shorter checkpoint; the ticket door's line to its spawner names the refusal too. A refusal not yet moved to a leg sends nobody back.
  - **What it cost (D321):** the checkpoint accepted over the cap is the one in effect. The key lookup carries `over_cap` beside its `size` (an imported checkpoint's mark is the file's claim, `claimed_over_cap`, never the mark); the next leg's first message, whole at the ticket door and cut at the client's cap with the row id at the hooks door, says `N characters, accepted over the 16000-character cap on its second write` (or `written over the cap by a writer the store keeps no refusal for`); its first-moment row carries `checkpoint_size`, `checkpoint_over_cap` and each checkpoint's mark. A refused insert is not counted by the retention sweep.
- **A run is exported as a unit, and a leg that ran elsewhere comes back into it by the handoff.** Unit 6 of the beta.3 build, over units 1 to 5; with it the last four `journal-runs` scenarios bind and the ruling left the register.
  - **The export takes `run`; its form is the skeleton by default or `whole` (D300, D318).** The export tool takes `run` beside `form` and `path` (`form` gains `skeleton`, the default under `run`; `summaries` is refused for a run, since it carries no checkpoint and no first moment and could not resume one), `treecontext export <path> --run R [--whole --yes]` writes the same file from a shell, and the library's `exportRun(store, { run, form, … })` and `FlatStore.runRows` are the one logic under both. The skeleton is the run's open and close, every brief, every checkpoint under every key in order, every leg's first-moment row whole and summary row, and each leg's registration as data, with no captured tool output; `whole` adds every row of every leg's lane (what `RUN_ROWS_SQL` reads) behind the same secrets acknowledgement as the whole journal: the warning first, nothing written until it is acknowledged. A run the store holds no row of writes nothing and says so. The file's head names the run and the form (`form`, `run`, `holds`) and follows the project-directory path rule and the atomic write of every handoff.
  - **The reply says what the first moments are (D318).** One line, `First moments carry the spawners' prompts as written and may hold what was pasted into them.`, in the tool's reply (`first_moments`), the shell's output and the file's head; no acknowledgement is asked for the skeleton. When a first moment is a door's own line and not a prompt, as every hooks-door leg's is, a second line (`door_lines`) names those legs and quotes how the row ends: `Its prompt rode on the Agent tool and is not seen by this door.`
  - **A leg's registration crosses stores as a row of the file.** The registry is a table, so the file carries one synthesized `leg-registration` row per leg of the run (an id derived from the leg, so the same leg lands once however many files bring it), whose facts (role, run, key, parent, door, how it ended, its start) sit under `_leg_registration`: a claim on import like any other, never a registration of the importing store. The exporting store's table is unchanged.
  - **A leg that ran on another machine comes back by the existing import (D310, D343).** The rows land in `handoff:` lanes with the importer's marks and the file's claims, whole and verbatim, under `_handoff_claims`; ids are kept, so a claim naming a local checkpoint names a row this store holds, and a registration for a leg this store registered itself is already present. After the import the run's facts count the imported leg (`legs_run`, with `imported_legs` and, per leg, `imported: { file, node_id }`, its state the file's claim as of the export and said so in the reply's notes), the key lookup returns the imported checkpoint in effect when it claims to supersede a local one, flagged as arrived by import, the local checkpoint untouched; and the imported checkpoint's return pointer now points at the imported leg's summary row in its handoff lane and says it arrived by import. `RUN_ROWS_SQL` reads the handoff lane's rows of the run in their own moments' order, each naming its writer as `imported from <file>`; the captured rows of a remote leg reach the run through the leg's imported registration. A run whose legs span two stores reads whole from one.
  - **What arrives by import is a review of what happened elsewhere, never a replay (D360, awaiting ratification).** The sender's stamps and trace (`_writer_src`, `_writer_agent_id`, `_door`, `_identity`, `_cwd`, `_parent`, `_parent_src`, `_worktree`, `_branch`, `_supersedes_src`, `_by_src`, `_cap_refused` and the rest of the store-only keys) sit under `_handoff_claims` with everything else the file says, never at the top level; the receiving store stamps only `_door: "import"`, `_identity: "imported"` and the importer's marks. An imported brief is in effect for no role (the next local subagent of its role is a plain subagent, no leg, no context) and an imported close ends no brief here; both, and an imported open, read back as imported in `RUN_ROWS_SQL` and in the lookup's facts (`imported_briefs`, `imported_opens`, `imported_closes`) and notes. An imported checkpoint keeps the number its own store gave it as the file's claim only (`claimed_number`; no top-level `_checkpoint_number`), takes none in this store's sequence and collides with none: the lookup says "number 3 as numbered there", the next local checkpoint takes the next local number, and the supersedes chain is the same as before. A registration is already present only when its defining facts (role, kind, run, door, parent, start) agree with the one this store holds; one that differs, or names another session than its lane, lands as an imported registration row carrying `registration_differs`, the lookup's notes naming the facts. A registration row the export composes bears the store's name as its writer, the leg's writer inside its facts.
  - **An export is one namespace's, and names what it does not carry.** A registration counts only when its lane has rows in the exporting namespace, so another namespace's leg of a run of the same name is never written into the file, and a run with no row in the namespace writes nothing. The skeleton carries no inner run (D311); the head lists them (`inner_runs`) and the tool reply and the shell print one line saying so. `holds` says "its open and close" only when the run was closed, and a whole run export's warning says "run export" (`RUN_SECRETS_WARNING`). The release gate's success line now counts the scenario-scoped entries still open (and their examples) beside saying the whole-feature rulings are bound.
- **The retention valve carries the rows the doors write: a worker's first moment goes with its lane and demotes with the tool bulk, and a leg's summary row is never the valve's.** Unit 7 of the beta.3 build, over units 1 to 6; with it the two `journal-storage` scenarios bind and the ruling left the register. The valve's reach was set by the ticket door (unit 3), which has labelled the first-moment row `auto-capture` since it landed; this unit rules its demotion class and the summary rows' protection and binds the scenarios.
  - **A first-moment row is the leg's capture (D319, D339).** Under the session cap it is archived whole with the rest of its lane's capture (the worker's own captured rows beside it), fsynced before the tombstone and the deletion commit, and evicted with its session; the worker's checkpoints and summary row stay. Over the byte budget it is demoted to its bounded preview (the tool output's 1000 characters), the whole text archived first, with `_full_len` and `_archive_path` on the row. **Its demotion class is the tool bulk, not user text:** the row carries `role: user` as the leg's user turn, which put it with the prose that demotes last, but it is a door's composition (often a pasted file, D313) kept behind a tool-sized preview, so it demotes first, ahead of a person's words however much older they are. The send-back row (D335), the door's other capture, is in the same class. The hooks door's first-moment row is written in the parent session's lane as capture, goes with that session under the cap and is in the same class over the budget; its text is a short line that is its own preview, so there is nothing to shrink and it stays whole.
  - **A leg's summary row is agent-authored for the valve whichever door wrote it (D319, D339).** The ticket door and the hooks door write it with no capture label, but the drain labels a SubagentStop report `auto-capture` (the label drives the index weights and stays), so the valve reads the row's kind as well as its label: a run's own rows (checkpoint, brief, open, close) and a `subagent-summary` that names its run (D336) are never evicted and never demoted. **A plain subagent's summary names no run and stays capture, exactly as today (D305, D263):** drained like any capture, archived with its session and demoted under the budget. The client's own internal-agent report (`internal-summary`) is capture too.
  - **A handoff lane is never the valve's** by the rows' own flag: the import door lands every row read-only (D222), the first-moment, registration and summary rows of an imported run among them, and a read-only row is protected. A test pins it across a session cap and a one-byte budget.
  - **Not a change:** the byte budget evicts no session (D48, D339); a lane with an evictable first-moment row has counted as a session toward the session cap since the ticket door landed, as D339 rules ("a ticketed worker has a session of its own").
  - Two `journal-storage` scenarios bind through the real `treecontext run` wrapper with a 300,000-character prompt and the real sweep, reading the archive and the rows through a separate handle: the cap scenario's worker is a `claude -p` child whose own hooks capture its tool calls into the lane beside the first moment (all archived whole and all evicted, the checkpoints and summary row untouched); the budget scenario holds the developer's own long prompt, captured through the real hook and drain and older than the first moment, which stays whole while the first moment is demoted. "Fsynced before any row moves" is observed, not read off the source: the sweep's own `fsync` (or `fdatasync`) of the archive is watched and, at that moment, the store is read through a separate handle (every row still there, no tombstone, the row whole) and the file off the disk (the whole prompt in it).
- **Install turns Claude Code's idle compaction off, doctor carries the setting on its own row, and neither touches a setting you made; uninstall takes out only the key install wrote.** Unit 8 of the beta.3 build, over units 1 to 7; with it the idle-compaction scenarios of `journal-install` bind and leave the register (the seventh after the owner's split at the final gate, D367). The client summarises a long conversation while the session sits idle, which replaces the checkpoint-then-`/clear` boundary and throws away the prompt cache the journal exists to keep (D290, D361).
  - **Install writes `"idleCompaction": false` into `~/.claude/settings.json` when the key is absent and the client is known to read it** (Claude Code 2.1.290 and later), and says so in one line with the reason and where to turn it back on: the client's `/config` Idle compaction row from 2.1.302, the settings line alone from 2.1.290 to 2.1.301, where the client honors the key and has no row, so no remedy names a row the client lacks (D290, D338). The key is the client's own, a boolean defaulting to true (Anthropic's settings reference, and the 2.1.316 client's settings schema).
  - **Install says nothing about a key you set, on, off or anything else, on this run or any later one, and writes nothing (D361).** Its one line belongs to the run that wrote the key. Doctor is where a key set to on is seen. The scenario "a client that honors the key but has no /config row is pointed at the settings line alone" asked install for a remedy with the key already on, which contradicts that; the owner split it at the final gate (D367) into install's line at 2.1.295 with the key absent (the settings line named, no /config row) and doctor's settings-line-only row with the key on, and both halves bind.
  - **A settings file Claude Code reads is read the way Claude Code reads it.** Comments and trailing commas are valid settings, so the hooks step keeps every key of such a file (it rewrote one it could not parse strictly from nothing, and install then wrote `false` over the user's `true`); a file that is no settings object at all is backed up to `.bak` before it is rebuilt, and the key is not written into it.
  - **Below 2.1.290, or with a version that cannot be read, install writes nothing and says the setting is not applicable to this client**, naming a version it read and asserting nothing about one it could not; an install run after the client is upgraded writes it then (D304). The version is what `claude --version` prints on PATH, run as the leader of its own process group with a 5-second bound and killed with its group, so a shell-wrapper `claude` leaves no child behind; no binary, a failing one, or one that prints nothing with a version in it is "cannot be read".
  - **Doctor's `Idle compaction` row** (shown wherever Claude Code is detected) says `off in <file>` and that only that file was read, since a project, local or managed file can set the key too; or, below the floor or unreadable, `the setting is not read by this client, version <x>` (or `version unknown`); or warns that treecontext recommends off with the `/config` row first and the settings line second, the settings line alone from 2.1.290 to 2.1.301. A key that is absent warns the same, since the client's default is on, and its fix is the command that clears it, `treecontext install`.
  - **Install records that it wrote the key, and into which file, in `~/.treecontext/install-state.json`; uninstall removes the key only when that record exists and the file still holds `false`** (D361). A value you set, or set since, is never touched, and a client is not left with a setting install chose after treecontext is gone. `--hooks-only` leaves it.
  - The README's install section (section 2) says install turns idle compaction off, why, and where to turn it back on; section 3 says the rest. Only the user's own settings file is read.
- **The beta.3 bindings are audited on the failure ladder, and the suite's stand-ins live in one module a guard holds them to.** Unit 9 of the beta.3 build, over units 1 to 8; no product code changes.
  - **`docs/beta3-bindings-audit.md`** classifies all 123 scenarios tagged D279–D361 by the door each act goes through, what each Then reads (the store file through a separate handle in 111 of them), and its rung, with totals per feature; and lists every mutation the unit reviews carried forward as charter-silent, each lit now, needing a scenario (written out for the owner), or not to be lit in owner language.
  - **Five bindings now catch what they missed, each proved by its mutation in a copy of the tree:** the skeleton export, with a `claude -p` worker leg sent back once in its run, refuses a send-back row in the skeleton (its rows as D360 lists them); the whole form carries a worker's lane, its captured calls and its send-back row; the D55 ordering scenario reads the archive and the store at the archive's fsync, catching an archive written after the rows it should hold were deleted; the corrupt-config scenario holds both of the reference agent's config files to their backup; and the hooks door's state-not-history line is asserted in its three parts rather than against the source's own constant.
  - **The stand-in harness, `tests/journal/standins.ts`**, holds every stand-in a binding uses: the hooks-door leg, the two stand-in processes' launcher and their plan vocabulary (now typed once and imported by the processes), the library-door registration and the named retirements a Given of history needs, and the fake `claude` install and doctor read. Its header says what each stands in for, what it may do and what it must never do, and that its helpers carry names and confinement, not rules. The guard "no binding stands in for a door outside the stand-in harness" fails on any mention of a door's own act outside comments and strings (any call shape, a bracket access, an import alias) and on a plain insert naming a door's row kind, in any steps file, journal harness module or test helper, outside the harness and a reasoned allowlist. The stand-in `claude -p` child writes its notes and checkpoints only through its own tools, each echoed, as a real child can; it learns `toolText` and a send-back's `checkpoints`.
- **The bindings audit's owner items are in the charter and bound, and the final gate's rulings are recorded.** Unit 11 of the beta.3 build, at the final gate over units 1 to 10 (2026-11-01): the owner ratified D357–D361 (D362–D366), split the install scenario whose install clause contradicted D361 (D367), named the export reply's door-line note (D368), declined a pointer for a background leg to the fence (D369), and approved thirteen scenarios the audit had found no words for, the `claude -p` child's identity line (one line naming who it is and its first-moment row, never the first moment again), the phantom outline's ticket-door row, the `@D360` tag on the skeleton scenario and the two `claude -p` rows' wording; every one binds through the real doors and is red under a mutation.
  - **Two product defects the new words found.** The key lookup never found an imported hooks-door leg's return: it matched the summary row on a top-level writer stamp that an imported row never carries, since D360 keeps the sender's stamps under the file's claims; it now reads the claims (`src/key-lookup.ts`), and the export reply's door-line note names an imported hooks-door first moment by the leg the file claims, not by its handoff lane (`src/run-export.ts`). The handoff-claims key moved to `run-kinds.ts` to break an import cycle; `runs.ts` re-exports it.
  - **The ticket door's line for a refused write says so.** A store the door could read but which refused its own write (the registration, the run's open, the first-moment row, a refused ticket's row) was reported with the busy-wait line, "could not be read after waiting 5 s", a cause that had not happened; it now says the store "refused the worker's start" with the error, nothing written (exit 75 as before). The busy-wait line stays for a store that could not be read.
  - **The run export file's head carries the door-line note under its own key**, `door_lines`, beside `first_moments`, as the tool's reply does; it had been joined into `first_moments`.
  - **The orchestration matrix (D370).** The README carries a second compatibility matrix, its own table apart from the hook-support one: one row per client (Claude Code, Codex CLI, Antigravity CLI, the last a row of the matrix only, no agent entry), one column per orchestration role (a headless worker through the ticket door; the worker's pen; its own tool calls captured; a main that registers itself and spawns workers; subagent legs through the hooks door; the pointer on the Agent tool's return), every cell `verified live`, `verified through a stand-in`, `documented only` or `not possible` with the date it was checked, a `not possible` cell naming what the client lacks. Claude Code is the primary client of beta.3; Codex CLI and Antigravity CLI are secondary, headless workers through the ticket door; beta.3.1 targets every cell a client makes possible, verified live. Antigravity's workers reach the tools by one line the user adds (`agy mcp add treecontext -- treecontext serve`), verified live at the gate: a real `agy -p` (1.4.12) through `treecontext run` wrote its checkpoint through that server into its own lane, by its role and parent, and was retired with its return, no send-back; its subagent legs and pointer are `not possible` (no SubagentStart or SubagentStop event in its hooks). A `journal-clients` scenario binds the table's shape. **Live at the gate (2026-11-01):** a real `agy -p` and a real `codex exec`, each through `treecontext run`, wrote their checkpoints through the tools into their own lanes and were retired with their returns; the Codex run first landed its checkpoint in no lane with no writer, because Codex forwards a parent's environment to an MCP server only for the names its `env_vars` lists, so **install's Codex entry now carries `env_vars = ["TREECONTEXT_TICKET", "TREECONTEXT_WORKER_SESSION"]`** and an entry an earlier build wrote without it is updated on the next install without `--force`; a hand-written Codex entry needs the same line (the README says so). The stray checkpoint behaved as D293 and D296 rule: accepted, traced to nobody, flagged as an unknown writer, superseded by the next leg's.
  - **A worker's first-moment row ranks in search like a user turn and demotes like tool bulk, on purpose (D260, D272, D319; the owner's "meaningful query results", 2026-11-01).** What a worker was told is what a later session searches for, so its words index at the user weight behind the 8000-character index view; the valve shrinks the row first because it is a door's composition, often a pasted file, not a person's words.
  - The review's failure ladder over the unit (findings 1 to 6) is answered in `docs/beta3-bindings-audit.md`: the "no /config row" clause of the settings-line scenarios is an earned absence now, the ticket-door phantom row no longer compares two moments one transaction stamps alike, and the cross-store return scenario runs a second subagent under the same parent so the pointer must pick the reviewer's row by its agent.
- **Housekeeping before the release.** Unit 10 of the beta.3 build, over units 1 to 9.
  - **The server reports the package's own version** to a connecting client (`serverInfo.version`), read once from `package.json`; it said `1.0.0` whatever the release.
  - **Log rotation keeps the newest five.** Rotation runs when a process opens its log, after its own file exists, and kept four where the constant said five. A log written in the last five minutes, or by a process still running, is never removed, so more than five can sit on disk inside that window (a burst of hooks leaves them all until the next open past it); the README's troubleshooting section says so.
  - **The hooks finish inside the 9 s rule against a store another process holds whole, with the write patience cut from 8 s to 7 s and the guard left at 1 s.** Measured with the built hooks (three runs): Stop and SubagentStop 8.10 s and the single-open hooks 7.09 to 7.11 s, against Stop 9.1 s and SubagentStart 8.1 s in unit 4's measurements. The trade is a busy store gets a hook's write 7 s of patience instead of 8 s; the guard read is unchanged because a lookup that cannot read within its budget is no evidence (D263). A new test runs each real hook against a locked store, in the same run as its unlocked baseline, and holds both the rule and what the lock added. The hook's second opens (the fresh-store bootstrap, the hooks door's journal) wait what is left of the budget, not the wrapper's 10 s.
  - **Several processes opening one store at the same instant no longer fail with `database is locked`.** The wrapped opener ran `journal_mode = WAL` before any busy wait was set, so a handle built with node:sqlite's own default (no wait) lost the race to the first opener's WAL recovery; it now sets the open's wait (the raw opener's 5 s, or the caller's `timeoutMs`) first, runs its pragmas, then sets its own 10 s default last as before, so a locked store still answers `openNodeSqlite(path)` after 5 s. A wrapped `DatabaseSync` with timeout 0 now waits that 5 s during the open where it failed at once. Six writers racing on a fresh store: 12 of 20 rounds had a casualty before, none after.
  - **An archive's directory is fsynced after the archive file,** before any row it archives moves, on platforms that can open a directory (not Windows), so a crash right after cannot lose the file's directory entry once the rows are gone.
  - **The README's team-handoff section and the reference skill name the run export** (`treecontext export <path> --run R`, `--whole --yes`; `treecontext_export` with `run`). The dependencies are at their latest again: `@opencode-ai/plugin` 1.19.5 and `@types/node` 26.6.6.

## 0.1.0-beta.2.1 — a hotfix: the recovery snapshot stops quoting itself, and no reply can end the connection (2026-10-30)

Upgrading bounds every recovery-snapshot row a store already holds, on its first open by this version (migration 030); stored content is not touched. Quit every running session before upgrading, as for beta.2. Re-run `treecontext install` afterwards: it converges the hooks (below).

- **The recovery snapshot row no longer grows without bound, and no longer quotes itself.** After a compaction, the next session's drain runs the recovery queries the pre-compact hook recorded and writes one row quoting what they found. From beta.1 to beta.2 that row quoted every hit whole, carried no boundary, sat in the note column, and held the literal query text, so at the next compaction it was the best match for its own queries and quoted itself again: rows compounded geometrically per compaction (93,751 / 370,389 / 1,426,928 / 5,495,219 / 21,146,347 chars on one store between 2026-10-27 and 10-29) until one `treecontext_query` reply was over 16 MB, Claude Code's single-message guard for a stdio server, and the client dropped the server: `wrote >16MB to stdout without a JSON-RPC message boundary ... Disconnecting`, twice on 2026-10-29, the second time until a manual `/mcp` reconnect. Now the row quotes each hit at its display view and no further than 2000 characters, names the entry it quotes, never quotes another recovery snapshot, keeps the recovery queries in its metadata and out of its indexed words, and carries its own display boundary (2000 characters) and index boundary (the 8000-character tool default), so a hit on it is a bounded preview with the availability marker, like a tool event's. Migration 030 stamps the same boundaries on every recovery-snapshot row a store already holds and re-indexes it to the boundary; its words stay and `treecontext_export` still returns all of them (D286, amending D35: what the drain writes from a snapshot is in the charter now; only the compaction interaction itself stays with ccr).
- **A reply never approaches the transport's limit.** A `treecontext_query` reply that would serialize past 4 MB, a quarter of the client's guard, has its entries' contents cut, hits and window entries alike, at a cap that shrinks until the reply fits; each cut entry ends in `…[cut to fit the reply ceiling; full content N chars via treecontext_export]`, and the reply carries `_reply_ceiling` with the ceiling, the cap and how many entries were cut. A `treecontext_export` of one entry over the ceiling is refused with the entry's id and both sizes, never cut, because export promises the whole entry (D287).
- **Install converges the hooks under a matcher it did not write.** Reinstalling rewrote treecontext's hook commands only inside the matcher groups it was about to write, so a copy of our command under any other matcher, a hand-merged `startup|clear` group for one, survived every `--force` and fired beside the new one: session-start and the reminder ran twice on every startup and `/clear`, and doctor's "degraded session identity" named a fix that could never clear it. Install now takes our commands out of every matcher first and writes the block it grades; foreign hooks sharing a group stay (D51).
- The suite no longer edits the developer's real `~/.claude.json` (a test-only change).

## 0.1.0-beta.2 — the journal recalls as well as it captures: notes outrank the tools' chatter, echoes keep their place, captures read as text, and a stale server steps aside (2026-10-11)

Upgrading re-indexes the treecontext echoes a store already holds, on its first open by this version (migration 028), and re-marks the client's internal-agent reports stored as subagent summaries (migration 029); stored content is not touched by either.
Re-run `treecontext install` after upgrading: it refreshes the installed reference skill's text, which until then still says recency fusion is served at `0.5` and does not state the ranking order.

- **A server older than its store steps aside and says so.** On the beta.1 night a still-running `rc.7` server sat beside a store the new release had migrated: its insert failed on the new index, the dead-letter record that would have retired each row failed on the same path, and the valve rightly kept the rows, so it retried 5 staging rows every 5 s for 2 h 20 min, about 1620 attempts each, until the beta.1 server drained them all on its first start. The valve was right; the gap was in noticing. Now a server whose drain finds the store's schema version past the one it was built for releases the drain lease and its row claims, writes one warning, and stops draining and sweeping; the newer server takes the drain on its next tick, with no wait for the lease to expire, and drains every staged event. Every tool call reads the version too, at most once every 5 seconds and without taking a lock, and against a newer store every tool, status included, replies with one line: `This store was migrated by a newer treecontext (schema N; this build understands M). Restart this session to use it.` A tool that fails re-reads the version before replying, so a migration that lands inside those 5 seconds still answers with that line, never a raw constraint error. Hooks keep staging into the store; what they stage waits for the newer server. A server that never held the drain stops its sweeps the same way. A beta.1 server has none of this, which is why the README now says to quit every session before upgrading (D265).
- **Doctor names a staging row retried far past the ceiling, and the process spinning on it.** A row is retired as a capture gap after 3 failed attempts, so an unprocessed row past ten times that means the dead-letter record itself fails on every tick. The Capture debt row now names the most-retried such row, its attempt count, how many rows are past the line, and the drain lease's holder (`pid@host`), the one persisted evidence of who spins, since the drain releases its row claims at every tick's end; when that lease is live and held on this machine, the fix is the bare command that stops the process (`kill <pid>`, or `taskkill /F /PID <pid>` on Windows) and the row says to restart that session and that `treecontext doctor --dump-logs` shows what it logged; otherwise the row says to quit every running session and the fix is `treecontext doctor --dump-logs` (D265).
- **The README says to quit every running session before upgrading.** It is the upgrading section's first instruction now, with the reason: a server from the older release keeps running against the store until its session ends, and a beta.1 server, which has no step-aside, keeps draining beside a beta.2-migrated store but without this release's echo re-indexing, so the echoes it drains are indexed with their results until a beta.2 server heals them (D265).
- **The import tool says a handoff is read-only by default.** Its description now says plainly that an import, from a file or pasted, is read-only unless `read_only` is false, and what that means: the entries cannot be modified, only queried, exported or deleted, and retention never evicts or shrinks them (D266).
- **The package's `bin` path drops its leading `./`.** It reads `dist/server/cli.js`, the manifest convention; npm normalised either form, so installs are unchanged (D266).
- **The client's own internal agents are marked as such, never as subagents.** Claude Code fires SubagentStop for agents nobody spawned, the compaction summarizer and prompt-suggestion side calls, with an agent id and no agent type, and each of those reports was stored as a subagent's summary under its agent id. On the owner's store they outnumbered real subagents about ten to one over two days of beta.1 (21 against 2), 18 of them under 100 characters, the largest a 26,598-character compaction summary (11 KB stored), and the subagent summaries were 23 of the 42 entries in the default handoff file. Now a SubagentStop whose agent id no SubagentStart registered and whose payload names no agent type is captured whole and searchable by its words as before, but as kind `internal-summary` with the writer `claude-code`: no subagent summary, so it stays out of the default (summaries) handoff, and like every row stamped by the hook it is never the packet's chapter or bookmark nor a resume pointer; a whole-journal export still carries it. Nothing is filtered out; only the marking changes. A user subagent type named `claude-code` is written `agent:claude-code`, so the two never share a lane. The hook marks a report internal only on evidence: a registry it could read and that holds no registration, live or retired, for that agent id; a lookup that cannot read the store keeps the report a subagent summary. Migration 029 re-marks the subagent summaries a store already holds that the hook captured with no agent type (their writer is their own agent id) and that no SubagentStart registered, leaving content and every other key as they were; a row written through the tools and any row in a handoff lane are left alone, so an untyped internal report already imported from a beta.1 handoff file stays a `subagent-summary` in its handoff lane; on a copy of the owner's store it re-marked those 21, their content bytes unchanged and the 2 typed ones untouched, and the default handoff went from 42 entries to 21, the 19 chapter summaries and the 2 real subagents' (D263).
- **The handshake's second step says what it is for, and the skill says what ranks where.** The session-start query (`what was I working on, what was the next step`) is kept, and the handshake now says it recovers the thread around the resume pointers status found; the card is 1979 characters, under the reference platform's 2 KB cap. The reference skill's search paragraph states the ranking order as served: the developer's directives and the curated notes first (user and note at `1.0`), assistant prose and captured tool output below them (`0.25` and `0.1`), and treecontext's own calls, captured as echoes, found by their tool name and never by their results. No query parameter was added (D264).
- **Doctor says in one line that nothing is set up yet.** A second beta tester ran the npm install the README showed, ran `doctor` as it said, and read four right warnings, each ending in its fix, as a failed install. On a machine where no agent is wired (no global config, no launcher, no client configured), doctor's first line after its header now says `treecontext is not set up for any agent yet — run: treecontext install`, and every client row below it names that same command as its fix, which wires every detected client and clears each row; a machine with anything wired keeps the per-agent `--force --agent` fix (D276).
  - At a beta tester's suggestion, the README's doctor check moved from the install section to the first step of "Verify it's working".

- **Captured tool output ranks below assistant prose.** Search weighted a tool's output the same as the developer's own words and the agent's curated notes, so on a store a few weeks old an orientation query ("what was I working on, what was the next step") returned shell transcripts and the echoes of its own earlier runs ahead of the notes it exists to find: on the owner's store the first curated note ranked 45th. The default weight of tool text is now `0.1`; developer turns and curated notes keep full weight, assistant prose stays at `0.25`. The bench's capture-path arm measured it: `0.1` is the lowest weight at which matching shell rows still order among themselves (53% MRR@5 from `1.0` down to `0.1`, 8% at `0`), and no shell row reached the orientation query's first page at it. At the served recency of `0.25` it beats `0.25` (+2.37pp MRR@5, 0 hurt and 9 helped, p≈0.004); only at the old recency of `0.5` was the difference within noise. A lower weight never hides a row: a shell event found only by its own output is still a result, and `role_weights` still sets every weight per query (D260, amended by D272).
- **Recency fusion is served at `0.25`, down from `0.5`.** At `0.5` the recency term outweighed about the first seventeen lexical ranks, so an exact lookup of an older note or developer turn lost to newer rows that merely shared its words: on the capture-path arm all 97 queries, orientation included, scored 49.95% MRR@5 fused against 89.78% pure lexical. At `0.25` the orientation queries keep what `0.5` gave them (the fresh plan first on the same three of six, no shell row on the page) while all 97 rise to 63.02% (notes from 37.85% to 59.51%, developer turns from 26.67% to 47.28%; thirty-nine helped, one hurt). The owner chose `0.25` over keeping `0.5` and over `0.35`; the library default stays `0`, `recency_weight: 0` still opts out, and adaptive and chronological queries still never receive it (D273, D274).
- **A chapter summary is placed above a bookmark on the page as served, and a bookmark is findable by its own words.** A bookmark's score was multiplied by a quarter inside the ordering that chose search's candidates, so on the owner's store, with six hundred rows carrying the word, the live bookmark fell outside the first two hundred for its own first sentence. The factor is retired: a bookmark ranks by its own words like any entry, and after the candidates are chosen and recency fusion has ordered them, each matching live chapter summary is moved above the first matching bookmark ahead of it, the rest keeping their order; a superseded chapter ranks where fusion left it. On the capture-path arm every bookmark lookup now finds its bookmark in the first five (four of six with the factor, at the same weights), MRR@5 54% to 56% at the served defaults and 28% to 58% pure lexical (D275, amending D262).
- **A metadata filter answers from the whole journal.** `metadata_filter` sifted a pool of at most two hundred ranked candidates after the ranking, so a filter on `kind: "bookmark"` returned nothing once enough rows carried the query's words. A filter's flat keys (a string, number, boolean or null at the top level of metadata, such as `kind`, `status`, `thread`, `type` or `next_session`) now narrow the candidates in the query itself, each compared by its JSON type as before (`true` never matches a stored `1`, `null` only a stored null, an absent key nothing); a nested value, a key that is not a plain name, and the media and namespace filters still sift the pool (D268).
- **A treecontext echo is searched by its tool name or its arguments, never its results.** The hook captures every treecontext tool call, and each of those echoes was indexed up to the 8000-character tool view, so a query's echo carried every hit's preview, a status echo every resume pointer, and an insert echo its note a second time, all matching later searches. An echo is still stored in full, still shown in full on a hit and in an export, and still read by the writer and session heals; only its reach into the index narrows: query, insert, export and status echoes are found by their tool name, delete, merge and clear echoes by what they were given, and an import echo by its tool name and label (the hook now writes the label on its own line). A query echo that indexed its own query text matched every repeat of that query better than any note could. The boundary is stamped on the row by the drain, and by the import door for an echo a handoff carries, so any build rebuilds the same index text; the retention sweep shrinks an echo to its display preview, never to that boundary, and likewise a captured tool row whose index cap was set below its preview now demotes to its display preview rather than to the cap (D261).
  - Echoes a still-running beta.1 server drains after the upgrade are healed by the next beta.2 server: once at its start and then in its five-minute sweep, at most 500 rows a sweep, it re-stamps and re-indexes any echo outside a handoff lane that is not at its arguments boundary, exactly as migration 028 does, content untouched (D265).
- **A tool's output is captured as its text, a line a line.** Claude Code hands a tool's response to the hook as an object (Bash's `stdout`, a Read's `file.content`, an MCP call's content blocks), and the hook stored its JSON encoding, so every line break became the two characters backslash and `n`, and the search index read the word that began the next line glued to that letter: only the first line of a shell output, a file read or a grep result was findable by its own words, and a commit hash deep in a `git log` was found only as `n<hash>`. The hook now writes an object out as text, every field in order, a text field as its name and then its lines, a nested field under its path (`file.content:`), any other field as its name and value, and a content block's text verbatim, so nothing the client sent is dropped and every line's first word is its own token; a string response is stored exactly as before, and a shielded pointer is recognized whatever shape the client wrapped it in. Entries captured before beta.2 keep their stored text: they are found by the glued form (`n<word>`, `t<word>`) for the words that began their lines (D270).
- **The bench has a capture-path arm.** Every earlier bench arm inserted straight into the store, so nothing measured a journal as capture really makes it, and no arm could weigh a tool weight. `mature-journal` builds a synthesized journal of six sessions through the real hooks, the real drain and the real MCP server (276 captured tool rows, echoes among them, against 24 curated notes) and scores 97 lookups by kind at the served defaults; `npm run bench:weights` sweeps a role weight over it. On this fixture the orientation query's gold rank does not move with the tool weight, but the shell rows crowding its first five do (6 of 30 slots at 1.0, 3 at 0.5, 1 at 0.25, none at 0.1 or 0); tool 0 against 0.25 helps 12 developer-turn lookups and hurts none (p≈0.0005), and drops how matching shell rows order among themselves from 53% to 8% MRR@5. The owner held the ruling on D260's `0.25` until the sweep is re-run on captures made under D270 (above), with a slice that scores how matching shell rows order among themselves. The arm also priced the served recency fusion on lookups of older rows (49.95% MRR@5 fused, 89.78% pure lexical; `npm run bench:recency` sweeps it) and found that the capture JSON-encodes an object tool response or input, so the token after each newline or tab is indexed glued to an `n` or a `t`: of 886 commit hashes in the fixture's `git log` outputs only the 60 on a first line were findable, and `modified` from `git status` was indexed only as `tmodified` (measured before D270; after it, 886 of 886 and `modified`). Reported here, fixed by D270 (D266).
  - The bench's two detectors flag a nonzero change over a zero standard error instead of calling it noise, so a slice sitting at 100% can flag a loss (a checkpoint slice that fell 50pp had printed "0.0 SE, within noise"); a zero change over a zero error stays within noise, and a slice's flag stays the slice's (D271).

## 0.1.0-beta.1 — the packet and the bookmark carry the thread, the handoff is a file, a note answers a note, and every client gets its mode

The first public release, published to npm as `treecontext-mcp` under the `beta` dist-tag (`npm install -g treecontext-mcp@beta`).
Existing installs must re-run `treecontext install`: the hook set grew and the hooks' commands changed (on macOS and Linux each now execs its wrapper, which keeps session identity where `/bin/sh` is dash), and `doctor` reports "hooks incomplete" or "degraded session identity" until you do.

- **Doctor's locked-store row claims no more than the platform can say.** Only Linux can name the process holding a store's write lock (through `/proc/locks`); Darwin's `lsof` does not see SQLite's fcntl locks, and Windows has no lock-holder API without native code. Doctor on macOS listed the actual locker as "not the cause" and offered an `lsof` line as the fix, and on Windows offered that same `lsof` line, which Windows does not have. Now, where the holder cannot be told from a bystander, the row names every process holding the store open with its command (`lsof` on macOS, the Restart Manager through PowerShell on Windows), says the platform cannot tell which owns the lock, and the one fix command stops them all (`kill …` or `taskkill /F /PID …`), a running server reopening the store on the next session; Linux keeps naming the holder alone. The three-OS suite also stopped assuming Linux in six tests (D259).
- **The bookmark request reads as housekeeping.** The stop hook's request for a bookmark, which Claude Code shows the developer as a blocking hook message, now says it is routine, that nothing is wrong and that the developer has nothing to do, and tells the agent to finish the turn as planned once the bookmark is written.
- **A healthy server is quiet on stderr.** Serving a client, the server writes its diagnostics to its log file under `~/.treecontext/logs/` only and keeps stderr for warnings, errors and fatals, so Claude Code's own log no longer shows a healthy `--debug` start as a page of errors; `doctor --dump-logs` still prints the whole story, and hooks keep their diagnostics on stderr (D258).
- **The final answer of a turn is captured, not the one before it.** The
  Stop hook read the assistant's response from the session transcript,
  and when Stop fires the transcript still ends at the previous turn, so
  every captured response was one turn late and a session's final answer
  was never captured (live probe, Claude Code 2.1.293, headless). It now
  captures from the Stop payload's own `last_assistant_message`, falling
  back to the transcript only for a payload without it (D249).
- **Hooks keep the session's identity where `/bin/sh` is dash.** Claude
  Code runs every hook command through `/bin/sh -c`; dash (Debian,
  Ubuntu) forks a bare quoted path, so each hook's parent was a
  short-lived shell and the pid-keyed joins — the session beacon, the
  /clear packet's link to the session it continues, the hook's namespace
  annotation — never matched there; attribution fell back to the insert's
  echo and a /clear's packet could not find its predecessor. Install now
  writes `exec "<wrapper>"` (Windows forms unchanged), and `doctor`
  grades an old command as degraded session identity (D251).
- **The store knows who wrote each row, a subagent's included, and a
  worktree resumes its own thread.** Your orchestrating agent and every
  subagent it spawns share one Claude Code session and one server, so a
  tool call never says who is speaking. Now the hooks tell the store:
  the session-start hook registers where the session runs (worktree,
  branch, directory, as git reports them), and two new hooks,
  SubagentStart and SubagentStop, register each subagent under that
  session and retire it (migration 027: a `session_registry` table, and
  the writer's fields on staged rows). Every row is stamped with its
  writer by the store, never by the writer's say-so: a subagent's
  captured tool calls carry its role from the platform's own payload
  (`_writer: "tester"`). A note written through the tools is stamped as
  the server reads the registry — yours (`main`, or `worktree:<name>` in
  a git worktree) when no subagent is live, or when one is but you have
  been active beside it, as a background subagent leaves you;
  provisionally the subagent's when it is the only one live and you are
  waiting on it; yours, marked `ambiguous`, when several are — and then
  made exact by the call's own echo: the PostToolUse event of each insert
  names its caller, and the drain sets the writer from it. If that moves
  a note to another lane, any pointer it retired under the first guess is
  put back and recorded as a reference, any retirement it suffered from
  another lane's writer is undone, and a supersession it could not make
  under the first guess is made. Until that drain, a few seconds, a
  wrongly guessed note acts in the lane it was guessed into. The insert
  reply now says the
  `writer` it stamped and why, and a
  caller's own `_writer` is dropped. With the stamp in place, the lane
  protection of the last entry takes effect for real subagents: a tester
  can answer your chapter but cannot retire it, its bookmarks retire
  only its own, and its pointers never stand in for your chapter or
  bookmark in the packet after a /clear — exactly once its notes' echoes
  have drained, and in the seconds before that as far as the guess at
  insert was right. Older
  rows that name no writer and new rows stamped `main` are one lane.
  When a subagent finishes, its last message is captured as its summary
  (`kind: "subagent-summary"`), found by search; `treecontext_export`
  with `writer: "tester"` reads its whole trail on its own, oldest
  first, none of yours mixed in. A subagent's searches default to its
  role's earlier trail and the plan it was spawned under (your live
  chapter, and notes whose `brief_for` names its role) only when the
  store can tell the caller apart — one subagent live and you waiting on
  it; otherwise, as while you work beside a background subagent, every
  search covers the whole store. `scope: "all"` widens a scoped search,
  and the reply's scope says which ran and why. In a git worktree,
  status lists that worktree's own pointers (`scope: "all"` for every
  lane). Restarting, resuming or clearing a session retires any subagent
  it still had registered. A session starting in a
  git worktree is handed that worktree's own newest chapter, whatever
  its session id, and never another worktree's; a worktree with no
  chapter yet is handed the note whose `brief_for` names it. Reinstall
  (`treecontext install --agent claude`) to add the two subagent hooks;
  until then no subagent is registered, so its notes are stamped as
  yours at insert and set right only when their echoes drain, any
  pointer one retired in between put back then.

- **A handoff is a file the server writes, and it tells its reader how
  to use it.** Until now the only route to a handoff file ran through
  the conversation: the agent exported the journal inline, every entry
  of it on the token bill, and wrote the file itself, and the export
  silently stopped at the oldest 5000 entries. `treecontext_export` now
  takes a `path` inside the project directory: the server writes the
  file itself, with no cap, and only the file's name and the count come
  back. By default a handoff holds the chapter summaries
  (`form: "summaries"`), and the subagent summaries, which SubagentStop
  now marks as kind `subagent-summary` in this release (D147), but no
  bookmarks and no
  captured tool output; the whole journal is `form: "whole"`, and the first call
  writes nothing and answers that captured tool output can hold secrets,
  tokens and keys, so the file is written only by a second call with
  `secrets_acknowledged: true`. An inline export's default rose from
  5000 entries to the 10000 cap, and it now keeps the newest rather than
  the oldest; it says how many it left out and that a file reaches the
  rest. Every file opens with its
  own head: who exported it, when, from which project, which
  treecontext version wrote it, what it holds, and the one step that
  imports it; the importer still reads only `exported_by`, as the
  sender's claim. `treecontext_import` takes the same `path` (or pasted
  `data` with a `label`, never both), reads the file itself without the
  pasted door's 5 MB cap, and marks every entry as imported from that
  path exactly as before. A path outside the project directory is
  refused, `..` and symbolic links alike, and the reply names the
  project directory as the only place a handoff may go: the directory
  the server was started for, never one the agent names. Inside it, a
  path under `.git` is refused, and an existing file is replaced only
  when it is itself a handoff, so an agent cannot be steered into
  overwriting `package.json` or a git hook; a file read by path that is
  not JSON is "not a handoff file", with none of it echoed back. From a shell,
  `treecontext export <path>` writes the same bytes the tool writes
  (`--whole --yes` for the whole journal, after the same warning), and
  `treecontext import <path>` replaces the tree-era tombstone, which now
  meets only a `.msgpack` dump.
  Two bound scenarios are reworded under a sanctioned change, titles
  unchanged: journal-library's whole export and design
  output-shielding's oversize export now say the whole journal is chosen
  and its secrets warning acknowledged.
  Charter: journal-handoff, the beta.2 set (D170, D172, D177, D199,
  D229-D234).
- **A note can answer an earlier one, and the earlier one shows who
  answered.** An entry names what it responds to in `metadata.refs`, by
  id, git-style: nothing is copied and the earlier entry is never
  touched. The store keeps the reverse index (migration 026: a
  `node_refs` table, backfilled from the refs already in your journal and
  kept by triggers, so every writer maintains it), and every read surface
  shows an entry's `referencedBy` one hop deep: how many entries refer to
  it, and one referrer's id, writer, age and first line — the newest from
  another writer when there is one, so your own follow-up notes never
  hide a subagent's or a teammate's answer. Search hits and
  `treecontext_export(node_id)` carry it; the packet after a /clear names
  the referrer under the chapter and the bookmark (`referenced by: <id>,
  tester, 20 minutes old: "CSRF blocks the plan's next step"`). The
  referrer is never shown in full and its own referrers never ride along:
  walking further is a fetch by id, so the trail you did not ask for
  stays out of the context window. Referrers are read inside the entry's
  own namespace only.
  `supersedes` now respects lanes, on the writer an entry names: a target
  the same writer wrote is retired as before (a new session of the main
  checkout still retires the last one's chapter), and a target another
  writer named (`_writer` or `agent_type` in its metadata) is left byte
  for byte as it was, live in status, its id going into the new entry's
  `refs` instead and listed under `referenced` in the reply. In this
  release the server stamps the writer itself, from the session
  registry at insert and the call's own echo at the drain, and drops a
  caller's copy, so the protection holds for real subagents (D240); a
  row the store cannot tell apart owns no lane. When an insert is a duplicate and
  writes no row, the reply now says which of its refs were not recorded
  (`refs_not_recorded`) rather than dropping them silently. The insert
  tool drops any `_handoff_*` key a caller sends: those marks are the
  importer's alone, so a note can no longer pose as imported.

- **Doctor gives every documented client its mode, its state and its
  remedy, and a copied configuration is graded against the block install
  writes today.** Until now doctor's rows for the five other clients said
  little more than "hooks not managed here". Each now carries three halves,
  in the compatibility matrix's words: Codex CLI copies the hooks into its
  own configuration, Gemini CLI into its own translated configuration, VS
  Code reads the Claude settings file when `chat.useClaudeHooks` is on,
  Cursor reads it by default, and OpenCode offers no shell hooks, so the
  tools are its whole surface. The state is what doctor found: for VS Code
  the setting read from VS Code's own `settings.json` (comments and
  trailing commas allowed, unset read as VS Code's default, off) and
  whether the Claude Code hooks block in `~/.claude/settings.json` is the
  one this build installs; for Cursor that same block; for a copying
  client its copy, read from `~/.codex/hooks.json` (nested or the top
  level an older build wrote) or `[hooks]` in `~/.codex/config.toml`, and
  from `~/.gemini/settings.json`. The remedy is the step that makes it
  correct: the flagged command that copies the hooks, turning the setting
  on, or nothing to do. The copy itself changed to match what the record
  always said it was: `install --agent codex|gemini
  --experimental-capture` now writes the Claude Code block, verbatim for
  Codex and with Gemini's event names (`BeforeAgent`, `AfterTool`,
  `BeforeTool`, `PreCompress`; no subagent events, and Claude's `Stop`
  left out, since Gemini's `AfterAgent` treats a deny as a forced retry)
  for Gemini, running the
  same `~/.claude/hooks/tc-*` scripts, instead of pointing at the
  unverified `codex/` and `gemini/` adapters; one run replaces any entry an
  earlier build wrote and keeps the user's own hooks. A copy whose
  treecontext entries match that block reads present and consistent; one
  that differs reads present and inconsistent, names the events it differs
  on, and offers the same command to rewrite it, which the binding runs
  and then reads consistent. Codex's `[hooks]` table in config.toml is
  graded, cleared by that command and removed by uninstall like
  hooks.json; a copy in both places reads inconsistent because it would
  fire twice. Only commands in treecontext's own hooks directory (or an
  earlier build's spellings) count as ours, so a `tc-*` hook of the user's
  elsewhere is never graded or touched. `uninstall --agent claude` keeps
  the hook scripts while a copy still runs them, exits non-zero and names
  `treecontext uninstall --agent codex|gemini` to run first; a copy whose
  scripts are gone reads inconsistent, and a row's single fix line carries
  the flag whenever the copy is what needs fixing. On these clients the
  row's server mode reads "server mode: capture (this client: tools
  only)", and OpenCode's install output no longer advertises the
  unverified plugin. The matrix's Mode cells and doctor's mode text are
  now the same words. VS Code and Cursor read the Claude settings file
  themselves, so `--experimental-capture` now writes nothing for them and
  prints one line saying so; a Copilot or Cursor hook file an earlier
  build wrote is a second route beside the Claude one, and doctor's row
  warns with `treecontext uninstall --agent vscode|cursor --hooks-only`,
  which removes it and keeps the tools. The install charter's opt-in
  scenario is now bound on Codex CLI, whose flagged install writes a real
  copy. Nothing is written without the flag, and no row calls capture
  verified.
  Charter: journal-clients, the doctor-per-client outline and the four
  copied-configuration scenarios; journal-install's opt-in scenarios, now
  bound on Codex CLI (D29, D153, D154, D161, D208, D225, D226).
- **A teammate's handoff lands once, marked as imported by you, and never
  crashes on a duplicate.** Importing a file whose entries the store
  already held used to crash when they lived in another lane: the
  duplicate check looked only in the importing lane, so an id held by a
  subagent's namespace of the same store hit the primary key (the
  same-store import crash of 2026-10-05). The check is now store-wide and
  by identity first: an entry is already present when its id is a row in
  any lane or the `_merged_from_node_id` back-pointer of one, and only an
  entry the file carries no id for is matched by content. Everything new
  lands, nothing present is touched, an id the store holds with different
  content is left alone and counted apart, an entry that is not an
  object at all is counted rather than failing the import, and
  `treecontext_import` says what happened: "1 entry landed; 0 were
  already present", with `landed`, `already_present` and, when there are
  any, `id_conflicts` and `skipped_malformed` beside it. Migration 025
  recreates the curated unique index without handoff lanes, so a
  teammate's chapter that reads word for word like one of yours still
  lands: inside a handoff lane, identity alone decides.
  A handoff file crosses the shared repository, which anyone with push
  access can edit, so the tool marks every entry it lands as imported by
  the importer: `_handoff_file` (the label, which now names the file, and
  the handshake says so), `_handoff_importer` (the importing session),
  `_handoff_imported_at`, and `_handoff_sender` (the file's own
  `exported_by` claim). The importer, not the file, sets the row's
  read-only flag, decay exemption, utility and source. The file's claims
  of writer, author, session, namespace, provenance, reliance,
  supersession and pointer state (`next_session`, `status`) leave the
  entry's top level and are kept verbatim under `_handoff_claims`, so a
  teammate's chapters never become your resume pointers; a claimed
  `supersedes` becomes a `refs` reference and never retires your chapter.
  The entry keeps the sender's own `created_at` and a lane of the
  sender's own (`session_id` behind a `handoff:` prefix): it never joins
  your self, and retention never takes a handoff lane for the present
  session, ordering it by when you imported it rather than by the
  sender's clock. Exports now carry `exported_by`, the exporting
  machine's `<user>@<host>`, the first piece of the file's own head. The
  packet after a /clear still opens on your chapter, and its handoff line
  reads "Handoff claimed from <sender>": the count, and the newest
  chapter summary the file claims with its universal time and id, saying
  when that time sits in the future by the sender's clock instead of
  correcting it. Imported entries are read-only by default and so sit
  outside the session cap. The import tool cannot tell an archive from a
  handoff, so an archive pasted through it lands as a handoff (the reply
  says when the file claims sessions this store archived); restoring an
  archive is a later door. The library's `importJson` without the
  `handoff` option stays the faithful round-trip archive restores rely
  on.
  Charter: journal-handoff, the beta.1 set (D151, D164, D165, D184,
  D206, D218-D224); the file-bound export
  and import ship in this release too (D229-D234).
- **A /clear hands the agent its thread, and the stop hook keeps a
  bookmark.** The hackathon team clears instead of compacting, and until
  now a clear re-oriented from three raw user messages and three tool
  previews, with no way to say which plan they belonged to. There are now
  two kinds of checkpoint: the chapter summary the developer asks for
  (today's `next_session` pointer) and the bookmark, the same entry with
  `metadata.kind = "bookmark"`. At every turn end the Stop hook, after it
  captures the response as before, checks the session's newest checkpoint
  of either kind; at 20 rounds or 45 minutes, whichever comes first, it
  blocks once and asks the agent for a one-line bookmark, never twice in a
  row, and a store that cannot take the write is reported once in the
  developer's own pane while the agent stops. `treecontext config
  checkpoint-interval "20 rounds or 45 minutes"` sets it per store (a row
  in `store_config`; "off", "1 round", "1000 rounds and 1 week" are all
  honored and echoed back as they will behave). A new bookmark supersedes
  the session's previous one, status labels every pointer with its kind
  and names what it superseded, and search ranks a chapter above a
  bookmark by the 0.25 weight assistant prose already carries. A /clear
  mints a new session id, so the hooks follow the session's chain: the
  session-start hook reads the id the clear ends from the pid beacon
  before rewriting it, records the link in the store, and every packet,
  bookmark supersession, nudge mark and interval check walks it; with no
  beacon to name the predecessor the packet says so rather than claiming
  no checkpoint exists. An ask restarts the interval, so the hook never
  asks twice in one. On a clear the session-start hook — now wired on
  `clear` and `resume` too; **existing installs must re-run `treecontext
  install`**, and doctor says so — emits one packet under 3000 characters: the chapter and its age, the bookmark
  with its age and the entries between, the developer's newest five turns
  each cut to its first line and length with the omitted count, one line
  per handoff, and the reminder; a session with no chapter gets the nudge
  once per local day. Every start says in the developer's pane which store
  it journals into, or that it is not journaling and why; a store locked
  by another process costs the packet 1.5 s and a line saying what it
  could not read, and doctor names the process holding the write lock and
  the `kill` that clears it, listing a running server that merely has the
  store open as not the cause.
  Charter: journal-reorientation (all but the beta.2 references scenario)
  and journal-capture "a stop that asks for a bookmark still captures the
  response" (D156-D163, D166, D171, D175, D178, D183, D185, D187, D198,
  D207).
- **The handshake teaches the checkpoint protocol, and the README says
  which clients have hooks.** A developer who never reads the README is
  now carried by what the agent already knows: the handshake names the
  two kinds of checkpoint (the bookmark the stop hook asks for, and the
  chapter summary written when the developer says "checkpoint"), says
  that a chapter is a good moment to `/clear`, that the first reply
  after a `/clear` shows the re-orientation packet as is and in order,
  how a handoff travels through a file in the repository, and that
  `treecontext doctor` is the first move when capture or recall looks
  wrong. It does so in 1884 characters, under both the 2500 ruled for
  the card and the reference platform's 2KB cap; the long form lives in
  the treecontext-reference skill, and the `AGENTS.md` block teaches the
  same protocol. The block and the handshake also stopped promising
  capture everywhere: hooks capture on Claude Code, and elsewhere only
  what the agent inserts is kept. The README carries a compatibility
  matrix, one row per client with its hook events, the documentation it
  was checked against and its date, its mode, and one status: Claude
  Code "verified live", the other five "documented only". Every page in
  `docs/hooks/` links to it, and a "Working as a team" section says what
  a junior team needs in six lines. For Codex CLI and Gemini CLI, which
  copy hooks into their own configuration, install still writes the
  tools alone without `--experimental-capture`, and doctor's row for
  them now names that flagged command as the way to copy. Charter:
  journal-agent-surface (D174, D188, D173, D179, D210), journal-clients
  (D153, D208, D152). The handshake no longer fences the bare words
  "checkpoint" and "summary"; it fences the tree era's machinery by name
  and any tool name the server does not register. To make room, the
  handshake no longer mentions `conversation_window` or "write at natural
  breaks"; the treecontext-reference skill still covers conversation
  windows and when to write. Doctor also stopped reading Gemini's MCP
  launcher as a hook: Gemini keeps both in one settings.json, and a
  tools-only install read "hooks present (experimental capture)" when no
  hook existed. Doctor now walks only the hooks.

- **Merging the same lane twice adds nothing.** A beta tester asked
  whether `treecontext_merge_from_agent` could run every few seconds per
  worker. Locks and latency were fine (a lane writer every 5 ms and a
  merger every 50 ms ran ten seconds across two processes with zero
  errors), but the merge was not idempotent: an auto-captured output a
  session legitimately repeats further apart than the dedup window — the
  same file read, the same status check — is two rows in the lane, and
  the merge's content predicate keeps one anchor per session and
  fingerprint, so the pair flipped it on every run and both re-imported
  each time, two frozen copies per merge, without bound. The live
  treecontext store holds 118 such pairs. Every merged copy now carries
  `_merged_from_node_id`, the merge consults those pointers before the
  predicate, and the result discloses the already-carried class as
  `skipped_already_merged`, so a re-run's zero reads as "all present"
  rather than "nothing to merge". Charter: journal-namespaces, "merging
  the same lane twice adds nothing" (D144). Copies made before this
  change carry no pointer, so the first merge after upgrading can repeat
  an affected pair once more; every run after that is exactly zero. The
  cross-store `stores merge` keeps its ids and was already idempotent;
  its path is unchanged.

## 0.1.0-rc.7 — the first hook captures, and doctor says which build is which

- **Doctor says which build is which.** A Windows tester with a
  0.1.0-rc.2 global install cloned the archived tree-era repository,
  built its 2.0.0, ran `node dist/server/cli.js install` from the
  checkout, and reported that 2.0.0 "did not install an executable on
  path". Both doctors were honest about themselves and silent about each
  other. Two rows near the top of every report now answer: `Command on
  PATH` reads the shim the shell would run — npm's symlink, or its
  `.cmd`/sh/`.ps1` bodies — back to the package it belongs to and names
  that build and this one, each by version and root; a shim it cannot
  follow (Volta, asdf, pnpm) it asks, with `--version`; when nothing is
  on PATH it says so and spells the way on (a global install of the
  checkout, which npm links, or the bin directory a global layout is
  missing). `Wired build` reads the MCP launcher's pinned entry point the
  same way — or, when a version-manager upgrade has deleted the pin,
  where the launcher's own fallback search lands — and names the build
  the agent actually talks to, with the fix spelled `treecontext install
  --force` only when typing `treecontext` runs exactly this build, and
  through this build's own entry point otherwise. Neither row ranks two
  versions (across lineages the larger number was the older build), and
  two copies of one version are reported, not warned about. Every warn
  carries the one command measured to clear it. The README's
  clone-and-build section now says a checkout is never on PATH by
  construction.

- **The first hook on a fresh install captures.** Issue #2 (filed
  2026-08-05 against 0.0.14-beta, still live on rc.6 in a mutated
  shape): only the serving process ever gave a store its schema, so a
  hook firing before the server's first boot — the window between
  `install` and the restart, a `SessionStart` racing the server it
  starts beside, a wiped `~/.treecontext` — opened an empty file, died
  on `no such table: staging`, exited 0 by ruling, and lost its event
  with no store to hold a gap marker. rc.6's leftover was a 4KB shell
  that `doctor` graded "v0→v24, 3 destructive" forever. The hook opener
  now applies the one definition of fresh (version 0 AND an empty
  sqlite_master, decided under the write lock) and the full ladder —
  the same open the library and the server perform — so a hook-minted
  store is indistinguishable from a server-minted one, and a server
  booting beside the hook waits for the lock and finishes the same
  ladder (a four-hook race on one fresh store, run while building this,
  showed three writes landing on the half-built base schema through the
  legacy column tier until the gate learned to read "empty journal"
  rather than "version 0"). A store holding journal rows is never
  migrated by a hook; that stays the server's job, behind its backup.
  And "holding" means `staging` too: a store that captured but was never
  drained is the server's, which also keeps the ladder's backup copy
  tiny under a hook's kill budget. The adversarial
  review of the first cut found the schema minted without its directory
  (only the two beacon-writing hooks created it, by accident;
  PostToolUse, Stop and every non-Claude adapter still lost their first
  event), the bootstrap's lock wait stacking a second 8s on the write's,
  a world-readable hook-minted file, and the library's server pragmas
  left on the hook's connection — all fixed: the opener makes the
  directory, the bootstrap takes a 1s share of the hook budget and hands
  the remainder to the write, the file is 0600 on create, and the
  connection leaves the bootstrap exactly as a non-bootstrapping open
  would. Four charter scenarios pin it with real hook subprocesses — a
  prompt first, a tool event first, rc.6's shell, six hooks at once —
  and the staging failure that means capture is losing data now says so
  in the debug log.

## 0.1.0-rc.6 — the install outlives its interpreter, and answers for what it wrote

The candidate the strand demanded: a live nvm upgrade (v24.18 → v24.20)
deleted the node directory every installed hook script was pinned to, and
both development machines' captures died with nothing but "Connection
closed" to show for it. Everything here follows from that incident and
from the adversarial review of the fixes.

- **A pinned path earns a search party, never a silent grave.** The
  generated hook scripts and MCP launcher pinned `$TC_CLI` to one
  absolute module path; when a version manager retires that directory,
  the pin dies with it. The pin now carries the same version-manager
  glob fallback `$TC_NODE` always had, `doctor` grades installed
  wrapper *bodies* (a stranded module path whose fallback search finds
  no copy is named, with the reinstall advice attached), and the
  managed-layout table is one table — the shell globs, the batch
  probe, and doctor's own filesystem scan all render from it.
- **Four agents come in from the cold.** Gemini, VS Code Copilot,
  Codex, and Cursor hooks now dispatch through generated
  `tc-<agent>-<stem>` wrapper scripts — the same shape that saved the
  Claude hooks — instead of baked interpreter+entry pairs that strand
  in pairs on every node upgrade. Wrappers guarantee exit 0, resolve
  through the managed globs, and are graded by `doctor`.
- **The installer takes only what is its.** Found by this candidate's
  review pass, fixed and regression-pinned: `install` no longer
  deletes a foreign gemini matcher whose hooks array is empty;
  `uninstall cursor` filters treecontext's entries out of
  `hooks.json` instead of unlinking the user's file; a full
  `uninstall` sweeps agent wrappers even after the agent's own config
  directory is gone (they could previously be orphaned forever); the
  hook script's exit-0 ruling now holds even when the module itself
  cannot load.
- **`doctor` stops lying about vscode.** It graded PascalCase event
  keys against a config the builder writes camelCase — every healthy
  Copilot install read "hooks incomplete" forever. Builder and doctor
  now read one event table; a wrapper the config references but which
  is missing from disk is reported instead of invisible behind
  Copilot's `bash`/`powershell` command spellings.
- **A dead peer earns a shutdown, never a storm.** An
  Electron-family client that abandons the server's stderr no longer
  primes an unkillable 100%-CPU exception storm: the serve and hook
  paths swallow dead-stream errors, the server notices a closed stdin
  even when the client dies *during* startup (previously an immortal
  orphan holding the store open), and shutdown runs under a per-step
  watchdog — a wedged close still dies, a slow clean close is never
  killed mid-flush.
- **One-shot commands stop faking success.** The storm-proofing above
  is scoped to serve and hooks only; every other subcommand now fails
  visibly when its output cannot land — `treecontext export | head`
  exits 141 instead of handing a truncated record to the caller as
  exit 0, and a full filesystem gets one diagnostic line and exit 1.

Suite 1,408 passing (2 registered todo), lint zero warnings, tsc-full
zero errors, three-OS matrix green on the tag.

**Upgrading:** no schema change — journals carry forward. Re-running
`treecontext install` after upgrading is REQUIRED to get the fixes:
every one of the wrapper and hook-script changes lands only when the
installer regenerates the scripts in `~/.claude/hooks/`.

## 0.1.0-rc.5 — the evidence converts, the product stands still

Zero product-behavior change: every `src/` diff since rc.4 is a comment
whose file citation moved in the corpus reorg. This candidate is about
the evidence for the product — the test corpus finished its conversion,
found real holes on the way, and closed them.

- **The corpus executes once, under one runner.** gherkin-node-test is
  now the sole executor corpus-wide: the mega-runner split into
  per-wave step modules, the shared World split into per-wave
  interfaces (a step body reading outside its wave is now a type
  error), and vitest-cucumber retired. The suite count moved from
  1,994 to 1,335 for the honest reason — duplicated executor runs and
  copied fixtures are gone, not coverage. Assertions were preserved
  verbatim and the migration was reviewed adversarially, twice.
- **The Windows install walk stopped being blind.** The harness that
  reads installed hook scripts graded only the POSIX dialect — on
  win32 it reached zero hook scripts and passed on the MCP entry
  alone, the same silent shape twice over. The walk now reads both
  dialects from the body (never the platform), every batch pattern is
  pinned to the installer literal it mirrors (CRLF included), and a
  fixture lane grades the foreign dialect from any platform. Proven on
  windows-latest.
- **Full-project typecheck is now a wired, zero-error gate.** The docs
  named `tsc -p tsconfig.json` as the enforcement for the world
  partition; nothing ran it, and it carried 84 errors. It runs on
  every `npm run typecheck` now, against a committed baseline ratchet
  that fails on new errors AND on stale entries — and the baseline is
  `{}`: all 84 were burned down with no assertion weakened, most made
  stronger. The release scripts themselves joined the gate.
- **The needs ledger closed its readback.** N15–N17 (policy tiers, the
  sidecar pane, echo attribution) ratified; the sidecar feature's
  charter citation corrected to what the coverage table always said.

Suite 1,335 (1,333 passing, 2 registered todo), lint zero warnings,
tsc-full zero errors, three-OS matrix green on the tag.

No new features to learn. This candidate closes every issue we were
tracking, hardens what an audit of our own test corpus found soft, and
moves the foundations to current major versions — with the full test
suite (1,994 tests) and the three-OS matrix green at every step.

Every known issue, fixed:

- **Concurrent sessions can no longer lose a project's first binding.**
  `bindings.json` is machine-wide state written by whichever hook fires
  next, and two hooks firing at the same instant could silently drop
  one project's entry. Writers now hold a bounded lock and merge only
  their own delta over what is on disk — proven with six real processes
  racing one file. A stuck lock never blocks you: waiters give up and
  retry on the next resolution, and a dead writer's lock is broken as
  stale.
- **A non-git project reached under two path spellings keeps one
  journal.** Identity canonicalization is a fallback ladder, and a
  binding minted while the ladder was degraded (an 8.3 short-form
  directory on Windows, a network share where realpath fails) could
  strand the journal under a spelling the healthy ladder never
  reproduces. The succession probe now walks the other rungs — each
  names the same directory, so the journal is carried forward, and the
  adoption is announced like every other.
- **`treecontext stores sweep --store X`** scopes the backup sweep to
  one store — verification, deletion, and sidecar tidy alike — so
  "delete everything verified" and "keep the rollback I just took"
  stop conflicting. A scope naming no store refuses by name.
- **Doctor stops advising a command that cannot run.** A split
  candidate whose store never landed on disk is now reported as what
  it is — a dangling binding, not two journals — instead of a
  `stores merge` line that merge itself would refuse.
- **Everything treecontext writes under `~/.treecontext` is private on
  create** — debug logs, telemetry lines, backup verdicts, retention
  archives, migration backups, `config.toml`, and the new bindings
  lock all land `0600` (directories `0700`), not umask-default.

Under the hood, two foundation moves:

- **MCP SDK v2** (`@modelcontextprotocol/server` 2.0.0, the package
  split released with the 2026-07-28 spec). The tool surface, wire
  behavior, and store schema are unchanged — journals carry forward,
  upgrading is install-over-install. One honest side effect: calling
  the long-retired `treecontext_feedback` tool now returns a proper
  protocol error instead of a silent error result.
- **TypeScript 7** (the native compiler) and every dependency at its
  latest — zod 4, better-sqlite3 13.0.3, vitest 4.1.11 — with zero
  source changes required.

Also in this candidate: the first field run of an external corpus
audit over our own test suite, and what it found, fixed — design docs
reconciled to the build, a dozen test bindings that could not fail
rewritten so they can, and the shutdown sweep bound end-to-end through
a real stdio subprocess.

No schema change since rc.2: upgrading from rc.2 or rc.3 is
install-over-install and your journals carry forward.

## 0.1.0-rc.3 — the wiring stops being homework

Not one macOS or Windows beta tester got a treecontext pane onto their
screen. The bytes were never the problem: the blob conforms, and the
documented config was verified to load through ccr's own reader. The
procedure was the defect — five hand-steps, four of which fail
silently, because a renderer that survives a typo by drawing nothing
makes every wiring mistake invisible.

So treecontext now writes the entry itself:

```
treecontext ccr wire
```

It finds the config file ccr will actually read on this platform
(`~/.config/ccr/config.json` everywhere — `%USERPROFILE%\.config` on
Windows, never `%APPDATA%`), merges this project's pane into whatever
is already there, and writes BOM-free UTF-8 with forward slashes. It
never removes another tool's pane or drops a setting it does not
understand. Two things it repairs in place, because ccr renders both
as silence: a byte-order mark or UTF-16 encoding — what PowerShell's
`Set-Content -Encoding utf8` and `>` produce — and bare-string pane
entries, which ccr skips without a word. A config that is not JSON at
all is refused rather than discarded, until `--force` moves it aside.
`--pane all` wires all three panes, `--dry-run` prints what it would
write.

Because that command edits a file treecontext does not own, it was
reviewed the way the phase gates review a builder, and six defects
were reproduced on disk before release. Three were data loss in
someone else's file: an entry we could not interpret was dropped
rather than preserved; `--force` overwrote an earlier `.bak` on POSIX
and failed outright on Windows, leaving the bad file to be
overwritten; and the write unlinked before renaming, so a failed
rename left neither file. One was a dotfiles hazard — a symlinked
config was replaced by a regular file, breaking the link and wiring a
pane the operator's real config never sees. Two were verdicts the
command had no business reaching: a directory at the config path read
as "does not exist" and then threw, and a config past the 64KB window
ccr itself reads was truncated, parsed, and pronounced invalid JSON —
a verdict `--force` would have acted on. All fixed, each with a test
that fails without the fix.

`treecontext doctor` now walks the whole join instead of only our half
of it: whether ccr is installed and new enough for panes (0.3.0),
which config file it will read, whether that file parses, whether this
project's pane is listed in a shape ccr accepts, when the pane file
was last written, and — the step no config can substitute for — how to
cycle to it on the terminal you are using. Windows Terminal binds no
cycle key at all, so that row names `ccr cycle-view` there instead of
a keystroke nobody has.

## 0.1.0-rc.2 — the short path git never speaks

rc.1's tag push put the identity program on a Windows runner for the
first time, and the full-matrix release gate did its job: five test
failures, one cause. Windows paths have two spellings — `%TEMP%` is an
8.3 short form (`RUNNER~1`) on every GitHub runner — and git
canonicalizes to the long form while Node's JS `realpathSync`
preserves the short one. Every identity comparison that mixed the two
missed: the containment guard failed closed, legacy stickies went
unread, a linked worktree minted its own store instead of resolving
the project it was cut from, and a symlinked view split from its
target. Identity canonicalization now goes through
`realpathSync.native`, which expands short names the way git does.
POSIX output is byte-identical between the two implementations, so no
existing binding re-keys; there is no schema change, and stores from
rc.1 open unchanged. Install rc.2 over rc.1 — on Windows, rc.1's
resolution should not be trusted to bind projects.

## 0.1.0-rc.1 — the store becomes the arbiter

The headline is database-enforced multi-user. Correctness no longer
depends on lockfiles or on every writer being polite: the invariants
moved into the store itself, where every consumer inherits them.
Sessions and sub-agents write concurrently; each capture lands in its
own session's namespace; dedup is a unique constraint; the capture
drain claims its batches atomically, so a double drain is impossible at
the SQL layer; and role holding — one primary claim per namespace, one
drain per store — is a `leases` table with heartbeat TTLs, not a
lockfile (a crashed holder frees its roles within 90 seconds, and the
live holder is what doctor names and what a later server takes
over). Migration 021
rewrites existing stores to the final shape losslessly, with the same
backup-and-verdict protection 0.0.16 introduced.

Around that core, three hardening programs ran, each with its own
adversarial review (the arc carried ~100 confirmed findings, all fixed
or explicitly ruled, plus mutation protocols on every touched seam):

### Added

- **A project keeps its journal across a change in its own identity.**
  Store selection was keyed on the git remote URL, or the project path
  when there was no remote — both of which change during a project's
  normal life. Adding a remote (`git remote add`, `gh repo create`,
  `push -u`), running `git init` above a directory that was already
  bound, or the remote URL changing form (https↔ssh, a `.git` suffix)
  all minted a **new empty store** and orphaned the old journal,
  silently. Now, on a first miss, resolution probes the predecessor
  identities of the same project — the path of the repository root and
  every raw spelling of the remote URL — and when they agree on one
  store it **carries the journal forward**: the new identity is bound
  to the existing store (`source: carried-forward`), the old binding
  still resolves to it, and the adoption is announced, never silent.
  Ambiguity fails closed: a predecessor in a subdirectory (the
  monorepo case, where two siblings could each claim the other's
  journal) is **disclosed, never adopted**, and two predecessors
  naming different stores derive a fresh store and say so.

- **A linked git worktree resolves to the project it was cut from.**
  A path-bound project checked out as a worktree used to mint one
  store per worktree; now every worktree of a project shares its
  journal — the shape agent orchestration needs, since subagents are
  commonly spawned in worktrees.

- **`treecontext doctor` audits for silently-misplaced work.** New
  read-only checks name what has no error to report: split journals
  (a path-bound store beside a git-bound one of the same project),
  fingerprint-collision groups (dedup keys covering more than one
  content — see the digest change below), stores bound but never
  written, and capture debt (dead-lettered events and an undrained
  backlog). Each check discloses its own blind spots rather than
  implying its list is exhaustive; none of them writes.

- **`treecontext stores merge <src> <dst>` — one project's two journals
  become one.** A directory bound by path before it had a git remote,
  and bound again by git after, wrote two journals that could not see
  each other; `doctor` names the pair and this command repairs it.
  It copies **every** namespace of the source (a predecessor's agent
  lanes come across too, not just `project`), **preserves the source
  entry ids** — so resume pointers and supersession chains still
  resolve, and a second run imports exactly zero — and reports what it
  did per namespace: imported, skipped as duplicate, skipped as already
  present, source total. The source store is **never deleted**;
  `stores rm` stays your own explicit act, and `--repoint` moves the
  bindings that still name it.

  Every precondition fails closed with its own message: both stores at
  this build's schema version (it refuses rather than migrating a store
  you did not name), a flat source, an undrained source backlog (it
  waits for the source's own drain), a **verified** backup of both from
  today (`--backup` takes them and confirms each opens and passes an
  integrity check), the destination inside the stores root, and `--yes`
  to confirm. It **takes** the destination's drain lease for the
  duration rather than checking that nobody holds it, and the source is
  read inside one transaction — so consistency is guaranteed and
  completeness assumes a quiet source, which the output says out loud.
  Merged entries are stamped `_merge_source_store` and `_merge_label`
  for provenance, and carry the merge time as their `updated_at` (their
  original `created_at` is preserved) — so a merged predecessor journal
  re-ages for retention and decay from the merge, not from its original
  capture.

- **`treecontext_merge_from_agent` now reports skipped duplicates.** Its
  response gains `skipped_duplicate` beside `imported_count`. Additive,
  but a user-visible contract change: until now a merge that dropped
  half its input to the dedup predicate read exactly like a clean one.

- **The dedup key became a real digest (schema v24)** — until now the
  fingerprint that decides "is this a duplicate" was a *structural* key
  for content over 128 characters: first 64 characters, last 64, and the
  whitespace-normalized length. Measured against this project's own
  journal (10,001 entries), 97 keys covered entries with **different**
  content — 219 rows, 2.2% — because captured tool calls share a
  command prefix and a result suffix and differ in a middle identifier
  of fixed width. Nothing was lost in place (in-store dedup is window-
  and session-scoped), but on the import and merge paths a colliding
  entry is skipped as a duplicate and disappears silently. The key is
  now `sha256` of the normalized content, truncated to 128 bits, for
  every length; whitespace normalization is unchanged, so entries that
  differ only in spacing still dedup as before.

  **Migration 024** rewrites the key of every entry whose content it can
  read, restores curated slots to entries that were demoted as false
  duplicates, re-resolves genuine duplicates over the new keys
  (earliest entry keeps the slot, nothing merged, nothing deleted), and
  re-keys the auto-capture dedup anchors so in-window duplicates keep
  collapsing. An entry whose content cannot be decoded on this runtime
  keeps the key it has; `treecontext doctor` counts those separately as
  "unmigrated keys" rather than folding them into its collision count.
  The migration verifies its own work inside the transaction and rolls
  the whole upgrade back rather than committing a store it cannot
  vouch for.

  **It is classified destructive**, so your store is copied to
  `treecontext.db.pre-migration-v<version>.bak` before it runs.
  Note that the completion verdict compares entry COUNTS, which this
  migration never changes — so it will read `success` and the backup
  becomes eligible for the routine sweep. **If you want a durable
  rollback, copy that `.bak` somewhere else before the sweep reclaims
  it.**

  **One-time capture gap.** The upgrade holds an exclusive lock for the
  whole batch — backup, rewrite, VACUUM and checkpoint — and hook
  captures that arrive during it wait on their 8-second budget and are
  dropped beyond it. Measured on a synthetic 10,000-entry, 43 MB store
  (rows sized to this project's own journal): **0.40 s** from v23, and
  **0.66 s** from v20 or below, which pays for the previous release's
  backfill pass as well. Larger journals scale with file size.

  **Older binaries refuse a v24 store** (the ladder is forward-only), so
  upgrade every treecontext install that opens the same store. Exports
  are unaffected — import and merge recompute keys from content, so
  archives written before this release import correctly.
- **Reliance-aware retention** — the eviction valve now measures which
  entries recall actually returns and evicts relied-on history last;
  the meter's refusals and edge cases are bound scenarios.
- **Output shielding under lockdown** — shield files hold verbatim
  journal content, so they now live in `~/.treecontext/shield`
  (0700 dir, 0600 files), never the shared tmpdir; the shutdown sweep
  deletes only names the module mints and pre-lockdown tmpdir leftovers
  are swept until gone; a shield write failure returns the response
  inline instead of destroying it.
- **Shareable diagnostics** — `doctor --dump-logs` and doctor's crash
  excerpt redact your home directory to `~` as they print (the on-disk
  logs keep full fidelity); the logs carry names, paths, and byte
  counts, never message bodies — now a pinned invariant.
- **`stores list` graduated** — backup bytes in their own column,
  shells and strays labeled as what they are, broken stores degrade to
  dashes without taking the listing down.
- **Echo-correlated session identity (v2)** — the store's own capture
  now attributes its curated writes: every `treecontext_insert` echo
  names the row its call touched, and the drain upgrades that row's
  attribution to exact causal identity (source `echo`), displacing
  beacon guesses with the displaced value kept countable, never
  touching an explicit or pid attribution, and disclosing genuine
  ambiguity when identical concurrent inserts collapse. A missing echo
  degrades to the insert-time ladder; an id is never invented. The
  18%-class attrition (long quiet autonomous stretches resolving to
  nothing) closes: the echo arrives however long the user has been
  quiet.
- **Session-keyed namespace attribution** — the drain publishes
  (session → serving namespace) from exact echo evidence (a status
  echo's own output names the namespace, and orientation fires one at
  session start; a correlated insert names the healed row's tree), and
  hooks resolve by the session id their payload already carries — the
  causal channel, and the one that works where exec chains break. The
  ppid bridge remains as the rung below, honored only while its server
  is corroborated as the live heartbeating holder of its namespace
  lease — pid existence alone no longer counts, so a SIGKILLed
  server's recycled pid cannot revive its stale claim.
- Rung 3 of the identity ladder now ignores live beacons recorded
  under a different working directory — a cross-project session cannot
  be this one; same-project ambiguity stays disclosed.
- **Two servers may share one namespace** — a second `treecontext
  serve` over a namespace another server already holds now serves
  normally instead of failing every tool call with a locked-store
  error. The refusal protected the pre-arbiter world of in-process
  dedup maps; store constraints have kept concurrent writers safe since
  the arbiter program, and per-row session identity keeps the two
  conversations reconstructable apart. The namespace lease stays as the
  primary claim: one holder, named by doctor, corroborating hook
  attribution, taken over when its heartbeats stop.

### Fixed

- **`~/.treecontext/bindings.json` is preserved, never clobbered** — a
  corrupt or unknown-version file is side-filed to
  `bindings.json.corrupt` before any rewrite (one bad byte used to cost
  every project its binding on the next hook fire); a symlinked path is
  refused for reading and writing; stored values are re-validated on
  load with neighbors surviving; a read error is not corruption and
  triggers no rewrite at all.
- **Hook exits are never non-zero** — the hook command dispatches
  before any config load, so a TOML typo in `config.toml` can no longer
  fail every hook on the machine into the agent's face; unknown events
  log their name instead of vanishing.
- **Your config file is yours** — install never flips an explicit
  `capture = false`, preserves a skipped file byte-for-byte (comments
  included), and side-files a corrupt config before replacing it;
  doctor and install both survive the corrupt config they exist to
  diagnose and repair; a trailing `--config` with no path is an error
  instead of silently loading a different file.
- **`uninstall --hooks-only` no longer deletes the MCP launcher** its
  surviving registration points at.
- **`backup` resolves read-only** — no more minted binding for every
  directory it ran from; a legacy sticky-file project is recognized
  instead of being told it never used treecontext.
- **`--secure-delete` flows through the audited option seam** and
  finally appears in `--help`; the tombstoned `verbose` instructions
  variant no longer advertises itself there.
- Doctor grades hook wrappers in both shell dialects; the five
  archived-build agent configs left the registry; a negative
  `shield_threshold` is rejected like the CLI flag always did.
- **The release-diff review's own catches** (ten findings, all fixed
  pre-tag): a store holding one undecodable auto-capture row survived
  migration instead of becoming permanently unopenable; a brand-new
  store created via `serve` gets the base schema before the ladder (no
  more junk verdict-less backup that doctor warned about forever); a
  `--capture --read-only` server no longer squats the drain lease it
  will never use; two servers starting together cannot silently replay
  the whole backfill; a sweeper that loses its lease mid-sweep aborts
  instead of interleaving with its successor; reliance counts are
  monotonic and survive demotion/restore; and the Stop hook reads
  through the shared 8-second opener like every other hook.

### Security

- **Repo contents can no longer redirect store selection** (finding S3,
  reopened and re-closed during this program's review). Store selection
  derives from the project's git identity, and three ways a checkout
  could forge that identity are now closed: a hand-written `.git` file
  pointing at another project (rejected unless it carries git's own
  worktree back-pointer to itself), a repo-local `core.worktree`
  claiming another project's directory as its tree (a git toplevel that
  does not contain the working directory is distrusted), and git
  configuration injected through the environment
  (`GIT_CONFIG_COUNT`/`KEY`/`VALUE` and the rest of `GIT_*` are scrubbed
  from every identity read). Identity derives from the repository
  alone, never from repo-controlled files or the ambient environment.

### Known limitations

- **Some split journals are invisible to the detector.** `doctor`'s
  split check pairs a path-bound store with a git-bound one of the same
  derived name; a split whose two stores do not share that shape — an
  explicitly-named store, a repository rename or org move, a directory
  renamed before it had a remote, or a worktree that was path-bound
  before this release — is not listed, and the check says so in its own
  output. Succession prevents new splits of every kind; only the
  detection of pre-existing ones is heuristic.

### Known limitations

- **A session's first capture rows may precede its first echo** — the
  session-keyed namespace channel primes on the session's first
  treecontext echo (normally the orientation status call, seconds in).
  On a multi-lane Windows setup, hook events staged before that echo
  drains still route into the serving namespace, exactly as every
  unresolved row always has. Single-lane installs are unaffected. This
  replaces the previous release-wide "Windows namespace attribution is
  a no-op" limitation, which session-identity v2 closed
  (`docs/session-identity.md` §7.8).

### Removed

- **The HTTP transport** — its consumers left with the tree era and the
  audit proved the surface unused; `serve` is stdio-only. The flag
  exits with a removal message; reinstatement would be a new feature.
- The pre-0.1 `.treecontext*.lock` files carry no meaning and are
  cleaned at server start.

## 0.0.16-beta — your store is copied aside before anything destructive touches it

The headline is migration safety. A schema migration that rebuilds tables
now **copies your store aside first** (`treecontext.db.pre-migration-v<N>.bak`,
inside the store's directory), runs the full ladder, reclaims the freed
space, and — while the backup and the migrated store are still twins —
records a **verdict** comparing the two. `doctor` lists every backup with
its verdict and size; a new opt-in `treecontext stores sweep` reclaims the
disk of verified ones and refuses, with a stated reason, anything it cannot
fully verify. `stores rm` and `stores prune` take verified backups with
their store and spare failed/missing-verdict ones as live rollbacks.
Upgrading to this release is what puts the protection in place: your
existing stores migrate *with* a backup and a verdict.

The whole surface then went through three adversarial review passes
(33 findings, all fixed or explicitly ruled). The ones worth knowing
about: a retried migration could record a **false failed verdict against a
stale backup and advise restoring it** — following that advice would have
been data loss; the sweep trusted a corruption check whose result it never
read; a locked store was mislabeled as corrupt; and several commands could
lose their whole report to one unremovable file. All of that is gone, and
every deletion surface now reports failures precisely and exits 2 on
partial completion.

### Added

- **Pre-migration backups with completion verdicts** — recorded before the
  post-migration VACUUM, and only when the copy was taken in the same run;
  a kept backup from an earlier attempt honestly carries "no migration
  verdict".
- **`treecontext stores sweep`** — dry-run by default, `--yes` to delete;
  only a backup whose live store opens, passes its integrity check, sits
  at the current schema, and carries a success verdict is eligible. It
  also tidies orphaned verdict sidecars whose backup is gone.
- **Doctor visibility** — every backup, its verdict, the exact reclaim
  command; orphaned verified backups (live store deleted) are named with
  their explicit `stores rm` path, or by-hand advice when the CLI cannot
  address the store's name.
- **Store names are validated at creation** — a bare `--store` name that
  would create a new store must be one the CLI can address later; existing
  stores are unaffected and always open.

### Fixed

- Ingestion can no longer be wedged by a poison event, and a schema change
  can never eat a store (both now bound scenarios).
- `stores rm`/`prune`/`sweep` isolate per-item filesystem failures, never
  claim "Removed" for a directory still on disk, and preview exactly what
  `--yes` will do — including the spare rule's outcome.
- `stores rm` validates its target before touching the filesystem, and the
  parser refuses stray positionals instead of silently re-aiming a command
  at a different store.
- Doctor no longer reports a healthy empty state for a stores directory it
  cannot read, and its advice lines are parse-through-tested so they can
  never name a command that does not parse.

## 0.0.15-beta — the node Windows checked and then did not use

**Supersedes 0.0.14-beta on Windows; upgrade and re-run `treecontext install`.**
If you are on Windows and capture has been storing nothing while `doctor`
reported a healthy install, this is why.

`install` has always probed your machine for a `node` that can actually load
the native database binding — "the first node on PATH" and "a node this
package works under" are different questions, and the wrong answer makes
every capture hook die on `require`. Windows ran that probe, printed its
result, and then wrote scripts that ignored it.

The MCP launcher asked `PATH` first and kept the verified interpreter only as
a fallback, so a `node` that could not load the binding won. The hook scripts
were worse: they pinned the interpreter that happened to run `install`, with
no fallback at all, so a routine node upgrade that moved it stranded every
hook. Both failures were suppressed (`2>nul`), which is what made this look
like a healthy install with an empty journal rather than an error.

The Windows test lane could not have caught any of it. It had been dying in
`npm ci` since it was added and had never executed a single test — through
five releases, including both of the ones that were *about* Windows. It runs
now, and everything below is verified on it.

### Fixed

- **Windows resolves the interpreter the same way macOS and Linux do**:
  the verified interpreter first, whatever `node` is on `PATH` behind it.
  When nothing verifies, no interpreter is pinned at all rather than
  pinning the one already probed and rejected.
- **Windows hook scripts have a fallback.** A node upgrade no longer
  strands them.
- **`doctor` sees the hooks `install` just wrote.** It was looking for
  them under names `install` does not use on Windows, so a correct install
  reported "hooks missing" — and the fix it offered did not change that.
- **`doctor`'s interpreter check runs on Windows.** It was skipped there,
  which is precisely where an unverified interpreter could hide: hooks
  running, storing nothing, errors swallowed, install reported healthy.
- **`doctor` no longer prints a shell fragment as your interpreter.** On a
  machine where *no* interpreter verified, it reported
  `[err] $(command -v node || true) cannot load better-sqlite3` instead of
  saying plainly that nothing was pinned and offering `--force`. This one
  affected macOS and Linux, not Windows.

## 0.0.14-beta — the other Windows shell

**Supersedes 0.0.13-beta on Windows; upgrade if you installed it.**
0.0.13-beta fixed hooks for Windows machines with Git Bash and broke them
for machines without it. If you are on Windows, install this and re-run
`treecontext install`.

Claude Code hands a hook command to a shell, and on Windows that shell is
**Git Bash if it is installed and PowerShell if it is not**. Those two
disagree about what a runnable command even looks like, so there is no
single string that satisfies both:

- Bash needs forward slashes and quotes. A backslash path is eaten as
  escapes; quoted, it survives but contains no `/`, so bash resolves it as
  a command *name* against `PATH` instead of opening a file.
- PowerShell needs the call operator. A quoted path on its own is an
  *expression* — PowerShell evaluates it, prints it, and runs nothing.
  Backslashes are safe there, because PowerShell escapes with a backtick.

0.0.13-beta wrote the bash form unconditionally. On a Windows machine
without Git Bash, that meant every hook printed its own path and exited,
which is the same silent nothing as before, arrived at a different way.

### Fixed

- **Hook commands are now written in the form the shell that will run
  them understands**, chosen by detecting Git Bash at install time, and
  the `shell` field is written alongside so the command and its
  interpreter stay pinned together rather than depending on two separate
  detections agreeing forever. Verified against real bash and real
  PowerShell, including paths containing spaces.
- **`doctor` grades each command against its own shell.** "No
  backslashes" was bash's rule, not a universal one — applied to a
  PowerShell command it would have condemned the only form that works
  there. It also now reports hooks pinned to Git Bash on a machine where
  Git Bash has since been removed.

## 0.0.13-beta — hooks that never ran, and a panel that would have said so

**Upgrade if you are on Windows.** Every capture hook failed there, in
every session, and nothing said so — `install` reported success and
`doctor` reported "hooks installed" while the journal stayed empty. If
you have been running treecontext on Windows, it has not been recording
anything, and re-running `treecontext install` after upgrading is what
repairs it.

The other half of the release is the reason that failure was invisible
for as long as it was, and is meant to be the last time it can be.

### Fixed

- **Windows: no hook ever ran.** Claude Code runs a hook command through
  a shell, and on Windows that shell is bash. `install` wrote a bare
  Windows path, so bash consumed every backslash as an escape and
  `C:\Users\user\.claude\hooks\tc-stop.cmd` arrived as
  `C:Usersuser.claudehookstc-stop.cmd` — command not found, six times a
  session, silently. Paths are now written in a form a shell hands back
  unchanged. Quoting alone would not have done it: quoted, the
  backslashes survive but leave a string containing no `/`, which a shell
  resolves as a command *name* against `PATH` rather than opening as a
  file.
- **`doctor` graded hooks by the wrong question.** It checked whether the
  hook *scripts* existed, which is not whether the *commands* run — on
  Windows every script was present and every command was dead. It now
  reports a command that cannot run and says what capture is losing. Note
  that checking whether the command's path exists would *not* have caught
  this: the broken path is a perfectly good Windows path, and only breaks
  once a shell reads it.
- **`doctor --dump-logs` printed the logs instead of the diagnosis.**
  Doctor's own closing text asks you to send that output to the
  developer, so the flag meant for reporting a problem removed the only
  part that diagnoses one. It now prints both.

### Added

- **Sidecar panes — a live view of whether memory is working.**
  treecontext writes small JSON files beside its own store that a
  terminal panel can render without knowing anything about treecontext
  (ccr's pane contract v1). Three views: `journal` (is capture running,
  is the drain clear, are there gaps, how long since a curated note),
  `threads` (what this session is in the middle of, from your resume
  pointers), and `trail` (what the journal is made of). The path is
  printed by `treecontext doctor`; turn them off with `--no-sidecar` or
  `sidecar = false` in config.

  The panes are deliberately conservative about what they claim. Every
  number is fixed at the drain it was taken from, so a stale panel reads
  as old rather than drifting. A drain that fails says so; a server that
  does not own the drain writes nothing at all rather than overwriting a
  live panel with numbers it never computed. And the `trail` view reports
  its composition without grading it — the exit types it counts come from
  matching words in tool output, so a search whose results mention an
  error is counted as one, and presenting that as a failure rate would be
  a word search dressed as a measurement.

## 0.0.12-beta — the diagnostic that edited what it was diagnosing

A one-defect release, found while acceptance-testing 0.0.11-beta against
its own published artifact. Nothing else changed; if 0.0.11-beta is working
for you, this only removes a side effect you would not have noticed.

### Fixed

- **`doctor` wrote a store binding for whatever directory it was run
  from.** Naming the store bound to the current directory — added in
  0.0.11-beta — used the resolver that *persists* a binding when it does
  not find one, rather than the one that only reads. Running `doctor`
  anywhere therefore registered that directory in `bindings.json`. Nothing
  was lost or misrouted, because the name it recorded is the same one that
  directory would have derived later anyway; the entries were inert. But a
  diagnostic that edits the configuration it reports on is no longer
  describing the system you have, which is the whole job.
- **`doctor` could name a store that does not exist.** The bound name was
  printed whether or not any such store was on disk, so `1 store at v19
  (this directory: tmp-463306)` read as though `tmp-463306` were the store
  just counted. It is now shown only when it is one of the stores listed.

## 0.0.11-beta — the server that would not start, and the doctor that said it was fine

Third private beta. **Upgrade if you ran any earlier build.** 0.0.10-beta
could not open a journal that an earlier version had created: the MCP
server died during startup, every session, and the only thing the host
could show for it was `-32000: Connection closed`. Nothing in `doctor` or
the debug log said why. Both of those are fixed here too — the defect and
the blindness to it were separate bugs, and the second one is the reason
the first took a round trip to find.

### Fixed — reported from the field

- **The MCP server refused to start against any store an earlier build had
  created.** Schema migrations that drop data require an explicit opt-in.
  `serve` passes it and the store layer honours it, but the factory sitting
  between them declared the option and never forwarded it — so the opt-in
  never arrived, the gate refused, and the process exited before its
  transport came up. Because the store was never migrated, the next start
  failed identically: self-perpetuating, and invisible to the host, which
  reports only a closed connection. Stores created fresh by 0.0.10-beta
  were unaffected, which is why this reads as "works in my project, broken
  everywhere else" — a directory outside a git repository binds to a
  long-lived home store, and that is the one most likely to predate the
  build you are running. **No data was at risk**: the store was never
  opened, let alone written.

### Added

- `doctor` checks **store schema**. Every check it ran before validated an
  installation artifact — config files, registrations, hook scripts,
  interpreters — and not one of them opened a journal. It therefore
  reported a clean bill of health on a machine whose server was failing on
  every launch. It now opens each store read-only and reports one below the
  current schema, one written by a *newer* build than you have installed,
  and one it cannot read at all. It also names which store the current
  directory binds to, so the global-versus-project split is visible instead
  of inferred. `doctor` diagnoses only: it never migrates, and read-only
  means it cannot disturb a running server.
- `doctor` reports **recent crashes**. Fatal errors are now recorded to the
  debug log and surfaced as a check, so a crash that the host swallowed is
  one `doctor` away instead of one log-archaeology session away.

### Changed

- **Fatal errors are always written to the debug log**, whether or not
  `--debug` is on. Debug output is the right default for progress chatter
  and the wrong one for a crash: the run worth asking about later is the
  run that died, and a server that dies before its transport comes up has
  no other channel. The log file is created when something goes wrong
  rather than at startup, and `install --dry-run` still writes nothing.
- **Migrations record how they ended, not just that they began.** Every
  run now closes with a completion, failure, or refusal line, so a log that
  stops mid-migration is unambiguous evidence rather than a guess. The
  refusal names what blocked it.

### Internal

- `gherkin-node-test` 0.9.0. Manifest rows now record feature paths
  relative to the manifest, so the charter's run manifest is portable
  across machines and checkouts and is committed as an artifact for the
  first time (117 rows: 103 bound and passing, 14 still unbound).

## 0.0.10-beta — the installer meets the machines it installs onto

Second private beta. Everything here is setup and diagnosis: the journal
itself is unchanged from 0.0.9-beta except for the fixes carried over
below. **Upgrading is worth it even if 0.0.9-beta appeared to work** —
on Claude Code it very likely did not, and said otherwise.

### Fixed — reported from the field

- **`treecontext <anything>` printed nothing and exited 0** after a global
  npm install. npm puts a *symlink* on PATH, so the process entry point and
  the module's own path differ; the guard that decides "am I being run or
  imported" compared them without resolving links, concluded "imported",
  and never ran. The documented verify step (`treecontext doctor`) was
  therefore a silent no-op on macOS and Linux. Windows escaped it because
  npm writes a `.cmd` shim naming the real file. Capture was unaffected —
  hooks embed absolute paths — so this only ever hid the CLI.
- **Claude Code's MCP registration went into a file Claude Code never
  reads.** 0.0.9-beta wrote `~/.claude/.mcp.json`; user-scope servers are
  read from `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`). The
  result was the worst kind of failure: `install` reported success,
  `doctor` reported "MCP configured" by parsing back its own dead file, and
  no `treecontext_*` tool ever appeared in a session. Upgrading writes the
  registration where it is read and clears the dead entry, leaving any
  other server in that file alone. This is also why global installs
  appeared impossible — only per-project `.mcp.json` had ever worked.
- **Hook wrappers could choose an interpreter that cannot run this
  package.** They took the first `node` on PATH; on a Mac with Homebrew
  node 26 in front (no prebuild for `better-sqlite3`) every capture hook
  died on `require`. Hooks end in `2>/dev/null; exit 0`, so they "ran" and
  nothing was ever recorded. `install` now probes candidate interpreters
  and pins one proven to load the native binding, keeping the old runtime
  resolution behind it so an nvm upgrade still cannot strand you.
- **`doctor` offered a fix that could not work.** Hooks left behind on a
  platform `install` deliberately does not manage were reported on the
  agent's own row with `install --force` as the remedy — a command that,
  by design, writes nothing there. Those now get their own row, naming the
  stale build they would execute, with a command that clears them.

### Added

- `treecontext uninstall --hooks-only` — remove an agent's hook
  configuration while keeping its MCP registration, instructions and
  skill. This is what `doctor` now offers for leftover hooks.
- `doctor` checks the **hook interpreter**: it probes the interpreter the
  wrappers will actually use, not just the one running `doctor`. A node
  that cannot load the binding is now an error that says capture would
  record nothing, instead of a green row.
- `install --dry-run` names every file it would write, including the six
  hook scripts and `settings.json` it previously left unlisted — and no
  longer writes a debug log while claiming to change nothing.

### Changed

- A failing agent no longer aborts the whole install. Each agent is wired
  independently, the failure names the path and permission, and the run
  still exits non-zero. Previously the first unwritable directory ended
  the run, so which agents got configured depended on their order.
- Claude Code's `~/.claude.json` is copied to `.claude.json.treecontext-backup`
  before it is touched. It is the agent's live state file, not ours.

### Carried over from main (unreleased at 0.0.9-beta)

The 0.0.9-beta tarball was cut before these landed:

- Owner rulings: recency fusion default, the channel-dedup protocol,
  by-name `--experimental-capture` opt-in, and the R7 fence.
- Round-3 tier-1 fixes: eviction archive integrity, fingerprint-map
  rollback, and the temporal recency gate.
- gherkin-node-test 0.8.0 with manifest opt-in.

### Verification

The installer charter (`tests/journal/journal-install.feature`) shipped in
0.0.9-beta with every scenario unbound — prose describing all five defects
above, none of it executing. It is now fully bound, and the scenarios that
cross a boundary are checked against the far side: the agent's own
`claude mcp get` output, the wrapper's interpreter resolution actually
executed, and the linked command on PATH invoked the way a user types it.
Binding it falsified three further clauses that had read true as prose,
all fixed above. A release gate (`npm run pack:beta`) now refuses to pack
while any whole-feature charter is unbound unless the release names that
surface explicitly.

## 0.0.9-beta — first private beta

First release of the streamlined journal. This repository starts fresh at
`0.0.9-beta`; the development history, including the tree-era
architecture and its deletion, lives in the original development
repository.

### What it is

A searchable chat-session journal for AI coding agents. Hooks capture your
sessions into a local SQLite store, one per working tree; MCP tools let a
future session search it at cold start instead of trusting a compacted
summary.

- Capture: user prompts, tool calls (input *and* output), assistant
  turn-ends, and agent-authored notes. No invocation is filtered out;
  dropped events leave `[capture gap]` markers.
- Recall: FTS5 BM25 with per-role weights, conversation windows with
  user-directive anchors, temporal queries, resume pointers for cold-start
  orientation, full-fidelity export by id. At the MCP surface, relevance
  queries fuse in recency at weight 0.5 by default (owner ruling
  2026-08-01) — broad orientation queries favor the latest thread; pass
  `recency_weight: 0` for pure lexical ranking. The default never applies
  to `sort_by` temporal queries or adaptive queries; the library API
  default stays 0.
- Retention: session-count recency caps that archive whole sessions and
  leave tombstones before anything is deleted; a byte budget serves as a
  demotion backstop and over-budget signal, not the eviction driver.
  Eviction refuses to run when no archive destination is configured.
- 8 MCP tools; installer with auto-detection, `doctor`, and clean
  uninstall.
- Index-cap expansion (2026-07-28 cap sweep): tool events index up to
  8000 chars of their content (preview plus full-fidelity tail) instead
  of only the bounded preview; user and assistant prose index in full.
  The `TREECONTEXT_INDEX_CAP` env var (floor 300) caps what new captures
  index, for stores where retrieval is slow — stored text is unaffected
  and existing entries keep their view. Ships as additive migration 018
  (`staging.preview_len`).

### Not in this release

Semantic/vector retrieval, hierarchical summary trees, and a code index —
each was built, benchmarked against this workload, and deleted. See
`tests/journal/OUT-OF-SCOPE.md`.

Verified automatic capture under GitHub Copilot: the adapter was rebuilt
against Copilot's documented payload shapes and hook-config schema and
now delegates to the reference capture hooks, but it has not been run
against a live Copilot session. Capture there is available behind
`treecontext install --experimental-capture` (unverified — please report
whether entries appear); a plain `install` gives Copilot users the MCP
tools only. Cursor, Codex, Gemini CLI and opencode adapters are
unverified scaffolding.

### Beta notes

- Not published to npm — install from the release tarball (see README).
- `--npx` is refused for the same reason.
- Query telemetry is **opt-in** and local
  (`TREECONTEXT_QUERY_TELEMETRY=1`).
- The store schema may change between beta releases. Migrations are
  additive, but treat your journal as replaceable for now.
