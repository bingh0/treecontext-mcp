/**
 * Split detection — one project, two journals (§4, amended 2026-08-20).
 *
 * The defect this exists for: a directory binds by PATH before it has a
 * remote, gains the remote, and binds again by GIT. Both bindings are
 * correct, both stores are real, and nothing inside either journal can
 * show the other. Phase 1a's succession stops new splits; the ones
 * already on disk are only visible from outside, which is what `doctor`
 * is. Five were found on the author's machine this way.
 *
 * The pairing rule lives here, pure, so it is pinned without a bindings
 * file, a stores directory, or a doctor run — and so that nothing in it
 * can reach a store or an identity. It reports; it never repairs.
 */
import type { Bindings } from './bindings.js'

/** The bindings map as it is recorded on disk. */
export type BoundProjects = Bindings['projects']

/**
 * The shape `deriveName` produces for a path identity: the project
 * basename, then a six-hex slice of the identity hash (bindings.ts
 * `deriveName`). Both sides of an observed split wear derived names —
 * that is why the git side is a bare slug and the path side is this.
 *
 * A HEURISTIC, never a proof: `my-app-abc123` is a perfectly ordinary
 * project name (finding A6). That is the whole reason every surface
 * built on this says "candidate", and why the detector reports rather
 * than acts.
 */
const DERIVED_PATH_NAME_RE = /^(.*)-[0-9a-f]{6}$/

/**
 * The slug a derived path-store name carries, or null when the name is
 * not of that shape. An empty slug (`-ab12cd`) is not a slug.
 */
export function derivedNameSlug(store: string): string | null {
  const slug = DERIVED_PATH_NAME_RE.exec(store)?.[1]
  return slug ? slug : null
}

export interface SplitCandidate {
  /** The path-bound store: bound first, and the merge SOURCE. */
  pathStore: string
  /** The git-bound store holding the slug: the merge DESTINATION. */
  gitStore: string
}

/**
 * §4's rule: for each `path`-sourced binding whose store name carries a
 * derived-name slug, a candidate exists when some `git`-sourced binding
 * holds exactly that slug. Deliberately conservative — under-reporting
 * is the accepted failure mode, and the detector's own output says so.
 *
 * `carried-forward` bindings are NOT git bindings here: one of those
 * means succession already united the two identities on one store, so
 * pairing against it would report a split that Phase 1a just prevented.
 *
 * Pairs are deduplicated (two fingerprints can name one store — a
 * directory and its realpath) and ordered, so the report is stable
 * across runs.
 */
export function findSplitCandidates(projects: BoundProjects): SplitCandidate[] {
  const gitStores = new Set<string>()
  for (const entry of Object.values(projects)) {
    if (entry.source === 'git') gitStores.add(entry.store)
  }

  const seen = new Set<string>()
  const out: SplitCandidate[] = []
  for (const entry of Object.values(projects)) {
    if (entry.source !== 'path') continue
    const slug = derivedNameSlug(entry.store)
    if (slug === null || !gitStores.has(slug)) continue
    const key = `${entry.store}\u0000${slug}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ pathStore: entry.store, gitStore: slug })
  }
  return out.sort((a, b) =>
    a.pathStore.localeCompare(b.pathStore) || a.gitStore.localeCompare(b.gitStore))
}

export interface CarriedForwardBinding {
  store: string
  /** Newest adoption naming this store, ms since epoch. */
  updatedAt: number
  /** How many bindings were carried forward onto it. */
  bindings: number
}

/**
 * The adoption audit trail (O3, §12): bindings this machine wrote
 * WITHOUT the user asking, because the project's identity source
 * changed under it. Information, not a finding — succession working as
 * designed still deserves to be sayable out loud (R2).
 *
 * Grouped by store: the ssh and https spellings of one remote can each
 * adopt the same journal, and that is one adoption to a reader.
 */
export function carriedForwardBindings(projects: BoundProjects): CarriedForwardBinding[] {
  const byStore = new Map<string, CarriedForwardBinding>()
  for (const entry of Object.values(projects)) {
    if (entry.source !== 'carried-forward') continue
    const at = typeof entry.updatedAt === 'number' ? entry.updatedAt : 0
    const prev = byStore.get(entry.store)
    if (prev) {
      prev.bindings++
      if (at > prev.updatedAt) prev.updatedAt = at
    } else {
      byStore.set(entry.store, { store: entry.store, updatedAt: at, bindings: 1 })
    }
  }
  return [...byStore.values()].sort((a, b) => a.store.localeCompare(b.store))
}
