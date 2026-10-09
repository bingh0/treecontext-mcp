/**
 * store-bindings.feature bindings — gherkin-node-test executor.
 * (Executor-migration Phase 2, 2026-08-26: translated from the
 * vitest-cucumber binding; every assertion preserved verbatim.)
 *
 * Preserve-never-clobber bindings contract (ruling 2026-08-15), identity
 * continuity (§3, §3.4), concurrency (§3.6), detection (§4), and
 * self-audit (§11a).
 *
 * TREECONTEXT_BINDINGS_FILE is the sanctioned sandbox seam — bindings.ts
 * reads it per call, so scenarios run in-worker: each scenario's opening
 * Given builds a fresh sandbox and scopes the seam with a defer-restore.
 * Project directories are temp dirs outside any git repo: identity
 * resolves through the path fallback and derived names take the
 * basename+hash shape, deterministic per directory. The backup scenario
 * and every doctor scenario spawn the real CLI (the refusal lives in
 * main()'s dispatch; doctor's report is the CLI's own rendering).
 *
 * The old binding's successionCollectors truncation machinery (Phase-1
 * review F10: --retry accumulated events across attempts) dissolves —
 * gnt worlds are per-scenario, so each scenario's event array is born
 * empty by construction.
 *
 * Merged sentences with diverging bodies stage their divergence in
 * world state: "a fresh store is derived" reads the expectations its
 * scenario's When staged (not-these-stores / exactly-this-store /
 * source / safe-shape); "the new binding records source
 * 'carried-forward'" reads the staged source inventory. "A repository
 * with no remote, bound by path to its own store" serves two scenarios
 * whose old bodies differed only by commitSomething (the worktree
 * scenario needs a commit) — the merged body commits in both, inert for
 * the gains-a-remote scenario. The four unit-pin blocks that shared the
 * old file (EACCES, repointBindings B3/B4/absent, identityEnv M7) are
 * feature-independent and moved to tests/server/bindings-internals.test.ts.
 *
 * The step-lint sanctions below travel from the old binding; their
 * prover pointers are rewritten descriptively (the old ones named line
 * numbers in the deleted file).
 */
import { fileURLToPath } from 'node:url'
import {
  mkdirSync, rmSync, readFileSync, writeFileSync, symlinkSync,
  existsSync, lstatSync, realpathSync, readdirSync, statSync, utimesSync,
} from 'node:fs'
import { join } from 'node:path'
import { execFile, execSync } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { expect } from 'vitest'
import type { Registry } from 'gherkin-node-test/vitest'

import BetterSqlite3 from 'better-sqlite3'

import { nodeTsArgs, sandboxedSpawnEnv, spawnCli } from '../helpers/cli-spawn.js'
import { freshHomeDir, seedAuditStore, storesDirIn, COLLIDING_A, COLLIDING_B } from '../helpers/store-fixtures.js'
import { SAFE_STORE_RE } from '../../src/tools/store-name.js'
import { SCHEMA_SQL } from '../../src/persistence/schema.js'
import { resolveStoreName, lookupStoreName } from '../../src/server/bindings.js'
import type { Bindings, SuccessionEvent } from '../../src/server/bindings.js'

const readBindings = (path: string): Bindings =>
  JSON.parse(readFileSync(path, 'utf8')) as Bindings

/** The concurrency scenario's real-process machinery: six drivers, one
 *  bindings file, a filesystem barrier so the overlap is genuine. The
 *  loader and the env come from cli-spawn (nodeTsArgs/sandboxedSpawnEnv),
 *  so this fleet cannot drift from every other child in the corpus. */
const RESOLVE_DRIVER = fileURLToPath(new URL('../helpers/resolve-driver.ts', import.meta.url))
const execFileAsync = promisify(execFile)

type Resolved = { storeName: string; source: string }
type Entry = Bindings['projects'][string]

interface World {
  defer: (fn: () => void | Promise<void>) => void
  dir?: string
  bindingsPath?: string
  corruptPath?: string
  proj?: string
  resolvedName?: string
  resolved?: Resolved
  events?: SuccessionEvent[]
  looked?: string | null
  before?: string
  neighborFp?: string
  target?: string
  projDirs?: string[]
  futureFile?: string
  pathBound?: string
  sub?: string
  subStore?: string
  subEntry?: Entry
  linkPath?: string
  pkgA?: string
  pkgB?: string
  storeA?: string
  storeB?: string
  beforeEntries?: Bindings['projects']
  victimStore?: string
  victimEntry?: Entry
  resolvedList?: Resolved[]
  projectStore?: string
  worktree?: string
  stores?: string[]
  linkA?: string
  linkB?: string
  status?: number | null
  stderr?: string
  out?: string
  indebtedOut?: string
  cleanOut?: string
  stamps?: string
  boundAt?: number
  indebted?: string
  clean?: string
  stalled?: string
  /** Staged by each succession When for the merged "a fresh store is
   *  derived" / carried-forward Thens. */
  expectFreshNot?: string[]
  expectFreshExact?: string
  expectFreshSource?: string
  expectFreshSafe?: boolean
  expectSources?: string[]
  carriedStore?: string
}

