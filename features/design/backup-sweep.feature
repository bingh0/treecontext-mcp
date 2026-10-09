Feature: Migration-backup sweep

  Reclaiming backup disk is manual and opt-in, in the house two-run idiom: a
  bare run is a dry-run that lists and verifies, a --yes run deletes. Safety
  lives in per-item verification, not ceremony — one --yes covers any count,
  because a backup is only eligible when the backup file itself opens and
  passes its own quick check (staleness repair 2026-08-12: this fifth
  condition was always enforced and even tabled in the refusal scenario
  below, but the preamble enumerated only four), its live store opens,
  passes its integrity check, sits at the current schema version, and
  carries a recorded success verdict from migration time. Verification runs on every pass, so a
  --yes run with no prior dry-run is verified identically. One refusal
  carries its own way out: a verified backup whose live store is gone is
  named an orphan and reclaimed only by an explicit stores rm of its shell.
  The sweep also tidies its own bookkeeping: a verdict sidecar whose backup
  is gone judges nothing, and is removed like any other sweep target.

  The exit status is the machine-readable half of the report. A --yes run
  that leaves sweep work behind — a refusal, a backup it could not delete,
  an orphaned sidecar it could not remove — exits as a partial completion,
  so `sweep --yes && ...` never sails past residue. One leftover is
  deliberately not partial: a sidecar stranded because its backup was
  deleted first judges nothing and self-heals on a later sweep, so the run
  that reclaimed the backup's bytes still exits as success. A bare run
  decides nothing and always exits as success, whatever it lists.

  Scenario: a bare sweep lists every backup and deletes nothing
    Given store "notes" has an eligible pre-migration backup of 308 KB
    And store "lectures" has an eligible pre-migration backup of 1200 KB
    When the user runs the backup sweep command with no flags
    Then each backup is listed on its own line with its store name and size
    And each backup is marked eligible
    And the output says to re-run with --yes to delete
    And both backup files still exist

  Scenario: the dry-run already reports what a --yes run would refuse
    Given store "notes" has an eligible pre-migration backup
    And store "lectures" has a pre-migration backup whose live store fails its integrity check
    When the user runs the backup sweep command with no flags
    Then the "notes" backup is marked eligible
    And the "lectures" backup is marked refused with reason "live store fails integrity check"
    And both backup files still exist
    And the exit status indicates success

  Scenario: a --yes sweep deletes every eligible backup and reports the freed total
    Given store "notes" has an eligible pre-migration backup of 308 KB
    And store "lectures" has an eligible pre-migration backup of 1200 KB
    When the user runs the backup sweep command with --yes
    Then both backup files no longer exist
    And each deletion is reported on its own line
    And the output states 1508 KB freed
    And a doctor run afterwards contains no backup section

  Scenario: a sweep scoped to one store touches only that store's backups
    Given store "notes" has an eligible pre-migration backup of 308 KB
    And store "lectures" has an eligible pre-migration backup of 1200 KB
    When the user runs the backup sweep command scoped to store "lectures" with --yes
    Then the "lectures" backup no longer exists and its deletion is reported
    And the "notes" backup still exists and is not listed
    And the output states 1200 KB freed
    # Added 2026-08-24, from running the sweep on real data during the
    # beta: "delete everything verified" and "keep the rollback I just
    # took" are both live wishes, and without a selector the only way to
    # honor the second was moving that backup out of the tree by hand.
    # The scope covers the whole pass — verification, deletion, and the
    # orphan-sidecar tidy alike.

  Scenario: a sweep scoped to a store that does not exist refuses by name
    Given store "notes" has an eligible pre-migration backup
    When the user runs the backup sweep command scoped to store "missing" with --yes
    Then the sweep refuses naming "missing"
    And the "notes" backup still exists
    # A typo silently sweeping nothing would read as "already clean".

  Scenario Outline: a --yes sweep refuses a backup <world>
    Given store "notes" has a pre-migration backup and <world>
    When the user runs the backup sweep command with --yes
    Then the backup file still exists
    And the refusal is reported with reason "<reason>"

    Examples:
      | world                                             | reason                           |
      | the live store file is missing                    | live store missing               |
      | the live store fails its integrity check          | live store fails integrity check |
      | the live store is below the current schema version | live store not at current schema |
      | the backup has no recorded migration verdict      | no migration verdict             |
      | the recorded migration verdict is failure         | migration verdict failed         |
      | the backup file itself cannot be opened           | backup unreadable                |
      | the backup is corrupt in a way that still opens   | backup unreadable                |
      | the live store is locked by another process       | live store cannot be checked     |

  Scenario: a --yes sweep refuses a verified backup whose live store is gone and names the reclaim path
    Given store "notes" has a pre-migration backup with a recorded success verdict and the live store file is missing
    When the user runs the backup sweep command with --yes
    Then the backup file still exists
    And the refusal is reported with reason "orphaned verified backup"
    And the refusal names stores rm as the reclaim path

  Scenario: a mixed sweep deletes the eligible and reports each refusal
    Given store "notes" has an eligible pre-migration backup of 308 KB
    And store "lectures" has a pre-migration backup whose live store fails its integrity check
    And store "scratch" has a pre-migration backup with no recorded migration verdict
    When the user runs the backup sweep command with --yes
    Then the "notes" backup no longer exists and its deletion is reported
    And the "lectures" backup still exists and its refusal names reason "live store fails integrity check"
    And the "scratch" backup still exists and its refusal names reason "no migration verdict"
    And the exit status indicates partial completion

  Scenario: a --yes sweep that cannot delete a backup reports it and exits partial
    Given store "notes" has an eligible pre-migration backup the filesystem will not let the sweep delete
    And store "scratch" has an eligible pre-migration backup
    When the user runs the backup sweep command with --yes
    Then the "scratch" backup no longer exists and its deletion is reported
    And the "notes" backup still exists and its failed deletion is reported
    And the freed total counts only the "scratch" backup's bytes
    And the exit status indicates partial completion

  Scenario: a --yes sweep that cannot remove an orphaned verdict sidecar exits partial
    Given store "notes" has a verdict sidecar file whose backup no longer exists
    And the filesystem will not let the sweep remove that sidecar
    When the user runs the backup sweep command with --yes
    Then the sidecar file still exists
    And its failed removal is reported
    And the exit status indicates partial completion

  Scenario: a sidecar stranded by its own backup's deletion is not a partial completion
    Given store "notes" has an eligible pre-migration backup whose verdict sidecar the filesystem will not let the sweep remove
    When the user runs the backup sweep command with --yes
    Then the backup file no longer exists and its deletion is reported
    And a note says the stranded sidecar is reclaimed by a later sweep
    And the exit status indicates success
    # The deliberate non-trigger (ruling in the sweep's exit comment and
    # tests/server/design/verdict-record.md): the promise --yes makes is
    # the BACKUP bytes, and they were reclaimed; the residue is derived
    # metadata the next sweep removes as an orphaned sidecar.

  Scenario: backup generations of one store are judged independently
    Given store "notes" has an eligible pre-migration backup from schema version 12
    And store "notes" has a pre-migration backup from schema version 17 whose recorded verdict is failure
    When the user runs the backup sweep command with --yes
    Then the version 12 backup no longer exists and its deletion is reported
    And the version 17 backup still exists and its refusal names reason "migration verdict failed"

  Scenario: a sweep with nothing to do says so and succeeds
    Given no store has a pre-migration backup
    When the user runs the backup sweep command with --yes
    Then the output states that no pre-migration backups were found
    And the exit status indicates success

  Scenario: a bare sweep reports an orphaned verdict sidecar and leaves it
    Given store "notes" has a verdict sidecar file whose backup no longer exists
    When the user runs the backup sweep command with no flags
    Then the sidecar file still exists
    And it is reported as an orphaned verdict sidecar

  Scenario: a --yes sweep removes a verdict sidecar whose backup is gone
    Given store "notes" has a verdict sidecar file whose backup no longer exists
    When the user runs the backup sweep command with --yes
    Then the sidecar file no longer exists
    And its removal is reported

  Scenario: hand-made .bak files are never swept
    Given store "notes" has a hand-made file "treecontext.db.bak" beside its database
    And store "notes" has a hand-made file "pre-migration-v12.bak" beside its database
    And no store has a pre-migration backup
    When the user runs the backup sweep command with --yes
    Then both hand-made files still exist
    And the output states that no pre-migration backups were found
