/**
 * Interim capture-fidelity knobs, locked 2026-07-04.
 *
 * Each constant below records the measurement or constraint behind its own
 * value. All are revisable — the FTS index and the demoted-content view are
 * both rebuildable from the full (zstd-compressed) store, so nothing here is
 * a one-way door.
 */

/** LEGACY index-cap for auto-captured user messages (chars), FROZEN.
 *
 *  Rows captured before schema 18 carry no `_index_len`, so their FTS text
 *  is recomputed from this constant at delete/update time (contentless
 *  FTS5 needs the exact original indexed text). Changing this value would
 *  desync those rows' index — it must never move again. New captures stamp
 *  an explicit `_index_len` at hook time (see `activeIndexCap`) and never
 *  consult this. */
export const INDEX_CAP_USER = 2000

/** LEGACY index-cap for auto-captured assistant prose (chars), FROZEN for
 *  the same recompute reason as INDEX_CAP_USER. Tool-event previews are
 *  exempt — they are already bounded at capture time and ARE the index
 *  form as-is. */
export const INDEX_CAP_ASSISTANT = 4000

/** Default indexed-view cap for tool events (chars), applied at capture.
 *
 *  Chosen from the 2026-07-28 cap sweep (bench/cap-sweep.ts + cap-cost.ts,
 *  LongMemEval-V2 states): an 8000-char view is statistically
 *  indistinguishable from full-text indexing (+0.16pp, 0.2 SE) while
 *  costing about a third of full's query latency and index growth on
 *  pathological DOM-like text. Prefix beats head+tail at this budget
 *  (equal within noise; head+tail only pays below ~2000). */
export const INDEX_CAP_TOOL_DEFAULT = 8000

/** Floor for TREECONTEXT_INDEX_CAP. Below ~300 chars retrieval measurably
 *  collapses (bench: −22pp on LongMemEval-S), so smaller values are almost
 *  certainly a mistake and are ignored. */
export const INDEX_CAP_ENV_FLOOR = 300

/**
 * The indexed-view cap for a NEW capture of the given role, in chars.
 *
 * Defaults: user/assistant prose is indexed in full (the 2026-07-28 sweep
 * measured the old 2000/4000 prefixes costing up to 14pp recall on prose),
 * tool events at INDEX_CAP_TOOL_DEFAULT. The `TREECONTEXT_INDEX_CAP` env
 * var overrides all three — the field lever for a store where retrieval
 * feels slow (treecontext_status surfaces latency and suggests it). It
 * bounds what becomes searchable for entries captured while it is set —
 * and, when it lands narrower than an entry's display preview, the preview
 * a hit shows (the display cut falls back to the index boundary); stored
 * text is unaffected and existing entries keep their view.
 *
 * Prose hooks stamp the resolved cap into `staging.index_len` on every
 * capture; post-tool-use stamps it only when load-bearing (JF-3: fitting
 * events stage NULL boundaries). Either way new rows are self-describing
 * at FTS recompute time — this function is consulted at capture only, and
 * changing the env var never desyncs existing rows.
 */
export function activeIndexCap(role: 'user' | 'assistant' | 'tool'): number {
  const env = envIndexCapOverride()
  if (env !== null) return env
  return role === 'tool' ? INDEX_CAP_TOOL_DEFAULT : Infinity
}

/** The accepted TREECONTEXT_INDEX_CAP value, or null when the variable is
 *  unset OR set to something `activeIndexCap` rejects (non-numeric, below
 *  the floor). Status reporting must use this — not raw env truthiness — so
 *  a rejected value is never presented as the active source. */
export function envIndexCapOverride(): number | null {
  const raw = process.env['TREECONTEXT_INDEX_CAP']
  if (raw === undefined || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n < INDEX_CAP_ENV_FLOOR) return null
  return Math.floor(n)
}

/** Tool-event preview caps (chars) — the preview IS the FTS index view for
 *  tool events, so these bound what is searchable, not what is stored (C4:
 *  the full input/output follows the preview in the staged content, with
 *  staging.index_len marking the boundary). Byte-for-byte the pre-C4
 *  composition so ranking behavior is unchanged. */
export const TOOL_INPUT_PREVIEW_CAP = 500
export const TOOL_OUTPUT_PREVIEW_CAP = 1000

/** Hard per-row safety cap (bytes) applied when staging content, independent
 *  of the FTS index caps above. Guards against a single pathological event
 *  (e.g. a runaway tool output) blowing up the store. */
export const STORE_SAFETY_CAP = 262_144

/** Below this utf8 byte length, content is stored as plain TEXT — small-row
 *  zstd is net-negative (compressed size + framing overhead exceeds the
 *  original). At/above it, content is zstd-compressed with a 1-byte flag. */
export const ZSTD_MIN_BYTES = 512

