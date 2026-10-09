/**
 * The dedup key, pinned (docs/project-identity.md §9.2 → §11b).
 *
 * §9.2 measured the pre-v24 key filing 219 rows (2.2% of a 10k store)
 * under keys that covered more than one content, because captured tool
 * calls share a command prefix and a result suffix and differ in a
 * fixed-width middle identifier. These pins hold the repair in place —
 * and hold the FROZEN key frozen, because migration 023 is shipped
 * ladder history that must keep writing what it shipped with.
 */
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

import { contentFingerprint, contentFingerprintV1, contentFingerprintV2 } from '../src/fingerprint.js'
import { COLLIDING_A, COLLIDING_B } from './helpers/store-fixtures.js'

/**
 * §9.2's measured shape, built with real arithmetic rather than a
 * hand-written key: same head(64), same tail(64), same normalized
 * length, a different middle identifier of equal width. Plus the
 * whitespace surface the head/tail design never accounted for (runs
 * collapse, so unequal raw lengths reach equal normalized ones) and
 * short content, where the old key WAS the content.
 */
const CORPUS = [
  COLLIDING_A,
  COLLIDING_B,
  `${COLLIDING_A}`, // a genuine byte twin: must share every key form
  'a short note',
  'a   short\n  note',
  `${'x'.repeat(200)}   ${'y'.repeat(200)}`,
  `${'x'.repeat(200)} ${'y'.repeat(200)}`,
  '',
  '   ',
]

describe('contentFingerprint — the digest (§11b)', () => {
  it('tells apart two texts that differ only in a fixed-width middle identifier', () => {
    // The whole defect, as one assertion. Head, tail and normalized
    // length are identical by construction; only the middle differs.
    expect(COLLIDING_A.slice(0, 64)).toBe(COLLIDING_B.slice(0, 64))
    expect(COLLIDING_A.slice(-64)).toBe(COLLIDING_B.slice(-64))
    expect(COLLIDING_A.length).toBe(COLLIDING_B.length)
    expect(contentFingerprintV1(COLLIDING_A)).toBe(contentFingerprintV1(COLLIDING_B))
    expect(contentFingerprint(COLLIDING_A)).not.toBe(contentFingerprint(COLLIDING_B))
  })

  it('keeps whitespace-only variants on ONE key — the designed equivalence', () => {
    // Normalization is not what changed; only the structure retired.
    expect(contentFingerprint('a short note')).toBe(contentFingerprint('a   short\n  note'))
    expect(contentFingerprint(`${'x'.repeat(200)}   ${'y'.repeat(200)}`))
      .toBe(contentFingerprint(`${'x'.repeat(200)} ${'y'.repeat(200)}`))
    expect(contentFingerprint('  trailing and leading  ')).toBe(contentFingerprint('trailing and leading'))
  })

  it('is 32 lowercase hex characters at every length, short content included', () => {
    // The short-content fast path retired with the structural key: one
    // uniform key, which is what lets doctor's "unmigrated" predicate be
    // "not 32 hex" rather than a length-dependent guess.
    for (const text of CORPUS) {
      expect(contentFingerprint(text), `key shape for ${JSON.stringify(text.slice(0, 24))}`)
        .toMatch(/^[0-9a-f]{32}$/)
    }
  })

  it('is deterministic, and is the documented sha256 truncation', () => {
    for (const text of CORPUS) {
      expect(contentFingerprint(text)).toBe(contentFingerprint(text))
      const normalized = text.replace(/\s+/g, ' ').trim()
      expect(contentFingerprint(text))
        .toBe(createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 32))
    }
  })

  it('REFINEMENT: equal new keys imply equal old keys, over the seeded corpus', () => {
    // The safety property the migration leans on (§11b). Groups only ever
    // SPLIT, so the curated partial-unique index cannot gain a violation
    // from the v24 rewrite. Stated as the implication, checked over every
    // pair — including the pair that violates the converse.
    let splits = 0
    for (const a of CORPUS) {
      for (const b of CORPUS) {
        if (contentFingerprint(a) === contentFingerprint(b)) {
          expect(contentFingerprintV1(a), `refinement violated for ${JSON.stringify([a.slice(0, 16), b.slice(0, 16)])}`)
            .toBe(contentFingerprintV1(b))
        }
        if (contentFingerprintV1(a) === contentFingerprintV1(b) && contentFingerprint(a) !== contentFingerprint(b)) {
          splits++
        }
      }
    }
    // Anti-vacuity: the corpus must actually contain a group that splits,
    // or the implication above holds for uninteresting reasons.
    expect(splits, 'the corpus must contain a genuine old-key collision').toBeGreaterThan(0)
  })
})

