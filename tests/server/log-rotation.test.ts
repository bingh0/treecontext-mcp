/**
 * Log rotation by count (src/debug.ts MAX_LOG_FILES = 5).
 *
 * Rotation runs when a process OPENS its log (ensureLogFile), after its
 * own file exists — so the cap counts the opener's file. A server opens
 * one at `serve` start; every hook invocation opens one too (cli.ts calls
 * enableDebug() on the hook path), so the hooks rotate the directory on
 * their own. LOGS_DIR freezes from homedir() at import, so each case
 * spawns the real CLI under a redirected home.
 *
 * Protected from removal: a file written within the last 5 minutes
 * (ROTATION_GRACE_MS) or whose named pid is alive. Seeded files use pid 0
 * in their names — never a live process — so only age can protect them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnCli } from '../helpers/cli-spawn.js'

const MAX_LOG_FILES = 5

let home: string
let logs: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tc-logrot-'))
  logs = join(home, '.treecontext', 'logs')
  mkdirSync(logs, { recursive: true })
})
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

/** Seed `n` dead-writer logs, file i last written (i + 10) minutes ago. */
function seed(n: number): string[] {
  const names: string[] = []
  for (let i = 0; i < n; i++) {
    const name = `debug-2026-01-01T00-00-${String(i).padStart(2, '0')}-000Z-0.log`
    const p = join(logs, name)
    writeFileSync(p, `old log ${i}\n`)
    const t = new Date(Date.now() - (i + 10) * 60_000)
    utimesSync(p, t, t)
    names.push(name)
  }
  return names // names[0] is the newest
}
const listing = (): string[] => readdirSync(logs).filter((f) => f.startsWith('debug-')).sort()

describe('log rotation by count', () => {
  it('a hook leaves exactly the newest MAX_LOG_FILES (its own file counted)', () => {
    const seeded = seed(9)
    const r = spawnCli(['hook', 'stop'], { home })
    expect(r.status, r.out).toBe(0)
    const left = listing()
    expect(left).toHaveLength(MAX_LOG_FILES)
    // the hook's own file plus the newest MAX_LOG_FILES - 1 seeded ones
    for (const name of seeded.slice(0, MAX_LOG_FILES - 1)) expect(left).toContain(name)
    for (const name of seeded.slice(MAX_LOG_FILES - 1)) expect(left).not.toContain(name)
  })

  it('a serving server leaves exactly the newest MAX_LOG_FILES (its own file counted)', () => {
    const seeded = seed(9)
    const r = spawnCli(['serve'], { home, input: '' })
    expect(r.status, r.out).toBe(0)
    const left = listing()
    expect(left).toHaveLength(MAX_LOG_FILES)
    for (const name of seeded.slice(0, MAX_LOG_FILES - 1)) expect(left).toContain(name)
  })

  it('a file written within the last five minutes is left alone, even beyond the cap', () => {
    // six protected files (30 s .. 4.5 min old) exceed the cap on their
    // own; three unprotected ones (6, 7, 8 min old) are beyond it as well
    const ages = [0.5, 1, 2, 3, 4, 4.5, 6, 7, 8]
    const names = ages.map((min, i) => {
      const name = `debug-2026-01-01T00-00-${String(i).padStart(2, '0')}-000Z-0.log`
      const p = join(logs, name)
      writeFileSync(p, 'x\n')
      const t = new Date(Date.now() - min * 60_000)
      utimesSync(p, t, t)
      return name
    })
    const r = spawnCli(['hook', 'stop'], { home })
    expect(r.status, r.out).toBe(0)
    const left = listing()
    for (const name of names.slice(0, 6)) expect(left, 'a recently written file was rotated away').toContain(name)
    for (const name of names.slice(6)) expect(left, 'an old file beyond the cap survived').not.toContain(name)
    expect(left).toHaveLength(7) // six protected + the hook's own
  })
})
