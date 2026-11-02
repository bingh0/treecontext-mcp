# Review: D378 draft (R14, the pre-stamp door)

This review was read-only, at `beta.3/node-sqlite` 7df7bd6. I made no repo edits and no store writes. The lint runs used a scratch copy of `features/`, in the `lint/` folder of this scratchpad.

## Verdict

**REDRAFT the door's scope, then it is ready.** The mechanism, the record and the reply are close to right.

The draft keeps a door open that R7a and R14's own premise shut: the mixed store, choice (b). Its main positive scenario binds exactly that contested case, because `openGitWorld` registers main's self. Choice (a), bookmarks, goes beyond what R14 needs.

The pre-stamp definition has two holes, a role claim and liveness. Two of the side-door probes are masked. The resp adds a form finding to the lint.

All fixes below are paste-ready. None of them needs the owner, but F1 carries one confirm line for the ratifying read.

## Resolution of the two drafter's choices

### (b) Mixed store: resolved from the record. Shut the door once a session has registered in the main checkout.

**Derivation:**

1. **R14 as ruled.** The text reads: "there is a mechanism by which a chapter **that no lane can otherwise retire** (a pre-stamp chapter, for a writer in the writer-unknown lane) is retired". In a store where the registry holds a session placed in the main checkout, main's own writer can retire every pre-stamp chapter, which is main's by D376. Such a chapter is not orphaned, so R14's premise does not hold there. The question put to the owner was also about the hookless client's *own* old chapters ("can never retire its old pre-stamp chapters"), not a hooked main's.
2. **R7a, agreed by the owner.** It says: "Do not let main's old chapters drop out of main's own thread." Under the draft, a hookless client in a mixed store retires main's pre-stamp chapter. Main's next fresh start then opens on its bookmark or fresh (D373), which the draft's own comment concedes. That is main's chapter dropping out of main's thread, by another writer's act, with no packet line. It is the incident's shape (a lane's live thread changed by someone else). It is not the incident's exact form (orienting on a stranger's chapter).
3. **D169 [I>V].** It says: "only a lane's own writer retires that lane's pointers". A departure from it is licensed only as far as the owner's words reach, and point 1 shows they do not reach here.
4. **The "window" is not a rule.** Nothing in the resp closes it. A pre-stamp chapter stays eligible for as long as it is live. It stops being eligible only if main's next chapter happens to name it in `supersedes`, so if main's agent supersedes something else, the door stays open forever. The comment's sentence ("until main's first stamped chapter retires it itself") describes a race. It cannot be tested as a rule.
5. **The drafter's objection** was that "the rule would flip the moment the first hooked session appears". That flip is exactly the moment the chapter stops being orphaned. A store-level fact read at the write is just as testable as the per-row facts. It reuses D235's spelling: a self row with an empty agent id and no worktree.

**Contradiction asked about:** yes. "Pre-stamp rows stay main's" (R7a, D376) contradicts the unknown lane retiring them whenever main exists to retire them itself. R14 is a narrow exception, valid only where main does not exist.

**Residual to disclose (comment, F13):** main registered once and never returns. Its pre-stamp chapter then stays live in main's lane, where main's next session can retire it.

**Confirm line for the ratifying read (plain language, optional):**

> "If a project's store has ever been used by Claude Code in the main folder, a tool without hooks (Codex, Cursor) may NOT clear out main's old pre-upgrade plan; only main can, so main never comes back to find its plan gone. A tool without hooks can clear old pre-upgrade plans only in a store where Claude Code has never run in the main folder since the upgrade. Every such clearing records who, what, when and how. OK?"

The stakes: if the door stays open as drafted, a Codex session running beside Claude Code can make main restart with its plan gone. Main is not told; the plan is only findable by export.

### (a) Bookmarks: resolved from the record. Exclude them, chapters only.

1. R14 and the question both say "chapter".
2. D166 [I>V] makes "at most one bookmark per session live" the designed steady state. Every ended session's last bookmark, in every lane, stays live by design, and chapters alone "stay live until deliberately superseded". So a pre-stamp bookmark is not an orphan peculiar to the boundary. It is what every session leaves.
3. Bookmarks are written at the stop hook's request (src/checkpoints.ts:442). A hookless client has almost none of its own. Pre-stamp bookmarks are therefore overwhelmingly hooked Claude Code main sessions' own.
4. D373 makes a lane's live bookmark main's packet anchor when it has no chapter. Including bookmarks would let the unknown lane change main's packet anchor, with no hookless benefit.

Minimum necessary means: out.

## Findings

