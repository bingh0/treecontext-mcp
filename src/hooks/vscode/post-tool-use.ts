/**
 * Copilot postToolUse → the reference post-tool-use hook.
 *
 * Delegating is what brings this adapter onto the capture charter. The
 * previous copy dropped Read/Glob/Grep-class invocations outright; the
 * charter says no invocation is ever filtered out, and the reference
 * implementation keeps them as trail (bounded preview, no full tail)
 * while execution and external output keep their full-fidelity tail.
 */
import { isDirectInvocation } from '../shared.js'
import { parseAndNormalize } from './normalize.js'
import { main as referenceMain } from '../post-tool-use.js'

export function main(): void {
  referenceMain(parseAndNormalize())
}

const isMain = isDirectInvocation(import.meta.url)
if (isMain) main()
