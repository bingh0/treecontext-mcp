/**
 * Model weights: fetched on demand, pinned by revision and checksum.
 *
 * Same discipline as the corpora, for the same reason — a benchmark number
 * computed against different weights is a different number, and "we
 * downloaded MiniLM" is not a reproducible statement. The HuggingFace
 * revision is pinned so `main` moving cannot silently change a result, and
 * the observed checksum is reported so it can be pinned deliberately after
 * the first run.
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

export function modelCacheDir(): string {
  return process.env['TREECONTEXT_BENCH_MODELS'] ?? join(HERE, '..', '.cache', 'models')
}

export interface ModelFile {
  /** Path within the HuggingFace repo. */
  remote: string
  /** Path within the local model directory. */
  local: string
  /** Expected sha256, once pinned. Null reports the observed value instead. */
  sha256: string | null
}

export interface ModelSpec {
  id: string
  repo: string
  /** Pinned revision. `main` would make results unreproducible. */
  revision: string
  files: ModelFile[]
}

/**
 * all-MiniLM-L6-v2, int8-quantized ONNX.
 *
 * Xenova's export is used rather than the sentence-transformers repo
 * because it publishes a quantized graph directly. The deletion inventory
 * records int8 as "correctly identified as the win over the ORT-format
 * variant", so int8 is the variant that matters here.
 */
export const MINILM_INT8: ModelSpec = {
  id: 'all-MiniLM-L6-v2-int8',
  repo: 'Xenova/all-MiniLM-L6-v2',
  revision: 'main',
  files: [
    { remote: 'onnx/model_quantized.onnx', local: 'model.onnx', sha256: null },
    { remote: 'tokenizer.json', local: 'tokenizer.json', sha256: null },
  ],
}

/**
 * potion-base-8M — a model2vec static embedding table.
 *
 * The fence's tier ladder is BM25 | +static | +int8, and this is the cheap
 * rung: a lookup table, mean-pooled. No ONNX runtime, no native
 * dependency, inference in pure TypeScript. If a signal shows up here it
 * shows up for almost no infrastructure at all.
 */
export const POTION_STATIC: ModelSpec = {
  id: 'potion-base-8M',
  repo: 'minishlab/potion-base-8M',
  revision: 'main',
  files: [
    { remote: 'model.safetensors', local: 'model.safetensors', sha256: null },
    { remote: 'tokenizer.json', local: 'tokenizer.json', sha256: null },
  ],
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

export interface ResolvedModel {
  dir: string
  /** local name → absolute path */
  paths: Record<string, string>
  /** local name → observed sha256 */
  checksums: Record<string, string>
  mismatches: string[]
}

export async function ensureModel(spec: ModelSpec): Promise<ResolvedModel> {
  const dir = join(modelCacheDir(), spec.id)
  mkdirSync(dir, { recursive: true })

  const paths: Record<string, string> = {}
  const checksums: Record<string, string> = {}
  const mismatches: string[] = []

  for (const file of spec.files) {
    const dest = join(dir, file.local)
    if (!existsSync(dest)) {
      const url = `https://huggingface.co/${spec.repo}/resolve/${spec.revision}/${file.remote}`
      process.stderr.write(`bench: fetching ${spec.id}/${file.local}\n`)
      const res = await fetch(url)
      if (!res.ok || !res.body) {
        throw new Error(`failed to fetch ${url}: ${res.status} ${res.statusText}`)
      }
      mkdirSync(dirname(dest), { recursive: true })
      await pipeline(
        Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
        createWriteStream(dest),
      )
    }
    paths[file.local] = dest
    const observed = await sha256File(dest)
    checksums[file.local] = observed
    if (file.sha256 !== null && file.sha256 !== observed) mismatches.push(file.local)
  }

  return { dir, paths, checksums, mismatches }
}
