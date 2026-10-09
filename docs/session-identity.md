# Session identity: unifying the note↔conversation join (design note, 2026-07-06)

> Status: **IMPLEMENTED — historical design note.** The design below
> shipped: pid-keyed session beacons live in `src/session-beacon.ts`
> (written by `src/hooks/session-start.ts`, refreshed by
> `src/hooks/user-prompt-submit.ts`), and the session-key index landed
> as migration 015
> (`src/persistence/migrations/015_session_identity_index.ts`). Kept as
> history, not live spec — measurements and populations below describe
> a development store as of 2026-07-06. §6 concerns the since-deleted
> tree architecture and is struck. **§7 (echo-correlated identity,
> ruled 2026-08-14) is IMPLEMENTED as of 2026-08-15**: the heal lives
> in `Persistence.healCuratedSessionIdentity` + the drain gate in
> `src/server/ingestion.ts` (extractors in
> `src/server/echo-correlation.ts`), the §7.8 namespace channel in
> `src/session-beacon.ts` + the drain publisher, and the scenarios in
> `features/journal-session-echo.feature` and
> `journal-session-namespace.feature`. §7.7 records the design
> review's mechanism amendment (correlate by the node id the echo's
> own output names).
>
> **Since 2026-10-08 (0.1.0-beta.1)** two further uses ride the same
> machinery; this note does not otherwise describe them. The insert
> echo also sets the row's **writer** exactly: the echo carries the
> calling subagent's `agent_id`/`agent_type` (none for the session's own
> agent), and the drain calls `Persistence.healWriterFromEcho`
> (`src/persistence/writer-heal.ts`) beside the session heal, on a row
> the call created, of the echo's own session or of none, within
> `ECHO_HEAL_WINDOW_SECS` (60 s). Who may be writing is read from
> `session_registry` (migration 027), which the session-start and
> subagent hooks keep. And on a `/clear`, which mints a new session id,
> the session-start hook reads the predecessor id from the pid beacon
> before rewriting it and records the link in the store
> (`session_chain:<id>`, `src/checkpoints.ts`) — the beacon is the only
> place that link exists.

## 1. The defect

The store carries two session-id namespaces that are disjoint by
construction, plus a population with none:

| writer | field | value | population (measured 2026-07-06) |
| --- | --- | --- | --- |
| capture hooks (`post-tool-use.ts` etc.) | `metadata.session_id` | Claude Code session UUID from the hook payload | 8,530 of 9,064 nodes |
| MCP server, daemon path (`server.ts` `_session_id` injection) | `metadata._session_id` | **MCP connection id** supplied by the daemon | 146 of the 243 ballot notes |
| MCP server, stdio path | — | nothing | 97 of the 243 ballot notes |

Zero overlap between the two value sets. Consequence: **a curated note
cannot be joined to the conversation that produced it by id.** This
breaks, today: `conversation_window`/anchor for note hits (notes group
by connection id or fall into `__nosession__`), X1-style label joins
(the experiment had to repair around it with time windows), and any
future session-scoped feature. `flat-store.ts` `getSessionKey`
(`session_id ?? _session_id`) silently coalesces the namespaces, which
is how the defect stayed invisible: every query "worked," grouping
nonsense together.

Ambiguity is real, not theoretical: 130/243 ballots had tool events
from more than one live CC session in the 2 h before their creation —
concurrent sessions in one project are the norm in this corpus.

## 2. Requirements

- **R1** — new notes join their CC conversation by id, on both stdio
  and daemon transports.
- **R2** — concurrent sessions in the same project must not
  cross-attribute (last-writer-wins beacons alone are not enough; when
  attribution is uncertain it must say so).
- **R3** — additive schema/metadata change only; no rewrite of
  historical rows (append-only store discipline; migration v15-style).
- **R4** — historical data gets a *disclosed-quality* backfill, never a
  silently invented id.
- **R5** — the two namespaces stop sharing a lookalike name; the false
  join must become impossible to write accidentally.

## 3. Design: record both identities, resolve explicitly

**Rename, don't overload.** On insert the server records:

- `_conn_id` — what `_session_id` is today (MCP connection identity;
  keep writing `_session_id` unchanged during a deprecation window so
  nothing downstream breaks).
- `_cc_session_id` — the Claude Code session UUID, when resolvable,
  plus `_cc_session_src` recording HOW it was resolved:

