# Proposal for beta review: who wrote this row, and who may read it

**Status: draft for beta-tester feedback, 2026-09-24; §3 revised and §5a added 2026-09-27 after round one and a design review.** Nothing in this
document is decided. It precedes the scoping interview for the
attribution program and exists so that objections arrive *before* the
rulings become feature files, not after. The findings in §1 are
verified against rc.7 code and a live store; the needs in §2 are the
owner's words; the design in §3 is one candidate set of means and is
the part most open to change; §5 is the list of questions we want your
answers to.

How to respond: reply in the thread this was posted to, quoting the
question number (Q1–Q12) or the section you are objecting to. Every
objection is recorded as a ruling with your reason attached, so a
one-line "Q3: hits only, exports are noise" is a complete and useful
answer.

The docket ids in this document were renumbered on 2026-09-28 when the whole corpus was backported into `features/DOCKET.md`: the program's needs are N18–N22 and its rulings D122–D129 (D130 records the backport).

---

## 0. The problem in one paragraph

treecontext journals a session into one SQLite store per project.
Today every row says *which session* wrote it and *whether a hook or a
tool call* wrote it, and that is nearly all it says. When a session
spawns subagents, or works in a git worktree, or a second agent's lane
is merged in, the rows that result are either indistinguishable from
the main agent's or distinguishable only by side effects. The store
also records nothing about who *read* a row. The owner has asked for
each row to stand on its own for traceability, for reads to be logged,
and for a subagent to be able to search only its own space while the
whole store stays open to it. This document lays out what exists, what
is asked for, one way to build it, and where we need your view.

---

## 1. What rc.7 does today

Every statement in this section was checked on 2026-09-23 by reading
the code *and* inspecting a live store with SQLite directly. Where the
finding is a gap, it is labeled as one. Where documentation and code
disagree, both are quoted.

### 1.1 One store per project

- The store lives at `~/.treecontext/stores/<name>/treecontext.db`.
- The name is the git remote slug when there is a remote, otherwise
  the directory basename plus a six-character hash of the identity.
- The identity is `git:<remote.origin.url>` when a remote exists,
  otherwise `path:<realpath of the primary repo root>`.
- A fingerprint of the identity maps to the store in
  `~/.treecontext/bindings.json`.
- Clones and worktrees of the same repository resolve to the same
  identity and therefore the same store.

### 1.2 The namespace is always `project`

- The installer writes `serve --transport stdio --capture --debug`
  with no `--namespace`. The config file has no namespace key. Only
  the CLI flag changes it.
- The live store on the owner's machine has exactly one namespace row.
- The lane design (a second server started with `--namespace agent-a`,
  isolated by default, folded into the trunk with
  `treecontext_merge_from_agent`) is real, specified in
  `features/journal-namespaces.feature`, and bound to passing tests.
  It requires a *separately launched server*. Nothing the Agent tool
  does can produce one.

### 1.3 What a captured row records

A row written by a hook (`source_label = 'auto-capture'`) carries:

| Field | Meaning |
| --- | --- |
| `session_id` | The Claude Code session id from the hook payload |
| `role` | user, assistant, or tool |
| `tool_name` | The tool that ran, for tool rows |
| `created_at` | The moment the event happened (hook time) |
| `ingested_at` | The moment the drain wrote it to the journal |
| `priority`, `intent`, `event`, `exit_type` | Classification stamped at capture or drain |
| `_index_len`, `_preview_len` | How much of the content is indexed and previewed |
| `namespace` (staging only) | The serving namespace, resolved at drain time from the session's annotation |

A captured row does **not** carry: the agent id or agent type, the
working directory, the branch or worktree name, or a namespace tag on
the row itself (namespace is tree membership, not a column on the row).

### 1.4 What a manual row records

A row written through `treecontext_insert` (`source_label = NULL`)
carries whatever metadata the caller passed, plus `_cc_session_id` and
`_cc_session_src` when the server could resolve its own session
(sources: pid, explicit, beacon-unanimous, beacon-ambiguous, echo).

- On the live store: 179 of 234 manual rows carry a session; 55 carry
  none.
- Zero of 234 carry `_namespace`. The server's docstring says every
  insert is namespace-tagged; the serve path never forwards the
  namespace into the server options, so the docstring is wrong and the
  feature file is right. `_namespace` appears on a row only when a
  merge stamps it.

