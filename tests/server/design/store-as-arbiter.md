# Design: the store as arbiter — database-enforced multi-user and the final shape

Program G (charter §2, third amendment; ruling node c48ada70,
2026-08-12). Successor to `multi-user.md` §C2: the lockfile model
shipped there is superseded as the *correctness* mechanism — the owner
ruled it "a technical oversight" against client-server best practice,
where invariants live in the database and every consumer inherits them.
This note designs the replacement and performs the mandated
**final-shape pass**: 0.1 ships, to the best of our knowledge, the last
big reshape of the database. Executed before program E so E's scenarios
bind against the final mechanism.

The governing principle, translated from Postgres/MariaDB practice to
SQLite's happy path: **coordination goes through the database, never
around it.** SQLite's WAL single-writer serialization is the enabling
property, not a limitation — one write lock means single-statement
claims are atomic and deadlock is structurally impossible. Accepted
ceilings, recorded: serialized whole-database writes (the workload is
capture-shaped, not OLTP-shaped); local filesystem only (WAL's -shm);
`BEGIN IMMEDIATE` for every read-modify-write transaction; a
`busy_timeout` on every connection. Verified: bundled SQLite 3.53.4 —
`ON CONFLICT` and `UPDATE … RETURNING` both available.

## 1. Dedup moves into the store

Today dedup lives in per-handle in-memory fingerprint maps
(`fpCurated`, `fpAuto`), warmed by a full-tree scan at open — safe
under one writer, merely accident-tolerant under several (hits
re-verify via `nodeExists`; misses duplicate). Both maps retire.

**Schema:** `nodes` gains `fingerprint TEXT` (the existing
`contentFingerprint` — as of schema v24 a `sha256` digest rather than
the head/tail/length structural key this program shipped against; see
docs/project-identity.md §9.2/§11b, and note that program G's ladder
steps keep writing the frozen `contentFingerprintV1`) and
`dedup_class TEXT` — `'curated'` or `'auto'`,
computed at insert exactly as `isAutoCaptureSource` decides today
(classes never cross, JF-11, unchanged). Backfill migration computes
both for every existing row — the first migration that reads every
row's content (zstd decode included); it gets its own scenario and
rides the beta cycle's oldest-store verification.

**Curated (global, permanent):** a partial unique index —
`UNIQUE (tree_id, fingerprint) WHERE dedup_class = 'curated'` — and
`INSERT … ON CONFLICT DO NOTHING`. When `changes = 0`, the insert path
fetches the surviving row and applies `mergePointerFlags` +
`applySupersedes` exactly as the dedup-hit path does today: the
re-arm and supersession semantics are bound scenarios and must not
move. The constraint is the truth for every writer in every process.

**Auto-capture (windowed, per-session):** a sliding 300s window cannot
be a unique constraint — the same content legitimately becomes a new
row outside the window. It becomes a `dedup_anchors` table:

```
dedup_anchors(tree_id, session_key, fingerprint,
              node_id, last_seen,
              PRIMARY KEY (tree_id, session_key, fingerprint))
```

Insert path, inside one `BEGIN IMMEDIATE` transaction: read the
anchor; if within `DEDUP_WINDOW_SECS` of `last_seen` and the node
still exists → dedup hit, slide `last_seen` forward (slide-forward
only, as today); else insert the row and upsert the anchor. Anchor
rows are hygiene-swept with staging retention. Semantics are
byte-identical to the map behavior the scenarios bind — **the
enforcement moves; the promises do not.**

## 2. The drain becomes claim-based

`staging` gains `claimed_by TEXT` and `claimed_at REAL`. A drain tick
claims its batch in one atomic statement:

```sql
UPDATE staging SET claimed_by = :me, claimed_at = :now
 WHERE id IN (SELECT id FROM staging
               WHERE processed = 0
                 AND (claimed_by IS NULL OR claimed_at < :now - :ttl)
               ORDER BY timestamp, id LIMIT :batch)
RETURNING *
```

Two drains get disjoint batches by construction — the double-ingestion
hazard the drain lock existed to prevent is gone at the SQL layer.
A crashed drain's claims expire by TTL (claim TTL ≫ tick interval,
≪ the staleness a user would notice; the value is a named constant
with its assumption stated). `markStagingProcessed` clears the claim;
the poison-row attempt counter, dead-letter ordering (tombstone first),
and the byte valve's live-session protection are all unchanged — the
valve's whole-group delete respects claims by running through the same
claim path.

## 3. Roles coordinate through a lease table

