import { describe, it, expect } from 'vitest'
import { enforceCharCap, stripAnsi, normalizeSource, type SessionSource } from '../../src/hooks/shared.js'

describe('stripAnsi', () => {
  it('removes ANSI color codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red')
  })

  it('removes multiple codes', () => {
    expect(stripAnsi('\x1b[1;32mbold green\x1b[0m normal \x1b[34mblue\x1b[0m')).toBe('bold green normal blue')
  })

  it('passes through clean text unchanged', () => {
    expect(stripAnsi('no codes here')).toBe('no codes here')
  })

  it('handles empty string', () => {
    expect(stripAnsi('')).toBe('')
  })
})

describe('enforceCharCap', () => {
  it('passes through text under budget', () => {
    const text = 'Short text.'
    expect(enforceCharCap(text, 1000)).toBe(text)
  })

  it('truncates at sentence boundary when possible', () => {
    const text = 'First sentence. Second sentence. Third sentence that is very long and pushes way over the budget limit we set.'
    const result = enforceCharCap(text, 90)
    expect(result).toContain('First sentence.')
    expect(result).toContain('... (more available via treecontext_query)')
    expect(result).not.toContain('Third sentence')
  })

  it('appends truncation sentinel', () => {
    const text = 'A'.repeat(200)
    const result = enforceCharCap(text, 100)
    expect(result).toContain('... (more available via treecontext_query)')
  })

  it('strips ANSI before measuring', () => {
    const text = '\x1b[31m' + 'A'.repeat(50) + '\x1b[0m'
    const result = enforceCharCap(text, 100)
    expect(result).not.toContain('\x1b')
    expect(result).toBe('A'.repeat(50))
  })

  it('respects hard cap of 10000 even if higher budget passed', () => {
    const text = 'A'.repeat(15000)
    const result = enforceCharCap(text, 20000)
    expect(result.length).toBeLessThanOrEqual(10000 + 50)
  })

  it('handles text exactly at budget', () => {
    const text = 'A'.repeat(100)
    expect(enforceCharCap(text, 100)).toBe(text)
  })

  it('handles empty string', () => {
    expect(enforceCharCap('', 100)).toBe('')
  })
})

describe('normalizeSource', () => {
  it('recognizes valid sources', () => {
    const valid: SessionSource[] = ['startup', 'clear', 'compact', 'resume']
    for (const s of valid) {
      expect(normalizeSource(s)).toBe(s)
    }
  })

  it('normalizes case', () => {
    expect(normalizeSource('STARTUP')).toBe('startup')
    expect(normalizeSource('Clear')).toBe('clear')
  })

  it('returns unknown for unrecognized strings', () => {
    expect(normalizeSource('other')).toBe('unknown')
    expect(normalizeSource('new')).toBe('unknown')
  })

  it('returns unknown for non-strings', () => {
    expect(normalizeSource(undefined)).toBe('unknown')
    expect(normalizeSource(null)).toBe('unknown')
    expect(normalizeSource(42)).toBe('unknown')
  })
})

// ── The one opener, read-only variant (release-diff review 2026-08-15) ─
// stop.ts kept a raw 2s readonly open and its stale-recapture guard
// silently disarmed on busy stores; every hook open — reads included —
// now routes through openHookDb's shared budget.
import { mkdtempSync as mkdtemp2, rmSync as rm2 } from 'node:fs'
import { join as join2 } from 'node:path'
import { tmpdir as tmpdir2 } from 'node:os'
import BetterSqlite3 from 'better-sqlite3'
import { openHookDb, writeStaging } from '../../src/hooks/shared.js'
import { existsSync } from 'node:fs'

describe('openHookDb readonly', () => {
  it('opens for reading and refuses writes', () => {
    const dir = mkdtemp2(join2(tmpdir2(), 'tc-hookdb-ro-'))
    const path = join2(dir, 'store.db')
    try {
      const seed = new BetterSqlite3(path)
      seed.exec('CREATE TABLE t (v TEXT)')
      seed.prepare('INSERT INTO t (v) VALUES (?)').run('row')
      seed.close()

      const ro = openHookDb(path, { readonly: true })
      try {
        const row = ro.prepare('SELECT v FROM t').get() as { v: string }
        expect(row.v).toBe('row')
        expect(() => ro.prepare("INSERT INTO t (v) VALUES ('nope')").run()).toThrow()
      } finally {
        ro.close()
      }
    } finally {
      rm2(dir, { recursive: true, force: true })
    }
  })
})

