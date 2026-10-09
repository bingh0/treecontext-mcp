/**
 * Bindings-machinery unit pins — functions, not scenarios. Relocated
 * byte-for-byte from the old store-bindings vitest-cucumber binding
 * when the feature converted to gnt (executor-migration Phase 2,
 * 2026-08-26; the stores-merge-internals precedent): these pins are
 * feature-independent library contracts, not steps of any scenario.
 *
 * TREECONTEXT_BINDINGS_FILE is the sanctioned sandbox seam — bindings.ts
 * reads it per call, so no import-order dance is needed.
 */
import {
  mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, chmodSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, describe, it } from 'vitest'

import { SAFE_STORE_RE } from '../../src/tools/store-name.js'
import { resolveStoreName, repointBindings, identityEnv } from '../../src/server/bindings.js'
import { itPosix } from '../helpers/platform.js'

// ── Read failure is not corruption (F review 2026-08-15) ─────────────
// EACCES on a healthy machine-wide bindings.json must never side-file
// or rewrite it: resolution continues unpersisted. POSIX-only — chmod
// carries no meaning on Windows, and root would bypass it anyway.

itPosix('an unreadable bindings file is neither side-filed nor rewritten', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-bindings-eacces-'))
  const bindingsPath = join(dir, 'bindings.json')
  const proj = join(dir, 'proj')
  mkdirSync(proj)
  const prev = process.env['TREECONTEXT_BINDINGS_FILE']
  process.env['TREECONTEXT_BINDINGS_FILE'] = bindingsPath
  try {
    const healthy = JSON.stringify({
      version: 1,
      projects: { feedfacecafef00d: { store: 'neighbor-store', updatedAt: 1, source: 'path' } },
    })
    writeFileSync(bindingsPath, healthy)
    chmodSync(bindingsPath, 0o000)

    const resolved = resolveStoreName(proj)
    expect(resolved.storeName).toMatch(SAFE_STORE_RE)

    chmodSync(bindingsPath, 0o600)
    expect(existsSync(`${bindingsPath}.corrupt`)).toBe(false)
    expect(readFileSync(bindingsPath, 'utf8')).toBe(healthy)
  } finally {
    if (prev === undefined) delete process.env['TREECONTEXT_BINDINGS_FILE']
    else process.env['TREECONTEXT_BINDINGS_FILE'] = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── repointBindings preserves and reports honestly (B3/B4) ───────────

describe('repointBindings', () => {
  let dir: string
  let bindingsPath: string
  let prev: string | undefined

  const use = (fn: () => void): void => {
    dir = mkdtempSync(join(tmpdir(), 'tc-repoint-'))
    bindingsPath = join(dir, 'bindings.json')
    prev = process.env['TREECONTEXT_BINDINGS_FILE']
    process.env['TREECONTEXT_BINDINGS_FILE'] = bindingsPath
    try { fn() } finally {
      if (prev === undefined) delete process.env['TREECONTEXT_BINDINGS_FILE']
      else process.env['TREECONTEXT_BINDINGS_FILE'] = prev
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('B3: a bystander entry with an unsafe store name survives the repoint', () => {
    use(() => {
      // The bystander's store name has a space — validProjects would DROP
      // it on read. The old repoint read through that filter and persisted
      // the filtered map, deleting the bystander for good. It must survive.
      const file = {
        version: 1,
        anUnknownTopLevelField: { keep: 'me' },
        projects: {
          aaaaaaaaaaaaaaaa: { store: 'src', updatedAt: 1, source: 'path' },
          bbbbbbbbbbbbbbbb: { store: 'has a space', updatedAt: 2, source: 'git', extra: 'field' },
        },
      }
      writeFileSync(bindingsPath, JSON.stringify(file, null, 2) + '\n')

      const res = repointBindings('src', 'dst')
      expect(res).toEqual({ changed: 1, persisted: true, health: 'ok' })

      const after = JSON.parse(readFileSync(bindingsPath, 'utf8')) as Record<string, any>
      // The target moved…
      expect(after.projects.aaaaaaaaaaaaaaaa.store).toBe('dst')
      // …the unsafe-named bystander is untouched, byte-for-byte…
      expect(after.projects.bbbbbbbbbbbbbbbb).toEqual({
        store: 'has a space', updatedAt: 2, source: 'git', extra: 'field',
      })
      // …and unknown top-level fields are preserved.
      expect(after.anUnknownTopLevelField).toEqual({ keep: 'me' })
      expect(after.version).toBe(1)
    })
  })

  it('B4: a corrupt bindings file warns and does not claim success', () => {
    use(() => {
      writeFileSync(bindingsPath, '{ these bytes are not JSON')
      const res = repointBindings('src', 'dst')
      // Distinct from "read ok, nothing matched": persisted is false and
      // the health names the failure, so the CLI can WARN rather than say
      // "no binding names src".
      expect(res.persisted).toBe(false)
      expect(res.changed).toBe(0)
      expect(res.health).toBe('corrupt')
      // The corrupt file is left exactly as it was — repoint never touched it.
      expect(readFileSync(bindingsPath, 'utf8')).toBe('{ these bytes are not JSON')
    })
  })

  it('an absent bindings file is nothing to repoint, not a failure', () => {
    use(() => {
      const res = repointBindings('src', 'dst')
      expect(res).toEqual({ changed: 0, persisted: true, health: 'absent' })
    })
  })
})

// ── M7: identity git runs must not suppress global/system config ─────

describe('identityEnv', () => {
  it('scrubs every GIT_* variable but leaves config scope alone (M7)', () => {
    const saved = { count: process.env['GIT_CONFIG_COUNT'], glob: process.env['GIT_CONFIG_GLOBAL'] }
    try {
      process.env['GIT_CONFIG_COUNT'] = '1'
      const env = identityEnv()
      // S2's carriers are all GIT_* env vars, and every one is removed.
      expect(env['GIT_CONFIG_COUNT']).toBeUndefined()
      // But global/system config is NOT pinned to /dev/null: doing so would
      // strip safe.directory and break rev-parse on a root-owned or
      // bind-mounted repo, degrading identity git→path and minting a fresh
      // store — the exact defect this program exists to kill.
      expect(env['GIT_CONFIG_GLOBAL']).toBeUndefined()
      expect(env['GIT_CONFIG_NOSYSTEM']).toBeUndefined()
    } finally {
      if (saved.count === undefined) delete process.env['GIT_CONFIG_COUNT']
      else process.env['GIT_CONFIG_COUNT'] = saved.count
      if (saved.glob === undefined) delete process.env['GIT_CONFIG_GLOBAL']
      else process.env['GIT_CONFIG_GLOBAL'] = saved.glob
    }
  })
})
