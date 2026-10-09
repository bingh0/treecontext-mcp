Feature: stores merge — one project, two journals, made one

  Part 3 of the identity program (docs/project-identity.md §5, §11c).
  A directory bound by path before it had a remote, bound again by git
  after, ends up writing two journals that cannot see each other. Nothing
  inside either one can show the split; `doctor` names it and points at
  this command, and this command is what actually repairs it.

  What it is NOT is a bespoke SQLite merge. `FlatStore.mergeFromNamespace`
  already was the operation minus a cross-store reader, so the source is
  ATTACHed and the reviewed copy body runs unchanged — which is why the
  FTS index, the dedup anchors and every protection column come out right
  by construction rather than by transcription.

  Three properties carry the whole feature. It copies EVERY namespace of
  the source, not just `project` — a predecessor holding agent lanes would
  otherwise lose them silently, which is the exact loss class this program
  exists to kill. It preserves source node ids and checks them BEFORE the
  content predicate, so a re-run imports exactly zero rather than
  approximately zero, and so the resume pointers and supersession chains
  written against those ids still resolve. And it never deletes the
  source: `stores rm` stays the user's own explicit act.

  Its refusals are as much the contract as its copy. Every precondition
  fails closed with its own message, and the locking one is a lock and not
  a check — the merge TAKES the destination's drain lease rather than
  looking for its absence and hoping.

  Scenario: merging a split pair leaves one journal holding both
    Given a path-bound store with 163 entries and a git-bound store with 599
    When the stores are merged with backups taken
    Then the destination holds all 762 entries
    And the per-namespace and total counts are reported
    And the source store is intact on disk and named as the user's own follow-up

  Scenario: an agent lane in the source survives the merge
    Given a source store holding a project namespace and an agent namespace
    When the stores are merged with backups taken
    Then both namespaces land in the destination under their own names
    And each namespace's counts are reported separately

  Scenario: merging twice imports nothing the second time
    Given a source and destination already merged once
    When the same merge runs again
    Then nothing is imported and every source row is reported as already present
    And the destination's entry count is unchanged

  Scenario: a source entry whose content already lives in the destination is skipped as a duplicate
    Given a source and destination that share one entry's content under different ids
    When the stores are merged with backups taken
    Then the shared entry is skipped as a duplicate, not imported twice
    # The content dedup predicate, pinned: without it the merge would
    # copy a second row with identical content and the destination would
    # carry the same note twice.

  Scenario: a curated entry's protections travel with it
    Given a source store holding a read-only, decay-exempt entry
    When the stores are merged with backups taken
    Then the copied entry is still read-only and decay-exempt
    And it carries its source store and source namespace as provenance

  Scenario: merging a store into itself is refused
    Given a store that exists
    When it is named as both source and destination
    Then the merge refuses and says a store cannot be merged into itself

  Scenario: a store name that reaches outside the stores root is refused
    Given a destination store that exists
    When a source name that escapes the stores root is passed
    Then the merge refuses and names the stores root it must resolve inside

  Scenario: a schema-version mismatch is refused rather than migrated
    Given a source store one schema version behind and a destination at the head
    When the stores are merged
    Then the merge refuses naming the source store and its version
    And the source store is not migrated

  Scenario: merging without a backup of both stores is refused
    Given a destination backed up today and a source with no backup
    When the stores are merged without the backup flag
    Then the merge refuses naming the store whose backup is missing

  Scenario: a held drain lease on the destination refuses the merge
    Given a destination store whose drain lease is held by another process
    When the stores are merged with backups taken
    Then the merge refuses naming the lease holder
    And nothing is imported

  Scenario: a source holding a non-leaf row is refused
    Given a source store with a tree-era non-leaf row
    When the stores are merged with backups taken
    Then the merge refuses rather than silently flattening it

  Scenario: without the repoint flag the merge names the command that finishes the job
    Given a split pair with both bindings on disk
    When the stores are merged with backups taken and no repoint flag
    Then the merge reports the bindings still naming the source and prints the repoint command
    And bindings.json is unchanged

  Scenario: repointing collapses the split and doctor reads clean
    Given a split pair with both bindings on disk
    When the stores are merged with backups taken and the repoint flag
    Then every binding that named the source now names the destination
    And each binding keeps its own source value
    And doctor reports no split candidates

  Scenario: the merge command doctor advises actually parses
    Given a split pair doctor reports
    When the exact command from doctor's fix line is run
    Then it is not rejected by the argument parser

  Scenario: a source with an undrained staging backlog is refused
    Given a source store with events still staged and undrained
    When the stores are merged with backups taken
    Then the merge refuses naming the undrained count and nothing is imported

  Scenario: an undecodable source row is skipped and the rest of the merge lands
    Given a source store holding one row that cannot be decoded beside readable ones
    When the stores are merged with backups taken
    Then the readable rows land and the undecodable one is reported as skipped
    And the undecodable skip is called out as a warning

  Scenario: a source id already present under different content is an id conflict
    Given a destination already holding a row under a source id but with different content
    When the same source is merged again
    Then the row is reported as an id conflict and the destination is not overwritten
    And the destination row keeps its own content

  Scenario: a source row below depth 0 is refused
    Given a source store with a row at depth 1
    When the stores are merged with backups taken
    Then the merge refuses rather than flattening the depth

  Scenario: a store directory that is a symlink outside the root is refused
    Given a source whose store directory is a symlink to a store outside the root
    When the stores are merged with backups taken
    Then the merge refuses naming the real path outside the root

  Scenario: an alias symlinked to the real store refuses a self-merge
    Given an alias store directory symlinked to the destination's own directory
    When the alias is merged into the destination
    Then the merge refuses because they resolve to the same directory
