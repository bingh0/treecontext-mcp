Feature: the dedup key is a digest of the whole content

  docs/project-identity.md §9.2 measured the pre-v24 key filing
  genuinely different texts under one fingerprint: over 128 characters
  it was head(64) + tail(64) + normalized length, and captured tool
  calls share a command prefix and a result suffix and differ in a
  middle identifier of fixed width — 97 keys over 219 rows, 2.2% of a
  10,001-node store. Curated dedup is store-wide and permanent, so on
  the import and merge paths such a collision drops a row silently.
  Since schema v24 the key is sha256 of the normalized content,
  truncated to 128 bits, and migration 024 rewrites every decodable row.
  The dedup behavior scenarios elsewhere pass textually unchanged: the
  key got stronger; the promises did not.

  Scenario: two tool calls differing only in a middle identifier stay two entries
    Given two captured tool calls sharing a prefix and a suffix, differing only in a task id of equal width
    When both are recorded as curated notes
    Then two entries exist, each recallable by its own task id
    # The §9.2 shape, built by construction: same head(64), same
    # tail(64), same normalized length. Under the pre-v24 key this was
    # one entry and the second insert reported a dedup hit.

  Scenario: a store carrying a false collision heals when it climbs to the digest
    Given a v23 store where two different tool calls were filed under one dedup key
    When the store is opened by a build that migrates it
    Then both entries hold a curated slot again, under keys of their own
    And the pre-migration copy is on disk and the rewrite counts are disclosed in the debug log
    # Nothing is merged or deleted: the demotion was a judgement about a
    # key that could not tell the two apart, and 024 retracts it. The
    # backup is the only rollback — the completion verdict compares row
    # counts, which a value rewrite cannot change.

  Scenario: the collision check reads zero on the migrated store, and names the leftover key for what it is
    Given a migrated store holding a row whose content could not be decoded
    When the self-audit counts collisions and pre-digest keys on it
    Then no collision group is reported, and the undecodable row is counted as an unmigrated key
    # "Reads zero after migration" is only true if the rows 024
    # deliberately leaves alone are counted apart from collisions
    # (§11b review, finding 10) — an undecodable row keeps its old key
    # forever, because rewriting it would mean inventing its content.
