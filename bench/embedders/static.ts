/**
 * Static (lookup-table) embedder — the cheap rung of the tier ladder.
 *
 * model2vec models are a token→vector table distilled from a sentence
 * transformer. Inference is: tokenize, gather rows, mean-pool,
 * L2-normalize. Pure TypeScript, no ONNX runtime, no native dependency,
 * and roughly two orders of magnitude faster than a transformer forward
 * pass. If dense retrieval helps this workload at all, this is the
 * cheapest possible way to see the signal.
 *
 * model2vec encodes with add_special_tokens=false, so [CLS]/[SEP] are
 * dropped after tokenization — including them shifts every vector.
 */
import { readFileSync } from 'node:fs'
import { BertWordPieceTokenizer } from './wordpiece-bert.js'
import { meanPoolNormalize, type Embedder } from './types.js'
import { ensureModel, POTION_STATIC, type ResolvedModel } from './models.js'

interface SafetensorsEntry {
  dtype: string
  shape: number[]
  data_offsets: [number, number]
}

/** Load the single 2-D F32 tensor from a .safetensors file. */
function loadEmbeddingMatrix(path: string): { data: Float32Array; rows: number; cols: number } {
  const buf = readFileSync(path)
  const headerLen = Number(buf.readBigUInt64LE(0))
  const header = JSON.parse(buf.subarray(8, 8 + headerLen).toString('utf8')) as Record<string, SafetensorsEntry>
  const entries = Object.entries(header).filter(([k, v]) => k !== '__metadata__' && v.shape?.length === 2)
  if (entries.length !== 1) {
    throw new Error(`expected exactly one 2-D tensor, found ${entries.map(([k]) => k).join(', ')}`)
  }
  const [name, meta] = entries[0]!
  if (meta.dtype !== 'F32') throw new Error(`tensor ${name} has dtype ${meta.dtype}, expected F32`)
  const [rows, cols] = meta.shape as [number, number]
  const start = 8 + headerLen + meta.data_offsets[0]
  const byteLen = meta.data_offsets[1] - meta.data_offsets[0]
  // Copied rather than viewed: a Float32Array view needs 4-byte alignment
  // that the file offset does not guarantee.
  const bytes = new Uint8Array(byteLen)
  bytes.set(buf.subarray(start, start + byteLen))
  return { data: new Float32Array(bytes.buffer), rows, cols }
}

/** Ids marked special in tokenizer.json — dropped before pooling. */
function specialTokenIds(tokenizerJsonPath: string): Set<number> {
  const parsed = JSON.parse(readFileSync(tokenizerJsonPath, 'utf8')) as {
    added_tokens?: { id: number; special?: boolean }[]
  }
  const ids = new Set<number>()
  for (const t of parsed.added_tokens ?? []) if (t.special) ids.add(t.id)
  return ids
}

export class StaticEmbedder implements Embedder {
  readonly id = 'static-potion-8m'
  readonly description = 'model2vec potion-base-8M lookup table, mean-pooled (no ONNX runtime)'
  readonly dimensions: number

  private constructor(
    private matrix: { data: Float32Array; rows: number; cols: number },
    private tokenizer: BertWordPieceTokenizer,
    private special: Set<number>,
    readonly model: ResolvedModel,
  ) {
    this.dimensions = matrix.cols
  }

  static async load(): Promise<StaticEmbedder> {
    const model = await ensureModel(POTION_STATIC)
    const matrix = loadEmbeddingMatrix(model.paths['model.safetensors']!)
    const tokenizerJson = model.paths['tokenizer.json']!
    const tokenizer = new BertWordPieceTokenizer({ tokenizerJsonPath: tokenizerJson, maxLength: 512 })
    return new StaticEmbedder(matrix, tokenizer, specialTokenIds(tokenizerJson), model)
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const { data, rows, cols } = this.matrix
    return texts.map(text => {
      const enc = this.tokenizer.encodeSync(text)
      const ids = enc.ids.filter(id => !this.special.has(id) && id < rows)
      if (ids.length === 0) return new Float32Array(cols)

      // Gather the rows, then reuse the shared pooling so static and ONNX
      // paths cannot drift in how they pool or normalize.
      const gathered = new Float32Array(ids.length * cols)
      ids.forEach((id, i) => gathered.set(data.subarray(id * cols, (id + 1) * cols), i * cols))
      return meanPoolNormalize(gathered, ids.length, cols, new Array<number>(ids.length).fill(1))
    })
  }

  async close(): Promise<void> {
    // Nothing to release: a table and a tokenizer.
  }
}
