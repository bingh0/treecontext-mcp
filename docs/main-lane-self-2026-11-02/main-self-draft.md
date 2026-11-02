# Draft: D167's main-checkout half (D372, [I], owner ratifies)

Repo read-only; nothing under it was touched. Numbers and line refs are
from `beta.3/node-sqlite` at add7004.

## What the record and the build say (verified by reading)

- D167: a fresh start anchors on self; main checkout's self is the main
  lane. D236 left main's fresh start unchanged "because the status panel
  already serves it". D242 gave the worktree a lane-scoped status and kept
  main at "every lane as before, its self being the main lane with every
  row that names no writer".
- Build: `status` scopes to a lane only when the registered self is a
  worktree (server.ts ~1081); main gets every lane's live pointers in one
  list, newest first, the writer visible only inside raw metadata. The
  fresh-start self lines exist for a worktree only (checkpoints.ts
  `worktreeSelfLines`, "Empty for the main checkout"). The /clear packet
  is session-chain scoped (`newestCheckpoint`, `session_key IN chain`), so
  the leak is the restart path and status, not /clear. The handshake's
  orientation query is lane-blind with recency 0.25; its worktree bullet
  (instructions.ts ~180) tells only worktree sessions about scope.
- Bindings: the D167 Then at steps.ts:656 reads the main checkout's start
  packet, which is empty of self lines by construction, so "does not carry
  it" is vacuous; eight bindings read status's `resume_pointers` list by
  node id (D169, D165, D166, D158, D185). **D242 has no scenario at all**
  (no `@D242` tag in any feature): the worktree scope block is on the
  "absent" rung, not hollow — noted below as an optional add.

## The position

**Main is not scoped; main is told which pointers are its own.** The
store cannot tell an orchestrating main from a peer main (the owner's
case), and must not try: the orchestrator legitimately needs the
worktrees' chapters, and the fence already declines "a top-down model
where the main lane owns its derivatives" (D169). What both mains need is
the same thing: the main lane's own thread first and named as its own,
every other lane's thread apart and named as that lane's — context, not
the thread. Hiding (the worktree rule mirrored) would blind the
orchestrator; a flat list labeled by writer (today, inside raw metadata)
is what produced the incident, because newest-first put B's chapter on
top and nothing said "not yours".

Consequences chosen:

1. **Status, main checkout, default.** The existing pointer list becomes
   the main lane's own live pointers (rows stamped main, older rows naming
   no writer, D242), newest first, under the same cap, under the same
   key — so the eight bindings that read it by node id keep passing and
   keep meaning what they meant. A self block says the session is the main
   checkout and that the list is the main lane's own. A separate block
   lists the other lanes that hold a live pointer, one entry per lane,
   named by lane (worktree name, subagent role, handoff label, D243), with
   that lane's newest live chapter summary (id, age, first line) and the
   count of its live pointers; bookmarks of other lanes are counted, not
   shown. `scope: "all"` gives the one flat list as before. A session the
   server cannot place is unchanged (D242). A main checkout with no other
   lane holding a live pointer sees its list exactly as before plus the
   self block; no other-lanes block.
2. **Fresh-start packet, main checkout.** Mirrors the worktree line, but
   only when another lane holds a live chapter — the moment self can be
   mistaken. Lines: this session runs in the main checkout and re-orients
   on the main lane's own thread; the main lane's own newest chapter
   summary labeled as its own with age and id, and its referenced-by line
   (or: the main lane has no chapter summary of its own); then one line
   per other lane with a live chapter, named by lane, with age and id,
   stated as that lane's thread, context for this session and never its
   own. With no other lane holding a live chapter, the fresh start is
   byte-for-byte what it is today (the solo developer pays nothing).
   /clear is untouched (chain-scoped already).
