# Owner rulings for the redraft (Bing, 2026-11-02)

Record these in the docket comments in the owner's own words (quoted below verbatim).

## The owner's words, verbatim

"1) my idea of labeling by branch won't work then. i think the worktree: nomenclature will ahve to do since it's the file system truth. 2) fundamentally, i do not see a difference between "main" and a worktree - they are all reflections and separate spaces within the store. So labeling each writer, including main, would make searching/filtering very easy, yes? A) be aware of other lanes or namespaces or checkouts (what's the right tc nomenclature - please tell me with your reply) when main starts, but no need to auto fill - would get messy if there are a 1000 worktrees. B) what i was working on depends on what lane/namespace we are in. main should get main, worktree gets it's own worktree, subagent gets whatever the supervising agent or harness feeds it. C) I don't think so. D) I believe that git worktrees are fairly fundamental unit for subagents and should be fully described in feature file scenarios. E) honesty first - if writer is uknown, indicate as such. agent can explore other metadata to figure out what it is. could be a human injected instruction which is fine."

Then, on the coordinator's clarification below: "a) agree with your more nuanced explanation about unknown writers. b) ok proceed with the plan."

## What they rule (as the coordinator read them back, and the owner agreed)

- R1 Lane identity is the filesystem: `main` and `worktree:<name>`; the branch is a signpost, never the lane.
- R2 SYMMETRY. Main is a lane like any worktree. The draft's position "main is never scoped, it is told which pointers are its own" is REVERSED: main's status is scoped to main's own lane by default exactly as a worktree's is (D242's worktree rule extended to main), with the scope block, `scope: "all"` to widen. An orchestrating main widens when it needs to.
- R3 (Q-A) At main's start (and status), main is made AWARE that other lanes exist and where to look, but their content is NOT auto-filled: no other lane's chapter text in the packet or status. Bounded for 1000 worktrees: a count plus at most a few most recent lane names, and how to look (status scope all / export by writer).
- R4 (Q-B) The orientation search ("what was I working on") is lane-scoped by default for every session, mirroring status: main gets main, a worktree its own, a subagent what its supervising agent or harness feeds it (its brief / run checkpoint — existing machinery, D237/runs). The reply says it was scoped and how to widen (`scope: "all"`). Keep the existing subagent scope rules coherent with this.
- R5 (Q-C) A fresh session adopts a recovery snapshot only from its own lane; never another lane's.
- R6 (Q-D) Worktrees are a fundamental unit for subagents: the worktree half gets full scenarios (status scoping, restart resumes own thread, new worktree as new subagent process, and the unknown-writer case), not just an optional @D242 one.
- R7 (Q-E) Honesty first: a row written while writers are recorded but whose writer could not be identified is shown as writer unknown, never folded into main's lane or labelled main's own; the agent may inspect other metadata (it may be a human-injected instruction, which is fine).
- R7a Nuance the owner agreed: rows from BEFORE the store recorded writers at all (no writer stamp) stay main's as D243 rules — they were the main session's (no worktrees then). "Writer unknown" is only for rows written after stamping existed where identification failed. Do not let main's old chapters drop out of main's own thread.

## Terminology the owner asked about (for consistent wording)

"Lane" is the term: a writer's own trail inside one namespace. Namespace is the process-level boundary (D196), not this. Checkout is git's word.

## Second round of rulings (after the v2 re-review), Bing, 2026-11-02

Owner's words, verbatim: "q1 - what about scenarios like flooding - there are dozens or hundreds of subagents or work trees - how do we manage that? q2 - i would prefer to hold up beta.3 to include the full filtering. we can dogfood it here." Then, on the coordinator's answer: "go ahead with v3, make sure we follow the aBDD pathway even though this wasn't formally scoped - failure ladder reviews, efficient subagent model triage, etc."

- R8 (Q1) A lane's default search covers the sessions that ran in that checkout AND what its own helpers handed back: the report (subagent summary / worker return) of each subagent or worker spawned by a session of this lane, and handoff files imported in this checkout. Never a helper's whole trail (its tool calls stay in its own lane). Another worktree's helpers report into that worktree's lane, never main's.
- R8a Flooding is bounded by design: one row per helper (its report), top_k ranking with bounded previews, other worktrees counted with at most 3 names (R3), and helpers' reports are never resume pointers, so status and the fresh-start packet lead with the lane's own chapter however many helpers ran. A scenario binds it, modelled on the existing "300 entries" orchestration scenario: main runs 200 subagents, restarts, and its own chapter still leads its orientation (status, packet, and the orientation search must not contradict them).
- R9 (Q2) The full filtered search ships in beta.3; beta.3 waits for it; dogfood on the desktop.
- R10 Design direction from the v2 re-review, adopted: a session's lane is derived at QUERY time from the session registry (which checkout each session ran in, and the parent link of each helper); nothing is stamped at the drain beyond what is stamped today, no backfill of existing rows.
- R11 Process: the aBDD pathway in full though this was not formally scoped: failure-ladder reviews (Opus), efficient model triage for builders (Sonnet/Opus by difficulty; Fable only where binding judgment warrants, per the binding-honesty-by-tier instrumentation), a Fable gate last, per-unit binding counts recorded.

## Third round (after the v3 review), Bing, 2026-11-02

Coordinator's question 1: after main restarts, must its own plan rank FIRST in the "what was I working on" search, or is "it's in the results and nothing contradicts it" enough? Coordinator recommended "found, never contradicted" (status and the fresh-start packet guarantee the lead; a rank-first promise needs a new chapter-boosting rule and can fail on common-term dropping past 256 rows). Question 2: the Fable gate.

Owner's words, verbatim: "ok on #1 rec. let's do everything other than fable gate including dogfooding and we can see what the fable situation looks like when you are done - if there's available tokens we can do it, otherwise it waits until thursday."

- R12 The search promise is "found, never contradicted": after a restart the lane's own chapter is among the orientation search's results and no result presents another lane's thread as the session's own; rank-first is not promised. Status and the packet carry the lead.
- R13 Everything except the Fable gate proceeds now, dogfooding on the desktop included; the Fable gate runs after, if Fable tokens are available, otherwise Thursday 2026-11-06.

## Fourth round (after the U1 review), Bing, 2026-11-02

Question: after the upgrade a client without hooks writes into the writer-unknown lane and can never retire its old pre-stamp chapters (main's lane by D243), so they stay live forever. Options put: (1, recommended) an unknown writer may retire a pre-stamp chapter, traced; (2) doctor lists them for a human; (3) disclose only.

Owner's words, verbatim: "i agree there has to be mechanism to retire so nothing is orphaned, as long as who/what/when/how is recorded"

- R14 No pointer is orphaned: there is a mechanism by which a chapter that no lane can otherwise retire (a pre-stamp chapter, for a writer in the writer-unknown lane) is retired, and every such retirement records who retired it (the writer as the store knows it, unknown included), what (the retired entry and the retiring entry), when, and how (the mechanism: e.g. supersession across the pre-stamp boundary). To be drafted as a docket entry and scenario through the same pathway before U3 closes.
