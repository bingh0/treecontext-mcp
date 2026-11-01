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
    reason: 'scoped 2026-10-31 before its build (D279–D285, D299, D305, D314, D320, D321); on 2026-11-01 unit 1 bound the store half of the leg contract (numbering, supersession named or stamped from the leg, two in effect, the walk back, the key settled by the leg\'s own write, the keyless subagent unchanged); on 2026-11-01 unit 2 bound the key lookup\'s reply for legs (the main agent\'s checkpoint flagged against the brief\'s checkpointer beside the one before it, a keyless leg counted in the run\'s facts, a silent leg live with its start and last write); leaves the register when the send-back, the recovery leg and the key lookup bind against real hook subprocesses; on 2026-11-01 unit 4 bound them (the hooks door: the first moment, the inference from the role\'s brief, the cap\'s cut, the send-back once, the cut at the next start, the recovery leg, the pointer on the Agent tool\'s result, the dropped start), so that condition holds, and the ruling stays only for the checkpoint cap\'s four scenarios (unit 5)',
    ruledOn: '2026-11-01',
    // The hooks door bound on 2026-11-01 (unit 4): every legs scenario
    // but unit 5's four runs through the real SubagentStart hook, which
    // infers the leg from its role's brief in effect, the real SubagentStop
    // hook (the send-back once), the real SessionStart hook (the cut known
    // at the next start) and the real PostToolUse hook on the Agent tool's
    // result (the pointer). The seven unit 1 and 2 scenarios once bound
    // through run-world.ts hooksLeg's registry call, and "until its session
    // restarts, a silent leg reads as live with its ages shown", are
    // re-bound through the hook's own inference (the last at the hook's own
    // clock, set to two hours back). What stays is unit 5's.
    scenarios: [
      // unit 5, the checkpoint cap (D299, D321, D332)
      'a checkpoint of <chars> characters is <verdict> on its first write and <verdict2> on the second',
      'a second over-cap write by another leg or under another key is refused again',
      'a leg refused once that stops without writing a shorter checkpoint is sent back for it',
      "an over-cap checkpoint accepted on its second write is the one in effect, and the next leg's first-moment row shows what it cost",
    ],
  },
  // journal-workers left this register on 2026-11-01 (unit 4) by its own
  // leaving condition: the `claude -p` child binds through its hooks (its
  // registration as a worker, the first-moment row through its
  // session-start hook, the send-back once across both doors). Its one
  // unbound row, the Antigravity parent of the parent outline, is a
  // scenario-scoped wip entry in features.test.ts: no hook adapter exists
  // for Antigravity, a charter question for the owner.
  {
    feature: 'journal-runs',
    reason: 'scoped 2026-10-31 before its build (D289, D296, D300–D302, D309–D312, D318); on 2026-11-01 unit 1 bound the plain-SQL read-back, the open and close, the run found by name, nested runs and the harness\'s lookup by run and key; on 2026-11-01 unit 2 bound the key lookup\'s whole reply (the flag in words against the brief\'s checkpointer, the run\'s facts and the sizes of the last three, a live leg\'s start and last write, the pointer to the writing leg\'s return or the line that it left none) and the agent\'s door to it and to a run\'s close through the tools; on 2026-11-01 unit 3 bound the run found by time through the first-moment, checkpoint and summary rows real workers left through the ticket door; leaves the register when the run export forms and the run come back by the handoff (D343) bind against the store file (unit 6)',
    ruledOn: '2026-11-01',
    // The three runs scenarios once bound through run-world.ts hooksLeg's
    // registry call are re-bound (unit 4, 2026-11-01) through the real
    // SubagentStart hook's own inference from the role's brief.
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
