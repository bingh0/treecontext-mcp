# Review — /audit field run #1 over this corpus (2026-08-24)

*Findings from the first field run of the gherkin-node-test `/audit`
instrument (audit 0.1.0, judge Claude Fable 5, grading delegated to nine
same-model batches; ~908k tokens, seven minutes, 408 units). The full
report stays in the maintainer's scratchpad — the skill era writes nothing
into the repo but this note, placed by the owner. Findings, not rulings:
nothing here changes a fence or a scenario until the owner rules.*

## The headline

**design↔code is drifting.** `DESIGN.md` was authored in one sitting on
2026-08-15; 25 `src/` commits have landed since and the doc is untouched.
Two of its 29 prose constraints are now false, both by *ratified* work:

- **D16, `DESIGN.md:66-68` "one server per namespace, one drain per
  store"** — the server half was retired by amendment 8 (`7c6fe59`,
  2026-08-20; `src/server/cli.ts:1305-1307`, `server.ts:84-86`). The
  ruling lives only in `tests/server/design/store-as-arbiter.md §8` and
  was never back-propagated. The drain half holds.
- **D26, `DESIGN.md:105` "everything the tool writes is 0600/0700"** —
  `src/server/ccr-pane.ts:476,488` writes `~/.config/ccr/config.json` at
  0644 (`cfa8f43`, the first write outside `~/.treecontext`);
  `src/persistence/backup-verdict.ts:62` writes `.verdict.json` with no
  mode; installer wrappers are 0644/0755. `docs/security.md:100-105`
  promises 0600 only for db/beacons/backups — the sentence is broader
  than the contract it cites.

Two more are honored but overstated: D14 (dedup described as "a unique
constraint" — curated is a partial unique index, capture uses
`dedup_anchors`), D17 (adapters' `skipTools` filtering, suppressed by
fence J19). `ARCHITECTURE.md` is stale in three places (§6 "ladder
currently v23" vs max 24; §7 same-namespace `StoreLockedError` vs
amendment 8; §8 "session-identity v2 next after 0.1" vs landed same day).

## The binding layer is in good shape

406 claimed-done units, **380 solid**, 26 flagged — zero pro-forma, zero
near-side assertions, zero steering text, zero sanction markers. The flags
cluster into shapes, not files:

- **Absence with no control in the scenario's own world (14).** The
  positive that would prove the needle *can* fire lives in another
  scenario, another file, or nowhere. Worst cases: both privacy claims in
  `telemetry-privacy` (`tests/server/telemetry-privacy.test.ts:109-111,
  148`); the `fts-dual-cap` delete/update trio (`:83, :100, :146`);
  `journal-agent-surface` "never advertises machinery it lacks"
  (`features.test.ts:1431-1439` — `staleSummaryCount` is hardcoded 0 at
  `src/flat-store.ts:930`, so the assertion has no failing world).
- **Assertion real, fixture erases the failing world (5).**
  `conversation_window: 2` equals `DEFAULT_CONVERSATION_WINDOW`
  (`flat-store-conversation-window.test.ts:558`); default role-weights
  ranking inserts the expected winner first and `ORDER BY score ASC` has
  no tie-break (`flat-store-role-weights.test.ts:57-69`,
  `src/flat-store.ts:613`); three `search-modes` pruning scenarios assert
  only `length > 0` (`features.test.ts:3025, :3034, :2845`).
- **Cannot fail by construction (2) — look at these first.**
  `flat-store-c4-read-view :: supersede and demotion metadata rewrites
  never ghost the contentless index` (`c4-read-view.test.ts:222-233`):
  `query()` JOINs `nodes_fts` onto `nodes` (`src/flat-store.ts:599`), so a
  ghost posting never joins and the scenario passes in the exact world it
  exists to catch; the binding comment at `:226-228` describes a mechanism
  the JOIN makes false; the observable that *would* fail is the fts5vocab
  doc count (`:519-535`), which the binding never reads. FG-2 is
  currently unpinned. Also `journal-recall :: recall needs no embedding
  model` (`require.cache` can never see ESM modules, `:3247`).
- **Product-free (2, deliberate) + one dead Given.** The two engine-only
  scenarios (`role-weights` all-ones; `role-weighted-fts` bm25 arity) pin
  SQLite, not the product — the preambles say so; decide whether they are
  a design tier or retire them. `journal-agent-surface :: gap markers are
  explained…` inserts a capture-gap row no step reads (`:1453-1462`).
- **Blind (1).** `output-shielding.feature:12-16` states a shutdown-sweep
  contract with no scenario; only unit `it`s cover it.

## Fence hygiene (one pass clears ten)

- Undated: J26 (perf numbers), J27 (release engineering). **J27's
  condition was met on 2026-07-25** (deletion phase ended; 0.0.9-beta,
  `release-charter-0.1.md`, `release-gate.ts` all exist) — the entry
  stands unrevised and, undated, no bell can fire.
- 50 entries (19 journal, 31 server) carry only a section heading's date;
  the change-watcher reads trailing parentheticals and will see them as
  undated. Server fence: the 2026-08-12 amendment precedes the 08-11 one,
  and the eleven 2026-08-06 rejections sit under the 08-11 heading.
- Eight rulings cite external state with no resight condition: J9 (ORT
  format), J20 (tree-sitter, "1M-token contexts"), J24 (rename on npm
  availability), J25 (compaction, no `/clear` hook), S27, S30, S32, and
  the 2048-byte platform-cap literal at `features.test.ts:1444`. The
  scoping grammar's `Resights when:` line is the template.
- Stale comments: `features.test.ts:1672-1673` ("spec-ahead") and
  `:7028-7040` ("awaiting binding") describe scenarios the manifest shows
  passed.

## Suggested order for the next rc

1. Bring `DESIGN.md` to the build (retire D16, narrow D26, add a
   changelog, back-propagate amendment 8) — before the public flip, since
   the doc is the exemplar's front door.
2. The fence pass above.
3. `telemetry-privacy` controls; the c4-read-view ghost-index scenario.
4. The remaining absence and fixture thins, one control each.
5. Rule the two product-free scenarios and the shutdown-sweep gap.