### 1.5 Subagents

Verified live: a subagent spawned by the Agent tool made eleven
`WebFetch` calls, and all eleven rows landed under the **parent's**
session id, in namespace `project`.

- Claude Code's hook documentation says every hook event fired inside
  a subagent carries `agent_id` and `agent_type`. treecontext's
  post-tool-use hook reads only `session_id`, `cwd`, `tool_name`,
  `tool_input`, and `tool_response`, and drops the rest.
- `UserPromptSubmit` does not fire for a subagent's prompt.
  `SubagentStart` and `SubagentStop` are not installed. `Stop` fires
  for the main agent only.
- Subagents inherit the parent's MCP tools, so they talk to the same
  server, the same namespace, and resolve to the same
  `_cc_session_id`. Their manual inserts are indistinguishable from
  the parent's.

Net effect: a subagent's rows can be told apart from the parent's only
by the parent's own `Tool: Agent` row (which holds the prompt in its
input and the final report in its output) and by timing.

A subagent's default search is the parent's search: tree-scoped to
`project`, recency weight 0.5, role weights user/tool/note 1.0 and
assistant 0.25. The query tool has no namespace or agent parameter.

### 1.6 Worktrees

- Claude Code creates linked worktrees under `.claude/worktrees/<name>`.
  The hook's `cwd` is the worktree root.
- A git-bound project resolves to the same remote and therefore the
  same store. A path-bound project is redirected to the primary repo
  root when the worktree signature is genuine (git dir under
  `<common>/worktrees/`, common basename `.git`, back-pointer equal to
  the toplevel). Nothing new is minted.
- Merge-back and worktree removal: treecontext is git-blind. Nothing
  happens and nothing needs reconciling, because the rows were in the
  trunk all along.
- **Gap:** no row records its worktree, branch, or working directory.
  "What happened in worktree X" is unanswerable after the fact except
  by session id and time.
- Documented residuals: bare-repo worktrees do not unify; a worktree
  path-bound before the unification shipped keeps its old store.

### 1.7 Merging a lane into the trunk

`treecontext_merge_from_agent` copies rows with **new** node ids, keeps
`created_at`, stamps `_merge_label` and `_namespace` when absent, marks
the copies read-only, and dedups per class. Two consequences testers
have not yet hit but will:

- Merged rows keep `next_session` and `status = active`, so they
  become trunk resume pointers under ids the subagent never saw.
- A later `supersedes` naming the *source* id does not clear the trunk
  copy. There is no pointer from copy to source.

### 1.8 Forgery and mutability

- Verified: a `treecontext_insert` whose metadata carries
  `source: "auto-capture"` produces a row the store labels as a hook
  capture. The source ladder falls back to caller metadata. Any agent
  with the insert tool can forge a journal row.
- Otherwise rows are append-only from the tool surface. The only
  mutations are `delete`, `clear` (both policy-gated), and the
  `next_session` / `status` flips that `supersedes` performs.

### 1.9 Touch counting

- `relied_count` increments only when a single entry is exported
  under full policy (owner ruling 2026-07-23). It orders session
  eviction and never feeds ranking.
- Queries, conversation windows, and the status panel record nothing.
  "Who read this" is not answerable today.

### 1.10 Platform differences

- On Linux and macOS the hook wrapper `exec`s into node, so the hook's
  parent pid is the Claude pid. Pid-keyed beacons and namespace
  annotations work.
- On Windows the `.cmd` wrapper cannot exec, so the parent pid is a
  per-process `cmd.exe`. The pid rung never fires. Windows relies
  entirely on the session-keyed annotation
  (`session-<uuid>.ns.json`) that the drain publishes from the status
  echo. Verified working; residual: rows staged before the first
  status echo drains carry no annotation and go to the serving
  namespace (only matters on multi-lane installs).
- Windows identity: path comparison normalizes separators and case,
  and uses native realpath to avoid 8.3 short-name mismatches.

---

## 2. What the owner has asked for

These are the needs, recorded in the owner's words in
`features/DOCKET.md` on 2026-09-23 and ratified. A need says *what*
must be true; §3 is one proposal for *how*. Push back on the how
freely; push back on the what if it is wrong for your workflow.

- **N18 (operator, weight 5):** each row stands on its own for
  traceability: who wrote it, when it was written, how it was written
  (journal hook or manual insert), and under what situation (main
  project, subagent, worktree, or any other).
