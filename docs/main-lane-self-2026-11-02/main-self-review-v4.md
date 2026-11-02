# Review v4: final confirmation (draft v4, D372–D377)

Read-only check of `beta.3/node-sqlite` at add7004. No journal writes.

## Verdict

**READY once three wording fixes are pasted, plus one binding-note
addition.** The exact replacement text for each is below. Every v3 finding is
closed in the paste-ready text itself. The only changes since v3 are the ones
my v3 findings and rulings R12 and R13 asked for. Every owner quote is word for
word. R12 is written as "found, never contradicted". All insertion points
match the current files. Lint goes from 45 to 59 findings, and the 14 new
ones are the expected kinds.

## 1. v3 findings, closed in the text

| v3 | Where in v4's text |
|---|---|
| F1 export trail | D376 resp: "a writer's trail by `main` or `worktree:<name>` is that lane's own rows as the lane is read from the registry…"; D374 ends "by the same lane reading"; the earlier-release scenario adds "an export of the worktree's trail carries those turns…" |
| F2 flood Then | The scenario reads "finds the chapter, and no report it finds is offered as the main checkout's own thread". The comment names pruning past 256 rows. The binding records the rank and does not assert it. |
| F3 worker caller | D374 adds "a worker of the ticket door searches the whole store as before…" and restores "every other caller searches as before". D372 adds "the block naming it a worker". A new journal-workers scenario covers both. |
| F4 gate and incident walk | The @D373 restarted-main scenario gains the status Then and the search Then. U7 is deferred per R13. The five probes are in U2, U3 and U4. |
| F5 internal summaries | U1 keeps both `subagent-summary` and `internal-summary`. Probe 7 is added. |
| F6 orphan helper | D374 resp has the orphan clause. The scenario gains a Given and a Then for it. |
| F7 residuals | D376's comment covers the moved worktree, the removed worktree, two unplaced writers sharing one lane (with D169 named), and the ambiguous beacon. |
| F8 D377 tag | D377 is `[I]`, and its comment says why. |
| F9 binding notes | Resume: every self line whole, the remainder at most 500 characters. Helpers: the tool rows carry the searched words, and the positive twin is mandatory. |
| Triage 2, 3, 5 | U4 is built by Opus. Merges go U1, U2, U3, U4. The incident probes are in place. |

## 2. Changes since v3 (substance diff)

Changes to the docket entries:
- **D372:** the trigger and resp gain the worker; `touches` gains D288.
- **D374:** the trigger gains the worker; the resp gains the orphan clause, the worker clause, "every other caller", the R12 clause and "by the same lane reading"; `touches` gains D288.
- **D376:** the trail clause is rewritten and the comment gains the residuals.
- **D377:** the tag becomes `[I]`, and the resp and comment gain the R13 schedule.

Changes to scenarios, text and triage:
- **Scenarios:** two walk Thens, the orphan worker, the export Then, the flood Then, and the new journal-workers scenario.
- **Fence:** line (b) gains "or promised to rank the lane's own chapter first" (R12).
- **DESIGN.md:** the paragraph gains the trail, the worker and the R12 promise.
- **Skill body:** the bullet gains the R12 and worker sentences.
- **Triage:** gains U6 dogfood and U7 Fable deferred (R13).

Every change traces to a v3 finding or to R12 or R13. D373, D375 and the other
scenarios are unchanged from v3.

## 3. Owner quotes

Each quote in the D372–D377 comments was checked by exact match against
main-self-rulings.md: R1, R2 (A, with the marked elision), B, C, D, E, a),
q1, q2, the aBDD sentence, and the third-round sentence. All match, including
the owner's own spellings ("ahve", "uknown", "it's own"). The other quoted
strings in those comments come from the record, not the owner: the fence, the
D236 comment, the D167 Then, and the handshake query.

## 4. R12 wording

The flood scenario, the DESIGN.md text, the fence line and the skill body all
say "found, never contradicted / first place not promised". D374's R12 clause
is right in meaning but its wording is tangled ("…no result is presented as the
session's own thread but its own lane's…"). That is slip S1.

## 5. Insertion points

All checked against the current files:
- journal-orchestration.feature:66: the @D167 Then is present with these words.
- journal-orchestration.feature: line 75 is "And the packet carries no chapter
  summary from any other worktree" and @D190 is at line 77.
- The orchestration header sentence "Self is recovered … resumes its own
  thread." is at lines 8-10.
- journal-workers.feature: the end of the file is valid.
- OUT-OF-SCOPE.md: "the one declined promise this entry still fences." is
  present; the "Declined alternative, Re-orienting from the project's newest
  chapter…" line is at about line 356; "- Lane model: cross-lane supersession
  that retires the target; a" is at line 438.
- DESIGN.md: the D371 paragraph ends `[ruled:\n  D371]` at lines 451-452, not at
  "~447", but the anchor is unambiguous.
- instructions.ts: the three replaced lines exist verbatim at lines 180-182.

## 6. Lint, re-run on my own copy

scratchpad/lintv4/ holds a fresh copy of `features/`. I appended the six docket
entries, inserted the orchestration scenarios after line 75, and appended the
workers scenario. Result: 45 findings before, 59 after, 14 new. They are:
- `inferred` ×9: D372, D373, D374 and D376 trigger and resp, and D377 resp;
- `rewrite` ×5: D372–D376.

There are no other kinds. This confirms the drafter's claim.

## Slips, with exact replacements

**S1 (D374 resp, R12 clause).** Replace
`after a restart the lane's own chapter is among the orientation search's results and no result is presented as the session's own thread but its own lane's, the first place not promised, the status panel and the packet carrying the lead`
with
`after a restart the lane's own chapter is among the orientation search's results and no result presents another lane's thread as the session's own, the first place not promised, the status panel and the packet carrying the lead`

**S2 (journal-orchestration.feature header).** The header should list only the
tags the file carries (v1 F16), and no scenario in this file carries @D377. In
v4 §3's rulings paragraph, replace
`D372 to D377
  of 2026-11-02 (the main checkout's own lane: status, the fresh start,
  the search scope read from the registry, the recovery snapshot's lane,
  the unknown writer, the beta.3 schedule).`
with
`D372 to D376
  of 2026-11-02 (the main checkout's own lane: status, the fresh start,
  the search scope read from the registry, the recovery snapshot's lane,
  the unknown writer).`

**S3 (journal-workers.feature header, not paste-ready as written).** Its
rulings paragraph is several sentences long, so "append to its rulings line"
does not say where the text goes. In journal-workers.feature:15-16, replace
`D313, D315, D316, D317, D329, D332, D335, D340, D341, D342 of the beta.3 interview, 2026-10-30 to
  2026-10-31.`
with
`D313, D315, D316, D317, D329, D332, D335, D340, D341, D342 of the beta.3 interview, 2026-10-30 to
  2026-10-31; D372 and D374 of 2026-11-02 (a worker's status and search).`

**S4 (binding note, helpers' scenario; not charter text).** The orphan worker's
Then says "the key lookup reaching it as before". A key lookup needs a run and
a key, so add to the note: "the orphan's ticket names a run and a key (and an
empty parent), so the key lookup on that run and key returns its return".