Resolution ladder (first hit wins). *Revised 2026-07-06 after reviewing
the launcher (the ccs profile manager): ccs is a profile/runtime manager and
is NOT in the MCP path — it has no treecontext integration. In current
production, treecontext is a plain stdio server spawned per `claude`
process (instance `.claude.json` → `tc-mcp-serve serve --transport
stdio`). Verified live: the server's `process.ppid` IS the claude PID,
and our hook wrappers run as children of the same claude process. The
original ccs-header assumption is dissolved; PID binding replaces it
and is exact.*

*Narration correction (2026-08-24): "current production" in the
paragraph above and rung 1 below describes the v1 era this note
designed. Since the §7 v2 program landed (2026-08-15), curated-row
identity is healed from the echo channel (§7.3) and namespace
attribution resolves first by the payload-session-keyed annotation
(§7.8), with the ppid-keyed annotation as the rung below it. The
ladder below is kept as shipped history, not the live mechanism.*

1. **`pid`** — stdio path (v1 production; superseded by §7), race-free. The
   SessionStart hook wrapper captures the claude PID from its own
   parent chain (`$PPID` of the wrapper shell) and writes/refreshes
   `<store>/sessions/pid-<claude_pid>.json` containing
   `{cc_session_id, cwd, started_at, last_seen}` (also refreshed by
   UserPromptSubmit, and rewritten on resume — SessionStart fires again
   with the new session id for the same PID). The server lazily
   resolves at first insert: beacon with `claude_pid === process.ppid`
   → `_cc_session_id`, cached for the process lifetime. Exact under
   concurrent sessions (each claude has its own PID); no ambiguity
   flag needed on this rung. Staleness bound + rewrite-on-SessionStart
   guards PID reuse; resolve-early-and-cache guards orphaning
   (PPID → 1 if claude dies first).
2. **`explicit`** — future daemon/HTTP transport: the client supplies
   `X-Treecontext-CC-Session` per connection (the header mechanism the
   server already uses for `X-Treecontext-Namespace`). Not applicable
   to any current deployment.
3. **Beacon fallback if PID matching fails** (no beacon for our PPID,
   PID recycled) — *split in two by the v1.2 amendment (2026-07-24)*.
   As shipped, this rung tagged every pid-miss ambiguous and disclosed
   one candidate per beacon *file*; since beacons are pid-keyed, one
   session with several hook processes produced candidate lists of N
   identical uuids and a spurious ambiguity flag on every entry —
   observed live before the fix. The rung now resolves on the
   **distinct-id set** of live beacons (15 min staleness bound):
   - 3a. **`beacon-unanimous`** — every live beacon names the same
     session id. Certainty, not ambiguity: no flag, no candidates.
   - 3b. **`beacon-ambiguous`** — live beacons disagree:
     most-recently-seen wins, with `_cc_session_ambiguous: true` and
     the distinct candidate ids, most-recent-first. Degraded,
     disclosed.
4. **`absent`** — no `_cc_session_id`. Never guess silently.

*Open (v1.2): why the pid rung misses at all under current launches —
several live pid-keyed beacons for one session means hook processes see
varying PPIDs, and the server's own ppid matches none of them. The
unanimous rung makes the common case honest; the pid-miss root cause is
a separate investigation.*

**Query layer.** `getSessionKey` stops coalescing: group by
`session_id` (hook events) and `_cc_session_id` (notes) — now the same
namespace — falling back to `_conn_id` grouping only for legacy rows,
which keeps old behavior for old data without contaminating new joins.

## 4. Backfill (historical rows)

Additive only: a `session_backfill` side table (or `_cc_session_inferred`
metadata on export), computed by time containment against hook-session
activity intervals, with an ambiguity flag when intervals overlap (44 of
68 adjacent intervals do). Inferred ids are marked `src: "inferred"`
and are opt-in at query time. X1 already demonstrated the honest
version of this repair; productizing it is optional, not urgent.

## 5. Sizing and sequencing

Server resolution ladder + rename: small (one injection site + tests).
PID beacon in the hook wrappers: small (hooks already have the session
id; the wrapper already has `$PPID`). `getSessionKey` change: small,
but wants regression tests around window/anchor behavior. All
Sonnet-buildable against this note; adversarial review on the
`getSessionKey` change (it touches ranked retrieval behavior).
Sequence after the X1 run completes; nothing here blocks it.

## 6. ~~Sibling finding: internal nodes inherit leaf metadata on split~~

