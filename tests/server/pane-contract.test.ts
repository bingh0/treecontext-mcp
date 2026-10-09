/**
 * Producer conformance against ccr's pane contract (v1).
 *
 * The contract (ccr `docs/PANE-CONTRACT.md`) says "producer suites
 * assert their output matches its shape" — and until 2026-08-15 this
 * suite didn't: the cross-product seam was verified only on ccr's
 * consumer side, and both 0.0.16-beta field reports about panes "not
 * registering" lived in that untested gap. This file closes the
 * producer half:
 *
 *   1. A v1 validator derived from the contract's written rules,
 *      proven against ccr's own canonical example
 *      (`pane-blob.golden.json`, copied verbatim from ccr@2026-08-15 —
 *      if ccr revs the golden, re-copy and this header's date moves).
 *   2. Every pane this producer writes — healthy from REAL FlatStore
 *      vitals, and the broken confession — validated by the same
 *      validator, from the bytes on disk, through the same read a
 *      consumer performs.
 *
 * Runs on every matrix OS: the write path (tmp + rename beside the
 * store) is exactly the platform-sensitive seam.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import BetterSqlite3 from 'better-sqlite3'

import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import {
  computeSidecarPanes,
  brokenSidecarPanes,
  writeSidecarPanes,
  sidecarPaths,
  PANE_VERSION,
  type PaneBlob,
  type PaneName,
} from '../../src/server/sidecar-blob.js'

const GOLDEN_PATH = fileURLToPath(new URL('./pane-blob.golden.json', import.meta.url))

// ── The v1 validator, transcribed from the contract's rules ──────────

const ROW_STATUSES = new Set(['ok', 'warn', 'alert', 'dark', 'off'])

/** Returns a list of contract violations; empty means conforming. */
function violationsOf(blob: unknown): string[] {
  const v: string[] = []
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) return ['blob is not an object']
  const b = blob as Record<string, unknown>

  if (b['v'] !== PANE_VERSION || !Number.isInteger(b['v'])) v.push(`v must be the integer ${PANE_VERSION}`)
  for (const key of ['tool', 'title'] as const) {
    if (typeof b[key] !== 'string' || !(b[key] as string).trim()) v.push(`${key} must be a non-empty string`)
  }
  if (b['status'] !== 'ok' && b['status'] !== 'broken') v.push('status must be "ok" | "broken"')

  const basis = b['basis'] as Record<string, unknown> | undefined
  if (!basis || typeof basis !== 'object') v.push('basis is required')
  else {
    if (typeof basis['label'] !== 'string' || !basis['label']) v.push('basis.label must be a non-empty string')
    if (typeof basis['at'] !== 'string' || !basis['at']) v.push('basis.at must be a non-empty string')
  }

  if (b['status'] === 'broken') {
    if (typeof b['message'] !== 'string' || !b['message'].trim()) v.push('broken requires a non-empty message')
  } else if (b['message'] != null && typeof b['message'] !== 'string') {
    v.push('message must be null/absent or a string')
  }

  if (!Array.isArray(b['rows'])) {
    v.push('rows must be an array')
    return v
  }
  if ((b['rows'] as unknown[]).length > 256) v.push('over 256 rows is the oversized state')
  for (const [i, r] of (b['rows'] as unknown[]).entries()) {
    if (!r || typeof r !== 'object') { v.push(`row ${i} is not an object`); continue }
    const row = r as Record<string, unknown>
    if (typeof row['label'] !== 'string') v.push(`row ${i}: label must be a string`)
    if (typeof row['value'] !== 'string') v.push(`row ${i}: value must be a JSON string (preformatted)`)
    if (!ROW_STATUSES.has(row['status'] as string)) v.push(`row ${i}: status outside the closed enum`)
    if (row['detail'] !== undefined && typeof row['detail'] !== 'string') v.push(`row ${i}: detail must be a string`)
    if (row['spark'] !== undefined) {
      const s = row['spark']
      if (!Array.isArray(s) || s.length > 32 || s.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
        v.push(`row ${i}: spark must be ≤32 finite numbers`)
      }
    }
    // Untrusted-string rule: no C0/C1 control bytes may survive to the file.
    for (const key of ['label', 'value', 'detail'] as const) {
      const s = row[key]
      // eslint-disable-next-line no-control-regex
      if (typeof s === 'string' && /[\u0000-\u001f\u007f-\u009f]/.test(s)) v.push(`row ${i}: ${key} carries control bytes`)
    }
  }
  return v
}

