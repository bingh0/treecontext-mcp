# Adversarial review, round 2 — pin suites, fidelity suites, wip register, and the day's fixes

**Date:** 2026-07-31 · **Repo:** working tree after the round-1 fixes (uncommitted)
**Method:** three independent cold-context reviewers (same model, fresh context each): (1) the five
store pin suites round 1 read only at title level; (2) the five fidelity/hook suites plus a
reason-by-reason wip-register audit; (3) an attack on the round-1 fixes (archive-before-shrink
demotion) plus a mechanical whole-repo todo-drift sweep. Contested claims settled by probe against
a real store; probe outputs inline. Baseline before attack: full suite green (856 passed + 38 todo).

**Round-2 theme.** Round 1's disease was silent data loss. Round 2's is different: **correct
implementations whose promises are bound by nothing** (delete the code, the suite stays green), and
**fixtures whose discriminating variable is not the one the scenario names**. Plus two genuine
bugs in the round-1 demotion work itself (R1, R2).

---

## Tier 1 — bugs in shipped behavior (fix before beta)

### R1 — the valve and status measure "over budget" with two different gauges; over_budget can latch forever

`status()` sums `LENGTH(CAST(content AS BLOB))` (bytes, `src/flat-store.ts:890`);
`demoteOverBudget()` sums `LENGTH(content)` (**characters** for plain-TEXT rows under the 512-byte
codec floor, `src/flat-store.ts:1374`). The comment at `flat-store.ts:926` — "status and the valve
can never disagree" — is false for any non-ASCII TEXT row.

Probe: 100 CJK rows, budget 30,000 → `status.storeBytes=50690 overBudget=true`, sweep
`{evicted:0, demoted:0}`, over_budget **still true after**. The valve sees 17,400 "bytes" and
refuses to fire; the server's `storage_warning` then lies twice — the condition never clears, and
its stated cause ("remaining entries are protected") is wrong. Every CJK/Cyrillic-heavy store
systematically under-triggers demotion. **One-line fix:** `CAST(... AS BLOB)` in the valve's total
and `byte_len`.

### R2 — the demotion archive cannot be imported back while the stump lives

`writeNodesArchive` keeps original node ids and the demoted row is updated, not deleted — so
archive and store share ids. `importJson` does a plain `INSERT` (`nodes.node_id` PRIMARY KEY).
Probe: `import of demotion archive THREW: UNIQUE constraint failed: nodes.node_id`. Eviction
archives import fine (their rows were deleted); demotion archives — the round-1 ruling's whole
recovery path — do not. The importJson loop is also untransacted, so a mixed archive leaves a
partial import behind the throw.

The pin suites never catch this: every "recoverable from the demotion archive" assertion reads the
JSON file directly, never exercises restore-by-import. Recoverability is pinned as *file exists*,
not *store can take it back*. **Owner ruling:** import semantics for id-colliding rows —
skip-existing, replace-when-stump (upgrade the stump back to full), or remint ids. Replace-when-stump
matches the ruling's intent; whichever is chosen, wrap importJson in a transaction and add a
restore-by-import scenario.

### R3 — `mergeFromNamespace` ignores `opts.nodeId` (pre-existing, uncovered by three specs)

The interface, the merge tool schema ("Optional entry ID … to merge alone"), and the server
pass-through all promise single-entry merge; the implementation never reads `opts.nodeId`. Probe:
merge with one `nodeId` → `importedCount=3` (whole namespace). Also: the tool says "Label recorded
on the merged entries" — the label is only echoed, never stamped. Notably, the bound agent-surface
scenario "tool schemas describe only what the backend does" stayed green over this — its binding
does not cover argument semantics. The namespaces wip scenario "a merge names one entry id" would
bind **red** today, which is exactly why it should be bound now (see R12).

### R4 — clamp-at-zero savings estimate over-demotes compressible stores

Planning decrements `max(0, byte_len − utf8(idxText))`; for zstd-compressed rows `byte_len` is
tiny, so the decrement is ~0 and the plan keeps growing. Probe: 10 × 50,000-char compressible
prose rows (stored total 270 bytes), budget over by 50 → **all 10 demoted** when one sufficed, and
the store is *still* over budget. Formula unchanged from before, but full-view prose is newly
shrinkable, so a 50-byte overage can now narrow an entire prose corpus to the 2000-char floor in
one sweep. No content loss (all archived), but store-wide findability narrowing. Fix direction:
estimate savings against encoded size (or recompute the SQL total per iteration).

### R5 — dedup slot-stealing: Stop-hook double-fire is NOT suppressed when a foreign session interleaves

`fpAuto` holds one entry per fingerprint, overwritten on every non-dedup insert; the dedup check
requires same-session. Probe: sess-1 double-fire 20s apart with sess-2 interleaving the same
content → `dedup=false, totalNodes=3` (control without interleave: 1). The dedup feature header
promises double-fire suppression; no fixture in the suite can reach the interleaved shape. Two
servers draining backlogs of identical short messages ("ok", "proceed") is a realistic pattern.
Fix: key the auto map by (fingerprint, session) or keep per-session entries.

