# Working on treecontext

Guidance for coding agents (and humans) making changes to this repository.
If you are a *user* of treecontext, you want [README.md](README.md) instead.

## What this is

A searchable chat-session journal for AI coding agents: a TypeScript
library plus an MCP server that captures a session's events (user
messages, tool calls, assistant turns) and the agent's curated notes into
a flat SQLite store, so a future session can recall prior context at cold
start — replacing context compaction as the recall mechanism and
preserving prompt-cache economics.

Retrieval is lexical (FTS5 BM25, role-weighted). There is no embedder, no
model download, no tree. No native dependency: the database is Node's
built-in `node:sqlite`. Node.js ≥ 24.16.

The design is the **minimum necessary** to honor that charter, and the
minimalism is earned rather than aesthetic: hierarchical summary trees, a
dual-tree promotion pipeline, query fusion, and a tree-sitter code index
were each built, benchmarked against this workload, and deleted.

## The spec is the tests

The living specification is the charter suite in `features/` —
owner-language feature files run by
[gherkin-node-test](https://github.com/bingh0/gherkin-node-test) through
its vitest adapter. Declined scope lives on the fence in
`features/OUT-OF-SCOPE.md`.

**When code and charter disagree, the charter wins.** Feature-file diffs
are owner-review territory — change behavior there first, deliberately,
not as a side effect of an implementation change.

**The verification rule:** a capture or storage claim only counts when it
has been exercised end-to-end — real payloads in, direct SQLite
inspection out. Reading the source is not verification. It covers the
server's own writes as much as the hooks' captures: the recovery
snapshot row (D286) compounded for three releases because the rule was
applied to what came in and never to what the drain wrote.

**Why a green suite can lie.** The review discipline is the failure
ladder, the `cino:` and `blind:` addresses in gherkin-node-test's
[docs/failure-ladder.md](https://github.com/bingh0/gherkin-node-test/blob/main/docs/failure-ladder.md):
hollow green (a scenario that exists and proves nothing) against absent
(a surface no scenario was ever written for). Two rungs this repo has
specimens of: half-lighting, a producer-agnostic promise bound through
one producer only (the bounded preview, D4, reached hook captures and
not the drain's own rows); and a fence that declared a live writer "out
of scope" (the compaction lifecycle, D35, amended by D286). A fence may
decline a promise, never a writer: anything that writes to the store is
in the charter or out of the build.

**Stand-ins live in one place.** Where a binding stands in for a party on
the far side of a door (Claude Code firing the hooks, the model inside a
headless worker, a spawner's library call, the `claude` a version check
reads), it does so through `tests/journal/standins.ts`, whose header says
what each stand-in stands in for, what it may and must never do, and the
plan vocabulary of the two stand-in processes. The helpers carry names
and confinement, not rules. The stand-in guard in
`tests/feature-guards.test.ts` fails on any mention, outside comments and
strings, of a door's own act (`GUARDED_DOOR_CALLS`: the registry's
writers, FlatStore's door methods, `claimTicket`, the door rows' metadata
builders, the echo heal), whether called, bracket-accessed by its name,
`.call`/`.bind`-ed or imported under an alias, in any steps file, journal
harness module or file under `tests/helpers`, and on a plain `insert(`
naming a door's row kind (first-moment, send-back, subagent-summary);
only `standins.ts` and the lines its allowlist names, each with a reason,
are exempt. It does not see a name assembled at run time or a door row
written through raw SQL. The binding state of every beta.3
scenario on the failure ladder, and the review mutations still needing a
scenario, are in `docs/beta3-bindings-audit.md`.

## Architecture

- `src/flat-store.ts` — the journal. Insert/query/export, BM25 + trigram
  search, conversation windows and anchors, session-scoped dedup,
  retention valve (archive → tombstone → delete, never destroy)
- `src/persistence/` — SQLite/WAL layer: schema plus additive migrations,
  role-weighted FTS5 columns, zstd content codec, preview/index split,
  staging table, store lock, backup
- `src/server/server.ts` — the MCP server (official SDK v2,
  `@modelcontextprotocol/server`), 8 tools
- `src/server/cli.ts` — CLI: serve, install/uninstall, doctor, init, hook,
  backup, stores, ccr, export/import (the handoff file's shell door),
  config checkpoint-interval and tool-approvals, run (the ticket door's
  shell door)
- `src/server/ingestion.ts` — drains staged events into the journal
  (honest timestamps, dedup, byte valve, poison dead-letter); stamps a
  captured row's `_writer` from the hook payload's agent fields and runs
  the echo heals (session identity, writer) on `treecontext_insert` echoes
- `src/server/instructions.ts` — agent-facing handshake text; this is a
  charter surface, see `journal-agent-surface.feature`. Two cards over one
  body (D382): every session's, with the session-start routine, and a
  ticket-door worker's, served only where `serve` trusts the worker's lane
  (`trustedWorkerLane`), which tells it to begin from its first message
- `src/server/installer.ts` — agent detection, config writing, AGENTS.md
  block, doctor (one row per documented client: mode, state, remedy); the
  Claude Code hooks block, and its verbatim (Codex) and translated
  (Gemini) copies behind `--experimental-capture`
- `src/server/idle-compaction.ts` — Claude Code's idle-compaction key
  (D290, D304, D338): the version parse and the 2.1.290 / 2.1.302 floors,
  what install does about the key, and doctor's row for it
- `src/server/tool-approvals.ts` — the one approval rule (D381, D390): the
  four tools install approves and the four that keep asking, Claude Code's
  and Antigravity CLI's `permissions.allow` merges (one shape, two rule
  dialects: `mcp__treecontext__<tool>`, `mcp(treecontext/<tool>)`) and
  Codex's per-tool approvals, each beside the
  developer's own rules and never over them, the record of what install
  wrote and of an off the developer chose, and every echo, message and
  doctor clause read from what the client's files decide now, tool by tool
- `src/server/codex-client.ts` — what install and doctor ask the Codex on
  PATH (D381, D387): its version against the per-tool approvals floor
  (0.166.0), its own reading of its configuration for a directory (the app
  server's `config/read`), and on Linux its sandbox check (`codex sandbox
  -- true`) and doctor's row
- `src/server/install-state.ts` — install's own record,
  `~/.treecontext/install-state.json` (D361, D390): what install wrote, so
  uninstall and `config tool-approvals off` take back that and nothing else;
  locked and written atomically, and a record that does not parse is moved
  aside and leaves the approvals unknown, never empty
- `src/handoff.ts` — the handoff door: the import rule (importer's marks,
  `_handoff_claims`, `handoff:` lanes), the export forms (`summaries`,
  `whole`, and a run's `skeleton`), the file's self-describing head, the
  project-directory path rule, the atomic file write; `exportRun`, the one
  door's logic (gate, build, write) under the tool, the shell and the library
- `src/run-export.ts` — a run's export: the skeleton's kinds, the reply's
  first-moments line and the door-line note, and a leg's registration as a
  `leg-registration` row (the facts a claim under `_leg_registration`, read
  back as an imported leg)
- `src/references.ts` — `metadata.refs` references and lanes: the lane key
  supersession respects (`laneOfRow`: the registry's placement of the
  session first; a row with no stamp is main's only where the registry
  never held its session, D379), the writer
  an entry is shown with, and "referenced by" one hop deep
- `src/checkpoints.ts` — chapter summaries and bookmarks, the bookmark
  interval, the /clear session chain, the re-orientation packet, a fresh
  start's self lines for a worktree and the main checkout alike, and its
  other-lanes line (counted, at most three named, never their text)
- `src/persistence/session-registry.ts` — the session registry (self and
  live subagents) and the writer stamp a tool-written row gets at insert
- `src/persistence/leg-registry.ts` — legs and workers on the registry
  (migration 031): run, key and its source, door and identity, the
  checkpointer, the start checkpoint(s), the parent linked or declared,
  a worker's host, process and OS start moment, re-runs, send-backs, how
  a leg ended; the phantom pass any reader of the registry runs; the run
  and key a leg's summary row is stamped with
- `src/persistence/process-probe.ts` — what this host's OS says about a
  process (exists, start moment) for the phantom pass
- `src/run-kinds.ts` — the row kinds a run is made of (checkpoint, brief,
  run-open, run-close, first-moment, the leg's summary) and the rows the
  ticket door writes in a worker's lane (send-back) or the spawner's
  (ticket-refused, identified by its moment), a leaf the dedup identity
  reads
- `src/runs.ts` — a run's reads: checkpoints in effect (an imported
  one's supersedes claim believed), the store's numbering, briefs in
  effect and of a key, a run's open and close, and `RUN_ROWS_SQL`, the
  plain-SQL read-back
- `src/key-lookup.ts` — the key lookup's whole reply, the harness's
  through the library and the agent's through the query tool's
  `key_lookup` mode: the checkpoint(s) in effect, the flag in words, the
  pointer to the writing leg's return, the run's facts, each leg's state
  and the checkpoints it wrote
- `src/ticket.ts` — the ticket a headless worker carries in its
  environment (`TREECONTEXT_TICKET`, one JSON object) and the lane the
  door named (`TREECONTEXT_WORKER_SESSION`): minting, and the one reader
  every door uses, whole, damaged, blank-keyed, keyless or silent
- `src/client-session-env.ts` — the client-session variables the ticket
  door never hands a worker (D389): a named list per client, each name
  with the evidence it was seen, never a prefix
- `src/first-moment.ts` — a leg's first moment for both doors: what it is
  composed from (brief, checkpoint(s) in effect, flags, the predecessor a
  recovery leg recovers), the first message, treecontext's own lines
  (state, not history; invalid instructions; the send-back reason), and
  the metadata and boundaries of the rows the door writes in the lane
- `src/ticket-door.ts` — the ticket door's process half: `spawnWorker`
  (the library spawner; `treecontext run` is the same call), the
  send-back decision, the not-started rule, retirement at exit with the
  summary row, `claimTicket` for a worker with no wrapper
- `src/server/run-command.ts` — `treecontext run`: the ticket from flags,
  `--ticket` or the environment, the worker's stdout passed through, the
  door's one line on stderr, the worker's exit code
- `src/persistence/writer-heal.ts` — the echo heal that sets a
  tool-written row's writer exactly at the drain, and undoes what a wrong
  first stamp did across lanes
- `src/persistence/lane-scope.ts` — the lane read (D376, D374): a placed
  lane's rows (`main`, `worktree:<name>`) read from the session registry
  at query time, as a search scope (its sessions minus helper trails,
  helpers' reports by parent link, its imports, never an `unregistered`
  row) or a writer's trail (the own agent's rows); `placedLaneOf`;
  `placementsOf`, the sessions' placement every pointer reader reads once
  per call (D379, references.ts `laneOfRow`: the registry places the
  session's own agent's row first, the stamp decides otherwise)
- `src/persistence/reference-index.ts` — the `node_refs` reverse index and
  the triggers that keep it
- `src/persistence/curated-index.ts` — the partial curated unique index,
  spelled once
- `src/persistence/metadata-filter.ts` — a metadata filter's flat keys as
  SQL predicates (D268); the rest stays on the pool post-filter
- `src/hooks/` — journaling hooks. Claude Code is the verified reference
  platform; the other adapters are unverified scaffolding. `subagent-start`
  and `subagent-stop` register and retire subagents and are the hooks door
  of a leg (the inference from the role's brief, the first moment under
  the client's 10,000-character cap, the send-back once); `post-tool-use`
  adds the leg's pointer beside the Agent tool's result; `session-start`
  retires a leg left live as cut and makes a `claude -p` child with a
  ticket a worker, never a self; `stop` sends that worker back once;
  `git-self.ts` reads where a session runs (worktree, branch) for its
  registration
- `src/hooks/hook-store.ts` — a FlatStore over a hook's own connection
  (`migrate: false`, at this build's schema only), so the hooks door writes its rows
  with the ticket door's code
- `src/hooks/gap-ledger.ts` — the events a hook could not write while the
  store refused them, kept beside the store; the drain writes each as a
  capture-gap row
- `src/session-beacon.ts` — pid-keyed session identity; on a /clear the
  session-start hook reads the predecessor session from it before
  rewriting it
- `src/persistence/recovery-snapshot.ts` — the recovery snapshot row the
  drain writes after a compaction (D286), claimed only in its own lane
  (D375)
- `src/server/bindings.ts` — project identity → store name
  (`~/.treecontext/bindings.json`, keyed by the git remote or the
  project root; docs/project-identity.md)
- `src/tools/stores.ts`, `src/tools/store-merge.ts` — `treecontext
  stores` (list, rm, prune) and `stores merge`
- `src/server/sidecar-blob.ts`, `src/server/ccr-pane.ts` — the sidecar
  panes written beside the store (journal, threads, trail) and
  `ccr wire`, which lists them in ccr's config
- `src/server/store-audit.ts` — the self-audit queries doctor runs
- `src/server/config.ts` — the TOML config loader (project
  `treecontext.toml` over `~/.treecontext/config.toml`)
- `src/server/agents.ts` — the agent registry install reads (detection,
  config paths and formats, hooks); Antigravity CLI (`agy`, D383) is a
  tools-only entry, detected by its command or `~/.gemini/antigravity-cli`,
  and `~/.gemini` alone stops counting as Gemini CLI where agy's own
  directories are in it (`geminiCliPresent`)
- `src/server/shielding.ts` — output shielding (`--shield-threshold`)

## Design decisions worth not re-litigating

1. **Flat store, lexical retrieval.** FTS5 BM25 with per-role column
   weights (user/note 1.0, assistant prose 0.25, tool output 0.1; D260 amended by D272). Recency fusion is served at 0.25 (D56 amended by D273). Dense retrieval has
   no seat at any tier; if it ever earns one it enters as a fused, opt-in
   second ranked list — see the fence.
2. **Capture is judged by one question:** if a future agent needed this
   moment, is it in the store? No invocation is ever filtered out.
   Repo-reading tool output is trail (bounded preview, re-derivable);
   execution and external output is treasure (kept in full behind the
   preview/index split). Dropped events leave visible `[capture gap]`
   markers.
3. **SQLite/WAL persistence.** Crash-safe writes, concurrent readers.
   Additive migrations auto-run; destructive ones need explicit opt-in.
4. **Retention never destroys.** The byte valve archives whole sessions
   (fsynced before any row moves), tombstones them, then deletes. No
   archive destination → demote but refuse to evict. Only the human
   deletes.
5. **Library first.** Any Node program that opens the SQLite file gets the
   same journal; the MCP server is one consumer, not a gatekeeper.

## Build and test

```bash
npm install
npm run build
npm test          # the full test suite + the charter suite
npm run lint
npm run typecheck
```

Run the server directly during development:

```bash
npm run serve                       # stdio transport, from source
node dist/server/cli.js doctor      # after a build
```

## Code style

- TypeScript strict mode, ES2022, ESM
- Named exports only, no default exports
- Type annotations on all public functions and interfaces
- Logging to **stderr** — stdout is reserved for the MCP stdio transport
- Vitest for testing

## Things to watch for

- A run's open or close row written through the tools while the writer
  stamp was not exact (provisional, concurrent, ambiguous) names nobody:
  `_by_src` is `pending` until the call's echo heal sets `opened_by` /
  `closed_by`, the line, and an inner run's parent leg. Never fill them
  from the insert-time stamp; `_by_src` `caller` marks a `by` taken from
  the caller's metadata when no stamp could be read at all
- Content in `nodes.content` may be zstd-encoded — decode with
  `persistence/content-codec.ts`, never assume plain text
- `metadata.created_at` is the event's moment; `ingested_at` is the
  drain's. Honest timestamps are what make temporal recall trustworthy
- Tree-era stores (embedding blobs, `backend_mode='tree'`) still open, but
  refusal is loud and read-only — never "migrate" one silently
- Persistence still round-trips tree-era embedding blobs so old stores stay
  readable; that code is deliberate, not dead
- `_writer` and `_writer_src` (and the rest of `WRITER_STAMP_KEYS`) are
  stamped by the store, never trusted from a caller: the insert tool drops
  a caller's copy, as it drops caller `_handoff_*` keys
- `_over_cap` (in `WRITER_STAMP_KEYS`, and a handoff claim on import) is the
  store's mark `{size, cap, second}` on a checkpoint accepted past the
  16000-character cap (D321); the cap counts code points with `charactersOf`.
  A refusal lives in `session_registry.cap_refused`, on an exactly named
  writer's registration; made under a non-exact writer stamp it is `pending`
  with its candidates until the call's echo (carrying `refusal_id`) moves it
  to its writer, in `cap-refusals.ts`. A writer with no registration is never
  refused, and the store keeps no refusal ledger outside the registry (D359)
- Imported rows live in `handoff:` lanes (`session_id` =
  `handoff:<claimed session>`); the file's identity claims sit under
  `_handoff_claims`, never at the top level
- The ticket door writes a worker's first moment and a re-run's message
  as the worker's capture (`source` auto-capture, in its own session), so
  the valve reaches them; what a run printed is not a row; its
  summary row is agent-authored, and a summary naming its run is a run
  row (`RUN_ROW_KINDS`), never deduplicated by its text. Never let a
  door row count as the worker's own write: a damaged ticket's worker is
  retired `invalid` when its first row of its own lands
  (`DOOR_ROW_KINDS` in flat-store.ts)
- A worker's lane is its whole session; the door hands the session to the
  worker in `TREECONTEXT_WORKER_SESSION` and `serve` stamps tool rows into
  it, but only through `trustedWorkerLane`: the registration there must be
  the one the ticket in the same environment describes. Never honour the
  variable alone. The door spawns a worker as its own process group and
  signals the group. A door that cannot write the store at a worker's exit records
  nothing and leaves the leg for the phantom pass: never retry that
  write, never guess an exit moment
- Platform events still stage (hook → staging → drain). The hooks door
  is the one place a hook writes journal rows directly: a leg's own rows
  (registration, the run's open, first moment, send-back, summary),
  through the library via `hook-store.ts`, in one transaction with the
  registration fact they belong to; never a migration, never at another
  schema than this build's (that, too, is recorded as a gap). What a
  hook cannot write goes to the gap ledger, never silently away (D314)
- The hooks door reads a role's briefs from the session's resolved
  namespace only; every namespace only when it does not resolve (the
  multi-agent story is namespaces of one store)
- A background Agent launch (`status: "async_launched"`) carries no
  pointer: its return is the platform's task notification
- A leg's key asks for a checkpoint at its stop only when it is the leg's
  own or declared, never inferred (D326); the stop hook settles it from
  the leg's own staged echoes first, the drain's rule, so the race with
  the drain cannot decide
- A `claude -p` child's captured rows land in its worker's lane at the
  drain (`workerLaneOf`: its own session, or the lane `client_sessions`
  links); the echo heals skip them, the lane's stamp being exact
- The retention valve reads a row's *kind* as well as its label
  (`isProtected` in `src/flat-store.ts`, `isRunAuthored` in
  `src/run-kinds.ts`): a run's own rows and a `subagent-summary` that names
  its run are never evicted or demoted although the drain labels a
  SubagentStop report `auto-capture`; a plain subagent's summary (no run)
  stays capture, as before. A leg's `first-moment` and `send-back` rows are
  the door's capture, evicted with their session and demoted in the
  tool-bulk class (`isDoorCapture`), not with user text, whatever `role`
  they carry
- The curated unique index is partial: `dedup_class = 'curated'` outside
  handoff lanes (`CURATED_INDEX_WHERE`). Inside a handoff lane identity
  decides, not content; any rebuild must reuse the shared DDL
- A pointer's lane is the registry's placement of its session first
  (`placementsOf`, read once per call), the writer stamp only where the
  registry places the session nowhere (D379, `laneOfRow`). A row with no
  stamp is main's only when the registry never held its session (the
  pre-stamp era); one whose session it holds but places in no checkout
  (a ticket-door worker's) is "writer unknown", never main's. Never decide
  a lane from `_writer` alone: a library row with no stamp in a worktree's
  session is the worktree's. The search's own-chapter seat reads the same
  lane; the search's scope does not
- A recovery snapshot is claimed only by a session of the lane it was
  written for, and its row is written in the claiming session (D375,
  `recovery-snapshot.ts`); a snapshot whose session the registry does not
  hold is claimed by no one
- A search by a session's own agent placed in a checkout is scoped to its
  lane (`QueryOptions.lane`, read from the registry, D374); the lane's
  one-hop reach is read once per search and shared by the hits and every
  window. A scoped relevance page keeps a seat for the lane's own live
  chapter the search matched (`seatOwnChapter`): the last place, never
  first by rule. A worker of the ticket door, a caller that cannot be told
  apart (D240) and an unplaced caller search the whole store, the reply's
  `scope` saying which
