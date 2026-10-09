# Design: the migration verdict record

Design-tier companion to `backup-lifecycle.feature` (the fence defers
"verdict record storage and survival semantics" to the builder — this is
that decision, recorded).

## Where the verdict lives

A JSON sidecar beside the backup it judges:

```
stores/<name>/treecontext.db.pre-migration-v12.bak          the backup
stores/<name>/treecontext.db.pre-migration-v12.bak.verdict.json
```

Two scenarios force this location; neither admits the obvious
alternatives:

- **Not in the live store's database.** The orphan scenario (doctor
  points out a spared backup whose live store is gone) requires reading
  the verdict *after* the database is deleted.
- **Not inside the backup.** The refusal row "backup unreadable" requires
  reading the verdict when the backup itself cannot be opened — and
  writing into the backup would mean mutating the one file whose whole
  value is being an untouched twin.

The sidecar travels with the backup under a directory move or a machine
copy, dies with it under hand-deletion of the pair, and its filename does
not match the backup pattern, so it is invisible to doctor and the sweep
as a backup. Deleting a backup (sweep, rm, prune) always deletes its
sidecar with it. A backup without a sidecar IS the "no migration verdict"
state — the pre-verdict ML-lecture backup needs no special casing.

**Orphaned sidecars are reclaimed by the sweep** (amended 2026-08-11,
second-pass review). "The sidecar dies with its backup" can be violated
from outside — hand-deletion of the `.bak` alone, or a sweep whose backup
delete succeeded but whose sidecar delete threw. A sidecar without its
backup is derived metadata judging nothing, so the sweep removes any file
matching the exact `<recognized backup>.verdict.json` shape whose backup
is absent. This also makes the split-failure case self-healing: the run
that strands a sidecar reports it precisely (never "failed to delete" a
backup that is already gone), and the next sweep takes the residue.

## Record shape

```json
{
  "version": 1,
  "verdict": "success" | "failed",
  "backupEntries": 36,
  "migratedEntries": 36,
  "from": 17,
  "to": 21,
  "recordedAt": 1786050000
}
```

## The comparison

`SELECT COUNT(*) FROM nodes`, backup vs migrated store, strict equality,
run at migration completion while the exclusive open still holds the
store (nothing else has written — they are twins). Total row count rather
than `is_leaf = 1` because the backup sits at an old schema and the bare
count is the query most likely to be valid there.

Verified 2026-08-06: no migration in the ladder (001–019) deletes rows
from `nodes` or `trees`, so equality is the correct expectation for every
ladder the current code can run. **If a future migration legitimately
prunes rows, that migration must carry its own expected-count adjustment
— weakening the equality here to `>=` would reopen the false-pass hole
the interview closed.**

If either side cannot be counted (alien ancient schema, unreadable
backup), no sidecar is written: the honest degradation is "no migration
verdict", which the sweep refuses and doctor labels — never a guessed
verdict.

**The comparison runs only when the backup was copied in the same run**
(amended 2026-08-10, review finding #1). A retry that finds an existing
backup keeps it — that file is a *previous* attempt's pre-migration
state, not the twin of the store this run just migrated. Comparing
strangers can only produce a false verdict, and a false `failed` verdict
is actively dangerous: its loud warning names the stale copy as "the
intact pre-migration copy" and advises restoring it, which would replace
the store with older data. A kept backup therefore records no verdict —
the same honest degradation as an uncountable side.

The verdict is also recorded **before** the post-migration VACUUM
(finding #4): VACUUM never changes the row count but can run for minutes
on a large store, and a crash inside that window must not cost the
verdict.

## Failure surface

On a failed comparison the open still succeeds (the migration already
happened; refusing to open bricks a store whose rollback sits beside it)
but warns loudly on stderr at migration time, naming the backup file and
the one restore action. Ratified at the cold-read: doctor must not be the
first place a user learns their migration lost data.