---

## Tier 2 — spec-integrity: promises bound by nothing (regression-one-away class)

### R6 — stop.feature's header contradicts the code's own docstring; the real guard is unpinned

Header: "never a tool_use block, **never an earlier turn's text**." `extractLastAssistantText`
deliberately scans past text-free turns to an earlier turn's text (its docstring says so), and the
compensating duplicate-guard `isStaleRecapture` (`src/hooks/stop.ts:37-55`) has **zero test
coverage anywhere** — delete its call and every stop scenario stays green. Fix: rewrite the header
to the honest contract (last assistant text in the transcript + staged-duplicate guard) and add:
transcript ending in a tool_use-only entry after previously-staged text → Stop fires → no second
staging row.

### R7 — conversation-window "hits win" (W7) is implemented and bound by nothing; and allocation actually follows display order, not rank

Deleting the pre-claiming set (`flat-store.ts:755`) leaves the whole suite green — traced through
the only multi-hit scenario, every assertion still passes. Separately, probe: with a
lexically-stronger *later* hit, the contested neighbor goes to whichever hit is **first in the
returned ordering** — under `sortBy: 'chronological'` that is not the higher-ranked hit, so the
scenario's "higher-ranked hit's window" wording (and the attachWindows docstring) is false; the
fixture passes only because its two hits tie. **Owner ruling:** spec says "earlier in returned
ordering claims first" (document reality) or implementation claims in rank order regardless of
sort. Then bind a hit-never-appears-as-neighbor assertion either way.

### R8 — content-codec zstd-fallback scenario is triply vacuous

Given is a declared no-op, the When hand-builds the flag-0x00 buffer instead of calling
`encodeContent`, and half the Then asserts the byte the test just wrote. Real residual coverage:
decode of flag-0x00 (genuine). Unpinned anywhere: the **encode-side** plain-fallback branch
(`content-codec.ts:54`). Fix: rewrite the scenario text to the decode contract it actually pins,
and inject the compressor via the existing `hasZstd` seam to pin the encode branch.

### R9 — tool-event-fidelity "identical previews with different full outputs are distinct nodes" is true by construction

The binding ingests the pair **outside** the dedup window (+3600s vs the 300s window), where two
nodes exist no matter what fingerprints cover — probe confirmed (outside window: 2 nodes even with
identical fingerprints; inside window, different tails: 2 nodes is the discriminating case). The
defect is in the feature wording itself ("outside any dedup window"). Fix: ingest both inside the
window, same session.

### R10 — role-weighted-fts: three bindings that don't touch what they claim to pin

- "role weights are validated at the query surface" calls `validateRoleWeights` directly — no
  query surface anywhere; drop `roleWeightVector` from `FlatStore.query` and it stays green.
- Migration-findability probes only **first tokens** (round-1 pattern (b) verbatim), and
  `buildLegacyStore` builds the "legacy" index with today's `indexTextFor` — partially
  self-fulfilling. No legacy row with post-insert-rewritten metadata (the FG-2 hazard for
  migration 013's recompute-from-current-metadata).
- "a query naming a column is not a column filter" tests a **private copy** of `buildFtsMatch`'s
  quoting, not production. Export it for the test or drive through `FlatStore.query`.

### R11 — smaller spec-integrity items

- **CW3**: anchor truncation at `ANCHOR_MAX_CHARS = 2000` (W5/W9) implemented, unbound.
- **D2**: dedup "outside the window" scenario varies both time and session; the session check
  short-circuits first — probe: same outcome at 1s. The time dimension is pinned only elsewhere.
- **D3/D4**: cross-source dedup bound in one direction only; "across sessions" Given faked.
- **RW1**: "all-ones weights reproduce the legacy ranking" is a synthetic-table SQLite-math demo
  (wrong tokenizer, no production code); relabel it as the engine pin it is.
- **RW3**: numeric default weights {1.0, 0.25, 1.0, 1.0} unpinned — ordinal user>assistant only.
- **B-A3**: ingestion byte-valve scenario never probes the budget-marginal middle session on
  either side (whole-session drop OR tombstone); pin the budget so all three fates are
  deterministic.
- **B-A4**: journal-library "bounded by the export node cap" asserts ≤5000 on a 3-row store.
- **B-A5**: journal-media bytes-absence scan misses codec-compressed byte copies (tripwire-grade;
  acknowledge in a comment or decode rows).
- **B-A6/A7**: stop.test.ts fixture is silently pre-016 (declare the tier like
  tool-event-fidelity does); tool-event-fidelity scenarios 3 & 8 migrate their fixture
  mid-scenario (comment-worthy only).
- **R-A5**: `_preview_len: 0` demotes a row to the empty string — unfindable forever, silently
  dropped by importJson. Valve should refuse a zero-length stump.
- **R-A6**: demoted marker leaks the absolute archive path into hit content (C4's marker
  deliberately routes through `treecontext_export` instead) and keeps advertising a deleted file;
  `writeArchiveFile` never fsyncs the directory entry; one SQL placeholder per victim caps a plan
  at 32,766 rows; retention-demotion S4's tool row is also the newer row (a newest-first
  implementation passes the tool-before-prose pin — age-invert the fixture).
