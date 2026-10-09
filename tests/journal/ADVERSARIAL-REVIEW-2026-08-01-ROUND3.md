# Adversarial review, round 3 — the round-2 fix wave, the tier-3/critic-5 test work, and the ruling commit

**Date:** 2026-08-01 · **Baseline:** commits `69bcb57` + `2677ade` (pushed)
**Method:** three independent cold-context reviewers (same model, fresh context each), disjoint
scopes: (1) the ruling-implementation commit `2677ade`; (2) the 2026-08-01 test-layer work
(namespaces bindings, wip-register refresh, round2-regressions pins, README registers); (3) the
round-2 fix wave in `src/flat-store.ts`, which no cold reviewer had ever read. Tree shared
read-only across reviewers, so no mutation testing this round (that discipline ran at creation
time); contested behavior settled by probe against real on-disk stores. Every T1 probe was
independently re-run by the synthesizer before this document was written.

**Round-3 theme.** The bindings and pins from the last two rounds largely held (see the cleared
lists — the R4 pin has ~6× margin, the namespaces bindings discriminate, the ratchet is real in
both directions). What this round found instead: **edge machinery around the round-2 fixes that
no test reaches** (fingerprint hygiene, session-key coercion, rollback scope), and **a served
default that escaped its ruling's boundary** on the very day it landed.

---

## Tier 1 — shipped-behavior bugs (silent data loss / wrong results)

### S1 — Evicting zstd-compressed rows leaves stale `fpAuto` entries; re-importing the session's own archive silently drops every ≥512-byte row

`src/flat-store.ts:1218-1220` forgets fingerprints only `if (typeof r.content === 'string')` —
rows at or above the 512-byte codec floor are Buffers and are skipped. `importIsDuplicate`
(`:326-337`) has no `nodeExists` re-check (unlike `insert()`), and the archived row's
`createdAt` equals the stale entry's `lastSeen` (Δ=0 ≤ 300s window) → skipped as duplicate.
Probe: evict a session holding one compressed and one plain row → archive holds 2 nodes;
re-import restores **1**. The restore path the tombstone advertises no-ops for exactly the
store's bulkiest rows. **Fix:** forget via `decodeContent` unconditionally; add a `nodeExists`
guard inside `importIsDuplicate`.

### S2 — Non-string `session_id` → eviction writes an EMPTY archive, then hard-deletes the rows

`src/flat-store.ts:1250-1262`: JS grouping stringifies the session key (`sessionOf`); the
archive's SQL re-match (`COALESCE(json_extract(...)) = ?` with `String(id)`) does not — SQLite
never equates INTEGER 123 with TEXT '123'. The delete loop uses the in-memory-grouped rows;
the archive matched nothing. Probe: two rows under `session_id: 123` → sweep evicts 2, archive
holds **0 nodes**, tombstone claims "2 entries". Permanent unrecoverable loss; metadata is
caller-controlled (MCP insert, importJson), so numeric ids are reachable. (The same comparison
divergence silently empties conversation windows for such rows — lesser, same root.) **Fix:**
archive by the already-grouped node-id list via `writeNodesArchive`; never re-match the key.

### S3 — `importJson` rollback does not undo in-memory fp-map mutations; the retry silently imports 0

`src/flat-store.ts:1003-1061`: map mutations run inside the transaction callback; on a
mid-import throw the DB rolls back, the maps keep entries for never-committed node ids. The
throw is reachable: `node_id` is a global PK but the collision check at `:1041` is tree-scoped,
so importing an export into a different namespace of the same DB hits
`SQLITE_CONSTRAINT_PRIMARYKEY` (that failure is itself S8). Probe: failed import → rollback ok;
retry with only the good row → `importedCount: 0`. Stump variant (trace): a rolled-back stump
restore leaves the full-content fingerprint pointing at the live stump node — `nodeExists`
passes — so the next real capture of that content dedups onto the stump and is swallowed.
**Fix:** buffer map mutations, apply after commit.

### S4 — The 0.5 recency default leaks into `sort_by` temporal queries and reshapes which entries a chronological listing contains