> **Struck — obsolete.** This section concerns MemTree leaf splits, part
> of the tree architecture deleted in the 2026-07-25 deletion phase. The
> flat journal has no internal nodes and no splits; the defect and both
> fix options no longer apply. Preserved verbatim below as history.

Verified 2026-07-06 on the live store: when a MemTree insert splits a
leaf, the resulting internal node retains the demoted leaf's full
metadata and `created_at` (including `files`), with content moved to
the child. Consequence: **metadata-filtered queries and exports return
internal-node duplicates of their own leaves** — the X1 label snapshot
caught 30 of them (previously misdiagnosed as a capture double-insert;
corrected here). Fix options, pick one at build time: (a)
metadata-filter paths exclude internal nodes by default (leaf-only,
flag to include); (b) stop copying selection-bearing metadata (`files`,
`type`, `status`) to internal nodes on split. (a) is safer — it fixes
the symptom for all historical data, not just future splits. Small,
test-pinned, separable from the session work.

## 7. v2 amendment (2026-08-13): echo-correlated identity — RULED 2026-08-14

> Status: **IMPLEMENTED 2026-08-15** (chunks A/B/C — see the top-of-file
> status note for the landing map). Drafted at owner request
> after the 2026-08-13 measurement session; the owner accepted the
> design and all four §7.5 proposals on 2026-08-14 ("basically ground
> truth" was the deciding property: a missing echo degrades to today's
> behavior, a wrong attribution is structurally impossible). Scenario
> drafts are embedded at the end; they move into a real feature file
> (with bindings) at implementation, which follows the strict per-chunk
> cycle (ruling 232b4219: design review → implementation → adversarial
> review) since it touches the drain and the session_key column.

### 7.1 What the measurements said (live store + beacons, ~1 month)

- **The §3 v1.2 open question is answered.** The pid rung misses
  because the hook wrappers' parent is an *ephemeral intermediate
  shell*, not the claude process: every prompt writes a fresh
  `pid-N.json` (verified live: one session left `pid-693003/709769/
  711418/712507`, one per prompt, each written once,
  `started_at == last_seen`, same `cc_session_id`). The server's
  `ppid` IS the claude pid (also verified live), but no beacon is ever
  keyed by it. Rung 1 has fired **zero times** in this store; all 71
  resolved curated inserts rode `beacon-unanimous`.
  The release-diff review (2026-08-15) confirmed the same root cause
  disables the C1 **namespace annotation** outright on Windows: the
  `.cmd` wrappers cannot exec, so the server's `pid-N.ns.json` is keyed
  by one intermediate `cmd.exe` while every hook resolves through a
  different one — `resolveHookNamespace` returns null on every Windows
  hook fire and all rows drain into the drain owner's serving
  namespace. Same defect class, same fix: v2's echo-correlated
  identity replaces the ppid bridge; until it lands, Windows
  namespace attribution is a documented no-op, not a subtle one.
- **The 15-min rung-3 window is the operative bound and it loses
  data.** 16 of 87 curated inserts (18%) resolved to nothing — exactly
  the inserts whose freshest beacon was older than 15 min, i.e. long
  autonomous stretches where the user is quiet but the agent works.
  Intra-session quiet gaps: p90 114 min, p99 549 min, max 10.3 h.
- **PID reuse is far away on this class of machine.** pid_max
  4,194,304, ~2.6 forks/s → wrap ≈ 6–19 days; observed recycles across
  1,932 beacon files: four, fastest 49.1 h. The 24 h rung-1 bound sits
  near the geometric midpoint of the observed separation (10.3 h legit
  quiet vs 49 h fastest recycle) — well-placed, but currently guarding
  a rung that never fires. On pid_max=32768 systems the distributions
  overlap and no constant is safe.

### 7.2 The insight: the capture pipeline is already a beacon

The PostToolUse hook captures treecontext's **own tool calls**. Every
`treecontext_insert` leaves an echo row in staging — composed preview
`Tool: mcp__treecontext__treecontext_insert\nInput:\n{json}` — stamped
with the hook's `session_id` (the real CC session UUID). Measured
coverage: 88 insert echoes against 87 curated inserts. The echo is
*causally* tied to the session that made the call: correlating it is
exact identity with no clocks, no pids, and no staleness window, and
it disambiguates concurrent same-project sessions — the one case no
freshness heuristic can ever resolve.

### 7.3 Mechanism: drain-time echo backfill

