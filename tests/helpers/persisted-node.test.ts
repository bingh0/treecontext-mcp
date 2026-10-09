/**
 * Pins for makePersistedNode's override semantics — the fixture the whole
 * persistence tier builds rows through.
 *
 * The gate's mutation run on the 2026-08-27 review response found the
 * per-field `??` form UNPINNED: reverting the builder to its old trailing
 * `...partial` spread left every consumer green, so the exact regression
 * the review caught — an explicitly-undefined key reaching the store as an
 * undefined timestamp instead of the default — could return silently.
 * These assertions are what now dies with it.
 *
 * The explicit-undefined partial arrives through `as unknown as` because
 * exactOptionalPropertyTypes forbids writing it directly, in a literal OR
 * in a single cast — which is the point: the type system cannot see a
 * `{ createdAt: undefined }` produced at runtime by a caller spreading
 * its own optional partial, so the builder has to defend at runtime, and
 * this file has to hand it the shape the type system would have blocked.
 */
import { describe, expect, test } from 'vitest'

import type { PersistedNode } from '../../src/persistence/store.js'
import { makePersistedNode } from './persisted-node.js'

describe('makePersistedNode override semantics', () => {
  test('an explicitly-undefined key is not an override and gets the default', () => {
    const node = makePersistedNode({ createdAt: undefined, metadata: undefined } as unknown as Partial<PersistedNode>)
    expect(typeof node.createdAt).toBe('number')
    expect(node.metadata).toBeNull()
  })

  test('a present key wins over the default, per field', () => {
    const node = makePersistedNode({ createdAt: 42, content: 'kept', readOnly: true })
    expect(node.createdAt).toBe(42)
    expect(node.content).toBe('kept')
    expect(node.readOnly).toBe(true)
    // Neighbouring fields keep their defaults — overrides are per field,
    // never a wholesale replacement.
    expect(node.updatedAt).not.toBe(42)
    expect(node.isLeaf).toBe(true)
  })

  test('decayRate is the exception: absent passes through, the store defaults it', () => {
    expect(makePersistedNode().decayRate).toBeUndefined()
    expect(makePersistedNode({ decayRate: 0.25 }).decayRate).toBe(0.25)
  })
})