describe('contentFingerprintV1 — frozen, because 023 shipped with it', () => {
  it('returns the normalized content itself at or under 128 characters', () => {
    expect(contentFingerprintV1('a   short\n  note')).toBe('a short note')
    const at128 = 'z'.repeat(128)
    expect(contentFingerprintV1(at128)).toBe(at128)
  })

  it('returns head + NUL + tail + normalized length above 128 characters', () => {
    const long = `${'a'.repeat(100)} ${'b'.repeat(100)}`
    const normalized = long.replace(/\s+/g, ' ').trim()
    expect(contentFingerprintV1(long))
      .toBe(`${normalized.slice(0, 64)}\x00${normalized.slice(-64)}:${normalized.length}`)
    // The embedded NUL is what makes the byte-length form load-bearing in
    // doctor's collision query — pinned here at the source.
    expect(contentFingerprintV1(long)).toContain('\x00')
  })

  it('is not the live key any more, and no live path may call it', () => {
    // If these ever agree again on long content, the freeze has been
    // undone and migration 023 is silently writing a different key than
    // it shipped with (022's tombstone rule).
    const long = 'tool output '.repeat(40)
    expect(contentFingerprintV1(long)).not.toBe(contentFingerprint(long))
  })
})

describe('contentFingerprintV2 — frozen, because 024 shipped with it', () => {
  // §11b's doc promise: "pinned so a drift fails a test instead of a
  // store." Migration 024 is shipped ladder history — the day a v25
  // changes the live `contentFingerprint`, stores climbing THROUGH 024
  // must still get exactly this key. So V2 is asserted BOTH ways: it must
  // equal the live function today, AND hit fixed literal digests so a
  // change to its own body fails even if the live function drifted with it.

  it('equals the live contentFingerprint over the whole corpus, today', () => {
    for (const text of CORPUS) {
      expect(contentFingerprintV2(text), `V2 drifted from live for ${JSON.stringify(text.slice(0, 24))}`)
        .toBe(contentFingerprint(text))
    }
    // Explicit representatives of every surface: short, >128, a
    // whitespace variant, and an astral-plane character.
    for (const text of [
      'a short note',
      'a   short\n  note',
      `${'x'.repeat(200)}   ${'y'.repeat(200)}`,
      'café ☕ résumé 𝟙',
    ]) {
      expect(contentFingerprintV2(text)).toBe(contentFingerprint(text))
    }
  })

  it('hits its frozen literal digests, so a body change fails even if live drifted with it', () => {
    // Hand-computed sha256(normalized).hex.slice(0,32). If V2 ever stops
    // producing these, migration 024 is silently writing a different key
    // than it shipped with.
    expect(contentFingerprintV2('a short note')).toBe('bfb2279faf89266069472fdfbb2c0672')
    expect(contentFingerprintV2('the quick brown fox')).toBe('9ecb36561341d18eb65484e833efea61')
    expect(contentFingerprintV2('café ☕ résumé 𝟙')).toBe('5bc00c33836f1ebb6a0b5a0c83d5f24a')
    // Whitespace normalization is part of the frozen contract.
    expect(contentFingerprintV2('a   short\n  note')).toBe('bfb2279faf89266069472fdfbb2c0672')
  })

  it('is 32 lowercase hex at every length', () => {
    for (const text of CORPUS) {
      expect(contentFingerprintV2(text)).toMatch(/^[0-9a-f]{32}$/)
    }
  })
})
