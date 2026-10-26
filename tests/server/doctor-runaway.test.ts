/**
 * D265 — doctor's runaway staging row offers a kill only for a process it
 * can stop: a drain lease that is live AND held on this host. An expired
 * lease, or one held on another host, gets the plain command instead
 * (D51: the fix is a bare runnable command). The charter scenario
 * (journal-install @D265) binds the live-and-local case.
 *
 * The real hook subprocess creates the store and binds the repository
 * directory to it under a sandboxed HOME; the row and the lease are
 * written through the real staging and lease APIs; the real doctor CLI
 * reads them.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { spawnCli, spawnNodeTs } from '../helpers/cli-spawn.js'
import { storesDirIn } from '../helpers/store-fixtures.js'
import { TS_ROOT } from '../journal/proc.js'
import { FlatStore } from '../../src/flat-store.js'
import { openNodeSqlite } from '../../src/persistence/node-sqlite.js'
import { LeaseClient, DRAIN_LEASE_TTL_SECS } from '../../src/persistence/leases.js'
import { MAX_INGEST_ATTEMPTS } from '../../src/persistence/capture-constants.js'

const homes: string[] = []
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }) })

async function runawayDoctor(lease: { host: string; expire: boolean }): Promise<{ row: string; fix: string }> {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-doctor-runaway-')))
  homes.push(home)
  const hook = spawnNodeTs(join(TS_ROOT, 'src', 'hooks', 'user-prompt-submit.ts'), [], {
    home, cwd: TS_ROOT,
    input: JSON.stringify({ session_id: 'cc-runaway', cwd: TS_ROOT, hook_event_name: 'UserPromptSubmit', prompt: 'binds this directory' }),
  })
  expect(hook.status, hook.out).toBe(0)
  const bindings = JSON.parse(readFileSync(join(home, '.treecontext', 'bindings.json'), 'utf8')) as { projects: Record<string, { store: string }> }
  const dbPath = join(storesDirIn(home), Object.values(bindings.projects)[0]!.store, 'treecontext.db')
  const store = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(dbPath)), ownsDatabase: true })
  try {
    const id = store.store.insertStaging({ sessionId: 'cc-runaway', role: 'user', content: 'stuck', timestamp: Date.now() / 1000 - 3600 })
    for (let i = 0; i <= 10 * MAX_INGEST_ATTEMPTS; i++) store.store.incrementStagingAttempts(id)
    new LeaseClient(store.store.database, { pid: 4242, host: lease.host }).tryAcquire('drain', DRAIN_LEASE_TTL_SECS)
    if (lease.expire) {
      // Test fixture: a heartbeat two TTLs old, the shape a dead holder leaves.
      store.store.database.prepare("UPDATE leases SET heartbeat_at = heartbeat_at - ? WHERE role = 'drain'").run(2 * DRAIN_LEASE_TTL_SECS)
    }
  } finally {
    await store.close()
  }
  const run = spawnCli(['doctor'], { home, cwd: TS_ROOT })
  const lines = run.stdout.split('\n')
  const at = lines.findIndex((l) => /^\[\w+\]\s+Capture debt:/.test(l))
  expect(at, run.out).toBeGreaterThan(-1)
  return { row: lines[at]!, fix: lines[at + 1] ?? '' }
}

describe('doctor: the runaway staging row\'s fix (D265)', () => {
  it('a lease held on another host gets the plain command, never a kill', async () => {
    const { row, fix } = await runawayDoctor({ host: 'elsewhere.invalid', expire: false })
    expect(row).toContain('the drain is held by pid 4242@elsewhere.invalid')
    expect(row).toContain('Quit every running session')
    expect(fix).toBe('       fix: treecontext doctor --dump-logs')
  })

  it('an expired lease names the last holder and gets the plain command', async () => {
    const { hostname } = await import('node:os')
    const { row, fix } = await runawayDoctor({ host: hostname(), expire: true })
    expect(row).toContain(`pid 4242@${hostname()}, its lease expired — the last holder`)
    expect(fix).toBe('       fix: treecontext doctor --dump-logs')
  })
})
