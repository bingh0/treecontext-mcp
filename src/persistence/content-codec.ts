/**
 * C1 — content codec: zstd-compressed blob storage with a legacy
 * plain-TEXT fallback, guarded by a 1-byte format flag.
 *
 * Encoding: strings under ZSTD_MIN_BYTES (utf8 byte length) are stored as
 * plain TEXT — the unchanged legacy shape, decodable with zero migration.
 * Strings at/above the floor are stored as `Buffer([flag, ...payload])`:
 *   - flag 0x01: zstd-compressed payload (node:zlib zstdCompressSync).
 *   - flag 0x00: uncompressed utf8 payload. Used whenever the runtime's
 *     node:zlib lacks zstd support (Node < 22.15), so the on-disk format
 *     never depends on which runtime wrote the row — a store written on an
 *     old runtime and opened on a new one (or vice versa) always decodes.
 *
 * Decoding dispatches on the flag byte. An unrecognized flag is treated as
 * store corruption (thrown), never silently swallowed or returned as
 * mangled text.
 */
import * as zlib from 'node:zlib'
import { ContentDecodeError } from '../errors/index.js'
import { ZSTD_MIN_BYTES } from './capture-constants.js'

export { ZSTD_MIN_BYTES }

const FLAG_PLAIN = 0x00
const FLAG_ZSTD = 0x01

/** node:zlib typed loosely — zstd*Sync only exists on Node >= ~22.15. */
interface ZstdCapableZlib {
  zstdCompressSync?: (input: Uint8Array) => Buffer
  zstdDecompressSync?: (input: Uint8Array) => Buffer
}

function zstdZlib(): ZstdCapableZlib {
  return zlib as unknown as ZstdCapableZlib
}

let zstdCapabilityOverride: boolean | null = null

/** Test-only seam: force the zstd-availability answer (null restores real
 *  detection). Re-added at round-2 R8 — without it the encode-side
 *  FLAG_PLAIN branch is unreachable on any runtime that ships zstd, and
 *  its pin was reduced to asserting a hand-built buffer. Governs BOTH
 *  sides since the G1 review: decode's zstd-less-runtime refusal (a
 *  zstd row on Node 22.0–22.14) was otherwise untestable on any modern
 *  runtime. Never set in production code paths. */
export function __setZstdCapabilityForTests(v: boolean | null): void {
  zstdCapabilityOverride = v
}

function hasZstd(): boolean {
  if (zstdCapabilityOverride !== null) return zstdCapabilityOverride
  const z = zstdZlib()
  return typeof z.zstdCompressSync === 'function' && typeof z.zstdDecompressSync === 'function'
}

function canDecodeZstd(): boolean {
  if (zstdCapabilityOverride !== null) return zstdCapabilityOverride
  return typeof zstdZlib().zstdDecompressSync === 'function'
}

/**
 * Encode text for storage in `nodes.content`. Returns the original string
 * unchanged when it is small (legacy shape); otherwise a flagged Buffer.
 */
export function encodeContent(text: string): string | Buffer {
  const utf8 = Buffer.from(text, 'utf8')
  if (utf8.byteLength < ZSTD_MIN_BYTES) return text
  const compress = hasZstd() ? zstdZlib().zstdCompressSync : undefined
  if (compress) {
    const compressed = compress(utf8)
    return Buffer.concat([Buffer.from([FLAG_ZSTD]), compressed])
  }
  return Buffer.concat([Buffer.from([FLAG_PLAIN]), utf8])
}

/**
 * Decode a `nodes.content` column value back to text. Strings pass through
 * unchanged (this covers both legacy plain-TEXT rows and small rows that
 * were never encoded); Buffers/Uint8Arrays dispatch on the leading flag
 * byte written by `encodeContent`.
 */
export function decodeContent(value: string | Buffer | Uint8Array | null | undefined): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(value)
  if (buf.length === 0) return ''
  const flag = buf[0]
  const payload = buf.subarray(1)
  if (flag === FLAG_PLAIN) return payload.toString('utf8')
  if (flag === FLAG_ZSTD) {
    if (!canDecodeZstd()) {
      throw new ContentDecodeError(
        'Content is zstd-encoded (flag 0x01) but this runtime\'s node:zlib has no zstdDecompressSync',
      )
    }
    return zstdZlib().zstdDecompressSync!(payload).toString('utf8')
  }
  throw new ContentDecodeError(
    `Unknown content encoding flag byte: 0x${(flag ?? 0).toString(16).padStart(2, '0')}`,
  )
}
