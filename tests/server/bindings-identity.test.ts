/**
 * Unit pins for the three pure decisions succession rests on
 * (docs/project-identity.md §3, §3.2, §3.4 as amended 2026-08-20).
 *
 * The continuity SCENARIOS in store-bindings.feature drive real git
 * repositories, which is what makes them worth having and also what
 * makes them coarse: one shape per scenario, at the cost of a
 * subprocess each. These pin the decisions themselves — every URL
 * spelling, the submodule shape a linked-worktree fix must not eat, and
 * the resolution rule's three branches — with no git and no filesystem
 * (ruling 1ddad164: unit tests are first-class deliverables).
 */
import { describe, it, expect } from 'vitest'
import {
  gitUrlVariants, primaryRepoRoot, decideSuccession,
} from '../../src/server/bindings.js'

describe('gitUrlVariants — every raw spelling of one remote (§3.2)', () => {
  it('reaches the scp and ssh spellings from the canonical https clone URL', () => {
    // The URL people actually copy out of GitHub, and the one a probe of
    // canonical forms only would have missed.
    expect(gitUrlVariants('https://github.com/org/repo.git').sort()).toEqual([
      'git@github.com:org/repo',
      'git@github.com:org/repo.git',
      'https://github.com/org/repo',
      'https://github.com/org/repo.git/',
      'https://github.com/org/repo/',
      'ssh://git@github.com/org/repo',
      'ssh://git@github.com/org/repo.git',
    ])
  })

  it('reaches the https spellings from the scp form', () => {
    const variants = gitUrlVariants('git@github.com:org/repo.git')
    expect(variants).toContain('https://github.com/org/repo.git')
    expect(variants).toContain('https://github.com/org/repo')
    expect(variants).toContain('ssh://git@github.com/org/repo')
    expect(variants).not.toContain('git@github.com:org/repo.git')
  })

  it('reaches both other spellings from the ssh:// form', () => {
    const variants = gitUrlVariants('ssh://git@github.com/org/repo')
    expect(variants).toContain('https://github.com/org/repo.git')
    expect(variants).toContain('git@github.com:org/repo')
    expect(variants).not.toContain('ssh://git@github.com/org/repo')
  })

  it('treats a trailing slash as the same remote', () => {
    const variants = gitUrlVariants('https://github.com/org/repo/')
    expect(variants).toContain('https://github.com/org/repo')
    expect(variants).toContain('https://github.com/org/repo.git')
    expect(variants).toContain('git@github.com:org/repo')
    expect(variants).not.toContain('https://github.com/org/repo/')
  })

  it('preserves a multi-segment path whole (gitlab subgroups)', () => {
    // Truncating to the last two segments would collide every subgroup
    // repo of the same name onto one store.
    expect(gitUrlVariants('https://gitlab.com/org/sub/repo.git')).toContain('git@gitlab.com:org/sub/repo')
    expect(gitUrlVariants('https://gitlab.com/org/sub/repo.git')).toContain('ssh://git@gitlab.com/org/sub/repo.git')
    expect(gitUrlVariants('https://gitlab.com/org/sub/repo.git')).not.toContain('git@gitlab.com:sub/repo')
  })

  it('strips userinfo and a port, which are not part of the triple', () => {
    expect(gitUrlVariants('https://user@github.com/org/repo')).toContain('git@github.com:org/repo')
    expect(gitUrlVariants('ssh://git@github.com:2222/org/repo')).toContain('https://github.com/org/repo')
  })

  it('says nothing about a remote it cannot parse', () => {
    // Empty is the fail-closed answer: a probe of garbage would either
    // find nothing or, worse, collide two unrelated projects.
    for (const raw of ['', 'not a url', '/srv/git/repo.git', 'file:///srv/git/repo.git', 'C:\\src\\repo']) {
      expect(gitUrlVariants(raw), raw).toEqual([])
    }
  })
})

