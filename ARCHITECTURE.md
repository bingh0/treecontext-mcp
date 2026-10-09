# treecontext — architecture

*How the system hangs together: the processes, the data flow, the
concurrency model, and the assumptions that are load-bearing. The
"why" is [features/DESIGN.md](features/DESIGN.md); the promises are the feature corpus;
this document owns the **interactions** — the cross-cutting properties
no single subsystem document is responsible for, which is where late
surprises hide. Written 2026-08-15, at the v0.1 release candidate, and brought up to
the code as built at 0.1.0-beta.1 (2026-10-08);
subsystem deep-dives are linked where they exist and this file defers
to them for their internals.*

## 1. Process topology

Everything is short-lived or session-lived; nothing daemonizes.

```
agent host (e.g. Claude Code)
 │
 ├─ MCP server ──── tc-mcp-serve wrapper ── exec → node cli.js serve
 │                  (one per session; stdio; exits on stdin EOF)
 │
 ├─ hooks ───────── tc-<event> wrappers ─── exec → node cli.js hook <event>
 │                  (one process per fire: session-start, pre-compact,
 │                   post-tool-use, user-prompt-submit, stop,
 │                   subagent-start, subagent-stop)
 │
 └─ user shell ──── treecontext <cmd>  (install, doctor, backup, stores,
                                        export, import, config, …)

library consumers ─ FlatStore.open()  (no server, no hooks, same store)
```

- **Wrappers** (`~/.claude/hooks/tc-*`, written by `install`): resolve
  a verified node interpreter, then `exec` the CLI. Hook wrappers
  discard stderr (the host surfaces it as user-facing noise); the MCP
  launcher deliberately does not (the client shows it, and hiding it
  once cost weeks of "Connection closed" debugging). See
  `docs/hooks/architecture.md` for the hook subsystem in depth.
- **Hook fast path** (`cli.ts`): a hook invocation is `argv[2] ===
  'hook'` — one spelling, dispatched before argument parsing and
  before any config load, ringed so **no hook path can exit non-zero**
  (a hook exit code is agent-facing; capture may be lost for a reason,
  never for a formality). The dispatcher lives in its own leaf module
  (`server/hook-dispatch.ts`) so hook spawns don't import the
  installer graph.
- **The agent surface** install also writes: an eighth script,
  `tc-session-reminder` — a static orientation heredoc on
  SessionStart, not a dispatcher event (the other seven are) — plus the
  reference skill and
  the AGENTS.md instruction block. Together they are why a
  cold-starting agent calls `status`/`query` before doing anything
  else; the parts the agent reads are spec'd in
  `journal-agent-surface.feature`.
- **The hook block** install writes into `~/.claude/settings.json`
  (`applyClaudeHookBlock`, `server/installer.ts`): SessionStart on the
  `startup`, `resume`, `clear` and `compact` matchers (reminder, then
  session-start), PreCompact, PostToolUse, UserPromptSubmit, Stop,
  SubagentStart and SubagentStop. The same block is copied verbatim into
  Codex CLI's `~/.codex/hooks.json` and, translated to Gemini CLI's
  event names (no Stop, no subagent events), into
  `~/.gemini/settings.json` — both only behind `--experimental-capture`.
  VS Code and Cursor read the Claude settings file as-is and get
  nothing written; doctor gives each documented client a row naming its
  mode, the state found and the remedy. Installs from before
  0.1.0-beta.1 lack the subagent events and the clear/resume wiring
  until `treecontext install` is re-run.
- **The serve open sequence** (order is load-bearing): open db →
  fresh-store base schema if brand new → run the migration ladder →
  delete pre-0.1 lockfile remnants → acquire leases → start the MCP
  server (which re-runs migrations as a no-op) → on stdin EOF /
  signal: release leases, sweep the shield dir, close.

## 2. Data at rest

