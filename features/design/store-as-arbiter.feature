Feature: the store as arbiter — coordination goes through the database

  Program G (charter third amendment; design note
  tests/server/design/store-as-arbiter.md). Correctness lives in the
  store: curated dedup is a partial unique index, the auto window is an
  anchor table, the drain claims its batches atomically, and the roles
  that remain are heartbeat leases. Every consumer that opens the file
  inherits the invariants — no locking API, no open-time warm scan, no
  process memory to go stale. The dedup behavior scenarios
  (flat-store-dedup.feature, journal-recall) pass textually unchanged
  across this program: the enforcement moved; the promises did not.

  Scenario: two same-namespace library writers cannot double a curated entry
    Given two library handles on the same namespace through separate connections
    When both insert the same curated content
    Then one row exists and both writers hold the same survivor id
    # The unique index is the truth for every writer in every process —
    # neither handle requested a role, took a lock, or ran a warm scan.

  Scenario: two drains claim disjoint batches
    Given a staged backlog and two drain identities
    When both claim batches at once
    Then the claims are disjoint and cover the backlog in capture order
    # Claims are marks in the store: a second drain — this process or
    # another, this connection or another — is offered only unmarked
    # rows. (The single-statement atomicity of the claim itself is
    # SQLite's serialized-writes guarantee, not something a sequential
    # binding can discriminate.)

  Scenario: an expired lease is reclaimed and an active one refused
    Given a server holding a namespace lease
    Then a rival naming the same namespace is refused, with the holder named
    When the holder's heartbeats stop for longer than the lease TTL
    Then the rival's next attempt takes the role
    # Liveness is heartbeat expiry — no pid probing, no reclaim
    # heuristics, none of the lockfile assumption ledger.

  Scenario: the doctor's view of role holders is one read-only SELECT
    Given a store whose drain and namespace roles are held
    When the lease table is read through a read-only handle
    Then every holder is visible with its liveness, and no role changed hands

  Scenario: a pre-arbiter store climbs the ladder losslessly
    Given a pre-arbiter store holding curated twins and an undecodable row
    When the ladder runs to the current version
    Then every decodable row is classified and the earliest twin keeps the curated slot
    And the twins survive as rows — nothing merged, nothing deleted, metadata untouched
    And the undecodable row is stamped from its metadata and waits for a capable runtime
    # Losslessness is the ruling (amendment 7/8): 023's key is the frozen
    # pre-digest one, where equality over 128 chars is head/tail/length,
    # not proof of byte equality — the backfill never unifies what it
    # cannot prove identical. Migration 024 later rewrites those keys as
    # digests and re-resolves the twins over them (§11b).