```
leases(role TEXT PRIMARY KEY,      -- 'drain' | 'ns:<namespace>' | 'sweep:<namespace>'
       holder_pid INTEGER, holder_host TEXT, holder_label TEXT,
       acquired_at REAL, heartbeat_at REAL, ttl_secs REAL)
```

Acquire = `BEGIN IMMEDIATE` upsert-if-absent-or-expired; renew =
heartbeat update each tick; release = delete-if-mine (safe here, unlike
the annotation unlink: the compare-and-delete runs inside the write
transaction, so the restart race `multi-user.md` amendment 9 documents
cannot occur). Liveness is heartbeat expiry — no pid probing, no
staleness ASSUMPTION comments, and the entire lockfile ledger
(pid-reuse bounds, same-host reclaim, case-collision hashing) retires
with the lockfiles.

What each role still means once correctness is constraint-enforced:

- **`drain`** — efficiency, not correctness: two drains are safe but
  waste ticks. `IngestionLoop.start()` acquires it; refusal degrades
  to no-capture exactly as today, still only contested under
  `--capture` (C-review finding 2 carries forward).
- **`ns:<namespace>`** — the product's same-namespace second-server
  refusal (a UX promise the corpus binds) plus sweep singularity: the
  retention sweep's archive-then-delete interleavings were designed
  for one writer per namespace, and leasing is cheaper than a full
  two-sweeper interleaving audit. The refusal message keeps naming the
  namespace.
- Doctor reports role holders with a `SELECT` over `leases` — closing
  C-review finding 10 (deferred doctor lock reporting) with a query
  instead of lockfile forensics.

**Library surface:** this is what makes library multi-user safe with
no locking API. Any consumer that opens the file gets constraint-
enforced dedup and claim-safe draining with zero ceremony;
`FlatStore.open` grows an optional role request only for consumers
that want the serve-style refusal semantics (`role: 'tool-writer'`
acquires `ns:<namespace>`), readers and drain-side handles need
nothing. The C2 lockfiles (`.treecontext.lock`,
`.treecontext.ns-*.lock`) are REMOVED, not kept as a second mechanism
— one arbiter. The capture-attribution machinery (staging.namespace,
the pid annotation file, hook honesty ladder) is orthogonal and
carries forward unchanged.

## 4. The final-shape pass — column vs metadata, every structural key

The rule that decides: **a datum becomes a column iff the engine
enforces an invariant on it or every query path computes on it; it
stays metadata iff it is annotation carried along.** Rulings:

| Datum | Today | Final shape | Why |
|---|---|---|---|
| fingerprint | memory only | **column** (+ partial unique index) | the engine enforces dedup on it |
| dedup_class | derived in JS | **column** | the partial index needs it; classes never cross |
| session key | 3-way COALESCE expression over metadata JSON, expression indexes (014/015) | **column `session_key`**, computed at insert by the same ladder, plain index; backfilled | every window/anchor/retention query computes on it; the COALESCE is legacy compat frozen into query text |
| staging claims | — | **columns** | the engine enforces the claim |
| leases | lockfiles on disk | **table** | the store is the arbiter |
| `_relied_count` | metadata json_set | **column `relied_count`** | retention ordering computes on it; also retires the review's altitude debt and simplifies the FTS-safety invariant (a column write provably cannot touch metadata) |
| `_index_len` / `_preview_len` | metadata | **columns**, mirroring staging's | every read-side cut computes on them; C4-read-view's rewriter-safety preamble simplifies to "content and its boundary columns move together" |
| `_namespace` merge provenance | metadata | **stays metadata** | annotation: optional, per-row, filterable through the existing metadata pushdown; the engine enforces nothing on it |
| resume flags (`next_session`, `status`) | metadata | **stays metadata** | agent-domain semantics; the engine enforces nothing |
| `_media` | metadata | **stays metadata** | annotation with open shape |
| demotion markers / archive paths | metadata | **stays metadata** | provenance of a content rewrite, read only by humans and hits |

Metadata keys that move to columns keep read-compat: the query surface
continues to *serve* them under their metadata names where bound
scenarios read them, sourced from the columns. Post-0.1 additions the
charter contemplates (dense vectors, ccr) are additive tables against
this shape — nothing on the §3 list requires reshaping what is ruled
here. That is the "final shape to the best of our knowledge" claim,
made falsifiable: anything structural left in metadata after this
table is a decision recorded above, not drift.

## 5. Migration and sequencing

