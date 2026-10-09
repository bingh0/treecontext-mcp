/**
 * The handoff's terminal door (D199): `treecontext export <path>` and
 * `treecontext import <path>` move the same files the tools do. Driven
 * through the real CLI as a subprocess in a sandboxed home, against real
 * stores on disk, read back off their SQLite files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import BetterSqlite3 from 'better-sqlite3'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { exporterName } from '../../src/handoff.js'
import { spawnCli } from '../helpers/cli-spawn.js'

let dir: string
let home: string
let repoA: string
let repoB: string
beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-handoff-cli-')))
  home = join(dir, 'home')
  repoA = join(dir, 'a', 'hackathon-app')
  repoB = join(dir, 'b', 'hackathon-app')
  for (const d of [home, repoA, repoB]) mkdirSync(d, { recursive: true })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

async function storeA(): Promise<string> {
  const path = join(dir, 'a.db')
  const store = await FlatStore.open({ database: wrapBetterSqlite(new BetterSqlite3(path)), ownsDatabase: true })
  await store.insert('plan: wire the login form; next: write its tests', { metadata: { next_session: true } })
  await store.insert('$ cat .env\nAPI_KEY=not-a-real-key', { metadata: { source: 'auto-capture', role: 'tool', tool_name: 'Bash', session_id: 's1' } })
  await store.close()
  return path
}

describe('treecontext export and import', () => {
  it('a summaries file exported in one shell imports in another, marked as a handoff', async () => {
    const a = await storeA()
    const out = spawnCli(['export', 'handoffs/login-plan.json', '--store', a, '--no-debug'], { home, cwd: repoA })
    expect(out.status, out.out).toBe(0)
    expect(out.stdout.trim()).toBe('Wrote 1 entry to handoffs/login-plan.json.')
    // B's pull.
    mkdirSync(join(repoB, 'handoffs'))
    const file = readFileSync(join(repoA, 'handoffs/login-plan.json'), 'utf8')
    expect(JSON.parse(file).to_import).toContain('treecontext import handoffs/login-plan.json')
    const bFile = join(repoB, 'handoffs/login-plan.json')
    writeFileSync(bFile, file)
    const b = join(dir, 'b.db')
    const run = (): ReturnType<typeof spawnCli> => spawnCli(['import', 'handoffs/login-plan.json', '--store', b, '--no-debug'], { home, cwd: repoB })
    const first = run()
    expect(first.status, first.out).toBe(0)
    expect(first.stdout.trim()).toBe('1 entry landed; 0 were already present.')
    const again = run()
    expect(again.stdout.trim()).toBe('0 entries landed; 1 was already present.')
    const raw = new BetterSqlite3(b, { readonly: true })
    const rows = raw.prepare('SELECT metadata_json, read_only FROM nodes').all() as Array<{ metadata_json: string; read_only: number }>
    raw.close()
    expect(rows).toHaveLength(1)
    const m = JSON.parse(rows[0]!.metadata_json) as Record<string, unknown>
    expect(m['_handoff_file']).toBe('handoffs/login-plan.json')
    expect(m['_handoff_importer']).toBe(`shell:${exporterName()}`)
    expect(m['_handoff_sender']).toBe(exporterName())
    expect(m['next_session']).toBeUndefined()
    expect(rows[0]!.read_only).toBe(1)
  })

  it('--whole warns and writes nothing without --yes; with it, every entry', async () => {
    const a = await storeA()
    const refused = spawnCli(['export', 'whole.json', '--whole', '--store', a, '--no-debug'], { home, cwd: repoA })
    expect(refused.status).toBe(1)
    expect(refused.stderr).toMatch(/Captured tool output can hold secrets, tokens and keys/)
    expect(existsSync(join(repoA, 'whole.json'))).toBe(false)
    const ok = spawnCli(['export', 'whole.json', '--whole', '--yes', '--store', a, '--no-debug'], { home, cwd: repoA })
    expect(ok.status, ok.out).toBe(0)
    expect(ok.stderr).toMatch(/Captured tool output can hold secrets, tokens and keys/)
    expect(JSON.parse(readFileSync(join(repoA, 'whole.json'), 'utf8')).nodes).toHaveLength(2)
  })

  it('a file outside the project names itself by its name, to be copied in first', async () => {
    const a = await storeA()
    const r = spawnCli(['export', join(dir, 'elsewhere', 'plan.json'), '--store', a, '--no-debug'], { home, cwd: repoA })
    expect(r.status, r.out).toBe(0)
    const head = JSON.parse(readFileSync(join(dir, 'elsewhere', 'plan.json'), 'utf8')) as { to_import: string }
    expect(head.to_import).toBe('Copy this file into the project first, then ask your agent to import "plan.json" '
      + '(treecontext_import with path "plan.json"), or run in this project\'s directory: treecontext import plan.json')
    expect(head.to_import).not.toContain(dir)
  })

  it('never overwrites a file that is not a handoff without --force', async () => {
    const a = await storeA()
    writeFileSync(join(repoA, 'package.json'), '{"name":"app"}\n')
    const r = spawnCli(['export', 'package.json', '--store', a, '--no-debug'], { home, cwd: repoA })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/is not a treecontext handoff file/)
    expect(readFileSync(join(repoA, 'package.json'), 'utf8')).toBe('{"name":"app"}\n')
  })

  it('importing a file that is not JSON echoes none of it', () => {
    writeFileSync(join(repoB, '.env'), 'API_KEY=sk-live-0123456789abcdef\n')
    const r = spawnCli(['import', '.env', '--store', join(dir, 'b.db'), '--no-debug'], { home, cwd: repoB })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/\.env is not a handoff file/)
    expect(r.out).not.toContain('sk-live')
  })

  it('a tree-era msgpack dump still meets its tombstone', () => {
    const r = spawnCli(['import', 'dump.msgpack', '--no-debug'], { home, cwd: repoA })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/removed with the tree era/)
  })
})
