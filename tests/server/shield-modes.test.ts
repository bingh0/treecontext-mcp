/**
 * Shielding lockdown modes (ruling 2026-08-15) — POSIX-only, pinned
 * beside the output-shielding.feature scenarios (now bound in
 * tests/steps/output-shielding.steps.ts). This block is deliberately
 * NOT a feature scenario: it asserts filesystem permission bits, which
 * Windows has none of — itPosix keeps the skip visible instead of
 * green-washing it.
 */
import { mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect } from 'vitest'

import { defaultShieldConfig, shieldResponse } from '../../src/server/shielding.js'
import { itPosix } from '../helpers/platform.js'

const BIG = `the shielded haystack sentinel ${'x'.repeat(4096)}`

itPosix('shield files are 0600 inside a 0700 directory', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tc-shield-modes-'))
  // A permissive umask, or the assertion proves nothing: under 077 the
  // default create mode is already 0600 and a dropped explicit mode
  // survives the check on umask luck (mutation protocol, 2026-08-15).
  const prevUmask = process.umask(0o022)
  try {
    const dir = join(tmp, 'shield')
    const config = defaultShieldConfig({ thresholdBytes: 8, shieldDir: dir })
    const res = shieldResponse('treecontext_query', BIG, config)
    expect(res.shielded).toBe(true)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    const files = readdirSync(dir)
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600)
    }
  } finally {
    process.umask(prevUmask)
    rmSync(tmp, { recursive: true, force: true })
  }
})
