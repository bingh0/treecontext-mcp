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
    reason: 'scoped 2026-10-31 before its build (D279–D285, D299, D305, D314, D320, D321); on 2026-11-01 unit 1 bound the store half of the leg contract (numbering, supersession named or stamped from the leg, two in effect, the walk back, the key settled by the leg\'s own write, the keyless subagent unchanged); leaves the register when the send-back, the recovery leg and the key lookup bind against real hook subprocesses',
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
      // unit 2, the lookup reply: the flag in words (D296), the run's
      // facts counting a keyless leg and showing a live leg's ages
      // (D301, D312, D320)
      "a checkpoint the main agent writes under a leg's key comes back flagged, never withheld",
      "a leg that writes under no key stays keyless, stops unblocked, and the run's facts count it as such",
      'until its session restarts, a silent leg reads as live with its ages shown',
      // unit 5, the checkpoint cap (D299, D321, D332)
      'a checkpoint of <chars> characters is <verdict> on its first write and <verdict2> on the second',
      'a second over-cap write by another leg or under another key is refused again',
      'a leg refused once that stops without writing a shorter checkpoint is sent back for it',
      "an over-cap checkpoint accepted on its second write is the one in effect, and the next leg's first-moment row shows what it cost",
    ],
  },
  {
    feature: 'journal-workers',
    reason: 'scoped 2026-10-31 before its build (D288, D291–D298, D303, D307, D313, D315–D317); on 2026-11-01 unit 1 bound the registry half of the ticket door (the parent declared or linked, what a registration carries, phantoms retired by the registry\'s readers against real processes, a library writer traced); leaves the register when the door and the first-moment row bind through real worker processes',
    ruledOn: '2026-11-01',
    scenarios: [
      // unit 3, the ticket door: the ticket read from the environment,
      // the first message and first-moment row, the wrapper and the
      // library spawner's send-back once, retirement at exit with the
      // summary row, a damaged or keyless ticket, the not-started rule
      // (D288, D291, D292, D293, D298, D303, D307, D313, D315, D316,
      // D329, D332, D335, D340, D341, D342)
      'a <worker> worker under a <parent> parent writes into its own lane with its role as writer',
      'a worker is retired at exit and its last output is the summary row the pointer names',
      "the ticket door composes a worker's first message from the brief, the checkpoint in effect and the spawner's prompt",
      'a first moment with no checkpoint in effect is the brief and the prompt',
      "the first-moment row is the first row of the worker's lane through the <door>",
      'both doors leave the same first-moment row, readable with plain SQL alone',
      'an empty spawner prompt still leaves the first-moment row',
      'a first-moment row keeps a pasted prompt whole behind a bounded preview',
      "a stranger's checkpoint reaches the worker's first moment flagged in words",
      'a hook-less worker that finishes without a checkpoint is run once more by the <spawner> that started it',
      'the wrapper never runs a worker a third time',
      'a worker that claimed a ticket with no wrapper gets no send-back and ends visibly without a checkpoint',
      'a worker whose ticket names another role as checkpointer is never sent back',
      'a worker whose ticket declares no door gets no send-back',
      'an exit by signal is a cut, never sent back, and the next leg of the role is a recovery leg',
      'a worker that exits on its own error is finished and gets the one send-back',
      "an unregistered writer's row through the <door> is accepted and traced, never refused",
      'a worker whose ticket is <damage> is registered with what was read, told its instructions were invalid, and ends visibly through the <door>',
      'the ticket door that sees the fault before spawning writes the row itself and spawns nothing',
      'a worker is not started while the store cannot be read, and the spawner is told',
      'a checkpoint the store cannot take at exit is lost from the store, not from the spawner',
      "a worker's first message carries both checkpoints when two are in effect",
      "the ticket door's first message says in treecontext's own words that a checkpoint is state, not history",
      "a worker's re-run for its missing checkpoint is the same leg in the same lane",
      'a ticket that says nothing about the door is read as declaring one',
      'a ticket that says in words the worker has no key starts a one-off worker',
      'a ticket whose key is merely blank is damage',
      'a worker whose ticket still named its run is listed under that run; one that named neither is reachable only by its exit line and parent',
      // unit 4, the hooks door for a `claude -p` child (D295)
      'a `claude -p` child with a ticket is registered as a worker by the hook, never as a self',
      "the stop hook's send-back is the leg's one, and the wrapper starts no run after it",
      "when the stop hook could not ask, the wrapper's send-back is the leg's one",
    ],
  },
  {
    feature: 'journal-runs',
    reason: 'scoped 2026-10-31 before its build (D289, D296, D300–D302, D309–D312, D318); on 2026-11-01 unit 1 bound the plain-SQL read-back, the open and close, the run found by name, nested runs and the harness\'s lookup by run and key; leaves the register when the key lookup with run facts and the run export forms bind against the store file',
    ruledOn: '2026-11-01',
    // Bound on 2026-11-01 through run-world.ts hooksLeg (the real
    // SubagentStart hook, then registerLeg): to be re-bound through the
    // SubagentStart hook's own inference in unit 4 —
    //   "a run's rows read back by plain SQL in the order of their own moments, each naming its writer and moment, each leg naming its run and key"
    scenarios: [
      // unit 2: the lookup reply (D296, D301, D312, D336, D337, D344)
      "a stranger's checkpoint comes back as the one in effect, flagged against the named checkpointer",
      'a checkpoint by the named checkpointer comes back with no flag',
      "every key lookup carries the run's facts beside the checkpoint",
      "the run's facts show each live leg's start and last write",
      'the lookup reply carries the pointer to the return of the leg that wrote the checkpoint',
      'a leg that left no return is said so, never guessed',
      'an agent gets the same lookup reply as the harness through the tools',
      "an agent closes a run through the tools and the record is the same as the harness's",
      'a key with <count> checkpoints returns the sizes of the last <shown>',
      // units 3 and 4: first-moment rows and summary rows carrying the run (D309)
      'an agent finds a run by time with no id in hand',
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
