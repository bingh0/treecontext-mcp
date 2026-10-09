/**
 * Corpus resolution and provenance.
 *
 * Corpora are NEVER committed to this repository. They are fetched on
 * demand into a gitignored cache and identified by checksum. Two reasons,
 * and the second is the one that matters:
 *
 *  1. Size — LongMemEval-S is 265 MB, and the run takes 27 seconds. There
 *     is nothing to gain by carrying it.
 *  2. Provenance — a benchmark number means nothing unless the bytes it
 *     was computed over are identified. The checksum is what lets someone
 *     else reproduce the figure, and what tells us the corpus moved when a
 *     result shifts for no apparent reason.
 *
 * Licences (both permit redistribution; we decline it for size, not law):
 *   LongMemEval    — MIT, Wu et al., ICLR 2025. See bench/NOTICE.md.
 *   LongMemEval-V2 — Apache-2.0.
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Gitignored. Override with TREECONTEXT_BENCH_CACHE to share one cache
 *  between checkouts rather than re-downloading per clone. */
export function cacheDir(): string {
  return process.env['TREECONTEXT_BENCH_CACHE'] ?? join(HERE, '..', '.cache')
}

export interface CorpusSpec {
  /** Stable id used in reports. */
  id: string
  /** Filename inside the cache directory. */
  filename: string
  /** Where to fetch it when absent. */
  url: string
  /**
   * Expected sha256, once recorded. Null means "not yet pinned" — the
   * first run reports the checksum it observed so it can be pinned here
   * deliberately, rather than the bench silently trusting whatever it got.
   */
  sha256: string | null
}

export async function ensureCorpus(spec: CorpusSpec): Promise<string> {
  const dir = cacheDir()
  mkdirSync(dir, { recursive: true })
  const path = join(dir, spec.filename)
  if (existsSync(path)) return path

  process.stderr.write(`bench: fetching ${spec.id} → ${path}\n`)
  const res = await fetch(spec.url)
  if (!res.ok || !res.body) {
    throw new Error(`failed to fetch ${spec.url}: ${res.status} ${res.statusText}`)
  }
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(path))
  return path
}

/** Streamed so a 265 MB corpus does not need 265 MB of heap. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

export interface CorpusProvenance {
  id: string
  path: string
  bytes: number
  sha256: string
  /** False when the spec had no pinned checksum, or it did not match. */
  pinned: boolean
  mismatch: boolean
}

export async function resolveCorpus(spec: CorpusSpec): Promise<CorpusProvenance> {
  const path = await ensureCorpus(spec)
  const sha = await sha256File(path)
  return {
    id: spec.id,
    path,
    bytes: statSync(path).size,
    sha256: sha,
    pinned: spec.sha256 !== null,
    mismatch: spec.sha256 !== null && spec.sha256 !== sha,
  }
}
