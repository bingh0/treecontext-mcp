/**
 * Subprocess toolkit shared by every journal wave — the repo root, this
 * tier's spelling of the tsx spawn argv, and the kill-and-wait teardown.
 * Split from the capture harness (extraction review, 2026-08-26): these
 * helpers were never capture-specific — both sibling harnesses and five
 * steps modules use them — and keeping them there made every wave load
 * the capture harness's imports transitively.
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { nodeTsArgs } from '../helpers/cli-spawn.js'

export const TS_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/**
 * argv for running a TypeScript entry point under tsx — the journal wave's
 * variadic spelling of helpers/cli-spawn's nodeTsArgs, which is where the
 * recipe (and the Windows/.bin history behind it) lives. Two independent
 * spellings of the loader argv is exactly how one platform's lane regresses
 * while the other stays green, so there is one, and this is a call into it.
 */
export const tsxArgv = (script: string, ...args: string[]): string[] =>
  nodeTsArgs(script, args)

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Kill a spawned server and WAIT for it to be gone before its directory is
 * removed.
 *
 * Windows will not unlink a file another process still holds open, and
 * ChildProcess.kill() only DELIVERS the signal — it does not wait for the
 * process to die. That was invisible while these servers never started on
 * Windows at all; the moment the tsx spawn was fixed they became real
 * processes holding real store files, and four scenarios began failing on
 * EPERM in teardown. The wait is bounded: a server that will not die should
 * surface as a loud EPERM, not as a suite that hangs.
 */
export function killAndWait(child: ReturnType<typeof spawn>): () => Promise<void> {
  return async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit')   // registered BEFORE the kill, or the event can be missed
    child.kill('SIGKILL')
    await Promise.race([exited, sleep(5_000)])
  }
}