```
~/.treecontext/                       0700
├── stores/<name>/treecontext.db     0600  the journal (one per project)
│   ├── …db-wal / …db-shm                  WAL siblings (same treatment)
│   ├── …db.pre-migration-v<N>.bak         migration backup + .verdict.json
│   ├── sessions/pid-*.json                session beacons + ns annotations
│   ├── archive/*.json                     retention archives (pre-delete)
│   ├── sidecar.json / -threads / -trail   display panes, rewritten per
│   │                                      drain by the drain owner ONLY
│   └── query-telemetry.jsonl              ONLY if opted in
├── bindings.json                          project → store-name map
├── config.toml                            written by install
├── shield/                          0700  shielded oversize responses, 0600
└── logs/debug-*.log                 0700  diagnostics (no message bodies)
```

Full trust contract: [docs/security.md](docs/security.md). The rule of
thumb: everything the tool writes under `~/.treecontext` is
`0600`/`0700`; outside it the hook and launcher wrappers are `0755`
(executable) and the ccr pane config is `0644` beside its siblings;
nothing leaves the machine, and the two sharing surfaces (`doctor --dump-logs`, doctor's
crash excerpt) redact the home directory as they print.

## 3. Store selection: the bindings ladder

Store choice must not be hijackable by repository contents (a hostile
checkout must not redirect capture into someone else's store), so it
keys on **project identity**, resolved outside the repo
(`server/bindings.ts`):

1. Identity = git remote URL when one exists (every clone and worktree
   of a remote shares one store), else the realpath of the project
   root. Fingerprint = truncated SHA-256.
2. `bindings.json` maps fingerprint → store name. Miss → one-time
   legacy sticky-file migration, else a derived name (git slug, or
   basename+hash), written through.
3. **Preserve, never clobber** (ruled 2026-08-15): the file is
   machine-wide state rewritten by background hooks, so a corrupt or
   unknown-version file is side-filed to `bindings.json.corrupt`
   before any rewrite, a symlinked path is refused for reading *and*
   writing, loaded values are re-validated with neighbors surviving,
   and a read *error* (EACCES/EMFILE) is not corruption — it earns no
   rewrite at all. Read-only surfaces (`backup`, doctor) use a lookup
   that never writes and also sees an unmigrated sticky.

Pinned in `features/design/store-bindings.feature`.

## 4. The capture pipeline

```
platform event ─ hook (per fire) ─▶ staging table ─▶ drain ─▶ nodes
                  8s db budget        (letterbox)     (one owner)
```

- **Hooks** parse the platform payload, compose the event text (a
  prompt or response as written; a tool event as a preview, input cut
  at 500 chars and output at 1000, followed, when a cut fell on
  execution or external output, by the full input and output as a
  tail; every row capped at the 262144-char store safety cap), resolve the
  store via the bindings ladder, stamp the session's namespace (see
  §8), and write one `staging` row. The ANSI strip and the 10k-char
  hard cap apply to the session-start rehydration text, not to
  capture. From v27 the row
  also carries the payload's `agent_id`/`agent_type` (a subagent's call)
  and a row `kind`; a hook meeting an older store falls back to the
  earlier column list. Hooks never touch
  `nodes`; the staging insert is their capture write. Beside it they
  write the session registry (`session_registry`: the session-start
  hook registers the self and retires live subagents, SubagentStart and
  SubagentStop register and retire a subagent), `store_config` (the
  /clear session link, the once-a-day nudge mark, the stop hook's
  bookmark ask) and `snapshots` (pre-compact writes one, session-start
  claims it). Every hook write is budgeted at 8s (`HOOK_DB_TIMEOUT_MS`,
  kept strictly under the platforms' 10s hook kill budget) through the
  one shared opener.
- **The drain** (`server/ingestion.ts`, run only by the drain-lease
  owner): claims staging batches atomically
  (`claimStagingBatch`, claim TTL 120s — a second drain is *safe*,
  merely wasteful), decodes, dedups, and inserts into `nodes` in each
  row's stamped namespace at its **capture** timestamp, not drain
  time. A row naming an agent is stamped `_writer` (its role) and
  `_writer_src: "hook"` here; an echo of `treecontext_insert` also runs
  the session and writer heals (§8). A row failing 3 attempts is dead-lettered as a `[capture
  gap]` node carrying a content prefix — never silently dropped. A
  staging byte valve (512MB) drops whole oldest sessions, tombstone
  first; if the tombstone cannot be written, nothing is dropped.
- **Dedup is the store's job** (G2): auto-capture dedups per
  (tree, session, fingerprint) within a 300s capture-time window via
  the `dedup_anchors` table; curated inserts dedup per namespace via a
  partial unique index on `(tree_id, fingerprint)` with `ON CONFLICT`
  refusal. The index leaves handoff lanes out (migration 025,
  `persistence/curated-index.ts`): an imported entry is present or new
  by identity — its id held in any lane, or named by any lane's
  `_merged_from_node_id` — and by content only when the file carries no
  id. No process-local
  maps; every writer inherits both rules.

Charter promises: `journal-capture.feature`; mechanics:
`ingestion-fidelity.feature`, `tool-event-fidelity.feature`.

## 5. The recall path

`treecontext_query` → FTS5 BM25 over the index column, with:

- **Role weights** (user/assistant/tool/note columns, tunable per
  query), **temporal filters and orderings**, **adaptive result
  counts** (score-distribution break detection, disclosed in the
  response), and **recency fusion** (reciprocal-rank fusion of the
  BM25 ordering with capture-time ordering; serving default 0.5,
  explicit 0 opts out).
- **Conversation windows**: each hit can carry its same-session
  neighbors plus the nearest preceding user message — the fabric that
  makes single-hit recall readable.
- **Reliance recording**: single-entry exports bump a monotonic
  `relied_count` (column is the truth; metadata copy heals upward),
  which retention uses to evict the least-relied-on history first.
  Ritual fetches (current resume pointers) and read-only rows are
  deliberately excluded from the meter.
- **Media references**: an entry can carry a `mediaRef` (URI, MIME
  type) alongside required descriptive text — the description IS the
  recall surface in a lexical store; a bare URI would be unfindable by
  every search mode. `journal-media.feature`.
- **References, one hop deep**: an entry names what it answers in
  `metadata.refs`; the store keeps the reverse index `node_refs`
  (migration 026, maintained by triggers on `nodes`, so every writer
  keeps it unaware). Search hits and a fetch by id carry
  `referencedBy` — the count of referrers in the entry's own namespace,
  and one referrer's id, writer, age and first line (80 characters),
  the newest from another lane when there is one — never the referrer
  in full, never its own referrers. `references.ts`.
- **Lanes**: supersession retires only targets in the inserting
  writer's own lane (an imported entry's `handoff:` session key, else
  the store-stamped `_writer`, else `agent_type`, else the main lane;
  an `ambiguous` stamp owns none). A target in another lane is left as
  it was and becomes a reference instead.