/** The entry-count safety net's allowance per configured session (D255,
 *  ruled 2026-10-08): the net scales with the session cap, so a raised cap
 *  is not undercut by a fixed entry count under subagents. Two hundred is
 *  a single agent's measured session. */
export const AUTO_ENTRIES_PER_SESSION = 200

/** The entry-count safety net (D6) at the default session cap: 200 x 100.
 *  A store derives its own from its cap (autoEntriesFor) unless it is
 *  opened with an explicit maxAutoEntries. */
export const MAX_AUTO_ENTRIES_DEFAULT = 20_000

/** The safety net a store with this session cap carries (D255). */
export function autoEntriesFor(maxSessions: number): number {
  return AUTO_ENTRIES_PER_SESSION * Math.max(1, maxSessions)
}

/** Default store-byte budget (sum of stored content byte lengths) before the
 *  demotion sweep (C3) starts stripping oldest-first non-protected rows back
 *  to their index text. 128 MiB since D141/D255 (raised from 64 MiB):
 *  subagents multiply a session's content without multiplying the session
 *  count. Operator-settable per store: `[retention] max_store_bytes` in the
 *  config file (src/server/config.ts). */
export const MAX_STORE_BYTES_DEFAULT = 128 * 1024 * 1024

/** Default cap on journaled sessions before the eviction valve archives the
 *  oldest whole session. Operator-settable per store: `[retention]
 *  max_sessions` in the config file (D141/D255). */
export const MAX_SESSIONS_DEFAULT = 100

/** The config-file key that sets the store-byte budget, in the words the
 *  file uses — the over-budget warning names it (D141/D255). */
export const STORE_BUDGET_CONFIG_KEY = '[retention] max_store_bytes'

/** D3 byte valve: unprocessed staging bytes beyond which ingestion drops
 *  oldest WHOLE sessions (writing one capture-gap tombstone each, JF-6).
 *  Deliberately huge — the valve exists for pathology (months of server-less
 *  capture), not normal backlogs, which drain in full. */
export const STAGING_MAX_BYTES = 512 * 1024 * 1024

/** Poison-row dead-letter: ingestion attempts before a failing staging row
 *  is marked processed and recorded as a capture-gap node (JF-7). */
export const MAX_INGEST_ATTEMPTS = 3

/** Drain claim TTL (G3, store-as-arbiter §2). A drain tick claims its
 *  batch atomically; a crashed drain's claims expire after this and the
 *  rows become claimable again. Assumption stated: much greater than the
 *  tick interval (5s default — a live drain releases its leftovers at
 *  tick end, never relying on expiry) and much less than the capture
 *  staleness a user would notice (a crash delays those rows at most two
 *  minutes). Wall-clock seconds: claimed_at is stamped at claim time by
 *  the claiming process, never from capture timestamps. Clock domain:
 *  all claimants share one host's clock — WAL's -shm limits a store to
 *  a local filesystem (accepted ceiling), so cross-host skew cannot
 *  reach this comparison in any supported configuration. */
export const STAGING_CLAIM_TTL_SECS = 120

/** D2: auto-capture dedup window (seconds). Identical auto-captured content
 *  within this window of the existing occurrence dedups (suppresses
 *  Stop-hook double-fire); outside it, a genuine recurrence gets its own
 *  node. Compared on CAPTURE timestamps, never drain-time wall clock
 *  (JF-4). Curated content ignores this — global idempotent dedup. */
export const DEDUP_WINDOW_SECS = 300

/** V2 echo-heal correlation window (seconds; docs/session-identity.md
 *  §7.5, ruled 2026-08-14: W = 60). Guards the dedup case — an echo of an
 *  insert that deduplicated onto an existing curated row may only touch a
 *  survivor created within this window of the echo, so a week-old row can
 *  never collect today's ambiguity — and sanity-bounds the creator case
 *  (echo and row are stamped by the same host clock, observed skew
 *  ≤ 0.1 s). */
export const ECHO_HEAL_WINDOW_SECS = 60

/** Echo composition markers (C4 + V2 echo correlation). Owned here so
 *  the composer (post-tool-use.ts) and the extractors
 *  (echo-correlation.ts) cannot drift apart: the extractors bound their
 *  scans on these exact strings. */
export const FULL_TAIL_SEPARATOR = '--- FULL ---'
export const OUTPUT_SECTION_LABEL = 'Output:'

/** §7.8 session-keyed namespace annotations: swept once older than this
 *  (by their own written_at). Session ids are never recycled, so a
 *  stale file can only describe a finished session; 14 days is far past
 *  any live session while keeping the sessions/ directory bounded —
 *  it shares a readdir with rung-3 identity resolution on every
 *  insert. */
export const SESSION_NS_ANNOTATION_TTL_SECS = 14 * 86400