One version, one story: migration **021 "the store becomes the
arbiter"** — additive columns (`fingerprint`, `dedup_class`,
`session_key`, `relied_count`, `index_len`, `preview_len` on nodes;
claims on staging), the two new tables, the partial unique index, and
the backfill (single pass over nodes computing fingerprint, class, and
session_key; lifting counters and boundaries out of metadata). Hooks
never run migrations: the staging claim columns extend the JF-8
fallback ladder exactly as 018 and 020 did. Old binaries refuse v21
stores (SchemaVersionError) — no mixed-mechanism concurrency window.

Implementation chunks, each review-gated per house pattern:
G1 migration + backfill; G2 dedup-in-store (maps retire); G3
claim-based drain; G4 leases + lockfile removal + doctor rows; G5
column lifts (session_key, relied_count, boundaries) + query-path
rework; G6 corpus (scenario rewording pre-registered below) +
adversarial review + mutation pass.

## 6. Corpus consequences (pre-registered sanctioned changes)

- `journal-storage` "concurrent sessions do not corrupt each other":
  reworded a second time — the writer-role lines become "claims and
  constraints make concurrent writers safe; the drain lease makes them
  efficient; a same-namespace second server is still refused" —
  keeping the cross-process second-session world and the lossless
  staging letterbox unchanged.
- `journal-namespaces` C2 scenarios: the coexistence scenario keeps
  its promise with the lease as the mechanism; the lockfile-path
  assertions in bindings move to lease-row assertions.