- **Handoff files** (`handoff.ts`): `treecontext_export` without a node
  id is a handoff — `form: "summaries"` by default (live chapter
  summaries and `subagent-summary` rows), or `"whole"`, which first
  returns a secrets warning and writes only when called again with
  `secrets_acknowledged: true`. With `path` the server writes the file
  itself, uncapped, atomically (temp file, fsync, rename); inline, the
  newest 10000 at most (`INLINE_EXPORT_CAP`), with the omitted count.
  Each file opens with its head (`exported_by`, `exported_at`,
  `project`, `treecontext_version`, `holds`, `to_import`, `form`, …).
  Paths are held to the project directory the server was started for
  (`--project-dir`, `TREECONTEXT_PROJECT_DIR`, the working directory),
  resolved through existing links; `..`, a link as the file, anything
  under `.git`, and overwriting a file that is not itself a handoff are
  refused. `treecontext_import` takes `path` or pasted `data` with a
  `label`; every landed entry is marked by the importer (`_handoff_file`,
  `_handoff_importer`, `_handoff_imported_at`, `_handoff_sender`), the
  file's identity and pointer claims move under `_handoff_claims`, and
  it lands in a `handoff:<claimed session>` lane, keeping the sender's
  `created_at`. `treecontext export <path> [--whole --yes]` and
  `treecontext import <path>` are the same doors from a shell.
  `journal-handoff.feature`.
