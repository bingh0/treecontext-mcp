# Design: full multi-user — capture attribution and per-namespace locks

> **Superseded in part (2026-08-12, same day, ruling c48ada70):** §C2's
> lockfile mechanism is replaced by database-enforced coordination —
> see `store-as-arbiter.md` (program G, charter third amendment). §C1
> (capture attribution) carries forward unchanged. This note stands as
> the record of the superseded mechanism, its adversarial review, and
> the amendments that review produced.

Design-tier companion to `journal-namespaces.feature` ("auto-capture
lands in the namespace of the session that produced it") and
`journal-storage.feature` ("concurrent sessions do not corrupt each
other"). Records program C of the audit work program (owner rulings
2026-08-12: attribution ruled buildable for 0.1, then expanded the same
day to full multi-user — per-namespace tool locks with a single drain
owner — rejecting the capture-side-only option).

## The defect being fixed (audit D3)

The staging table has no namespace column, and the drain is the serving
process's single `FlatStore` handle — so every captured event, from
every session, lands in whatever namespace the drain owner was launched
with. The bound scenario "auto-capture lands in the namespace of the
session that produced it" currently passes only because the binding
drains through a second, contrived store handle: configuration-dishonest.
In the shipped configuration the scenario's promise is false. C1 makes
it true; C2 makes the concurrency story around it real.

## C1 — capture attribution

### Migration 020: `staging.namespace`

Additive, nullable `TEXT`. NULL means *unresolved at capture* — a hook
that could not learn its session's namespace stamps nothing, and the
drain attributes NULL rows to `project`. That is a defined default, not
a guess: `project` is already the declared default namespace at every
other surface (CLI `--namespace` default, `FlatStore.open` default, the
trunk in the namespaces charter). Keeping NULL distinct from an explicit
`project` stamp preserves the honesty distinction — the row's own record
says whether attribution happened or defaulted — and makes the pre-020
hook fallback (below) semantically identical to an unresolved stamp.

### How a hook learns its session's namespace: the namespace beacon

The server knows `--namespace`; hooks do not. The bridge is the same
PID identity the session beacon already exploits: both the hook wrapper
scripts and the MCP launcher wrapper `exec` into node, so a hook process
and the stdio server spawned by the same claude instance agree on one
`process.ppid` with no IPC (see `src/session-beacon.ts` header).

Mechanism: the stdio server writes a **namespace annotation file**,
`sessions/pid-<claudePid>.ns.json`, at startup:

```json
{ "namespace": "agent-a", "server_pid": 12345, "written_at": 1786… }
```

**A separate file, not a field in the session beacon.** The beacon has
exactly one writer class — hooks — and SessionStart rewrites it
wholesale (`rewrite: true`). Merging a server-owned field into a
hook-owned file would create a clobber race the atomic-rename protocol
cannot arbitrate (server writes namespace, SessionStart rewrite drops
it). One file, one writer: hooks own `pid-N.json`, the server owns
`pid-N.ns.json`. Same `atomicWriteJson` pattern, same directory.

Lifecycle: written at startup (stdio only — the ppid argument does not
hold elsewhere, and the HTTP transport is tombstoned); rewritten on
restart, so a relaunch with a different `--namespace` wins; best-effort
unlink on clean shutdown. Staleness guard: the file names the server's
own pid, and a hook honors the annotation only while that pid is alive —
a dead server's annotation is unresolved, not a guess.

Hook resolution ladder (mirrors the identity ladder's honesty rungs;
first hit wins):

1. **own-ppid annotation, server pid alive** → that namespace, exact.
2. **anything else** → NULL. Never read other pids' annotation files,
   never most-recently-seen, never infer. Rung 2 is the *absent* rung —
   the drain's `project` default is applied at drain time, visibly,
   not smuggled in at capture time.

Platform adapters (codex / cursor / gemini / opencode / vscode): where
the adapter's launch chain preserves the exec-into-node ppid identity,
the same ladder applies; where it does not, the hook lands on rung 2 by
construction. Audit each adapter during implementation; none may guess.

### Hook write path

`writeStaging` gains `namespace` on `StagingEntry` and includes the
column in its INSERT. JF-8 (hooks never run migrations) extends the
existing degradation ladder by one rung: a missing-column error on
`namespace` falls back to the pre-020 INSERT, then the existing pre-018
and pre-016 rungs apply unchanged. On a pre-020 store the stamp is
simply lost — which is exactly the NULL/unresolved semantics.

### Drain attribution

Per-row target namespace = `row.namespace ?? 'project'`. The
`IngestionLoop` stops writing through one bound handle and instead keeps
a **per-namespace handle cache**, create-if-absent (`FlatStore.open` on
the same wrapped database; `ensureTree` creates the tree row). The
serving process's own store seeds the cache for its namespace, so the
common single-namespace case allocates nothing new.

Attribution covers every insert the drain performs, tombstones included:

- **Dead-letter and malformed-snapshot tombstones** go to the failing
  row's own namespace — the hole is in that journal's timeline.
- **Byte-valve tombstones**: the valve's grouping becomes
  `(session_id, namespace)` rather than session alone, and each dropped
  group's tombstone lands in that group's namespace. (A session's rows
  share one namespace in practice — a session has one server — but the
  grouping must not assume it; a mid-session server restart under a new
  namespace is legal.)
- **Recovery-snapshot rows** are attributed like any other row, and
  their recovery *queries* run against the target namespace's handle —
  a subagent's snapshot must not be rehydrated from the trunk's journal.

### Rebinding the scenario

"Auto-capture lands in the namespace of the session that produced it"
rebinds in the shipped configuration: one serving process (drain owner,
namespace `project`), staged rows stamped `agent-a` by the hook path,
drained by the project server, asserted present in `agent-a`'s tree and
absent from the trunk until an explicit merge. The second-handle
contrivance in the current binding is deleted, not repaired.

## C2 — per-namespace locks

### Two roles where there was one

Today `.treecontext.lock` means "the one writer per store": tool
mutations and the capture drain travel together. C2 splits the roles:

- **Drain owner** — at most one per *store*, serving all namespaces
  (with C1 the drain is inherently cross-namespace). Keeps the legacy
  lockfile path `.treecontext.lock`, the holder JSON shape, the
  stale-pid reclaim, and the lazy startup-try semantics
  (`capture = args.capture && drainOwner`, unchanged).
- **Tool-writer lock** — one per *(store, namespace)*:
  `.treecontext.ns-<namespace>.lock`. Same holder format, same
  stale-reclaim, same lazy `lockHook` re-attempt so a refused server
  fails per-call and can take over when the holder exits.

Why the drain keeps the legacy filename: migration 020 bumps the schema,
and older binaries refuse newer stores outright (`SchemaVersionError`,
`migrations.ts`) — so no pre-C2 binary can ever contend on a post-020
store, and the filename carries no mixed-version hazard. Reusing it also
keeps the scope fence's settled sentence — "the multi-agent story is
namespaces of one store with a single capture-drain owner (store
lock)" — literally true. The `ns-` prefix on tool locks keeps the
namespace charset (`[A-Za-z0-9._-]+`) from ever colliding with the
drain lockfile or any future reserved name (a namespace literally named
`lock` or `drain` must not alias a role file).

Startup order: acquire the tool lock for the server's namespace first —
refusal here is the "same-namespace second server" case and stays a
hard, clearly-worded refusal — then try the drain lock, degrading to
tools-only exactly as today's non-owner path does.

### Why per-namespace tool writers are safe

The two ingredients, both already bound:

- **WAL** gives multi-process file safety — the concurrent-sessions
  scenario (two real processes, interleaved captures, none lost, none
  doubled) and the crash scenario bind it.
- **FlatStore in-memory state is per-namespace**: the dedup fingerprint
  maps are warmed from, and only ever name, one tree; `treeId` scopes
  every query and mutation. Two servers on different namespaces share
  no in-memory state at all.

The one real interleaving is **drain owner and tool server writing the
same namespace** — the drain reaches into every tree, so per-namespace
exclusivity does not exclude it. Enumerated:

- `fpAuto` (auto-capture dedup): only the drain inserts
  `source='auto-capture'` rows, and there is exactly one drain. The
  map's writer is its only consumer. Exclusive; no staleness.
- `fpCurated` (curated dedup): the tool server inserts curated rows;
  the drain's tombstones are *also* curated-class
  (`isAutoCaptureSource` is `source === 'auto-capture'` exactly, and
  tombstones carry `capture-gap`). Each process's map is blind to the
  other's inserts, so a cross-writer duplicate can slip past dedup —
  a **benign false negative**: dedup exists to collapse re-delivery,
  and its miss costs one extra row. The dangerous direction is already
  guarded: every dedup *hit* re-verifies `nodeExists` against the
  database before swallowing an insert, so a stale map entry can never
  eat a write. This asymmetry (misses duplicate, hits re-verify) is the
  invariant the concurrency scenarios must pin.
- `mergePointerFlags` / `applySupersedes` update by `node_id`; WAL
  serializes the row-level writes.

Remaining cross-tree surfaces, audited:

- **`merge_from_agent`** reads a source tree that another server may be
  writing. The read-then-copy must run inside one transaction so WAL
  gives it a consistent snapshot — a merge must not carry half of a
  concurrent insert's supersession chain. (Today it runs on the single
  writer's handle where the question could not arise.)
- **`exportJson` reliance bump**: the SELECT is tree-scoped and gates
  the bump, and node ids are global UUIDs, so a cross-tree write cannot
  occur today — accepted, with `tree_id` added to the UPDATE's WHERE as
  a free belt-and-braces guard while we are in the file.
- **Status staging panel** stays store-wide by design (staged rows are
  pre-attribution), but its comment gains the C1 clause: rows now carry
  their *intended* namespace; attribution still happens at the drain.

### Scenario and fence changes (sanctioned-change protocol)

Bound-scenario changes are pre-registered here before any edit:

- `journal-storage.feature`, "concurrent sessions do not corrupt each
  other": "exactly one process holds the writer role and runs
  ingestion" rewords to per-namespace form — exactly one *tool writer
  per namespace*, exactly one *drain owner per store*, and the
  non-owner's captures still stage and drain when the owner runs.
- `journal-namespaces.feature` gains the concurrency scenarios this
  design creates: two servers on different namespaces of one store
  serve tools concurrently; a same-namespace second server is refused
  with an error naming the namespace; a session's captures drain into
  its stamped namespace even when no server for that namespace is
  running (the drain owner serves all namespaces).
- `features/OUT-OF-SCOPE.md`, shared-process entry: the
  parenthetical "(store lock)" gains a dated amendment — the drain
  owner keeps the store-wide lock; tool writers became per-namespace
  under this design. The decline itself (no shared process) is
  untouched.
- Doctor and refusal messages: "another treecontext server holds this
  store" splits into the namespace-aware tool-lock refusal and the
  drain-ownership line; doctor's lock reporting names both roles.

## Amendments (adversarial review of program C, 2026-08-12)

The `/code-review high` pass over `29a3cc5..a624048` returned ten
findings; all ten were accepted and disposed as follows, and the
sections above should be read with these corrections:

1. **`migrate: false` now refuses ANY pending migration**, additive
   included — the destructive-only gate let 020 run an ALTER over
   read-only connections. An opt-out is an opt-out.
2. **The drain lock is only contested under `--capture`** — a
   non-capture server must not seize the role and starve the store of
   its only drain.
3. **The valve protects the live SESSION whole**, not just the newest
   (session, namespace) group — a session straddling a NULL-stamped
   prefix and a stamped suffix is one live stream.
4. **An unresolved (NULL) stamp drains into the SERVING namespace**,
   not the literal `project` — pre-attribution behavior, and visible in
   the journal the user's server actually queries. §C1's "defined
   default" paragraph is superseded accordingly.
5. **The annotation gains a 24h staleness bound** (same ASSUMPTION
   posture as the beacon's `PID_MATCH_STALE_MS`) — pid liveness alone
   guesses once the OS recycles a SIGKILL'd server's pid.
6. **Namespace lockfiles carry a case-sensitive hash suffix**
   (`.treecontext.ns-<name>.<sha256/8>.lock`) — raw names collide
   distinct-case namespaces on macOS/Windows filesystems while
   `trees.namespace` collates BINARY.
7. **`tombstoneHandleFor` falls back to the serving handle only for
   GARBAGE stamps**; transient factory failures for valid stamps
   propagate — both callers leave the row/group queued and retry, which
   is self-healing where a wrong-journal tombstone is permanent.
8. **The serve-path lock catches only survive `StoreLockedError`** —
   an EACCES/EROFS creating a lockfile surfaces as itself instead of
   masquerading as contention.
9. **There is NO shutdown unlink of the annotation** — read-compare-
   unlink races a restarted server's atomic write and deletes the new
   server's annotation. Beacon parity: never removed, defused by the
   guards, overwritten by the next server. §C1's "best-effort unlink"
   sentence is superseded.
10. **Doctor lock reporting is DEFERRED to program E's doctor pass** —
    §C2 pre-registered it, it did not ship in C, and this amendment is
    the honest record of that gap rather than a claim it exists. The
    refusal-message half shipped; the observability half rides with E's
    doctor work (backup rows `fix:` fields et al.).

Review-capped cleanup items carried as known debt: the synchronous
dedup warm scan when the drain first touches a mature namespace; an
invalid stamp riding the full 3-retry poison path; `isPidAlive`
duplicated between session-beacon and store-lock; and the attribution
factory living in three shapes (production + two test copies).

## What stays declined

- **Cross-machine locking** — holder liveness stays host-scoped
  (`pid` + `host`, reclaim only on same host), unchanged.
- **Multiple drain owners** — one per store, permanently; parallelizing
  the drain buys nothing (it is I/O-trivial) and costs the `fpAuto`
  exclusivity argument above.
- **HTTP transport** — tombstoned (ruling 1, 2026-08-12); the
  `explicit` rung of the identity ladder stays dormant, and nothing in
  this design depends on any transport but stdio.