`src/server/server.ts` computes `effectiveRecency` without consulting `sort_by`, and the server
never passes `sortBy` to the store (it re-sorts in JS) — so the store's own relevance-only
guard (`flat-store.ts:588`, "an explicit chronological sort already IS a recency decision")
never fires for MCP calls. Fusion runs inside candidate SELECTION for every temporal query that
omits `recency_weight`, against the schema's own "Relevance ordering only" promise. Probe:
`sort_by: chronological`, "history of X" → the strongest-lexical oldest entry is evicted from
the answer and an unrelated fresh entry injected. No test catches it: the charter's temporal
binding queries the store directly, bypassing the MCP layer. **Fix:** gate the default on the
`relevanceOrdered` predicate the shadow arm already uses.

---

## Tier 2 — spec-integrity and API honesty

- **S5 — nodeId-scoped merge of already-present content reports success-shaped nothing**
  (`flat-store.ts:1097`): dedup `continue` → `{importedCount: 0}`, no error, no dedup flag. The
  caller named one entry and cannot distinguish "already in trunk" from "vanished". Surface
  `deduplicated: true` + the existing node id.
- **S6 — Merge imports `next_session`/`status:'active'` wholesale**: trunk resume pointers get
  armed by agent-namespace plans (probe: merged plan appears in trunk's resumePointers). No
  ruling says merged entries should arm trunk pointers. Owner call: strip by default or opt-in.
- **S7 — `mergeFromNamespace` is not transactional** (contrast the R2 fix for importJson): a
  mid-loop failure commits a partial merge. Same fix shape as importJson (+S3's buffered maps).
- **S8 — Cross-namespace import of a same-DB export fails wholesale with a raw PK constraint
  error** (tree-scoped collision check vs global PK). Loud but opaque, undocumented, and it
  triggers S3. Detect cross-tree collisions explicitly (mint fresh ids or skip-with-count).
- **S9 — Cross-namespace dedup binding discriminates handle identity, not namespace**
  (`features.test.ts`, namespacesDefiner): both handles open before any insert, so their
  in-memory maps can never collide regardless of namespace — the scenario outcome is true by
  construction (probe: same result with both handles in the SAME namespace). The one seam where
  namespace scoping is load-bearing — the tree-filtered warm-up scan — is never exercised.
  Fix: open the second handle after the first insert; keep the same-namespace warm-handle
  collapse as the control.
- **S10 — The adaptive exemption exists only in a source comment**: the `recency_weight` schema,
  the `adaptive` schema ("combined with recency_weight, always so [flat]" — now wrong), and the
  skill body all promise the default unconditionally. The exemption is correctly implemented
  and bound; the promise agents read is not the behavior. State it on all three surfaces.
- **S11 — Channel-binding provenance comment is false for two of four channels**: "the exact
  bytes install writes to disk (installer.test.ts pins that they land there verbatim)" — the
  verbatim disk pin exists only for the skill; AGENTS.md is pinned by markers + one tool name,
  and the reminder script's on-disk content is never content-asserted. Pin the written script
  and block to contain their constants, or scope the comment to constant-level binding.
- **S12 — The gate-phrase regex is satisfiable by an inverted gate**: constructed text
  ("Respond to the user first… Only then … check treecontext_status — the user is waiting")
  passes both assertions while teaching the opposite. Require the gate to follow the last
  protocol-step mention, or pin the gate clause per channel.

---

## Tier 3 — hygiene (condensed)

- `unshrinkable` never pruned on `delete()`/stump-restore (import-supplied id resurrection is
  invisible to the valve for the process lifetime).
- `writeArchiveFile` fsyncs the file, not the parent directory (dirent can be lost on crash).
- `IMPORT_MAX_JSON_BYTES` enforced against UTF-16 `json.length` (~3× under-enforcement).
- Imports/merges bypass `insertsSinceSweep` — a 5 MB import waits 50 organic inserts for a sweep.
- Chained merges overwrite `_merge_label` (provenance chain lost); whole-namespace merges copy
  tombstones into the trunk.
- Stale instrument contract in `query-telemetry.ts` + test file headers (pre-inversion prose).
- `dbg` logs `rw: 0` for defaulted queries that ran at 0.5 (use `effectiveRecency`).
- This machine's installed skill (`~/.claude/skills/treecontext-reference`) predates the ruling
  — refreshes only on reinstall (operational note, not repo state).
- CHANGELOG has no line for the recency default — a served-ranking behavior change.
- By-name capture refusal is parse-only; `install()` accepts a blanket `experimentalCapture`
  unvalidated (unreachable publicly today via the exports map — defense-in-depth).
- `--agent --experimental-capture` swallows the flag as an agent NAME (refusal dodged into
  "No matching agents found"; reject `--agent` values starting with `-`). Relatedly, installer
  silently drops unmatched names when at least one matches.
- README legacy-register row for `flat-store-role-weights` claims the 4×4 matrix and FG-2
  attack that belong to the `role-weighted-fts` row below it (miscopied from the round-2 doc).
- The storage-poison wip reason names ingestion-fidelity's `poisonWrapper` (a seam) as the
  trigger-based harness; the real no-seam trigger harness is journal-capture's gap-marker
  binding in features.test.ts. Conclusion stands; named artifact wrong.
- The migration-harness wip reason overstates the blocker: migration-002/003/004/015 tests are
  exactly the open-old-schema-with-today's-code pattern; what's missing is a charter binding.

---

## Checked and cleared (so round 4 doesn't re-derive)

- **R1 gauges**: both LENGTH sites CAST AS BLOB over the same row set; status() and the valve
  cannot disagree; staging gauge separately BLOB-cast.
- **R2/R3/R4/R5 core paths**: stump restore round-trips (probe), double import idempotent,
  forged shorter-than-stump import refused; stump merge carries markers/protection correctly;
  unshrinkable staleness unreachable through shipped writers; all-victims-unshrinkable sweep
  stays honestly over-budget; savings accounting exact (encode-identical); fpAuto warm-on-open
  tree-scoped and newest-per-key; chunked IN clause correct; zero-length-stump guard holds;
  demoted marker cannot enter FTS/exports/archives/windows; test seam unexported and safe.
- **Namespaces bindings** (except S9): isolation two-sided, pointer control real, provenance
  asserted on raw rows with a no-`_namespace` precondition, single-entry merge detects both
  over-copy and move, clear tree-scoped with controls. gnt ratchet verified bidirectional at
  the runner source level.
- **R4 pin**: ~6× margin over the failure threshold, budget derived from measured bytes, fails
  red (never false-green) if zstd drift ever collapses the saving.
- **Recall binding**: in-test opt-out probe makes the fixture self-verifying; a
  reverse-chron-only fake fails `toContain(oldId)`.
- **Adaptive exemption**: genuinely bound by the flywheel scenario (flat: false under the
  default); explicit `adaptive: false` behaves as ruled.
- **Recency default hygiene**: latency panel and session stats undistorted by the shadow arm
  (recorded pre-shadow; store query side-effect-free); policy tiers uniform; opt-out reaches
  pure BM25 end to end; no stale "off by default" claims in repo docs; negative/NaN weights
  rejected at the schema.
- **No blanket-capture bypass**: flag has no env/config source; `--agent <name>` scopes the
  whole install; deep import blocked by the exports map; naming a verified agent writes no
  unverified capture.
- **Register claims** (tier-3 refresh): every named file/seam verified real and doing what the
  reason claims, except the two misattributions above.

## Suggested order of work

1. **S2** (empty-archive eviction) — data loss with a lying tombstone; archive by node-id list.
2. **S1 + S3** (fingerprint hygiene) — one fix shape: decode-before-forget, `nodeExists` in
   `importIsDuplicate`, post-commit map application (S7's transaction joins here).
3. **S4** (temporal leak) — one-line predicate reuse; add an MCP-surface temporal binding so
   the class stays caught.
4. **S5/S6/S8** — owner rulings on merge semantics (dedup reporting, pointer stripping,
   cross-tree id collisions), then small fixes.
5. **S9–S12** — binding/comment repairs; re-bind dedup with the warm-handle construction.
6. Tier 3 opportunistically; CHANGELOG line with the S4 fix.