- **Dead citation ×3**: `fts5-weighted.feature` cited by two feature headers and
  `src/persistence/fts.ts:39`; the file doesn't exist and has no retirement entry. Its
  per-column-normalization claim is also empirically falsified by flat-store-role-weights' own D1
  evidence (normalization is row-global).

---

## Tier 3 — the wip register has rotted (7 of 15 reasons stale or false)

Verified reason-by-reason against current src/ and test helpers:

| Entry | Verdict |
|---|---|
| storage "over-budget signal … unbuilt" | **FALSE** — shipped (`StatusInfo.retention.overBudget`, `storage_warning`), and contradicted by a comment in the same feature file saying it closed 2026-07-29. Bindable now. |
| journal-policy "per-policy spins don't exist" | **STALE** — `createServer(store, {policy})` + `tests/server/policy.test.ts` already do it; `mcpOver` needs a one-param extension. |
| journal-install "needs an installer harness" | **STALE** (harness half) — installer.test.ts + doctor-interpreter.test.ts run install/doctor/uninstall against a fake HOME. The honest remaining reason is the pending owner wording review (F8). |
| capture session-identity "combined harness is a later wave" | **STALE** — capture world + `ccSessionId` server option + identity ladder all ship; bind sketch in the audit. |
| storage poison "needs staging harness" | **STALE** — the same file already binds trigger-based fault injection; only the retirement-ordering clause needs new assertions. |
| recall latency panel "no deterministic slowness harness" | **STALE** — `CreateServerOptions.sessionStats` is a documented production seam; probe bound the hint with zero sleeps. |
| agent-surface AGENTS.md init "needs a CLI init harness" | **STALE** — `init` exists in cli.ts; the TSX_BIN spawnSync pattern is established; library-level idempotency already pinned. |
| recall index-cap knob | Self-conceded bindable (env override + spawnHook env param). |
| journal-namespaces (whole-feature) | Majority **bindable now** (isolation, scoped pointers, cross-namespace dedup, self-merge refusal, per-namespace clear). Single-entry merge binds **red** (R3) and provenance-stamp binds red until F5's remaining half — bind as the ratchet intends. |
| Still valid | dense pair (no dense path in src/), export-reliance eviction (no tracking), crash-mid-write (mostly — needs a SIGKILL script, not a harness class), broad-query default-recency ruling, session-start-protocol ruling, install owner wording review. |

Meta-finding: the gnt ratchet fires on bound entries but nothing ratchets stale *reasons* — they
rot within days of a wave landing. Consider a guard that greps each wip reason's named blocker
against the tree (crude but would have caught "unbuilt" vs the shipped over_budget flag).

---

## Checked and cleared (recorded so round 3 doesn't re-derive)

- **Round-1 fix quality**: crash-ordering of archive-before-shrink is sound (fsync strictly
  precedes the shrink transaction; failure direction over-honest). Refuse-without-archive reports
  honestly via over_budget + storage_warning. No archive accumulation on repeat sweeps; no double
  demotion; markers never enter FTS, exports, windows, or resume pointers; legacy demoted rows
  degrade gracefully; merge `_namespace` stamping doesn't collide with server stamping; protection
  carry-over verified; two-bucket ordering can't starve the budget check; yesterday's F2 vacuity
  is genuinely closed (S1 probes beyond-cap on both sides; S9+S9b jointly sound).
- **Todo-drift sweep: CLEAN.** All 246 step defines extracted and matched with gnt's own parser:
  every scenario in the 10 gnt features is bound or wip-covered, no over-registration, no title
  typos, no ambiguity; all 12 vitest-cucumber pairs match both ways; zero orphan features.
  (Sweep hazard: content-codec.test.ts contains literal NULs — plain grep drops it as binary; use
  `grep -a`.)
- **Strong suites, credit where due**: journal-media bindings (two-sided filters, raw-row
  inspection, refusal verifies zero rows); journal-library (independent second store handle,
  before/after watcher, real hook-subprocess comparator); role-weighted-fts atomicity scenario
  (real mid-table corruption, rollback verified), 4×4 attribution matrix, FG-2 metadata-rewrite
  attack; dedup's sliding-window scenario asserts its own fixture exercised the sliding case;
  content-codec NUL fixture is real (verified via od); ingestion-fidelity's poison trio.

## Suggested order of work

1. **R1** (gauge mismatch) — one line, plus a CJK regression test.
2. **R2** ruling + fix (import semantics for demotion archives) + restore-by-import scenario.
3. **R5** (dedup slot-stealing) and **R3** (single-entry merge) — real behavior bugs with clear fixes.
4. **R4** (over-demotion estimate) — fix alongside R1 since both touch the same accounting.
5. **R6–R10** spec-integrity repairs — each is a small binding or wording fix.
6. **Tier 3** — refresh the wip register's reasons; bind the seven bindable scenarios (two of
   which pin R3 red until fixed, which is the point).
7. R11 small items opportunistically.
