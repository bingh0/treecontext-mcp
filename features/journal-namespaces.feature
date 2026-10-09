Feature: Journal namespaces — many agents, one store, no cross-talk

  One project accumulates more than one writer: subagents fanned out over
  worktrees, orchestrators, parallel sessions. Namespaces give each writer
  its own journal inside the same SQLite file — isolated by default,
  merged deliberately, with provenance kept. The project namespace is the
  trunk; everything else is a working branch that earns its way in through
  an explicit merge.

  Charter detail (h): multi-agent orchestration and worktree isolation.

  @D9
  Scenario: writers in different namespaces never see each other by default
    Given two agents journaling into the same store under different namespaces
    When each agent queries its own store handle
    Then each sees hits only from its own namespace

  @D78
  Scenario: auto-capture lands in the namespace of the session that produced it
    Given a subagent session journaling under its own namespace
    When its captured events are ingested
    Then those entries live in the subagent's namespace
    And the project namespace gains them only through an explicit merge
    # Isolation must hold on the capture side, not just the query side — a
    # hook that writes every session's events into the trunk would make the
    # query-side isolation above a fiction.

  @D9
  Scenario: resume pointers are scoped to their namespace
    Given an active plan tagged next_session in a subagent namespace
    When the project namespace calls status
    Then that plan is not among the project's resume pointers

  @D9
  Scenario: dedup never reaches across namespaces
    Given two writers journaling into separate namespaces
    When identical auto-captured content arrives in each
    Then each namespace holds its own distinct entry
    # Dedup exists to collapse platform re-delivery of ONE event. Two
    # agents observing the same thing are two observations — collapsing
    # them would erase one writer's record.

  @D9
  Scenario: a merge carries a subagent's journal into the trunk with provenance
    Given a subagent namespace holding findings
    When a merge from that namespace into the project runs
    Then the entries are queryable from the project namespace
    And each merged entry records the namespace it came from
    # The merge itself must stamp provenance, unconditionally. When this
    # was written the merge copied metadata verbatim, so raw library writes
    # carried no source tag. Revised 2026-10-08: the merge now stamps the
    # source namespace on every merged entry that carries none, and this
    # scenario is bound; the gap this comment once predicted is closed.

  @D9
  Scenario: merged provenance is filterable and weightable at query time
    Given merged entries carrying a source namespace
    When a query excludes that namespace
    Then those entries are absent from the results
    And a query that down-weights the namespace instead returns them ranked lower
    # Surface note: exclusion is enforced inside the store before the
    # result budget fills; down-weighting is applied at the MCP query
    # surface over returned scores. Both bind against the server — the
    # product's outer face — not the raw library call.

  @D9
  Scenario: a merge can carry a single entry, not the whole branch
    Given a subagent namespace holding many entries
    When a merge names one entry id
    Then only that entry lands in the trunk, with provenance stamped
    And the rest of the branch stays where it was

  @D144
  Scenario: merging the same lane twice adds nothing
    Given a subagent namespace whose session repeated one tool output more than five minutes apart
    And that namespace has been merged into the trunk once
    When the same merge runs again
    Then no entry is added to the trunk
    And each trunk copy still names the source entry it came from
    # Idempotence by identity, not by content. A lane's session legitimately
    # repeats tool output — the same file read, the same status check —
    # further apart than the dedup window, and two observations are two
    # rows in the lane. The content predicate alone cannot tell "already
    # carried across" from "a second observation": it flipped between the
    # pair on every run, so a merge repeated every few seconds grew the
    # trunk by two frozen copies per run, without bound (verified
    # 2026-10-05). Every copy now carries a pointer to its source entry,
    # and a repeated merge consults the pointer before the predicate.

  @D9
  Scenario: a namespace cannot merge into itself
    Given a store whose current namespace is the trunk
    When a merge names the current namespace as its source
    Then the merge is refused with an error naming the namespace

  @D9
  Scenario: clearing one namespace leaves the others whole
    Given two populated namespaces in one store file
    When one namespace is explicitly cleared
    Then the other namespace's entries remain intact and queryable

  @D81
  Scenario: servers on different namespaces of one store serve concurrently
    Given a server holding the tool-writer role for one namespace
    When a second server takes the tool-writer role for a different namespace of the same store
    Then both hold their roles at once
    And a third server naming an already-held namespace serves alongside the holder, which keeps the primary claim
    # C2 (multi-user design note): the tool-writer lock is per
    # (store, namespace) — FlatStore in-memory state is per-namespace and
    # WAL covers file safety, so cross-namespace servers share nothing the
    # lock exists to protect. Same-namespace EXCLUSIVITY retired
    # 2026-08-20 (store-as-arbiter design note §8) — it gated nothing
    # correctness needed once the store became the arbiter. What remains
    # is the same-namespace PRIMARY CLAIM: exactly one lease holder per
    # namespace, which is what doctor reports, what corroborates the hook
    # ladder's pid rung, and what a later server takes over when the
    # holder's heartbeats stop. The lease refusal itself is unchanged and
    # still names WHICH namespace is claimed — the server just no longer
    # treats it as fatal.

  @D96
  Scenario: two servers sharing one namespace keep their sessions apart
    Given two servers over the same namespace of one store, each with its own session
    When each of them inserts and queries through its own tools
    Then every one of those tool calls succeeds
    And each entry carries the session identity of the server that wrote it
    And each session's conversation is reconstructable from its session key alone
    # The attribution half of the ruling that retired the same-namespace
    # refusal (store-as-arbiter design note §8, 2026-08-20), made
    # falsifiable: one namespace may carry two conversations only while
    # every row still says which one it belongs to. The lease is not the
    # mechanism being tested here — one server holds the primary claim,
    # the other is refused it and serves anyway.

  @D81
  Scenario: the drain serves namespaces nobody is serving
    Given staged events stamped for a namespace with no live server
    When the drain owner drains
    Then those events land in that namespace's journal, created on demand
    # The drain owner is one per STORE and attributes every staged row to
    # its stamped namespace (C1) — a subagent's session whose server has
    # exited still gets its journal written, not silently rerouted.
