/**
 * The split detector's rule, pinned as pure functions
 * (docs/project-identity.md §4, amended 2026-08-20).
 *
 * The doctor scenarios in store-bindings.feature prove the check reads
 * a real bindings file, opens real stores, and writes nothing. These
 * pin the decision itself — every shape the name matcher must refuse
 * and the pairing rule's exact preconditions — where a fixture would
 * cost a spawn per case and prove less.
 */
import { describe, it, expect } from 'vitest'

import {
  derivedNameSlug, findSplitCandidates, carriedForwardBindings,
  type BoundProjects,
} from '../../src/server/split-candidates.js'

/** Bindings as recorded on disk; fingerprints are opaque keys here. */
function bound(...entries: Array<[store: string, source: string]>): BoundProjects {
  const projects: BoundProjects = {}
  entries.forEach(([store, source], i) => {
    projects[`fp${i}`] = { store, updatedAt: 1000 + i, source: source as never }
  })
  return projects
}

describe('derived-name shape', () => {
  it('captures the slug deriveName would have prefixed to the hash', () => {
    expect(derivedNameSlug('proj-ab12cd')).toBe('proj')
    // Greedy: the LAST dash-plus-six-hex is the suffix, so a hyphenated
    // project name survives whole.
    expect(derivedNameSlug('my-long-name-0f9e8d')).toBe('my-long-name')
  })

  it('refuses everything that is not that shape', () => {
    for (const name of [
      'proj',            // a git slug — the other side of the split
      'proj-ab12c',      // five hex
      'proj-ab12cd7',    // seven
      'proj-ab12cg',     // 'g' is not hex
      'proj-AB12CD',     // deriveName emits lowercase
      'proj_ab12cd',     // underscore, not dash
      'ab12cd',          // no slug at all
      '-ab12cd',         // an EMPTY slug is not a slug
    ]) {
      expect(derivedNameSlug(name), name).toBeNull()
    }
  })

  it('matches a name a project could genuinely carry (finding A6)', () => {
    // The known false positive, pinned rather than wished away: it is
    // why the report says "candidate" and why it never acts.
    expect(derivedNameSlug('my-app-abc123')).toBe('my-app')
  })
})

describe('pairing rule', () => {
  it('pairs a derived path store with the git binding holding its slug', () => {
    expect(findSplitCandidates(bound(['proj-ab12cd', 'path'], ['proj', 'git'])))
      .toEqual([{ pathStore: 'proj-ab12cd', gitStore: 'proj' }])
  })

  it('reports nothing when no git binding holds the slug', () => {
    expect(findSplitCandidates(bound(['proj-ab12cd', 'path'], ['other', 'git']))).toEqual([])
  })

  it('will not pair on the path side alone, whatever the name', () => {
    // Both halves are required: a second path binding naming the slug is
    // not the git side of anything.
    expect(findSplitCandidates(bound(['proj-ab12cd', 'path'], ['proj', 'path']))).toEqual([])
  })

  it('requires the path source: a git-bound derived name pairs with nothing', () => {
    expect(findSplitCandidates(bound(['proj-ab12cd', 'git'], ['proj', 'git']))).toEqual([])
  })

  it('does not pair against a carried-forward binding', () => {
    // Succession already united those two identities on one store —
    // reporting a split there would advise merging a store into itself.
    expect(findSplitCandidates(bound(['proj-ab12cd', 'path'], ['proj', 'carried-forward'])))
      .toEqual([])
    // ...and the shape's own store being carried-forward is likewise the
    // adopted state, not a split.
    expect(findSplitCandidates(bound(['proj-ab12cd', 'carried-forward'], ['proj', 'git'])))
      .toEqual([])
  })

  it('reports each pair once and in a stable order', () => {
    const candidates = findSplitCandidates(bound(
      ['zeta-ffffff', 'path'],
      ['zeta', 'git'],
      // Two fingerprints naming one store: a directory and its realpath.
      ['alpha-000000', 'path'],
      ['alpha-000000', 'path'],
      ['alpha', 'git'],
    ))
    expect(candidates).toEqual([
      { pathStore: 'alpha-000000', gitStore: 'alpha' },
      { pathStore: 'zeta-ffffff', gitStore: 'zeta' },
    ])
  })

  it('reads an empty map without inventing a finding', () => {
    expect(findSplitCandidates({})).toEqual([])
  })
})

describe('carried-forward bindings (O3)', () => {
  it('groups adoptions by store, keeping the newest and counting the identities', () => {
    const projects = bound(
      ['journal', 'carried-forward'],
      ['journal', 'carried-forward'],
      ['other', 'git'],
      ['adopted', 'carried-forward'],
    )
    expect(carriedForwardBindings(projects)).toEqual([
      { store: 'adopted', updatedAt: 1003, bindings: 1 },
      { store: 'journal', updatedAt: 1001, bindings: 2 },
    ])
  })

  it('says nothing about bindings the user asked for', () => {
    expect(carriedForwardBindings(bound(['a', 'path'], ['b', 'git'], ['c', 'explicit']))).toEqual([])
  })
})
