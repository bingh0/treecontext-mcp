# Spec — Resume-pointer lifecycle (supersession mechanism)

> **Historical note (2026-07):** this is a locked spec from the tree
> era, preserved unchanged. The mechanism it specifies — `supersedes` on
> insert clearing stale resume-pointer flags — still ships in the
> current flat journal (`src/core/types.ts` cites this file); references
> below to tree-era code (e.g. `tree.ts`) name files that have since
> been deleted or renamed, and store observations describe the
> development store of 2026-06-10.

> **Status:** 🟢 LOCKED v1.0 — all decision points resolved 2026-06-10
> (marked **DECIDED** inline). Changes after this point are logged in §5.
> **Date locked:** 2026-06-10 · **Scope:** make resume-pointer clearing a *mechanism*
> instead of agent discipline. Companion to the prompt-slimming workstream
> (instructions/AGENTS.md/channel-dedup), but independently shippable.

---

## 1. Problem (with live evidence)

Resume pointers are nodes tagged `metadata.next_session = true` or
`metadata.status = "active"` (`tree.ts` `_isResumePointer`). `getStatus()`
surfaces up to 8, newest first, and every instruction channel tells the agent
to `treecontext_export(node_id)` **each one** before doing anything else.

There is **no mechanism that clears the flags.** The documented protocol is
"delete + reinsert without, or insert a follow-up that supersedes" — but a
superseding follow-up only supersedes *in prose*; the data model never learns.
Observed in this project's own store (2026-06-10):

