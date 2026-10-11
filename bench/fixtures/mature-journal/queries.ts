/**
 * The mature journal's query set, built from the generator's own content
 * so every gold label is exact. Gold is a LOGICAL key (see build.ts), so
 * the same query set scores any build of the seed, a mutated one included,
 * where node ids differ.
 *
 * Slices (bench/arms/mature-journal.ts reports by these):
 *   orientation       the handshake query and close paraphrases; gold the
 *                     newest live checkpoint (FRESH_PLAN) and the newest
 *                     session's bookmark
 *   note-lookup       each decision/finding note, asked by each half of
 *                     its own sentence
 *   checkpoint-lookup each session's chapter checkpoint, by its first
 *                     sentence
 *   bookmark-lookup   each bookmark, by its own first sentence (D166/D262)
 *   shell-lookup      SHELL_ONLY_TERM, and per session two commit hashes
 *                     that occur in exactly one generated text, a git-log
 *                     shell event's output, at a seeded line of it: D260's
 *                     guard (a quarter weight never hides a row) and the
 *                     capture's indexing of a line's first token at once
 *   shell-ordering    a word from the shell outputs that no other text
 *                     carries, matched in the INDEXED text of five or more
 *                     shell rows (read from the built database); gold the
 *                     ONE row whose indexed text carries it strictly most,
 *                     kept only when that row is also the densest match
 *                     (a tie or a denser rival drops the word), Bash and
 *                     Grep golds preferred over Read;
 *                     so the score reads how matching shell rows order
 *                     among themselves: what a tool weight of 0 costs,
 *                     since weight 0 keeps the rows but flattens the
 *                     column's term frequency. checkShellOrdering pins
 *                     that pure lexical ranking at the default weights
 *                     puts nearly every gold first
 *   developer-turn    each distinct developer prompt, without the
 *                     generator's "(topic, turn N)" tag; gold every turn
 *                     that said exactly that
 */
import { MATURE, ORIENTATION_QUERY, SHELL_ONLY_TERM, mulberry32 } from './shape.js'
import type { MatureJournal } from './build.js'

export type MatureSlice =
  | 'orientation' | 'note-lookup' | 'checkpoint-lookup' | 'bookmark-lookup' | 'shell-lookup' | 'shell-ordering'
  | 'developer-turn'

export interface MatureQuery {
  text: string
  kind: MatureSlice
  /** Logical keys of the relevant rows. */
  gold: string[]
}

/** Close paraphrases of the handshake's orientation query. */
export const ORIENTATION_PARAPHRASES = [
  ORIENTATION_QUERY,
  'what was I doing',
  'where did I leave off',
  "what's next",
  'what is the next step',
  'where was I, what was I working on',
]

/** Two commit hashes per session for the shell-lookup slice. */
const HASHES_PER_SESSION = 2

/** Queries in the shell-ordering slice. */
const SHELL_ORDERING_QUERIES = 12
/** Shell rows whose indexed text must carry a shell-ordering word. */
const SHELL_ORDERING_MIN_ROWS = 5

/** The index's words, approximately: unicode61 splits on anything that is
 *  not a letter or a digit and folds case. */
const tokens = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)

const stripLabel = (s: string): string => s.replace(/^[A-Z]+:\s*/, '')
const words = (s: string): string[] => s.split(/\s+/).filter(Boolean)

/**
 * Build the query set from a build's own report (`texts`, `kinds`): every
 * query and every gold label comes from what the generator made, never
 * from the index under test.
 */
