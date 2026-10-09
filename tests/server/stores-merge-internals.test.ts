/**
 * stores-merge unit pins (§11c) — the namespace enumerator and the
 * count arithmetic are functions, not a command, so they pin directly
 * beside the feature scenarios (now bound in
 * tests/steps/stores-merge.steps.ts). Pure library surfaces on explicit
 * paths: no home sandbox involved.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it, expect } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'

import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { attachedNamespaces, mergeTotals } from '../../src/persistence/merge-source.js'
import { mergeBackupName, hasBackupFromToday, countsLine } from '../../src/tools/store-merge.js'
import { FlatStore } from '../../src/flat-store.js'
import { MERGE_SRC_ALIAS } from '../../src/persistence/merge-source.js'
import { randomBytes } from 'node:crypto'
import { vi } from 'vitest'

describe('stores merge internals', () => {
  it('enumerates every ensemble-index-0 namespace of the attached source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-merge-unit-'))
    try {
      const srcPath = join(dir, 'src.db')
      const raw = new BetterSqlite3(srcPath)
      raw.exec(
        'CREATE TABLE trees (tree_id INTEGER PRIMARY KEY, namespace TEXT, ensemble_index INTEGER)',
      )
      raw.prepare('INSERT INTO trees VALUES (?, ?, ?)').run(1, 'project', 0)
      raw.prepare('INSERT INTO trees VALUES (?, ?, ?)').run(2, 'agent-reviewer', 0)
      // An ensemble member is not a namespace: the tree era's non-zero
      // ensemble indices must not become destination trees.
      raw.prepare('INSERT INTO trees VALUES (?, ?, ?)').run(3, 'project', 1)
      raw.close()

      const holder = new BetterSqlite3(join(dir, 'dst.db'))
      const db = wrapBetterSqlite(holder)
      try {
        db.prepare("ATTACH DATABASE ? AS merge_src").run(srcPath)
        // Sorted, so the disclosure reads the same on every run.
        expect(attachedNamespaces(db, 'merge_src')).toEqual(['agent-reviewer', 'project'])
      } finally {
        db.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sums the per-namespace counts without losing a category', () => {
    const per = [
      {
        namespace: 'project', imported: 163, skippedDuplicate: 2, skippedExistingId: 5,
        skippedIdConflict: 1, skippedUndecodable: 3, skippedEmpty: 4, srcTotal: 178,
      },
      {
        namespace: 'agent-a', imported: 11, skippedDuplicate: 0, skippedExistingId: 1,
        skippedIdConflict: 0, skippedUndecodable: 0, skippedEmpty: 0, srcTotal: 12,
      },
    ]
    expect(mergeTotals(per)).toEqual({
      imported: 174, skippedDuplicate: 2, skippedExistingId: 6, skippedIdConflict: 1,
      skippedUndecodable: 3, skippedEmpty: 4, srcTotal: 190, namespaces: 2,
    })
    // H5: the six buckets plus srcTotal reconcile for each row.
    for (const p of per) {
      expect(p.imported + p.skippedDuplicate + p.skippedExistingId
        + p.skippedIdConflict + p.skippedUndecodable + p.skippedEmpty).toBe(p.srcTotal)
    }
    expect(mergeTotals([])).toEqual({
      imported: 0, skippedDuplicate: 0, skippedExistingId: 0, skippedIdConflict: 0,
      skippedUndecodable: 0, skippedEmpty: 0, srcTotal: 0, namespaces: 0,
    })
  })

  it('reports each namespace with every skip class named', () => {
    expect(countsLine({
      namespace: 'project', imported: 1, skippedDuplicate: 2, skippedExistingId: 3,
      skippedIdConflict: 4, skippedUndecodable: 5, skippedEmpty: 6, srcTotal: 21,
    })).toBe('namespace project: 1 imported, 2 skipped as duplicate, 3 skipped as already present, '
      + '4 skipped as id conflict, 5 skipped as undecodable, 6 skipped as empty, 21 in source')
  })

  it('accepts only a backup from today that opens as a real store (B2)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-merge-backup-'))
    try {
      expect(hasBackupFromToday(dir)).toBe(false)
      // A file with the store's own name but junk bytes is not a backup.
      writeFileSync(join(dir, 'treecontext.db'), 'not a backup')
      expect(hasBackupFromToday(dir)).toBe(false)
      // B2: a *.bak with the right name and mtime but garbage bytes does
      // NOT satisfy the gate — the old filename+mtime check accepted it.
      writeFileSync(join(dir, mergeBackupName()), 'a backup')
      expect(hasBackupFromToday(dir)).toBe(false)
      // A real store db under a *.bak name does satisfy it.
      const real = new BetterSqlite3(join(dir, mergeBackupName(Date.now(), process.pid + 1)))
      real.exec('CREATE TABLE nodes (node_id TEXT)')
      real.close()
      expect(hasBackupFromToday(dir)).toBe(true)
      // Yesterday's copy is not today's promise.
      expect(hasBackupFromToday(dir, Date.now() + 86_400_000)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // D141 review: store-merge opens its destination with no retention
  // options because that handle can never sweep. Pin it at the tightest
  // figures there are — a one-byte budget, one session, a sweep due on
  // every insert: the merge still runs no sweep and demotes or evicts
  // nothing it copied.
  it('the merge destination handle never runs the retention valve', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-merge-nosweep-'))
    try {
      const srcPath = join(dir, 'src.db')
      const src = await FlatStore.open({ database: wrapBetterSqlite(new BetterSqlite3(srcPath)), ownsDatabase: true, retentionInterval: 1_000_000 })
      const contents: string[] = []
      for (let s = 0; s < 3; s++) {
        for (let i = 0; i < 2; i++) {
          const c = `merge row ${s}-${i} ${randomBytes(1200).toString('base64')}`
          contents.push(c)
          await src.insert(c, { metadata: { source: 'auto-capture', role: 'user', session_id: `s-${s}`, _index_len: c.length }, createdAt: 1_700_000_000 + s * 10 + i })
        }
      }
      await src.close()

      const dstPath = join(dir, 'dst.db')
      const dstDb = wrapBetterSqlite(new BetterSqlite3(dstPath))
      const dst = await FlatStore.open({ database: dstDb, ownsDatabase: false, maxStoreBytes: 1, maxSessions: 1, retentionInterval: 1 })
      const sweep = vi.spyOn(dst, 'retentionSweep')
      dstDb.prepare(`ATTACH DATABASE ? AS ${MERGE_SRC_ALIAS}`).run(srcPath)
      try {
        const result = dst.mergeFromAttachedStore({ label: 'nosweep', sourceStore: 'src' })
        expect(result.perNamespace.reduce((n, c) => n + c.imported, 0)).toBe(contents.length)
      } finally {
        dstDb.prepare(`DETACH DATABASE ${MERGE_SRC_ALIAS}`).run()
      }
      expect(sweep).not.toHaveBeenCalled()
      await dst.close()
      dstDb.close()

      const ro = new BetterSqlite3(dstPath, { readonly: true })
      try {
        const rows = ro.prepare('SELECT metadata_json FROM nodes').all() as Array<{ metadata_json: string }>
        expect(rows.length).toBe(contents.length)
        for (const r of rows) expect(JSON.parse(r.metadata_json)['_demoted']).toBeUndefined()
      } finally {
        ro.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