Insert-time behavior is unchanged: the existing ladder stamps its
best-known attribution (`explicit`/`pid`/`beacon-*`/absent). The new
work happens in the drain, which already sees every staged echo:

1. For each drained echo of a **mutating** treecontext tool call
   (`insert`, `import`, `merge_from_agent`), extract the target
   content prefix from the echo's composed preview.
2. Find curated rows whose `created_at` lies in
   `[echo_ts − W, echo_ts]` (W small, proposed 60 s; same machine,
   same clock — no skew) and whose content matches the extracted
   prefix. Matching is **normalized-prefix** comparison through the
   JSON escaping and the preview cap — the preview may truncate
   mid-string, even mid-escape-sequence, so the comparator works on
   the escaped form and discards a trailing partial escape. Never a
   parse of possibly-truncated JSON.
3. Stamp the match: `_cc_session_id` from the echo,
   `_cc_session_src: "echo"`, and — because `session_key` is an
   authoritative COLUMN (G5) — re-stamp the column through the shared
   `resolveSessionKey` derivation, in the same transaction. The
   backfill touches session identity only: never `fingerprint`,
   `dedup_class`, boundary columns, or content (the G5 split-stamp
   backfill is the shape precedent).

**Guards (each is a scenario below):**

- **Precedence.** Echo never overwrites `explicit` or `pid` (both
  exact). It DOES overwrite `beacon-unanimous`/`beacon-ambiguous`/
  absent — causal evidence beats a freshness guess — recording the
  displaced value as `_cc_session_prev` when it disagrees, so a wrong
  guess is countable (doctor material), never silently erased.
- **Dedup window.** An insert that dedups onto an existing row still
  produces an echo whose content matches the ORIGINAL row. The time
  window is the guard: only rows created within W of the echo are
  candidates, so a week-old row can never be re-stamped by today's
  echo. Additionally a row with `_cc_session_src: "echo"` is final.
- **Identical concurrent inserts.** Two sessions inserting identical
  content inside one window produce one row (curated dedup) and two
  echoes. Genuine ambiguity, disclosed:
  `_cc_session_ambiguous: true` + candidate ids, echo-order. Never
  pick silently.
- **No echo.** Capture off, hooks broken/killed, non-hook consumers:
  the row keeps its insert-time ladder attribution. A missing echo
  degrades to today's behavior — attribution may be absent, never
  invented. (E2a pinned that contributor-policy servers capture their
  own tool calls, so echoes exist under every tier that can insert.)
- **Durability.** The echo is a staged row; a crash or shutdown before
  the drain leaves it durable, and the heal lands on the next drain,
  next server start included. Late, never lost.

**Disclosed cost — eventual consistency.** Between the insert and its
drain tick the row carries only its provisional attribution; an export
in that gap shows the pre-heal state. This is the price of ground
truth arriving via the hook path, and it is disclosed, not hidden.

### 7.4 What this dissolves, what it leaves

- The **24 h vs 15 min tension dissolves** rather than being tuned:
  both constants stop being load-bearing for curated-note identity.
  They remain as shipped, governing only the provisional insert-time
  stamp that the echo upgrades.
- The pid rung stays as-is (exact when it fires; it currently never
  fires). The ancestry-walk fix (v1.2 open item) becomes optional
  hardening, no longer the main road.
- Adjunct, proposed alongside: rung 3 filters live beacons by
  `beacon.cwd === server cwd` — one line, kills cross-project
  ambiguity; same-project ambiguity remains rung 3b's disclosed case.

### 7.5 Open decisions — RULED 2026-08-14, all four as proposed

1. **Ruled:** echo overwrites `beacon-unanimous` on disagreement, with
   the displaced value kept in `_cc_session_prev`.
2. **Ruled:** correlation window W = 60 s.
3. **Ruled:** the cwd-narrowing adjunct for rung 3 ships with this
   work, not separately.
4. **Ruled:** both staleness constants (`PID_MATCH_STALE_MS` 24 h,
   `AMBIGUOUS_LIVE_MS` 15 min) stay untouched — they govern only the
   provisional insert-time stamp the echo upgrades, and stop being
   load-bearing for curated-note identity.

### 7.6 Scenario drafts (move to a bound feature file at implementation)

