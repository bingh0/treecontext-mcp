/**
 * Where a session runs, as git reports it (D190, D167): the hook reads it
 * for the payload's cwd and registers it, so self is recovered from the
 * directory a session runs in, never from its process.
 *
 * The roots come from the same vetted probe store resolution uses
 * (bindings.ts gitRoots: one rev-parse, offsets resolved against the
 * physical cwd, a toplevel that does not contain the cwd distrusted), and a
 * checkout is a LINKED worktree only on git's full worktree signature
 * (primaryRepoRoot), so a hand-written `.git` file cannot pose as one. The
 * branch is one more rev-parse. Outside git, every field but the directory
 * is null.
 */
import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'
import { gitRoots, primaryRepoRoot, identityEnv } from '../server/bindings.js'
import type { GitSelf } from '../persistence/session-registry.js'

export function gitSelfOf(cwd: string): GitSelf {
  const roots = gitRoots(cwd)
  if (!roots) return { worktree: null, branch: null, cwd, toplevel: null, commonDir: null }
  const primary = primaryRepoRoot(roots.toplevel, roots.gitDir, roots.commonDir, roots.backPointerRoot)
  let branch: string | null = null
  try {
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: identityEnv(), timeout: 2000,
    }).trim() || null
  } catch { /* an unborn branch or no HEAD: the branch stays unknown */ }
  // A detached HEAD names no branch: rev-parse says the literal "HEAD".
  if (branch === 'HEAD') branch = null
  return {
    worktree: primary !== roots.toplevel ? basename(roots.toplevel) : null,
    branch,
    cwd,
    toplevel: roots.toplevel,
    commonDir: roots.commonDir,
  }
}
