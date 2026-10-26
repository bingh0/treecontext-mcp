/**
 * The mature journal (D266), for the charter suite: a thin wrapper over the
 * shared builder in bench/fixtures/mature-journal/, which the bench arm
 * reads too (bench/arms/mature-journal.ts). The builder holds the shape,
 * the vocabularies, the session script, the capture-pipeline build (real
 * hook subprocesses, the real MCP server, the production drain) and the
 * honest-time rewrite; this file runs it with the suite's one spawn recipe
 * and sandbox env, asserts what the scenarios rely on, and hands each
 * scenario a private copy of the per-process template.
 */
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { expect } from 'vitest'
import { openNodeSqlite } from '../../src/persistence/node-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { roleWeightVector } from '../../src/persistence/fts.js'
import { type MatureJournal, matureTemplate } from '../../bench/fixtures/mature-journal/index.js'
import type { CaptureWorld } from '../journal/capture-harness.js'
import { tsxArgv } from '../journal/proc.js'
import { sandboxedSpawnEnv } from './cli-spawn.js'

export { MATURE, ORIENTATION_QUERY, OLD_THREAD, FRESH_PLAN, SHELL_ONLY_TERM, type MatureJournal } from '../../bench/fixtures/mature-journal/index.js'

/**
 * Seed the mature journal into `w`: a private copy of the per-process
 * template at `w.dbPath` (under a fresh `w.dir`), opened as `w.store`.
 */
export async function seedMatureJournal(w: { defer: CaptureWorld['defer']; dir?: string; dbPath?: string; store?: FlatStore }): Promise<MatureJournal> {
  const dir = mkdtempSync(join(tmpdir(), 'tc-mature-'))
  w.defer(() => rmSync(dir, { recursive: true, force: true }))
  w.dir = dir
  w.dbPath = join(dir, 'journal.db')
  const journal = await copyMatureJournalTo(w.dbPath)
  const store = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(w.dbPath)), ownsDatabase: true })
  w.defer(() => store.close())
  w.store = store
  return journal
}

/**
 * Copy the per-process mature-journal template to `dbPath` (its directory
 * must exist), asserting what every scenario relies on. For a scenario
 * that needs the journal at a path of its own choosing, such as the store
 * path a capture sandbox derives, where the real hooks write.
 */
export async function copyMatureJournalTo(dbPath: string): Promise<MatureJournal> {
  const { file, journal } = await matureTemplate({
    hookArgv: (script) => tsxArgv(script),
    hookEnv: (home) => sandboxedSpawnEnv(home, { TREECONTEXT_BINDINGS_FILE: join(home, '.treecontext', 'bindings.json') }),
  })
  expect(journal.oldThreadId, 'the old thread was not captured').not.toBe('')
  expect(journal.freshPlanId, 'the fresh plan was not inserted').not.toBe('')
  expect(journal.shellOnlyId, 'exactly one shell event carries the shell-only term').not.toBe('')
  copyFileSync(file, dbPath)
  return journal
}

/**
 * Raw ranking evidence (verification rule): every row matching any of
 * `words` (the OR match search builds), scored by weighted bm25 at the
 * default role weights straight from SQLite, and how many of them score
 * better than `nodeId` would with its score multiplied by `factor` (the
 * retired bookmark factor of D262 was 0.25). Positive-oriented scores.
 */
export function rawOutranking(dbPath: string, words: string[], nodeId: string, factor = 1): { matching: number; better: number; score: number } {
  const raw = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const match = words.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')
    const rows = raw.prepare(
      'SELECT n.node_id AS id, -bm25(nodes_fts, ?, ?, ?, ?) AS s FROM nodes_fts JOIN nodes n ON n.rowid = nodes_fts.rowid WHERE nodes_fts MATCH ?',
    ).all(...roleWeightVector(), match) as Array<{ id: string; s: number }>
    const own = rows.find((r) => r.id === nodeId)
    expect(own, `${nodeId} does not match ${words.join(' ')}`).toBeTruthy()
    const score = own!.s * factor
    return { matching: rows.length, better: rows.filter((r) => r.id !== nodeId && r.s > score).length, score }
  } finally {
    raw.close()
  }
}