3. **The handshake** tells the main checkout the same rule the worktree
   gets (prose below). **The orientation query gets no charter promise**:
   search is whole-store for main by design (an orchestrator searches
   across lanes), hits already show their writer (D186/D243), and a
   lane-scoped default search for main would re-create D237's scope
   machinery for the one caller that must see everything. Declined to the
   fence; the handshake says what to do with a cross-lane hit instead.
4. **Ambiguous rows** (D243: never a worktree's own chapter) are not
   main's own either: they are listed apart under a lane named as
   undetermined, never in the own list.

## 1. Docket entry

```
D372 2026-11-02 [I] amends D242
  trig:  a session registered in the main checkout calls status, or starts in the main checkout other than by a /clear, while another lane holds a live pointer [I]
  resp:  the main checkout is never scoped and never told whose thread is whose by order alone: status lists the main lane's own live pointers, the rows stamped main and the older rows naming no writer, newest first under the cap, as the list it listed before, with a self block saying the session is the main checkout and the list is its own lane's; every other lane holding a live pointer is listed apart, one entry per lane named as D243 names it, carrying that lane's newest live chapter summary with its id, age and first line and the count of that lane's live pointers, bookmarks counted and not shown, a row stamped ambiguous under a lane named undetermined; `scope: "all"` lists every lane flat as before; a session the server cannot place, and a main checkout while no other lane holds a live pointer, see what they saw, the self block aside; a fresh start in the main checkout while another lane holds a live chapter opens its packet with the main lane's own newest chapter labeled as its own with age, id and referrers, or the line that it has none, then one line per other lane naming that lane's chapter as that lane's thread and context for this session, never its own; while no other lane holds a live chapter the main checkout's fresh start is unchanged; the /clear packet is untouched; the handshake tells the main checkout this rule as it tells the worktree its own; the orientation query stays whole-store for the main checkout, declined to the fence [I]
  sib:   none -- a restarted main checkout orienting on a worktree's chapter because it was newest is the confusion D167 removes, not a behaviour
  ->     structural
  serves: N23 N24 N20 N5
  touches: D242 D167 D236 D190 D243 D169 D237 D186
# the owner's incident, 2026-11-02, on another machine's store: two Claude Code sessions on one store and one repo, A in the main checkout (documentation), B in a linked worktree (a new subproject); A quit and restarted while B wrote a chapter summary; the restarted A oriented on B's chapter as its own thread and recovered only by replaying its own transcript. D167 promised the main checkout its self; D236 left main's fresh start to the status panel; D242 left main's status flat, every lane newest first, the writer inside raw metadata only, so B's newer chapter led the panel with nothing saying whose it was; the D167 Then "the packet handed to a session starting in the main checkout does not carry it" is bound against a packet that carries no self line by construction, vacuously green, and D242 carries no scenario at all. The position: main as orchestrator and main as peer cannot be told apart by the store and need the same thing, its own thread named as its own and the other lanes' named as theirs; neither is served by hiding. Roads not taken: scoping main like a worktree with a count and a widen (blinds the orchestrator, who spawned the worktrees to read their chapters; the fence already declines a top-down lane model, D169); the flat list labeled by writer in each pointer's preview (order still says "newest is yours", which is the incident); a lane-scoped default search for the main checkout (re-creates D237's scope for the one caller that must search everything; hits already show their writer); main's self lines in every fresh-start packet, other lanes or none (a change to every solo developer's start for a confusion only another lane can cause; reopens if the owner wants the main lane's own chapter at every restart); asking the main session at start whether it orchestrates (an interactive gate, and the answer changes mid-session)
```

## 2. Scenarios (owner language)

### features/journal-orchestration.feature — replace the last Then of `@D167` "a restarted worktree session resumes its own thread" (line 66)

The vacuous Then becomes a non-vacuous one: the main checkout's packet
must *carry* the chapter, as the worktree's.

```
    And the packet handed to a session starting in the main checkout at the same time names that chapter as the worktree's own thread, never as the main checkout's
```

### features/journal-orchestration.feature — new scenarios after the two `@D167` scenarios (after line 75)

```
  @D372 @D167
  Scenario: a restarted main checkout is told which thread is its own when a worktree wrote the newer chapter
    Given a session in the main checkout that wrote the chapter summary "plan: rewrite the README's install section" and then stopped
    And a session in the worktree "subproject" that wrote the newer chapter summary "plan: scaffold the subproject; next: its first test"
    When a new session starts in the main checkout under a new session id
    Then the packet handed to its agent opens by saying the session runs in the main checkout and re-orients on the main lane's own thread
    And the packet carries the main checkout's chapter summary labeled as its own, with its age and id
    And the packet names the worktree's chapter summary as the worktree "subproject"'s thread, context for this session and never its own
    And the packet's main-checkout line comes before the worktree's line

  @D372
  Scenario: a main checkout with no chapter of its own is not handed a worktree's as its own
    Given a main checkout that never wrote a chapter summary
    And a session in the worktree "subproject" that wrote the chapter summary "plan: scaffold the subproject"
    When a session starts in the main checkout
    Then the packet handed to its agent says the main lane has no chapter summary of its own
    And the packet names the worktree's chapter summary as the worktree's, never as the main checkout's

  @D372
  Scenario: the main checkout's status lists its own lane's pointers as its own and the other lanes' apart
    Given the main checkout's live chapter summary "plan: rewrite the README's install section"
    And a chapter summary written later from the worktree "subproject" that reads "plan: scaffold the subproject"
    And an older chapter summary from before the store stamped writers, reading "plan: the first release"
    When the main checkout's session calls status
    Then the developer sees the main checkout's chapter and the older unstamped chapter listed as the main lane's own live pointers, newest first
    And the developer sees the worktree's chapter listed apart, under the worktree "subproject", with its age and first line and the count of that lane's live pointers
    And the worktree's chapter is not among the main lane's own pointers though it is the newest in the store
    And the status says the session is the main checkout and which list is its own lane's

  @D372
  Scenario: the main checkout asking for every lane sees one flat list as before
    Given the main checkout's live chapter summary and a live chapter summary from the worktree "subproject"
    When the main checkout's session calls status asking for every lane
    Then the developer sees both chapters in one list, newest first, with no lane set apart

  @D372
  Scenario: a main checkout alone in its store is unchanged
    Given a store in which only the main checkout ever wrote, holding one live chapter summary and one live bookmark
    When the main checkout's session calls status and then starts a new session other than by a /clear
    Then the status lists the chapter and the bookmark as it did before, with no other lane listed
    And the fresh start's packet is the one a main checkout received before this ruling, with no self line

  @D372 @D169
  Scenario: an orchestrating main checkout still reads its worktrees' chapters from status
    Given a main checkout that briefed the worktrees "feature-login" and "feature-search" and holds its own live chapter summary
    And each worktree wrote a live chapter summary of its own, "feature-login" also a live bookmark
    When the main checkout's session calls status
    Then the developer sees its own chapter as the main lane's own pointer
    And the developer sees one entry per worktree, each naming the worktree and carrying its newest chapter summary's id, age and first line
    And the entry for "feature-login" counts two live pointers and shows one, the chapter
```

### Optional, same file — D242's worktree half has no scenario (absent rung)

Not in the brief, but D372 amends D242 and a builder touching status will
otherwise re-bind a surface nothing describes. One scenario:

```
  @D242
  Scenario: a worktree's status lists its own lane's pointers and counts the rest
    Given the main checkout's live chapter summary and a live chapter summary written from the worktree "feature-login"
    When the session in the worktree "feature-login" calls status
    Then the developer sees the worktree's chapter as the only live pointer listed
    And the status names the worktree's lane, counts 1 live pointer of other lanes left out and says how to widen
    And asking for every lane lists both
```

## 3. Feature header and fence text

- `features/journal-orchestration.feature` header, rulings paragraph: add
  "D236, D242 and D243 of the chunk-5b review, 2026-10-08; D372 of
  2026-11-02 (the main checkout's own thread)". The second paragraph's
  "so a stopped worktree resumes its own thread" becomes "so a stopped
  worktree, or the main checkout beside one, resumes its own thread".
- `features/OUT-OF-SCOPE.md`, declined alternatives (near the D167 line
  at ~356): "Scoping the main checkout's status to its own lane, the
  worktree rule mirrored — the main checkout is often the orchestrator
  and reads its worktrees' chapters from status; it is told which
  pointers are its own and which another lane's, never shown fewer.
  (D372, 2026-11-02)". And: "A lane-scoped default search for the main
  checkout — search stays whole-store for it; a hit shows its writer and
  the handshake says a cross-lane hit is context, not the thread. (D372,
  2026-11-02)".
- `features/OUT-OF-SCOPE.md`, the D167 line at ~437 ("Fresh start: …
  nothing automatic on a fresh start") gains "; the main lane's own
  chapter in every fresh-start packet, other lanes or none (D372)".
- `docs/beta3-bindings-audit.md`: the D167 Then at line 66 should be
  entered as a vacuous binding corrected by D372, and D242 as absent.

## 4. Handshake wording (instructions.ts, prose)

In "Subagents, worktrees and writers", the last bullet becomes two:

- In a git worktree, status lists that worktree's own pointers (scope
  "all" for every lane), and a fresh start is handed the worktree's own
  newest chapter. (unchanged)
- In the main checkout, status lists the main lane's own pointers as this
  session's thread and, apart from them, each other lane that holds a live
  pointer with its newest chapter: a worktree's or a subagent's chapter is
  context for the main checkout, never its thread, even when it is the
  newest entry in the store; if this session spawned that worktree, its
  chapter is the return you were waiting for, still not your own thread.
  A fresh start beside such a lane is handed the main lane's own chapter
  labeled as its own and the other lanes' named as theirs.

In the session-start protocol (both copies, the short instructions and
the reference body), step 1 gains a clause: "resume_pointers are your own
lane's; other lanes are listed apart, named." Step 2's query stays as is,
with one sentence after it: "A hit from another lane carries that lane's
writer; it is context around your thread, not the thread, whatever its
recency."

## 5. Open questions for the owner

1. **Main's own chapter at every restart, or only beside another lane?**
   Drafted conditional: the packet gains self lines only when another
   lane holds a live chapter, so a solo developer's start is unchanged.
   The unconditional form gives every restart the main lane's own chapter
   (D167 read literally) at the cost of a longer start for everyone and a
   feature-header change in journal-reorientation. At stake: start-packet
   size for the common case versus one rule with no condition to explain.
2. **What of the other lanes shows in main's status: the newest chapter
   per lane (drafted), or every live pointer of every lane?** Per lane
   keeps the panel bounded with many worktrees; every pointer is what the
   flat list showed. At stake: an orchestrator with five worktrees sees
   five lines or up to twenty rows.
3. **Bookmarks of other lanes: counted and not shown (drafted), or
   shown?** A worktree's bookmark is its own stop-hook noise; an
   orchestrator may still want "where is feature-login right now". At
   stake: whether main can see a worktree's position without export.
4. **Does the orientation query need anything?** Drafted no, declined to
   the fence; the handshake carries the rule. If the owner wants the
   query's reply to say "N of these hits are another lane's" that is a
   new promise on the recall surface, not this amendment.
5. **The handshake's "the return you were waiting for" clause** names
   the orchestrator's case in the agent's text without the store knowing
   it. Keep it as guidance, or leave the handshake neutral?

## 6. Binding notes — what each Then must observe

General: every scenario runs the real session-start hook through the
stand-in in `tests/journal/standins.ts` (Claude Code firing the hooks),
registers the main checkout and the worktree with real `git worktree
add` (the existing `openGitWorld`/`addWorktree` helpers), writes chapters
through the insert tool from the registered session so the stamp is the
store's, and reads status through the MCP client with the main session
resolvable (the same `statusPanel` helper the D169 binding uses). The
worktree's chapter must be written *after* the main's, so newest-first
would put it first under the old behaviour: a binding where main's
chapter is newer proves nothing.

- "names that chapter as the worktree's own thread, never as the main
  checkout's" (corrected D167 Then): the main's packet must *contain* the
  worktree chapter's id on a line that names the worktree
  `"feature-login"` and reads as another lane's; and no line labeled as
  the main checkout's own contains that id or text. A packet with neither
  line fails (that is the vacuity being removed).
- "opens by saying the session runs in the main checkout…": first line of
  the packet matches the main-checkout self sentence; also assert the
  registry row for the new session has `worktree` null (as the current
  binding does), so the rule fired on a placed main.
- "carries the main checkout's chapter summary labeled as its own, with
  its age and id": a line matching the own-chapter label with an age and
  `(id <main chapter id>)`; the id is the one the insert reply returned.
- "names the worktree's chapter … context for this session and never
  its own": a line carrying the worktree name, the worktree chapter's id
  and the "context, not its own" wording; plus the negative: the own-label
  line does not contain the worktree chapter's id.
- "main-checkout line comes before the worktree's line": compare line
  indices in the packet, both present.
- "says the main lane has no chapter summary of its own": the exact
  no-own-chapter line present and no own-label line at all; the worktree
  line present with its id.
- Status "listed as the main lane's own live pointers, newest first": the
  existing pointer list contains exactly {main chapter, unstamped older
  chapter} in that order by node id; the unstamped row must be inserted
  with no writer stamp (the one place a raw insert is allowed, through
  the standins' pre-stamp fixture, not through the tool), so D242's
  "rows naming no writer are main's" is actually exercised.
- "worktree's chapter listed apart, under the worktree … count": the
  other-lanes block has one entry whose lane is the worktree's name (as
  D243 names it), whose chapter id is the worktree insert's id, whose
  age and first line are present, and whose count equals the number of
  live pointers that lane holds (2 when a bookmark was added, 1
  otherwise). Read the count back against SQL: live pointer rows whose
  `_writer` is that worktree's.
- "not among the main lane's own pointers though it is the newest in the
  store": assert the worktree chapter's `created_at` is the maximum among
  live pointers (SQL) and that its id is absent from the own list.
- "says the session is the main checkout and which list is its own": the
  self block names the main checkout and says the own list is the main
  lane's; no `other_lanes`-style count claiming pointers were left out
  (nothing is hidden).
- "asking for every lane sees one flat list": with the widen parameter,
  both ids in one list, worktree's first, and no other-lanes block, no
  self block.
- "a main checkout alone in its store is unchanged": capture the status
  reply and the fresh-start packet on the current build (or a golden
  fixture committed with the build) and assert the pointer list and the
  packet text are identical except for the self block; assert no
  other-lanes block and no self sentence in the packet. A binding that
  only checks "no other lane listed" is hollow — it must also prove the
  packet carries no self line.
- "one entry per worktree … counts two live pointers and shows one":
  other-lanes block has exactly two entries, lanes named `feature-login`
  and `feature-search`, each chapter id matching the insert replies;
  feature-login's count is 2 and its shown pointer is the chapter, not
  the bookmark (assert by id and kind).
- Optional D242 scenario: worktree's own list has exactly the worktree
  chapter; scope block names the lane, `other_lanes` = 1, widen text
  present; `scope: "all"` lists both ids.
- Hollow-binding traps to refuse at review: asserting on
  `metadata._writer` of pointers in the flat list (that is today's
  behaviour); passing when the packet is empty; writing the worktree's
  chapter through raw SQL with a hand-stamped writer (bypasses the
  registry, the thing D190 makes the stamp come from); calling status
  from a session the server cannot place (falls into the unchanged
  branch and passes for the wrong reason — assert the self block to prove
  the placed branch ran).
