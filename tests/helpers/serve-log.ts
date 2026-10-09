/**
 * A sandboxed process's debug log, read as a test reads stderr (D258).
 *
 * A serving server writes its diagnostics — the startup facts, the drain's
 * ticks, the shutdown line — to `<HOME>/.treecontext/logs/debug-*.log`
 * only; its stderr carries warnings, errors and fatals. A test that waits
 * for a diagnostic therefore watches the file in the child's sandbox HOME.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Everything a sandboxed process has written to its debug log files,
 *  oldest file first. */
export function readServeLog(home: string): string {
  const dir = join(home, '.treecontext', 'logs')
  if (!existsSync(dir)) return ''
  return readdirSync(dir)
    .filter((f) => f.startsWith('debug-') && f.endsWith('.log'))
    .sort()
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('')
}

/**
 * Poll the log until `marker` appears (or the timeout runs out), returning
 * everything seen — the caller asserts on the transcript, so a miss fails
 * with the evidence attached rather than a bare timeout.
 */
export async function waitForServeLog(
  home: string, marker: string, timeoutMs = 30_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let seen = readServeLog(home)
  while (!seen.includes(marker) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
    seen = readServeLog(home)
  }
  return seen
}
