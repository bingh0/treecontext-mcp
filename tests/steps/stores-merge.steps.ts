/**
 * stores-merge.feature bindings — gherkin-node-test executor.
 * (Executor-migration Phase 2, 2026-08-26: translated from the
 * vitest-cucumber binding; every assertion preserved verbatim.)
 *
 * `stores merge` contract (docs/project-identity.md §5, §11c).
 *
 * Every scenario spawns the REAL CLI: the argument parse, the
 * precondition refusals, the exit codes, and the disclosure text live in
 * main()'s dispatch and in runStores, and a library-level call would
 * grade none of them. Each scenario owns a sandboxed home passed to the
 * spawn (the command reads everything through explicit paths and env —
 * no import-freeze here). Stores are real journals written through
 * FlatStore.insert (helpers/merge-fixtures.ts): the merge reads the
 * arbiter columns and re-anchors through dedup_anchors, so a
 * hand-stamped fixture would prove the copy against a store shape that
 * never occurs.
 *
 * The namespace-enumerator and arithmetic unit pins live in
 * tests/server/stores-merge-internals.test.ts — functions, not a
 * command. The shared "a split pair with both bindings on disk" Given
 * carries the repoint scenario's doctor probe for both of its scenarios
 * (a fixture precondition: the split must be visible before either
 * half of the repoint contract runs).
 */
