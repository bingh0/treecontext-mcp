/**
 * Subprocess driver for the concurrent-bindings scenario
 * (store-bindings.feature): resolves ONE project directory's store name
 * and prints the result as JSON. The scenario's whole point is that six
 * of these run as genuinely separate processes against one bindings
 * file — an in-process interleaving cannot exercise the cross-process
 * lock at all.
 *
 * The optional barrier directory makes the overlap real rather than
 * lucky: each driver announces itself with a ready file, then spins
 * until the test drops the go file, so all six enter resolution within
 * the same few milliseconds.
 */
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { resolveStoreName } from '../../src/server/bindings.js'

const projectDir = process.argv[2]
const barrierDir = process.argv[3]
if (!projectDir) throw new Error('usage: resolve-driver <projectDir> [barrierDir]')

if (barrierDir) {
  writeFileSync(join(barrierDir, `ready-${process.pid}`), '')
  const goFile = join(barrierDir, 'go')
  const deadline = Date.now() + 30_000
  while (!existsSync(goFile)) {
    if (Date.now() > deadline) throw new Error('barrier go-file never appeared')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
  }
}

process.stdout.write(JSON.stringify(resolveStoreName(projectDir)))