describe('primaryRepoRoot — one store per project, whatever checkout (§3.4)', () => {
  it('leaves a primary checkout on its own toplevel', () => {
    expect(primaryRepoRoot('/home/u/proj', '/home/u/proj/.git', '/home/u/proj/.git', null)).toBe('/home/u/proj')
  })

  it('resolves a linked worktree to the repository it was cut from', () => {
    // The genuine signature: gitDir under <common>/worktrees/<name>,
    // AND git's own back-pointer (<gitDir>/gitdir) naming this very
    // toplevel as the registered worktree.
    expect(primaryRepoRoot('/home/u/wt', '/home/u/proj/.git/worktrees/wt', '/home/u/proj/.git', '/home/u/wt'))
      .toBe('/home/u/proj')
  })

  it('a hand-written .git FILE cannot redirect identity to a victim (S3; review F2)', () => {
    // One attacker-authored line — `gitdir: /home/u/victim/.git` — in an
    // unpacked tarball makes git report the victim's dir as BOTH gitDir
    // and commonDir. No worktrees/ segment, no redirect: the hostile
    // checkout keeps its own toplevel and its own store.
    expect(primaryRepoRoot('/home/u/hostile', '/home/u/victim/.git', '/home/u/victim/.git', null))
      .toBe('/home/u/hostile')
  })

  it('a gitfile CHAINED to a real worktree gitdir cannot redirect either (Phase-2 review S1)', () => {
    // `gitdir: /home/u/victim/.git/worktrees/wt` wears the FULL
    // worktrees signature — but git's back-pointer names the victim's
    // genuine worktree, not the impostor toplevel. The back-pointer
    // match is the guard that closes the chain.
    expect(primaryRepoRoot('/home/u/unpacked', '/home/u/victim/.git/worktrees/wt', '/home/u/victim/.git', '/home/u/victim-wt'))
      .toBe('/home/u/unpacked')
  })

  it('a missing or unreadable back-pointer never redirects — fail closed', () => {
    expect(primaryRepoRoot('/home/u/wt', '/home/u/proj/.git/worktrees/wt', '/home/u/proj/.git', null))
      .toBe('/home/u/wt')
  })

  it('--separate-git-dir keeps its own toplevel (review F4)', () => {
    expect(primaryRepoRoot('/home/u/proj', '/home/u/elsewhere/.git', '/home/u/elsewhere/.git', null))
      .toBe('/home/u/proj')
  })

  it('leaves a submodule on its own toplevel', () => {
    // The basename guard that earns its keep: a submodule's common dir
    // is <super>/.git/modules/<name>, so the parent rule alone would
    // bind the submodule to `<super>/.git/modules` — not a project root.
    expect(primaryRepoRoot('/home/u/super/lib', '/home/u/super/.git/modules/lib', '/home/u/super/.git/modules/lib', null))
      .toBe('/home/u/super/lib')
  })

  it('a worktree cut from a SUBMODULE keeps its own toplevel', () => {
    // Passes the worktrees test AND carries a truthful back-pointer,
    // but not the .git basename test — every guard is load-bearing.
    expect(primaryRepoRoot('/home/u/subwt', '/home/u/super/.git/modules/lib/worktrees/subwt', '/home/u/super/.git/modules/lib', '/home/u/subwt'))
      .toBe('/home/u/subwt')
  })

  it('a bare-repo worktree keeps its own toplevel (disclosed residual, §3.4)', () => {
    expect(primaryRepoRoot('/home/u/wtA', '/home/u/proj.git/worktrees/wtA', '/home/u/proj.git', '/home/u/wtA'))
      .toBe('/home/u/wtA')
  })

  it('stands on the toplevel when either dir is unreported', () => {
    expect(primaryRepoRoot('/home/u/proj', null, null, null)).toBe('/home/u/proj')
    expect(primaryRepoRoot('/home/u/proj', '/home/u/proj/.git', null, null)).toBe('/home/u/proj')
    expect(primaryRepoRoot('/home/u/proj', null, '/home/u/proj/.git', null)).toBe('/home/u/proj')
  })
})

describe('decideSuccession — §3\'s resolution rule', () => {
  const noneBound = { adoptable: [], disclosed: [] }

  it('derives fresh when nothing adoptable is bound', () => {
    expect(decideSuccession(noneBound)).toEqual({ action: 'derive', conflict: null, disclosed: [] })
  })

  it('adopts when every bound adoptable predecessor names one store', () => {
    expect(decideSuccession({
      adoptable: [
        { identitySource: 'path', store: 'proj' },
        { identitySource: 'git', store: 'proj' },
      ],
      disclosed: [],
    })).toEqual({ action: 'adopt', store: 'proj', fromIdentitySource: 'path', disclosed: [] })
  })

  it('fails closed when bound predecessors disagree (R4)', () => {
    expect(decideSuccession({
      adoptable: [
        { identitySource: 'git', store: 'repo-late' },
        { identitySource: 'git', store: 'repo-early' },
      ],
      disclosed: [],
    })).toEqual({ action: 'derive', conflict: ['repo-early', 'repo-late'], disclosed: [] })
  })

  it('carries disclosures through whatever it decided', () => {
    // A subdirectory predecessor is never the reason for a decision
    // (§3.1) and is always worth saying out loud (R2).
    const disclosed = [{ dir: '/home/u/proj/packages/a', store: 'a-111111' }]
    expect(decideSuccession({ adoptable: [], disclosed }).disclosed).toEqual(disclosed)
    expect(decideSuccession({ adoptable: [{ identitySource: 'path', store: 'proj' }], disclosed }))
      .toEqual({ action: 'adopt', store: 'proj', fromIdentitySource: 'path', disclosed })
  })
})
