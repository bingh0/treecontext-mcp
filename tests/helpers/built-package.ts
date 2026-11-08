/**
 * This build, compiled and laid out as a package, for a test that runs the
 * real launcher or hook wrapper install wrote.
 *
 * Under the suite the installer runs from source, so the launcher and hook
 * wrappers pin `src/server/cli.js`, which exists only as its `.ts` twin. The
 * wrappers then search the layouts a global install lands in, under the
 * HOME they run with (the nvm version directories on POSIX, %APPDATA%\npm
 * on Windows). `placeBuiltPackage` puts this build there, inside the
 * sandbox home, so the wrapper itself resolves and runs it: nothing of the
 * wrapper's dispatch is re-implemented by the test, and a wrapper that adds
 * or alters a flag is what runs.
 *
 * The package is compiled once per test process into the OS temp directory
 * (tsc with the build config, the manifest copied, node_modules linked to
 * this checkout's), so a stale `dist/` in the checkout can never stand in
 * for this build.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { sandboxedSpawnEnv } from './cli-spawn.js'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
let built: string | null = null

/** The compiled package root (holding dist/, package.json, node_modules). */
export function builtPackageRoot(): string {
  if (built) return built
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-built-pkg-')))
  const root = join(parent, 'treecontext-mcp')
  mkdirSync(root, { recursive: true })
  const tsc = join(dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc')
  const r = spawnSync(process.execPath, [tsc, '-p', join(REPO, 'tsconfig.build.json'), '--outDir', join(root, 'dist')], {
    cwd: REPO, encoding: 'utf8', timeout: 300_000,
  })
  if (r.status !== 0) throw new Error(`compiling this build failed:\n${r.stdout}\n${r.stderr}`)
  cpSync(join(REPO, 'package.json'), join(root, 'package.json'))
  symlinkSync(join(REPO, 'node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  process.once('exit', () => { try { rmSync(parent, { recursive: true, force: true }) } catch { /* best effort */ } })
  built = root
  return root
}

/**
 * This build placed where a global install lands under `home`, for the
 * wrappers install wrote there to find. Returns the function that takes it
 * away again.
 */
export function placeBuiltPackage(home: string): () => void {
  const root = builtPackageRoot()
  const dir = process.platform === 'win32'
    ? join(sandboxedSpawnEnv(home)['APPDATA']!, 'npm', 'node_modules')
    : join(home, '.nvm', 'versions', 'node', 'v0.0.0-this-build', 'lib', 'node_modules')
  mkdirSync(dir, { recursive: true })
  const link = join(dir, 'treecontext-mcp')
  if (!existsSync(link)) symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir')
  return () => {
    try { if (process.platform === 'win32') rmdirSync(link); else unlinkSync(link) } catch { /* already taken away */ }
  }
}