- 8 pointers in the panel; **6 are eval-execution pointers explicitly
  superseded in prose** by close-out node `12a1d847` ("Supersedes
  eval-execution resume pointers") — yet all 6 still carry live flags.
- Those stale pointers show `access_count` 21–116: each has been re-surfaced
  (and re-fetched, per the orientation protocol) across **dozens of sessions**.
- A review node written 2026-06-10 set `metadata.supersedes:
  "47854e7d…"` expecting it to mean something. It is inert. Agents already
  *reach for* this mechanism; it just doesn't exist.

Cost: the cold-start orientation flow exports N stale subtrees every session
(thousands of tokens + tool round-trips), and the panel's signal-to-noise
degrades exactly where signal matters most — session start.

**Why "fix the prompts" doesn't fix this:** clearing-on-completion is a
discipline that demonstrably fails even for an agent that wrote the
supersession sentence in the same breath. Lifecycle belongs in the mechanism.

## 2. Design

### 2.1 Supersession on insert (the core mechanism)

`treecontext_insert` gains an optional **`supersedes: string[]`** parameter
(MCP schema + `InsertOptions.supersedes`). At insert time, atomically with the
new node's insertion, for each target ID:

1. **Delete** the `metadata.next_session` key (**DECIDED:** delete rather
   than set-false — keeps metadata clean).
2. If `metadata.status === "active"`, set `metadata.status = "superseded"`.
3. Write trace fields on the target: `metadata.superseded_by = <new_node_id>`,
   `metadata.superseded_at = <unix_ts>`.
4. Mark the target dirty so the change persists (SQLite write-back path).

The target's **content, summary, position, and all other metadata
are untouched.** Supersession is a flag operation, not a content operation.

**DECIDED — `metadata.supersedes` alias: honored.** A `supersedes` key
(string or string[]) inside the `metadata` argument is normalized into the
same code path and stripped from the stored metadata (replaced by the trace
fields on the targets). Agents already write this key spontaneously (observed
above). Risk of silently "activating" historical inserts on re-import is
mitigated because supersession runs only at insert time, never retroactively.

**Amended 2026-10-08 — lanes (D169, D228).** The steps above run only for
a target in the inserting writer's own lane. The lane
(`laneWriterOf`, `src/references.ts`) is an imported entry's `handoff:`
session key; else no lane at all for a row stamped `_writer_src:
"ambiguous"` (it retires nothing); else `metadata._writer`, else
`metadata.agent_type`; else the main lane — an entry naming no writer, or
naming `_writer: "main"`, whichever session of the main checkout wrote it.
A linked worktree's main agent is `worktree:<name>`, its own lane.
`_writer` is stamped by the store, never taken from the caller (the insert
tool drops a caller's copy): at insert from the session registry, then
made exact at the drain by the call's own PostToolUse echo
(`src/persistence/writer-heal.ts`; amended 2026-10-08, D190, D240). So
the protection is in effect for real subagents once their hooks are
installed; until the echo drains (one ingestion tick, about five
seconds), a note stamped wrongly at insert acts in the lane it was
guessed into, and the heal then puts right what it did across lanes.
A target in another writer's lane is left untouched — no flag, no trace —
and its id is added to the new entry's `metadata.refs` instead (and to
`_supersedes_referenced`, so a heal that moves the entry into that lane
can perform the supersession); the reply lists it under `referenced`, and
the owning lane sees the new entry as `referencedBy` on search hits, a
fetch by id and the /clear packet (D186). When the insert is a dedup hit
those targets are reported as `supersede_misses` with reason
`other_writer`. See `src/references.ts`.

**Amended 2026-10-08 — the retirement keeps its prior.** Step 3 also
writes `metadata._superseded_prior` on the target: the flags it held and
any earlier retirement it carried (`retireMeta`,
`src/persistence/writer-heal.ts`), so the echo heal can undo a retirement
exactly. A bookmark (`metadata.kind = "bookmark"`) implies
`next_session = true`, and a new bookmark supersedes the previous live
bookmark of the same session chain (across /clears) in the same lane
automatically (D166).

### 2.2 Recall guarantee (the safety property)

A superseded node remains an ordinary node:

- findable by `treecontext_query` (all modes, unchanged scoring),
- fetchable by `treecontext_export(node_id)`,
- listed by nothing less, ranked by nothing less.

The **only** behavioral change is removal from the auto-fetch orientation
panel. The supersession trace (`superseded_by`) makes the demotion auditable
and manually reversible (re-insert/edit). This is what distinguishes this
design from the lazy version (a TTL that silently drops live threads).

### 2.3 Error handling

- Target ID not found: do **not** fail the insert. Record
  `supersede_misses: [ids]` in the insert response. Rationale: the insert
  content is the valuable payload; a stale ID must not block it.
- Target is `readOnly` (imported subtree): skip, report in
  `supersede_misses` with reason. Imported flags belong to the source store.
- Self-supersession (`supersedes` includes the new node's own would-be slot):
  impossible by construction (IDs assigned at insert); no handling needed.
- Duplicate IDs in the list: dedupe silently.

### 2.4 Auto-expiry — DECIDED: not in v1 (Option A)

Option A (adopted): **no auto-expiry in v1.** Supersession covers the
dominant observed failure (close-outs that supersede in prose). The remaining
leak — a pointer whose thread simply fizzles with no follow-up — is bounded by
the panel cap (8) and ordering (newest first).

Option B (rejected): demote pointers not superseded or deleted after **N** status-calls
(`access_count`-based, the counter already exists) with trace field
`metadata.expired_at`. Rejected for v1 because "surfaced N times" ≠ "no longer
live" — long-running threads legitimately surface for weeks (this repo's
Workstream A pointer was correctly live across 4+ sessions). An expiry
heuristic that can kill a live thread re-introduces the silent failure this
spec exists to prevent. Revisit only with evidence that fizzled-thread leakage
is material after v1 ships.

### 2.5 Prompt-surface change (bounded)

One line, in the single-sourced trigger content (post-A0; until then, in
`INSTRUCTIONS_BRIEF` + `INSTRUCTIONS_CONTENT` + `SESSION_REMINDER_TEXT`):

> When a new plan/close-out replaces an earlier one, pass
> `supersedes: [<old_node_ids>]` to `treecontext_insert`.

No new tool. No new always-on paragraph.

## 3. Acceptance criteria

| # | Criterion | Test |
|---|---|---|
| **L1** | Superseding insert atomically clears `next_session` and demotes `status:"active"` → `"superseded"` on every target, and writes `superseded_by`/`superseded_at`. | unit (tree) |
| **L2** | **Recall guarantee:** superseded node's content/summary/other-metadata unchanged; still returned by `query` (same rank as before supersession, ± nothing) and by `export(node_id)`. | unit (tree) + integration (server) |
| **L3** | **Panel hygiene:** seed a store reproducing the observed pileup (8 pointers, 6 prose-superseded); after re-inserting the close-out *with* `supersedes`, `treecontext_status` panel contains only the live pointers. | integration |
| **L4** | Missing/readOnly targets: insert succeeds, `supersede_misses` reported, no throw. | unit |
| **L5** | Persistence: flag changes survive store close/reopen (dirty-marking covers metadata-only mutation of an *existing* node — verify this path explicitly; it is the likeliest implementation bug). | integration (sqlite) |
| **L6** | MCP schema: `supersedes` param accepted; response includes `superseded: [ids]` + `supersede_misses`. `policy.test.ts` updated if schema-pinned. | server test |
| **L7** | Prompt cost: teaching line ≤ 120 chars, present in each trigger channel, covered by the AC6 drift test once single-sourcing lands. | unit (instructions) |
| **L8** | Backward compat: stores with legacy prose-superseded pointers behave exactly as today until a superseding insert touches them; migration is additive-only (no schema change expected — metadata is a JSON blob). | integration |
| **M1** | *Measurement, not gate:* `treecontext_status` payload tokens on this repo's store, before vs after retro-superseding the 6 stale eval pointers. Report in the PR. | manual |

## 4. Out of scope (explicitly)

- **Status response diet** (compact panel, suppressing zeroed stats blocks) —
  separate change, larger win, orthogonal mechanism.
- Single-slot resume pointer / panel redesign.
- Retroactive bulk-supersession tooling (the 6 current stale pointers get
  cleaned manually once, as the L3/M1 fixture).
- Auto-expiry (rejected for v1 per §2.4; revisit only with evidence of
  material fizzled-thread leakage).

## 5. Deviations log

- **2026-06-10 (implementation, same day as lock):** §2.3 claimed
  self-supersession is "impossible by construction." Wrong: dedup makes it
  possible — an insert whose content dedups *into* a node listed in its own
  `supersedes` would supersede the node it just returned. Implementation
  guards this: the target is skipped and reported in `supersede_misses` with
  reason `"self"`. The miss-reason set is therefore
  `not_found | read_only | self`.
