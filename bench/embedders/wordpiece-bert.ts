/**
 * Pure-JavaScript BertTokenizer for sentence-transformers/all-MiniLM-L6-v2.
 *
 * Hardcoded for the bert-base-uncased vocabulary (see bert-vocab.ts). The
 * React Native backend locks MiniLM-L6-v2 permanently, so we do not need
 * generic tokenizer.json parsing or model-swapping flexibility here — the
 * main library's node backend still uses the HuggingFace `tokenizers` NAPI
 * binding for that.
 *
 * Why roll our own:
 *   - The NAPI `tokenizers` binding is Node-only.
 *   - onnxruntime-extensions (which ships a WASM tokenizer kernel) would
 *     pull in another native dep on RN.
 *   - This file is ~200 lines and produces byte-identical output to the
 *     Python `tokenizers` library for the bert-base-uncased configuration
 *     (see tests/embeddings/wordpiece-bert-parity.test.ts).
 *
 * Pipeline, mirroring the upstream tokenizer.json:
 *   1. BertNormalizer
 *        clean_text:            drop null + control chars (keep \t\n\r),
 *                               collapse whitespace runs
 *        handle_chinese_chars:  pad CJK ideographs with spaces
 *        strip_accents:         NFD decompose, drop combining marks
 *                               (config had `strip_accents: null`, which
 *                               defaults to `true` when `lowercase: true`)
 *        lowercase
 *   2. BertPreTokenizer
 *        whitespace split, then split punctuation into its own tokens
 *   3. WordPiece model (greedy longest-match with `##` continuation;
 *      any unmatchable word → [UNK])
 *   4. TemplateProcessing: prepend [CLS], append [SEP]
 *   5. Truncate to maxLength, preserving [CLS]/[SEP] wrapping
 */

import { readFileSync } from 'node:fs'

export interface TokenizerResult {
  ids: number[]
  attentionMask: number[]
}

// Special-token ids are bert-base-uncased's, which every MiniLM variant
// inherits. They are asserted against the loaded vocab in the constructor
// rather than trusted, so a model with a different vocab fails loudly
// instead of silently embedding garbage.
const BERT_CLS_TOKEN = '[CLS]'
const BERT_SEP_TOKEN = '[SEP]'
export const BERT_UNK_TOKEN = '[UNK]'


// ── Character classification ────────────────────────────────────────

/** BERT `_is_whitespace`: \t, \n, \r, or Unicode category Z (space separators). */
function isWhitespace(cp: number): boolean {
  if (cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d) return true
  // Category Z (Zs/Zl/Zp) — non-breaking space, em/en space, etc.
  return /\p{Z}/u.test(String.fromCodePoint(cp))
}

/** BERT `_is_control`: category C, but not whitespace. */
function isControl(cp: number): boolean {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return false
  // Cc/Cf/Cs/Co/Cn
  return /\p{C}/u.test(String.fromCodePoint(cp))
}

/**
 * BERT `_is_punctuation`: the ASCII-punctuation bands plus any Unicode
 * category-P character. The ASCII bands are checked explicitly so symbols
 * like `$`, `^`, `+`, `<` (which are S, not P) still split as punctuation.
 */
function isPunctuation(cp: number): boolean {
  if (
    (cp >= 0x21 && cp <= 0x2f) ||
    (cp >= 0x3a && cp <= 0x40) ||
    (cp >= 0x5b && cp <= 0x60) ||
    (cp >= 0x7b && cp <= 0x7e)
  ) {
    return true
  }
  return /\p{P}/u.test(String.fromCodePoint(cp))
}

/** BERT `_is_chinese_char`: the CJK code-point ranges. */
function isChineseChar(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) ||
    (cp >= 0x2b740 && cp <= 0x2b81f) ||
    (cp >= 0x2b820 && cp <= 0x2ceaf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f)
  )
}

// ── Normalization ───────────────────────────────────────────────────

function cleanAndPadCjk(input: string): string {
  // clean_text + handle_chinese_chars in one pass: iterate by code point
  // (so surrogate pairs in supplementary CJK ranges decode correctly).
  let out = ''
  for (const ch of input) {
    const cp = ch.codePointAt(0)!
    // clean_text: drop null, replacement char, and all other control
    // chars entirely (matches HF tokenizers `clean_text`); only whitespace
    // characters are replaced with a single space.
    if (cp === 0 || cp === 0xfffd) continue
    if (isControl(cp)) continue
    if (isWhitespace(cp)) {
      out += ' '
      continue
    }
    if (isChineseChar(cp)) {
      out += ' ' + ch + ' '
      continue
    }
    out += ch
  }
  return out
}

