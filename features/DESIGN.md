# treecontext — design

*The orienting document: what this is, why it is shaped this way, and
where the boundaries are. How the pieces fit mechanically is
[ARCHITECTURE.md](../ARCHITECTURE.md); what the system promises is the
feature corpus beside this file; what it deliberately does not do is
the `OUT-OF-SCOPE.md` fence beside it; the rulings every tag below
names are in `DOCKET.md` beside it. This file is the front door to all
of them, and it lives here, beside the corpus, so the docket lint reads
it (D200). Edit doctrine: nobody edits this file outside a discussion;
the agent holds the pen, and every change appends one changelog line
naming the ruling that sanctioned it. A `ruled` constraint changes only
by the visionary's reversal; a `chosen` one by a discussion at a lower
bar. A change with no changelog line is drift.*

## What it is

A searchable chat-session journal for AI coding agents: a TypeScript
library plus MCP server that captures what happened in a session —
every prompt, every tool call, every response — and makes it
recallable in the next one. An agent cold-starting (or surviving a
context clear) asks the journal "what was I working on, what was the
next step" instead of re-deriving it from scratch, replacing context
compaction as the recall mechanism and preserving prompt-cache
economics.

The charter (owner, 2026-07-16, in full at `tests/journal/README.md`):
capture is automatic and unfiltered, recall is search over a local
SQLite store, and the system serves **multiple agents** — concurrent
sessions, subagents, and worktree clones journal into namespaces of
one store, isolated by default and mergeable on purpose. [ruled: D2, D9]

Two consumption modes, one store:

- **MCP server** (`treecontext serve`, stdio): eight tools —
  `query`, `status`, `insert`, `delete`, `clear`, `export`, `import`,
  `merge_from_agent` — gated by tool-access policies
  (`full` / `contributor` / `read_only`).
- **Library** (`FlatStore`): the same journal with no server, no
  transport, no hooks — for programs that want a memory, not an agent.

## The design stance: earned minimalism

The design is the minimum necessary to honor the charter, and the
minimalism is earned, not aesthetic. Trees (RAPTOR, MemTree,
BIRCH-PCA), a dual-tree promotion pipeline, and dense query fusion
were each **built, benchmarked, and removed** — machinery a chat
journal measurably did not need. What survived is a flat SQLite store
with FTS5 BM25, zstd-compressed content, and a handful of columns that
make its promises database-enforced.

The dead ends were not wasted: they proved where the extension seams
belong. Each is held open as an explicit seam, not speculative code:

- **Dense retrieval** enters (if ever) as a fused, opt-in second
  ranked list — never a dependency, never a default
  (`journal-search-modes.feature`; the fence has the full ruling).
  [ruled: D5, D18, D73]
- **Capture platforms**: any platform's events enter through the
  library staging surface; Claude Code is the reference platform, and
  a platform ships capture only after live-payload verification
  (`docs/hooks/adding-a-platform.md`). [ruled: D29, D30]
- **Multi-agent**: namespaces carry the story, and since v0.1 the
  invariants live in the database itself — see "the store as arbiter"
  below.

## The three load-bearing decisions

**1. The store is the arbiter** (ruled 2026-08-12,
`tests/server/design/store-as-arbiter.md`; amended 2026-08-20, same
document §8). Correctness in a multi-writer world does not depend on
lockfiles or polite processes: dedup is enforced by database
constraints, the capture drain claims its batches atomically, and the
primary claim is a heartbeat-TTL `leases` row inside the database.
Every consumer — server, hook, library caller, a second copy of any of
them — inherits the invariants by opening the store. Since the
amendment, a second server on an occupied namespace serves alongside
the holder instead of refusing: writer safety comes from the store's
constraints, and the claim's remaining duties are visibility and
attribution (`stores merge` keeps true exclusivity). This was a late
rearchitecture, replacing a shipped lockfile model the owner ruled "a
technical oversight"; the lesson it encodes is that concurrency
properties belong where every process must pass, not in per-process
discipline. [ruled: D80, D81, D96]

**2. Capture is honest or it is nothing.** No tool invocation is ever
filtered out; dropped or failed events leave explicit `[capture gap]`
tombstones rather than silent holes; retention archives whole sessions
to disk *before* deleting rows and refuses to evict what it cannot
archive; eviction order respects measured reliance (what recall
actually returned) and never touches the newest session. The journal's
value is that its silences are as trustworthy as its records.
[ruled: D3, D22, D48, D55, D118, D171, D175, D179]

**3. The feature corpus is the control layer** (aBDD). The `.feature`
files under `features/` are the product spec, written in owner language,
audited by the owner, and enforced by guards that make the suite
structurally unable to lie about what it checked (dialect gate, orphan
ratchet, wip registers with written whole-feature rulings, tag
allowlist, step-source lint — inventory in `tests/journal/README.md`;
the two-parser cross-check retired 2026-08-26 when gnt became sole
executor and there was no second parser left to disagree). Declined scope is recorded on
the fences with its why and date; re-opening a fence entry is an owner
decision. Every hardening program in the beta closed through
adversarial review with all confirmed findings fixed and scenarios
pinning what the review found, and the review records are committed
alongside the code they audited. [ruled: D15, D31, D74, D101]

