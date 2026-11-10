/**
 * Doctor's "Project root" row names a binding an earlier build made for a
 * stub `.git`'s directory (D419; review A2). Before D419 a project below an
 * empty `.git` directory was bound to the stub's directory; this build binds
 * it to the project's own. The earlier binding and its store are left as
 * they were: doctor names the store and the command that merges it, and
 * moves nothing.
 *
 * The bindings are made by the real resolver in subprocesses under a
 * sandboxed home (the earlier one by resolving the stub's directory, which
 * is the identity an earlier build derived for the project), and doctor is
 * the real CLI run from the project.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sandboxedSpawnEnv, spawnCli } from '../helpers/cli-spawn.js'
import { TS_ROOT, tsxArgv } from '../journal/proc.js'

function resolveIn(home: string, dir: string): string {
  const r = spawnSync(process.execPath, tsxArgv(join(TS_ROOT, 'tests', 'helpers', 'resolve-driver.ts'), dir), {
    env: sandboxedSpawnEnv(home), cwd: TS_ROOT, encoding: 'utf8', timeout: 30_000,
  })
  expect(r.status, r.stderr).toBe(0)
  return (JSON.parse(r.stdout) as { storeName: string }).storeName
}
const projectRootRow = (out: string): string => {
  const row = out.split('\n').find((l) => l.includes('Project root'))
  expect(row, out).toBeDefined()
  return row!
}

describe('doctor names an earlier binding to a stub .git\'s directory (D419; review A2)', () => {
  it('names the old store, says it is left as it was, and gives the merge command, moving nothing', () => {
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-doctor-root-')))
    try {
      const home = join(base, 'home')
      const holder = join(base, 'holder')
      const project = join(holder, 'project')
      mkdirSync(home)
      mkdirSync(join(holder, '.git'), { recursive: true })
      mkdirSync(project)
      // The earlier build's binding: the stub's directory as the root.
      const old = resolveIn(home, holder)
      // This build's binding, from the project.
      const now = resolveIn(home, project)
      expect(now).not.toBe(old)
      const bindingsFile = join(home, '.treecontext', 'bindings.json')
      const before = readFileSync(bindingsFile, 'utf8')

      const run = spawnCli(['doctor'], { home, cwd: project })
      const row = projectRootRow(run.out)
      expect(row).toContain(`follow ${project} (no repository: keyed by this directory itself)`)
      expect(row).toContain(`${join(holder, '.git')} ignored because it is no repository`)
      expect(row).toContain(`an earlier treecontext bound this project to ${holder}, taking its .git for a root, in store "${old}", which is left as it was`)
      expect(row).toContain(`treecontext stores merge ${old} ${now}`)
      // Nothing moved: the bindings are as they were, and no merge ran.
      expect(readFileSync(bindingsFile, 'utf8')).toBe(before)
      expect(existsSync(join(home, '.treecontext', 'stores', old))).toBe(false)

      // The command doctor names is one the CLI's own parser takes: asked
      // with no stores on disk, it fails on the store, never on its usage.
      const merge = spawnCli(['stores', 'merge', old, now], { home, cwd: project })
      expect(merge.out).not.toMatch(/requires a source and a destination|Unknown|usage/i)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }, 120_000)

  // A binding minted while the realpath ladder was degraded is keyed by the
  // spelling the directory was reached by (docs/project-identity.md §3.5),
  // here a symlinked ancestor. A child process's cwd is always the
  // physical path, so this case reads the report through the library with
  // the lexical directory, as a hook's payload cwd carries it; the binding
  // is written in the file's own format under that spelling, which the
  // resolver itself no longer mints.
  it.skipIf(process.platform === 'win32')('finds an earlier binding keyed by another spelling of the stub\'s directory, through a symlink (F4)', async () => {
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-doctor-root-')))
    const prior = process.env['TREECONTEXT_BINDINGS_FILE']
    try {
      const realHolder = join(base, 'real-holder')
      mkdirSync(join(realHolder, '.git'), { recursive: true })
      mkdirSync(join(realHolder, 'project'))
      const link = join(base, 'link-holder')
      symlinkSync(realHolder, link)
      const file = join(base, 'bindings.json')
      const fp = createHash('sha256').update(`path:${link}`).digest('hex').slice(0, 16)
      writeFileSync(file, JSON.stringify({ version: 1, projects: { [fp]: { store: 'holder-legacy', updatedAt: Date.now(), source: 'path' } } }))
      process.env['TREECONTEXT_BINDINGS_FILE'] = file
      const { projectRootReport } = await import('../../src/server/bindings.js')
      const report = projectRootReport(join(link, 'project'))
      expect(report.passedOver).toEqual([join(realHolder, '.git')])
      expect(report.priorBindings).toEqual([{ dir: realHolder, store: 'holder-legacy' }])
    } finally {
      if (prior === undefined) delete process.env['TREECONTEXT_BINDINGS_FILE']
      else process.env['TREECONTEXT_BINDINGS_FILE'] = prior
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('says nothing of an earlier binding where none was made', () => {
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-doctor-root-')))
    try {
      const home = join(base, 'home')
      const project = join(base, 'holder', 'project')
      mkdirSync(home)
      mkdirSync(join(base, 'holder', '.git'), { recursive: true })
      mkdirSync(project, { recursive: true })
      resolveIn(home, project)
      const row = projectRootRow(spawnCli(['doctor'], { home, cwd: project }).out)
      expect(row).toContain('ignored because it is no repository')
      expect(row).not.toContain('an earlier treecontext bound')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }, 120_000)
})