function stripAccentsAndLower(input: string): string {
  // NFD decomposes accented letters into base + combining-mark sequences;
  // we drop the combining marks (category Mn) before lowercasing, matching
  // BertNormalizer with `strip_accents: true, lowercase: true`.
  const decomposed = input.normalize('NFD').replace(/\p{Mn}+/gu, '')
  return decomposed.toLowerCase()
}

function normalize(input: string): string {
  return stripAccentsAndLower(cleanAndPadCjk(input))
}

// ── Pre-tokenization ────────────────────────────────────────────────

function preTokenize(text: string): string[] {
  const pieces: string[] = []
  for (const raw of text.split(/\s+/)) {
    if (!raw) continue
    let buf = ''
    for (const ch of raw) {
      const cp = ch.codePointAt(0)!
      if (isPunctuation(cp)) {
        if (buf) {
          pieces.push(buf)
          buf = ''
        }
        pieces.push(ch)
      } else {
        buf += ch
      }
    }
    if (buf) pieces.push(buf)
  }
  return pieces
}

// ── WordPiece ───────────────────────────────────────────────────────

/**
 * Greedy longest-match WordPiece on one pre-token. Returns the list of
 * sub-piece ids, or a single `[UNK]` id if any position cannot match.
 *
 * Mirrors the reference implementation (HuggingFace tokenizers
 * `WordPiece.tokenize_chars`): start index advances by the matched piece's
 * character length, continuation pieces get the `##` prefix.
 */
function wordpieceEncode(word: string, vocab: Map<string, number>, unkId: number): number[] {
  // WordPiece has a max-chars-per-token guard (100) to protect against
  // pathological inputs like 10k-char tokens blowing up the O(n^2) scan.
  // Upstream BERT fallback on exceed → `[UNK]`.
  const chars = Array.from(word)
  if (chars.length > 100) return [unkId]

  const ids: number[] = []
  let start = 0
  const n = chars.length
  while (start < n) {
    let end = n
    let matched: number | null = null
    while (start < end) {
      let piece = chars.slice(start, end).join('')
      if (start > 0) piece = '##' + piece
      const id = vocab.get(piece)
      if (id !== undefined) {
        matched = id
        break
      }
      end--
    }
    if (matched === null) return [unkId]
    ids.push(matched)
    start = end
  }
  return ids
}

// ── Public tokenizer ────────────────────────────────────────────────

export interface BertWordPieceOptions {
  /** Path to the model's tokenizer.json. The vocabulary comes from the
   *  model itself rather than an inlined copy, so a model with a different
   *  vocabulary tokenizes correctly instead of silently mismatching. */
  tokenizerJsonPath: string
  /** Hard cap after [CLS]/[SEP] wrapping. Defaults to 512 (MiniLM's limit). */
  maxLength?: number
}

interface TokenizerJson {
  model?: { vocab?: Record<string, number> }
}

function loadVocab(path: string): Map<string, number> {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as TokenizerJson
  const raw = parsed.model?.vocab
  if (!raw) throw new Error(`no model.vocab in ${path}`)
  return new Map(Object.entries(raw))
}

/**
 * BertTokenizer pinned to bert-base-uncased.
 *
 * Implements the small subset of the shared Tokenizer interface that the
 * embedding path actually uses. `setPadding` is accepted for API symmetry
 * but is a no-op — RN runs single-sequence encodes, so the ONNX wrapper
 * sees the natural length and the attention mask is all 1s.
 */
export class BertWordPieceTokenizer {
  private maxLength: number
  private vocab: Map<string, number>
  private clsId: number
  private sepId: number
  private unkId: number

  constructor(opts: BertWordPieceOptions) {
    this.maxLength = opts.maxLength ?? 512
    this.vocab = loadVocab(opts.tokenizerJsonPath)
    const need = (tok: string): number => {
      const id = this.vocab.get(tok)
      if (id === undefined) throw new Error(`tokenizer vocab is missing ${tok}`)
      return id
    }
    this.clsId = need(BERT_CLS_TOKEN)
    this.sepId = need(BERT_SEP_TOKEN)
    this.unkId = need(BERT_UNK_TOKEN)
  }

  encodeSync(text: string): TokenizerResult {
    const vocab = this.vocab
    const normalized = normalize(text)
    const preTokens = preTokenize(normalized)

    // Cap body length to (maxLength - 2) so [CLS] and [SEP] fit.
    const bodyCap = Math.max(0, this.maxLength - 2)
    const body: number[] = []
    for (const pt of preTokens) {
      const pieceIds = wordpieceEncode(pt, vocab, this.unkId)
      for (const id of pieceIds) {
        if (body.length >= bodyCap) break
        body.push(id)
      }
      if (body.length >= bodyCap) break
    }

    const ids = [this.clsId, ...body, this.sepId]
    const attentionMask = new Array<number>(ids.length).fill(1)
    return { ids, attentionMask }
  }

}