## Trust model, in one paragraph

Everything is local: one SQLite file per project under
`~/.treecontext/stores/`, no network surface (the HTTP transport was
removed at the 0.1 audit as unused), no telemetry unless explicitly
opted in — and the one opt-in instrument writes to a local file beside
the store. Journal contents are treated as untrusted input at recall
time (prompt injection is the consuming agent's boundary), the
repository being worked in is untrusted for store selection (bindings
live in the home directory, not the repo), and everything the tool
writes under `~/.treecontext` is private by mode — directories `0700`,
regular files `0600` on create. Writes elsewhere
follow platform convention (the ccr config this tool wires is `0644`
beside its siblings; installer wrappers are executable). The full
contract is [docs/security.md](../docs/security.md). [ruled: D28, D77]

## Ecosystem

treecontext-mcp stands alone at runtime, and is coupled at the spec
layer to the gherkin toolchain: `gherkin-node-test` (gnt) is the
charter suite's linter and executor, and the corpus is written in a
pinned dialect subset portable verbatim to the Rust sibling (gct).
Alongside gnt/gct/gt/ccr, this repository is a public exemplar of
aBDD practice — the corpus, the fences, the design notes, and the
review records are release deliverables, not internal residue. An npm
metapackage bundling the toolchain is planned once its members are
individually released (`docs/public-release.md`).

## The hackathon re-cut (interview of 2026-10-05 to 2026-10-07)

The first public release, `0.1.0-beta.1` on `2026-10-12` under the npm
`beta` dist-tag, with `0.1.0-beta.2` by `2026-10-16` and `0.1.0` final
after the competition, is cut for a junior four-person hackathon team on
macOS working the aBDD toolchain through Claude Code with /clear instead
of compaction. [ruled: D192, D197] Recorded 2026-10-08: the beta.2 set
was built on 2026-10-08, before `0.1.0-beta.1` was cut, and ships inside
`0.1.0-beta.1`; the chunk bullets below that say "beta.2 build" name
the set, not the release that carries it; the fold awaits the owner's
ratification. [ruled: D253] The constraints the build must not cross:

- **Two kinds of checkpoint, distinguishable everywhere.** The bookmark
  is automatic, cheap and low in signal; the chapter summary is the
  developer's deliberate, high-signal note. Search ranks the chapter
  above the bookmark; a new bookmark supersedes the session's previous
  one; chapters keep today's supersession rule. [ruled: D158, D166,
  D183]
- **The bookmark is the stop hook's second duty.** At every turn end the
  hook checks the session's newest checkpoint against a configured
  interval, rounds and or minutes, default `20` rounds or `45` minutes
  whichever first, and blocks once to have the agent write a bookmark;
  a failed write is reported once and never blocks the developer. Capture
  of the response stays the hook's first duty. [ruled: D156, D157, D163]
- **The interval is set from inside the session through a treecontext
  command.** [ruled: D156] The command is the CLI's config command,
  invoked by the agent on the developer's word, so the ruled tool set is
  unchanged (D139). [chosen]
