# Brief: the main checkout's half of D167 (draft scenarios + docket amendment)

Repo: ~/Documents/treecontext-mcp (branch beta.3/node-sqlite). READ-ONLY.
Do not edit anything under the repo. Write your draft to
/tmp/claude-1000/-home-<user>-Documents-treecontext-mcp/bd91acc7-8f45-4fe0-ba79-b27f76ef86c1/scratchpad/main-self-draft.md

Read AGENTS.md first (the charter rules: feature files are owner language,
the charter wins over code, the failure ladder, "a fence may decline a
promise, never a writer").

## The incident (owner's report, from another machine's store; not inspectable)

Two Claude Code sessions on one store, same repo: session A in the main
checkout (documentation work), session B in a linked git worktree (a new
subproject). The owner quit A and restarted it. Meanwhile B kept working
and wrote a chapter summary. The restarted A oriented on B's chapter as if
it were its own thread, and only recovered by replaying its own chat
transcript to work out what the main session was doing.

## What the record promises

- features/DOCKET.md D167 (line ~1200): default re-orientation anchors on
  "self" — "the worktree it runs in for a worktree session, the main
  checkout for the main session". Its sib: "a restart that orients on a
  stranger's thread is the confusion this removes, not a behaviour".
- D190 (line ~1380) and the comment at line ~1715: "The main checkout's
  fresh start was left as it is, the orientation reminder and the status
  pointers, because no scenario binds it and the status panel already
  serves it; D167's main-checkout half is therefore carried by the stamp,
  not yet by a packet line".
- D242 (line ~1752, with its comment at ~1757): a worktree session's status
  lists its own lane's pointers with a `scope` block; "a session in the
  main checkout, or one the server cannot place, sees every lane as before,
  its self being the main lane with every row that names no writer".
- D243 (line ~1759) for how lanes and writers are named.

## What the build does (verified by reading; the owner's incident is the live evidence)

- src/server/server.ts ~1078-1131: status scopes to a lane only when the
  session's registered self is a worktree; the main checkout gets every
  lane's pointers, newest first, the writer visible only inside raw
  `metadata._writer`.
- src/checkpoints.ts ~652-710 (`worktreeSelfLines`): the fresh-start packet
  line exists for a worktree only; empty for the main checkout.
- The handshake's orientation query (src/server/instructions.ts; the
  "what was I working on" step) is lane-blind; its default recency weight
  0.25 favours the newest chapter whatever lane wrote it.
- instructions.ts ~180: the handshake tells only worktree sessions about
  their lane-scoped status.

## The existing scenarios this touches

features/journal-orchestration.feature:
- line ~61 `@D167` "a restarted worktree session resumes its own thread".
  Its last Then, "the packet handed to a session starting in the main
  checkout at the same time does not carry it", is bound at
  tests/journal/steps/journal-orchestration.steps.ts:656 by checking the
  main checkout's start packet — which is empty for the main checkout, so
  the Then is vacuously green; the leak is through status.
- line ~68 `@D167` new worktree as new subagent process.
- line ~98 `@D169` "a subagent cannot retire the orchestrator's pointer":
  "the orchestrator calling status still sees the chapter as a live
  pointer" — the main session as orchestrator relies on status.
Find every other scenario that asserts what a main-checkout status or
packet shows (grep the features for status, packet, resume pointer,
orchestrator, main checkout) — the amendment must not break them silently.

## The tension to design for

The main checkout is very often the orchestrator: it spawned the worktrees
and legitimately needs to see their chapters. So "hide other lanes from
main" (the worktree rule mirrored) may be wrong. The owner's case is main
as a PEER of a worktree, not its orchestrator, and the store cannot
necessarily tell the two apart. Your draft must take a position and say
why, e.g. main's own pointers first and labeled as its own, other lanes'
pointers listed separately and labeled as another lane's (context, not its
thread); or scoped like a worktree with a count and a widen; or something
better. Consider also: the fresh-start packet line for main (mirroring the
worktree self line); the handshake text; whether the orientation query
needs anything (probably not a charter promise — say so if you decline it);
a main checkout restarted while NO worktree exists (unchanged behaviour);
older rows that name no writer (D242: they count as main's).

## Deliverable (in the draft file)

1. The proposed docket entry in the docket's own grammar (look at D371 at
   line ~2757 for the shape: `Dnnn date [I] amends Dxxx`, resp, ->,
   serves, touches, and a `#` comment with the incident and roads not
   taken). Next free number: check the end of features/DOCKET.md. Mark it
   [I] — the owner ratifies.
2. The scenario text, owner language (no internal key names like
   `_writer`, `lane key`, no file or function names), each tagged, with
   where it goes in which feature file. Include the corrected wording for
   the vacuous D167 Then if it needs changing.
3. Any feature-header or OUT-OF-SCOPE.md text that must change.
4. The handshake (instructions.ts) wording change, if any, as prose.
5. A short list of open questions only the owner can answer, each in plain
   language with what is at stake.
6. A note on how each new Then can be bound non-vacuously (what a binding
   must observe), so the builder cannot bind it hollow.

Keep the draft tight. Do not write code.
