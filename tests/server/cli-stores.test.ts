/**
 * S9: `stores rm` traversal guard.
 *
 * Verify that removeStore rejects paths that resolve outside
 * DEFAULT_STORES_DIR via directory traversal (e.g. `../../etc`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { removeStore, SWEEP_COMMAND, rmCommandFor } from '../../src/tools/stores.js'
import { isCliAddressableStoreName } from '../../src/tools/store-name.js'
import { writeVerdict } from '../../src/persistence/backup-verdict.js'
import { maxSupportedVersion } from '../../src/persistence/migrations/index.js'
import { parseArgs, refusesNewStoreName } from '../../src/server/cli.js'

const posixNonRoot = process.platform !== 'win32' && process.getuid?.() !== 0

let tmpDir: string
let fakeStoresDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'tc-stores-rm-'))
  fakeStoresDir = join(tmpDir, 'stores')
  mkdirSync(fakeStoresDir, { recursive: true })
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('S9: removeStore traversal guard', () => {
  it('allows removal of a store directory inside storesDir', () => {
    const storeDir = join(fakeStoresDir, 'legit-store')
    mkdirSync(storeDir)
    writeFileSync(join(storeDir, 'treecontext.db'), '')

    expect(() => removeStore(storeDir, fakeStoresDir)).not.toThrow()
  })

  it('rejects traversal path like ../../etc', () => {
    // Create a sibling directory that a traversal would reach
    const outsideDir = join(tmpDir, 'outside-target')
    mkdirSync(outsideDir)
    writeFileSync(join(outsideDir, 'important.txt'), 'do not delete')

    const traversalPath = join(fakeStoresDir, '..', 'outside-target')
    expect(() => removeStore(traversalPath, fakeStoresDir)).toThrow(
      /refusing to delete path outside stores directory/i,
    )
  })

  it('rejects absolute path outside stores directory', () => {
    const outsideDir = join(tmpDir, 'elsewhere')
    mkdirSync(outsideDir)

    expect(() => removeStore(outsideDir, fakeStoresDir)).toThrow(
      /refusing to delete path outside stores directory/i,
    )
  })

  it('rejects non-existent path', () => {
    expect(() => removeStore(join(fakeStoresDir, 'does-not-exist'), fakeStoresDir)).toThrow(
      /does not exist/i,
    )
  })
})

describe('stores rm target validation (review finding #8)', () => {
  /** parseArgs error()s via console.error + process.exit(1); capture both. */
  function parseExpectingError(argv: string[]): string {
    const errs: string[] = []
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.join(' ')) })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit:${code}`)
    }) as never)
    try {
      parseArgs(argv)
      throw new Error('expected parseArgs to refuse')
    } catch (err) {
      expect((err as Error).message).toBe('__exit:1')
      return errs.join('\n')
    } finally {
      errSpy.mockRestore()
      exitSpy.mockRestore()
    }
  }

  it('accepts a plain store name', () => {
    // parseArgs takes full process.argv (skips node + script path).
    const args = parseArgs(['node', 'cli', 'stores', 'rm', 'my-store.v2'])
    expect(args.storesAction).toBe('rm')
    expect(args.storesTarget).toBe('my-store.v2')
  })

  it.each([
    ['a separator name', '../evil'],
    ['an absolute path', '/etc'],
    ['dot', '.'],
    ['dot-dot', '..'],
  ])('refuses %s before any filesystem is touched', (_label, target) => {
    // Before this guard, `stores rm ..` enumerated ~/.treecontext itself
    // and the shell branch described backups outside the stores root (S9
    // blocked the deletion, but rm must not describe what it will never
    // remove).
    expect(parseExpectingError(['node', 'cli', 'stores', 'rm', target])).toMatch(/store name must match/)
  })

  it.each([
    ['-legacy', false],
    ['notes copy', false],
    ['café', false],
    ['.', false],
    ['..', false],
    ['my-store.v2', true],
    ['lectures', true],
  ])('the parser agrees with isCliAddressableStoreName on %s (addressable=%s)', (name, addressable) => {
    // Doctor advises rmCommandFor(name) exactly when this predicate says
    // yes — so predicate and parse guard must never disagree, or doctor
    // prints a command the parser refuses ('-legacy' did exactly that).
    expect(isCliAddressableStoreName(name)).toBe(addressable)
    if (addressable) {
      const args = parseArgs(['node', 'cli', 'stores', 'rm', name])
      expect(args.storesTarget).toBe(name)
    } else {
      expect(parseExpectingError(['node', 'cli', 'stores', 'rm', name]))
        .toMatch(/store name/)
    }
  })

  it('refuses an unexpected bare positional instead of silently dropping it', () => {
    // The wrong-store chain: a store directory named 'notes copy' makes
    // doctor's advice shell-split into target 'notes' + stray 'copy';
    // pre-guard, parseArgs dropped 'copy' silently and --yes then deleted
    // the sibling store 'notes'.
    expect(parseExpectingError(['node', 'cli', 'stores', 'rm', 'notes', 'copy', '--yes']))
      .toMatch(/Unexpected argument: copy/)
    expect(parseExpectingError(['node', 'cli', 'serve', 'bogus'])).toMatch(/Unexpected argument: bogus/)
  })
})

describe('tombstone commands keep their historical argument shapes (finding 5)', () => {
  it.each([
    [['import', 'dump.msgpack'], 'import'],
    [['viz', 'my-store'], 'viz'],
    [['embed', 'notes.txt'], 'embed'],
    [['daemon', 'restart'], 'daemon'],
  ])('%j reaches its curated tombstone, not the positional guard', (argv, command) => {
    // The tombstones exist for stale invocations, which arrive in their
    // historical argument-taking form — 'Unexpected argument' would hide
    // the recovery pointer from exactly that audience.
    expect(parseArgs(['node', 'cli', ...argv as string[]]).command).toBe(command)
  })
})

describe.skipIf(!posixNonRoot)('removeStore fault isolation (finding 4)', () => {
  it('collects per-item failures instead of losing the report to a throw', () => {
    const storeDir = join(fakeStoresDir, 'stuck')
    mkdirSync(storeDir)
    writeFileSync(join(storeDir, 'treecontext.db'), '')
    writeFileSync(join(storeDir, 'junk.txt'), 'x')
    const bak = join(storeDir, 'treecontext.db.pre-migration-v12.bak')
    writeFileSync(bak, 'x')
    writeVerdict(bak, {
      version: 1, verdict: 'failed', backupEntries: 36, migratedEntries: 35,
      from: 12, to: maxSupportedVersion, recordedAt: 0,
    })
    chmodSync(storeDir, 0o555)
    try {
      // Spared backup present → the per-item spare-rule loop runs; every
      // non-keep deletion fails on the read-only directory.
      const result = removeStore(storeDir, fakeStoresDir)
      expect(result.spared).toHaveLength(1)
      expect(result.took).toHaveLength(0)
      expect(result.failed.length).toBeGreaterThanOrEqual(2)
      expect(result.failed.some((f) => f.name === 'treecontext.db')).toBe(true)
      expect(result.failed.some((f) => f.name === 'junk.txt')).toBe(true)
      expect(result.failed.every((f) => /EACCES|permission/i.test(f.error))).toBe(true)
    } finally {
      chmodSync(storeDir, 0o755)
    }
  })
})

describe('refuse-at-creation for --store (ruling 2026-08-11)', () => {
  it.each([
    // [storeName, storeDirExists, refused]
    ['my café', false, true],       // would create an unaddressable store
    ['notes copy', false, true],
    ['-legacy', false, true],
    ['my café', true, false],       // EXISTING store always opens — no lockout
    ['-legacy', true, false],
    ['good-name.v2', false, false], // addressable creation proceeds
    ['./relative/path', false, false], // paths pass through by design
    ['/abs/path', false, false],
  ])('refusesNewStoreName(%j, exists=%s) === %s', (name, exists, refused) => {
    expect(refusesNewStoreName(name as string, exists as boolean)).toBe(refused)
  })
})

describe('doctor sweep advice stays runnable (review finding #10)', () => {
  it('SWEEP_COMMAND parses through the real CLI parser to the sweep action', () => {
    // Doctor prints SWEEP_COMMAND verbatim; if the subcommand tokens ever
    // rename, this parse-through goes red instead of doctor advising a
    // command that no longer exists.
    const [bin, ...rest] = SWEEP_COMMAND.split(' ')
    expect(bin).toBe('treecontext')
    const args = parseArgs(['node', 'cli', ...rest])
    expect(args.command).toBe('stores')
    expect(args.storesAction).toBe('sweep')
  })

  it('rmCommandFor parses through the real CLI parser to the rm action (R7)', () => {
    // Doctor's orphan advice and the sweep's refusal reason both build
    // from STORES_RM; this parse-through tethers them the same way.
    const [bin, ...rest] = rmCommandFor('my-store').split(' ')
    expect(bin).toBe('treecontext')
    const args = parseArgs(['node', 'cli', ...rest])
    expect(args.command).toBe('stores')
    expect(args.storesAction).toBe('rm')
    expect(args.storesTarget).toBe('my-store')
    expect(args.yes).toBe(true)
  })
})