- **Re-orientation is one bounded packet, disclosed, never decided.**
  On a /clear the session-start hook emits: the session's newest chapter
  with its age and its one-hop referrers; the newest bookmark with its
  age, the count of entries between, and its referrers; the newest `5`
  developer turns since the bookmark, each cut to its first line with
  its length, with the omitted count; the one-line chapter reminder.
  About `3000` characters; anything more is the agent's deliberate fetch
  by id. [ruled: D187, D162, D186] The packet rides the hook's
  `additionalContext`, the same channel the rehydration text uses today.
  [chosen] Recorded 2026-10-08: the closing line is settled in the code,
  not in a ruling — the packet ends with the one-line chapter
  reminder when the session has a chapter summary; on a no-chapter day
  the once-a-day nudge of D198 carries the reminder on the first clear of
  the local day, and later clears that day close with no reminder line
  (`src/checkpoints.ts`, the packet's closing branch). [ruled: D252]
- **Scenarios bind on the packet and on the instructions, never on the
  model's reply.** [ruled: D188]
- **The novice is carried by the instructions.** The handshake text
  teaches the two kinds, the word that writes a chapter, the packet's
  shape, the handoff steps, the suggestion to clear after a chapter, and
  doctor as the first move when something looks wrong; the nudge for a
  developer with no checkpoint fires on the first /clear of the machine's
  local calendar day. [ruled: D174, D173, D179, D198] The nudge's
  once-a-day mark is a row in the store keyed by session and local date.
  [chosen]
- **Lanes, append-only, like git.** The main lane and every derivative
  stay their own; any writer may append into any lane with writer and
  reference stamped by the store; nothing outside the writer's lane is
  modified; a cross-lane supersession is a pointer the owning lane sees
  at its next re-orientation, never a flag flip; only a lane's own
  writer retires its pointers. References follow git conventions: name
  by id, say what you respond to, the store keeps the reverse index, one
  hop shown by default. [ruled: D169, D186] The reverse index is a
  table keyed by referenced id, filled on insert from a `refs` list in
  metadata, and `supersedes` across lanes writes a reference instead of
  flipping the target's flags. [chosen]
- **Self is recovered from where a session runs, not its process.** The
  session-start hook registers self, worktree, branch and directory,
  under the session id; the server stamps tool-written rows by looking
  up that session. A restarted worktree resumes its own thread; a new
  worktree is a new subagent process; a group member orients on self and
  group (deferred, D209: group orientation is not built). Namespaces stay
  the process-level boundary; lanes are metadata
  inside them. [ruled: D167, D190, D168, D196] Writer identity on
  captured rows comes from the payload's agent id, agent type and cwd,
  which the hooks already receive; the registration lives in the store
  table `session_registry` (migration 027). [chosen] Revised 2026-10-08:
  this bullet first placed the registration in the existing
  session-annotation channel; the build replaced that means with the
  registry table (D235), as the self-registration bullet below records.
- **The orchestrator reads a subagent's summary and its trail.** The
  summary is findable by search and marked as the subagent's; the trail
  is readable on its own by writer. A new subagent starts from its
  role's prior trail and the plan it was spawned under, not the whole
  history by default. [ruled: D147, D148, D150]
- **Handoff is a file through the repository, pull model.** Summaries by
  default, the whole journal by deliberate choice with a secrets
  warning; the file says in itself who, when, from where, what, and the
  one import step; every imported entry is marked as imported from that
  file by the importer, the file's claims kept as data; everything new
  lands, anything truly present anywhere in the store is left alone,
  identity first and content only without ids, never a failure on a
  duplicate; file-bound content never transits the conversation and
  carries no cap, inline keeps today's `10000`; timestamps universal,
  skew disclosed. Two doors: a path argument on the tools, built first,
  and terminal commands. [ruled: D149, D151, D164, D165, D170, D172,
  D177, D184, D199] The path argument is accepted only inside the
  project directory, so the agent cannot be steered into writing
  elsewhere. [chosen]
- **Other clients: a dated matrix and a doctor that knows each one.**
  Capture is promised only where verified live, Claude Code alone; the
  matrix documents each client's hook support with the documentation's
  date; doctor states each documented client's mode, state, correctness
  and remedy; the installer writes nothing for a client that reads the
  Claude file, and for a copying client, Codex CLI and Gemini CLI, it
  copies the hooks only behind the existing experimental flag, writing
  the tools alone without it. [ruled: D153, D208]
- **Availability and ops burden.** Nothing treecontext does blocks a
  turn; capture degrades with a gap marker; doctor names the cause in
  one command; the sprint runs with zero maintenance. Performance
  figures for the new moments are aspirational ranges, never gates.
  [ruled: D175, D178, D176]
- **The build pattern.** Fable produces the feature files; a cold Fable
  review of them by the CINO layers precedes any build; Opus subagents
  build; Opus reviews first and Fable last, both ordered by the CINO
  layers and the blind family. The coverage harness ships report-only;
  the two-axis bar and the latency gate move to `0.1.x`. [ruled: D202,
  D194]
- **Chosen means of the beta.1 build, chunk 1 (2026-10-08).** The
  interval and the nudge mark live in the store's own config table:
  `checkpoint_interval` as rounds, minutes and the echo text, and
  `reorient_nudge:<session>:<local date>`; the command is `treecontext
  config checkpoint-interval <value>`, invoked by the agent through the
  shell, never an MCP tool. A bookmark is a curated entry with metadata
  kind `bookmark`; a chapter summary is one with `next_session`; the
  bookmark's rank factor is `0.25`, the weight assistant prose already
  carries, so a chapter outranks it. "Effectively off" is any limit above
  about three hundred rounds or a day. A retraction is written as a
  chapter summary that supersedes the one it names, and status pointers
  carry `kind` and the ids they supersede. The packet reads the handoff
  line from `_handoff_file` and `_handoff_sender` metadata, which the
  handoff chunk stamps on import. The session-start hook is wired on the
  clear and resume matchers as well as startup, so an existing install
  reinstalls to receive the packet. Text naming no interval is a usage
  error. [ruled: D217] A /clear mints a new session id: the developer's
  session for re-orientation is the chain of ids linked through clears on
  one process, read from the pid beacon's predecessor before the hook
  rewrites it; the nudge and bookmark supersession key on the chain, and
  the stop hook records each ask so it never asks twice within one
  interval. [ruled: D216]
- **Chosen means of the beta.1 build, chunk 2 (2026-10-08).** The
  import tool is the handoff door, and every import through it is a
  handoff: it stamps every entry it lands with `_handoff_file` (the
  import's label, naming the file), `_handoff_importer` (the importing
  session), `_handoff_imported_at`, and `_handoff_sender` (the file's own
  `exported_by` claim, which every export now writes as `<user>@<host>`).
  The file's claims of session, writer, author, agent, namespace, merge
  provenance, supersession and pointer state (`next_session`, `status`),
  and every `_cc_session*`, `_relied*` and `_handoff_*` key, move verbatim
  into `_handoff_claims`; the importer sets the row's read-only flag,
  decay exemption, utility and source. The entry's lane is `session_id`
  `handoff:<claimed session>`, a claimed `supersedes` becomes `refs`, and
  the packet's handoff line, "Handoff claimed from <sender>", reads the
  newest chapter the file claims and calls a time more than five minutes
  ahead the future. Already present means, in order, an id held by any
  lane or named by any lane's `_merged_from_node_id`, then content, in
  every lane, for an entry with no id; an id held with different content
  is left alone and counted as an id conflict, and an entry that is not
  an object is counted as malformed. The curated unique index leaves
  handoff lanes out (migration 025, one shared definition), so identity
  alone decides there; retention never takes a handoff lane for the
  newest session and orders it by import time. The library import without
  the handoff marks stays the archive restore's faithful round-trip.
  [ruled: D218, D219, D220, D221, D222, D223, D224]
- **Chosen means of the beta.2 build, chunk 6: doctor per client
  (2026-10-08).** Each documented client's doctor row ends in one clause,
  `the client <mode>; state: <state>; remedy: <remedy>`, its mode worded
  as the README matrix words it. A client is installed when the directory
  detection already looks for exists (`~/.codex`, `~/.gemini`, VS Code's
  `Code/User`, `~/.cursor`, OpenCode's config directory). The copy a
  copying client gets behind the experimental flag is the Claude Code
  block install writes today, running the same `~/.claude/hooks/tc-*`
  scripts: verbatim under `hooks` in `~/.codex/hooks.json` (doctor also
  reads the top level an older build wrote and `[hooks]` in
  `~/.codex/config.toml`), and in `~/.gemini/settings.json` with events
  renamed UserPromptSubmit→BeforeAgent, PreToolUse→BeforeTool,
  PostToolUse→AfterTool, PreCompact→PreCompress, Stop and the subagent
  events dropped, matchers kept, Claude's Windows `shell` key dropped. A
  command is treecontext's only when it runs a known script in
  `<home>/.claude/hooks/` or is an earlier build's spelling. A copy is
  consistent when its treecontext entries equal that block's, foreign
  hooks and matcher order aside, it sits in one place only, and the
  scripts it runs exist; the flagged install command both copies and
  rewrites, clearing `[hooks]` in config.toml as well, and uninstall
  removes both. Uninstalling Claude Code keeps the scripts while a copy
  runs them and names the uninstall to run first. VS Code's `chat.useClaudeHooks` is read from its
  user `settings.json` as JSON with comments, unset counting as off; the
  Claude Code block counts as installed when `~/.claude/settings.json`
  holds this build's block. [ruled: D225] For VS Code and Cursor the
  experimental flag writes nothing and prints one line; their adapters
  stay in source, unwired; a hook file an earlier build wrote for them is
  a second route doctor warns about, remedied by `uninstall --agent
  vscode|cursor --hooks-only`. [ruled: D226]
- **Chosen means of the beta.2 build, references and lanes
  (2026-10-08).** An entry names what it responds to in `metadata.refs`,
  one id or a list. The store's reverse index is the table `node_refs`
  (referenced id, referring id), created by migration 026 with a backfill
  and kept by triggers on `nodes` — insert, a change of `$.refs`, delete
  — so ingestion, import, merge and restore maintain it unaware. The
  referenced-by block is one hop and bounded the same way on every read
  surface: the count of all referrers in the entry's own namespace, and
  one referrer's id, writer, age and first line cut to 80 characters —
  the newest from another lane when there is one, else the newest —
  never its full content and never its own referrers. Search hits and a
  fetch by id carry it as `referencedBy` (absent when nothing refers);
  the whole-journal export carries none; the packet's line under each
  checkpoint reads `referenced by: <id> (newest of N), <writer>, <age>
  old: "<first line>"`, or `none`. The writer shown is the importer's
  mark, then `_writer`, then `agent_type`, then the session. Supersession
  follows the lane: the lane key is the `handoff:` session key of an
  imported entry, else `_writer`, else `agent_type`, else the main lane
  (the session is not part of it). A target in the writer's own lane is
  retired as before; a target in another's is left byte for byte, its id
  is added to the new entry's `refs`, and the insert reply lists it under
  `referenced`. The server stamps `_writer` itself: a tool-written row by
  looking the session up in the registry at insert, made exact by the
  call's own PostToolUse echo at the drain, and a caller's copy of the
  stamp is dropped (D240). A dedup hit records no refs and the reply lists them as
  `refs_not_recorded`; the survivor is never modified. The insert tool
  drops caller `_handoff_*` keys. A bookmark's automatic supersession
  is per session per lane (D241, D245). [ruled: D227, D228] Revised
  2026-10-08: this bullet first said the lane key was a claim until the
  server stamped `_writer`, so the protection was inert for real
  subagents, which wrote neither key, and that a bookmark's supersession
  stayed session-scoped (D166); the self-registration build made the
  server stamp the writer by registry lookup and the echo (D240) and
  scoped bookmark supersession to the lane (D241, D245).
- **Chosen means of the beta.2 build, chunk 4: the file-bound handoff
  (2026-10-08).** `treecontext_export` without a node id exports a
  handoff: `form` is `summaries`, the default (live `next_session`
  pointers that are not bookmarks, and rows of `kind`
  `subagent-summary`), or `whole`, which writes nothing and returns the
  secrets warning until it is called again with `secrets_acknowledged:
  true`. With `path` the server writes the file itself, uncapped, and
  replies with the file's name and the count alone; without it the reply
  is inline, the newest `10000` at most (`max_export_nodes`, default and
  ceiling), stating `omitted` and the way to the rest. The file's head:
  `exported_by`, `exported_at`, `project`, `treecontext_version`,
  `holds`, `to_import`, then `form`, `node_count`, `version`,
  `namespace`; on import only `exported_by` is read, as a claim.
  `treecontext_import` takes `path` or pasted `data` with `label`, never
  both; a path import is uncapped and labelled with its path. Both tools
  hold a path to the project directory the server was started for
  (`--project-dir`, `TREECONTEXT_PROJECT_DIR`, the working directory),
  resolved through the links of every existing directory, never a link
  as the file itself. From a shell, `treecontext export <path> [--whole
  --yes]` writes the same bytes the tool writes, and `treecontext import
  <path>` imports with the importer `shell:<user>@<host>`; the tree-era
  tombstone remains only for a `.msgpack` dump. Inside the project, a
  path under `.git` is refused and an existing file is replaced only
  when it is itself a handoff (`form` and `exported_by` at its head); a
  file read by path that is not JSON is refused without echoing it. The
  tool's export without a node id is the summaries handoff, so the
  library and shielding scenarios' whole exports were reworded to choose
  the whole form. [ruled: D229, D230, D231, D232, D233, D234]

- **Chosen means of the beta.2 build, self registration, writer stamps,
  worktree self and subagent trails (2026-10-08).** The registry is a
  store table, `session_registry` (migration 027), rather than the
  session-annotation files the self bullet above names: one row per
  session and agent, the session's own row (empty agent id) holding its
  worktree (a linked worktree's directory name, none for the main
  checkout), branch, directory, top level and common dir as git reports
  them, a subagent's row its agent id, type, start and stop. The
  session-start hook registers the self on every start; two new hooks,
  SubagentStart and SubagentStop, register and retire a subagent under
  the parent's session id, and SubagentStop stages the subagent's last
  message as its summary, kind `subagent-summary`. Captured rows take
  `_writer` from the payload's agent type at the drain (`_writer_src`
  `hook`). Tool-written rows are stamped at insert by the server from the
  session it resolves, then made exact at the drain by the call's own
  PostToolUse echo (matched by the node id its result names, `echo`). At
  insert: no subagent live, the self, `main` or `worktree:<name>` with
  `_worktree` and `_branch` (`self`); a subagent live but the session's
  own agent seen by a hook since it started, the self (`concurrent`); one
  live and no such sign, that subagent (`provisional`); several, the self
  with the candidates, owning no lane (`ambiguous`). The reply says the
  writer and, for the three guesses, a `writer_note`. The heal acts only
  on a row the call created, of its own session, within 60 seconds. When
  the echo moves a row to another lane, what the first stamp did across
  lanes is put right: pointers it retired that the new lane does not own
  are restored (to an earlier retirement when they had one, from
  `_superseded_prior`) and become references; a retirement it suffered
  from another lane is undone and becomes a reference on the retiring
  row; supersessions it could not perform (`_supersedes_referenced`) are
  performed if the new lane owns them; a restored bookmark stays retired
  when its lane already has a newer live one.
  Caller copies of the stamp are dropped. The lane key reads `_writer`,
  `main` and no writer being one lane; a row naming a subagent's agent id
  never stands in for the orchestrator's checkpoints in the packet, and a
  bookmark retires only its own lane's previous one. A fresh start in a
  linked worktree opens its packet with the worktree's own newest live
  chapter and the brief addressed to it, an entry whose `brief_for` names
  the worktree, written by the orchestrator before the worktree's first
  session; its status lists its own lane's pointers (`scope: "all"` for
  every lane). A `provisional` caller searches its role's trail, the
  spawning lane's live pointers, entries briefing its role and their
  one-hop references, windows included; `scope: "all"` widens it, and
  every other caller searches the whole store. A writer's trail is
  `treecontext_export` with `writer`, outside the handoff's summaries
  default. Every session (re)start retires the session's live subagents.
  [ruled: D235, D236, D237, D238, D239, D240, D241, D242, D243, D244,
  D245]
