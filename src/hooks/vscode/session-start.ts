/**
 * Copilot sessionStart → the reference session-start hook.
 *
 * The adapter's only job is payload translation; the capture behavior
 * itself is the reference platform's, so the two can no longer drift.
 */
import { isDirectInvocation } from '../shared.js'
import { parseAndNormalize } from './normalize.js'
import { main as referenceMain } from '../session-start.js'

export function main(): void {
  referenceMain(parseAndNormalize())
}

const isMain = isDirectInvocation(import.meta.url)
if (isMain) main()