// ── 1. The validator agrees with ccr's canonical example ─────────────

describe('the v1 validator vs ccr’s golden blob', () => {
  it('the golden validates clean — validator and contract agree', () => {
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'))
    expect(violationsOf(golden)).toEqual([])
  })

  it('the validator is not vacuous — each rule family rejects', () => {
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'))
    const broken = (mutate: (g: Record<string, unknown>) => void): string[] => {
      const g = JSON.parse(JSON.stringify(golden))
      mutate(g)
      return violationsOf(g)
    }
    expect(broken((g) => { g['v'] = 2 })).not.toEqual([])
    expect(broken((g) => { g['status'] = 'fine' })).not.toEqual([])
    expect(broken((g) => { delete g['basis'] })).not.toEqual([])
    expect(broken((g) => { (g['rows'] as Array<Record<string, unknown>>)[0]!['value'] = 3 })).not.toEqual([])
    expect(broken((g) => { (g['rows'] as Array<Record<string, unknown>>)[0]!['status'] = 'red' })).not.toEqual([])
    expect(broken((g) => { g['status'] = 'broken'; g['message'] = '' })).not.toEqual([])
  })
})

// ── 2. Everything this producer writes conforms, from the disk up ────

describe('treecontext panes conform to pane-contract v1', () => {
  let dir: string
  let store: FlatStore
  let storePath: string

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tc-pane-contract-'))
    storePath = join(dir, 'treecontext.db')
    const db = wrapBetterSqlite(new BetterSqlite3(storePath))
    store = await FlatStore.open({ database: db, ownsDatabase: true })
    // Real content, including a hostile thread topic: the control bytes
    // must be gone from the bytes a consumer reads.
    await store.insert('a plain captured entry', {
      metadata: { source: 'auto-capture', role: 'tool', session_id: 'sess-1', tool_name: 'Bash' },
    })
    await store.insert('an open plan with a hostile topic', {
      metadata: { next_session: true, status: 'active', topic: 'evil\u001b]0;pwned\u0007topic\u0000here' },
    })
  })

  afterAll(async () => {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const readPane = (name: PaneName): unknown => {
    const paths = sidecarPaths(storePath)
    return JSON.parse(readFileSync(paths[name], 'utf8'))
  }

  it('healthy panes from real vitals validate, on disk, on this platform', () => {
    const at = Math.floor(Date.now() / 1000)
    writeSidecarPanes(storePath, computeSidecarPanes(store.vitals(at), 'contract-store'))
    for (const name of ['journal', 'threads', 'trail'] as PaneName[]) {
      const blob = readPane(name)
      expect(violationsOf(blob), `${name} pane`).toEqual([])
      // Size is a resource cap in the contract: over 256 KB is the
      // oversized state, and a producer should never come near it.
      expect(statSync(sidecarPaths(storePath)[name]).size).toBeLessThan(256 * 1024)
    }
  })

  it('a rewrite lands whole on this platform (the reader-facing atomicity seam)', () => {
    // Second write over existing files — the exact operation that
    // differs across platforms (rename-over-existing) and the one a
    // polling reader races.
    const at = Math.floor(Date.now() / 1000) + 60
    writeSidecarPanes(storePath, computeSidecarPanes(store.vitals(at), 'contract-store'))
    for (const name of ['journal', 'threads', 'trail'] as PaneName[]) {
      expect(violationsOf(readPane(name)), `${name} pane after rewrite`).toEqual([])
    }
  })

  it('the broken confession validates too', () => {
    const at = Math.floor(Date.now() / 1000)
    writeSidecarPanes(storePath, brokenSidecarPanes('the drain failed: disk full', at, 'contract-store'))
    for (const name of ['journal', 'threads', 'trail'] as PaneName[]) {
      const blob = readPane(name) as PaneBlob
      expect(violationsOf(blob), `${name} pane`).toEqual([])
      expect(blob.status).toBe('broken')
      expect(blob.rows).toEqual([])
    }
  })

  it('a hostile store name cannot put control bytes on a pane', () => {
    const at = Math.floor(Date.now() / 1000)
    const hostile = 'store\u001b[2J\u0007name'
    const panes = computeSidecarPanes(store.vitals(at), hostile)
    for (const name of ['journal', 'threads', 'trail'] as PaneName[]) {
      expect(violationsOf(panes[name]), `${name} pane`).toEqual([])
      // eslint-disable-next-line no-control-regex
      expect(panes[name].title).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
    }
  })
})
