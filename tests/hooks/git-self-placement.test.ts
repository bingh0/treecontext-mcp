/**
 * A session's placement and its store binding read one resolution (D419
 * read with D190 and D167; review A1). A linked worktree holding a `.git`
 * FILE git cannot read in a subdirectory: git, asked from below it, stops
 * there and names no repository. The binding then finds the repository
 * above it; the session-start hook must place the session in that same
 * worktree, never in the main checkout.
 *
 * Real git (`git init`, `git worktree add`), the real session-start hook
 * subprocess under a sandboxed home, and the registry read from SQLite.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { runHook } from '../journal/capture-harness.js'
import { type CaptureWorld } from '../journal/capture-harness.js'

const gitEnv = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
})
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const gitFails = (cwd: string): boolean => {
  try { git(cwd, 'rev-parse', '--show-toplevel'); return false } catch { return true }
}

describe('a session below a .git file git cannot read is placed where its store is bound (D419, D190; review A1)', () => {
  it.each([
    ['a linked worktree', 'wt'],
    ['the main checkout', 'main'],
  ])('in %s', (_where, which) => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-gitself-')))
    try {
      const home = join(root, 'home')
      mkdirSync(home)
      const repo = join(root, 'repo')
      execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: gitEnv() })
      git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
      const wt = join(root, 'wt')
      git(repo, 'worktree', 'add', '-q', '-b', 'wt-branch', wt)
      const checkout = which === 'wt' ? wt : repo
      const deeper = join(checkout, 'junksub', 'deeper')
      mkdirSync(deeper, { recursive: true })
      writeFileSync(join(checkout, 'junksub', '.git'), 'this file is named .git and is no repository\n')
      // Git itself names no repository from below the junk file.
      expect(gitFails(deeper)).toBe(true)

      const sessions = { below: `cc-${randomBytes(6).toString('hex')}`, top: `cc-${randomBytes(6).toString('hex')}` }
      const w = { home, proj: deeper } as CaptureWorld
      for (const [key, cwd] of [['below', deeper], ['top', checkout]] as const) {
        w.sessionId = sessions[key]
        runHook(w, 'session-start', { hook_event_name: 'SessionStart', source: 'startup', cwd })
      }

      // One store: the session below the junk file was bound to the
      // repository's store, as the session at the checkout's top was.
      const stores = readdirSync(join(home, '.treecontext', 'stores'))
      expect(stores).toHaveLength(1)
      const bindings = JSON.parse(readFileSync(join(home, '.treecontext', 'bindings.json'), 'utf8')) as { projects: Record<string, { store: string }> }
      expect(Object.values(bindings.projects).map((p) => p.store)).toEqual(stores)
      const db = new DatabaseSync(join(home, '.treecontext', 'stores', stores[0]!, 'treecontext.db'), { readOnly: true })
      try {
        const reg = (s: string): { worktree: string | null; branch: string | null } | undefined =>
          db.prepare("SELECT worktree, branch FROM session_registry WHERE session_id = ? AND agent_id = ''").get(s) as { worktree: string | null; branch: string | null } | undefined
        const top = reg(sessions.top)
        expect(top).toEqual(which === 'wt' ? { worktree: 'wt', branch: 'wt-branch' } : { worktree: null, branch: 'main' })
        // Placed exactly as the checkout's own top is: same lane, same branch.
        expect(reg(sessions.below)).toEqual(top)
      } finally {
        db.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})