| # | Sev | Finding | Fix |
|---|---|---|---|
| F1 | high | (b) above. The door opens in a mixed store against R7a and beyond R14. The window is undefined. Scenario 1's Given ("a store whose chapter summary … before the store recorded writers") runs `openGitWorld`, which registers main's self (journal-orchestration.steps.ts:917-921). So the contested mixed case is the bound positive, and R14's own case, a store with no main registration, is unbound. | Resp clause R below ("while the registry holds no session placed in the main checkout"). Scenario 1 gets a world with no main registration. New scenario 4 (the incident guard). Comment C below. |
| F2 | med | (a) above. Bookmarks are included beyond need. | R: "a live chapter summary … never a bookmark". Drop "or bookmark" from the trig. |
| F3 | med | The definition admits a role lane's row. The resp tests only "neither `_writer` nor `_writer_src`". `laneWriterOf` (src/references.ts:134) reads an unstamped row's `agent_type` as its lane, and D243 and D376 keep "the older rows claiming it as `agent_type` with no stamp" as the role's. The MAIN_LANE test appears only in build note §4, not in the resp, so a build can omit it and still match the charter. "Live" is also defined as `next_session` alone; LIVE_POINTER (checkpoints.ts:247) also counts `status` `active`. | R: "a live chapter summary of the main lane naming no writer, carrying neither `_writer`, `_writer_src` nor `agent_type`". Binding: live means `next_session` true or `status` `active`. Scenario 2 adds the role-claim victim. |
| F4 | med | The handoff clause has no victim. D223 moves `next_session` and `status` under `_handoff_claims` (src/handoff.ts:66), so an imported chapter is never live. Scenario 2's "all four stay live" is false for it, and probe (iii) (drop the handoff guard) stays green behind liveness. Build note §4's "one line in src/handoff.ts" is not needed: HANDOFF_CLAIM_KEYS already spreads WRITER_STAMP_KEYS (handoff.ts:81). | Then: "each of the four is as it was". Binding: the import's guard has no victim of its own; its probe drops liveness and the handoff test together. Drop the handoff.ts build line. |
| F5 | med | The side-door probes are masked. Main's and the worktree's stamped chapters fail both the stamp guard and the registry guard (their sessions are registered). Probe (iv) ("lane is main" instead of "no stamp") is therefore silent while the registry guard holds, and probe (i) as written is garbled. Under F1's store rule, scenario 2 in a world where main is registered would also shut the door for every victim, masking all probes. | Scenario 2 runs in a world with a registered worktree and no main registration. Each victim fails exactly one guard: the worktree's library row with no stamp (registry guard), the role-claim pre-stamp row (lane guard), the imported row (liveness and handoff), and the worktree's stamped chapter (both guards, a regression victim). The store guard is probed by scenario 4. |
| F6 | med | The draft records the store-only discipline only as a build note. AGENTS.md lists the stamp keys as charter-level: "stamped by the store, never trusted from a caller". | R: "both keys are the store's: the insert tool drops a caller's copy, and an import keeps a file's copy among its claims". Scenario 2's unplaced client carries a forged `_retired_across` and `_supersedes_across`, and the existing negative Then catches a leak. Probe: remove the two keys from WRITER_STAMP_KEYS, and the scenario goes red. |
| F7 | med | The reversal is mis-cited: D241 is the bookmark rule, and the echo heal's undo is D240's. The record's fate on undo is left as "builder's choice", which is a charter gap. A live pointer still carrying `_retired_across` would be a false record. | R: "when an echo moves the retiring row into a lane that does not own the target, the echo heal's undo restores the target and removes its `_retired_across` and the retiring row's `_supersedes_across`, the heal's own record saying so". Bind it with a unit test through the drain, with a staged echo carrying agent fields (the self-unplaced heal returns early, per U1 F8). |
| F8 | low | Lint. The draft's "no bare digit run" claim is false. Docketry goes from 59 to 63 findings: inferred ×2 and rewrite ×1 (expected), plus **bare-digit-run** in resp on "D241's" (a form finding, a new kind for this entry). Gherkin lint of the feature with §2 inserted gives 0 findings. | Clause R has no ids in the resp. Expected after the fix: 62. |
| F9 | low | The resp and scenario 1 restate F4's reply fix ("says the writer it stamped is undetermined"). D235 already rules that "the reply says the writer stamped". Restating it is scope beyond R14. | Drop it from D378's resp and from scenario 1's first Then. Fix the code under D235 (U1 F4). |
| F10 | low | The feature header's narrative still says "nothing outside the writer's own lane is modified; a cross-lane reference is a pointer the owning lane sees, never a flag flip", which is now untrue for one case. The proposed list "D372 to D378" claims D377, which is not in this feature. | Append to the narrative: "save one door: a client the server cannot place may retire a chapter from before the store recorded writers, recorded, where no session has run in the main checkout". List: "D372 to D376 and D378 of 2026-11-02 (…, the unknown writer, the pre-stamp chapter)". |
| F11 | low | `touches` misses D373 (the packet anchor that the retirement changes), D223 (import claims) and D293 (the owner's who/when/where/how/what trace principle that R14 echoes). | `touches: D376 D169 D235 D240 D241 D243 D166 D223 D293 D372 D373 D374` |
| F12 | low | Binding note: the F5 slip (a claimed role in `writer`) is planted in scenario 2, which has no record to check. | Put the `agent_type` claim on scenario 1's unplaced client ("that claims the role \"tester\""). Assert `_retired_across.writer` = "writer unknown" verbatim, with no "tester" anywhere in the record. |
| F13 | low | Residuals are undisclosed. (i) A hooked session whose registration failed is unplaced and could be a worktree. Under the store rule it reaches the door only where no main registration exists. (ii) Main registered once and never returns. (iii) In a mixed store, the hookless client's own pre-upgrade chapters stay main's (D376) and its new ones reference them. (iv) Under (b), the record keeps the writer as stamped at the retirement; a later heal is said by the heal's own keys. | Comment C. |
| F14 | low | The existing @D376 scenario (an unplaced client supersedes its own earlier chapter) is the victim for a door that reads `_writer` and not `_writer_src`. Such a door would put an across record on an own-lane retirement. | Add to it: "And neither chapter carries a retirement across the pre-stamp boundary". Probe: the door's stamp test reads `_writer` only, and the scenario goes red. |

## Paste-ready text

### Trig (replace the second half)

> … or a writer the store could not place names in `supersedes` a chapter summary of the main lane that names no writer [I]

### Clause R (replaces the draft's inserted clause, from "an unplaced writer never retires" to "does not own the target")

> an unplaced writer never retires a placed lane's pointer, with one door so that no chapter is orphaned: while the registry holds no session placed in the main checkout, an unplaced writer that names in `supersedes` a pre-stamp chapter, a live chapter summary of the main lane that names no writer, carrying neither `_writer`, `_writer_src` nor `agent_type`, whose session the registry never held, retires it, and never otherwise: never a bookmark, never by the bookmark chain, never a pointer naming a writer or carrying a stamp of any source, never one whose session the registry holds, never an imported entry, and never once a session has registered in the main checkout, each of those staying a reference as before; every such retirement is recorded on the retired entry beside the ordinary trace under one key `_retired_across`: who, the writer as the store stamped it at the retirement, "writer unknown" with the stamp source `unregistered` and the retiring row's session when it carries one, never a role the row claims; what, the retiring entry's id; when, the moment of the retirement; and how, `pre-stamp`; the retiring entry lists what it retired that way under `_supersedes_across`, beside `_supersedes_referenced`; both keys are the store's, the insert tool dropping a caller's copy and an import keeping a file's copy among its claims; the reply lists those chapters under `retired_across`, apart from the lane's own supersessions, with a note saying who, what and how; the record is read wherever the entry's metadata is read, export by id, the writer trail by `main` and the handoff export's whole form; when an echo moves the retiring row into a lane that does not own the target, the echo heal's undo restores the target and removes its `_retired_across` and the retiring row's `_supersedes_across`, the heal's own record saying so;

### Comment C (replaces the draft's sentences from "The door is the unknown lane's alone" through "in main's trail.")

> The door is the unknown lane's alone, and only where the registry holds no session placed in the main checkout. R14 reaches "a chapter that no lane can otherwise retire". Where main has registered, its writer can retire every pre-stamp chapter, and by R7a "do not let main's old chapters drop out of main's own thread": a hookless client retiring main's chapter there would leave main's next start without its thread, the incident's shape (D372). A worktree retiring main's is the incident. An `ambiguous` writer retires nothing (D235). Bookmarks stay out: D166 keeps one live per ended session by design, so a pre-stamp bookmark is no orphan; and they are written at the stop hook's request, so the pre-stamp ones are hooked main sessions' own, and D373 makes one main's anchor. The test is the row's own facts and the registry's, read at the write, never a release or a date. The record lives on the retired entry because that is the row that changed and the row main's trail reads; the retiring entry carries the list. Both keys are the store's, like the stamp. Residuals, disclosed: main registered once and never returns, leaving its pre-stamp chapter live in its own lane for its next session; a hooked session whose registration failed is unplaced, whichever checkout it ran in; in a store where main has registered, a hookless client's own pre-upgrade chapters stay main's (D376) and its new ones reference them.

In the roads not taken, add: "the door open in a store where main has registered, until main supersedes the chapter itself (the first draft; R7a, and the window closes only by chance)". Also change "D241's undo" to "D240's undo" throughout.

### Scenarios (replace §2)

```gherkin
  @D378
  Scenario: a client without hooks retires its chapter from before the upgrade, and the retirement says who, what, when and how
    Given a store whose chapter summary "plan: the first release" was written before the store recorded writers, where no session has registered in the main checkout since
    And a client the server cannot place, after the store recorded writers, that claims the role "tester"
    When that client writes the chapter summary "plan: the second release" superseding "plan: the first release"
    Then the reply lists "plan: the first release" as retired across the pre-stamp boundary, apart from the lane's own supersessions
    And "plan: the first release" is retired, its record naming who as "writer unknown" with the stamp source and the retiring session and never the role it claims, what as the retiring entry, when as the moment, and how as "pre-stamp"
    And "plan: the second release" lists "plan: the first release" as retired across the boundary
    And that client calling status sees "plan: the second release" as a live pointer labeled "writer unknown" and no pointer of "plan: the first release" in any lane
    And exporting "plan: the first release" by id and reading the main lane's writer trail both show the record

  @D378
  Scenario: the boundary opens to no pointer that names a writer, whose session the registry holds, or that was imported
    Given the worktree "subproject"'s own live chapter summary, where no session has registered in the main checkout
    And a chapter summary written through the library with no writer stamp in the worktree "subproject"'s session
    And a chapter summary from before the store recorded writers that claims the role "tester"
    And a chapter summary imported from a teammate's handoff file
    And a client the server cannot place, after the store recorded writers, whose metadata carries a retirement record of its own making
    When that client writes a chapter summary superseding all four
    Then each of the four is as it was, the reply listing each as referenced, written by another writer, and none as retired across the boundary
    And no entry in the store carries a retirement across the pre-stamp boundary

  @D378
  Scenario: once a session has run in the main checkout, a client without hooks cannot retire the main checkout's chapter from before the upgrade
    Given a store whose chapter summary "plan: the first release" was written before the store recorded writers
    And a client the server cannot place, after the store recorded writers
    When that client writes a chapter summary superseding "plan: the first release"
    Then "plan: the first release" stays live and unchanged, the reply listing it as referenced, written by another writer, and no entry carries a retirement across the boundary
    And the main checkout's next fresh start opens on "plan: the first release" as its own chapter

  @D378
  Scenario: the boundary opens for the writer-unknown lane alone
    (the draft's scenario 3, unchanged)
```

The third scenario reuses the existing Given, which registers main through `openGitWorld`. The new Given in scenario 1 must build the git world *without* the main session-start: a hookless-only store whose registry has no main-checkout row, asserted by SQL. The draft's scenario 3 still works: its first When is a worktree writer (placed, refused); its second registers main.

## Binding notes: corrections

- **S1 status.** The Then is called by the unplaced client (`mcpOver(w, { ccSessionId: unplaced })`). Per D372, an unplaced caller sees every lane flat. Assert that the ids contain `second` labelled "writer unknown", and that `first.id` appears nowhere in the serialized reply. Probe: leave `first` live, and the Then goes red.
- **S1 record.** `_retired_across` deep-equals `{by, writer: "writer unknown", writer_src: "unregistered", session, how: "pre-stamp"}`, with `at` equal to `superseded_at`, and the serialized record does not contain "tester". Probe: write `agent_type` into `writer`, and the Then goes red.
- **S2 victims and probes.** Each probe below turns one victim's assertion red:

  | Probe | Victim it turns red |
  |---|---|
  | (i) drop the registry guard | The worktree's library row |
  | (ii) drop the `agent_type` part of "names no writer" | The tester row (its lane by `laneWriterOf` is `tester`) |
  | (iii) drop the liveness test and the handoff test together | The imported row |
  | (iv) remove the two keys from WRITER_STAMP_KEYS | The forged record lands, so the global `count(*)` Then fails |

  The worktree's stamped chapter is a regression victim with no single-guard probe. Say so.
- **S4 (new).** Probe: delete the store guard ("no main-checkout registration"). The chapter is retired, and both Thens go red. This is the incident probe. The packet Then fires a real startup SessionStart through `runHook` for main's session and reads the packet's self line (D373), never the reply.
- **F14.** The existing @D376 scenario gains the negative Then above. Probe: the door's stamp test reads `_writer` only, and it goes red.
- **Unit (F7).** Stage a PostToolUse echo of the across insert, carrying a subagent's agent fields, then drain. Assert by SQL that the target is live again, has no `_retired_across`, and that `_writer_heal_unretired` names it on the retiring row.
- Every Then above is observed by the reply plus direct SQLite through the real doors (`treecontext_insert` over `mcpOver`, `treecontext_import`, `runHook`, `store.insert` for the library). None is checkable only by reading code.