- **Checkpoints and the /clear packet** (`checkpoints.ts`): a chapter
  summary is a `next_session` pointer, a bookmark the same with
  `kind: "bookmark"` (ranked at 0.25). The Stop hook asks once for a
  bookmark when the interval passes (default 20 rounds or 45 minutes,
  per store via `treecontext config checkpoint-interval`, kept in
  `store_config`). After a `/clear` the session-start hook emits a
  packet under 3000 characters built from the session's chain of ids
  across clears. `journal-reorientation.feature`.
- **Output shielding** (opt-in): an oversize query/export response is
  written to `~/.treecontext/shield` (0700/0600) and replaced by a
  file reference; `status` is unshieldable by construction; a shield
  write failure returns the response inline rather than destroying it.

Charter: `journal-recall.feature`, `journal-search-modes.feature`;
shielding: `output-shielding.feature`.

## 6. The storage engine

One SQLite file, WAL mode, `busy_timeout` 10s, **immediate
transactions by default** (contention waits at BEGIN instead of
failing mid-write). Highlights:

- **Namespaces are rows in the `trees` table**; every node belongs to
  exactly one, every query is tree-scoped, and crossing the boundary
  is always an explicit act (`merge_from_agent`, provenance-stamped) —
  isolation by construction, not by filtering.
  `journal-namespaces.feature`.
- **`nodes`** carries the arbiter columns (`fingerprint`,
  `dedup_class`, `session_key`, `relied_count`, boundary columns) —
  computed at the single write choke point from the node's own fields,
  identity by construction. Content ≥512B is zstd-compressed with a
  flag byte; a zstd-less runtime (Node 22.0–22.14) degrades readably.
- **Index/preview split**: FTS indexes a bounded index text; the full
  content stays in the row. C4 tool tails are index-invisible but
  window-recoverable.
