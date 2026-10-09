/**
 * Tool-access policies for the MCP server.
 *
 * A running server exposes one of three policies:
 *
 * - `full`        — all tools. Default. Matches single-agent / project use.
 * - `read_only`   — query + status + export (no mutations). Use for
 *                   sub-agents that should consume context but never
 *                   modify it.
 * - `contributor` — insert in addition to the read_only
 *                   tools. CANNOT delete, clear,
 *                   import, or merge_from_agent. Intended for sub-agents
 *                   feeding findings into a shared namespace without
 *                   risking catastrophic loss (their work gets reviewed
 *                   by a `full` supervisor).
 *
 * `treecontext_merge_from_agent` is gated to `full` only — grafting
 * another namespace's subtree is a supervisor-level action.
 *
 * Kept as a flat allow-list rather than a role matrix; three policies is
 * small enough that matrixification would be more indirection than it's
 * worth.
 */

export const POLICIES = ['full', 'read_only', 'contributor'] as const
export type Policy = (typeof POLICIES)[number]

export const DEFAULT_POLICY: Policy = 'full'

/** THE policy resolution — explicit policy wins, --read-only is
 *  shorthand for read_only, otherwise the default. Four call sites
 *  used to inline this formula (two with a hardcoded 'full'), and the
 *  drain-lease gate agreed with the ingestion-loop gate only because
 *  the copies happened to match (pass-2 review 2026-08-15). */
export function effectivePolicy(policy: Policy | null | undefined, readOnly: boolean | undefined): Policy {
  return policy ?? (readOnly ? 'read_only' : DEFAULT_POLICY)
}

/**
 * Every tool the MCP server registers. Kept in one place so the
 * allow-list below and any future additions stay in sync.
 */
export type ToolName =
  | 'treecontext_insert'
  | 'treecontext_query'
  | 'treecontext_status'
  | 'treecontext_delete'
  | 'treecontext_clear'
  | 'treecontext_export'
  | 'treecontext_import'
  | 'treecontext_merge_from_agent'

const ALLOW: Record<Policy, ReadonlySet<ToolName>> = {
  full: new Set<ToolName>([
    'treecontext_insert',
    'treecontext_query',
    'treecontext_status',
    'treecontext_delete',
    'treecontext_clear',
    'treecontext_export',
    'treecontext_import',
    'treecontext_merge_from_agent',
  ]),
  read_only: new Set<ToolName>([
    'treecontext_query',
    'treecontext_status',
    'treecontext_export',
  ]),
  contributor: new Set<ToolName>([
    'treecontext_insert',
    'treecontext_query',
    'treecontext_status',
    'treecontext_export',
  ]),
}

export function policyAllows(policy: Policy, tool: ToolName): boolean {
  return ALLOW[policy].has(tool)
}

/**
 * Conversation capture is active only when explicitly requested AND the
 * policy permits writes. A `read_only` server consumes context but never
 * mutates it, so it ingests no captured events (MVP Step 6A, AC6A.5).
 * `contributor` and `full` both allow capture (both can insert).
 */
export function captureEnabled(captureFlag: boolean | undefined, policy: Policy): boolean {
  return !!captureFlag && policy !== 'read_only'
}
