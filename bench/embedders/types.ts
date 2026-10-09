/**
 * Embedders live in bench/, never in src/.
 *
 * That placement is the point. The fence says dense retrieval has no seat
 * in the product and enters, if ever, only as a fused opt-in second list
 * that has passed a bench gate. Measuring whether it deserves that seat
 * does not require giving it one — so this code can be exercised, argued
 * with, and deleted again without touching a line of what ships.
 *
 * Consequences, deliberately accepted:
 *   - `onnxruntime-node` is not even a devDependency — it is installed on
 *     demand (npm install --no-save) only to reproduce the recorded arms.
 *     `bench/` is excluded from the package by `files: ["dist/**"]`, so
 *     nothing here reaches a user.
 *   - Model weights are downloaded on demand into a gitignored cache and
 *     identified by checksum, exactly like the corpora.
 */

export interface Embedder {
  /** Stable id, used in report and history records. */
  id: string
  /** Human description including the model and quantization. */
  description: string
  /** Vector width. */
  dimensions: number
  /** Embed a batch, returning L2-normalized vectors. */
  embed(texts: string[]): Promise<Float32Array[]>
  close(): Promise<void>
}

/** Cosine similarity of two L2-normalized vectors is their dot product. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!
  return sum
}

/** Mean-pool a [tokens × dims] matrix under an attention mask, then
 *  L2-normalize. This is what sentence-transformers does for MiniLM, and
 *  getting it wrong produces vectors that are subtly, silently worse. */
export function meanPoolNormalize(
  data: Float32Array,
  tokens: number,
  dims: number,
  mask: number[],
): Float32Array {
  const out = new Float32Array(dims)
  let live = 0
  for (let t = 0; t < tokens; t++) {
    if (mask[t] === 0) continue
    live++
    const base = t * dims
    for (let d = 0; d < dims; d++) out[d]! += data[base + d]!
  }
  if (live > 0) for (let d = 0; d < dims; d++) out[d]! /= live

  let norm = 0
  for (let d = 0; d < dims; d++) norm += out[d]! * out[d]!
  norm = Math.sqrt(norm)
  if (norm > 0) for (let d = 0; d < dims; d++) out[d]! /= norm
  return out
}