export function matureQueries(journal: MatureJournal): MatureQuery[] {
  const sessions = MATURE.sessionDays.length
  const newest = sessions - 1
  const out: MatureQuery[] = []

  for (const text of ORIENTATION_PARAPHRASES) {
    out.push({ text, kind: 'orientation', gold: [`s${newest}:checkpoint`, `s${newest}:bookmark`] })
  }

  for (let k = 0; k < sessions; k++) {
    for (const note of ['decision', 'finding'] as const) {
      const w = words(stripLabel(journal.texts[`s${k}:${note}`]!))
      const half = Math.ceil(w.length / 2)
      out.push({ text: w.slice(0, half).join(' '), kind: 'note-lookup', gold: [`s${k}:${note}`] })
      out.push({ text: w.slice(Math.floor(w.length / 2)).join(' '), kind: 'note-lookup', gold: [`s${k}:${note}`] })
    }
  }

  for (let k = 0; k < sessions; k++) {
    const first = stripLabel(journal.texts[`s${k}:checkpoint`]!).split(/[.;]\s/)[0]!
    out.push({ text: first, kind: 'checkpoint-lookup', gold: [`s${k}:checkpoint`] })
  }

  for (let k = 0; k < sessions; k++) {
    const first = journal.texts[`s${k}:bookmark`]!.split(/\.\s/)[0]!
    out.push({ text: first, kind: 'bookmark-lookup', gold: [`s${k}:bookmark`] })
  }

  const shellOnlyKey = Object.keys(journal.texts).find((key) => journal.kinds[key]?.kind === 'shell' && journal.texts[key]!.includes(SHELL_ONLY_TERM))
  if (!shellOnlyKey) throw new Error('mature journal: no shell event carries the shell-only term')
  out.push({ text: SHELL_ONLY_TERM, kind: 'shell-lookup', gold: [shellOnlyKey] })
  // Commit hashes chosen from the generator's own text, never from the
  // index under test: a hash that occurs in exactly one generated text
  // anywhere in the journal, at a line drawn by a seeded PRNG among that
  // output's eligible lines, so a hash the capture makes unfindable scores
  // as a miss instead of leaving the query set.
  const allTexts = Object.values(journal.texts)
  const occurrences = (needle: string): number => allTexts.reduce((n, t) => n + (t.includes(needle) ? 1 : 0), 0)
  const pick = mulberry32(MATURE.seed ^ 0x5e11)
  for (let k = 0; k < sessions; k++) {
    let taken = 0
    for (let turn = 0; turn < MATURE.turnsPerSession && taken < HASHES_PER_SESSION; turn++) {
      for (let i = 0; i < MATURE.shellEventsPerTurn && taken < HASHES_PER_SESSION; i++) {
        const key = `s${k}:shell:${turn}:${i}`
        // The git-log events: one line per commit, `<7 hex> <subject>`.
        const lines = (journal.texts[key] ?? '').split('\n')
        if (!lines.every((l) => /^[0-9a-f]{7} /.test(l))) continue
        // A hash of digits alone reads as a number to nobody; skip it.
        const eligible = lines.map((l) => l.slice(0, 7))
          .filter((h) => /[a-f]/.test(h) && /[0-9]/.test(h) && occurrences(h) === 1)
        if (eligible.length === 0) continue
        out.push({ text: eligible[Math.floor(pick() * eligible.length)]!, kind: 'shell-lookup', gold: [key] })
        taken++
      }
    }
  }

  // Shell ordering. Candidate words come from the generator's shell
  // outputs (so the hook's own field names never qualify) and are left
  // out when any non-shell text carries them, so only shell rows compete.
  // Matches and counts are read on each row's INDEXED text from the built
  // database (journal.indexed): a Read is trail and indexes only its
  // preview, so a word deep in a long read is no gold at all.
  const shellKeys = Object.keys(journal.indexed).filter((key) => journal.kinds[key]?.kind === 'shell')
  const elsewhere = new Set<string>()
  for (const [key, text] of Object.entries(journal.texts)) {
    if (journal.kinds[key]?.kind !== 'shell') for (const t of tokens(text)) elsewhere.add(t)
  }
  const fromOutputs = new Set<string>()
  for (const key of shellKeys) for (const t of tokens(journal.texts[key] ?? '')) fromOutputs.add(t)
  const perRow = new Map<string, Map<string, number>>()
  for (const key of shellKeys) {
    for (const t of tokens(journal.indexed[key]!)) {
      if (!fromOutputs.has(t) || elsewhere.has(t)) continue
      const m = perRow.get(t) ?? new Map<string, number>()
      m.set(key, (m.get(key) ?? 0) + 1)
      perRow.set(t, m)
    }
  }
  const preferred: Array<{ word: string; gold: string }> = []
  const reads: Array<{ word: string; gold: string }> = []
  const len = (key: string): number => journal.indexed[key]!.length
  for (const [word, m] of [...perRow].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (word.length < 4 || !/[a-z]/.test(word) || m.size < SHELL_ORDERING_MIN_ROWS) continue
    const ranked = [...m].sort((a, b) => b[1] - a[1] || len(a[0]) - len(b[0]))
    // Gold: the row with strictly the most occurrences, which is also the
    // densest (occurrences per indexed character) of the matching rows. A
    // tied top count, or a gold some shorter row out-densifies, drops the
    // word: on this fixture ties-to-the-shorter-row left pure lexical
    // ranking the gold first on 7 of 12, a strict count alone on 6 of 12,
    // so the slice read length normalisation, not ordering by occurrence.
    const [first, second] = [ranked[0]!, ranked[1]!]
    if (first[1] === second[1]) continue
    if (ranked.some(([k, c]) => k !== first[0] && c / len(k) >= first[1] / len(first[0]))) continue
    const tool = journal.kinds[first[0]]?.tool
    ;(tool === 'Bash' || tool === 'Grep' ? preferred : reads).push({ word, gold: first[0] })
  }
  // Bash and Grep golds first; a Read gold only to fill the slice.
  const pickOrdering = mulberry32(MATURE.seed ^ 0x0de5)
  for (const pool of [preferred, reads]) {
    while (pool.length > 0 && out.filter((q) => q.kind === 'shell-ordering').length < SHELL_ORDERING_QUERIES) {
      const [c] = pool.splice(Math.floor(pickOrdering() * pool.length), 1)
      out.push({ text: c!.word, kind: 'shell-ordering', gold: [c!.gold] })
    }
  }

  const byBody = new Map<string, string[]>()
  for (let k = 0; k < sessions; k++) {
    for (let turn = 0; turn < MATURE.turnsPerSession; turn++) {
      const key = `s${k}:user:${turn}`
      const body = journal.texts[key]!.replace(/ \([^()]*, turn \d+\)$/, '')
      byBody.set(body, [...(byBody.get(body) ?? []), key])
    }
  }
  for (const [body, keys] of byBody) out.push({ text: body, kind: 'developer-turn', gold: keys })

  return out
}

/** Of the shell-ordering queries, how many golds pure lexical ranking at
 *  the default role weights must put first (measured 2026-10-10: see the
 *  bench README). Below it the slice no longer measures ordering among
 *  matching shell rows, and the build throws. */
export const SHELL_ORDERING_LEXICAL_FIRST_MIN = 11

/**
 * The shell-ordering sanity check: run every shell-ordering query through
 * `search` (pure lexical at the default role weights, the first result's
 * node id) and count the golds ranked first. Throws below the floor.
 */
export async function checkShellOrdering(
  journal: MatureJournal,
  queries: MatureQuery[],
  search: (text: string) => Promise<string | undefined>,
): Promise<{ first: number; of: number }> {
  const slice = queries.filter((q) => q.kind === 'shell-ordering')
  let first = 0
  for (const q of slice) {
    if ((await search(q.text)) === journal.ids[q.gold[0]!]) first++
  }
  if (first < SHELL_ORDERING_LEXICAL_FIRST_MIN) {
    throw new Error(`mature journal: shell-ordering gold first under pure lexical on ${first} of ${slice.length} (floor ${SHELL_ORDERING_LEXICAL_FIRST_MIN})`)
  }
  return { first, of: slice.length }
}
