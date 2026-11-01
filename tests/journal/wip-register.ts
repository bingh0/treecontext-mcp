/**
 * Whole-feature WIP rulings.
 *
 * A scenario-scoped wip entry is ordinary debt: some of a feature is bound,
 * some is not, and the ratchet keeps it honest. A *whole-feature* entry is a
 * different animal — it means an entire surface of the product has a charter
 * that has never executed. 0.0.9-beta shipped exactly that: journal-install
 * was added and released in the same commit with all thirteen of its
 * scenarios unbound, so five field-reported defects walked past a suite that
 * had prose describing every one of them.
 *
 * The register was not dishonest then; it said plainly "awaiting the binding
 * wave". What was missing was any requirement to *decide* about that before
 * cutting a release. So a whole-feature entry now costs a written ruling
 * here, and the release gate (scripts/release-gate.ts) refuses to pack while
 * one exists unless the release explicitly names it as acceptable.
 */

export interface WholeFeatureWipRuling {
  /** Feature file stem, e.g. 'journal-policy'. */
  feature: string
  /** Why the whole surface is unbound, and what would end it. */
  reason: string
  /** ISO date the ruling was made or last reaffirmed. */
  ruledOn: string
  /**
   * The scenarios still unbound once part of the surface has bound. Present,
   * the runner holds open exactly these (scenario-scoped precision, so the
   * bound part keeps the full ratchet); absent, the whole feature is open.
   * Either way the ruling stands, and the release gate refuses on it, until
   * its own reason's leaving condition holds: binding some scenarios of a
   * surface is not the decision the gate asks for.
   */
  scenarios?: string[]
}

