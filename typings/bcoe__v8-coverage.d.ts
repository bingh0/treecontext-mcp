/**
 * Ambient types for @bcoe/v8-coverage, which ships none. Only the one
 * function the merged coverage provider (scripts/coverage/provider.ts)
 * calls, over the shapes Node writes under NODE_V8_COVERAGE.
 */

declare module '@bcoe/v8-coverage' {
  import type { Profiler } from 'node:inspector'

  interface ProcessCov {
    result: Profiler.ScriptCoverage[]
  }

  /** Union of several processes' coverage: one entry per script URL, ranges merged. */
  function mergeProcessCovs(processCovs: ProcessCov[]): ProcessCov

  export { mergeProcessCovs }
  export type { ProcessCov }
}