- **Retention valve** (runs synchronously every 50th insert, under
  `sweep:<ns>` lease): hard bounds — 100 sessions / an entry safety
  net of 200 auto entries per configured session (20k at the default
  cap; an explicit `maxAutoEntries` keeps its figure) / 128 MiB content
  bytes (D141, D255; the session cap and the byte budget are set per
  project in the config file's `[retention]` table, §9). Order: archive the victim session
  to disk (fsync) → tombstone → delete, atomically per session; then
  demote oversized tool bulk back to its index text (archiving tails
  first); then VACUUM at ≥25% dead space. The valve **refuses to evict
  what it cannot archive**, never touches the newest session, and
  never fragments a session. `journal-storage.feature`,
  `retention-demotion.feature`.
- **Migrations**: a versioned ladder (currently v27: 025 makes the
  curated unique index partial over handoff lanes, 026 adds the
  `node_refs` reverse index with its triggers and backfill, 027 adds
  `session_registry` and staging's `agent_id`/`agent_type`/`kind`; all
  three additive). Any pending
  migration, additive or destructive (D59, D256), copies the store
  aside first (`VACUUM INTO`) and records a **verdict** at
  completion while backup and store are still twins; doctor lists
  every backup with its verdict, and `stores sweep` reclaims only
  verified ones. A brand-new store gets the base schema (v5) before
  the ladder. The ladder re-checks the schema version under the write
  lock, so concurrent servers cannot silently replay a backfill.
  `features/design/backup-{lifecycle,sweep,visibility}.feature`.

## 7. Concurrency: the store as arbiter

Design: `tests/server/design/store-as-arbiter.md` (authoritative).
The shape:

| Role | Lease | TTL | Held by |
| --- | --- | --- | --- |
| Namespace primary claim | `ns:<namespace>` | 90s | at most one server per (store, namespace); others serve without it |
| Capture drain | `drain` | 60s | one per store, re-contested per tick |
| Retention sweep | `sweep:<ns>` | 300s | taken at sweep fire, released after |

- Leases are rows in the store: heartbeat-TTL liveness, no lockfiles,
  no PID probing. A crashed holder frees its roles within one TTL.
  Since amendment 8 (`store-as-arbiter.md` §8, 2026-08-20), a second
  same-namespace server serves alongside the holder without the claim
  instead of being refused — the refusal is machinery now, not a gate:
  the drain role re-contests per tick and absorbs it (a skipped tick,
  "standing by" at serve startup), and `stores merge` is the one place
  `StoreLockedError` still surfaces to a caller. Re-acquiring your own
  role *is* the heartbeat; the
  serve process also renews on a 20s timer.
- **Correctness does not depend on the leases.** Dedup constraints and
  atomic staging claims make concurrent writers safe at the SQL layer.
  The leases buy efficiency and visibility: one drain per store, one
  sweeper per namespace, and a namespace's primary claim (`ns:<ns>`),
  which gates no tool call — it serves doctor's view of who holds the
  namespace, clean-exit release, and corroboration of the hook
  ladder's pid rung. Losing one degrades service, never data.
- A sweeper that loses `sweep:<ns>` mid-sweep **aborts** (checked per
  victim, before demotion, before the shrink commit). The store calls
  a `maintenanceHeartbeat` before its long synchronous phases (sweep,
  VACUUM) so the event-loop-blocked renew timer gets the full TTL of
  headroom. *Known residual*: a single synchronous phase exceeding its
  TTL can still starve a lease — accepted for 0.1, documented here.

## 8. Session identity and namespace attribution

Two problems, one file (`session-beacon.ts`): *which session produced
this event* (beacons: `pid-N.json`, written by hooks, resolved by a
pid → freshest-beacon ladder) and *which namespace should it drain
into* (annotation: `pid-N.ns.json`, written by the server, read by
hooks). Both bridge processes via `process.ppid` — which assumes the
wrappers `exec` into node.

**Known limitation**: that assumption fails where wrappers cannot exec
— measured on Linux for the beacon rung (hooks' parent is an ephemeral
shell), structural on Windows for the namespace annotation (`.cmd`
runs under per-process `cmd.exe`; attribution resolves null and rows
drain into the serving namespace). The ratified **session-identity
v2** (echo-correlated identity, `docs/session-identity.md` §7)
landed 2026-08-15, before the rc, and added the echo beside the pid
bridge rather than replacing it: the pid rung stays in the ladder, and
since 2026-10-08 install writes each POSIX hook command as `exec`
(D251), so the hook's parent is the agent's own process and the rung
matches where `/bin/sh` is dash; that document records what remains
platform-bound on Windows.

### Writer identity (0.1.0-beta.1)

An orchestrating agent and every subagent it spawns share one Claude
Code session id and one server connection, so the transport never says
who is speaking. The store stamps the writer instead
(`persistence/session-registry.ts`, `session_registry`, migration 027):

- The session-start hook registers the session's **self** on every
  start — worktree (a linked worktree's directory name, none for the main
  checkout), branch, directory, git top level and common dir, read by
  `hooks/git-self.ts` — and on every source but `compact` retires any
  subagent still live under the session. SubagentStart registers a
  subagent (`agent_id`, `agent_type`) under the parent's session id;
  SubagentStop stages its report as kind `subagent-summary` and retires
  it.
- **Captured rows** take `_writer` from the payload's agent fields at the
  drain (`_writer_src: "hook"`); a row naming none is the session's own
  agent's.
- **Tool-written rows** are stamped at insert from the registry
  (`resolveWriter`): `self` when no subagent is live (`main`, or
  `worktree:<name>`); `concurrent` (the self) when a subagent is live
  but a hook saw the session's own agent after the oldest live subagent
  started; `provisional` (that subagent) when exactly one is live and the
  session's own agent has been silent; `ambiguous` (the self with the
  candidates, owning no lane) when several are; `unregistered` (no
  writer) when the session is unknown. The insert reply names the writer
  and, for the guesses, a `writer_note`. A caller's own copy of any stamp
  key is dropped.