export const storeBindingsDefiner = (reg: Registry<World>): void => {
  function freshWorld(w: World): void {
    const dir = freshHomeDir(w, 'tc-bindings-')
    w.dir = dir
    w.bindingsPath = join(dir, 'bindings.json')
    w.corruptPath = `${w.bindingsPath}.corrupt`
    w.proj = join(dir, 'proj')
    mkdirSync(w.proj)
    const prevOverride = process.env['TREECONTEXT_BINDINGS_FILE']
    process.env['TREECONTEXT_BINDINGS_FILE'] = w.bindingsPath
    w.defer(() => {
      if (prevOverride === undefined) delete process.env['TREECONTEXT_BINDINGS_FILE']
      else process.env['TREECONTEXT_BINDINGS_FILE'] = prevOverride
    })
    w.events = []
  }

  const opts = (w: World): { onSuccession(i: SuccessionEvent): void } =>
    ({ onSuccession: (i) => { w.events!.push(i) } })

  // ── Continuity helpers (docs/project-identity.md §3, §3.4) ────────
  // Real repositories in temp dirs: the succession probe reads the real
  // remote URL and the real primary root, so a stub would pin nothing.

  const git = (cwd: string, cmd: string): void => {
    // Isolated from the developer's real git config (Phase-1 review
    // F9): a global commit.gpgsign would sign throwaway fixtures with
    // the developer's key — and fail where the key is locked — while a
    // global remote URL would flip 'path' fixtures to 'git' source.
    execSync(`git ${cmd}`, {
      cwd, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    })
  }

  const initRepo = (path: string): string => {
    mkdirSync(path, { recursive: true })
    git(path, 'init -q')
    // A commit needs an identity, and `worktree add` needs a commit.
    git(path, 'config user.email tc@example.invalid')
    git(path, 'config user.name treecontext-test')
    return realpathSync.native(path)
  }

  const commitSomething = (path: string): void => {
    writeFileSync(join(path, 'file.txt'), 'x\n')
    git(path, 'add -A')
    git(path, 'commit -qm seed')
  }

  const bindingEntries = (w: World): Bindings['projects'] => readBindings(w.bindingsPath!).projects

  const entryNaming = (w: World, store: string): Entry | undefined =>
    Object.values(bindingEntries(w)).find((e) => e.store === store)

  /** Rename a bound store in place — the sanctioned way to give two real
   *  fingerprints two distinguishable stores without hand-computing a
   *  fingerprint the resolver would have to agree with. */
  const renameBoundStore = (w: World, from: string, to: string): void => {
    const b = readBindings(w.bindingsPath!)
    const fp = Object.entries(b.projects).find(([, e]) => e.store === from)![0]
    b.projects[fp]!.store = to
    writeFileSync(w.bindingsPath!, JSON.stringify(b, null, 2))
  }

  /** Seed a real binding for proj, then vandalize its store value and
   *  plant a valid neighbor. Returns the neighbor's fingerprint key. */
  const seedUnsafeBesideNeighbor = (w: World): string => {
    resolveStoreName(w.proj!)
    const seeded = readBindings(w.bindingsPath!)
    const fp = Object.keys(seeded.projects)[0]!
    seeded.projects[fp]!.store = '../evil'
    const neighborFp = 'feedfacecafef00d'
    seeded.projects[neighborFp] = { store: 'neighbor-store', updatedAt: 1, source: 'path' }
    writeFileSync(w.bindingsPath!, JSON.stringify(seeded, null, 2))
    return neighborFp
  }

  // ── Preserve, never clobber ────────────────────────────────────────

  reg.define(/^a bindings file holding unparseable bytes$/, (w) => {
    freshWorld(w)
    writeFileSync(w.bindingsPath!, '{ these bytes are not JSON')
  })

  reg.define(/^a project resolves its store name$/, (w) => {
    w.resolvedName = resolveStoreName(w.proj!).storeName
  })

  reg.define(/^the original bytes survive in a corrupt side-file$/, (w) => {
    expect(readFileSync(w.corruptPath!, 'utf8')).toBe('{ these bytes are not JSON')
  })

  // Merged: the corrupt-file and dead-lock scenarios pin the identical
  // observable.
  reg.define(/^the bindings file holds the fresh binding$/, (w) => {
    const entries = Object.values(readBindings(w.bindingsPath!).projects)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.store).toBe(w.resolvedName)
  })

  reg.define(/^a bindings file marked with a future version and holding another project's binding$/, (w) => {
    freshWorld(w)
    w.futureFile = JSON.stringify({
      version: 2,
      projects: { cafecafecafecafe: { store: 'someone-elses-store', updatedAt: 1, source: 'git' } },
    })
    writeFileSync(w.bindingsPath!, w.futureFile)
  })

  reg.define(/^the original file survives in the corrupt side-file with the other binding intact$/, (w) => {
    expect(readFileSync(w.corruptPath!, 'utf8')).toBe(w.futureFile)
    const sideFiled = readBindings(w.corruptPath!)
    expect(sideFiled.projects['cafecafecafecafe']!.store).toBe('someone-elses-store')
  })

  reg.define(/^a bindings path that is a symlink to a foreign file$/, (w) => {
    freshWorld(w)
    w.target = join(w.dir!, 'foreign.json')
    writeFileSync(w.target, '{"foreign":true}')
    symlinkSync(w.target, w.bindingsPath!)
  })

  reg.define(/^a safe store name is still derived$/, (w) => {
    expect(w.resolvedName).toMatch(SAFE_STORE_RE)
  })

  reg.define(/^the symlink and its target are untouched$/, (w) => {
    expect(lstatSync(w.bindingsPath!).isSymbolicLink()).toBe(true)
    expect(readFileSync(w.target!, 'utf8')).toBe('{"foreign":true}')
    expect(existsSync(w.corruptPath!)).toBe(false)
  })

  // ── Concurrency (§3.6) ─────────────────────────────────────────────

  reg.define(/^six unbound project directories$/, (w) => {
    freshWorld(w)
    w.projDirs = Array.from({ length: 6 }, (_, i) => {
      const p = join(w.dir!, `proj-${i}`)
      mkdirSync(p)
      return p
    })
  })

  reg.define(/^each resolves its store name in its own process at the same moment$/, async (w) => {
    // Real processes, real lock: each driver announces itself at the
    // barrier and none resolves until every one is alive, so the six
    // read-modify-write intervals genuinely overlap instead of racing
    // by spawn-order luck.
    const barrier = join(w.dir!, 'barrier')
    mkdirSync(barrier)
    // The shared spawn env, not a hand-rolled scrub: NODE_OPTIONS carries
    // vitest's worker loader flags the drivers must not boot, and the rest
    // of LEAK_KEYS is exactly the ambient state these drivers must not
    // resolve real-machine identity from. The bindings file is the one
    // deliberate re-add.
    const childEnv = sandboxedSpawnEnv(w.dir!, { TREECONTEXT_BINDINGS_FILE: w.bindingsPath! })
    const children = w.projDirs!.map((p) => execFileAsync(
      process.execPath, nodeTsArgs(RESOLVE_DRIVER, [p, barrier]),
      { env: childEnv, timeout: 60_000 },
    ))
    const deadline = Date.now() + 30_000
    while (readdirSync(barrier).filter((f) => f.startsWith('ready-')).length < w.projDirs!.length) {
      if (Date.now() > deadline) throw new Error('drivers never reached the barrier')
      await new Promise((r) => setTimeout(r, 10))
    }
    writeFileSync(join(barrier, 'go'), '')
    const results = await Promise.all(children)
    for (const r of results) {
      expect((JSON.parse(r.stdout) as { storeName: string }).storeName).toMatch(SAFE_STORE_RE)
    }
  })

  reg.define(/^the bindings file holds all six bindings$/, (w) => {
    expect(Object.keys(readBindings(w.bindingsPath!).projects)).toHaveLength(6)
  })

  reg.define(/^another writer holds the bindings lock$/, (w) => {
    freshWorld(w)
    // A FRESH lock file: below the stale bound, so the resolver waits
    // its bounded deadline and then defers — this scenario pays those
    // ~2 seconds on purpose.
    writeFileSync(`${w.bindingsPath!}.lock`, '424242')
  })

  reg.define(/^no binding is persisted while the lock is held$/, (w) => {
    expect(existsSync(w.bindingsPath!)).toBe(false)
  })

  reg.define(/^the resolution after the lock is released persists the binding$/, (w) => {
    rmSync(`${w.bindingsPath!}.lock`)
    // Derived names are deterministic per directory, so the deferred
    // and the persisted resolution agree without coordination.
    expect(resolveStoreName(w.proj!).storeName).toBe(w.resolvedName)
    const entries = Object.values(readBindings(w.bindingsPath!).projects)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.store).toBe(w.resolvedName)
  })

  reg.define(/^a bindings lock file left behind by a writer that died$/, (w) => {
    freshWorld(w)
    const lockPath = `${w.bindingsPath!}.lock`
    writeFileSync(lockPath, '424242')
    // utimesSync takes epoch SECONDS — ms would stamp the lock into
    // the far future and make it unbreakable forever.
    const past = (Date.now() - 60_000) / 1000
    utimesSync(lockPath, past, past)
  })

  reg.define(/^the stale lock file is gone$/, (w) => {
    expect(existsSync(`${w.bindingsPath!}.lock`)).toBe(false)
  })

  // ── Unsafe values ──────────────────────────────────────────────────

  reg.define(/^a bindings file where this project's entry names an unsafe store beside a valid neighbor$/, (w) => {
    freshWorld(w)
    w.neighborFp = seedUnsafeBesideNeighbor(w)
    w.before = readFileSync(w.bindingsPath!, 'utf8')
  })

  reg.define(/^the project resolves its store name$/, (w) => {
    w.resolvedName = resolveStoreName(w.proj!).storeName
  })

  reg.define(/^the resolved name is a freshly derived safe name$/, (w) => {
    expect(w.resolvedName).toMatch(SAFE_STORE_RE)
    expect(w.resolvedName).not.toBe('../evil')
  })

  reg.define(/^the neighbor's binding survives the rewrite$/, (w) => {
    const after = readBindings(w.bindingsPath!)
    expect(after.projects[w.neighborFp!]!.store).toBe('neighbor-store')
    expect(Object.values(after.projects).map((p) => p.store)).toContain(w.resolvedName)
  })

  reg.define(/^the binding is looked up read-only$/, (w) => {
    w.looked = lookupStoreName(w.proj!)
  })

  reg.define(/^no store name is reported$/, (w) => {
    expect(w.looked).toBeNull()
  })

  reg.define(/^the bindings file is unchanged$/, (w) => {
    expect(readFileSync(w.bindingsPath!, 'utf8')).toBe(w.before)
  })

  // ── Backup refusal / legacy sticky ─────────────────────────────────

  reg.define(/^a project directory with no binding$/, (w) => {
    freshWorld(w)
    expect(existsSync(w.bindingsPath!)).toBe(false)
  })

  reg.define(/^backup runs from that directory$/, (w) => {
    const r = spawnCli(['backup', join(w.dir!, 'out.db')], {
      home: w.dir!, cwd: w.proj!, env: { TREECONTEXT_BINDINGS_FILE: w.bindingsPath! },
    })
    w.status = r.status
    w.stderr = r.stderr
  })

  reg.define(/^it refuses with guidance naming a store flag$/, (w) => {
    expect(w.status, w.stderr).toBe(1)
    expect(w.stderr).toMatch(/--store/)
    expect(w.stderr).toMatch(/no store bound/)
  })

  reg.define(/^no binding was created$/, (w) => {
    expect(existsSync(w.bindingsPath!)).toBe(false)
    expect(existsSync(join(w.dir!, 'out.db'))).toBe(false)
  })

  reg.define(/^a repository with a legacy sticky file and no binding$/, (w) => {
    freshWorld(w)
    // The sticky reader anchors at the git repo root; a bare temp dir
    // has none, so the scenario needs a real (empty) repository.
    execSync('git init -q', { cwd: w.proj! })
    writeFileSync(join(w.proj!, '.treecontext-store'), 'legacy-notes\n')
  })

  reg.define(/^the sticky's store name is reported$/, (w) => {
    expect(w.looked).toBe('legacy-notes')
  })

  reg.define(/^no binding was created and the sticky survives$/, (w) => {
    expect(existsSync(w.bindingsPath!)).toBe(false)
    expect(readFileSync(join(w.proj!, '.treecontext-store'), 'utf8')).toBe('legacy-notes\n')
  })

  // ── Identity continuity (docs/project-identity.md §3, §3.4) ────────

  // Merged: serves the gains-a-remote and linked-worktree scenarios.
  // The commit is the worktree scenario's need (`worktree add` needs a
  // commit) and is inert for the other; the source pin was the
  // gains-a-remote scenario's and holds in both.
  reg.define(/^a repository with no remote, bound by path to its own store$/, (w) => {
    freshWorld(w)
    initRepo(w.proj!)
    commitSomething(w.proj!)
    w.pathBound = resolveStoreName(w.proj!).storeName
    w.projectStore = w.pathBound
    expect(entryNaming(w, w.pathBound)!.source).toBe('path')
  })

  reg.define(/^a remote is added and the project resolves its store name again$/, (w) => {
    git(w.proj!, 'remote add origin https://example.invalid/org/tc-demo.git')
    w.resolved = resolveStoreName(w.proj!, opts(w))
    w.expectSources = ['carried-forward', 'path']
  })

  reg.define(/^the resolved store is the one the path binding already named$/, (w) => {
    expect(w.resolved!.storeName).toBe(w.pathBound)
    // Without succession the git identity derives its slug instead.
    expect(w.resolved!.storeName).not.toBe('tc-demo')
  })

  // Merged: the gains-a-remote and ssh-https scenarios stage their own
  // source inventories; only the ssh-https one stages carriedStore.
  reg.define(/^the new binding records source "carried-forward"$/, (w) => {
    expect(w.resolved!.source).toBe('carried-forward')
    if (w.carriedStore) expect(entryNaming(w, w.carriedStore)).toBeDefined()
    const sources = Object.values(bindingEntries(w)).map((e) => e.source).sort()
    expect(sources).toEqual(w.expectSources)
  })

  reg.define(/^the path binding still names that store, untouched$/, (w) => {
    const stillPath = Object.values(bindingEntries(w)).filter((e) => e.source === 'path')
    expect(stillPath).toHaveLength(1)
    expect(stillPath[0]!.store).toBe(w.pathBound)
  })

  reg.define(/^the succession was announced to the caller$/, (w) => {
    expect(w.events).toEqual([
      { kind: 'adopted', store: w.pathBound, fromIdentitySource: 'path' },
    ])
  })

  reg.define(/^a subdirectory bound by path to its own store, with no repository above it$/, (w) => {
    freshWorld(w)
    w.sub = join(w.dir!, 'outer', 'inner')
    mkdirSync(w.sub, { recursive: true })
    w.subStore = resolveStoreName(w.sub).storeName
    w.subEntry = { ...entryNaming(w, w.subStore)! }
  })

  reg.define(/^a repository is initialized above it and the store is resolved from the subdirectory$/, (w) => {
    initRepo(join(w.dir!, 'outer'))
    w.resolved = resolveStoreName(w.sub!, opts(w))
    w.expectFreshNot = [w.subStore!]
    w.expectFreshSource = 'path'
    w.expectFreshSafe = true
  })

  // Merged over staged expectations: the three fresh-derivation
  // scenarios pin different stores-not-taken / exact slugs / sources.
  reg.define(/^a fresh store is derived$/, (w) => {
    if (w.expectFreshExact) expect(w.resolved!.storeName).toBe(w.expectFreshExact)
    for (const not of w.expectFreshNot ?? []) expect(w.resolved!.storeName).not.toBe(not)
    expect(w.resolved!.source).toBe(w.expectFreshSource)
    if (w.expectFreshSafe) expect(w.resolved!.storeName).toMatch(SAFE_STORE_RE)
  })

  reg.define(/^the predecessor journal at the subdirectory is disclosed with its store name$/, (w) => {
    expect(w.events).toEqual([
      { kind: 'predecessorDisclosed', dir: realpathSync.native(w.sub!), store: w.subStore },
    ])
  })

  reg.define(/^the subdirectory's binding is untouched$/, (w) => {
    expect(entryNaming(w, w.subStore!)).toEqual(w.subEntry)
  })

  reg.define(/^a repository bound under the https spelling of its remote$/, (w) => {
    freshWorld(w)
    initRepo(w.proj!)
    git(w.proj!, 'remote add origin https://host.invalid/org/repo.git')
    expect(resolveStoreName(w.proj!).storeName).toBe('repo')
    // Renamed so an adopted store is distinguishable from a re-derived
    // one: both spellings derive the same slug.
    renameBoundStore(w, 'repo', 'repo-early')
  })

  reg.define(/^the remote is respelled in scp-style ssh form and the store is resolved$/, (w) => {
    git(w.proj!, 'remote set-url origin git@host.invalid:org/repo')
    w.resolved = resolveStoreName(w.proj!, opts(w))
    w.expectSources = ['carried-forward', 'git']
    w.carriedStore = 'repo-early'
  })

  reg.define(/^the resolved store is the one the https spelling named$/, (w) => {
    expect(w.resolved!.storeName).toBe('repo-early')
    expect(w.events).toEqual([
      { kind: 'adopted', store: 'repo-early', fromIdentitySource: 'git' },
    ])
  })

  reg.define(/^a non-git project bound under a symlinked spelling of its path$/, (w) => {
    freshWorld(w)
    w.linkPath = join(w.dir!, 'proj-link')
    symlinkSync(w.proj!, w.linkPath)
    // The binding is written under the RAW symlinked spelling — the
    // artifact a degraded canonicalization ladder leaves behind, which
    // the healthy ladder never mints on its own (that is the defect).
    // The key mirrors the file's stored contract exactly:
    // sha256("path:" + spelling), first 16 hex.
    const fp = createHash('sha256').update(`path:${w.linkPath}`).digest('hex').slice(0, 16)
    writeFileSync(w.bindingsPath!, JSON.stringify({
      version: 1,
      projects: { [fp]: { store: 'spelled-store', updatedAt: 1755000000000, source: 'path' } },
    }, null, 2) + '\n')
  })

  reg.define(/^the project resolves through that symlinked spelling$/, (w) => {
    w.resolved = resolveStoreName(w.linkPath!, opts(w))
  })

  reg.define(/^the predecessor's store is adopted and recorded carried-forward$/, (w) => {
    expect(w.resolved!.storeName).toBe('spelled-store')
    expect(w.resolved!.source).toBe('carried-forward')
    const sources = Object.values(bindingEntries(w)).map((e) => e.source).sort()
    expect(sources).toEqual(['carried-forward', 'path'])
  })

  reg.define(/^the adoption is announced$/, (w) => {
    expect(w.events).toEqual([
      { kind: 'adopted', store: 'spelled-store', fromIdentitySource: 'path' },
    ])
  })

  reg.define(/^two package subdirectories each bound by path to their own stores$/, (w) => {
    freshWorld(w)
    w.pkgA = join(w.dir!, 'mono', 'packages', 'a')
    w.pkgB = join(w.dir!, 'mono', 'packages', 'b')
    mkdirSync(w.pkgA, { recursive: true })
    mkdirSync(w.pkgB, { recursive: true })
    w.storeA = resolveStoreName(w.pkgA).storeName
    w.storeB = resolveStoreName(w.pkgB).storeName
    expect(w.storeA).not.toBe(w.storeB)
    w.beforeEntries = bindingEntries(w)
  })

  reg.define(/^a repository is initialized at their common root and the store is resolved from the first package$/, (w) => {
    initRepo(join(w.dir!, 'mono'))
    w.resolved = resolveStoreName(w.pkgA!, opts(w))
    w.expectFreshNot = [w.storeA!, w.storeB!]
    w.expectFreshSource = 'path'
  })

  reg.define(/^the predecessor journal at the first package is disclosed, naming neither the other package nor its store$/, (w) => {
    expect(w.events).toEqual([
      { kind: 'predecessorDisclosed', dir: realpathSync.native(w.pkgA!), store: w.storeA },
    ])
    expect(JSON.stringify(w.events)).not.toContain(w.storeB!)
    expect(JSON.stringify(w.events)).not.toContain(realpathSync.native(w.pkgB!))
  })

  reg.define(/^neither package binding is modified$/, (w) => {
    const after = bindingEntries(w)
    for (const [fp, entry] of Object.entries(w.beforeEntries!)) expect(after[fp]).toEqual(entry)
  })

  reg.define(/^one remote whose https and scp spellings name two different stores$/, (w) => {
    freshWorld(w)
    initRepo(w.proj!)
    git(w.proj!, 'remote add origin https://host.invalid/org/repo.git')
    resolveStoreName(w.proj!)
    renameBoundStore(w, 'repo', 'repo-early')
    git(w.proj!, 'remote set-url origin git@host.invalid:org/repo')
    expect(resolveStoreName(w.proj!).storeName).toBe('repo-early')
    // The scp spelling's own binding is then pointed at a second
    // store: the shape a project acquires when its two URL forms were
    // bound separately over its life, before succession existed.
    const b = readBindings(w.bindingsPath!)
    const scpFp = Object.entries(b.projects).find(([, e]) => e.source === 'carried-forward')![0]
    b.projects[scpFp]!.store = 'repo-late'
    writeFileSync(w.bindingsPath!, JSON.stringify(b, null, 2))
  })

  reg.define(/^the remote is respelled a third way and the store is resolved$/, (w) => {
    git(w.proj!, 'remote set-url origin ssh://git@host.invalid/org/repo')
    w.resolved = resolveStoreName(w.proj!, opts(w))
    w.expectFreshExact = 'repo'
    w.expectFreshSource = 'git'
  })

  reg.define(/^the conflict is disclosed naming both predecessor stores$/, (w) => {
    expect(w.events).toEqual([
      { kind: 'conflict', stores: ['repo-early', 'repo-late'] },
    ])
  })

  reg.define(/^a repository bound by its remote URL beside a stale path binding naming another store$/, (w) => {
    freshWorld(w)
    initRepo(w.proj!)
    git(w.proj!, 'remote add origin https://host.invalid/org/repo.git')
    expect(resolveStoreName(w.proj!).storeName).toBe('repo')
    git(w.proj!, 'remote remove origin')
    const pathStore = resolveStoreName(w.proj!).storeName
    renameBoundStore(w, pathStore, 'stale-path-store')
    git(w.proj!, 'remote add origin https://host.invalid/org/repo.git')
  })

  reg.define(/^the store is resolved$/, (w) => {
    w.resolved = resolveStoreName(w.proj!, opts(w))
  })

  reg.define(/^the resolved store is the one its own binding names$/, (w) => {
    expect(w.resolved!.storeName).toBe('repo')
    expect(w.resolved!.source).toBe('binding')
    expect(w.events).toEqual([])
  })

  reg.define(/^the stale path binding is untouched$/, (w) => {
    expect(entryNaming(w, 'stale-path-store')!.source).toBe('path')
    expect(Object.keys(bindingEntries(w))).toHaveLength(2)
  })

  reg.define(/^a linked worktree of it is added and the store is resolved from inside the worktree$/, (w) => {
    w.worktree = join(w.dir!, 'wt')
    git(w.proj!, `worktree add -q "${w.worktree}" -b wt-lane`)
    w.resolved = resolveStoreName(w.worktree)
  })

  reg.define(/^the resolved store is the project's own$/, (w) => {
    expect(w.resolved!.storeName).toBe(w.projectStore)
    // A HIT on the project's own fingerprint, not a succession: the
    // worktree resolves the primary root as its identity.
    expect(w.resolved!.source).toBe('binding')
  })

  reg.define(/^no second binding was written$/, (w) => {
    expect(Object.keys(bindingEntries(w))).toHaveLength(1)
  })

  reg.define(/^two unrelated repositories each reached through a symlink of a different depth$/, (w) => {
    freshWorld(w)
    // Real subdirectories inside real repos, reached through symlinks
    // that are SHALLOWER than their targets: git answers relative to
    // the physical path, and the F1 defect resolved that offset
    // against the lexical one.
    for (const name of ['repoA', 'repoB']) {
      initRepo(join(w.dir!, name))
      mkdirSync(join(w.dir!, name, 'packages', 'app'), { recursive: true })
    }
    w.linkA = join(w.dir!, 'a')
    w.linkB = join(w.dir!, 'b')
    symlinkSync(join(w.dir!, 'repoA', 'packages', 'app'), w.linkA)
    symlinkSync(join(w.dir!, 'repoB', 'packages', 'app'), w.linkB)
  })

  reg.define(/^each resolves its store name through its symlink$/, (w) => {
    w.stores = [resolveStoreName(w.linkA!).storeName, resolveStoreName(w.linkB!).storeName]
  })

  reg.define(/^each resolves to its own project's store, and the stores differ$/, (w) => {
    expect(w.stores![0]).not.toBe(w.stores![1])
    // And each symlinked view names the same store its REAL path does
    // — the identity is the project, not the route taken into it.
    expect(resolveStoreName(join(w.dir!, 'repoA', 'packages', 'app')).storeName).toBe(w.stores![0])
    expect(resolveStoreName(join(w.dir!, 'repoB', 'packages', 'app')).storeName).toBe(w.stores![1])
  })

  reg.define(/^a project with a worktree, bound to its own store, and two unpacked directories whose \.git files name it$/, (w) => {
    freshWorld(w)
    const victim = join(w.dir!, 'victim')
    initRepo(victim)
    commitSomething(victim)
    git(victim, `worktree add -q "${join(w.dir!, 'victim-wt')}" -b victim-lane`)
    w.victimStore = resolveStoreName(victim).storeName
    w.victimEntry = { ...entryNaming(w, w.victimStore)! }
    const plain = join(w.dir!, 'unpacked-plain')
    const chained = join(w.dir!, 'unpacked-chained')
    for (const h of [plain, chained]) mkdirSync(h, { recursive: true })
    // The one attacker-authored line a tarball can carry — and the
    // chained spelling that wears the FULL worktrees signature
    // (Phase-2 review S1: the plain spelling alone under-claimed).
    writeFileSync(join(plain, '.git'), `gitdir: ${realpathSync.native(victim)}/.git\n`)
    writeFileSync(join(chained, '.git'), `gitdir: ${realpathSync.native(victim)}/.git/worktrees/victim-wt\n`)
  })

  reg.define(/^each unpacked directory resolves its store name$/, (w) => {
    w.resolvedList = [join(w.dir!, 'unpacked-plain'), join(w.dir!, 'unpacked-chained')]
      .map((h) => resolveStoreName(h))
  })

  reg.define(/^each derives a fresh store of its own$/, (w) => {
    for (const r of w.resolvedList!) {
      expect(r.storeName).not.toBe(w.victimStore)
      expect(r.source).toBe('path')
    }
    // And they are two different impostors, not one shared identity.
    expect(w.resolvedList![0]!.storeName).not.toBe(w.resolvedList![1]!.storeName)
  })

  // Merged: the .git-file and core.worktree scenarios pin the identical
  // observable over the staged victim.
  reg.define(/^the project's binding is untouched$/, (w) => {
    expect(entryNaming(w, w.victimStore!)).toEqual(w.victimEntry)
  })

  reg.define(/^a project bound to its own store and a repository whose config claims the project as its worktree$/, (w) => {
    freshWorld(w)
    const victim = join(w.dir!, 'victim')
    initRepo(victim)
    w.victimStore = resolveStoreName(victim).storeName
    w.victimEntry = { ...entryNaming(w, w.victimStore)! }
    const claiming = join(w.dir!, 'claiming')
    initRepo(claiming)
    git(claiming, `config core.worktree "${realpathSync.native(victim)}"`)
  })

  reg.define(/^the claiming repository resolves its store name$/, (w) => {
    w.resolved = resolveStoreName(join(w.dir!, 'claiming'))
  })

  reg.define(/^it derives a fresh store of its own$/, (w) => {
    expect(w.resolved!.storeName).not.toBe(w.victimStore)
    expect(w.resolved!.source).toBe('path')
  })

  reg.define(/^a repository with no remote and a hostile remote URL injected through the environment$/, (w) => {
    freshWorld(w)
    initRepo(w.proj!)
    const INJECTED = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'] as const
    const saved: Record<string, string | undefined> = {}
    for (const k of INJECTED) saved[k] = process.env[k]
    // Restored by defer as well as the When's finally: a failure between
    // here and the When must not leak injected config into every later
    // scenario in the worker.
    w.defer(() => {
      for (const k of INJECTED) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    })
    process.env['GIT_CONFIG_COUNT'] = '1'
    process.env['GIT_CONFIG_KEY_0'] = 'remote.origin.url'
    process.env['GIT_CONFIG_VALUE_0'] = 'https://example.invalid/victim/secret.git'
  })

  reg.define(/^the repository resolves its store name$/, (w) => {
    w.resolved = resolveStoreName(w.proj!)
  })

  reg.define(/^its identity is still the path identity, not the injected remote$/, (w) => {
    expect(w.resolved!.source).toBe('path')
    // The slug an adopted injected remote would have produced.
    expect(w.resolved!.storeName).not.toBe('secret')
  })

  // ── Detection (docs/project-identity.md §4) ────────────────────────
  //
  // The seeding writes bindings.json BY HAND. Resolving to seed would
  // defeat the scenario twice over: it would mint the fingerprints the
  // detector is supposed to read rather than compute, and it would make
  // "byte-identical afterwards" a claim about a file this test had just
  // written through the very code path doctor must not use.

  const storesDir = (w: World): string => storesDirIn(w.dir!)

  /** A REAL store on the fixture's disk: doctor counts by opening it
   *  read-only, so a fabricated file would count "?" and pin nothing. */
  const seedStore = (w: World, name: string, nodes: number): void => {
    const storeDir = join(storesDir(w), name)
    mkdirSync(storeDir, { recursive: true })
    const db = new BetterSqlite3(join(storeDir, 'treecontext.db'))
    db.exec(SCHEMA_SQL)
    db.prepare("INSERT INTO trees (tree_id, namespace, ensemble_index, created_at) VALUES (1, 'project', 0, 0)").run()
    const insert = db.prepare(
      'INSERT INTO nodes (node_id, tree_id, depth, is_leaf, content, created_at, updated_at)'
      + ' VALUES (?, 1, 0, 1, ?, 0, 0)',
    )
    for (let i = 0; i < nodes; i++) insert.run(`${name}-${i}`, `entry ${i}`)
    db.close()
  }

  /** Fingerprints are opaque 16-hex keys to every reader of this file;
   *  the detector never inverts one, so any distinct pair will do.
   *  `updatedAt` defaults to the fixed stamp the split scenarios were
   *  written against — only the age-bearing checks name their own. */
  const writeBindingsByHand = (
    w: World,
    entries: Array<{ store: string; source: string; updatedAt?: number }>,
  ): void => {
    const projects: Record<string, unknown> = {}
    entries.forEach((e, i) => {
      projects[`${i}`.repeat(16).slice(0, 16)] =
        { store: e.store, updatedAt: e.updatedAt ?? 1755000000000, source: e.source }
    })
    writeFileSync(w.bindingsPath!, JSON.stringify({ version: 1, projects }, null, 2) + '\n')
  }

  const runDoctorFromElsewhere = (w: World): string => {
    const elsewhere = join(w.dir!, 'unrelated')
    mkdirSync(elsewhere, { recursive: true })
    return spawnCli(['doctor'], {
      home: w.dir!, cwd: elsewhere, env: { TREECONTEXT_BINDINGS_FILE: w.bindingsPath! },
    }).out
  }

  /**
   * Size + mtime of each store's database, for the no-write clauses.
   *
   * The database FILE, not the directory listing the split scenario
   * pins: these stores are WAL (the real schema head is), and SQLite
   * recreates -shm/-wal for any reader of a WAL database, read-only
   * connections included. So the listing is not evidence here — the file
   * being byte-for-byte the same size at the same mtime is, and the
   * emptiness of any -wal is the rest of it.
   */
  const storeStamps = (w: World, ...names: string[]): string =>
    names.map((n) => {
      const st = statSync(join(storesDir(w), n, 'treecontext.db'))
      const wal = join(storesDir(w), n, 'treecontext.db-wal')
      const walBytes = existsSync(wal) ? statSync(wal).size : 0
      return `${n}:${st.size}:${st.mtimeMs}:wal=${walBytes}`
    }).join('|')

  reg.define(/^a path binding to "proj-ab12cd" and a git binding to "proj", each holding a store$/, (w) => {
    freshWorld(w)
    seedStore(w, 'proj-ab12cd', 3)
    seedStore(w, 'proj', 7)
    writeBindingsByHand(w, [
      { store: 'proj-ab12cd', source: 'path' },
      { store: 'proj', source: 'git' },
    ])
    w.before = readFileSync(w.bindingsPath!, 'utf8')
  })

  reg.define(/^doctor runs from an unrelated directory$/, (w) => {
    w.out = runDoctorFromElsewhere(w)
  })

  reg.define(/^the split is reported as a candidate naming both stores and both node counts$/, (w) => {
    expect(w.out).toMatch(
      /Split candidates: proj-ab12cd \(3 nodes, bound by path\) and proj \(7 nodes, bound by git\)/,
    )
    // A6: the shape is a heuristic, and the word carrying that is the
    // one the output must never lose.
    expect(w.out).toMatch(/candidate, not a verdict/)
  })

  reg.define(/^the fix line names the merge command with the path-bound store as its source$/, (w) => {
    // Exactly the next line — doctor prints each row's own fix
    // directly beneath it, so a wider window would let this pass on a
    // neighbouring row's fix (journal-install's universal clause).
    const lines = w.out!.split('\n')
    const idx = lines.findIndex((l) => l.startsWith('[warn] Split candidates:'))
    expect(idx, w.out).toBeGreaterThanOrEqual(0)
    expect(lines[idx + 1]).toBe('       fix: treecontext stores merge proj-ab12cd proj')
  })

  reg.define(/^the report states that the list is not exhaustive$/, (w) => {
    expect(w.out).toMatch(/NOT an exhaustive list/)
    expect(w.out).toMatch(/renamed before/)
  })

  reg.define(/^bindings\.json is byte-identical afterwards$/, (w) => {
    expect(readFileSync(w.bindingsPath!, 'utf8')).toBe(w.before)
  })

  reg.define(/^neither store gained a write-ahead sidecar$/, (w) => {
    // The other half of "reports, never repairs": read-only opens
    // cannot leave -wal/-shm behind, and a migration would.
    for (const name of ['proj-ab12cd', 'proj']) {
      expect(readdirSync(join(storesDir(w), name))).toEqual(['treecontext.db'])
    }
  })

  reg.define(/^a path binding to "my-app-abc123" with no git binding holding "my-app"$/, (w) => {
    freshWorld(w)
    writeBindingsByHand(w, [
      { store: 'my-app-abc123', source: 'path' },
      { store: 'unrelated-project', source: 'git' },
      { store: 'workbench-notes', source: 'path' },
      { store: 'workbench', source: 'git' },
    ])
  })

  reg.define(/^a path binding to "workbench-notes" beside a git binding to "workbench"$/, (w) => {
    // Seeded together above: one bindings file, both decoys.
    expect(Object.keys(bindingEntries(w))).toHaveLength(4)
  })

  reg.define(/^no split candidate is reported$/, (w) => {
    expect(w.out).toMatch(/Split candidates: 0 candidates among 4 bindings/)
    // step-lint: allow unearned-absence -- guarded: the paired positive above asserts 'Split candidates: 0 candidates among 4 bindings' for this same doctor output
    expect(w.out).not.toMatch(/stores merge/)
  })

  reg.define(/^neither path-bound store is named in the report$/, (w) => {
    // step-lint: allow unearned-absence -- guarded: the decoy stores were seeded together (binding count asserted in the beside-a-git-binding Given) and ARE named in the split scenarios' reports; this clean run must name neither
    expect(w.out).not.toMatch(/my-app-abc123/)
    // step-lint: allow unearned-absence -- guarded: same seeding proof as above; workbench appears only where a split exists
    expect(w.out).not.toMatch(/workbench/)
  })

  reg.define(/^a path binding to "proj-ab12cd" holding a store and a git binding to "proj" holding none$/, (w) => {
    freshWorld(w)
    seedStore(w, 'proj-ab12cd', 3)
    writeBindingsByHand(w, [
      { store: 'proj-ab12cd', source: 'path' },
      { store: 'proj', source: 'git' },
    ])
  })

  reg.define(/^the pair is reported as a dangling binding naming "proj"$/, (w) => {
    expect(w.out).toMatch(/proj holds no store on disk/)
    expect(w.out).toMatch(/dangling binding, not two journals/)
  })

  reg.define(/^no merge command is advised$/, (w) => {
    // step-lint: allow unearned-absence -- guarded: the split scenario's fix-line Then asserts the merge advice appears where the split exists; this is its no-split control
    expect(w.out).not.toMatch(/stores merge/)
  })

  // ── Self-audit (docs/project-identity.md §11a checks 2-4) ──────────
  //
  // Same discipline as the detection scenarios above: real stores at the
  // real schema head (the audit queries read columns migrations added, so
  // a stamped baseline would make every check degrade to "?" and pass for
  // the wrong reason), and every scenario ends by proving doctor left the
  // disk exactly as it found it.

  reg.define(/^a bound store whose two entries collide under one dedup key$/, (w) => {
    freshWorld(w)
    // preDigest: the collision this check exists to find only exists
    // on a store that has not climbed 024 — after it, the digest tells
    // the pair apart and there is nothing to report (§11b).
    seedAuditStore(storesDir(w), 'colliding-store', {
      preDigest: true,
      nodes: [{ content: COLLIDING_A }, { content: COLLIDING_B }],
    })
  })

  reg.define(/^a second bound store holding one entry filed twice under one key$/, (w) => {
    // The designed dedup shape: identical content under one key, which
    // is what the store looks like when dedup is WORKING.
    seedAuditStore(storesDir(w), 'deduped-store', {
      preDigest: true,
      nodes: [{ content: COLLIDING_A }, { content: COLLIDING_A }],
    })
    writeBindingsByHand(w, [
      { store: 'colliding-store', source: 'path' },
      { store: 'deduped-store', source: 'git' },
    ])
    w.before = readFileSync(w.bindingsPath!, 'utf8')
    w.stamps = storeStamps(w, 'colliding-store', 'deduped-store')
  })

  reg.define(/^the collision is reported as one group of two rows, naming only that store$/, (w) => {
    expect(w.out).toMatch(
      /Fingerprint collisions: colliding-store \(1 group, 2 rows\) among 2 bound stores/,
    )
    // The healthy half, and the load-bearing half: a check comparing
    // fingerprints alone would name this store too, on every machine.
    // Scoped to the collision LINE since §11b: both fixtures are
    // genuine pre-024 stores, so the schema check legitimately names
    // them both as v23→v24 elsewhere in the report.
    const collisionLine = w.out!.split('\n').find((l) => l.includes('Fingerprint collisions:'))!
    // step-lint: allow unearned-absence -- guarded: the Givens seed deduped-store and bind it but assert nothing; the first positive is the collision regex just above (store-bindings.steps.ts:981), whose 'among 2 bound stores' shows doctor read deduped-store's binding and still named only colliding-store
    expect(collisionLine).not.toMatch(/deduped-store/)
  })

  reg.define(/^the report says the rows are at risk only on import and merge, and names the migration that retires the class$/, (w) => {
    expect(w.out).toMatch(/Nothing is at risk in place/)
    expect(w.out).toMatch(/only dropped on the import and merge paths/)
    expect(w.out).toMatch(/Phase 3 digest migration retires the class/)
  })

  reg.define(/^bindings\.json is byte-identical and neither store file changed$/, (w) => {
    expect(readFileSync(w.bindingsPath!, 'utf8')).toBe(w.before)
    // Size, mtime, and directory contents: a read-only open cannot
    // leave a -wal behind, and a migration would leave all three.
    expect(storeStamps(w, 'colliding-store', 'deduped-store')).toBe(w.stamps)
  })

  reg.define(/^a binding written long ago to a store holding nothing$/, (w) => {
    freshWorld(w)
    w.boundAt = Date.now() - 90 * 86400_000
    seedAuditStore(storesDir(w), 'empty-store', {})
  })

  reg.define(/^a second bound store holding entries$/, (w) => {
    seedAuditStore(storesDir(w), 'lived-in-store', { nodes: [{ content: 'a note' }] })
    writeBindingsByHand(w, [
      { store: 'empty-store', source: 'path', updatedAt: w.boundAt! },
      { store: 'lived-in-store', source: 'git' },
    ])
    w.before = readFileSync(w.bindingsPath!, 'utf8')
    w.stamps = storeStamps(w, 'empty-store', 'lived-in-store')
  })

  reg.define(/^the empty store is reported with the age of its binding$/, (w) => {
    const day = new Date(w.boundAt!).toISOString().slice(0, 10)
    expect(w.out).toMatch(new RegExp(
      `Bound-but-empty stores: empty-store \\(bound ${day}, 90 days ago\\) among 2 bound stores`,
    ))
  })

  reg.define(/^the store holding entries is not named$/, (w) => {
    // step-lint: allow unearned-absence -- guarded: the Givens seed lived-in-store and bind it but assert nothing; the first positive is the previous Then's empty-store regex (store-bindings.steps.ts:1025), whose 'among 2 bound stores' shows doctor read lived-in-store's binding
    expect(w.out).not.toMatch(/lived-in-store/)
    expect(readFileSync(w.bindingsPath!, 'utf8')).toBe(w.before)
    expect(storeStamps(w, 'empty-store', 'lived-in-store')).toBe(w.stamps)
  })

  reg.define(/^the report states that emptiness alone proves nothing$/, (w) => {
    expect(w.out).toMatch(/emptiness alone proves NOTHING/)
    expect(w.out).toMatch(/not been captured yet/)
  })

  reg.define(/^a project whose store holds capture gaps of every kind and an undrained backlog$/, (w) => {
    freshWorld(w)
    // Resolved rather than hand-written: doctor finds this store by
    // looking THIS directory's identity up, so the binding key has to be
    // the real fingerprint and no fixture can invent one.
    mkdirSync(join(w.dir!, 'indebted'), { recursive: true })
    w.indebted = resolveStoreName(join(w.dir!, 'indebted')).storeName
    seedAuditStore(storesDir(w), w.indebted, {
      nodes: [
        { content: 'a note that did land' },
        // The other two gap kinds the drain writes (Phase-2 review
        // S2): under the one-kind predicate this scenario read
        // "2 dead-lettered" and passed while both were invisible.
        {
          content: '[capture gap] Recovery snapshot was malformed and was dead-lettered.',
          metadata: { source: 'capture-gap', event: 'malformed_snapshot' },
        },
        {
          content: '[capture gap] 3 events dropped by the byte valve. The journal has a hole here.',
          metadata: { source: 'capture-gap', event: 'capture_gap' },
        },
      ],
      deadLetters: 2,
      stagedAgoSecs: [4 * 86400, 60],
    })
  })

  reg.define(/^a second project whose store is draining cleanly$/, (w) => {
    mkdirSync(join(w.dir!, 'draining'), { recursive: true })
    w.clean = resolveStoreName(join(w.dir!, 'draining')).storeName
    seedAuditStore(storesDir(w), w.clean, { nodes: [{ content: 'a note that did land' }] })
    w.stamps = storeStamps(w, w.indebted!, w.clean)
  })

  reg.define(/^doctor runs from each project directory$/, (w) => {
    const run = (cwd: string): string => spawnCli(['doctor'], {
      home: w.dir!, cwd, env: { TREECONTEXT_BINDINGS_FILE: w.bindingsPath! },
    }).out
    w.indebtedOut = run(join(w.dir!, 'indebted'))
    w.cleanOut = run(join(w.dir!, 'draining'))
  })

  reg.define(/^the indebted store is reported as a warning counting all its capture gaps and its oldest undrained event$/, (w) => {
    // FOUR: 2 dead letters + 1 malformed snapshot + 1 valve drop.
    // A predicate filtered back to one kind reads 2 and fails here.
    expect(w.indebtedOut).toContain(
      `[warn] Capture debt: ${w.indebted}: 4 capture gaps`
      + ' — holes this store admitted in itself (dead letters, malformed snapshots, valve drops);'
      + ' 2 events still staged, oldest waiting 4 days',
    )
  })

  reg.define(/^the fix line names where those events are recorded$/, (w) => {
    // Exactly the next line, same geometry as the split scenario: a
    // wider window would let this pass on a neighbouring row's fix.
    const lines = w.indebtedOut!.split('\n')
    const idx = lines.findIndex((l) => l.startsWith('[warn] Capture debt:'))
    expect(idx, w.indebtedOut).toBeGreaterThanOrEqual(0)
    expect(lines[idx + 1]).toContain('fix: Read them from the journal')
    expect(lines[idx + 1]).toContain(join(storesDir(w), w.indebted!, 'treecontext.db'))
    expect(lines[idx + 1]).toContain('nothing re-ingests a dead letter')
  })

  reg.define(/^the clean project's report carries no capture-debt warning$/, (w) => {
    expect(w.cleanOut).toMatch(new RegExp(`Capture debt: ${w.clean}: no capture gaps, staging clear`))
    // step-lint: allow unearned-absence -- guarded: the clean capture-debt line is asserted positively immediately above; the [warn] form belongs to the indebted fixture pinned in the sibling Then
    expect(w.cleanOut).not.toMatch(/\[warn\] Capture debt/)
  })

  reg.define(/^neither store file changed$/, (w) => {
    expect(storeStamps(w, w.indebted!, w.clean!)).toBe(w.stamps)
  })

  reg.define(/^a project whose store has a backlog past the pane's warning line and no gaps$/, (w) => {
    freshWorld(w)
    mkdirSync(join(w.dir!, 'stalled'), { recursive: true })
    w.stalled = resolveStoreName(join(w.dir!, 'stalled')).storeName
    // 25 staged, 0 gaps: past DRAIN_BACKLOG_WARN (20), the sidecar
    // pane's own line. Under the old grading this read [ok].
    seedAuditStore(storesDir(w), w.stalled, {
      nodes: [{ content: 'a note that did land' }],
      stagedAgoSecs: Array.from({ length: 25 }, (_, i) => 3600 + i),
    })
  })

  reg.define(/^doctor runs from that project directory$/, (w) => {
    w.out = spawnCli(['doctor'], {
      home: w.dir!, cwd: join(w.dir!, 'stalled'), env: { TREECONTEXT_BINDINGS_FILE: w.bindingsPath! },
    }).out
  })

  reg.define(/^capture debt is a warning saying nothing is draining this store$/, (w) => {
    expect(w.out).toContain(`[warn] Capture debt: ${w.stalled}: no capture gaps recorded, but 25 events still staged`)
    expect(w.out).toContain('nothing is draining this store')
  })

  reg.define(/^the fix line says the backlog is waiting, not lost$/, (w) => {
    const lines = w.out!.split('\n')
    const idx = lines.findIndex((l) => l.startsWith('[warn] Capture debt:'))
    expect(idx, w.out).toBeGreaterThanOrEqual(0)
    expect(lines[idx + 1]).toContain('the backlog is not lost, it is waiting')
  })
}
