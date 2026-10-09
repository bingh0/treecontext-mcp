# Changelog

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
