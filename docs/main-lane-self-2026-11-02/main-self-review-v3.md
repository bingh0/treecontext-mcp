# Review v3: the main checkout's half of D167 (draft v3, D372–D377)

Reviewer: adversarial re-review, read-only, `beta.3/node-sqlite` at add7004.
Inputs: rulings R1–R11 (settled), main-self-draft-v3.md, my v2 review. All
claims were checked against the code and the record. Lint was re-run on a
copy of my own (scratchpad/lintv3/: v3's entries and scenarios appended to
features/DOCKET.md and journal-orchestration.feature). It reports 45 findings
before and 58 after. The 13 new findings are `inferred` ×8 and `rewrite` ×5,
and nothing else. **The drafter's lint claim is confirmed.**

## Verdict

**Ratifiable after the fixes below. No blockers remain; there are four majors.**
The registry-at-query-time design can be built from what the registry
records:

- every session's self row (`agent_id ''`, `worktree`);
- subagents under the parent's session id;
- workers with `kind 'worker'` and `parent_session`, set whether the parent
  is linked or only declared (leg-registry.ts:91, 505-519);
- imports carrying `_handoff_importer` when the importing session was
  resolved (handoff.ts:38, 132).

v3 closes every v2 blocker. The four majors are:

1. The export trail still reads lanes by writer stamp. It disagrees with the
   search lane, so a worktree's trail misses its own conversation.
2. The flood scenario's ranking Then over-asserts R8a, and it can fail
   through high-frequency term pruning, which the draft does not name.
3. D374 dropped D237's "every other caller" clause, so a worker searching
   through the ticket door has no rule.
4. The triage's Fable gate falls inside the Fable limit (until 2026-11-06
   12:00 Central), and no probe or scenario walks the incident end to end.

## Findings

**F1. major. Ladder: half-lit. The export trail and the search lane disagree.**
D374 and D376 read a lane's search from the registry. But D376 keeps "a writer's
trail by `main` includes the older rows naming no writer … as the lane key
reads them", and the lane key is the stamp. A worktree session's own captured
turns carry no writer (ingestion.ts:637-666). So `export writer
worktree:<name>` returns only its tool-written rows, while `export writer main`
returns every worktree's conversation. D374 advertises export by `main` or
`worktree:<name>` as "a writer's whole trail", and R10 says a lane is derived
from the registry. Fix: replace D376's clause with this wording:
"a writer's trail by `main` or `worktree:<name>` is that lane's own rows as the
lane is read from the registry, the session's own agent's rows of every session
placed in that checkout, and for `main` the older rows naming no writer whose
session the registry never held; by a role, its stamped rows and the older rows
claiming it as `agent_type` with no stamp". Add one Then to the "earlier
release" scenario: `And an export of the worktree's trail carries those turns, and the main checkout's trail does not`.
U1 owns the shared predicate.

**F2. major. Ladder: over-asserted, and possibly unlit. The flood's ranking
Then.**
R8a: "its own chapter still leads its orientation (status, packet, and the
orientation search must not contradict them)". The scenario says "the
orientation search places the chapter above every report". That is stronger
than R8a, and BM25 does not guarantee it. The draft names only role weight
against recency (§5). It misses `pruneHighDfTokens` (flat-store.ts:1749-1767).
Once the store holds 256 rows (flood world: 200 reports plus 200 start/stop
captures and more), a token in more than half the corpus is dropped. The
canonical query's "next" will be pruned if 200 reports say "next step". The
chapter ("…; next: the doctor table") then matches nothing at all, while the
reports still match on "step". Fix: use R8a's own words. Replacement Then:
`And the orientation search finds the chapter, and no report it finds is offered as the main checkout's own thread`.
Binding: the canonical handshake query verbatim; a world above 256 rows so
pruning is exercised; the chapter's id among the hits; no hit carrying a
pointer label except the chapter; rank recorded in the audit note as an
observation. If the owner wants rank one guaranteed, that is a new placement
rule (Q1), not a build risk to raise mid-unit.