- **N19 (operator, weight 3):** every touch of an entry is recorded,
  searched, read, and by whom, because more data is better forensics
  later.
- **N20 (agent, weight 4):** a subagent can search only its own space,
  its journal and its manual entries, while the whole store stays open
  to it.
- **N21 (agent, weight 3):** when a worktree is folded back, the
  subagent's summary of its work exists and is findable by search.
- **N22 (operator, weight 3):** a group of subagents doing related work,
  such as a cybersecurity set, can be found as a group without each
  being its own namespace.

Two further things the owner said that shape the design:

- Trust is not a concern. This is a local store. If a subagent wants
  to read the whole store, it may.
- It should be relatively difficult to fake a row or to change an
  existing one.

---

## 3. Candidate design

Everything below is labeled *means, to be ruled*. Items already ruled
say so. The shape is deliberately additive: new tables and columns
with an additive migration, no rewrite of existing rows. Revised
2026-09-27 after the first round of beta feedback and the hook probe
(§6); each item ends with the roads not taken, so an objection can name
the alternative it prefers. A design review the same day produced the
fourteen interview items in §5a; where one of them changes an item
below, §5a wins until the owner rules.

### 3.0 The identity levels this design uses

Claude Code already supplies three of the four levels; the store adds
the fourth from configuration.

| Level | Source | Lifetime | Example |
| --- | --- | --- | --- |
| instance | `agent_id` in every hook payload inside a subagent; the session id for a main agent | one spawn | `a46d8a7f7bba07eb2` |
| role | `agent_type` in the same payloads: the `name:` of the agent definition, or `main` | the agent definition | `coder`, `designer`, `Explore` |
| group | a project-level mapping over roles, in config | the project | `documentation = [needs-interviewer, domain-modeler, designer, srs-writer]` |
| session | `session_id`, which is the parent's on every subagent event (verified) | one Claude Code session | |

A new subagent resuming earlier work has the same role and a new
instance id. That is why role, not instance, is the level most scope
questions are really about: a fresh instance has written nothing yet,
and what it needs is what earlier instances of its role wrote.

### 3.1 An agent registry (ruled as the means for N18)

One row per agent lifetime, in its own table.

| Column | Content |
| --- | --- |
| `agent_id` | The instance id (§3.0) |
| `agent_type` | The role (§3.0) |
| `kind` | `main`, `subagent`, `lane`, `merged`, `imported` |
| `parent_agent_id` | The spawning agent, when there is one |
| `session_id` | The Claude Code session the agent ran inside |
| `cwd`, `branch`, `worktree` | Working directory from the payload; branch from one `git rev-parse --abbrev-ref HEAD` at registration, never per tool call; worktree name when the path matches the linked-worktree shape |
| `host`, `platform` | Hostname and OS |
| `first_seen`, `last_seen` | Honest timestamps from hook payloads |

Populated by: `SessionStart` (main agent), `SubagentStart` (subagent;
verified to fire with both ids, §6), the merge path (lane or merged),
and the import path (a store brought in from an isolated environment).
Groups are not stored on the row; they are resolved from config at
query time (§3.6), so a project can regroup its roles without
rewriting history.

Roads not taken: identity columns directly on every journal row (the
row would carry eight columns of repetition per agent instead of one
join key); the session id as the only identity (cannot tell a subagent
from its parent, which is the gap in §1.5); a per-subagent namespace
(the Agent tool cannot launch a server, ruled D124).

### 3.2 Provenance stamped by the store, never by the caller

New columns on `nodes`, written by the store from evidence it holds,
not from caller metadata:

| Column | Content |
| --- | --- |
| `written_by` | `agent_id`, joins to the registry; `NULL` means a writer the store did not mediate, which is itself the signal |
| `written_via` | `hook`, `tool`, `library`, `merge`, `import` |
| `namespace` | The tree's namespace, denormalized onto the row so a row answers alone |

How the stamp gets there without the writer identifying itself:

- Hook rows: `written_by` comes straight from the payload's `agent_id`
  (or the session id for the main agent).
- Curated rows written from inside a subagent: the store's existing
  echo heal already attributes an insert to its session by matching
  the insert's own `PostToolUse` echo; that echo carries `agent_id`
  (verified, §6), so the same heal stamps the instance.