// ── The one opener, fresh-store variant (issue #2, 2026-09-02) ───────
// A hook that fires before any server has run must not lose its event.
// The opener applies the ONE definition of fresh and the full ladder —
// and touches nothing that already has a version or data.
import { HOOK_DB_TIMEOUT_MS as HOOK_BUDGET, HOOK_BOOTSTRAP_TIMEOUT_MS } from '../../src/hooks/shared.js'
import { statSync, writeFileSync as writeFile3 } from 'node:fs'
import { maxSupportedVersion } from '../../src/persistence/migrations/index.js'
import { ensureBaseSchema } from '../../src/persistence/migrations.js'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'

describe('openHookDb bootstraps a fresh store', () => {
  const inTemp = (fn: (path: string) => void): void => {
    const dir = mkdtemp2(join2(tmpdir2(), 'tc-hookdb-fresh-'))
    try {
      fn(join2(dir, 'treecontext.db'))
    } finally {
      rm2(dir, { recursive: true, force: true })
    }
  }
  const versionOf = (path: string): number => {
    const raw = new BetterSqlite3(path, { readonly: true })
    try {
      return raw.pragma('user_version', { simple: true }) as number
    } finally {
      raw.close()
    }
  }
  const hasStaging = (path: string): boolean => {
    const raw = new BetterSqlite3(path, { readonly: true })
    try {
      return (raw.prepare("SELECT count(*) AS c FROM sqlite_master WHERE name = 'staging'").get() as { c: number }).c === 1
    } finally {
      raw.close()
    }
  }

  // The wrapper's constructor sets mmap_size (256MB); a raw open leaves it
  // at SQLite's default 0 — the one pragma that tells the two apart.
  const mmapOf = (db: ReturnType<typeof openHookDb>): number => db.pragma('mmap_size', { simple: true }) as number

  it('a path with no file behind it gets the full schema, at the ladder head', () => {
    inTemp((path) => {
      const db = openHookDb(path)
      db.close()
      expect(versionOf(path)).toBe(maxSupportedVersion)
      expect(hasStaging(path)).toBe(true)
      // The base schema went in FIRST (the one definition of fresh), so
      // the ladder's backup is of a version-5 store — never the
      // pre-migration-v0.bak of an empty file that no verdict could be
      // recorded against and doctor warned about forever.
      expect(existsSync(`${path}.pre-migration-v5.bak`)).toBe(true)
      expect(existsSync(`${path}.pre-migration-v0.bak`)).toBe(false)
    })
  })

  it('a path whose directory does not exist yet gets the directory, private, and a private file', () => {
    // Release review finding 1: the schema alone is not a store. Nothing
    // but the opener stands in front of PostToolUse, Stop, PreCompact and
    // every non-Claude adapter.
    inTemp((path) => {
      const deep = join2(path, '..', 'stores', 'fresh-store', 'treecontext.db')
      // A permissive umask for the duration, or the 0600 assertion is
      // vacuous on a machine whose umask already makes every file private.
      const prevUmask = process.platform === 'win32' ? null : process.umask(0o022)
      try {
        const db = openHookDb(deep)
        db.close()
      } finally {
        if (prevUmask !== null) process.umask(prevUmask)
      }
      expect(versionOf(deep)).toBe(maxSupportedVersion)
      if (process.platform !== 'win32') {
        expect(statSync(join2(deep, '..')).mode & 0o777).toBe(0o700)
        expect(statSync(deep).mode & 0o777).toBe(0o600) // S11 on create, finding 4
      }
    })
  })

  it('the loud line: a staging write that cannot land names the data loss', () => {
    inTemp((path) => {
      const seen: string[] = []
      const orig = console.error
      console.error = (...args: unknown[]) => { seen.push(args.map(String).join(' ')) }
      try {
        // A "directory" that is a regular file: the opener can neither
        // make the directory nor open the database — the one error class
        // that means capture is losing data.
        writeFile3(path, 'not a directory')
        writeStaging(join2(path, 'treecontext.db'), {
          role: 'user', content: 'lost words', timestamp: Date.now(),
        })
      } finally {
        console.error = orig
      }
      expect(seen.join('\n')).toMatch(/capture is losing data/i)
    })
  })

  it('a versioned store with an empty journal but STAGED rows is the server\'s, not a hook\'s (finding 5)', () => {
    inTemp((path) => {
      const seed = new BetterSqlite3(path)
      expect(ensureBaseSchema(wrapBetterSqlite(seed))).toBe(true)
      seed.prepare("INSERT INTO staging (role, content, timestamp) VALUES ('user', 'captured, never drained', 1)").run()
      seed.close()
      const db = openHookDb(path)
      try {
        expect(mmapOf(db)).toBe(0)
      } finally {
        db.close()
      }
      expect(versionOf(path)).toBe(5)
      expect(existsSync(`${path}.pre-migration-v5.bak`)).toBe(false)
    })
  })

  it('the bootstrap waits at most its own share, and the write inherits the remainder (finding 2)', () => {
    inTemp((path) => {
      const seed = new BetterSqlite3(path)
      expect(ensureBaseSchema(wrapBetterSqlite(seed))).toBe(true)
      seed.close()
      // Another starter holds the store mid-ladder.
      const holder = new BetterSqlite3(path)
      holder.exec('BEGIN EXCLUSIVE')
      const t0 = Date.now()
      let db: ReturnType<typeof openHookDb> | undefined
      try {
        db = openHookDb(path)
        const waited = Date.now() - t0
        expect(waited).toBeGreaterThanOrEqual(HOOK_BOOTSTRAP_TIMEOUT_MS - 50)
        expect(waited).toBeLessThan(HOOK_BOOTSTRAP_TIMEOUT_MS + 2000)
        const left = db.pragma('busy_timeout', { simple: true }) as number
        expect(left).toBeLessThanOrEqual(HOOK_BUDGET - HOOK_BOOTSTRAP_TIMEOUT_MS + 50)
        expect(left).toBeGreaterThan(HOOK_BUDGET - HOOK_BOOTSTRAP_TIMEOUT_MS - 2000)
        expect(db.inTransaction).toBe(false)
      } finally {
        db?.close()
        holder.exec('ROLLBACK')
        holder.close()
      }
      expect(versionOf(path)).toBe(5) // untouched: the holder never let go
    })
  })

  it('a schema-less shell file (rc.6\'s leftover) is healed the same way', () => {
    inTemp((path) => {
      const shell = new BetterSqlite3(path)
      shell.pragma('journal_mode = WAL')
      shell.close()
      const db = openHookDb(path)
      db.close()
      expect(versionOf(path)).toBe(maxSupportedVersion)
      expect(hasStaging(path)).toBe(true)
    })
  })

  it('a v0-era store WITH data is left for the server, untouched', () => {
    inTemp((path) => {
      const seed = new BetterSqlite3(path)
      seed.exec('CREATE TABLE nodes (id TEXT PRIMARY KEY)')
      seed.prepare('INSERT INTO nodes (id) VALUES (?)').run('legacy-row')
      seed.close()
      const db = openHookDb(path)
      db.close()
      expect(versionOf(path)).toBe(0)
      expect(hasStaging(path)).toBe(false)
      // And the ladder never started: its first act on a destructive
      // pending set is the VACUUM INTO backup, so a pre-migration-v0.bak
      // beside the store would mean a hook ran the ladder on a store with
      // data — the file doctor warned about forever, minted by a hook.
      expect(existsSync(`${path}.pre-migration-v0.bak`)).toBe(false)
    })
  })

  it('a versioned store behind the ladder WITH journal rows is never migrated by a hook', () => {
    inTemp((path) => {
      const seed = new BetterSqlite3(path)
      seed.exec('CREATE TABLE nodes (node_id TEXT PRIMARY KEY)')
      seed.exec('CREATE TABLE staging (id INTEGER PRIMARY KEY, content TEXT)')
      seed.prepare('INSERT INTO nodes (node_id) VALUES (?)').run('a-real-row')
      seed.pragma('user_version = 16')
      seed.close()
      const db = openHookDb(path)
      try {
        // Never wrapped: the library's pragma set (mmap_size among them)
        // is a bootstrap side effect, and a store that is not ours to
        // bootstrap must not pay it — the raw open's default stays.
        expect(mmapOf(db)).toBe(0)
      } finally {
        db.close()
      }
      expect(versionOf(path)).toBe(16)
    })
  })

  it('a versioned file with no journal table at all is left alone', () => {
    inTemp((path) => {
      const seed = new BetterSqlite3(path)
      seed.exec('CREATE TABLE something_else (v TEXT)')
      seed.pragma('user_version = 3')
      seed.close()
      const db = openHookDb(path)
      try {
        expect(mmapOf(db)).toBe(0)
      } finally {
        db.close()
      }
      expect(versionOf(path)).toBe(3)
      // The ladder never started on it: its first act on a destructive
      // pending set is the backup copy, which would sit beside the file.
      expect(existsSync(`${path}.pre-migration-v3.bak`)).toBe(false)
    })
  })

  it('a versioned store behind the ladder with an EMPTY journal is brought to the head (the race window)', () => {
    // The shape a second starter sees between the winner's base-schema
    // commit and its first exclusive batch: a genuine version-5 store,
    // no rows anywhere. Left alone, the write would land through the
    // legacy column tier with its stamps and tail dropped.
    inTemp((path) => {
      const seed = new BetterSqlite3(path)
      expect(ensureBaseSchema(wrapBetterSqlite(seed))).toBe(true)
      expect(seed.pragma('user_version', { simple: true })).toBe(5)
      seed.close()
      const db = openHookDb(path)
      db.close()
      expect(versionOf(path)).toBe(maxSupportedVersion)
      expect(hasStaging(path)).toBe(true)
    })
  })

  it('a store already at the head is not touched at all', () => {
    inTemp((path) => {
      const first = openHookDb(path)
      first.close()
      const stat = (): number => {
        const raw = new BetterSqlite3(path, { readonly: true })
        try {
          return (raw.prepare('SELECT count(*) AS c FROM sqlite_master').get() as { c: number }).c
        } finally {
          raw.close()
        }
      }
      const before = stat()
      const again = openHookDb(path)
      try {
        expect(mmapOf(again)).toBe(0) // the common case pays one pragma read, not the wrapper
      } finally {
        again.close()
      }
      expect(versionOf(path)).toBe(maxSupportedVersion)
      expect(stat()).toBe(before)
    })
  })

  it('after bootstrapping, the connection looks exactly like one that never did (findings 2 and 7)', () => {
    inTemp((path) => {
      const db = openHookDb(path)
      try {
        // The write's budget is what the bootstrap left of the hook's —
        // never the wrapper's 10s, never a fresh 8s on top.
        const left = db.pragma('busy_timeout', { simple: true }) as number
        expect(left).toBeLessThanOrEqual(HOOK_BUDGET)
        expect(left).toBeGreaterThan(HOOK_BUDGET - HOOK_BOOTSTRAP_TIMEOUT_MS)
        // And the wrapper's pragma set is gone: FULL sync, no mmap, no
        // memory temp store — a hook's durability does not depend on
        // whether it happened to bootstrap.
        expect(db.pragma('synchronous', { simple: true })).toBe(2)
        expect(mmapOf(db)).toBe(0)
        expect(db.pragma('temp_store', { simple: true })).toBe(0)
        expect(db.inTransaction).toBe(false)
      } finally {
        db.close()
      }
    })
  })

  it('a read-only open never bootstraps', () => {
    inTemp((path) => {
      const seed = new BetterSqlite3(path)
      seed.pragma('journal_mode = WAL')
      seed.close()
      const ro = openHookDb(path, { readonly: true })
      try {
        expect(mmapOf(ro)).toBe(0) // never even wrapped
      } finally {
        ro.close()
      }
      expect(versionOf(path)).toBe(0)
      expect(hasStaging(path)).toBe(false)
    })
  })
})

