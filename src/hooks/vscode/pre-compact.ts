/**
 * Copilot preCompact → the reference pre-compact hook.
 */
import { isDirectInvocation } from '../shared.js'
import { parseAndNormalize } from './normalize.js'
import { main as referenceMain } from '../pre-compact.js'

export function main(): void {
  referenceMain(parseAndNormalize())
}

const isMain = isDirectInvocation(import.meta.url)
if (isMain) main()