export const WHOLE_FEATURE_WIP: WholeFeatureWipRuling[] = [
  // The beta.3 subagent cut (interview 2026-10-29 to 2026-10-31, rulings
  // D279–D323): three surfaces scoped before their build, by design — the
  // feature files are the contract the build is measured against. Each
  // leaves the register when its scenarios bind. The release gate must
  // name any still here as acceptable for `0.1.0-beta.3`.
  {
    feature: 'journal-legs',
    reason: 'scoped 2026-10-31 before its build (D279–D285, D299, D305, D314, D320, D321); on 2026-11-01 unit 1 bound the store half of the leg contract (numbering, supersession named or stamped from the leg, two in effect, the walk back, the key settled by the leg\'s own write, the keyless subagent unchanged); on 2026-11-01 unit 2 bound the key lookup\'s reply for legs (the main agent\'s checkpoint flagged against the brief\'s checkpointer beside the one before it, a keyless leg counted in the run\'s facts, a silent leg live with its start and last write); leaves the register when the send-back, the recovery leg and the key lookup bind against real hook subprocesses',
    ruledOn: '2026-11-01',
    // Bound on 2026-11-01 with the leg's facts given by registerLeg, the
    // registry call the hooks door makes, after the real SubagentStart hook
    // registered the subagent (run-world.ts hooksLeg): to be re-bound
    // through the SubagentStart hook's own inference in unit 4 —
    //   'the checkpoint a leg writes at its end takes the next number and supersedes the one it started from'
    //   'two legs that started from one checkpoint write 4 and 5, never two 4s, and both stay in effect'
    //   "a checkpoint that names nothing as superseded is stamped from the leg's start, marked as the store's"
    //   'a checkpoint that names another checkpoint is taken at its word'
    //   'an inferred key gives way to the key the leg first writes under'
    //   "the leg's first write under a key settles an ambiguous registration"
    //   "a leg that writes under no key stays keyless, stops unblocked, and the run's facts count it as such" (unit 2)
    // and one bound on 2026-11-01 by unit 2 with the leg registered through
    // the library door at its own moment two hours back (registerLeg with
    // `at`; a hook subprocess cannot be started in the past), to be
    // re-bound when the hooks door's registration lands (unit 4) —
    //   'until its session restarts, a silent leg reads as live with its ages shown'
    // and "the builder's stop is not blocked" in the first of those is a
    // forward guard: today's SubagentStop hook never blocks; it holds once
    // the send-back lands (unit 4), since a checkpoint newer than the start
    // was written.
    scenarios: [
      // unit 4, the hooks door: the subagent-start hook's inference from
      // the role's brief and the first moment it emits, the stop hook's
      // send-back, the cut known at the session's next start, the
      // recovery leg, the pointer on the Agent tool's result (D279, D281,
      // D284, D285, D305, D314, D320, D325, D326, D327, D328, D329, D330,
      // D332, D334)
      "a leg's first moment is its brief and the checkpoint in effect, with no query made",
      'a fresh leg on a key with no checkpoint is told so, and its first checkpoint is number 1',
      'a leg that finishes with no checkpoint is sent back once with the missing checkpoint named',
      'a leg sent back once that then writes its checkpoint stops unblocked',
      'a leg sent back once is never sent back a second time',
      'no send-back when the store cannot be written',
      'a cut leg leaves its trail and the next leg of its role starts as a recovery leg',
      'a recovery leg writes the checkpoint its predecessor did not',
      'a cut leg leaves no checkpoint the store wrote',
      'the brief names who checkpointed the work resumed and who will checkpoint at the end',
      'a leg whose brief names another role as checkpointer is never sent back',
      "the pointer to a leg's summary row carries the leg's role, run and key",
      'the pointer comes back every time and the next leg starts from the store whether or not it was followed',
      'a subagent whose brief names a run and a key gets the leg contract',
      "the hooks door takes a leg's key from its role's newest brief and marks it inferred",
      'two briefs in effect for one role make the key ambiguous and name the candidates',
      'a leg through the hooks door starts cold when the store is unreachable, and the gap is marked',
      'a first moment of <chars> characters through the hooks door is <injected>',
      'a leg fetches the rest of a cut checkpoint by export and gets it whole',
      'an inferred key never makes the stop ask for a checkpoint',
      'a key the leg wrote under, marked as its own, makes the stop ask for the missing checkpoint',
      'a newer brief for the same role and key supersedes the older one',
      "a run's close ends its briefs",
      'a leg left live is retired as cut when its session next starts, and the next leg of its role recovers',
      'a leg starting while two checkpoints are in effect is handed both, flagged',
      "the pointer rides on the Agent tool's result and the subagent's final message is untouched",
      "every first moment says in treecontext's own words that a checkpoint is state, not history",
      'a leg that ended without a checkpoint after its one send-back is followed by a recovery leg',
      'a leg whose start was dropped stops unasked and its summary still lands',
      // unit 5, the checkpoint cap (D299, D321, D332)
      'a checkpoint of <chars> characters is <verdict> on its first write and <verdict2> on the second',
      'a second over-cap write by another leg or under another key is refused again',
      'a leg refused once that stops without writing a shorter checkpoint is sent back for it',
      "an over-cap checkpoint accepted on its second write is the one in effect, and the next leg's first-moment row shows what it cost",
    ],
  },
  {
    feature: 'journal-workers',
    reason: 'scoped 2026-10-31 before its build (D288, D291–D298, D303, D307, D313, D315–D317); on 2026-11-01 unit 1 bound the registry half of the ticket door (the parent declared or linked, what a registration carries, phantoms retired by the registry\'s readers against real processes, a library writer traced); on 2026-11-01 unit 3 bound the ticket door itself through real worker processes, the library call and the `treecontext run` wrapper each starting the stand-in headless worker (the ticket read from the environment, whole, damaged, blank-keyed or keyless, the first message and the first-moment row, the send-back once, the cut, the not-started rule, the exit the store cannot take, the self-minted ticket); leaves the register when the `claude -p` child binds through its hooks (unit 4): its registration as a worker, the first-moment row through its session-start hook, the send-back once across both doors',
    ruledOn: '2026-11-01',
    // Two outlines are bound in part: their rows through the hook-less door
    // of a `codex exec` worker (the wrapper) run on 2026-11-01, unit 3; the
    // rows through the session-start hook of a `claude -p` child wait on
    // unit 4, so the outlines stay listed until those rows bind —
    //   "the first-moment row is the first row of the worker's lane through the <door>"
    //   'a worker whose ticket is <damage> is registered with what was read, told its instructions were invalid, and ends visibly through the <door>'
    // The parent outline is bound in part too: its Claude Code row (the
    // real session-start hook) and its Codex row (the session-start command
    // of the verbatim copy `install --experimental-capture --agent codex`
    // writes, run as Codex runs it) bind; its Antigravity row cannot, since
    // this build writes no hooks for Antigravity (an archived-build platform,
    // MCP config only), so no unit owns it until Antigravity gets a hook
    // adapter, and the outline stays listed. Standing it in with another
    // CLI's hook would bind the row against something it does not name.
    scenarios: [
      'a <worker> worker under a <parent> parent writes into its own lane with its role as writer',
      // unit 4, the hooks door for a `claude -p` child (D295, D298, D303, D342)
      "the first-moment row is the first row of the worker's lane through the <door>",
      'both doors leave the same first-moment row, readable with plain SQL alone',
      'a worker whose ticket is <damage> is registered with what was read, told its instructions were invalid, and ends visibly through the <door>',
      'a `claude -p` child with a ticket is registered as a worker by the hook, never as a self',
      "the stop hook's send-back is the leg's one, and the wrapper starts no run after it",
      "when the stop hook could not ask, the wrapper's send-back is the leg's one",
    ],
  },
  {
    feature: 'journal-runs',
    reason: 'scoped 2026-10-31 before its build (D289, D296, D300–D302, D309–D312, D318); on 2026-11-01 unit 1 bound the plain-SQL read-back, the open and close, the run found by name, nested runs and the harness\'s lookup by run and key; on 2026-11-01 unit 2 bound the key lookup\'s whole reply (the flag in words against the brief\'s checkpointer, the run\'s facts and the sizes of the last three, a live leg\'s start and last write, the pointer to the writing leg\'s return or the line that it left none) and the agent\'s door to it and to a run\'s close through the tools; on 2026-11-01 unit 3 bound the run found by time through the first-moment, checkpoint and summary rows real workers left through the ticket door; leaves the register when the run export forms and the run come back by the handoff (D343) bind against the store file (unit 6)',
    ruledOn: '2026-11-01',
    // Bound on 2026-11-01 through run-world.ts hooksLeg (the real
    // SubagentStart hook, then registerLeg): to be re-bound through the
    // SubagentStart hook's own inference in unit 4 —
    //   "a run's rows read back by plain SQL in the order of their own moments, each naming its writer and moment, each leg naming its run and key"
    //   'the lookup reply carries the pointer to the return of the leg that wrote the checkpoint' (unit 2)
    //   'an agent gets the same lookup reply as the harness through the tools' (unit 2)
    scenarios: [
      // unit 6: run export forms and the handoff back (D300, D318, D343)
      'a leg that ran on another machine comes back into the run by the handoff, and its claim is believed, flagged',
      "a run's default export is its skeleton, with no captured tool output",
      'the whole form adds every row of every leg behind the secrets acknowledgement',
      "the skeleton carries first moments whole and its reply says they are the spawners' prompts as written",
    ],
  },
  // The hackathon re-cut (interview 2026-10-05 to 2026-10-07, rulings
  // D145–D202): four surfaces scoped before their build, by design — the
  // feature files are the contract the build is measured against. Each
  // leaves the register when its scenarios bind: the beta.1 set on
  // 2026-10-12 and the beta.2 set by 2026-10-16 (D197). The release gate
  // must name any still here as acceptable for `0.1.0-beta.1`.
  // journal-reorientation left the register 2026-10-08 — bound at the
  // beta.1 build, and its one beta.2 scenario (references, D186) bound
  // with the reverse index in chunk 5.
  // journal-orchestration left this register 2026-10-08 when references
  // bound (D186); as of 2026-10-08 its remaining scenarios (the subagent
  // summary and trail, scoped search, worktree self, self registration,
  // and the two lane scenarios on server-stamped writers, D169/D190) are
  // bound too, and features.test.ts carries none of them as wip.
  // journal-handoff left this register at the beta.1 build (2026-10-08):
  // the import rule is bound (marked and counted, store-wide identity,
  // claims as data, the packet's handoff line); as of 2026-10-08 the
  // file-bound handoff is bound as well (D170, D172, D177, D199).
  // journal-clients left this register at the beta.1 build (2026-10-08):
  // the matrix, the copying client's tools-only install and the teammate
  // on another agent are bound; as of 2026-10-08 doctor per client is
  // bound as well (D161, D208). The beta.2 set was built on 2026-10-08
  // and ships in `0.1.0-beta.1` (D253).
  // Empty, and worth keeping that way. journal-policy was the last entry and
  // was paid off rather than waived on 2026-08-03, the first time this gate
  // was exercised: binding it took one optional parameter on mcpOver plus a
  // subprocess check that a read_only server really does refuse to ingest —
  // a clause whose gate lives in startServer, where no in-process spin would
  // ever have reached it.
]

/** The runner's wip entries for every ruling: the feature's stem while
 *  the whole surface is open, its still-unbound scenarios once part of it
 *  has bound. */
export const wholeFeatureWip = (): Array<string | { feature: string; scenarios: string[] }> =>
  WHOLE_FEATURE_WIP.map(r => (r.scenarios ? { feature: r.feature, scenarios: r.scenarios } : r.feature))
