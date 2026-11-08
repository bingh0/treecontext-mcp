import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { afterEach, describe, expect, test } from 'vitest'
import { removeIfHolding, writeAtomic } from '../../src/server/install-state.js'

// The install record's two corners (D361, D390): a crash's leftover
// temporary file, and a stale lock two waiters both judge stale.

const dirs: string[] = []
const dir = (): string => { const d = mkdtempSync(join(tmpdir(), 'tc-install-state-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('the record\'s temporary files', () => {
  test('a write removes the leftovers of a process that is gone, and keeps a live one\'s', () => {
    const d = dir()
    const file = join(d, 'install-state.json')
    const dead = spawnSync(process.execPath, ['-e', '0']).pid!
    writeFileSync(`${file}.tmp.${dead}`, 'half')
    writeFileSync(`${file}.tmp.${process.ppid}`, 'alive')
    writeFileSync(join(d, 'other.json.tmp.' + dead), 'not ours')
    writeAtomic(file, '{}\n', 0o600)
    expect(readdirSync(d).sort()).toEqual(['install-state.json', `install-state.json.tmp.${process.ppid}`, `other.json.tmp.${dead}`].sort())
  })
})

describe('taking over a stale lock', () => {
  test('only the lock that was judged stale is removed, never a fresh one in its place', () => {
    const d = dir()
    const lock = join(d, 'install-state.json.lock')
    writeFileSync(lock, '111 aaaa\n')
    // A second waiter took the stale lock over and holds its own now.
    writeFileSync(lock, '222 bbbb\n')
    expect(removeIfHolding(lock, '111 aaaa\n')).toBe(false)
    expect(readFileSync(lock, 'utf8')).toBe('222 bbbb\n')
    expect(removeIfHolding(lock, '222 bbbb\n')).toBe(true)
    expect(existsSync(lock)).toBe(false)
  })

  test('many processes over one planted stale lock lose no update', async () => {
    const d = dir()
    mkdirSync(join(d, '.treecontext'))
    writeFileSync(join(d, '.treecontext', 'install-state.json.lock'), `${spawnSync(process.execPath, ['-e', '0']).pid} dead\n`)
    const mod = new URL('../../src/server/install-state.ts', import.meta.url).href
    const code = `import { updateInstallState } from ${JSON.stringify(mod)}
for (let i = 0; i < 5; i++) updateInstallState(s => { const w = (s.toolApprovals ??= {}).written ??= {}; const c = (w.n ??= { f: { items: [], at: '' } }); c.f.items.push('x') })`
    const run = (): Promise<number | null> => new Promise((res) => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, HOME: d, USERPROFILE: d }, stdio: 'ignore' })
      c.on('close', res)
    })
    const codes = await Promise.all(Array.from({ length: 6 }, run))
    expect(codes).toEqual([0, 0, 0, 0, 0, 0])
    const rec = JSON.parse(readFileSync(join(d, '.treecontext', 'install-state.json'), 'utf8')) as { toolApprovals: { written: { n: { f: { items: string[] } } } } }
    expect(rec.toolApprovals.written.n.f.items).toHaveLength(30)
  }, 60_000)
})
