/**
 * The shape a `.git` must have before treecontext's own look upward takes
 * it for a repository (D419; review N1, N2 and the minor items): real
 * trees on disk, resolved by the production `projectRootFor` (which asks
 * real git first). Each stub sits in the directory above a project with no
 * repository, where git itself names none, so the walk alone decides.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { holdsRepository, projectRootFor } from '../../src/server/bindings.js'

const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-root-shape-')))
afterAll(() => rmSync(base, { recursive: true, force: true }))
const gitEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))
const gitNames = (cwd: string): string | null => {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() } catch { return null }
}

/** A holder directory with `plant` applied to its `.git`, and a project
 *  below it; returns both. */
function tree(name: string, plant: (gitPath: string, holder: string) => void): { holder: string; project: string } {
  const holder = join(base, name)
  const project = join(holder, 'project')
  mkdirSync(project, { recursive: true })
  plant(join(holder, '.git'), holder)
  return { holder, project }
}

describe('a .git is a repository only in the shape git accepts (D419)', () => {
  it('a gitfile whose gitdir names nothing is no repository (N1)', () => {
    const { project } = tree('dangling', (g) => writeFileSync(g, 'gitdir: /nonexistent/elsewhere/.git\n'))
    expect(gitNames(project)).toBeNull()
    expect(projectRootFor(project)).toBe(project)
  })

  it('a gitfile whose gitdir names an empty directory is no repository (N1)', () => {
    const { project } = tree('names-empty', (g, holder) => {
      mkdirSync(join(holder, 'empty-gitdir'))
      writeFileSync(g, 'gitdir: empty-gitdir\n')
    })
    expect(gitNames(project)).toBeNull()
    expect(projectRootFor(project)).toBe(project)
  })

  it('a .git directory with a HEAD and files but no objects or refs is no repository (N2)', () => {
    const { project } = tree('no-objects', (g) => {
      mkdirSync(g)
      writeFileSync(join(g, 'HEAD'), 'ref: refs/heads/main\n')
      writeFileSync(join(g, 'config'), '[core]\n\trepositoryformatversion = 0\n')
      mkdirSync(join(g, 'hooks'))
    })
    expect(gitNames(project)).toBeNull()
    expect(projectRootFor(project)).toBe(project)
  })

  it('a .git directory with objects and refs but no valid HEAD is no repository (N2)', () => {
    const { project } = tree('bad-head', (g) => {
      mkdirSync(join(g, 'objects'), { recursive: true })
      mkdirSync(join(g, 'refs'))
      writeFileSync(join(g, 'HEAD'), 'not a ref\n')
    })
    expect(gitNames(project)).toBeNull()
    expect(projectRootFor(project)).toBe(project)
  })

  it('a repository whose HEAD reads `ref:refs/...` with no space is found above a .git file git cannot read', () => {
    const repo = join(base, 'nospace')
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: gitEnv() })
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref:refs/heads/main\n')
    // git itself accepts that HEAD.
    expect(gitNames(repo)).toBe(repo)
    const project = join(repo, 'mid', 'project')
    mkdirSync(project, { recursive: true })
    writeFileSync(join(repo, 'mid', '.git'), 'junk\n')
    expect(gitNames(project)).toBeNull()
    expect(projectRootFor(project)).toBe(repo)
  })

  it.skipIf(process.platform === 'win32')('a gitfile that is a device or a FIFO is never read without bound', () => {
    const { project: p2 } = tree('gitfile-zero', (g) => symlinkSync('/dev/zero', g))
    const { project: p3 } = tree('gitfile-fifo', (g) => execFileSync('mkfifo', [g]))
    const t0 = Date.now()
    for (const p of [p2, p3]) expect(projectRootFor(p)).toBe(p)
    expect(Date.now() - t0).toBeLessThan(10_000)
  }, 30_000)

  // Git itself reads `commondir` without bound (a `commondir` symlinked to
  // /dev/zero ran `git rev-parse` until it was killed, 2026-11-10), so this
  // case is graded on the shape check alone, not through projectRootFor.
  it.skipIf(process.platform === 'win32')('a commondir that is a device is never read without bound by the shape check', () => {
    const { holder } = tree('commondir-zero', (g) => {
      mkdirSync(join(g, 'objects'), { recursive: true })
      mkdirSync(join(g, 'refs'))
      writeFileSync(join(g, 'HEAD'), 'ref: refs/heads/main\n')
      symlinkSync('/dev/zero', join(g, 'commondir'))
    })
    const t0 = Date.now()
    expect(holdsRepository(holder)).toBe(false)
    expect(Date.now() - t0).toBeLessThan(2_000)
  }, 30_000)
})