- Merge and import stamp the registry row they mint.

Rules that go with it:

- Caller-supplied keys beginning with `_` are stripped on insert.
- `metadata.source = "auto-capture"` from the tool path is refused
  with an error, not silently relabeled.
- Rows stay append-only. The store gains no update surface. What can
  change on a row stays exactly what changes today: the resume-pointer
  flags via `supersedes`, and deletion under policy.
- Writes made with the sqlite3 command line bypass all of this. They
  land with `written_by NULL`, which is how they are found afterwards.
  The store cannot mediate what it does not see; a project that wants
  a complete record denies the sqlite3 binary through its host's
  permission rules.

Roads not taken: trusting caller metadata with a warning (the forgery
in §1.8 stays possible); a cryptographic signature per row (there is
no key the caller does not also hold, since every writer is a local
process of the same user); refusing library writes without an agent
id (the library is a first-class consumer by charter; it stamps
`library` and no agent).

### 3.3 An append-only access log (ruled as the means for N19)

A separate table, one row per read event.

| Column | Content |
| --- | --- |
| `node_id` | The row touched |
| `reader` | `agent_id` of the reader, or `NULL` when the reader did not identify itself |
| `kind` | `hit`, `window`, `export`, `status` (which of these count is Q3; the recommendation is hits and exports only) |
| `query_hash` | Optional, the query that surfaced it |
| `at` | Timestamp |

Rules:

- The log never feeds ranking and never feeds retention of journal
  rows. The 2026-07-23 ruling that reference frequency stays out of
  ranking is not reopened. `relied_count` keeps its current meaning.
- The log will outgrow the journal. Ten hits with a two-row window on
  each side is up to fifty log rows for one query. The log therefore
  has its own retention: archive then delete by age, the same valve
  shape as the journal, with its own budget. The owner ruled "optimize
  when it appears"; the retention is the floor under that ruling.
- Reads the store does not mediate (the sqlite3 command line, a
  library consumer that opens the file directly) are not logged. This
  is a limit, stated here so nobody reads the log as complete.
- Separate from the registry (two tables, not one) because the
  registry is one row per agent and joins onto rows, while the log is
  one row per read and has its own retention. This is pending ruling
  D128.

Roads not taken: a counter on the row (`touch_count`) instead of a log
(cheap, but loses who and when, which is the forensic value the owner
asked for); logging inside `nodes.metadata_json` (turns every read into
a write of the journal row, and defeats append-only); one combined
table with the registry (different cardinality and different
retention).

### 3.4 Scope on the query tool (ruled as the means for N20; shape revised after round one)

Two new parameters on `treecontext_query`, and the same on
`treecontext_status` for its resume pointers.

**`agent`**: the caller's instance id. A subagent learns it from the
`SubagentStart` hook, which injects one line of context at spawn
(verified, §6): its id, its role, and the instruction to pass the id
on every treecontext call. The main agent learns the same from
`SessionStart`. The id is self-declared and forgeable; the owner has
ruled trust out of scope for a local store.

**`scope`**: `{ level, mode }`.