- **Deferred, after the betas**: nothing of the beta.2 set remains
  unbuilt (references, the file-bound handoff, doctor per client, self
  registration and the subagent set all landed on 2026-10-08); what
  stays deferred is the remainder of the attribution program, group
  orientation (D168) among it. [ruled: D197, D191] The restore door for this store's own archives and
  demoted stumps, a distinct operation reading the archive from the path
  a tombstone records, is scoped after `beta.1`. [ruled: D222]


## The ruled structure, indexed

Every structural ruling in the docket that the prose above does not
already cite, one line each in the docket's own words, so the design
layer carries the whole ruled shape and the docket lint can read it.
Added 2026-10-07 when this file moved beside the corpus (D200); the
index is a transcription, not a new decision.

- the single-author session structure is a ranking signal: time, turn sequence, and role rank, they do not merely filter [ruled: D6]
- the surfaces the agent reads are first-class product: tool descriptions, hooks, the session-start reminder, and the `AGENTS.md` block teach the protocol, and the platform payload shapes are pinned [ruled: D8]
- an attachment is journaled as a stored description plus a URI reference to the pdf, image, video, or audio; the bytes stay out of the store [ruled: D10]
- the platform-independent capture surface lives in the library: events from any platform journal identically through the staging surface, while the capture feature pins the reference platform's payloads [ruled: D16]
- a media entry is an event, not an asset: exactly one reference per entry, several attachments are several entries, the same file attached twice is two entries, a repeat sighting is a new event, and drift detection is a hash-in-metadata convention, not a store mechanism [ruled: D26]
- tool schemas describe only what the backend does; a schema that still described subtree drilling, multimodal retrieval, or dense fusion after the tree era is a defect [ruled: D39]
- an adaptive result count over a fused ranking returns the budgeted count and discloses that no cutoff was found, rather than inventing one [ruled: D44]
- authored text, user and assistant, is indexed in full: the old character-prefix caps cost measurable recall, and only tool output keeps a bounded index reach [ruled: D47]
- trust tiers at the tool surface: a read-only server exposes only the reading tools, a contributor adds but never removes, and merging and reliance bookkeeping are full-trust writes [ruled: D50]
- install detects what exists, shows a dry-run plan, merges rather than clobbers, registers where the agent itself reads, and doctor diagnoses honestly with fix commands; uninstall reverses the wiring and never the record; the summary names every hook event of the block install writes; on POSIX each hook command execs its wrapper, so the hook's parent is the agent's own process [ruled: D51, D250, D251]
- near-universal query tokens are pruned for speed and never at the cost of a discriminative hit: pruning applies only above a corpus-size floor, a query of only pruned tokens still matches, and small corpora are never pruned [ruled: D54]
- recency fusion is the served default at the MCP surface at weight `0.5`, fused as a rank list, never a score formula; the library default stays zero, an explicit zero opts out, and the default is never applied to adaptive queries or non-relevance orderings [ruled: D56]
- the first hook on a fresh install captures without waiting for a server: a hook may mint the store it binds, applying one definition of fresh and the full migration ladder; a store holding rows is never migrated by a hook; a second starter waits and finishes the ladder [ruled: D58]
- schema changes never eat a store: every migration on the ladder runs behind a backup taken while store and backup are twins, and only an unwritable store refuses; this replaces the earlier additive-automatic, destructive-opt-in split [ruled: D59]
- every migration run copies the store aside before any pending migration, additive as well as destructive, and verdicts that copy by containment, every row the backup holds present in the migrated store and none fewer, like any other backup; only an in-memory database is exempt [ruled: D256]
- a destructive migration backs up while store and backup are twins and records a completion verdict at migration time; the count-at-sweep-time content check is superseded, because eviction makes it refuse forever for a healthy store and later captures mask migration loss [ruled: D60]
- the backup sweep is manual and opt-in: it deletes only backups with a verified verdict, refuses failed or missing verdicts and labels each refusal, verifies every generation independently, and one confirmation covers the whole run because safety lives in per-item verification [ruled: D61]
- when the completion comparison after a migration fails, the store still opens: refusing would undo nothing and brick a store whose backup sits beside it; instead it warns loudly at migration time naming the backup as the intact copy and records the failed verdict, so doctor is never the first place a user learns their migration lost data [ruled: D64]
- prune honors the same spare rule as removal: verified backups go with the stray, failed or missing-verdict backups are spared as shells, and doctor reports the orphan; nothing in this tool deletes the only intact copy of a store's data [ruled: D65]
- when a backup's verdict is success but its live store is gone, the sweep still refuses, with the distinct reason "orphaned verified backup" naming the removal command as the reclaim path; removal reclaims the shell explicitly and labels it an orphaned verified backup, never a spared live rollback; doctor names the exact reclaim command [ruled: D70]
- fix all eleven: the removal dry run on an orphan shell names the directory it would remove; a mixed shell is a bound scenario where removal takes the orphan, spares the rollback, and exits success while a rollback-only shell keeps its refusal exit; the sweep removes a verdict sidecar whose backup is gone; doctor's reclaim advice is honest about addressability [ruled: D71]
- a bare store name that would create a store and fails the addressability check is refused at creation only; opening an existing odd-named store keeps working, so no lockout on upgrade, and paths pass through untouched [ruled: D72]
- capture rows are attributed to their namespace in staging before the release, so isolation holds on the capture side and not only at query time [ruled: D78]
- the operations exit contracts are bound: the removal exit asymmetry, the sweep's partial-completion exit per trigger with the self-healing stranded-sidecar non-trigger, prune's dry run, and doctor's backup advice carried in the fix channel [ruled: D84]
- a curated row is attributed to the exact session that made it from the store's own capture echoing its tool calls; a guess never outranks evidence and a missing echo never invents an id [ruled: D86]
- user backups are invisible to the store listing and doctor, which count only migration backups by exact filename, and the size column stays database-only because the write-ahead siblings are transient [ruled: D88]
- Windows namespace attribution goes into the identity program before the release candidate: the drain publishes a session-keyed namespace annotation from exact echo evidence, and hooks resolve by the session id their payload carries [ruled: D90]
- silent identity succession is a defect: a project's binding key changing under it must never orphan the journal; succession is announced, ambiguity fails closed, past splits are detectable and repairable without data loss, and the full three-part program of succession, a doctor detector, and store merge goes in before the release candidate [ruled: D92]
- the ratified session-first rung order is restored: the session rung is causal and a session id is never recycled while the pid file is structurally shared, so the session-keyed annotation outranks the pid rung; the mid-session relaunch counter-case is accepted as a disclosed, self-healing residual [ruled: D95]
- treecontext offers to write the pane wiring into the reader's own configuration itself, because a reader that survives a typo by drawing nothing makes every mistake invisible; pulled into the release line after no closed-beta tester got a pane by hand-naming paths [ruled: D98]
- the sidecar is a post-charter surface, not charter detail (h): pane files on disk beside the store, pure data conformant to the reader's pane contract; the renderer never runs treecontext's code, stale health never reads as an all-clear, only the drain owner writes a pane and rewrites it on every drain, and a drain that fails confesses [ruled: D102]
- all six client integrations stand, Cursor included: Claude Code, Gemini CLI, VS Code, Codex, Cursor, OpenCode [ruled: D104] — noted 2026-10-08: the VS Code and Cursor adapters are in source and unwired; the installer writes nothing for those two clients, which read the Claude settings file (D226)
- version skew is stated policy: stores migrate forward, the oldest supported store version is named per release, a store with a newer schema is refused by name, and in mixed-version lanes the laggards refuse until upgraded [ruled: D116]
- an append-only access log exists; more data is better forensics later, and a performance cost is optimized only when it appears [ruled: D125]
- an agent registry exists, one record per agent lifetime, so a row needs only an agent identity and the rest is a join [ruled: D126]
- a subagent restricts its search through an option on the query tool rather than through a namespace; treecontext offers the flexibility and a project's `AGENTS.md` documents the workflow [ruled: D127]
- the access log and the agent registry are two tables, not one: the registry is one row per agent lifetime and joins onto rows, the log is one row per read event and will need its own retention [ruled: D128]
- namespaces stay as they are, the hard boundary between separate processes, and are not extended by this program; documented as an advanced, process-level lane [ruled: D129]
- the store-byte budget default rises from `64 MiB` to `128 MiB`, and both the budget and the session cap become operator-settable per store through a key in the config file; subagents multiply a session's content without multiplying the session count, which is what the old sizing did not anticipate [ruled: D141]
- the build item of D141 lands: a `128 MiB` default, the config file's `retention` table with `max_store_bytes` and `max_sessions`, a project's `./treecontext.toml` ahead of `~/.treecontext/config.toml`, the project file found at the root the store binding resolves, both passed to every store handle serve opens, an entry safety net of two hundred per configured session, reported by status, and an over-budget warning that names the key and the file [ruled: D255]
- a merge from a namespace is idempotent by identity: every copy carries a pointer to the source entry it came from, a repeated merge consults that pointer before the content predicate and adds nothing for an entry already carried across, and the merge counts disclose the already-merged class as its own number [ruled: D144]
- a dead peer earns a swallowed write or a shutdown, never a storm; a server serving a client writes its diagnostics to its log file under `~/.treecontext/logs/` only and keeps its stderr for warnings, errors and fatals, because the client records every stderr line as an error; `--debug` stays wired, the log file stays what `doctor --dump-logs` reads, and a hook keeps its diagnostics on stderr [ruled: D258]
- the design document's canonical home is `features/DESIGN.md`, beside the fence, the ledger and the docket, where the docket lint reads it; the root `DESIGN.md` becomes a one-paragraph pointer to it [ruled: D200]

