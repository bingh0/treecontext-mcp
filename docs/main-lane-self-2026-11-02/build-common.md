# Main-lane build: rules every builder follows

Repo: ~/Documents/treecontext-mcp, branch beta.3/node-sqlite. The charter
is committed at e4a35f4 (D372–D377 in features/DOCKET.md; 16 new scenarios in
features/journal-orchestration.feature and features/journal-workers.feature,
entered as scenario-scoped wip entries in tests/journal/features.test.ts).

Read first: AGENTS.md (whole), then in the scratchpad
/tmp/claude-1000/-home-<user>-Documents-treecontext-mcp/bd91acc7-8f45-4fe0-ba79-b27f76ef86c1/scratchpad/:
- main-self-rulings.md (the owner's rulings R1–R13; settled)
- main-self-draft-v4.md §5–§8 (binding notes per Then, the build triage with
  each unit's files and the mutation probes its reviewer will run)
- main-self-review-v4.md fix 4 (a binding note: the orphan worker needs a run
  and key on its ticket for the key-lookup check)

Rules:
- The charter wins. Do NOT edit any .feature file, DOCKET.md, OUT-OF-SCOPE.md,
  DESIGN.md or USER-NEEDS.md. If a scenario cannot be bound honestly as worded,
  stop and report it; never narrow a step regex or soften a Then to make it pass.
- Bind your unit's scenarios (see the triage table) and remove exactly their
  wip entries from tests/journal/features.test.ts. Leave other units' entries.
- Honest bindings: real doors, real payloads in, direct SQLite inspection out
  (the verification rule). Stand-ins only through tests/journal/standins.ts;
  the stand-in guard in tests/feature-guards.test.ts must stay green. Every
  negative Then ("does not carry", "never") must be able to fail: before you
  finish, run each mutation probe listed for your unit in the triage table
  against your code (apply, run the scenario, confirm it fails, revert) and
  report the table (probe, result). A probe that stays green means the binding
  is hollow: fix the binding, not the probe.
- Unit tests beside the code where the triage names them.
- Code style per AGENTS.md (strict TS, named exports, stderr logging).
- Before finishing: npm run typecheck, npm run lint, npm test (full) green;
  docket lint unchanged from 59 findings.
- Commit your unit as one commit on the branch (do not push), message
  "beta.3 main-lane <unit>: <what> (D37x...)" with a short body and the trailer
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Leave run-manifest.ndjson uncommitted.
- No treecontext_insert writes; the coordinator journals.
- Reply under 250 words: commit hash, scenarios bound (by title), wip entries
  removed, the probe table, test counts, anything you could not bind honestly
  or any deviation from the triage.