// ── The cross-file timeout invariant, enforced instead of prosed ─────
// HOOK_DB_TIMEOUT_MS's own doc comment says it "must stay strictly
// below the smallest platform hook kill budget — VS Code registers
// every hook with timeoutSec: 10". Two files, one invariant, and until
// 2026-08-15 nothing failed if either side moved (flagged by the F
// scout and again by the release-diff review). This reads the budget
// from the GENERATED config, not a copied literal.
import { writeFileSync as wf, readFileSync as rf } from 'node:fs'
import { HOOK_DB_TIMEOUT_MS, STOP_GUARD_TIMEOUT_MS } from '../../src/hooks/shared.js'

describe('hook db timeout vs platform kill budgets', () => {
  it('the Stop hook\'s STACKED budgets (guard + write) also fit, with headroom', async () => {
    // The Stop hook opens twice; its budgets sum. Pinning only the
    // single-open budget let the sum reach 16s against the 10s kill
    // (pass-2 review 2026-08-15).
    const { upsertVscodeHooks } = await import('../../src/server/installer.js')
    const dir = mkdtemp2(join2(tmpdir2(), 'tc-timeout-sum-'))
    const settings = join2(dir, 'hooks.json')
    try {
      wf(settings, '{}')
      upsertVscodeHooks(settings, true, false)
      const cfg = JSON.parse(rf(settings, 'utf8')) as { hooks: Record<string, Array<{ timeoutSec?: number }>> }
      const minBudgetMs = Math.min(...Object.values(cfg.hooks).flat().map((e) => e.timeoutSec! * 1000))
      expect(STOP_GUARD_TIMEOUT_MS + HOOK_DB_TIMEOUT_MS).toBeLessThanOrEqual(minBudgetMs - 1000)
      // The fresh-store bootstrap (2026-09-02) is a third phase on the
      // write connection; it is a SHARE of HOOK_DB_TIMEOUT_MS, not a
      // fourth term — pinned here so a future budget cannot stack it.
      expect(HOOK_BOOTSTRAP_TIMEOUT_MS).toBeLessThan(HOOK_DB_TIMEOUT_MS)
    } finally {
      rm2(dir, { recursive: true, force: true })
    }
  })

  it('stays strictly below every registered timeoutSec, with headroom', async () => {
    const { upsertVscodeHooks } = await import('../../src/server/installer.js')
    const dir = mkdtemp2(join2(tmpdir2(), 'tc-timeout-invariant-'))
    const settings = join2(dir, 'hooks.json')
    try {
      wf(settings, '{}')
      upsertVscodeHooks(settings, true, false)
      const cfg = JSON.parse(rf(settings, 'utf8')) as {
        hooks: Record<string, Array<{ timeoutSec?: number }>>
      }
      const budgets = Object.values(cfg.hooks).flat().map((e) => e.timeoutSec)
      expect(budgets.length).toBeGreaterThan(0)
      for (const sec of budgets) {
        expect(typeof sec).toBe('number')
        // Strictly below, with at least a second to fail gracefully:
        // a hook killed mid-busy-wait loses its diagnostic and its close.
        expect(HOOK_DB_TIMEOUT_MS).toBeLessThanOrEqual(sec! * 1000 - 1000)
      }
    } finally {
      rm2(dir, { recursive: true, force: true })
    }
  })
})

// ── stdio storm-proofing at the hook bootstrap (rc.6 review) ────────

describe('hook stdio storm-proofing', () => {
  it('is armed by importing the shared bootstrap, before any hook writes', async () => {
    // Since the agent wrappers landed (7e3f899) a hook fire execs
    // dist/hooks/<agent>/<stem>.js DIRECTLY — the CLI main() that armed
    // the guard never runs — in exactly the Electron-family hosts
    // observed abandoning a spawned child's stderr. Without a listener
    // the first diagnostic write raises EPIPE, becomes an
    // uncaughtException, and kills the hook mid-capture behind a
    // wrapper that still reports exit 0. Every entry point reaches its
    // main() through shared.ts, so the guard is armed by importing it.
    const entry = await import('../../src/hooks/vscode/session-start.js')
    expect(typeof entry.main).toBe('function')
    expect(process.stdout.listenerCount('error')).toBeGreaterThan(0)
    expect(process.stderr.listenerCount('error')).toBeGreaterThan(0)
    // What the guard buys: a dead peer's write error is inert rather
    // than an exception nobody is left to handle.
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    expect(() => process.stderr.emit('error', epipe)).not.toThrow()
    expect(() => process.stdout.emit('error', epipe)).not.toThrow()
  })
})