- Dedup scenarios (`flat-store-dedup`, "dedup never reaches across
  namespaces"): **must pass textually unchanged** — they are the
  invariance proof for G2.
- New scenarios: two drains claim disjoint batches; two same-namespace
  library writers cannot double a curated entry; an expired lease is
  reclaimed and an active one refused; doctor names role holders; the
  backfill migration round-trip on an oldest-store fixture.
- `multi-user.md` gains a dated pointer to this note; its §C2 stands
  as the record of the superseded mechanism and its review.

## 7. Amendment 2026-08-13 — dispositions from the pre-implementation review

A four-reader review of the G1–G5 landing surfaces (review node
2904bf20) checked this note against the code before implementation.
Its prerequisite finding shipped first as **G0** (@ 47d58f7, own
adversarial review, nine findings fixed): the `Database` wrapper's
transactions default to `BEGIN IMMEDIATE` with `deferred` as the
explicit read-only opt-out, `busy_timeout` is 10 s server-side and 8 s
hook-side (`openHookDb`, the single hook opener — hook timeouts are
capped by platform kill budgets, not by the store's patience), and
manual-transaction migrations map busy to `StoreBusyError`. The
accepted-ceilings paragraph in the preamble is therefore no longer
aspiration; it is shipped discipline. The remaining dispositions,
by chunk:

**G1 — pre-existing curated duplicates must not block the index.**
The partial unique index cannot be created over rows that already
violate it, and such rows can exist — the in-memory maps only ever
prevented *false* hits, never *missed* ones, and the warm scan resolves
curated collisions last-writer-wins in arbitrary rowid order. The
backfill resolves each curated `(tree_id, fingerprint)` group before
index creation: the **earliest row** (lowest `created_at`, then rowid —
what dedup would have produced had it worked) keeps
`dedup_class = 'curated'`; every later twin becomes
`dedup_class = 'curated_dup'` — outside the partial index, never again
a dedup participant, but **never deleted**: fingerprint equality over
128 chars is head/tail/length, not proof of byte equality, and the
data-loss priority forbids merging rows the engine cannot prove
identical. `curated_dup` rows stay fully queryable; nothing is lost,
nothing is silently unified. The round-trip scenario asserts both the
survivor choice and the twins' survival.

**G2 — demotion is the one place a fingerprint changes.** The demotion
sweep shrinks a row's index text and re-keys its fingerprint; with the
column, that recompute moves **inside the demotion transaction**. If
the row's class is curated and the recomputed fingerprint would collide
in the partial index, the row takes `curated_dup` — the same lossless
escape as the backfill. And the hit asymmetry is bound behavior, not an
accident to fix: the auto hit applies supersedes but does **not** merge
pointer flags; the curated hit does both and returns the survivor with
`deduplicated: true`. G2 preserves this exactly — it is part of the
invariance proof.

**G3 — the scope grows by one table and two decisions.** The
`snapshots` claim (`claimSnapshot`, SessionStart hooks racing with no
lock) joins the `UPDATE … RETURNING` rework — it was the codebase's
worst deferred-claim offender and already carries the interim
immediate-mode fix; the lock-free probe stays even after the rework,
because a zero-row `UPDATE` still takes the write lock. Decisions: a
drain tick that stops early (soft deadline) **releases its unprocessed
claims at tick end** — the TTL is for crashes, not for routine
leftovers; and the byte valve's whole-group delete honors live claims
(it may steal only expired ones). Migration 021 adds the claim-shaped
index — `staging(timestamp, id) WHERE processed = 0` — since the 017
index leads with `session_id` and cannot serve the claim's ordering;
017 stays for the valve's grouping. JF-8 correction: the hook ladder
needs **no new rung** — hooks always insert unclaimed rows, so the
claim columns ride their NULL defaults.

**G4 — sweeps lease at fire time.** The retention sweep triggers off
every 50th insert in *whichever process* inserts, and library writers
hold no role by design — so the `ns:` lease alone cannot make the
sweep single. The sweep (and the demotion valve it calls)
**try-acquires `sweep:<namespace>` non-blocking at fire time**; refusal
skips the sweep and the next trigger retries. Without this, the
"leasing is cheaper than a two-sweeper interleaving audit" argument
silently fails for exactly the library consumers this note enables.

**G5 — the boundary keys are load-bearing, not display.** The
contentless FTS replays a row's exact indexed text at update/delete by
reading `_index_len` from persisted metadata; and `metadata_filter` is
a JS post-filter over the parsed metadata object. So the lift serves
lifted values by **re-injecting them into the parsed metadata object at
materialization** — one choke point, upstream of `indexTextFor`,
`demotionTextFor`, the filter, and every result-assembly site — rather
than rewriting each consumer. The session-key lift preserves the
`'__nosession__'` sentinel (not NULL) and the `String()` coercion; the
`status()` session count, today a bare `json_extract` with no ladder,
moves to the column — the count may change, and that is a fix, not a
regression. `SCHEMA_VERSION` in `schema.ts` is already stale (19 vs
ladder max 20): 021 derives it from the ladder rather than bumping a
constant.

**G6 — the sanctioned-change list grows.** Several bindings assert via
raw `json_extract` SQL and break on the lift regardless of read-compat
(`features.test.ts`, `flat-store.test.ts`, `role-weighted-fts.test.ts`,
`migration-015.test.ts` — the last also pins the 014/015 index SQL this
program retires); `bench/cap-cost.ts` drives the bench through the
`_index_len` metadata marker. These rewordings are pre-registered here
as sanctioned alongside §6's list.

## 8. Amendment 2026-08-13 (post-G1 review) — the interim heal

G1's adversarial review confirmed a scheduling hole: a store at v21
whose rows were written by a G1-era binary (insert path not yet
rewired) carries NULL `fingerprint`/`dedup_class`/`session_key`
columns, and nothing re-fires the backfill — the runner early-returns
at max version. Released binaries never see this (G1 through G5 ship
together in 0.1), but the dogfood store lives in the gap, and the §5
"no mixed-mechanism window" claim rested on open-time refusal alone.
Disposition, pre-registered for **G2**: the backfill loop is extracted
to a shared function, and G2 registers **migration 022 "the interim
heal"** landing in the same commit that rewires the insert path, so
the moment a binary starts writing the columns it has also healed
every row written by its predecessor. NULL-column rows are harmless
meanwhile by construction: NULL `dedup_class` sits outside the partial
unique index, and G1-era readers still read metadata, not columns.

The G1 review then widened this in three ways (all G2 obligations):

- **022 heals by full recompute, not `WHERE fingerprint IS NULL`.**
  Three live write paths rewrite a row after 021 without re-stamping
  the columns — the demotion sweep (content shrinks to a stump), the
  `_relied_count` bump (metadata-only `json_set`), and the import
  stump-restore — leaving *non-NULL but stale* values a NULL-predicate
  heal never revisits. 022 recomputes every row (the pass is cheap:
  530 ms for the 4.8k-row dogfood store), which also heals rows 021
  skipped as undecodable, if a later runtime can decode them.
  *(§11b, 2026-08-20:)* the pass landed at 023 and is now frozen on
  `contentFingerprintV1` — a shipped rung keeps writing the key it
  shipped with, and migration 024 is the one step that rewrites those
  keys as digests. A store upgrading from below v23 therefore pays
  023's pass AND 024's, in one exclusive batch.
  *(G2 review, further:)* 021 and 022 ship in one release and batch
  into one transaction, so 021 carries **no backfill at all** — 022 is
  the one whole-store pass an upgrading store pays, and it also
  **seeds the window anchors** newest-wins (warm-scan parity: without
  it, post-upgrade duplicates of pre-upgrade rows would not dedup and
  a repeated merge would re-copy every auto row). Anchors carry two
  clocks — `last_seen` is capture time (the window), `updated_at` is
  wall time (the hygiene sweep) — and their node reference is an
  `ON DELETE CASCADE` FK, making anchor lifecycle structural rather
  than a call-site convention.
- **G2's write paths maintain the columns from then on**: demotion
  recomputes fingerprint and boundaries in its transaction (amendment
  7 already requires the fingerprint half), the reliance bump
  increments the column alongside the metadata key, and the import
  restore re-stamps. After G2 no write path may change content or a
  lifted datum without the column moving in the same transaction.
- **The G1→G2 survivor split is accepted, not fixed**: until the maps
  retire, the in-process `fpCurated` map is last-writer-wins while the
  persisted resolution is earliest-wins, so a duplicate curated insert
  in the gap may return and re-arm a `curated_dup` row. Dogfood-only
  exposure (G1 and G2 ship together); G2's map retirement ends it, and
  022's recompute does not alter classes — the earliest-wins ruling
  stands.

## 8. Amendment 2026-08-20 — the same-namespace refusal retires

Owner ruling (treecontext node `c6f8ed2e`, off a beta-16 field report:
two claude code instances in one repo): *"as long as concurrent
writers is safe, with clear attribution (so we can reconstruct
different conversations) i do not see why not."* Both conditions were
verified pre-existing before this amendment was written — writer
safety is §3's own constraint argument (G2), and attribution is the
session-identity program (per-row session key, echo heal, disclosed
ambiguity). The refusal this note kept as "the product's
second-server refusal" protected the pre-G world of in-process dedup
maps; since G2 it gates nothing correctness needs.

### What changes

- **`serve`'s `lockHook` stops throwing on contention.** It still
  `tryAcquire`s `ns:<namespace>` per tool call — that is the
  heartbeat-past-freshness and the takeover path when a holder dies —
  but a `StoreLockedError` is swallowed: the tool proceeds. Any
  *other* error still surfaces as itself (program-C review, finding
  8, preserved). The `CreateServerOptions.lockHook` contract comment
  updates from "must throw" to "best-effort primary-claim
  acquisition; never throws for contention."
- **The lease primitive is untouched.** One holder per role; a
  rival's `tryAcquire` is still refused with the holder named
  (`store-as-arbiter.feature` and `leases.test.ts` pins stand
  verbatim). The holder is the **primary claim**: doctor visibility,
  clean-exit release, and the hook-side pid-rung corroboration
  (`nsLeaseLiveFor`) all key on it unchanged.
- **A non-holding server serves normally.** Its pid annotation fails
  corroboration (the lease belongs to the other pid), so its hooks
  ride the causal session rung or stamp NULL — routed correctly
  either way, since NULL drains into the same serving namespace.
  Stated at `nsLeaseLiveFor` so nobody "fixes" it.
- **The startup message changes** from "tools will error until it
  releases" to a sharing note naming the holder.
- **Untouched:** the drain lease (one drain owner, per-tick), the
  `sweep:<namespace>` lease (sweep singularity), annotation writing.

### Out of scope

The contention-attempt cost (a write-lock attempt per call while a
holder lives) is the release-diff below-cap note about `tryAcquire`
on every tool call; it predates this amendment and is not made worse
by it — a non-holder pays exactly what a refused server paid. Backoff
stays a flagged note, not a rider on this change.

### Pre-registered corpus changes (sanctioned)

- `journal-storage` "concurrent sessions do not corrupt each other",
  **third rewording**: the refusal line becomes "a second server on
  the same namespace serves too — the store's constraints, not a
  lease, are what keep writers safe"; the comment records the
  2026-08-20 retirement and the lease's demotion to primary claim.
- `journal-namespaces` "servers on different namespaces of one store
  serve concurrently": the third-server refusal line becomes "a third
  server naming an already-held namespace serves alongside the
  holder, which keeps the primary claim"; the C2 comment updates —
  same-namespace *exclusivity* is retired, same-namespace *primary
  claim* is what remains.
- **New scenario** (the attribution pin — the ruling's second
  condition made falsifiable): two servers over ONE namespace, two
  sessions; both servers' tools succeed; every row carries its own
  session's identity; each conversation is reconstructable by its
  session key.