## Reading order

| To understand… | Read |
| --- | --- |
| What the product promises | `features/*.feature` (start with `journal-recall`) |
| What it refuses to do, and why | `features/OUT-OF-SCOPE.md` |
| How it works mechanically | [ARCHITECTURE.md](../ARCHITECTURE.md) |
| The multi-user model | `tests/server/design/store-as-arbiter.md`, then `multi-user.md` |
| The security contract | [docs/security.md](../docs/security.md) |
| What 0.1 means | [docs/release-charter-0.1.md](../docs/release-charter-0.1.md) |
| The spec methodology | `tests/journal/README.md` |
| Session identity (and its v2) | [docs/session-identity.md](../docs/session-identity.md) |

## Changelog

*In date order, oldest first; entries of one day in commit order.
Reordered 2026-10-08 at the audit's correction pass; before that the
newest lines had been prepended out of order.*

- **2026-08-15** — authored in one sitting alongside the v2
  session-identity program.
- **2026-08-24** — first reconciliation against the build, from the
  initial `/audit` field run's findings
  (`docs/review-2026-08-24-audit-run-1.md`): the store-as-arbiter
  decision now carries amendment 8 (same-namespace servers serve
  alongside; the refusal they replaced was retired by ratified work,
  not drift), the dedup sentence names database constraints rather
  than one mechanism, and the trust model states the file-mode
  contract `docs/security.md` actually makes instead of an
  unscoped "everything `0600`/`0700`".