- `level`: `instance`, `role`, `group`, `session`, `all`.
- `mode`: `only` (a hard filter, nothing outside the level is
  returned) or `boost` (everything is returned, rows inside the level
  rank higher; same mechanism as today's namespace weights).

**Defaults are configured, not chosen by the agent.** The first round
showed two projects wanting opposite defaults (a beta tester's role-based
subagent orchestration platform for software development, called the
orchestration platform below: its own rows;
treecontext: everything), and that agents pick one option set early
and keep it. So:

- A project sets `default_scope` in its config, optionally per role.
- When `agent` is passed and `scope` is absent, the server looks up
  the agent's role and applies the configured default.
- When neither is passed, the caller is treated as the main agent and
  gets `all`. Whether that silent fallback is acceptable, or must be
  reported in the response (`scope_applied: all, agent: none`), is
  interview question I2 in §5a.
- treecontext's own shipped default is `{ all, only }`. A project
  like the orchestration platform sets `{ role, only }` for subagents.

Roads not taken: a required `scope` parameter with no default (a
forced choice is the same nondeterministic pick, one call earlier, and
it hits the main agent too); `all | mine | lineage` as fixed values
(the first-round draft; "mine" as instance is nearly empty for a fresh
subagent, and lineage is one config line away as a group); weights
only, no hard filter (the orchestration platform asked for isolation, not emphasis); a hard
filter only (the owner's concern that a subagent which cannot see the
parent's plan re-derives it).

### 3.5 Capturing the subagent's hand-back (means for N21)

Install `SubagentStop` (verified to carry the full final report, §6)
and capture `last_assistant_message` as a row with
`event = subagent_response`, `written_by` the subagent, role
assistant. This is the subagent's own summary of its work, in the
journal, findable by search, attributed to the agent that did the
work rather than to the parent that read it. A subagent may also
write a curated hand-back node with `treecontext_insert`, which lands
under its own instance id once §3.2 exists.

Worktree fold-back needs nothing further: rows were in the trunk all
along (§1.6). What fold-back gains is `branch` and `worktree` on the
registry, so "what happened on branch X" becomes a filter.

Roads not taken: parsing the parent's `Tool: Agent` row for the report
(it is there today, but attributed to the parent and indexed as tool
output at tool weight); requiring the subagent to insert a summary
(instruction-only rules are the ones that fail).

### 3.6 Groups are configuration over roles, not namespaces (means for N22)

A namespace is one-to-one; group membership is many-to-one. Groups
live in the project's config as a mapping from group name to role
names, resolved at query time. Nothing is written to rows or to the
registry, so regrouping never rewrites history. `metadata_filter`
already covers ad-hoc tags on curated rows for anything finer.

Roads not taken: a `groups` column on the registry (the first-round
draft; it freezes membership at spawn and cannot be corrected later);
row-level tags stamped by the hook (the hook could read the same
config, but a tag on every row means regrouping rewrites history).

### 3.7 Namespaces stay as they are (pending ruling D129)

The owner asked what namespaces are even for. The answer from the
review: they are the hard boundary between *separate processes*
(a second server, a different machine's export, a lane that must not
see the trunk until merged). That boundary is still needed and still
tested. The proposal is to freeze them, extend nothing, and document
them as an advanced, process-level feature. The everyday subagent
case is served by §3.2 and §3.4 instead. No tester in round one uses
them (Q9).

Roads not taken: removing them (the process-boundary case has no other
home); extending them to carry subagent lanes (declined by ruling D124
as too much machinery for this program; independently, the Agent tool
cannot launch a server to produce one).

### 3.8 Merge and import carry a pointer back

The merge stamps `_merged_from_node_id` on each copy, and `supersedes`
learns to chase it, so a supersession named against the source id
clears the trunk copy. The same path serves a store brought back from
an isolated environment (a container or VM, which the owner expects
later): import mints a registry row of kind `imported` with the origin
host, and stamps `written_via = import`.

Roads not taken: stripping `next_session` on merge (loses a real
resume pointer the subagent meant to leave); keeping source ids on
merge (collides when the same lane is merged twice).

### 3.9 A schema document

`docs/schema.sql`, generated from the live schema at build time, plus
a hand-written table of column ownership (which component writes each
column, and whether a caller may). The generated half cannot drift;
the hand-written half is short. Round one: no tester wants it; it
stays on the list as an exemplar artifact for the owner to rule on.

### 3.10 Delete and clear for subagents

Policy tiers are per server. A subagent shares its parent's server and
therefore its parent's tier, including delete and clear under full
policy. treecontext cannot restrict this per agent without trusting
the self-declared id from §3.4. The host can: an agent definition's
`tools:` list decides which treecontext tools a role sees at all, and
a project that locks its agent definitions (as the orchestration platform does) already has
the control. The proposal is to document this in the AGENTS.md block
and change nothing in the server.

Roads not taken: per-agent policy in the server (rests on a forgeable
id); a confirmation token on delete (the parent would just pass it
along).

### What this costs

| Change | Kind |
| --- | --- |
| Registry table, access-log table, three columns on `nodes` | Additive migration, auto-applied |
| Hooks read `agent_id`, `agent_type`, `cwd` from payloads they already receive; one git call at registration | Hook edit, no new permission |
| `SubagentStart` and `SubagentStop` installed | Two new hook registrations |
| `agent` and `scope` on query and status; `default_scope` and `groups` in config | Tool schema addition, default unchanged |
| Forgery refusal | Behavior change for one already-wrong input |
| Access-log retention | New valve over a new table |
| Merge and import stamps | Additive metadata |

No change to search ranking, retention of journal rows, the store
file's location, or the install flow.

---

## 4. What this program does not do

- **Per-subagent MCP servers.** Ruled out (D124). A subagent talks to
  the server its parent talks to.
- **A trust model between agents.** The owner's ruling: local store,
  no trust needed. Forgery refusal (§3.2) is about honesty of the
  record, not access control.
- **Access counts in ranking.** Fenced 2026-07-23 and not reopened.
- **A namespace per subagent.** The Agent tool cannot produce one and
  it would mint one tree per spawn.
- **Removing namespaces.** They stay for the process-boundary case.
- **Dense retrieval, summaries, or any model in the loop.** Unchanged
  from the charter.

---

## 5. Questions for beta testers

Answer any subset. The recommended answer, where there is one, is
marked.

- **Q1. Default scope for a subagent's query: `all` or `mine`?**
  Recommended: `all`, with `mine` opt-in, because a subagent that
  cannot see the parent's plan re-derives it.
- **Q2. What is "my space" to you?** Only rows the subagent wrote?
  Plus the parent's rows? Plus sibling subagents in the same group?
- **Q3. What counts as a touch in the access log?** A search hit, a
  conversation-window neighbor, an export, a status-panel listing?
  Recommended: hits and exports; windows and status are noise.
- **Q4. Is per-reader logging valuable to you, or is a count enough?**
  The owner leans to full logging ("more data is better forensics").
  If you would never look at it, say so.
- **Q5. Group membership: labels on the agent, tags on the row, or
  both?** §3.6 proposes agent labels.
- **Q6. Worktree identity: name, path, or branch?** And is "what
  happened in worktree X" a question you actually ask?
- **Q7. Subagent summary: is automatic capture of the hand-back
  message enough, or do you want the subagent to write an explicit
  summary node?**
- **Q8. Forgery refusal: is there a legitimate workflow where a tool
  insert should be labeled as a capture?** For example importing
  another agent's transcript. If so, it needs an explicit import
  path, not the current fallback.
- **Q9. Does anyone use `--namespace` lanes today?** If nobody does,
  they freeze as proposed.
- **Q10. Should a subagent be able to delete or clear?** Today it
  can, under the parent's policy.
- **Q11. Would a schema document help you?** Or is the feature suite
  enough?
- **Q12. Windows and macOS: did anything in §1.10 surprise you?** The
  Windows path depends entirely on the status echo, and we want to
  know if that has ever failed for you.

---

## 5a. Objections from the design review (2026-09-27)

A reader with no session context was asked to break §3. Fifteen
objections came back; the ones below survived a check against the code
and the probe. Each is an interview item: the owner rules, and the
ruling replaces the corresponding §3 text. Where the fix is obvious it
is named as the candidate; it is still a ruling, not a commitment.

- **I1. The registry row can arrive after the first query that needs
  it.** Hooks write to staging and the drain moves rows later, but the
  handshake tells every agent to call status and query first. So a
  subagent's first `agent` id is unknown to the server. Fall back to
  `all` and a `{role, only}` project leaks the whole store on the
  first call; error and every first call fails. Candidate: the
  `SubagentStart` hook writes the registry row synchronously, the way
  hooks already write staging, and the configured default is keyed by
  kind (`subagent`) as well as role, so an unknown role still gets the
  project's subagent default. The response reports `registry: miss`
  when it happens.
- **I2. Scope is an instruction-only rule, and its failure widens
  silently.** A subagent that omits `agent` gets `all` with no error,
  and the log records reader unknown. Candidate: the response always
  carries `scope_applied` and `agent: none` when the caller did not
  identify; and the query's own `PostToolUse` echo, which carries the
  real `agent_id` and the hit ids, heals the log's reader after the
  fact exactly as the insert echo heals `written_by` today. A declared
  id that disagrees with the echoed one is recorded as a mismatch.
- **I3. The access log can be a drain product, not a server write.**
  Every treecontext_query made from Claude Code is already captured:
  its input (the scope) and its response (the hits, the windows) land
  in the journal through the hook. The drain can derive the log from
  those rows with no write on the query path at all. That removes the
  WAL contention the review raised (a read path that writes serializes
  behind the drain's large zstd and FTS transactions), records the
  scope actually applied and the group definition in effect at the
  time, and gives the log a reference to the captured query row rather
  than a hash. Reads from an MCP client with no hooks would then be
  logged by the server through staging, the same path, so the query
  itself never writes to `nodes`. Rule: derived log, server-written
  log, or both.
- **I4. `written_by NULL` collapses six states.** Legacy rows from
  before the migration, library writes, sqlite3 writes, rows whose
  heal has not drained yet, rows whose echo was dropped, and rows from
  an MCP client that never echoes. Candidate: the migration records
  its boundary (the existing `insert_generation` column already
  separates pre- and post-migration rows); `written_via` separates
  library from sqlite3; and a heal that gives up after the echo window
  stamps `written_by = unknown` with a visible marker, the same
  discipline as `[capture gap]`. What the marker says is the ruling.
- **I5. "Append-only" is not literally true, and the heal is
  asynchronous.** The echo heal is an update. A subagent that inserts
  and then queries `{instance, only}` does not see its own row until
  the drain runs. Candidate: `treecontext_insert` accepts the same
  self-declared `agent` and stamps it at insert; the heal then confirms
  or records a mismatch instead of writing the first value. The text
  in §3.2 changes to "no caller-facing update surface".
- **I6. `general-purpose` is one shared bucket for every ad-hoc
  subagent.** `{role, only}` for an ad-hoc security-audit subagent
  returns every ad-hoc subagent's rows from every session; `{instance,
  only}` returns nothing for a fresh instance. The spawn payload has
  no prompt text. But the parent's own Agent tool echo carries the
  subagent's id, its description, and its prompt, so the registry can
  gain a `label` after the fact, and a parent can pass a group name in
  the description by convention. Candidate: `label` on the registry,
  healed from the parent's echo; `session` level as the isolation
  answer for ad-hoc agents in the meantime. Whether a description
  convention is acceptable is the ruling.
- **I7. The log's retention contradicts both N19 and the never-destroy
  rule as written.** Log rows reference journal rows the valve
  archives and that delete and clear remove; nothing says the log
  travels with the archive. And a log that ages out by time while the
  journal is retained by bytes makes "every touch recorded" silently
  false for old rows. Candidate: log rows are archived in the same
  session archive as the rows they reference, never deleted ahead of
  them, and never cascade-deleted when a journal row is deleted by
  hand. The log has no separate age valve.
- **I8. Merging the same lane twice duplicates its auto-captured
  rows.** Curated rows dedup globally by fingerprint; auto rows dedup
  only inside a five-minute session anchor, so a second merge re-mints
  them. And a bare source node id is ambiguous across lanes. Candidate:
  `_merged_from` is the pair (source namespace, source node id) and
  the merge skips a pair it has already copied.
- **I9. Import needs its own identity ruling.** Whether imported rows
  keep their origin `written_by` (dangling unless the origin registry
  comes too), whether the origin registry and log are carried, and how
  a container seeded from a snapshot of the local store avoids
  colliding registry keys. Candidate: import carries registry and log,
  upserts registry rows by id (a seeded copy is the same agent), and
  sets `written_via = import` only on the registry row, never
  overwriting a row's own `hook` or `tool`.
- **I10. Branch captured once is wrong after a mid-session checkout,
  and `SessionStart` fires again on resume and compaction.** Candidate:
  the hook reads the `.git/HEAD` text file (no subprocess) on each
  fire and stamps branch on the staging row only when it differs from
  the registry's last value, so branch lives on the row where it
  changes and on the registry as "first seen". Registry writes are
  upserts keyed by id, so a repeated `SessionStart` updates
  `last_seen` and nothing else.
- **I11. Renaming an agent definition splits its history.** Candidate:
  an `aliases` map in the same config as groups, applied at query time
  at the role level. Also the ruling on whether a user-level and a
  project-level definition sharing one name are one role.
- **I12. The hand-back summary would rank at a quarter of the weight
  of the parent's copy.** A row with role assistant and no tool name
  lands in the assistant column at weight 0.25; the parent's `Tool:
  Agent` row holding the same text lands in the tool column at 1.0. So
  N21 "findable" is served worse than today. Candidate: rows with
  `event = subagent_response` are indexed as notes (weight 1.0), since
  a hand-back is a summary the agent wrote for a reader, not chatter.
  Dedup between the two copies is unproven either way and is checked
  at build.
- **I13. An exported row does not stand alone.** Who, role, parent,
  branch, and worktree need the registry join, and export of a single
  node carries no registry. Candidate: single-node export and query
  hits resolve the join and return the registry fields inline.
- **I14. Logging hits but not windows answers "did agent X see row Y"
  wrongly.** Window rows are shown to the agent as fully as hits.
  Candidate: log windows too, with `kind = window`, and let the
  question "did X see Y" include them. This reverses the §3.3
  recommendation and stands with the tester's Q3 answer (no opinion).

Two objections were checked and did not survive: that §3.6's reason
for rejecting hook-stamped tags was wrong (it was; the text now gives
the real reason, that regrouping would rewrite history), and that
§3.7's reason for rejecting subagent lanes differs from ruling D124 (it
does; both reasons hold, and the text now cites D124).

---

## 6. Named assumptions about Claude Code

Checked against the official hook, hook-guide, and sub-agent
documentation on 2026-09-23, then verified empirically on 2026-09-25
(Claude Code 2.1.282, Linux) with a throwaway project, a logging hook,
and one subagent spawned by the Agent tool. "Silent" means the docs do
not say; every silent row below is now settled by the probe.

| Claim | Docs | Probe 2026-09-25 |
| --- | --- | --- |
| Every hook event inside a subagent carries `agent_id` and `agent_type` | Documented ("when in subagent") | Confirmed on `SubagentStart`, `PostToolUse`, `SubagentStop` |
| `SubagentStop` carries `last_assistant_message` | Documented | Confirmed; it held the subagent's full final report |
| `SubagentStart` can return `additionalContext` into the subagent | Silent | **Confirmed.** The subagent quoted the injected token verbatim. A spawn-time token is a real channel |
| `session_id` on a subagent's hook events is the parent's | Silent | Confirmed, on every event |
| `Stop` also fires when a subagent finishes | Ambiguous | No. `Stop` fired once at the end of the main turn, with no agent fields. `SubagentStop` is the subagent's terminal event |
| Whose transcript `transcript_path` names on `SubagentStop` | Silent | The parent session's transcript, on every subagent event |

What this settles for the design: the registry can be populated at
`SubagentStart`; hook rows can be stamped `written_by` straight from
the payload; curated rows written from inside a subagent can be stamped
through the existing echo heal, since the echo of the insert call
carries `agent_id`. The one place a subagent must identify itself is at
read time, because an MCP request carries no agent identity. The
spawn-time token is the channel that gives it its id and the
instruction to pass it.

---

## 7. How your feedback enters the process

1. Objections and answers are collected in the thread.
2. The scoping interview resumes with them as inputs. Each ruling is
   recorded in `features/DOCKET.md` with a date, a verified mark, and
   the reason, including yours.
3. Rulings become scenarios in feature files. At build time only the
   feature files bind; this document does not.
4. The program is on the 0.1.0 critical path by ruling D122, with no
   time pressure attached.

---

## Appendix A. Glossary

- **Store:** one SQLite file per project under `~/.treecontext/stores/`.
- **Row / entry / node:** one journaled event or one curated note.
- **Namespace:** a tree inside the store; `project` is the trunk. A
  second server started with `--namespace` writes to its own tree.
- **Lane:** a non-trunk namespace used by a separately launched agent,
  folded into the trunk by merge.
- **Session:** a Claude Code session, identified by the id in every
  hook payload.
- **Agent:** the main agent of a session, or a subagent the Agent tool
  spawned inside it.
- **Capture / journal row:** written by a hook. **Curated / manual
  row:** written by `treecontext_insert`.
- **Resume pointer:** a row tagged `next_session` or `status = active`,
  listed by the status panel at cold start.
- **Drain:** the process that moves staged hook events into the journal.

## Appendix B. Where the evidence lives

- Review findings: journal node `a85c6b3c` (2026-09-23).
- Docket: `features/DOCKET.md`, entries N18–N22, D122–D129.
- Namespace charter: `features/journal-namespaces.feature`,
  `features/journal-session-namespace.feature`.
- Identity: `docs/project-identity.md`, `docs/session-identity.md`.
- Hook payload handling: `src/hooks/post-tool-use.ts`,
  `src/hooks/shared.ts`.
- Merge: `treecontext_merge_from_agent` in `src/server/server.ts`.
