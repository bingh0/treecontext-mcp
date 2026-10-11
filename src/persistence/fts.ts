/**
 * FTS5 role-weight helpers for the `nodes_fts` bm25() ranking.
 */

import type { RoleWeights } from '../core/types.js'
import { ValidationError } from '../errors/index.js'

export type { RoleWeights }

/** Two-corpus evidence (weighted-arm ledger): assistant 0.25 is the
 *  best-of-program weight. Tool text was lowered to 0.25 on 2026-10-10
 *  (D260): on two live stores captured tool output, echoes of the
 *  orientation query's own earlier runs among it, flooded that query at a
 *  tie with curated notes. Then to 0.1 (D272), on the mature-journal
 *  arm's sweep re-run on captures made under D270 (bench/README.md):
 *  shell-ordering, how matching shell rows order among themselves, holds
 *  53.06% MRR@5 at every weight from 1.0 down to 0.1 and collapses to
 *  8.33% at 0 (weight 0 flattens the column's term frequency); at the
 *  sweep's recency of 0.5 shell rows reached the orientation query's
 *  first page in 6 of 30 slots at 1.0, 1 at 0.25 and none at 0.1, so 0.1
 *  keeps a margin below the weights that let them in; against 0.25 the
 *  aggregate moves within noise. User and note stay at full weight. */
export const DEFAULT_ROLE_WEIGHTS: Required<RoleWeights> = {
  user: 1.0,
  assistant: 0.25,
  tool: 0.1,
  note: 1.0,
}

export const ROLE_WEIGHT_MIN = 0
export const ROLE_WEIGHT_MAX = 10

/** FG-8: negative weights invert a column's contribution (actively
 *  promotes non-matching rows); absurdly large weights swamp the others.
 *  Reject out-of-range weights before they ever reach bm25(). */
export function validateRoleWeights(weights: RoleWeights): void {
  for (const [key, value] of Object.entries(weights)) {
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value < ROLE_WEIGHT_MIN || value > ROLE_WEIGHT_MAX) {
      throw new ValidationError(
        `role weight "${key}" must be between ${ROLE_WEIGHT_MIN} and ${ROLE_WEIGHT_MAX}, got ${String(value)}`,
      )
    }
  }
}

/**
 * FG-3: the ONE place that builds the bm25 weight vector. bm25() silently
 * defaults omitted TRAILING weights to 1.0 (pinned in
 * features/design/role-weighted-fts.feature
 * / the role-weighted-fts scenario "an omitted trailing weight silently
 * means one point zero") — a forgotten fourth argument full-weights a
 * column with no error anywhere. Always returning all four, in column
 * order, from a single total function makes that arity mistake structurally
 * impossible for callers.
 */
export function roleWeightVector(overrides?: RoleWeights): [number, number, number, number] {
  if (overrides) validateRoleWeights(overrides)
  const w = { ...DEFAULT_ROLE_WEIGHTS, ...overrides }
  return [w.user, w.assistant, w.tool, w.note]
}