import {
  mkdirSync, readFileSync, writeFileSync, statSync, symlinkSync, copyFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { expect } from 'vitest'
import type { Registry } from 'gherkin-node-test/vitest'

import BetterSqlite3 from 'better-sqlite3'

import { spawnCli } from '../helpers/cli-spawn.js'
import { seedJournal, entriesOf, allNodes, countsByNamespace } from '../helpers/merge-fixtures.js'
import { freshHomeDir, seedAuditStore, storesDirIn } from '../helpers/store-fixtures.js'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { LeaseClient, DRAIN_LEASE_TTL_SECS } from '../../src/persistence/leases.js'
import { maxSupportedVersion } from '../../src/persistence/migrations/index.js'
import { mergeBackupName } from '../../src/tools/store-merge.js'

const SRC = 'proj-ab12cd'
const DST = 'proj'
const SHARED = 'A decision both journals happen to record identically: dedup must catch it across the merge.'

interface CliRun {
  status: number | null
  out: string
}

interface World {
  defer: (fn: () => void | Promise<void>) => void
  home?: string
  run?: CliRun
  srcStamp?: string
  firstIds?: string[]
  advised?: string
  schemaBefore?: string
  bindingsBefore?: string
  conflictId?: string
  dstContentBefore?: string
  holderPid?: number
}

export const storesMergeDefiner = (reg: Registry<World>): void => {
  function freshWorld(w: World): void {
    const home = freshHomeDir(w, 'tc-stores-merge-')
    mkdirSync(storesDirIn(home), { recursive: true })
    w.home = home
  }

  function storesDir(w: World): string {
    return storesDirIn(w.home!)
  }

  function bindingsPath(w: World): string {
    return join(w.home!, 'bindings.json')
  }

  function dbOf(w: World, store: string): string {
    return join(storesDir(w), store, 'treecontext.db')
  }

  function runMerge(w: World, args: string[]): CliRun {
    return spawnCli(['stores', 'merge', ...args], {
      home: w.home!, env: { TREECONTEXT_BINDINGS_FILE: bindingsPath(w) },
    })
  }

  /** A backup taken today, in the shape the freshness check accepts. B2:
   *  the gate now opens the file and runs quick_check, so a real copy of
   *  the store's own db is the only thing that satisfies it — a garbage
   *  file no longer counts. */
  function seedBackupToday(w: World, store: string): void {
    copyFileSync(dbOf(w, store), join(storesDir(w), store, mergeBackupName()))
  }

  /** The two split bindings, written by hand: fingerprints are opaque to
   *  every reader here and the detector never inverts one. */
  function writeSplitBindings(w: World): void {
    writeFileSync(bindingsPath(w), JSON.stringify({
      version: 1,
      projects: {
        '0000000000000000': { store: SRC, updatedAt: 1755000000000, source: 'path' },
        '1111111111111111': { store: DST, updatedAt: 1755000000000, source: 'git' },
      },
    }, null, 2) + '\n')
  }

  function readBindings(w: World): Record<string, { store: string; source: string }> {
    return (JSON.parse(readFileSync(bindingsPath(w), 'utf8')) as {
      projects: Record<string, { store: string; source: string }>
    }).projects
  }

  /** Size plus every node id: what "intact on disk" has to mean for a
   *  WAL store, where any reader legitimately creates -shm/-wal. */
  function stampOf(w: World, store: string): string {
    const path = dbOf(w, store)
    return `${statSync(path).size}|${allNodes(path).map((n) => n.node_id).join(',')}`
  }

  function runDoctor(w: World): string {
    const elsewhere = join(w.home!, 'unrelated')
    mkdirSync(elsewhere, { recursive: true })
    return spawnCli(['doctor'], {
      home: w.home!, cwd: elsewhere, env: { TREECONTEXT_BINDINGS_FILE: bindingsPath(w) },
    }).out
  }

  reg.define(/^a path-bound store with 163 entries and a git-bound store with 599$/, async (w) => {
    freshWorld(w)
    await seedJournal(storesDir(w), SRC, 'project', entriesOf('path-bound', 163))
    await seedJournal(storesDir(w), DST, 'project', entriesOf('git-bound', 599))
    w.srcStamp = stampOf(w, SRC)
  })

  reg.define(/^a source store holding a project namespace and an agent namespace$/, async (w) => {
    freshWorld(w)
    // A post-chunk-C store is namespace-capable, and a split
    // predecessor may hold agent lanes beside `project`. A merge that
    // copied one namespace would drop the others SILENTLY — the exact
    // failure this whole program exists to kill, reproduced here so it
    // cannot come back.
    await seedJournal(storesDir(w), SRC, 'project', entriesOf('path-bound', 7))
    await seedJournal(storesDir(w), SRC, 'agent-reviewer', entriesOf('agent-lane', 5))
    await seedJournal(storesDir(w), DST, 'project', entriesOf('git-bound', 3))
  })

  reg.define(/^a source and destination already merged once$/, async (w) => {
    freshWorld(w)
    await seedJournal(storesDir(w), SRC, 'project', entriesOf('path-bound', 9))
    await seedJournal(storesDir(w), DST, 'project', entriesOf('git-bound', 4))
    const first = runMerge(w, [SRC, DST, '--backup', '--yes'])
    expect(first.status, first.out).toBe(0)
    w.firstIds = allNodes(dbOf(w, DST)).map((n) => n.node_id)
    expect(w.firstIds).toHaveLength(13)
  })

  reg.define(/^a source and destination that share one entry's content under different ids$/, async (w) => {
    freshWorld(w)
    // Same content, seeded independently into each store, so the ids
    // differ and only the content fingerprint can relate them.
    await seedJournal(storesDir(w), SRC, 'project', [{ content: SHARED }, ...entriesOf('src-only', 2)])
    await seedJournal(storesDir(w), DST, 'project', [{ content: SHARED }, ...entriesOf('dst-only', 2)])
  })

  reg.define(/^a source store holding a read-only, decay-exempt entry$/, async (w) => {
    freshWorld(w)
    await seedJournal(storesDir(w), SRC, 'project', [{
      content: 'A curated finding worth protecting: the merge must not demote it to bulk.',
      opts: { readOnly: true, decayExempt: true },
    }])
    await seedJournal(storesDir(w), DST, 'project', entriesOf('git-bound', 2))
  })

  reg.define(/^a store that exists$/, async (w) => {
    freshWorld(w)
    await seedJournal(storesDir(w), DST, 'project', entriesOf('git-bound', 2))
    seedBackupToday(w, DST)
  })

  reg.define(/^a destination store that exists$/, async (w) => {
    freshWorld(w)
    await seedJournal(storesDir(w), DST, 'project', entriesOf('git-bound', 2))
  })

  reg.define(/^a source store one schema version behind and a destination at the head$/, async (w) => {
    freshWorld(w)
    // One version behind the head: the ladder ran, then the stamp was set
    // one below it. (Until migration 025 this was the preDigest fixture,
    // which is one below 024 and so now two behind; the head's last rung
    // only recreates an index, so the stamp claims nothing the schema
    // contradicts.)
    seedAuditStore(storesDir(w), SRC, { userVersion: maxSupportedVersion - 1, nodes: [{ content: 'an old entry' }] })
    await seedJournal(storesDir(w), DST, 'project', entriesOf('git-bound', 2))
    seedBackupToday(w, SRC)
    seedBackupToday(w, DST)
    w.schemaBefore = `${statSync(dbOf(w, SRC)).size}|${readVersion(dbOf(w, SRC))}`
  })

  reg.define(/^a destination backed up today and a source with no backup$/, async (w) => {
    freshWorld(w)
    await seedJournal(storesDir(w), SRC, 'project', entriesOf('path-bound', 3))
    await seedJournal(storesDir(w), DST, 'project', entriesOf('git-bound', 2))
    seedBackupToday(w, DST)
  })

  reg.define(/^a destination store whose drain lease is held by another process$/, async (w) => {
    freshWorld(w)
    await seedJournal(storesDir(w), SRC, 'project', entriesOf('path-bound', 3))
    await seedJournal(storesDir(w), DST, 'project', entriesOf('git-bound', 2))
    // A4: the merge must TAKE the lease, not look for its absence — so
    // the pin is a live lease row, written the way a real holder writes
    // one, still inside its TTL when the CLI runs.
    const raw = new BetterSqlite3(dbOf(w, DST), { fileMustExist: true })
    const db = wrapBetterSqlite(raw)
    w.holderPid = 424242
    new LeaseClient(db, { pid: w.holderPid, host: 'another-host', label: 'drain owner' })
      .tryAcquire('drain', DRAIN_LEASE_TTL_SECS)
    db.close()
  })

  reg.define(/^a source store with a tree-era non-leaf row$/, async (w) => {
    freshWorld(w)
    await seedJournal(storesDir(w), SRC, 'project', entriesOf('path-bound', 4))
    await seedJournal(storesDir(w), DST, 'project', entriesOf('git-bound', 2))
    const raw = new BetterSqlite3(dbOf(w, SRC), { fileMustExist: true })
    raw.prepare('UPDATE nodes SET is_leaf = 0 WHERE node_id = (SELECT node_id FROM nodes LIMIT 1)').run()
    raw.close()
  })

  // Merged: both --repoint scenarios open with the same split pair; the
  // doctor probe and the bindings snapshot travel with it (the probe is
  // a fixture precondition for BOTH halves — neither contract means
  // anything if the split was never visible).
  reg.define(/^a split pair with both bindings on disk$/, async (w) => {
    freshWorld(w)
    await seedJournal(storesDir(w), SRC, 'project', entriesOf('path-bound', 3))
    await seedJournal(storesDir(w), DST, 'project', entriesOf('git-bound', 2))
    writeSplitBindings(w)
    w.bindingsBefore = readFileSync(bindingsPath(w), 'utf8')
    expect(runDoctor(w)).toMatch(new RegExp(`Split candidates: ${SRC} \\(3 nodes, bound by path\\)`))
  })

  reg.define(/^a split pair doctor reports$/, async (w) => {
    freshWorld(w)
    await seedJournal(storesDir(w), SRC, 'project', entriesOf('path-bound', 3))
    await seedJournal(storesDir(w), DST, 'project', entriesOf('git-bound', 2))
    writeSplitBindings(w)
    const line = runDoctor(w).split('\n').find((l) => l.includes('fix: treecontext stores merge'))
    expect(line, 'doctor must advise the merge for an addressable pair').toBeDefined()
    w.advised = line!.split('fix: ')[1]!.trim()
    expect(w.advised).toBe(`treecontext stores merge ${SRC} ${DST}`)
  })

  reg.define(/^a source store with events still staged and undrained$/, async (w) => {
    freshWorld(w)
    await seedJournal(storesDir(w), SRC, 'project', entriesOf('path-bound', 3))
    await seedJournal(storesDir(w), DST, 'project', entriesOf('git-bound', 2))
    // The copy body reads `nodes` only; a row still in `staging` with
    // processed = 0 is owed work the merge would silently leave behind.
    const raw = new BetterSqlite3(dbOf(w, SRC), { fileMustExist: true })
    raw.prepare(
      "INSERT INTO staging (session_id, role, content, timestamp, processed) "
      + "VALUES ('sess', 'user', 'an event never drained', 1, 0)",
    ).run()
    raw.prepare(
      "INSERT INTO staging (session_id, role, content, timestamp, processed) "
      + "VALUES ('sess', 'user', 'a second undrained event', 2, 0)",
    ).run()
    raw.close()
  })

  reg.define(/^a source store holding one row that cannot be decoded beside readable ones$/, async (w) => {
    freshWorld(w)
    await seedJournal(storesDir(w), SRC, 'project', entriesOf('path-bound', 4))
    await seedJournal(storesDir(w), DST, 'project', entriesOf('git-bound', 2))
    // A v24 store can hold a row a later runtime cannot decode (024's
    // own log expects them). The unknown flag byte 0xee is exactly what
    // decodeContent throws on — the throw used to abort the whole merge
    // after backups were written.
    const raw = new BetterSqlite3(dbOf(w, SRC), { fileMustExist: true })
    raw.prepare('UPDATE nodes SET content = ? WHERE node_id = (SELECT node_id FROM nodes LIMIT 1)')
      .run(Buffer.from([0xee, 1, 2, 3]))
    raw.close()
  })

  reg.define(/^a destination already holding a row under a source id but with different content$/, async (w) => {
    freshWorld(w)
    await seedJournal(storesDir(w), SRC, 'project', entriesOf('path-bound', 3))
    await seedJournal(storesDir(w), DST, 'project', entriesOf('git-bound', 2))
    // Merge once so the destination carries the source ids, then rewrite
    // ONE carried row's content: now a different row wears that id, the
    // exact state that used to read as "already present" (false).
    const first = runMerge(w, [SRC, DST, '--backup', '--yes'])
    expect(first.status, first.out).toBe(0)
    const raw = new BetterSqlite3(dbOf(w, SRC), { fileMustExist: true })
    w.conflictId = (raw.prepare('SELECT node_id FROM nodes LIMIT 1').get() as { node_id: string }).node_id
    raw.close()
    const dst = new BetterSqlite3(dbOf(w, DST), { fileMustExist: true })
    dst.prepare('UPDATE nodes SET content = ? WHERE node_id = ?')
      .run('a DIFFERENT row wearing the same id', w.conflictId)
    w.dstContentBefore = String(
      (dst.prepare('SELECT content FROM nodes WHERE node_id = ?').get(w.conflictId) as { content: string }).content,
    )
    dst.close()
  })

  reg.define(/^a source store with a row at depth 1$/, async (w) => {
    freshWorld(w)
    await seedJournal(storesDir(w), SRC, 'project', entriesOf('path-bound', 4))
    await seedJournal(storesDir(w), DST, 'project', entriesOf('git-bound', 2))
    const raw = new BetterSqlite3(dbOf(w, SRC), { fileMustExist: true })
    raw.prepare('UPDATE nodes SET depth = 1 WHERE node_id = (SELECT node_id FROM nodes LIMIT 1)').run()
    raw.close()
  })

  reg.define(/^a source whose store directory is a symlink to a store outside the root$/, async (w) => {
    freshWorld(w)
    await seedJournal(storesDir(w), DST, 'project', entriesOf('git-bound', 2))
    // A real store OUTSIDE the stores root, reached through a symlink
    // named like an ordinary store INSIDE it. The lexical checks all pass
    // — only realpath reveals the escape.
    const outside = join(w.home!, 'outside-store')
    await seedJournal(outside, 'real', 'project', entriesOf('path-bound', 3))
    symlinkSync(join(outside, 'real'), join(storesDir(w), SRC))
  })

  reg.define(/^an alias store directory symlinked to the destination's own directory$/, async (w) => {
    freshWorld(w)
    await seedJournal(storesDir(w), DST, 'project', entriesOf('git-bound', 5))
    seedBackupToday(w, DST)
    // `alias` is a symlink to DST's directory: string-distinct names,
    // one real target. A merge would be a no-op reported as merged, then
    // advise `stores rm alias`, which unlinks the real store.
    symlinkSync(join(storesDir(w), DST), join(storesDir(w), 'alias'))
  })

  // ── Whens ──────────────────────────────────────────────────────────

  reg.define(/^the stores are merged with backups taken$/, (w) => {
    w.run = runMerge(w, [SRC, DST, '--backup', '--yes'])
  })

  reg.define(/^the same merge runs again$/, (w) => {
    w.run = runMerge(w, [SRC, DST, '--yes'])
  })

  reg.define(/^the same source is merged again$/, (w) => {
    w.run = runMerge(w, [SRC, DST, '--yes'])
  })

  reg.define(/^it is named as both source and destination$/, (w) => {
    w.run = runMerge(w, [DST, DST, '--yes'])
  })

  reg.define(/^a source name that escapes the stores root is passed$/, (w) => {
    w.run = runMerge(w, ['../elsewhere', DST, '--yes'])
  })

  reg.define(/^the stores are merged$/, (w) => {
    w.run = runMerge(w, [SRC, DST, '--yes'])
  })

  reg.define(/^the stores are merged without the backup flag$/, (w) => {
    w.run = runMerge(w, [SRC, DST, '--yes'])
  })

  reg.define(/^the stores are merged with backups taken and no repoint flag$/, (w) => {
    w.run = runMerge(w, [SRC, DST, '--backup', '--yes'])
  })

  reg.define(/^the stores are merged with backups taken and the repoint flag$/, (w) => {
    w.run = runMerge(w, [SRC, DST, '--backup', '--repoint', '--yes'])
  })

  reg.define(/^the exact command from doctor's fix line is run$/, (w) => {
    w.run = runMerge(w, w.advised!.split(' ').slice(3))
  })

  reg.define(/^the alias is merged into the destination$/, (w) => {
    w.run = runMerge(w, ['alias', DST, '--yes'])
  })

  // ── Thens ──────────────────────────────────────────────────────────

  reg.define(/^the destination holds all 762 entries$/, (w) => {
    expect(w.run!.status, w.run!.out).toBe(0)
    expect(countsByNamespace(dbOf(w, DST))).toEqual({ project: 762 })
  })

  reg.define(/^the per-namespace and total counts are reported$/, (w) => {
    expect(w.run!.out).toMatch(
      /namespace project: 163 imported, 0 skipped as duplicate, 0 skipped as already present, 0 skipped as id conflict, 0 skipped as undecodable, 0 skipped as empty, 163 in source/,
    )
    expect(w.run!.out).toMatch(
      /Total: 163 imported, 0 skipped as duplicate, 0 skipped as already present, 0 skipped as id conflict, 0 skipped as undecodable, 0 skipped as empty, 163 in source across 1 namespace\(s\)/,
    )
    // §5.1's honest half: one immediate transaction buys consistency,
    // and completeness is a assumption about the source being quiet.
    expect(w.run!.out).toMatch(/Consistency is guaranteed/)
    expect(w.run!.out).toMatch(/Completeness assumes a quiet source/)
    // B2: a backup this command relies on is opened and verified after
    // it is written, and the line says so.
    expect(w.run!.out).toMatch(/Backed up .* \(verified, \d+ node\(s\)\)/)
  })

  reg.define(/^the source store is intact on disk and named as the user's own follow-up$/, (w) => {
    // D5: merging never deletes. `stores rm` stays an explicit act.
    expect(stampOf(w, SRC)).toBe(w.srcStamp)
    expect(countsByNamespace(dbOf(w, SRC))).toEqual({ project: 163 })
    expect(w.run!.out).toMatch(new RegExp(`${SRC} is untouched on disk`))
    expect(w.run!.out).toMatch(new RegExp(`treecontext stores rm ${SRC} --yes`))
  })

  reg.define(/^both namespaces land in the destination under their own names$/, (w) => {
    expect(w.run!.status, w.run!.out).toBe(0)
    expect(countsByNamespace(dbOf(w, DST))).toEqual({ 'agent-reviewer': 5, project: 10 })
  })

  reg.define(/^each namespace's counts are reported separately$/, (w) => {
    expect(w.run!.out).toMatch(/namespace agent-reviewer: 5 imported, .* 5 in source/)
    expect(w.run!.out).toMatch(/namespace project: 7 imported, .* 7 in source/)
    expect(w.run!.out).toMatch(/across 2 namespace\(s\)/)
  })

  reg.define(/^nothing is imported and every source row is reported as already present$/, (w) => {
    expect(w.run!.status, w.run!.out).toBe(0)
    // The counts must distinguish "already there by id" from "collapsed
    // by the content predicate": D2 says the latter is unreliable, and
    // a re-run that read as nine dedup hits would be hiding it.
    expect(w.run!.out).toMatch(
      /namespace project: 0 imported, 0 skipped as duplicate, 9 skipped as already present, 0 skipped as id conflict, 0 skipped as undecodable, 0 skipped as empty, 9 in source/,
    )
  })

  reg.define(/^the destination's entry count is unchanged$/, (w) => {
    expect(allNodes(dbOf(w, DST)).map((n) => n.node_id)).toEqual(w.firstIds)
  })

  reg.define(/^the shared entry is skipped as a duplicate, not imported twice$/, (w) => {
    expect(w.run!.status, w.run!.out).toBe(0)
    // 3 in source: 2 src-only imported, 1 shared skipped as duplicate.
    expect(w.run!.out).toMatch(/namespace project: 2 imported, 1 skipped as duplicate, .* 3 in source/)
    const copies = allNodes(dbOf(w, DST)).filter((n) => String(n.content) === SHARED)
    expect(copies, 'the shared content must exist exactly once in the destination').toHaveLength(1)
  })

  reg.define(/^the copied entry is still read-only and decay-exempt$/, (w) => {
    expect(w.run!.status, w.run!.out).toBe(0)
    const copied = allNodes(dbOf(w, DST)).find((n) => String(n.content).startsWith('A curated finding'))
    expect(copied, 'the curated row must be in the destination').toBeDefined()
    expect(copied!.read_only).toBe(1)
    expect(copied!.decay_exempt).toBe(1)
  })

  reg.define(/^it carries its source store and source namespace as provenance$/, (w) => {
    const copied = allNodes(dbOf(w, DST)).find((n) => String(n.content).startsWith('A curated finding'))!
    const meta = JSON.parse(copied.metadata_json ?? '{}') as Record<string, unknown>
    // D3: for a cross-STORE merge the meaningful provenance is the
    // store. `_namespace` keeps meaning the source namespace, so a
    // later reader can tell the two kinds of merge apart.
    expect(meta['_merge_source_store']).toBe(SRC)
    expect(meta['_namespace']).toBe('project')
    expect(meta['_merge_label']).toBe(`store-merge:${SRC}`)
  })

  reg.define(/^the merge refuses and says a store cannot be merged into itself$/, (w) => {
    expect(w.run!.status, w.run!.out).toBe(1)
    expect(w.run!.out).toMatch(/refuses to merge a store into itself/)
    expect(w.run!.out).toMatch(new RegExp(`'${DST}' is both source and destination`))
  })

  reg.define(/^the merge refuses and names the stores root it must resolve inside$/, (w) => {
    expect(w.run!.status, w.run!.out).toBe(1)
    expect(w.run!.out).toMatch(/refuses the source store '\.\.\/elsewhere'/)
    expect(w.run!.out).toMatch(/must resolve directly inside the stores root/)
    expect(w.run!.out).toContain(storesDir(w))
  })

  reg.define(/^the merge refuses naming the source store and its version$/, (w) => {
    expect(w.run!.status, w.run!.out).toBe(1)
    expect(w.run!.out).toMatch(
      new RegExp(`${SRC} is at schema version ${maxSupportedVersion - 1}, this build's maximum is ${maxSupportedVersion}`),
    )
  })

  reg.define(/^the source store is not migrated$/, (w) => {
    // Refusing beats migrating a store the user did not name (§5.2).
    expect(`${statSync(dbOf(w, SRC)).size}|${readVersion(dbOf(w, SRC))}`).toBe(w.schemaBefore)
  })

  reg.define(/^the merge refuses naming the store whose backup is missing$/, (w) => {
    expect(w.run!.status, w.run!.out).toBe(1)
    expect(w.run!.out).toMatch(new RegExp(`requires a backup of both stores from today; ${SRC} has none`))
    expect(w.run!.out).toMatch(/Re-run with --backup/)
    // It says WHICH is missing, so the half that is covered is not
    // re-copied on a hunch.
    expect(w.run!.out).not.toMatch(new RegExp(`${SRC} and ${DST} have none`))
  })

  reg.define(/^the merge refuses naming the lease holder$/, (w) => {
    expect(w.run!.status, w.run!.out).toBe(1)
    expect(w.run!.out).toMatch(new RegExp(`could not take the drain lease on ${DST}`))
    expect(w.run!.out).toMatch(new RegExp(`pid ${w.holderPid}`))
    expect(w.run!.out).toMatch(/another-host/)
  })

  reg.define(/^nothing is imported$/, (w) => {
    expect(countsByNamespace(dbOf(w, DST))).toEqual({ project: 2 })
  })

  reg.define(/^the merge refuses rather than silently flattening it$/, (w) => {
    // A10: the copy loop hardcodes parentId null / depth 0, so an
    // internal node would be flattened without a word.
    expect(w.run!.status, w.run!.out).toBe(1)
    expect(w.run!.out).toMatch(new RegExp(`refuses a non-flat source: ${SRC} holds 4 node\\(s\\) of which 3 are leaves`))
    expect(w.run!.out).toMatch(/would be silently flattened/)
    expect(countsByNamespace(dbOf(w, DST))).toEqual({ project: 2 })
  })

  reg.define(/^the merge reports the bindings still naming the source and prints the repoint command$/, (w) => {
    expect(w.run!.status, w.run!.out).toBe(0)
    expect(w.run!.out).toMatch(new RegExp(`1 binding\\(s\\) still name ${SRC}`))
    expect(w.run!.out).toMatch(new RegExp(`treecontext stores merge ${SRC} ${DST} --repoint --yes`))
  })

  reg.define(/^bindings.json is unchanged$/, (w) => {
    expect(readFileSync(bindingsPath(w), 'utf8')).toBe(w.bindingsBefore)
  })

  reg.define(/^every binding that named the source now names the destination$/, (w) => {
    expect(w.run!.status, w.run!.out).toBe(0)
    expect(w.run!.out).toMatch(new RegExp(`Repointed 1 binding\\(s\\) from ${SRC} to ${DST}`))
    const entries = Object.values(readBindings(w))
    expect(entries.map((e) => e.store)).toEqual([DST, DST])
  })

  reg.define(/^each binding keeps its own source value$/, (w) => {
    // The binding is the same binding, pointed at the surviving store —
    // rewriting `source` would erase how the project was identified.
    const entries = readBindings(w)
    expect(entries['0000000000000000']!.source).toBe('path')
    expect(entries['1111111111111111']!.source).toBe('git')
  })

  reg.define(/^doctor reports no split candidates$/, (w) => {
    const out = runDoctor(w)
    expect(out).toMatch(/Split candidates: 0 candidates among 2 bindings/)
    expect(out).not.toMatch(new RegExp(`stores merge ${SRC}`))
  })

  reg.define(/^it is not rejected by the argument parser$/, (w) => {
    // The fence: doctor's split check has printed this command since
    // Phase 2, and until now nothing proved the command existed.
    // step-lint: allow unearned-absence -- guarded: this scenario's Given 'a split pair doctor reports' pins doctor's fix line exact via toBe ('treecontext stores merge SRC DST', stores-merge.steps.ts:255), and the positive at the end of this step shows the command ran to the merge's own precondition; these exclude parser rejection of that exact command
    expect(w.run!.out).not.toMatch(/Unexpected argument/)
    // step-lint: allow unearned-absence -- guarded: same provers: the advised command pinned by toBe in the Given (stores-merge.steps.ts:255) and the precondition positive at the end of this step
    expect(w.run!.out).not.toMatch(/Unknown flag/)
    // step-lint: allow unearned-absence -- guarded: same provers: the advised command pinned by toBe in the Given (stores-merge.steps.ts:255) and the precondition positive at the end of this step
    expect(w.run!.out).not.toMatch(/requires a source and a destination/)
    // It reaches a precondition of the merge's own, which is what
    // "parses" means here: the command ran.
    expect(w.run!.out).toMatch(/requires a backup of both stores from today/)
  })

  reg.define(/^the merge refuses naming the undrained count and nothing is imported$/, (w) => {
    expect(w.run!.status, w.run!.out).toBe(1)
    expect(w.run!.out).toMatch(new RegExp(`refuses ${SRC}: 2 event\\(s\\) are still staged and undrained`))
    expect(w.run!.out).toMatch(/wait for its drain/)
    expect(countsByNamespace(dbOf(w, DST))).toEqual({ project: 2 })
  })

  reg.define(/^the readable rows land and the undecodable one is reported as skipped$/, (w) => {
    expect(w.run!.status, w.run!.out).toBe(0)
    // Three readable rows carried across; the fourth could not be read.
    expect(countsByNamespace(dbOf(w, DST))).toEqual({ project: 5 })
    expect(w.run!.out).toMatch(/1 skipped as undecodable/)
    expect(w.run!.out).toMatch(/namespace project: 3 imported/)
  })

  reg.define(/^the undecodable skip is called out as a warning$/, (w) => {
    expect(w.run!.out).toMatch(/WARNING: 1 source row\(s\) could not be decoded and were skipped/)
  })

  reg.define(/^the row is reported as an id conflict and the destination is not overwritten$/, (w) => {
    expect(w.run!.status, w.run!.out).toBe(0)
    // The conflicting id is NOT counted as already-present.
    expect(w.run!.out).toMatch(/1 skipped as id conflict/)
    expect(w.run!.out).toMatch(/namespace project: 0 imported, 0 skipped as duplicate, 2 skipped as already present, 1 skipped as id conflict/)
    expect(w.run!.out).toMatch(/WARNING: 1 source row\(s\) were skipped as an id conflict/)
  })

  reg.define(/^the destination row keeps its own content$/, (w) => {
    const dst = new BetterSqlite3(dbOf(w, DST), { fileMustExist: true })
    const now = String(
      (dst.prepare('SELECT content FROM nodes WHERE node_id = ?').get(w.conflictId) as { content: string }).content,
    )
    dst.close()
    expect(now).toBe(w.dstContentBefore)
  })

  reg.define(/^the merge refuses rather than flattening the depth$/, (w) => {
    expect(w.run!.status, w.run!.out).toBe(1)
    expect(w.run!.out).toMatch(/refuses a non-flat source/)
    expect(w.run!.out).toMatch(/1 sit below depth 0/)
    expect(countsByNamespace(dbOf(w, DST))).toEqual({ project: 2 })
  })

  reg.define(/^the merge refuses naming the real path outside the root$/, (w) => {
    expect(w.run!.status, w.run!.out).toBe(1)
    expect(w.run!.out).toMatch(/resolves through a symlink to/)
    expect(w.run!.out).toMatch(/outside the stores root/)
    expect(countsByNamespace(dbOf(w, DST))).toEqual({ project: 2 })
  })

  reg.define(/^the merge refuses because they resolve to the same directory$/, (w) => {
    expect(w.run!.status, w.run!.out).toBe(1)
    expect(w.run!.out).toMatch(/refuses to merge a store into itself/)
    expect(w.run!.out).toMatch(/resolve to the same directory/)
    // Nothing was advised to be removed.
    // step-lint: allow unearned-absence -- guarded: the paired positives above assert the refusal text; the Given comment names exactly the hazard (advising rm on a symlink would unlink the real store)
    expect(w.run!.out).not.toMatch(/stores rm alias/)
  })
}

function readVersion(dbPath: string): number {
  const db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true })
  try {
    return Number(db.pragma('user_version', { simple: true }))
  } finally {
    db.close()
  }
}