```gherkin
Feature: Echo-correlated session identity — the store's own capture
  attributes its curated writes

  The capture pipeline echoes every treecontext tool call back into
  staging with the hook's session id. The drain correlates each echo
  with the curated row it wrote and upgrades that row's attribution to
  exact, causal identity. A missing echo degrades to the insert-time
  ladder; it never invents an id.

  Scenario: a curated insert unresolved at write time is healed by its own echo
    Given a curated insert whose ladder resolution came up absent
    And the PostToolUse echo of that insert sits in staging
    When the drain runs
    Then the row carries the echo's session id with source "echo"
    And the row's session-key column agrees with the healed metadata
    # The 18% attrition case, closed: the echo arrives regardless of
    # how long the user has been quiet.

  Scenario: an export taken before the drain shows the pre-heal state honestly
    Given a curated insert awaiting its echo
    When the journal is exported before the drain runs
    Then the exported row shows the provisional attribution
    And the same export after the drain shows the echo attribution
    # Eventual consistency is disclosed, not hidden.

  Scenario: the echo outranks a freshest-beacon guess that disagrees
    Given a curated row the ladder attributed by beacon unanimity
    And an in-window echo naming a different session
    When the drain runs
    Then the row carries the echo's session id with source "echo"
    And the displaced guess is preserved in the trace field
    # Causal evidence beats a freshness heuristic — and the wrong
    # guess stays countable.

  Scenario: an exact insert-time attribution is never overwritten
    Given a curated row attributed by an explicit client header
    And an in-window echo naming a different session
    When the drain runs
    Then the row's attribution and source are unchanged

  Scenario: a dedup-hit echo cannot re-stamp the older original
    Given an old attributed curated row
    And a new identical insert from another session that deduplicated onto it
    When the drain processes the new insert's echo
    Then the old row's attribution and session-key column are unchanged
    # The correlation window is the guard: only rows created within
    # the window of the echo are candidates.

  Scenario: identical concurrent inserts from two sessions disclose their ambiguity
    Given two sessions that insert identical content within one correlation window
    And curated dedup collapsed them to a single row
    When the drain processes both echoes
    Then the row is flagged ambiguous with both session ids as candidates
    # Both sessions genuinely asserted this content; the store says so
    # rather than picking one silently.

  Scenario: a capture-disabled server's inserts keep their ladder attribution
    Given a server with capture off whose insert resolved by beacon unanimity
    When the drain runs with no echo present
    Then the row keeps the beacon attribution unchanged
    And no session id is invented

  Scenario: an echo stranded by a crash heals the row on the next start
    Given a curated insert whose echo was staged but the server died before draining
    When a new server opens the store and its drain runs
    Then the row carries the echo's session id with source "echo"

  Scenario: a preview-capped echo still correlates
    Given a curated insert whose content exceeds the echo preview cap
    And the echo's composed preview truncates inside an escape sequence
    When the drain runs
    Then the row carries the echo's session id with source "echo"
    # The comparator works on the escaped prefix and discards the
    # trailing partial escape — never a parse of truncated JSON.
```

### 7.7 Design review of §7.3 (2026-08-15, pre-implementation — per-chunk cycle, ruling 232b4219)

Four parallel readers over the landing surfaces (drain, session
identity/`session_key`, echo composition, dedup + corpus rules) at
6331ee5, plus an empirical sweep of the live store. Verdict: **the
design is sound and all four §7.5 rulings survive unchanged, but the
correlation mechanism in §7.3 steps 1–2 should be upgraded** — the
review found a strictly stronger correlator the original design
missed.

**R1 — the echo's Output section names the node id; correlate by id,
not by content prefix.** The composed echo is
`Tool: …\nInput:\n{…}\nOutput:\n{…}`, and for `treecontext_insert`
the Output is the tool's own response — `node_id` first key,
`deduplicated` alongside, both inside the 1000-char output cap in
every observed case. Live-store sweep: **23/23 insert echoes carry an
extractable `node_id` resolving to the exact curated row** (echo↔row
clock skew ≤ 0.1 s, far inside W), and 10 of the 23 rows sit at
absent attribution today — each would heal exactly. Extraction: the
first `node_id`-keyed 32-hex value after the first `\nOutput:\n`
marker (the Input JSON cannot contain a raw newline, so the marker is
unambiguous; escaping-tolerant regex, 0–2 backslash levels; never a
JSON parse). This dissolves the escaped-prefix comparator, the
key-order hazard (`content` may not appear in a 500-char preview at
all when metadata serializes first), the whitespace-normalization
mismatch with dedup identity, and the cross-tree search problem
(node ids are store-global). A failed insert's Output is the error
payload — no `node_id`, so failed-call echoes are skipped naturally.
No extractable id (missing output, foreign adapter format) → no heal:
degrades to the ladder, never invents. All four §7.5 rulings are
preserved: precedence and `_cc_session_prev` unchanged; **W = 60 s
remains load-bearing as the dedup guard** (a `deduplicated: true`
echo names the *survivor*, so only survivors created within W of the
echo may collect ambiguity candidates — a week-old row stays
untouchable) and as a sanity bound on `deduplicated: false` heals;
the cwd adjunct and both staleness constants are untouched.

