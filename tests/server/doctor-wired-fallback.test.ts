/**
 * The `Wired build` row when the launcher's pin is gone.
 *
 * Lives in its own file because where the launcher's fallback search lands
 * is a function of HOME (the nvm/fnm roots under it), so HOME must be
 * redirected BEFORE the installer module graph is imported — the same
 * file-level isolation doctor-interpreter.test.ts uses. The developer's
 * real machine has a global treecontext under ~/.nvm; graded against that
 * home, "nowhere to land" could never be observed.
 *
 * The case itself is the one the first cut went silent on (adversarial
 * review, finding 1): a version-manager upgrade deletes the pinned
 * checkout, a global install survives in a managed layout, the launcher's
 * own `for _c in …` loop lands on it, and the agent runs THAT build while
 * doctor reported nothing.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { redirectHome } from '../helpers/home.js'

const fakeHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-wired-fallback-')))
const restoreHome = redirectHome(fakeHome)

const { wiredBuildRow, moduleFallbackTarget, resetManagedLayoutScan, mcpLauncherScriptContent, hookScriptContent } = await import('../../src/server/installer.js')

afterAll(() => {
  restoreHome()
  rmSync(fakeHome, { recursive: true, force: true })
})

function stubPackage(root: string, version: string, name = 'treecontext'): string {
  mkdirSync(join(root, 'dist', 'server'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name, version }))
  const cli = join(root, 'dist', 'server', 'cli.js')
  writeFileSync(cli, '// stub\n')
  return cli
}

const selfCli = stubPackage(join(fakeHome, 'self'), '0.1.0-rc.7')
const gone = join(fakeHome, 'deleted-checkout', 'dist', 'server', 'cli.js')
// The POSIX launcher's shape as every release before the rename wrote it: a
// pin, then the fallback loop over the managed globs under the OLD package
// directory only — which is where `moduleFallbackTarget` reads the
// package-relative module path from. Wrappers of this shape are on disk
// until their owners re-run `install`, so it stays a fixture.
const posixBody = (pin: string): string => [
  '#!/bin/sh',
  'TC_NODE="/usr/bin/node"',
  `TC_CLI="${pin}"`,
  `if [ ! -f "$TC_CLI" ]; then for _c in /opt/homebrew/lib/node_modules/treecontext/dist/server/cli.js /usr/local/lib/node_modules/treecontext/dist/server/cli.js "$HOME"/.fnm/node-versions/*/installation/lib/node_modules/treecontext/dist/server/cli.js "$HOME"/.nvm/versions/node/*/lib/node_modules/treecontext/dist/server/cli.js; do [ -f "$_c" ] && TC_CLI="$_c"; done; fi`,
  'exec "$TC_NODE" "$TC_CLI" "$@"',
  '',
].join('\n')

describe.skipIf(process.platform === 'win32')('doctor: Wired build when the pin is gone', () => {
  it('is silent when the search lands nowhere — that death is the existence grader\'s to report', () => {
    resetManagedLayoutScan()
    expect(moduleFallbackTarget(posixBody(gone))).toBeNull()
    expect(wiredBuildRow(posixBody(gone), selfCli, 'treecontext')).toBeNull()
  })

  it('names the build the search lands on, and says the pin is gone', () => {
    const survivor = join(fakeHome, '.nvm', 'versions', 'node', 'v1.0.0', 'lib', 'node_modules', 'treecontext')
    const survivorCli = stubPackage(survivor, '7.7.7-fallback')
    resetManagedLayoutScan()
    expect(moduleFallbackTarget(posixBody(gone))).toBe(survivorCli)
    const row = wiredBuildRow(posixBody(gone), selfCli, `node "${selfCli}"`)
    expect(row?.status).toBe('warn')
    expect(row?.detail).toContain(`runs treecontext v7.7.7-fallback at ${survivor}`)
    expect(row?.detail).toContain(`the pinned ${gone} is gone`)
    expect(row?.detail).toContain(`lands on ${survivorCli}`)
    expect(row?.fix).toContain(`node "${selfCli}" install --force`)
  })

  it('mirrors the launcher: within the globs the LAST match wins', () => {
    // Two nvm versions both holding a copy: the shell loop assigns in glob
    // order and keeps the last, so v2 (lexically after v1) is the winner.
    const later = stubPackage(join(fakeHome, '.nvm', 'versions', 'node', 'v2.0.0', 'lib', 'node_modules', 'treecontext'), '8.8.8')
    resetManagedLayoutScan()
    expect(moduleFallbackTarget(posixBody(gone))).toBe(later)
  })

  it('grades a pin gone inside this build by where the search lands, not by the pin\'s root', () => {
    const row = wiredBuildRow(posixBody(join(fakeHome, 'self', 'dist', 'server', 'removed.js')), selfCli, 'treecontext')
    // The pin is a missing file inside THIS build's root; the search lands
    // on nvm v2 — a different build — so this is a warn, and the assertion
    // that matters is on the message: it must name where it landed.
    expect(row?.status).toBe('warn')
    expect(row?.detail).toContain('v8.8.8')
  })
})

// The launcher this build writes, pin swapped for a dead one: the search
// names `treecontext-mcp` (the published package) and `treecontext` (every
// release candidate before it), current name preferred.
const currentBody = (pin: string): string => {
  const body = mcpLauncherScriptContent()
  expect(body, 'the launcher pin changed shape — this fixture no longer applies').toMatch(/^TC_CLI="/m)
  return body.replace(/^TC_CLI="[^"]*"/m, `TC_CLI="${pin}"`)
}
const nvmPackage = (version: string, dir: string): string =>
  join(fakeHome, '.nvm', 'versions', 'node', version, 'lib', 'node_modules', dir)

describe.skipIf(process.platform === 'win32')('doctor: Wired build across the package rename', () => {
  it('a current launcher lands on a surviving treecontext-mcp copy, and an old launcher does not', () => {
    rmSync(join(fakeHome, '.nvm'), { recursive: true, force: true })
    const survivor = nvmPackage('v1.5.0', 'treecontext-mcp')
    const survivorCli = stubPackage(survivor, '0.1.0-beta.1', 'treecontext-mcp')
    resetManagedLayoutScan()
    expect(moduleFallbackTarget(currentBody(gone))).toBe(survivorCli)
    const row = wiredBuildRow(currentBody(gone), selfCli, `node "${selfCli}"`)
    expect(row?.detail).toContain(`runs treecontext-mcp v0.1.0-beta.1 at ${survivor}`)
    // The pre-rename wrapper's own shell loop names only `treecontext`: it
    // cannot reach this copy, so neither may the probe that mirrors it.
    expect(moduleFallbackTarget(posixBody(gone))).toBeNull()
  })

  it('the current name wins over a legacy copy, whatever the version order', () => {
    // v9.0.0 sorts after v1.5.0, so on version order alone the legacy copy
    // would be the last match; the package name is the outer key.
    const legacyCli = stubPackage(nvmPackage('v9.0.0', 'treecontext'), '0.1.0-rc.7')
    resetManagedLayoutScan()
    expect(moduleFallbackTarget(currentBody(gone))).toBe(join(nvmPackage('v1.5.0', 'treecontext-mcp'), 'dist', 'server', 'cli.js'))
    expect(moduleFallbackTarget(posixBody(gone))).toBe(legacyCli)
  })

  it('an old install under the legacy name still resolves from a current launcher', () => {
    rmSync(nvmPackage('v1.5.0', 'treecontext-mcp'), { recursive: true, force: true })
    resetManagedLayoutScan()
    expect(moduleFallbackTarget(currentBody(gone))).toBe(join(nvmPackage('v9.0.0', 'treecontext'), 'dist', 'server', 'cli.js'))
  })

  it('reads a search that names only treecontext-mcp', () => {
    // The module path is read from whichever package name the search
    // names; a body whose loop has dropped the legacy name must still be
    // read, not left "not judged".
    const onlyCurrent = posixBody(gone).replaceAll('node_modules/treecontext/', 'node_modules/treecontext-mcp/')
    const cli = stubPackage(nvmPackage('v3.0.0', 'treecontext-mcp'), '0.1.0-beta.1', 'treecontext-mcp')
    resetManagedLayoutScan()
    expect(moduleFallbackTarget(onlyCurrent)).toBe(cli)
    rmSync(nvmPackage('v3.0.0', 'treecontext-mcp'), { recursive: true, force: true })
  })

  it('with neither name anywhere the search lands nowhere', () => {
    rmSync(join(fakeHome, '.nvm'), { recursive: true, force: true })
    resetManagedLayoutScan()
    expect(moduleFallbackTarget(currentBody(gone))).toBeNull()
    expect(wiredBuildRow(currentBody(gone), selfCli, 'treecontext')).toBeNull()
  })
})

// The batch dialect, generated and graded on any host. Generation reads
// process.platform, so it is stubbed for the call; the batch branch of
// moduleFallbackTarget keys on the body (`@echo off`) and the env var that
// locates each prefix, so APPDATA is pointed at a sandbox.
describe('the batch dialect across the package rename', () => {
  function asWin32<T>(fn: () => T): T {
    const real = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...real, value: 'win32' })
    try { return fn() } finally { Object.defineProperty(process, 'platform', real) }
  }
  const probes = (body: string): string[] =>
    body.split('\r\n').filter(l => l.startsWith('if not exist "%TC_CLI%"'))

  it.each([
    ['the MCP launcher', () => mcpLauncherScriptContent()],
    ['a capture hook', () => hookScriptContent('post-tool-use')],
  ])('%s probes treecontext-mcp under both prefixes before treecontext', (_what, gen) => {
    const body = asWin32(gen)
    expect(body.startsWith('@echo off')).toBe(true)
    // First existing probe wins in batch, so table order IS preference order.
    expect(probes(body)).toEqual([
      'if not exist "%TC_CLI%" set "TC_CLI=%APPDATA%\\npm\\node_modules\\treecontext-mcp\\dist\\server\\cli.js"',
      'if not exist "%TC_CLI%" set "TC_CLI=%ProgramFiles%\\nodejs\\node_modules\\treecontext-mcp\\dist\\server\\cli.js"',
      'if not exist "%TC_CLI%" set "TC_CLI=%APPDATA%\\npm\\node_modules\\treecontext\\dist\\server\\cli.js"',
      'if not exist "%TC_CLI%" set "TC_CLI=%ProgramFiles%\\nodejs\\node_modules\\treecontext\\dist\\server\\cli.js"',
    ])
  })

  it('moduleFallbackTarget mirrors the batch probes: treecontext-mcp first, legacy still found', () => {
    // The sanctioned redirect (tests/helpers/home.ts) points APPDATA under
    // a sandbox home; restoring it puts back the file-level redirect.
    const home = mkdtempSync(join(tmpdir(), 'tc-appdata-'))
    const restoreHome = redirectHome(home)
    const appdata = join(home, 'AppData', 'Roaming')
    const realProgramFiles = process.env['ProgramFiles']
    delete process.env['ProgramFiles']
    try {
      const body = asWin32(() => mcpLauncherScriptContent()).replace(/^set "TC_CLI=[^"]*"/m, 'set "TC_CLI=C:\\gone\\dist\\server\\cli.js"')
      const at = (name: string): string => join(appdata, 'npm', 'node_modules', name, 'dist', 'server', 'cli.js')
      for (const name of ['treecontext', 'treecontext-mcp']) {
        mkdirSync(join(appdata, 'npm', 'node_modules', name, 'dist', 'server'), { recursive: true })
        writeFileSync(at(name), '// stub\n')
      }
      expect(moduleFallbackTarget(body)).toBe(at('treecontext-mcp'))
      rmSync(join(appdata, 'npm', 'node_modules', 'treecontext-mcp'), { recursive: true, force: true })
      expect(moduleFallbackTarget(body)).toBe(at('treecontext'))
      rmSync(join(appdata, 'npm', 'node_modules', 'treecontext'), { recursive: true, force: true })
      expect(moduleFallbackTarget(body)).toBeNull()
    } finally {
      restoreHome()
      if (realProgramFiles !== undefined) process.env['ProgramFiles'] = realProgramFiles
      rmSync(home, { recursive: true, force: true })
    }
  })
})
