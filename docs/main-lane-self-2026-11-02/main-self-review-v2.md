# Review v2: the main checkout's half of D167 (draft v2, D372–D376)

Reviewer: adversarial re-review, read-only, `beta.3/node-sqlite` at add7004.
Inputs: main-self-brief.md, main-self-review.md (F1–F18), main-self-rulings.md
(R1–R7a, settled), main-self-draft-v2.md. Every factual claim below was checked
against the code, the docket, the features and the fence. The docket was linted
on a scratch copy (`docketry lint`, features copied to scratchpad/lint/, draft
entries and scenarios appended; before 45 findings, after 67).

## Verdict

**Not ready to ratify. Three blockers, six majors. The direction is right and
most of v1 is closed.** v2 applies R1, R2, R3 and R5 faithfully. Its premise on
the new ground checks out: the drain stamps no writer on a session's own
captures (ingestion.ts:637-646; references.ts:97-103). The blockers:

1. D374 scopes *every* default search, because D264 allows no orientation
   parameter. That breaks the [V] ruling D147 ("the orchestrator can see and
   search a summary of the subagent's work") and the handoff scenario's "B
   searching finds that summary" (D151). v2 says existing scenarios are
   unaffected. They are not.
2. Two amendments contradict entries that are still in effect. D376 restates
   D235's original single-live `registry` stamp, which D240/D244 replaced.
   D374 overturns D240's whole-store rule for `concurrent`/`ambiguous` callers
   without amending D240.
3. The recovery row the drain writes carries no session and no writer
   (ingestion.ts:587-598). D375's "scoped to that lane" therefore still files a
   worktree's recovery row in main's lane. This is the D286 drain-write specimen
   again.

The proposed stamp-on-open (D376 b) is not needed. A query-time lane read from
the registry is smaller and safer, and it is also the fix for blocker 1.

## Findings

**F1. blocker. Ladder: absent (a [V] promise silently broken). D374 scopes away
what main must find.**
Evidence: features/journal-orchestration.feature:17-22 (@D147 [V],
DOCKET.md:1034-1036), binding at journal-orchestration.steps.ts:421-426, which
asserts `res['scope']` undefined and finds the tester's report. The report is
stamped `_writer` = the tester's role (ingestion.ts:641-646), so main's lane
scope (`_writer` main or none) excludes it. Also @D263 "the orchestrator
searching the report's own words finds it" (orchestration.feature:28): writer
`claude-code`, excluded. Also journal-handoff.feature:40 (@D151 [I>V]): the
import lives in a `handoff:` lane (AGENTS.md; references.ts:99), excluded.
Possibly journal-workers.feature:93 (a first-moment row in a worker's lane).
D264 rules out an orientation-only parameter, so R4's "orientation search" is
the default search. Fix (resolvable from the record, since D147 is [V] and
outranks an [I] amendment): define a lane's default search scope by **the
sessions that ran in that checkout**, not by `_writer`. Replacement clause for
D374's resp:
"a search by the session's own agent, in the main checkout or in a linked
worktree, defaults to its own lane: the rows of every session the registry
places in that checkout, the session's own agent's, its subagents' reports and
trails and the client's own summaries alike, the entries imported in that
checkout, and, for the main lane, the rows of sessions the registry never held,
written before the store recorded writers; never a row stamped as of an
undetermined writer; the entries its live pointers and briefs reference, one hop"
Add to the scenario list: "Existing @D147, @D263 and @D151 searches keep finding
what they find. Their bindings run from a placed main session and assert the
scope block names the main lane." Workers launched through the ticket door have
their own sessions. By door parity with subagents, a leg's summary row whose
parent session is in the lane is in scope and its trail is not. The key lookup
reaches the rest (D336). See Q1.

**F2. blocker. Docket: amendments that contradict entries still in effect.**
(a) D376 "amends D235" but restates D235 as first written: "exactly one live
subagent, that subagent with `_writer_src` `registry`". D240 (DOCKET.md:1738,
"amends D235") replaced that with the `self`/`concurrent`/`provisional`/
`ambiguous` insert stamp and the echo heal, and D244 amends D240. The build
follows D240 (session-registry.ts:386-408). Under the grammar ("an amends entry
restates its target in full and is the target's effective shape"), D376 would
bring back the superseded rule. Replacement for that clause of D376's resp:
"a row written through the tools is stamped at insert from the registry's
reading and corrected at the drain by its own echo, as D240 and D244 rule; with
no subagent live, the self, `main` in the main checkout and `worktree:<name>` in
a linked worktree, with `_worktree` and `_branch`"
(b) D374 sends `concurrent`/`ambiguous` callers to "the session's own lane".
D240's resp (still in effect, DOCKET.md:1738) says "a `concurrent` or
`ambiguous` caller searches the whole store with the reply's scope saying why".
D374 amends D237, not D240. Fix, resolvable from R7's own reasoning (a caller
that cannot be told apart is not folded into a lane): keep D240. Replacement:
"a caller that cannot be told apart from a live subagent, `concurrent` or
`ambiguous`, searches the whole store as D240 rules, the reply saying why".
Delete the D374 comment sentence that justifies the change ("the `concurrent`
and `ambiguous` cases fall to the session's own lane because…"). Status keeps
scoping such a session to its self, as it does today (server.ts:1081-1089).
That is disclosed, not unified.

**F3. blocker. Ladder: half-lit (the drain's own write). The recovery row has
no lane.**
Evidence: ingestion.ts:587-598. `target.insert(recoveredText, { metadata: {
source, original_session_id, … } })` carries no `session_id` and no writer. By
the lane key (references.ts:101-102) and by v2's "rows carrying no stamp are
main's", every recovery row is main's, including one written for a worktree
session that claimed its own snapshot under D375. The scenario Then "the
recovery row the drain writes for it quotes the main lane only" checks what the
row quotes, not whose row it is. Fix: add to D375's resp, after "scoped to that
lane as a search by that session would be": "and the recovery row is written in
the claiming session and in its lane, never in no session". Add to the D375
scenario: `And the recovery row written for the worktree's session is the worktree's own, never the main lane's`.
Binding: SQL on the row's `session_key` and its lane, not only its refs.

**F4. major. New ground (a): the forward drain stamp breaks concurrent-caller
detection.**
`newestMainEvent` (session-registry.ts:293-310) finds the session's own agent's
drained captures by `_writer IS NULL AND _writer_agent_id IS NULL`. Processed
staging is purged on a timer (ingestion.ts:366-381), so the nodes half is the
lasting evidence. Stamping `main`/`worktree:<name>` on those rows at the drain
removes them from that read. A background subagent's orchestrator would then be
stamped `provisional` (the subagent) instead of `concurrent`, which is the D240
F1 defect reopened. The stamp would also need its own `_writer_src`: the drain's
existing value `hook` means "a subagent's hook payload" to D238/D263's readers.
The draft names none. If stamping stays, the resp must name a distinct source,
and the binding notes must name `newestMainEvent` as a reader to update.

**F5. major. New ground (b): the stamp-on-open is unnecessary, and the evidence
for it is weaker than the draft says.**
- Does it edit existing rows in place? Yes. It rewrites `metadata_json` on
  captured rows and moves them out of the main lane. Precedent allows store
  migrations to re-mark metadata (D263's additive re-mark, DOCKET.md:1901; D286's
  boundaries on first open, :2101). The feature header's "Nothing is edited in
  place" (journal-orchestration.feature:5) is about writers and other lanes'
  rows, so the migration is not barred outright. But this is the first migration
  that changes *which lane owns* rows. That is closer to the header's concern
  than a boundary stamp is.
- Is it honest? Its only evidence is the registry's current self for the
  session. Registration is `ON CONFLICT … DO UPDATE SET worktree = excluded.worktree`
  (session-registry.ts:187-191), so it records where the session *last* started,
  not where each row was written. A stamp written later and spelled like a live
  stamp (no distinct source is named) presents a later reading as a stamp made
  when the row was written. That runs against R7's "honesty first".
- Is it needed for R4? No. The lane of a row that names no writer can be read at
  query time: `session_key` joined to `session_registry` (agent_id '', worktree)
  gives the checkout. That is a fact of record, read where it is used, and
  nothing is written. The draft's road not taken ("scoping search by session key
  (D167 makes self the checkout, not the session)") misreads this option: the
  registry maps session to checkout, so self stays the checkout.
- Which is smaller and safer: the query-time read. It needs no migration, no
  drain change, no `newestMainEvent` change and no header tension, and it is
  reversible. It covers past and future rows alike. One shared SQL predicate
  would serve the search scope, its conversation windows and the export writer
  trail (D243 already defers to "as the lane key reads them"). Pointers are
  written through the tools and are already stamped, so `laneWriterOf` and
  supersession stay untouched. F1's session-based scope needs the same join, so
  one mechanism closes both.
Replacement for the D376 clauses "a row the hooks captured for the session's
own agent … is stamped at the drain …" and "on first open this build stamps
the self …":
"a row naming no writer belongs to the lane of its session's self as the
registry holds it, `main` or `worktree:<name>`, read when the lane is read and
never written onto the row; a row naming no writer whose session the registry
never held, written before the store recorded writers, is the main lane's"
Delete the @D376 scenario "a worktree's captured rows from an earlier release
move to the worktree's lane when this treecontext opens the store". Replace it
with: `Scenario: a worktree's conversation from an earlier release is the worktree's own` /
`Given a store in which an earlier treecontext captured a worktree "subproject" session's turns with no writer` /
`When the session in the worktree "subproject" searches those turns' words` /
`Then it finds them as its own, and the main checkout's session finds them only when it asks for the whole store` /
`And the store's rows are unchanged byte for byte`.
Residual to disclose in D376's comment: a session id started again in another
checkout re-registers there, and its earlier rows follow it.

**F6. major. Blast radius of "writer unknown": supersession for unplaced
writers.**
Every unplaced caller stamps `unregistered` (server.ts:374-381): no resolved
Claude Code session, an ambiguous beacon, or no self. That covers every MCP
client without hooks. D376's "apart from every lane and no lane's own" reads
like `AMBIGUOUS_LANE`, which "owns no lane and retires none"
(flat-store.ts:1466-1471, 1683-1686). That would stop chapter supersession and
bookmark auto-retirement for unplaced writers, so a non-Claude-Code user's
status panel would grow without bound. That violates D166 and the
F8 class. Evidence of size: across the owner's 17 local stores, zero rows carry
`_writer_src` `unregistered` (read-only SQL, today), so the Claude Code impact
is small and the non-Claude-Code impact is the whole protocol. Fix (R7 is about
labelling, not about retiring): add to D376's resp:
"rows of an undetermined writer are one lane for supersession: an unplaced
writer's chapter or bookmark retires the earlier ones of that lane as before,
never a placed lane's, and a placed lane's writer never retires one of them,
recording it as a reference"
Add the binding note: an unplaced client's two chapters, the second
superseding the first, leave one live pointer.

**F7. major. D373 "the self lines count toward the start's budget" breaks the
worktree's existing packet on resume.**
SOURCE_BUDGETS (shared.ts:442-447) give `resume` 500 characters. The worktree
self lines are prepended outside the budget today (session-start.ts:310-316),
under D236 [I>V]. The self sentence, the chapter line (clipped by
`checkpointBody`, checkpoints.ts:490-494), the referenced-by line and the
other-lanes line together can exceed 500 characters, so a resume would cut the
packet's own anchor. F8 asked for the *other-lanes* block to be bounded, not
the self lines. Replacement: delete "the self lines count toward the start's
budget". Write instead: "the self lines stay outside the start's budget, each
bounded: the chapter by its first line, the other lanes by a count and at most
{3} names".

**F8. major. R6 not fully applied: no unknown-writer case from a worktree.**
The rulings require that "the unknown-writer case" get worktree scenarios. The
v2 table claims "unknown writer seen from a worktree", but the @D376
unknown-writer scenario (v2:217-224) runs from main only. Add to it:
`And a session in the worktree "subproject" calling status counts the unplaced chapter under "writer unknown", never as its own, and its packet does the same`.

**F9. major. DESIGN.md is not amended.**
features/DESIGN.md:428-446 is the `[ruled: D235 … D243, D263]` destination. It
says "`main` and no writer being one lane", "every other caller searches the
whole store", and that only a worktree's status is scoped. v2 §3 lists the
header and the fence but not DESIGN.md. Fix: an "Amended 2026-11-02 (D372–D376)"
paragraph in that passage, in the form of the D371 amendment that follows it
(:447).

**F10. major. Docket form findings (lint verified).**
`touches-later`: D372 and D374 list D376, a later entry. Fix: remove D376 from
both `touches` lines. D376 already touches D372 and D374. `unspread` (coverage):
`{3}` in D372/D373 and `{20}` in D372 have no `spread:` line. Either add one, or
write the 25-worktree scenario as an Outline with `spread:`. `rewrite` ×5 is
expected under [I] until the owner's [V] ratification (precedent D357).
`uncited-trigger` clears once the scenarios carry @D372–@D376 (checked).

**F11. minor. Restatements drop text.**
D373 drops D236's means clause. Restore "the brief is the means of 'the
orchestrator injected the brief at its start': an entry the orchestrator writes
through the insert tool before the worktree's first session". D375 drops D286's
"what the drain writes to the store is in the charter from here" and D286's own
sib reason. Restore both: put the sib as "none -- a row the store writes about
itself growing without a boundary, or a session answering another lane's
recovery queries into its own, is what this prevents, not a behaviour".

**F12. minor. The owner's words for R6 are absent.**
The rulings file asks for the owner's own words in the docket comments. D) ("I
believe that git worktrees are fairly fundamental unit for subagents and should
be fully described in feature file scenarios.") is quoted nowhere. Add it to
D372's comment.

**F13. minor. Over-assertion: "no stamp" is not the same as "written before
writers".**
Library writes (D5) and, today, the drain's recovery rows (F3) carry no stamp
although they are written now. Replace "a row carrying no stamp at all, written
before the store recorded writers" (D376, D374) with "a row carrying no stamp
at all, written before the store recorded writers or by a program writing
through the library without one".

**F14. minor. D374 "the count of hits the scope left out when the store can say
it cheaply".**
This is optional behaviour in a resp and cannot be bound. Either commit to it
("the count of hits the scope left out") or drop it.

**F15. minor. Handshake card.**
The optional swap would break the pinned lines at
tests/server/instructions-drift.test.ts:25-26. The card is "measured, not
assumed" (instructions.ts:4-13), and the cap is Claude Code's 2KB, not "2000".
Drop the optional swap. The skill body and the replies' scope blocks carry the
rule.

**F16. minor. Binding notes.**
- `sessionStart` is local to journal-orchestration.steps.ts:127. It is not in
  standins.ts, and no pre-compact stand-in exists anywhere. Name the real seat,
  or add the hook firing to standins.ts per AGENTS.md.
- "absent … except nowhere" (v2:375) is garbled. Write "absent from the whole
  serialized reply".
- 25 worktrees is a slow binding for a cap of 3. Use 5 (count 5, 3 named).
- The F9 extension's "counts 0 other-lane pointers" over-asserts in worlds that
  hold other pointers. Write instead: "the row is not among the pointers, not
  named in the scope block, and not listed under `scope: "all"`".
- The bindings that today assert no scope block will change and must be
  revisited, not deleted: session-registry.test.ts:199, 271, 275;
  orchestration.steps.ts:426, 624.

**F17. minor. A snapshot whose session the registry never held is "claimed by
no one".**
This is honest under R7, but it strands snapshots left before the registry
existed. Disclose it in D375's comment ("a snapshot left before the store
recorded sessions is not claimed; it stays in its table") rather than claim it
for main.

## Rulings check

| Ruling | v2 | Verdict |
|---|---|---|
| R1 filesystem names | `main`, `worktree:<name>`, branch a signpost | faithful |
| R2 main scoped like a worktree | D372: own lane, scope block, `scope: "all"` | faithful; status of `concurrent` callers unchanged, disclose (F2b) |
| R3 aware, not auto-filled, bounded | count, ≤{3} names with kind and age, no text or id | faithful; kind, age and per-lane count are metadata, not content, so they do not exceed R3 |
| R4 search lane-scoped | D374 | **misapplied**: scoping by `_writer` drops subagent reports, client summaries and imports that main must find (F1); conflicts with D240 for indistinguishable callers (F2b) |
| R5 own-lane snapshot | D375 claim filter | faithful for the claim; the recovery row it writes has no lane (F3) |
| R6 worktree scenarios | status, restart, new worktree kept; captured lane | **incomplete**: no unknown-writer case from a worktree (F8) |
| R7 unknown apart | D376 "writer unknown" | faithful in labelling; supersession consequence unruled (F6) |
| R7a pre-stamp rows main's | D376, scenario | faithful; wording over-asserts (F13) |

## F1–F18 (v1) closure check

| v1 | Closed? | Note |
|---|---|---|
| F1 trig with resolution | closed | behavioural shape, no `->`; lint confirms no `trigger-with-resolution` |
| F2 restate target; D236 | **partly** | split into five, but D376 restates a stale D235 and D374 contradicts D240 (F2); D373 and D375 drop text (F11) |
| F3 D167 Then reversed | closed | words kept; binding non-vacuous (self line first, lane named, text and id absent) |
| F4 query unlit | **reopened** | R4 applied with collateral damage (F1) |
| F5 unplaced as main's | closed | "writer unknown"; side effect F6 |
| F6 snapshot claim | **partly** | claim filtered; the recovery row it writes has no lane (F3) |
| F7 card room | closed | no card change; drop the optional swap (F15) |
| F8 unbounded | closed, over-applied | caps in; "self lines count toward budget" harms resume (F7) |
| F9 narrowed negatives | closed | extension wording to fix (F16) |
| F10 bookmark-only | closed | D373 and scenario |
| F11 vague Thens | closed | positive Thens |
| F12 owner language | closed | Thens use owner words; "the drain" has precedent (journal-recall.feature:161) |
| F13 handoff lanes in status | closed | dropped |
| F14 sources | closed | trig names startup, resume and compaction; scenario binds two |
| F15 helper and client reuse | **partly** | `mcpOver` noted; helper location still misnamed, no pre-compact stand-in (F16) |
| F16 tags and header | closed | one tag each; header lists D263 and D372–D376 |
| F17 fence grammar | closed | new lines, one parenthetical each; compaction entry "Amended" form matches the D286 line |
| F18 audit placement | closed | build unit's own note |

## The draft's open questions

1. **Main's own line at every start: resolved, at every start.** R2 ("i do not
   see a difference") and R4 ("main should get main") decide it. D236's
   premise, "the status panel already serves it", is the one that failed. The
   cost is bounded because each line is clipped, provided F7 holds (the self
   lines stay outside the budget). Remove the item from §5. The fence line
   "its own line only beside another lane" stays a road not taken.
2. **Stamp-on-open: resolved, neither stamp nor backfill.** Read the lane from
   the registry at query time (F5). It needs no edit in place, its evidence is
   a recorded fact read where it is used, and it covers old and new rows. If a
   builder later wants a stored stamp, it is forward-only, with its own
   source, and with `newestMainEvent` updated (F4).

## Questions for the owner (plain language)

**Q1. When the main session searches without asking for everything, should it
still find what its helpers produced: subagent reports, a background worker's
final report, and a teammate's handoff file imported in that checkout?**
Your earlier rulings say the orchestrator can always search its subagents'
reports, and a teammate's imported plan is found by search. Scoping "main gets
main" by author alone would hide all three. Recommended: yes. "Main's lane" is
everything that happened in the main checkout's sessions, helpers included.
Other worktrees' work and anything of unknown authorship stay out until you
widen.

**Q2. Scheduling: should the search scoping ship in beta.3, or follow in
beta.3.1?**
The status panel, the opening note, the snapshot rule and "writer unknown" are
contained changes. The search scoping touches every search an agent makes and
several existing promises (Q1). Shipping it later leaves the second startup
step (the "what was I working on" search) able to surface a worktree's newer
plan, though the opening note and status would already point the right way.
Shipping it now delays beta.3 by one more build-and-review unit.