- **The echo heal** (`persistence/writer-heal.ts`): at the drain the
  insert's own PostToolUse echo, which carries the caller's agent fields,
  sets the writer exactly (`_writer_src: "echo"`) — only on a row that
  call created, of the echo's session or of none, within 60 s
  (`ECHO_HEAL_WINDOW_SECS`). When that moves the row to another lane, what
  the first stamp did across lanes is put right: pointers it retired that
  the new lane does not own are restored (from `_superseded_prior`) and
  become references; a retirement it suffered from another lane is undone
  and recorded as a reference on the retiring row; supersessions it could
  not perform (`_supersedes_referenced`) are performed if the new lane
  owns them; a restored bookmark stays retired when its lane already has
  a newer live one. Every act is listed in `_writer_heal_note`.
- **Readers**: the /clear packet ignores rows naming a subagent's agent
  id (`NOT_SUBAGENT`); a fresh start in a linked worktree opens with that
  worktree's own newest chapter and the entry whose `brief_for` names it;
  status in a worktree lists its own lane's pointers; a `provisional`
  caller's search is scoped to its role's trail and the plan it was
  spawned under. `scope: "all"` widens either. `treecontext_export` with
  `writer` reads one writer's trail.

*Known residuals*: until the echo drains (one ingestion tick, about five
seconds) a row stamped wrongly at insert acts in the lane it was guessed
into, and a read in that window shows it so; an echo that never drains
leaves the insert-time stamp, disclosed by its `_writer_src`; a subagent
whose stop never arrives stays live until its session starts, resumes or
clears; an install predating the two subagent hooks registers no
subagent; and the order in which Claude Code delivers the Agent tool's
own PostToolUse and SubagentStart for a background spawn, which the
`concurrent` rule relies on, is a live-platform probe still owed (with
the order reversed the orchestrator's next insert is `provisional` and
set right at the drain). `journal-orchestration.feature`.

### The session chain across /clear

A `/clear` mints a new session id. Before rewriting the pid beacon, the
session-start hook reads the id it still names and records the link in
`store_config` (`session_chain:<id>`); the packet, the bookmark interval,
bookmark supersession and the nudge mark all walk that chain. With no
beacon to name the predecessor, the packet says so rather than claiming
no checkpoint exists.

## 9. Configuration

Precedence: **CLI flag > TOML config > defaults**, applied only for
keys the CLI didn't explicitly set. Discovery, first match wins:
`--config <path>` (must exist; missing value is a parse error) →
`$TREECONTEXT_CONFIG` (skipped if missing — it participates in
discovery) → `./treecontext.toml` → `~/.treecontext/config.toml`.
Wrong-typed or out-of-range values are dropped, never fatal; an
*unparseable* file fails `serve` loudly but never the commands that
exist to fix it (`doctor`, `install`) nor hooks (which read no config
at all). Install treats the file as the user's: explicit values are
never flipped, skipped files keep their comments, corrupt files are
side-filed before replacement. `config-file.feature`.

Retention keys (D141), config-file only — no flag shadows them:

```toml
[retention]
max_store_bytes = 268435456   # the byte budget; default 134217728 (128 MiB)
max_sessions = 200            # the session cap; default 100
```

The project file is discovered in the project directory the store
binding resolves — the primary repository root, else the nearest `.git`
ancestor, else the directory itself, starting from `--project-dir`,
`$TREECONTEXT_PROJECT_DIR` or the cwd — so a server started from a
subdirectory reads the root's file. Discovery is first match, whole
file: a project with its own `treecontext.toml` never reads the global
file's `[retention]`. Each key must be a positive whole number; anything
else is dropped with a stderr line naming the file and key. The serve
path passes both to every store handle it opens (the serving one and
each drain-side namespace handle); the entry safety net follows the
cap. `stores merge` and `import` take neither: they never sweep. The
over-budget storage warning names `[retention] max_store_bytes`.