- **2026-08-27** — second reconciliation, from the second `/audit`
  field run (@ 667410e): accounts for the three programs the doc had
  not yet absorbed — the MCP-SDK-v2 server split and the bindings-file
  write lock (rc.4, 2026-08-25; both verified consistent with
  decisions 1 and 2), and the executor migration + mega-runner
  extraction (2026-08-26: gnt 0.11.0 is sole linter and executor
  corpus-wide, step bodies live in per-feature definer modules, and
  decision 3's guard list above now names the guards that exist rather
  than one that retired).
- **2026-09-28** — `[ruled: …]` tags added at the docket backport; the
  ids name entries in `features/DOCKET.md`.
- **2026-10-07** — moved to `features/DESIGN.md` (D200) and extended
  with the hackathon re-cut: the ruled constraints of D145–D202 and the
  builder's chosen means beside them; the root file is now a pointer.
- **2026-10-08** — chunk 1 of the beta.1 build records its chosen
  means (config keys, command, rank factor, thresholds, handoff keys).
- **2026-10-08** — the /clear session-id correction (D216) and the
  builder's thresholds (D217), from the chunk-1 review.
- **2026-10-08** — the copying-client bullet follows D208 (the copy
  behind the experimental flag), raised by the chunk-3 builder.
- **2026-10-08** — chunk 2 of the beta.1 build records its chosen means
  (the handoff marks, the claims key, the handoff lane, the identity
  order), D218-D220; corrected after its review (D221-D224): pointer
  state is a claim, the curated index leaves handoff lanes, the export
  head names its sender, and the restore door is deferred.
