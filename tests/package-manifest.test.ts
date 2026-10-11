/**
 * The package manifest's `bin` (D266 ride-along): the path is written
 * without a leading `./`, the manifest convention (npm normalises either),
 * and it names a file the published tarball carries — the build output of
 * a source file that exists, matched by the `files` list.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  bin: Record<string, string>
  files: string[]
}

/** The two glob shapes the `files` list uses: `dir/**\/*.ext` and a plain name. */
function carriedBy(files: string[], path: string): boolean {
  return files.some((f) => {
    const m = /^(.+)\/\*\*\/\*(\.[\w.]+)$/.exec(f)
    if (m) return path.startsWith(`${m[1]}/`) && path.endsWith(m[2]!)
    return f === path
  })
}

describe('package.json bin', () => {
  it('names the treecontext command', () => {
    expect(Object.keys(pkg.bin)).toEqual(['treecontext'])
  })

  for (const [name, path] of Object.entries(pkg.bin)) {
    it(`${name}: no leading ./, carried by the files list, built from a source that exists`, () => {
      expect(path.startsWith('./')).toBe(false)
      expect(path.startsWith('/')).toBe(false)
      expect(carriedBy(pkg.files, path), `${path} is not in the files list ${JSON.stringify(pkg.files)}`).toBe(true)
      const source = path.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts')
      expect(existsSync(join(ROOT, source)), source).toBe(true)
    })
  }
})