## 10. Failure philosophy

| Surface | On failure |
| --- | --- |
| Hooks | **exit 0, always**; reason to the debug log. Capture loss is logged, never user-facing. |
| serve | loud, exit 1; fatal logged with full fidelity before the (redacted) stderr line |
| doctor | always completes its report; exit 0; findings carry their fix command |
| CLI refusals | exit 1 (parse/validation), exit 2 (partial completion: `stores sweep`, `stores rm`, `stores prune`; dead install path: --npx) |
| Ingestion | bounded retries → dead-letter with tombstone; poison cannot wedge the drain |
| Retention | refuses rather than risks: no archive dir → demote-only; tombstone refused → nothing dropped |
| Shield/telemetry/reliance | best-effort instruments; their failure never fails the operation they observe |

Debug logs (`~/.treecontext/logs`, 5 files × 2MB): paths, names, byte
counts, tool tags — **never message bodies** (a pinned invariant,
`debug-log-sharing.feature`). Redaction happens at the sharing
surfaces, not in the record.

## 11. Platform assumptions (the load-bearing ones)

- **Wrappers exec on POSIX; they cannot on Windows** — feeds the §8
  limitation. Windows capture works; per-session *namespace
  attribution* has the bounded residual `docs/session-identity.md`
  records.
- **File modes exist on POSIX only**; Windows relies on profile ACLs.
  Mode assertions are POSIX-only tests, visible skips, never silent
  passes — and mode tests pin the umask, since a 077 machine makes a
  dropped `0600` invisible.
- **POSIX rename replaces; Windows refuses an existing destination** —
  every side-file site unlinks first.
- **Unlink-while-open**: POSIX allows it, Windows does not — why every
  test closes its stores, and why the full-matrix Windows lane is a
  release gate (it has caught real defects three releases running).
- **The interpreter is probed, not assumed**: install pins a node that
  demonstrably loads the native sqlite binding; doctor grades the
  pinned interpreter, in both shell dialects.

## 12. Invariants index

The cross-cutting invariants, each with the corpus location that pins
it — the table to extend when a new one is ruled:

| Invariant | Pinned in |
| --- | --- |
| No capture filtering; gaps leave tombstones | `journal-capture.feature` |
| Nodes carry capture time, not drain time | `ingestion-fidelity.feature` |
| Dedup enforced in-store for every writer | `store-as-arbiter.feature`, `flat-store-dedup.feature` |
| Archive before delete; refuse eviction without archive | `journal-storage.feature`, `retention-demotion.feature` |
| Newest session never evicted; sessions never fragmented | `journal-storage.feature`, `ingestion-fidelity.feature` |
| Hook exits never non-zero | `hook-dispatch.feature` |
| bindings.json preserved, never clobbered | `store-bindings.feature` |
| User's config never flipped, never destroyed | `config-file.feature` |
| Migration backups verdicted while twins; sweep deletes only verified | `features/design/backup-lifecycle.feature`, `features/design/backup-sweep.feature` |
| Uninstall reverses wiring, never the record | `journal-install.feature` |
| No message bodies in logs; redact at sharing surfaces | `debug-log-sharing.feature` |
| Telemetry: counts always, content only by consent | `telemetry-privacy.feature` |
| Media entries require descriptive text; the description is the recall surface | `journal-media.feature` |
| Only the drain owner writes the sidecar panes | `journal-sidecar.feature` |
| Shield files locked down; sweep deletes only its own names | `output-shielding.feature`, `shielding.test.ts` |
| Serve options cross the parse→server seam intact | `serve-options.test.ts` (D1 ratchet) |
| Every `.feature` is bound or registered debt | `feature-guards.test.ts` |
| Writer stamps come from the store, never the caller | `journal-orchestration.feature` |
| Only a lane's own writer retires that lane's pointers | `journal-orchestration.feature` |
| Imported entries keep the importer's marks; the file's claims are data | `journal-handoff.feature` |
| A handoff is read or written only inside the project directory | `journal-handoff.feature` |