- **2026-10-08** — chunk 6 (beta.2, doctor per client) records its
  chosen means (row clause, detection markers, the copy and its
  consistency rule, the VS Code setting read) under D225. Noted at the
  correction pass: the same commit (6502f47) also wrote the bullet's
  closing sentence on VS Code and Cursor, which rests on D226.
- **2026-10-08** — references and lanes (9b7023a, recorded at the
  correction pass; the commit added no line): the chosen-means bullet
  for `metadata.refs`, the `node_refs` reverse index of migration 026,
  the one-hop referenced-by block and lane-following supersession,
  D227 and D228; the Deferred bullet narrowed to "the rest of the
  beta.2 set".
- **2026-10-08** — chunk 4 of the beta.2 build records its chosen means
  for the file-bound handoff (the export forms, the head, the path rule,
  the shell commands, the overwrite guard), D229-D234. Noted at the
  correction pass: the same commit (964dc82) rewrote the Deferred bullet
  to say the file-bound handoff had landed in chunk 4.
- **2026-10-08** — self registration, writer stamps, worktree self and
  subagent trails (c18435c, its merge 5ba6156 and 95c2a55; recorded at
  the correction pass, the commits added no line): the chosen-means
  bullet first written at c18435c was rewritten substantively at
  95c2a55 — the stamp sources renamed to `self`, `concurrent`,
  `provisional` and `ambiguous` with the drain's `echo` making them
  exact, the disclosed background-subagent residual dropped, the
  reversal rules for a row the echo moves across lanes added, and a
  bookmark retiring only its own lane's previous one; the merge
  rewrote the Deferred bullet to say nothing of the beta.2 set remains
  unbuilt. D235-D245.
- **2026-10-08** — publication generalization and the package rename
  (43e1519, b7c0d73, 05a453f): no text of this file changed; recorded
  so the trail accounts for D246 (the record names no private project
  or person, both chain heads kept), D247 and D248 (the npm package is
  `treecontext-mcp`, the wrappers search under both names, the npx
  form names the package).
- **2026-10-08** — the live-probe fixes (a077ed6): the D51 line of the
  ruled index adds the install summary naming every hook event and the
  `exec` hook command on POSIX, D250 and D251; D249, the stop hook
  capturing the payload's own message, changed no text here.
- **2026-10-08** — the audit's correction pass: the self bullet names
  `session_registry` (D235) with a dated note; the references bullet
  says the server stamps `_writer` (D240) and bookmark supersession is
  per session per lane (D241, D245), with a dated note; the packet's
  closing line records the D187/D198 settlement (D252); the re-cut
  header records the beta.2 set built into `0.1.0-beta.1` (D253); the
  duplicated "effectively off" sentence is removed; decision 2 also
  cites N2's own rulings D118, D171, D175 and D179; the group
  orientation sentence is marked deferred (D209); the D104 index line
  notes the unwired VS Code and Cursor adapters (D226); this section is
  put in date order.
