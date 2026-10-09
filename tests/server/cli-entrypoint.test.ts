/**
 * Entrypoint-guard regression (beta-1 field report).
 *
 * `npm install -g` puts a symlink on PATH pointing at the package's real
 * cli.js. Node leaves argv[1] as the symlink but realpath-resolves the ESM
 * module URL, so a resolve()-only comparison decides "not the entrypoint",
 * main() never runs, and every `treecontext <cmd>` prints nothing and exits 0.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isEntrypoint } from '../../src/server/cli.js'
import { describePosix } from '../helpers/platform.js'

const dir = mkdtempSync(join(tmpdir(), 'tc-entry-'))
const realDir = join(dir, 'lib', 'dist', 'server')
const binDir = join(dir, 'bin')
mkdirSync(realDir, { recursive: true })
mkdirSync(binDir, { recursive: true })

const realCli = join(realDir, 'cli.js')
writeFileSync(realCli, '// stand-in for the installed cli.js\n')

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('isEntrypoint', () => {
  it('matches when argv[1] is the module path itself', () => {
    expect(isEntrypoint(realCli, realCli)).toBe(true)
  })

  it('rejects an unrelated entry (imported as a module)', () => {
    expect(isEntrypoint(join(realDir, 'other.js'), realCli)).toBe(false)
  })

  it('rejects a missing argv[1]', () => {
    expect(isEntrypoint(undefined, realCli)).toBe(false)
  })

  it('matches relative and absolute spellings of the same file', () => {
    expect(isEntrypoint(join(realDir, '..', 'server', 'cli.js'), realCli)).toBe(true)
  })

  it('still compares unresolvable paths by resolved form', () => {
    const ghost = join(dir, 'deleted', 'cli.js')
    expect(isEntrypoint(ghost, ghost)).toBe(true)
  })
})

describePosix('isEntrypoint through an npm global-bin symlink', () => {
  const binLink = join(binDir, 'treecontext')
  symlinkSync(realCli, binLink)

  it('matches the symlink on PATH against the real module path', () => {
    // The exact shape of a global install: argv[1] is ~/.local/bin/treecontext,
    // import.meta.url is .../lib/node_modules/treecontext/dist/server/cli.js.
    expect(isEntrypoint(binLink, realCli)).toBe(true)
  })

  it('matches through a symlinked parent directory too', () => {
    const dirLink = join(dir, 'linked-server')
    symlinkSync(realDir, dirLink)
    expect(isEntrypoint(join(dirLink, 'cli.js'), realCli)).toBe(true)
  })
})
