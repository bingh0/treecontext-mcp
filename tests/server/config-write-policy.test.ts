/**
 * Config write-failure policy and file modes (F review 2026-08-15) —
 * POSIX/self-contained pins beside the config-file.feature scenarios
 * (now bound in tests/steps/config-file.steps.ts). These are not
 * feature scenarios: they stage filesystem-failure worlds with chmod
 * and assert byte survival. Each unit owns its sandboxed home via a
 * scoped redirect (installGlobalConfig resolves homedir() per call),
 * self-restoring, independent of scenario lifecycle.
 */
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, chmodSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { it, expect } from 'vitest'

import { redirectHome } from '../helpers/home.js'
import { itPosix, describePosix } from '../helpers/platform.js'

import { installGlobalConfig } from '../../src/server/installer.js'

itPosix('a failed update write on a VALID config propagates and side-files nothing', () => {
  // The corrupt-file handler must never catch an ENOSPC/EACCES from the
  // update path: that renamed a healthy config to .corrupt and replaced
  // it with the template.
  const home = mkdtempSync(join(tmpdir(), 'tc-config-wf-'))
  const restore = redirectHome(home)
  const gDir = join(home, '.treecontext')
  const gCfg = join(gDir, 'config.toml')
  try {
    mkdirSync(gDir, { recursive: true })
    const original = '[server]\nsidecar = false\n'
    writeFileSync(gCfg, original)
    chmodSync(gDir, 0o500)
    try {
      expect(() => installGlobalConfig(false)).toThrow()
    } finally {
      chmodSync(gDir, 0o700)
    }
    expect(readFileSync(gCfg, 'utf8')).toBe(original)
    expect(existsSync(`${gCfg}.corrupt`)).toBe(false)
  } finally {
    restore()
    rmSync(home, { recursive: true, force: true })
  }
})

itPosix('a corrupt config whose side-file rename fails is left untouched', () => {
  // Same policy as persistBindings: no side-file, no overwrite — the
  // unparseable bytes are still the user's only copy.
  const home = mkdtempSync(join(tmpdir(), 'tc-config-wf2-'))
  const restore = redirectHome(home)
  const gDir = join(home, '.treecontext')
  const gCfg = join(gDir, 'config.toml')
  try {
    mkdirSync(gDir, { recursive: true })
    writeFileSync(gCfg, '[server\ncapture = maybe')
    chmodSync(gDir, 0o500)
    let result: ReturnType<typeof installGlobalConfig>
    try {
      result = installGlobalConfig(false)
    } finally {
      chmodSync(gDir, 0o700)
    }
    expect(result!.status).toBe('skipped')
    expect(result!.detail).toMatch(/side-filed|left untouched/)
    expect(readFileSync(gCfg, 'utf8')).toBe('[server\ncapture = maybe')
    expect(existsSync(`${gCfg}.corrupt`)).toBe(false)
  } finally {
    restore()
    rmSync(home, { recursive: true, force: true })
  }
})

describePosix('config.toml lands private by mode (docs/security.md §3)', () => {
  it('created and updated files are 0600 on create, never umask-default', () => {
    const home = mkdtempSync(join(tmpdir(), 'tc-config-mode-'))
    const restore = redirectHome(home)
    const gDir = join(home, '.treecontext')
    const gCfg = join(gDir, 'config.toml')
    try {
      expect(installGlobalConfig(false).status).toBe('created')
      expect(statSync(gCfg).mode & 0o777).toBe(0o600)
      // The update path rewrites through tmp+rename — a pre-existing
      // group-shareable file is tightened by the rewrite.
      writeFileSync(gCfg, '[server]\nsidecar = false\n', { mode: 0o644 })
      expect(installGlobalConfig(false).status).toBe('updated')
      expect(statSync(gCfg).mode & 0o777).toBe(0o600)
      expect(readFileSync(gCfg, 'utf8')).toMatch(/sidecar = false/)
    } finally {
      restore()
      rmSync(home, { recursive: true, force: true })
    }
  })
})