**F3. major. Ladder: absent. The worker caller has no rule.**
D237 ended "every other caller searches as before". D374 restates D237 without
that clause and names four callers: own agent, subagent, `concurrent`/`ambiguous`,
and unplaced. A ticket-door worker is stamped `declared` (session-registry.ts:372-385;
server.ts:515), so it is none of the four. The build would then decide on its
own. Resolvable from R4 ("subagent gets whatever the supervising agent or
harness feeds it": the brief and the key lookup feed a worker, not a scope)
and from the status quo. Add to D374's resp:
"a worker of the ticket door searches the whole store as before, its harness
feeding it by brief and key lookup, the reply saying so". Correct D372's
"a session the server cannot place … the block saying it could not be placed"
so that a worker is not labelled unplaced:
"…; a worker of the ticket door sees every lane flat, the block naming it a
worker". Bind both with one Then on a `runWorker` world.

**F4. major. Triage: the gate's schedule, and the incident has no end-to-end
probe. See Triage below.**

**F5. minor. U1's trail subtraction would drop D263's internal summaries.**
The drain stamps `_writer_agent_id` on `internal-summary` rows too
(ingestion.ts:639-642). U1's "minus helper trails: rows with
`_writer_agent_id` whose kind is not the summary" must read "whose kind is
neither `subagent-summary` nor `internal-summary`". Otherwise @D263's "the
orchestrator searching the report's own words finds it" fails. Add U1 probe:
"exclude `internal-summary` from the kept kinds → @D263's search Then must
fail".

**F6. minor. A helper whose parent the registry cannot place.**
A worker spawned by a library harness with no session (`parent_session` NULL,
leg-registry.ts:517) reports into no lane. One whose parent is declared but
unregistered (`parent_src 'declared'`) reports into the lane of an id the
registry has no self for. D374 is silent on both. Add to D374's resp:
"a worker whose parent the registry places in no checkout reports into no
lane's default search; its return is reached by the key lookup or by asking
for the whole store". Under R7, the honest choice is no lane, not main.

**F7. minor. Residuals the registry reading brings, to disclose in D376's
comment.**
(a) A worktree moved with `git worktree move` has a new top level. The
registry finds no name for it and, because the old top level holds the
directory name, registers it as `<name>@<hex>` (session-registry.ts:169-179,
D243). Its lane splits: the restarted session "starts fresh" and the old lane
is counted among the others.
(b) A removed worktree's lane keeps its live pointers and stays counted.
Nothing retires them unless asked. The count is bounded by R3, but it grows.
(c) Two unplaced writers are one lane for supersession and can retire each
other's pointers (D376). That is today's behaviour, since both are main now,
but D169 reads "a lane's own writer". Disclose it as kept on purpose for the
bounded panel (D166).
(d) The /clear chain is safe, because every start registers its self
(D235).
(e) An ambiguous beacon makes the caller unplaced, so it searches the whole
store. Both are consistent; no change needed.

**F8. minor. D377 carries `[V]` on drafted text.**
The owner's words are in its comment. The resp is the drafter's paraphrase,
and the owner has not read it. Precedent D370/D371 is gate-written `[V]` after
the owner said "record it". Tag it `[I]` until the owner reads it. The [V]
ratifying entry for D372–D376 can then ratify D377 at the same time.

**F9. minor. Binding notes.**
- The resume F7 proof ("packet longer than 500 characters") can pass or fail
  for the wrong reason: the self lines may be under 500 characters on their
  own. Replace it with: "every self line is present whole, the chapter line
  carrying its id, and the part after the self lines is no longer than 500
  characters".
- The helpers scenario's "none of the tool calls" is a negative. Its binding
  must give the 70 tool rows the searched words, so that `scope: "all"` finds
  them (the draft has the positive twin; keep it mandatory).

## v2-finding closure check (in the text, not the table)

| v2 | Closed? | Where in v3 |
|---|---|---|
| F1 scope hides D147/D263/D151 | closed (F5 nit) | D374 resp lists helpers' reports, internal summaries, imports; scenario "finds its helpers' reports and its imports" |
| F2a stale D235 restated | closed | D376 now amends D243 and restates it in full: detached HEAD, `@hex`, `agent:`, trail, `omitted`, ambiguous, summaries default are all present |
| F2b D240 overturned | closed | D374: "`concurrent` or `ambiguous`, searches the whole store as D240 rules"; D372 discloses status |
| F3 recovery row no lane | closed | D375 resp "written in the claiming session and so in its lane"; scenario Thens for both lanes; SQL on `session_key` |
| F4 drain stamp | closed | D376 "nothing is stamped at the drain beyond what is stamped today" |
| F5 stamp-on-open | closed | "no row already stored is rewritten"; byte-for-byte Then |
| F6 unplaced supersession | closed | D376 one lane for supersession; scenario added (residual F7c) |
| F7 self lines in budget | closed | D373 "stay outside the start's budget, each bounded" (binding nit F9) |
| F8 worktree unknown-writer | closed | scenario Then for the worktree's status and packet |
| F9 DESIGN.md | closed | §3 paragraph, `[ruled: D372–D377]` |
| F10 lint | closed | re-run: only `inferred`/`rewrite` |
| F11 dropped text | closed | D373 means clause; D375 charter clause and sib |
| F12 R6 quote | closed | D372 comment |
| F13 no-stamp wording | closed | D376 "or by a program writing through the library without one" |
| F14 optional count | closed | removed |
| F15 card swap | closed | withdrawn |
| F16 binding notes | closed | real seats; `preCompact` to standins.ts; 0/1/3/5 Outline |
| F17 stranded snapshots | closed | D375 resp and comment |

**Rulings R8–R11:** R8 is applied, with the gaps F1, F3, F5 and F6. R8a's
scenario exists but over-asserts (F2). R9 is D377. R10 is D376, except the
export trail (F1). R11 is applied in the triage, with the gaps in F4. No ruling
in effect is contradicted without an amendment. D240 is coherent with v3.
D237's dropped clause is F3.

## Triage assessment

What is right:
- U1 comes first and is the foundation.
- Opus builds the set logic (U1) and the two-surface agreement (U2, U3).
- Opus failure-ladder reviewers sit on every unit, and binding counts are
  recorded per unit.
- The probes are well chosen. U2 probe 1 (remove the self sentence) is the
  vacuity check the D167 history demands.

Fixes:
1. **The Fable gate falls inside the limit.** The project memory: no Fable
   before Thursday 2026-11-06 12:00 Central. R11 orders a Fable gate last, so
   U6 is scheduled after the reset, and the Opus units and the desktop dogfood
   run before it. The triage should say this and should not plan U6 as
   immediate.
2. **U4 should be Opus, not Sonnet.** It is a door unit (session-start claim
   plus a drain write). Its predecessor specimen is D286, a drain write that
   compounded for three releases. It also edits `standins.ts`, which the
   stand-in guard governs. The binding-honesty memory names door units as the
   class to raise a tier.
3. **Merge order.** U1, U2 and U3 all edit `server.ts` and `flat-store.ts`. Run
   them in separate worktrees, merge U1, then U2, then U3, and re-run the
   charter suite after each merge.
4. **Fable binder.** None is warranted now, and none is available before 11-06.
   Keep the memory's rule: if U2's counts show a hollow or vacuous negative,
   move the step definitions of U2 and U4 to Fable medium after the reset, and
   compare.
5. **Missing probes on the incident itself.** No scenario walks the incident:
   main stops, a worktree writes a newer chapter, main restarts, and status,
   packet and search must all agree. Add the walk as Thens on the @D373
   "restarted main checkout" scenario:
   `And the status it calls lists the main checkout's chapter as its own and not the worktree's`
   `And its search "what was I working on, what was the next step" finds the main checkout's chapter and none of the worktree's`
   The steps must open a fresh MCP client under the new main session id.
   Add these probes:
   - (U2) Restore today's main branch in status (lane set only for a worktree
     self). The main-status scenario and the walk must fail. This is the
     incident's own regression.
   - (U2) Derive the lane from the newest pointer instead of the registry.
     They must fail.
   - (U2/U3) Run the walk's status and search on the reused `w.client` (the
     previous session). They must fail: the block names the wrong lane.
   - (U3) Scope by `_writer` instead of the registry. The walk's search Then
     must fail, because the worktree's captured turns read as main's.
   - (U4) Claim by `session_id != ?` alone (today's code). The snapshot Then
     must fail.

## Questions for the owner (plain language)

**Q1. After a main session that ran 200 helpers restarts, should its
"what was I working on" search be guaranteed to put main's own plan first, or
is it enough that the status panel and the opening note lead with that plan
and the search finds it without passing off any helper's report as main's own
thread?**

Your ruling said the plan "leads its orientation", and that the search must
not contradict the panel and the note. A plain word search cannot always
promise first place: when hundreds of reports share the plan's words, common
words get discounted. Guaranteeing first place would need a new rule that
lifts the lane's own plan to the top of that search. Recommended: the
"finds it, never contradicts" form. The panel and the note already guarantee
the lead.
