/**
 * hookStoreOn opens the wrapper and the journal on a hook's connection
 * (the hooks door). Those opens wait what is LEFT of the hook's budget
 * (`since` is where the budget began), not the wrapper's 10 s default:
 * a write lock another process takes after the hook's own open used to
 * hold the hook for 10 s on top of whatever it had already waited.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { openNodeSqlite, pragmaValue } from '../../src/persistence/node-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { openHookDb, hookBudgetLeftMs, HOOK_DB_TIMEOUT_MS } from '../../src/hooks/shared.js'
import { hookStoreOn } from '../../src/hooks/hook-store.js'
import { TS_ROOT } from '../journal/proc.js'

describe.skipIf(process.platform === 'win32')('hookStoreOn waits what is left of the hook budget', () => {
  it('against a write lock taken after the open, it gives up inside the remainder, not at the wrapper\'s 10 s', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-hsb-'))
    const dbPath = join(dir, 'treecontext.db')
    const seed = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(dbPath)), retentionInterval: 1e6 })
    await seed.close()
    const raw = openHookDb(dbPath)
    const locker = spawn(process.execPath, [join(TS_ROOT, 'tests', 'helpers', 'store-write-locker.cjs'), dbPath], { stdio: ['ignore', 'pipe', 'inherit'] })
    try {
      await new Promise<void>((resolve, reject) => {
        let seen = ''
        const bail = setTimeout(() => reject(new Error(`the locker never locked: ${seen}`)), 20_000)
        locker.stdout!.on('data', (c: Buffer) => { seen += c.toString(); if (/locked \d+/.test(seen)) { clearTimeout(bail); resolve() } })
        locker.once('exit', (code) => { clearTimeout(bail); reject(new Error(`the locker exited ${code}: ${seen}`)) })
      })
      // The hook has already used 5.5 s of its budget: 1.5 s are left.
      const since = Date.now() - (HOOK_DB_TIMEOUT_MS - 1500)
      const left = hookBudgetLeftMs(since)
      expect(left).toBeGreaterThan(1000)
      expect(left).toBeLessThanOrEqual(1500)
      const t0 = Date.now()
      let outcome: unknown = 'opened'
      try { outcome = await hookStoreOn(raw, dbPath, null, since) } catch (err) { outcome = (err as Error).message }
      const took = Date.now() - t0
      // Slack 3 s on every OS (the macOS runner's busy wait overran 1.5 s by
      // 0.3 s, run 41654065600); the wrapper's 10 s this guards against
      // still fails it.
      expect(took, `hookStoreOn took ${took} ms (${String(outcome).slice(0, 80)}) with ${left} ms of the budget left`).toBeLessThan(left + 3000)
      // and the connection leaves with the remainder as its busy wait, not 10 s
      const wait = pragmaValue(raw, 'busy_timeout') as number
      expect(wait).toBeLessThanOrEqual(1500)
    } finally {
      try { locker.kill('SIGKILL') } catch { /* gone */ }
      raw.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
