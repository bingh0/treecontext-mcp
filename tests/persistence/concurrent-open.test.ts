/**
 * Several processes opening one store at the same instant must all get
 * through the wrapped opener's pragmas (journal_mode = WAL, ...).
 *
 * The race (tests/legs-and-runs.test.ts "two writer processes racing"):
 * the wrapper ran `journal_mode = WAL` BEFORE `busy_timeout`, so on a
 * DatabaseSync built with node:sqlite's default (timeout 0) the loser of
 * the open threw "database is locked" instead of waiting. Measured before
 * the fix: six writers, 12 of 20 rounds had a casualty.
 */
import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { openNodeSqlite } from '../../src/persistence/node-sqlite.js'
import { TS_ROOT, tsxArgv } from '../journal/proc.js'

const OPENERS = 6
const ROUNDS = 8

describe('simultaneous opens of one store from several processes', () => {
  it('every opener gets through the pragma list', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-concopen-'))
    try {
      for (let round = 0; round < ROUNDS; round++) {
        const dbPath = join(dir, `store-${round}.db`)
        const raw = new DatabaseSync(dbPath)
        openNodeSqlite(raw).exec('CREATE TABLE t (x)')
        raw.close() // the next first opener has to recover the WAL
        const barrier = mkdtempSync(join(dir, 'barrier-'))
        const runs = Array.from({ length: OPENERS }, () => new Promise<string | null>((resolve) => {
          const child = spawn(process.execPath, tsxArgv(join(TS_ROOT, 'tests', 'helpers', 'concurrent-opener.ts'), dbPath, barrier), { cwd: TS_ROOT, stdio: ['ignore', 'ignore', 'pipe'] })
          let err = ''
          child.stderr.on('data', (d) => { err += String(d) })
          child.on('exit', (code) => resolve(code === 0 ? null : (err || `exit ${code}`)))
        }))
        await new Promise((r) => setTimeout(r, 1500)) // let every child finish booting
        writeFileSync(join(barrier, 'go'), '')
        const failures = (await Promise.all(runs)).filter((r) => r !== null)
        expect(failures, `round ${round}`).toEqual([])
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
