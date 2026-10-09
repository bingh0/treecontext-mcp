/**
 * Copilot userPromptSubmitted → the reference user-prompt-submit hook.
 */
import { isDirectInvocation } from '../shared.js'
import { parseAndNormalize } from './normalize.js'
import { main as referenceMain } from '../user-prompt-submit.js'

export function main(): void {
  referenceMain(parseAndNormalize())
}

const isMain = isDirectInvocation(import.meta.url)
if (isMain) main()