**R2 — scope narrows to `treecontext_insert` only.** A
`merge_from_agent` echo's input carries no content and its output no
usable single-row identity; an `import` echo's 500-char input preview
covers only the export header while one call produces many rows —
neither satisfies the mechanism, and neither path stamps
`_cc_session_*` today, so nothing regresses. Their attribution stays
insert-time ladder; a missing heal is the disclosed degradation mode.

**R3 — write shape (the db-touching heart; adversarial-review
target).** The heal must NOT go through `updateNode`
(`store.ts` `updateNodeInTxn` rewrites FTS, deletes dedup anchors,
and `arbiterUpdateValues` can demote the row's dedup class). Shape: a
new dedicated store method, one **immediate transaction** per heal —
read the row's metadata, apply precedence/finality in code, then one
`UPDATE` writing `metadata_json`, `session_key`, and `updated_at`
together. The transaction is what makes this read-modify-write safe
(no writer can interleave between the read and the write; the
NON-transactional whole-blob RMW style elsewhere is the documented
lost-update hazard). `json_set` path surgery was considered at review
and dropped at implementation: the heal's shape variants
(candidate-set union, guess-artifact removal, conditional
`_cc_session_prev`) are not fixed paths, and inside the transaction
path surgery buys nothing. `session_key` is recomputed via `sessionOf` on the healed
metadata, never hardcoded. Candidates are `dedup_class IN ('curated',
'curated_dup')` — never `'auto'` (an auto row's `dedup_anchors` PK
embeds `session_key`; re-stamping would desynchronize the dedup
window). Idempotent by value: replay of an echo (staging claim-expiry
can double-process) recomputes the same result; `_cc_session_src:
"echo"` finality and the ambiguous candidate *set* are enforced
inside the transaction, so re-runs never append duplicates or
re-displace `_cc_session_prev`. FTS is untouched by design —
`indexTextFor`/`attributeColumn` read none of the healed keys.

**R4 — drain integration.** Seam: the ingestion row loop, gated on
`role === 'assistant'` and `toolName` ending `__treecontext_insert`
(suffix, not the `mcp__treecontext__` literal — the client config key
sets the prefix). Per-row cost is one indexed lookup plus one guarded
UPDATE, inside the tick's 500 ms budget. The heal is keyed by the
extracted node id, so the echo's own namespace stamp (NULL on every
Windows hook fire) plays no routing role — the Windows identity gap
closes. Two honest caveats join the durability guard: an echo deleted
by the **byte valve** or **dead-lettered as poison** never heals its
row (the `[capture gap]` tombstone is the disclosure — "late, never
lost" holds only for rows the drain actually processes), and the
`CcSessionSrc` union plus doc comments asserting "historical rows are
never rewritten" (`dedup-identity.ts`, `flat-store.ts` unshrinkable
cache) must be amended in the same change that makes the heal real.

**R5 — scenario deltas from §7.6 (owner-review territory at the
feature-file diff).** All scenarios map onto the id-correlator
unchanged except one: *"a preview-capped echo still correlates"*
becomes an Output-section claim (input-preview truncation is
irrelevant to correlation; the tail carries the full input anyway for
every overflowing insert). One scenario is added: *a failed insert's
echo heals nothing* (no `node_id` in an error Output). The
identical-concurrent-inserts scenario keeps its ruled ambiguity
semantics even though `deduplicated` flags could name the creator —
both sessions asserted the content; the store discloses rather than
picks.

