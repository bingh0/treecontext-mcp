import type { Arm } from './types.js'
import { lmeSQuestions } from './lme-s-questions.js'
import { lmeV2Goals } from './lme-v2-goals.js'
import { codeFixture } from './code-fixture.js'
import { matureJournal } from './mature-journal.js'

/**
 * The arm registry.
 *
 * Adding an arm is adding a file here — corpus spec, mapping, gold labels,
 * metric — and nothing else changes. That is the extension point.
 *
 * The arms answer different questions and are deliberately not
 * averaged together:
 *   lme-s-questions — published gold labels on chat. Little headroom
 *     (BM25 at 91.5%), so it confirms rather than adjudicates.
 *   lme-v2-goals    — agentic trajectories, derived labels, real headroom.
 *   code-fixture    — the vocabulary no public corpus has, reported by
 *     query kind so the identifier-vs-paraphrase contrast is visible.
 *   mature-journal  — the capture-path arm: a synthesized journal made
 *     through the real hooks and drain, read at the served defaults.
 */
export const ARMS: Arm[] = [lmeSQuestions, lmeV2Goals, codeFixture, matureJournal]

export function findArm(id: string): Arm | undefined {
  return ARMS.find(a => a.id === id)
}

export type { Arm, ArmRun } from './types.js'
