/**
 * ONNX int8 MiniLM-L6-v2 — the transformer rung of the tier ladder.
 *
 * A real forward pass, quantized to int8. The deletion inventory records
 * this as the variant that mattered ("the int8 quantization was correctly
 * identified as the win over the ORT-format variant"), and the footprint
 * it cost the product is on record too: 256ms cold start and +145MB RSS
 * before any data, with insert and query becoming embed-dominated.
 *
 * That footprint is exactly why this lives in bench/ and is loaded through
 * a dynamic import: nothing in the shipping path may depend on it, and a
 * checkout without `onnxruntime-node` installed must still run every other
 * arm rather than fail at import time.
 */
import { BertWordPieceTokenizer } from './wordpiece-bert.js'
import { meanPoolNormalize, type Embedder } from './types.js'
import { ensureModel, MINILM_INT8, type ResolvedModel } from './models.js'

/** Minimal shape of the bits of onnxruntime-node this uses. */
interface OrtTensorCtor {
  new (type: string, data: BigInt64Array, dims: number[]): unknown
}
interface OrtSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array; dims: number[] }>>
  inputNames: string[]
  release?(): Promise<void>
}

export class OnnxInt8Embedder implements Embedder {
  readonly id = 'onnx-int8-minilm'
  readonly description = 'all-MiniLM-L6-v2, int8-quantized ONNX, mean-pooled'
  readonly dimensions = 384

  private constructor(
    private session: OrtSession,
    private Tensor: OrtTensorCtor,
    private tokenizer: BertWordPieceTokenizer,
    readonly model: ResolvedModel,
  ) {}

  static async load(): Promise<OnnxInt8Embedder> {
    let ort: { InferenceSession: { create(path: string, opts?: unknown): Promise<OrtSession> }; Tensor: OrtTensorCtor }
    try {
      // Specifier held in a variable so tsc doesn't require the package (it
      // is not a devDependency — this arm's conclusion is recorded and the
      // package is installed on demand only to reproduce it).
      const specifier = 'onnxruntime-node'
      ort = (await import(specifier)) as unknown as typeof ort
    } catch {
      throw new Error(
        'onnxruntime-node is not installed. It is used only by this bench arm:\n' +
        '  npm install --no-save onnxruntime-node',
      )
    }

    const model = await ensureModel(MINILM_INT8)
    const session = await ort.InferenceSession.create(model.paths['model.onnx']!, {
      // Single-threaded and deterministic: a benchmark that varies with
      // scheduler luck is not a measurement.
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
    })
    const tokenizer = new BertWordPieceTokenizer({
      tokenizerJsonPath: model.paths['tokenizer.json']!,
      maxLength: 256,
    })
    return new OnnxInt8Embedder(session, ort.Tensor, tokenizer, model)
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = []
    // One sequence per run: batching would need padding, and a padded batch
    // that forgets to mask produces vectors that are wrong in a way no
    // assertion here would catch.
    for (const text of texts) {
      const enc = this.tokenizer.encodeSync(text)
      const len = enc.ids.length
      const ids = BigInt64Array.from(enc.ids.map(BigInt))
      const mask = BigInt64Array.from(enc.attentionMask.map(BigInt))
      const typeIds = new BigInt64Array(len) // all zeros: single segment

      const feeds: Record<string, unknown> = {
        input_ids: new this.Tensor('int64', ids, [1, len]),
        attention_mask: new this.Tensor('int64', mask, [1, len]),
      }
      if (this.session.inputNames.includes('token_type_ids')) {
        feeds['token_type_ids'] = new this.Tensor('int64', typeIds, [1, len])
      }

      const result = await this.session.run(feeds)
      const first = result['last_hidden_state'] ?? Object.values(result)[0]!
      const dims = first.dims[first.dims.length - 1] ?? this.dimensions
      out.push(meanPoolNormalize(first.data, len, dims, enc.attentionMask))
    }
    return out
  }

  async close(): Promise<void> {
    await this.session.release?.()
  }
}