**R6 — the Windows *namespace* promise. RULED 2026-08-15: into the
v2 program, before RC.** The 0.1.0-rc.1 CHANGELOG known-limitation
says v2 "replaces the whole pid bridge." For *identity* the ruled
§7.3 mechanism does. For **namespace attribution** it did not:
`resolveHookNamespace` still resolves by ppid-keyed annotation, so
Windows capture rows would keep draining into the serving namespace
after v2 landed. The review surfaced this as an open scope question;
the owner ruled it fixed before RC rather than documented ("rc is as
good as you can make it" — a defect classified as not-RC-affecting
is a signal to fix, not to defer). The fix is designed as §7.8 below
and ships as the program's third chunk; the CHANGELOG entry comes
out truthfully, disclosing only the §7.8 residual.

### 7.8 Chunk C design (2026-08-15): session-keyed namespace annotation — the pid bridge retired

The hook always knows its CC session id exactly (payload field); what
it cannot learn on Windows is which *namespace* its session's server
serves, because the only ambient server↔hook link is process
ancestry and the `.cmd` wrappers break it. §7.3's insight applies
unchanged: **the echo stream is a causal channel from session to
server.** Every treecontext tool call from session S is served by
S's own lane's server, and two echo shapes betray that server's
namespace inside the 1000-char output cap:

- a `__treecontext_status` echo — the response's `"namespace"` field
  (measured on the live store: 6/6 status echoes carry it at offset
  ≈187 of the Output section; the session-orientation protocol calls
  `treecontext_status` first thing in every session, so this channel
  fires at session start, not at first insert);
- a healed `__treecontext_insert` echo — the §7.3 heal already
  yields the (session → healed row's tree) pair.

**Mechanism.** The drain — already the single lease-serialized
consumer of every echo — publishes
`<store>/sessions/session-<uuid>.ns.json`
`{namespace, derived_from: "status-echo" | "insert-heal",
written_at}` when it processes either shape, refreshing on newer
evidence (last writer wins; conflicting evidence within one session
means the session really did talk to two servers, and the annotation
tracks the most recent — disclosed, not resolved). Hook-side,
`resolveHookNamespace` gains a first rung: the annotation keyed by
the hook's **payload session id**, exact and pid-free; the ppid-keyed
annotation remains as the rung below (it is instant from server
startup where exec works, while the session rung needs one echo to
prime). The pid-keyed file's liveness/staleness guards stay; the
session-keyed file needs neither — session ids are never recycled (a
resume mints a new id, §3 rung 1), so a session annotation can only
ever describe the session it names. One file, one writer: only the
drain owner writes `session-*.ns.json`, mirroring the C1 discipline.

**Honesty contract, unchanged.** The annotation is published from
**exact, causal evidence only** — never from `beacon-unanimous` or
any freshness guess. A wrong session-keyed annotation would misroute
capture rows *silently*, which is strictly worse than today's
disclosed drain-owner fallback; a missing one degrades to exactly
today's behavior. Same shape as §7.3: heal when certain, disclose
when not, never invent.

**Residual (disclosed).** Rows captured after SessionStart but
before the drain processes the session's first status/insert echo
still stamp no namespace and drain into the serving namespace — on
multi-lane Windows that is a bounded startup window (one drain tick
past the orientation status call, ~seconds), not a permanent no-op.
Single-lane installs are unaffected (serving namespace is the right
answer). This residual is what the CHANGELOG discloses in place of
the removed known-limitation.

**Scenario drafts (chunk C; move to the bound feature file at
implementation):**

```gherkin
  Scenario: a status echo teaches the store which namespace a session's server serves
    Given a session whose orientation status call left an echo in staging
    When the drain processes the echo
    Then the store carries a session-keyed namespace annotation naming the serving namespace
    And a later hook fire from that session stamps that namespace with no ancestry lookup

  Scenario: a healed insert corroborates the session's namespace
    Given a session with no status echo whose curated insert was healed by its echo
    When the drain processes the insert echo
    Then the session's namespace annotation names the healed row's namespace

  Scenario: a beacon guess never publishes a namespace annotation
    Given a server that resolved its session id only by beacon unanimity
    When its session produces no echoes
    Then no session-keyed namespace annotation exists for that session
    And hook fires resolve through the pid rung or not at all

  Scenario: capture rows staged before the first echo keep today's routing
    Given a session that has produced hook events but no treecontext echoes
    When the drain processes those events
    Then the rows drain into the serving namespace as before
    And no namespace is invented

  Scenario: the session rung outranks the pid rung when both resolve
    Given a session-keyed annotation and a live ppid-keyed annotation that disagree
    When a hook from that session resolves its namespace
    Then the session-keyed namespace wins
    # The session rung is causal; the pid rung is ancestry inference.
```
