/**
 * content-codec.feature bindings — gherkin-node-test executor.
 * (Executor-migration Phase 2, 2026-08-26: translated from the
 * vitest-cucumber binding; every assertion preserved verbatim. The two
 * scenarios sharing "each is encoded" stage their strings as world
 * samples; "it is decoded" merges over a staged decode target. Pure
 * function bindings — no store, nothing to defer.)
 */
import { expect } from 'vitest'
import type { Registry } from 'gherkin-node-test/vitest'
import {
  encodeContent,
  decodeContent,
  ZSTD_MIN_BYTES,
  __setZstdCapabilityForTests,
} from '../../src/persistence/content-codec.js'
import { ContentDecodeError } from '../../src/errors/index.js'

interface Sample {
  input: string
  encoded?: string | Buffer
}

interface World {
  defer: (fn: () => void | Promise<void>) => void
  samples?: Sample[]
  roundtripped?: string[]
  legacyValue?: string
  legacyDecoded?: string
  fallbackOriginal?: string
  fallbackEncoded?: string | Buffer
  fallbackDecoded?: string
  /** Staged by both Givens feeding the shared "it is decoded" When. */
  decodeTarget?: string | Buffer
  thrown?: unknown
}

export const contentCodecDefiner = (reg: Registry<World>): void => {
  reg.define(/^a set of strings below the zstd floor, including the empty string$/, (w) => {
    const inputs = ['', 'a', 'short note', 'x'.repeat(ZSTD_MIN_BYTES - 1)]
    w.samples = inputs.map((input) => ({ input }))
  })

  reg.define(/^a string exactly at the zstd floor and a multi-megabyte string$/, (w) => {
    const floorSized = 'y'.repeat(ZSTD_MIN_BYTES)
    const multiMb = 'the quick brown fox jumps over the lazy dog. '.repeat(80_000) // ~3.7MB
    w.samples = [{ input: floorSized }, { input: multiMb }]
  })

  // Shared by the plain-TEXT and zstd round-trip scenarios.
  reg.define(/^each is encoded$/, (w) => {
    for (const s of w.samples!) s.encoded = encodeContent(s.input)
  })

  reg.define(/^each encodes to the identical plain string, and decodes back unchanged$/, (w) => {
    w.samples!.forEach((s) => {
      expect(typeof s.encoded).toBe('string')
      expect(s.encoded).toBe(s.input)
      expect(decodeContent(s.encoded!)).toBe(s.input)
    })
  })

  reg.define(
    /^each encodes to a flagged Buffer with the zstd flag byte and decodes back to the original text$/,
    (w) => {
      for (const s of w.samples!) {
        expect(Buffer.isBuffer(s.encoded)).toBe(true)
        expect((s.encoded as Buffer)[0]).toBe(0x01)
        expect(decodeContent(s.encoded!)).toBe(s.input)
      }
    },
  )

  reg.define(/^strings containing emoji, CJK characters, and embedded NUL bytes, padded past the zstd floor$/, (w) => {
    const pad = 'p'.repeat(ZSTD_MIN_BYTES)
    const inputs = [
      `emoji: \u{1F600}\u{1F680}\u{1F984} ${pad}`,
      `CJK: 日本語のテキスト 中文文本 한국어 ${pad}`,
      `nul: a\u0000b\u0000\u0000c ${pad}`,
    ]
    w.samples = inputs.map((input) => ({ input }))
  })

  reg.define(/^each is encoded and decoded$/, (w) => {
    w.roundtripped = w.samples!.map((s) => decodeContent(encodeContent(s.input)))
  })

  reg.define(/^the decoded text is identical to the original, byte for byte$/, (w) => {
    expect(w.roundtripped).toEqual(w.samples!.map((s) => s.input))
  })

  reg.define(/^a plain string value as it would be read from an old, unmigrated row$/, (w) => {
    w.legacyValue = 'a legacy row that predates the zstd codec, arbitrarily long '.repeat(50)
  })

  reg.define(/^it is decoded directly without going through encodeContent$/, (w) => {
    w.legacyDecoded = decodeContent(w.legacyValue!)
  })

  reg.define(/^it is returned unchanged$/, (w) => {
    expect(w.legacyDecoded).toBe(w.legacyValue)
  })

  reg.define(/^the zstd capability override is forced off$/, () => {
    __setZstdCapabilityForTests(false)
  })

  reg.define(/^the zstd capability override is then forced off$/, () => {
    __setZstdCapabilityForTests(false)
  })

  reg.define(/^a large string is encoded and then decoded$/, (w) => {
    w.fallbackOriginal = 'z'.repeat(ZSTD_MIN_BYTES * 4)
    try {
      w.fallbackEncoded = encodeContent(w.fallbackOriginal)
    } finally {
      __setZstdCapabilityForTests(null)
    }
    w.fallbackDecoded = decodeContent(w.fallbackEncoded!)
  })

  reg.define(
    /^the encoded form carries the plain-fallback flag byte and decodes back to the original string$/,
    (w) => {
      expect(Buffer.isBuffer(w.fallbackEncoded)).toBe(true)
      expect((w.fallbackEncoded as Buffer)[0]).toBe(0x00)
      expect(w.fallbackDecoded).toBe(w.fallbackOriginal)
    },
  )

  reg.define(/^a string encoded through real zstd$/, (w) => {
    w.fallbackOriginal = 'y'.repeat(ZSTD_MIN_BYTES * 4)
    w.decodeTarget = encodeContent(w.fallbackOriginal)
    // Real zstd must have produced the flagged form, or this scenario
    // would silently test the plain path.
    expect(Buffer.isBuffer(w.decodeTarget)).toBe(true)
    expect((w.decodeTarget as Buffer)[0]).toBe(0x01)
  })

  reg.define(/^a buffer with an unknown leading flag byte$/, (w) => {
    w.decodeTarget = Buffer.concat([Buffer.from([0x7f]), Buffer.from('whatever', 'utf8')])
  })

  // Merged: "a zstd row on a runtime without zstd" and "an unrecognized
  // flag byte" decode their staged target catching into world state;
  // executes once per scenario.
  reg.define(/^it is decoded$/, (w) => {
    try {
      decodeContent(w.decodeTarget!)
    } catch (err) {
      w.thrown = err
    }
  })

  reg.define(
    /^a ContentDecodeError names the zstd requirement, and the same row decodes once capability returns$/,
    (w) => {
      try {
        expect(w.thrown).toBeInstanceOf(ContentDecodeError)
        expect((w.thrown as Error).message).toContain('zstd')
      } finally {
        __setZstdCapabilityForTests(null)
      }
      expect(decodeContent(w.decodeTarget!)).toBe(w.fallbackOriginal)
    },
  )

  reg.define(/^a ContentDecodeError is thrown naming the offending byte$/, (w) => {
    expect(w.thrown).toBeInstanceOf(ContentDecodeError)
    expect((w.thrown as Error).message).toContain('0x7f')
  })
}
