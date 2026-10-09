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
}

export const WHOLE_FEATURE_WIP: WholeFeatureWipRuling[] = [
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

/** Feature stems carrying a whole-feature ruling, for the runner's wip list. */
export const wholeFeatureWip = (): string[] => WHOLE_FEATURE_WIP.map(r => r.feature)
