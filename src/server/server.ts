/**
 * treecontext MCP server — the lexical journal's MCP surface.
 *
 * Exposes 8 tools:
 *   treecontext_insert, treecontext_query, treecontext_status,
 *   treecontext_delete, treecontext_clear, treecontext_export,
 *   treecontext_import, treecontext_merge_from_agent
 *
 * Transport: stdio only — HTTP was tombstoned at the 0.1 corpus audit
 * (2026-08-12; its tree-era consumers are gone). The tree-era tools
 * (checkpoint/update_summary/recover) left with the tree backend —
 * deletion phase, 2026-07-25.
 */

import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'
import { sanitizeError, type SanitizeOptions } from '../errors/sanitize.js'
import type { MemoryStore } from '../memory-store.js'
import { createMemoryStore } from '../memory-store-factory.js'
import { IngestionLoop, isIngestible, type IngestibleStore, type IngestionOptions } from './ingestion.js'
import { isVitalsSource, publishSidecarPanes } from './sidecar-blob.js'
import type { Database } from '../persistence/database.js'
import type { QueryResult, InsertOptions, MediaRef, MediaFilter, BackendMode } from '../core/types.js'
import { DEFAULT_CONVERSATION_WINDOW } from '../core/types.js'
import { NodeNotFoundError } from '../errors/index.js'
import { INSTRUCTIONS_BRIEF_LEXICAL, resolveInstructions } from './instructions.js'
import { policyAllows, captureEnabled, effectivePolicy, type Policy } from './policy.js'
import { shieldResponse, defaultShieldConfig, cleanShieldDir, cleanLegacyShieldDir, type ShieldConfig } from './shielding.js'
import { SessionStats } from './session-stats.js'
import { activeIndexCap, envIndexCapOverride, INDEX_CAP_ENV_FLOOR, STORE_BUDGET_CONFIG_KEY } from '../persistence/capture-constants.js'
import { resolveCcSessionId, writeNamespaceAnnotation, type CcSessionResolution } from '../session-beacon.js'
import { dbg, warn } from '../debug.js'
import type { FlatStore } from '../flat-store.js'
import { selfWriterOf, stampMetadata, WRITER_STAMP_KEYS, type WriterStamp } from '../persistence/session-registry.js'
import {
  INLINE_EXPORT_CAP, SECRETS_WARNING, buildHandoff, importToldMessage, resolveProjectPath, writeHandoffFile,
  type HandoffForm,
} from '../handoff.js'
import { DEFAULT_RECENCY_WEIGHT, SHADOW_RECENCY_WEIGHT, recordQueryTelemetry, telemetryEnabled } from './query-telemetry.js'

// ── Server state ────────────────────────────────────────────────────

const sessionStats = new SessionStats()

let ctx: MemoryStore | null = null
let ingestionLoopRef: IngestionLoop | null = null
void ingestionLoopRef // reserved for status surfacing; assigned by initCapture

function getCtx(): MemoryStore {
  if (!ctx) throw new Error('Memory store not initialized. Call startServer() first.')
  return ctx
}

// ── Tool registration ───────────────────────────────────────────────

export interface CreateServerOptions {
  /**
   * Tool-access policy. Controls which tools are registered:
   *   - 'full' (default): all 8 tools
   *   - 'read_only': query/status/export only
   *   - 'contributor': adds insert, but still forbids
   *     delete/clear/import/merge_from_agent
   *
   * Takes precedence over `readOnly` when both are provided.
   */
  policy?: Policy
  /**
   * Deprecated shorthand. `readOnly: true` is equivalent to
   * `policy: 'read_only'`. Retained for backward compatibility; prefer
   * `policy`.
   */
  readOnly?: boolean
  /**
   * Optional runtime metadata surfaced by treecontext_status so agents
   * can see which store / namespace they are attached to without having
   * to inspect server stderr.
   */
  info?: {
    storeName?: string | null
    storePath?: string | null
    namespace?: string | null
    modelName?: string | null
  }
  /**
   * Best-effort acquisition of the namespace's primary claim (G4: a
   * lease heartbeat, not a lockfile). Called before every tool
   * invocation; must be idempotent, and must NOT throw when another
   * live process holds the role — since amendment 8 (2026-08-20,
   * tests/server/design/store-as-arbiter.md §8) a same-namespace second
   * server serves alongside the holder, writer safety being the store's
   * constraints rather than this hook. A non-contention error (a real
   * database failure) propagates and fails the tool call as itself.
   */
  lockHook?: () => void
  /**
   * Transport type for error sanitization. Over HTTP, unknown errors
   * are replaced with a generic message + correlation ID. Stdio passes
   * full messages through (local-trust model). Default: 'stdio'.
   */
  transport?: 'stdio'
  /** Byte threshold for output shielding. 0 = disabled. */
  shieldThreshold?: number
  /** Directory for shielded output files. */
  shieldDir?: string
  /**
   * Namespace tag injected into `metadata._namespace` on every insert
   * issued through this server instance. Daemon callers set this from
   * the per-session `X-Treecontext-Namespace` header. When omitted,
   * inserts are not namespace-tagged (current behavior).
   */
  namespace?: string | null
  /**
   * Session identifier injected into `metadata._session_id` on every
   * insert. Daemon callers pass the SDK-assigned session ID so the tree
   * can identify which connection produced a node. Accepts a function
   * so the ID can be resolved lazily (the SDK assigns it during the
   * initialize round-trip, after createServer has been called).
   */
  sessionId?: string | null | (() => string | null)
  /**
   * Explicit Claude Code session id (docs/session-identity.md
   * §3, resolution ladder rung 2 "explicit"). Daemon/HTTP callers pass the
   * `X-Treecontext-CC-Session` header value here so the server doesn't need
   * to guess via the pid beacon (which only applies to the stdio path — see
   * `claudePid`). Accepts a function for lazy resolution, mirroring
   * `sessionId`. When set, this always wins over the pid/beacon rungs.
   */
  ccSessionId?: string | null | (() => string | null)
  /**
   * Override for the claude process's PID used by the rung-1 "pid" beacon
   * match (docs/session-identity.md §3). Defaults to
   * `process.ppid`, which is the real claude PID on the stdio path (the
   * hook wrapper and MCP launcher both `exec` into node — see
   * installer.ts). Test-only knob; production callers should never set
   * this.
   */
  claudePid?: number
  /**
   * Override for the working directory used by the rung-3 cross-project
   * beacon narrowing (docs/session-identity.md §7.5 adjunct). Defaults to
   * `process.cwd()`, which on the stdio path is the claude process's
   * project directory — the same value the hooks record in their
   * beacons. Test-only knob, mirroring `claudePid`.
   */
  claudeCwd?: string
  /**
   * Per-instance SessionStats. When provided, tool handlers record into
   * this instance instead of the module-level singleton. Daemon callers
   * create one per session for proper isolation.
   */
  sessionStats?: SessionStats
  /**
   * Override the agent-facing `instructions` string sent on the MCP
   * handshake. Defaults to INSTRUCTIONS_BRIEF_LEXICAL (the measured
   * winner of the activation eval).
   * Used by the activation eval harness to vary the Tier-1 instruction
   * channel, and the intended hook for a future
   * `--instructions verbose|brief` flag. Pass an empty string to simulate
   * a client that receives no server instructions.
   */
  instructions?: string
  /**
   * The project directory this server was started for: the directory the
   * CLI resolves the store from (`--project-dir`, TREECONTEXT_PROJECT_DIR,
   * or the working directory). The only place the export and import tools
   * read or write a handoff file by path (D199), and the project the
   * file's head names. Never taken from the agent. Defaults to
   * `process.cwd()`, which is what the CLI resolves when nothing is set.
   */
  projectDir?: string
}

/**
 * Create an MCP server with all treecontext tools.
 *
 * When `injectedCtx` is provided, all tools use it directly instead of
 * the module-scoped `ctx` set by `startServer()`. This allows tests to
 * drive the full MCP transport path without stdio.
 */
export function createServer(
  injectedCtx?: MemoryStore,
  opts: CreateServerOptions = {},
): McpServer {
  const serverOpts = opts
  const stats = opts.sessionStats ?? sessionStats
  const resolve = injectedCtx ? () => injectedCtx : getCtx
  const policy: Policy = effectivePolicy(opts.policy, opts.readOnly)
  const staticInfo = opts.info ?? {}
  const getInfo = (): NonNullable<CreateServerOptions['info']> => staticInfo
  const projectDir = opts.projectDir ?? process.cwd()
  const projectName = basename(projectDir) || projectDir

  const shieldConfig: ShieldConfig = defaultShieldConfig({
    thresholdBytes: opts.shieldThreshold ?? 0,
    ...(opts.shieldDir ? { shieldDir: opts.shieldDir } : {}),
  })

  /** Apply shielding to a tool result, returning the (possibly modified) result. */
  const maybeShield = (toolName: string, result: { content: Array<{ type: 'text'; text: string }>; isError?: boolean }) => {
    if (result.isError || shieldConfig.thresholdBytes === 0) return result
    const first = result.content[0]
    if (!first || first.type !== 'text') return result
    const sr = shieldResponse(toolName, first.text, shieldConfig)
    if (!sr.shielded) return result
    return { content: [{ type: 'text' as const, text: sr.text }] }
  }

  const server = new McpServer(
    {
      name: 'treecontext',
      version: '1.0.0',
    },
    {
      // Default: BRIEF. The activation eval (t10, AC1 PASS) showed VERBOSE
      // uniquely suppresses memory-necessary activation (55% vs 100%) while
      // costing 405 more always-on tokens, and Claude Code's 2KB instruction
      // cap truncates VERBOSE mid-sentence in production anyway. Pass
      // opts.instructions to override (used by the activation eval
      // harness; empty string disables them).
      instructions: opts.instructions ?? INSTRUCTIONS_BRIEF_LEXICAL,
    },
  )
  const sanitizeOpts: SanitizeOptions = { transport: opts.transport ?? 'stdio' }
  /** Format a tool error response with proper sanitization. */
  const toolError = (err: unknown) => {
    const { message, correlationId } = sanitizeError(err, sanitizeOpts)
    const payload: Record<string, string> = { error: message }
    if (correlationId) payload.correlationId = correlationId
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], isError: true as const }
  }
  const ensureReady = async (): Promise<void> => {
    if (opts.lockHook) opts.lockHook()
  }

  // Session-identity resolution (docs/session-identity.md
  // §3). Resolved lazily at first insert (the store path isn't known until
  // then in manager/CtxManager mode) and cached for the process lifetime —
  // but ONLY a rung-1 "pid" exact match is cached; explicit/beacon-unanimous/
  // beacon-ambiguous/absent are re-resolved on every insert (cheap: one stat
  // + a small directory listing) since a beacon can appear shortly after the
  // server starts (SessionStart hook racing the first tool call) and a
  // unanimous read can turn ambiguous when a second session comes up.
  let cachedPidResolution: CcSessionResolution | null = null
  const resolveCcSession = (): CcSessionResolution => {
    if (cachedPidResolution) return cachedPidResolution
    const explicit = typeof serverOpts.ccSessionId === 'function'
      ? serverOpts.ccSessionId()
      : (serverOpts.ccSessionId ?? null)
    const dbPath = getInfo().storePath
    if (!dbPath) return { ccSessionId: explicit, src: explicit ? 'explicit' : null }
    const resolution = resolveCcSessionId(dbPath, {
      claudePid: serverOpts.claudePid ?? process.ppid,
      stdio: (serverOpts.transport ?? 'stdio') === 'stdio',
      explicitCcSessionId: explicit,
      cwd: serverOpts.claudeCwd ?? process.cwd(),
    })
    if (resolution.src === 'pid') cachedPidResolution = resolution
    return resolution
  }

  // D190: who wrote a row written through the tools. The server knows
  // the Claude Code session (above) but not, from the transport, whether
  // the orchestrator or one of its subagents is calling — they share the
  // session and this connection. It looks the session up in the registry
  // the hooks keep (persistence/session-registry.ts). A session whose own
  // identity is ambiguous here is not looked up: its stamp would be a
  // guess about a guess.
  type Stamping = MemoryStore & Partial<Pick<FlatStore, 'writerStampFor' | 'subagentScopeFor' | 'selfOfSession'>>
  const writerStamp = (ctx: MemoryStore, cc: CcSessionResolution): WriterStamp => {
    const store = ctx as Stamping
    if (typeof store.writerStampFor !== 'function' || cc.ccSessionId === null || cc.ambiguous) return { src: 'unregistered' }
    try {
      return store.writerStampFor(cc.ccSessionId)
    } catch (err) {
      dbg('server', 'writer stamp lookup failed — row stamped unregistered', { error: err instanceof Error ? err.message : String(err) })
      return { src: 'unregistered' }
    }
  }

  // ── treecontext_insert (mutating) ───────────────────────────────

  if (policyAllows(policy, 'treecontext_insert')) server.registerTool(
    'treecontext_insert',
    {
      description: 'Store an observation, decision, finding, or passage into working memory.',
      inputSchema: z.object({
      content: z.string().min(1).max(50000).describe(
        'The text to store. Be specific — vague entries produce poor summaries.',
      ),
      decay_exempt: z.boolean().default(false).describe(
        'When true, this node is protected from retention eviction and ' +
        'demotion — it is never archived away or shrunk by the storage valve.',
      ),
      metadata: z.record(z.string(), z.unknown()).optional().describe(
        'Optional structured metadata dict for filtering during queries. '
        + 'refs: the id (or ids) of earlier entries this one responds to; they '
        + 'then show it as referencedBy, and the earlier entries stay untouched. '
        + 'brief_for: a worktree name or subagent role this entry briefs; a '
        + 'session starting in that worktree is handed it, and a subagent of '
        + 'that role finds it in its default search. The writer is stamped '
        + 'by the store and said back as writer.',
      ),
      supersedes: z.array(z.string().min(1)).max(100).optional().describe(
        'Node IDs whose resume-pointer flags this insert supersedes (e.g. a '
        + 'prior plan or close-out this entry replaces). Clears next_session, '
        + 'demotes status "active" to "superseded", and writes a superseded_by '
        + 'trace on each target. Targets stay fully queryable. A target '
        + 'another writer wrote is never changed: it is recorded in this '
        + "entry's refs instead and listed as referenced.",
      ),
      media_ref: z.object({
        uri: z.string().describe('URI to the content (file://, https://, etc.)'),
        mime_type: z.string().describe('MIME type (image/png, audio/wav, etc.)'),
        filename: z.string().optional(),
        extension: z.string().optional(),
        size_bytes: z.number().optional(),
        extracted: z.record(z.string(), z.unknown()).optional().describe(
          'Extracted metadata: dimensions, codec, duration, GPS, etc.',
        ),
      }).optional().describe(
        'Reference pointer to non-text content. The content field must contain '
        + 'a text description of the media; the actual binary lives at the URI.',
      ),
      }),
    },
    async ({ content, decay_exempt, metadata, supersedes, media_ref }) => {
      const t0 = Date.now()
      try {
        await ensureReady()
        const opts: InsertOptions = {}
        if (decay_exempt) opts.decayExempt = decay_exempt
        // Normalize the `metadata.supersedes` alias: agents write it
        // spontaneously, so honor it (string or string[]), merge with the
        // top-level param, and strip it from the stored metadata — the
        // trace fields land on the targets instead.
        const metadataCopy = metadata ? { ...metadata } : undefined
        let supersedesList: string[] = supersedes ?? []
        if (metadataCopy && 'supersedes' in metadataCopy) {
          const alias = metadataCopy.supersedes
          if (typeof alias === 'string') supersedesList = [...supersedesList, alias]
          else if (Array.isArray(alias)) {
            supersedesList = [...supersedesList, ...alias.filter((x): x is string => typeof x === 'string')]
          }
          delete metadataCopy.supersedes
        }
        // The `_handoff_*` keys are the importer's own marks (D165): only
        // treecontext_import writes them, so a caller's copy is a forgery
        // that would read as "imported from <file>" and place the row in a
        // handoff lane. They are dropped, never stored.
        if (metadataCopy) {
          for (const k of Object.keys(metadataCopy)) if (k.startsWith('_handoff_')) delete metadataCopy[k]
          // The writer stamp is the store's alone (D169, D190): a caller's
          // `_writer`, `_worktree` and kin are a claim, dropped like the
          // importer's marks, and the stamp below replaces them.
          for (const k of WRITER_STAMP_KEYS) delete metadataCopy[k]
        }
        if (supersedesList.length > 0) opts.supersedes = supersedesList
        // Merge namespace/session tags onto user-provided metadata.
        // User keys win over auto-tags only for non-reserved keys; the
        // `_namespace` / `_session_id` reserved keys are always set when
        // configured at the server level.
        const namespaceTag = serverOpts.namespace ?? null
        const sessionIdTag = typeof serverOpts.sessionId === 'function'
          ? serverOpts.sessionId()
          : (serverOpts.sessionId ?? null)
        // Session-identity fix (docs/session-identity.md
        // §3): `_conn_id` is the renamed field for what `_session_id` means
        // today (MCP connection identity) — written alongside the unchanged
        // `_session_id` for the deprecation window. `_cc_session_id` +
        // `_cc_session_src` are the resolution-ladder result (the real
        // Claude Code session UUID); rung 4 ("absent") writes nothing
        // rather than guess.
        const ccResolution = resolveCcSession()
        const stamp = writerStamp(resolve(), ccResolution)
        if (metadataCopy || namespaceTag || sessionIdTag || ccResolution.ccSessionId !== null || stamp.src !== 'unregistered') {
          const merged: Record<string, unknown> = { ...metadataCopy }
          if (namespaceTag !== null) merged._namespace = namespaceTag
          if (sessionIdTag !== null) {
            merged._session_id = sessionIdTag
            merged._conn_id = sessionIdTag
          }
          if (ccResolution.ccSessionId !== null) {
            merged._cc_session_id = ccResolution.ccSessionId
            merged._cc_session_src = ccResolution.src
            if (ccResolution.ambiguous) {
              merged._cc_session_ambiguous = true
              if (ccResolution.candidates) merged._cc_session_candidates = ccResolution.candidates
            }
          }
          if (stamp.src !== 'unregistered') Object.assign(merged, stampMetadata(stamp))
          opts.metadata = merged
        }
        if (media_ref) {
          const mappedMediaRef: MediaRef = {
            uri: media_ref.uri,
            mimeType: media_ref.mime_type,
          }
          if (media_ref.filename !== undefined) mappedMediaRef.filename = media_ref.filename
          if (media_ref.extension !== undefined) mappedMediaRef.extension = media_ref.extension
          if (media_ref.size_bytes !== undefined) mappedMediaRef.sizeBytes = media_ref.size_bytes
          if (media_ref.extracted !== undefined) mappedMediaRef.extracted = media_ref.extracted
          opts.mediaRef = mappedMediaRef
        }
        const result = await resolve().insert(content, opts)
        const source = metadata?.source === 'auto-capture' ? 'auto-capture' : 'manual'
        stats.recordInsert(source, Date.now() - t0)

        const response: Record<string, unknown> = {
          node_id: result.nodeId,
          path: result.path,
          depth: result.depth,
          deduplicated: result.deduplicated,
          drift_detected: result.driftDetected,
        }
        // D190: the writer the store stamped, said back — and when it
        // could not tell the caller apart from the session's other live
        // subagents, said so, never presented as fact.
        if (stamp.src !== 'unregistered') {
          response.writer = stamp.writer ?? null
          response.writer_src = stamp.src
          if (stamp.src === 'ambiguous') {
            const names = (stamp.candidates ?? []).map((c) => c.agent_type ?? c.agent_id)
            response.writer_candidates = stamp.candidates
            response.writer_note = `${names.length} subagents of this session were live (${names.join(', ')}), so the store `
              + `cannot tell which of them, or the session's own agent, wrote this entry: it is stamped `
              + `${stamp.writer ? `"${stamp.writer}"` : 'with no writer'} with the candidates recorded, and any entry it supersedes `
              + 'is recorded as a reference instead of retired. The call\'s own echo corrects the writer when it is captured.'
          } else if (stamp.src === 'provisional') {
            response.writer_note = `The ${stamp.writer} subagent is this session's one live subagent and the session's own agent has `
              + `been silent since it started, so this entry is stamped "${stamp.writer}" provisionally; the call's own echo `
              + 'confirms or corrects the writer when it is captured.'
          } else if (stamp.src === 'concurrent') {
            const names = (stamp.candidates ?? []).map((c) => c.agent_type ?? c.agent_id)
            response.writer_candidates = stamp.candidates
            response.writer_note = `A subagent of this session is live (${names.join(', ')}) but the session's own agent has been `
              + `active since it started, so this entry is stamped "${stamp.writer}", the session's own; the call's own echo `
              + 'corrects the writer when it is captured.'
          }
        }
        // A dedup hit lands no row: the references it carried went nowhere,
        // and the survivor is never modified to hold them (D169).
        if (result.refsNotRecorded && result.refsNotRecorded.length > 0) {
          response.refs_not_recorded = result.refsNotRecorded
          response.refs_note = 'This text is already in the journal, so no new entry was written and these refs were not recorded; '
            + 'reword the entry to record them.'
        }
        if (opts.supersedes) {
          response.superseded = result.superseded ?? []
          response.supersede_misses = result.supersedeMisses ?? []
          // D169: another writer's pointers are theirs to retire. The
          // targets stay live and untouched; this entry carries the
          // pointer, which their lane sees as referenced-by.
          if (result.referenced && result.referenced.length > 0) {
            response.referenced = result.referenced
            response.referenced_note = 'Written by another writer, so left live and unchanged; '
              + "recorded in this entry's refs, where that writer sees it as referenced-by."
          }
        }

        return { content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }] }
      } catch (err) {
        return toolError(err)
      }
    },
  )

  // ── treecontext_query ───────────────────────────────────────────

  server.registerTool(
    'treecontext_query',
    {
      description: 'Recall stored observations, decisions, findings, or passages from working memory.',
      inputSchema: z.object({
      query: z.string().min(1).max(5000).describe(
        'Natural language query, topic, or keyword phrase.',
      ),
      top_k: z.number().int().min(1).max(20).default(3).describe(
        'Number of results to return.',
      ),
      metadata_filter: z.record(z.string(), z.unknown()).optional().describe(
        'Optional metadata filter dict. Only entries whose metadata contains all specified key-value pairs are returned (AND semantics).',
      ),
      media_filter: z.object({
        filename: z.string().optional().describe('Substring match on filename'),
        extension: z.string().optional().describe('Exact match on file extension (without dot)'),
        mime_prefix: z.string().optional().describe('MIME type prefix match (e.g. "image/")'),
      }).optional().describe(
        'Filter results to entries with matching media references. Applied as a post-filter after retrieval.',
      ),
      namespace_weights: z.record(z.string(), z.number().min(0)).optional().describe(
        'Per-namespace score multiplier applied after retrieval. Unlisted '
        + 'namespaces use weight 1.0. Default: no re-ranking.',
      ),
      exclude_namespaces: z.array(z.string()).optional().describe(
        'Hard filter: drop results whose metadata._namespace is listed. '
        + 'Applied after retrieval.',
      ),
      adaptive: z.boolean().optional().describe(
        'Let the score distribution set the result count: top_k becomes a '
        + 'budget (fewer on an early break, up to adaptive_max past it); '
        + 'the response discloses _adaptive {returnedK, confidence, flat}. '
        + 'Flat distributions return the budget with flat=true, never a '
        + 'fabricated break — combined with recency_weight, always so. '
        + 'Off by default.',
      ),
      adaptive_max: z.number().int().min(1).max(50).optional().describe(
        'Maximum results when adaptive=true. Default: 3× top_k.',
      ),
      recency_weight: z.number().min(0).max(2).optional().describe(
        'Recency fusion weight. Default 0.5 at this surface (owner ruling '
        + '2026-08-01: broad orientation queries should favor the latest '
        + 'thread; the library default stays 0). Pass 0 for pure lexical '
        + 'ranking. Re-ranks by reciprocal rank fusion of the BM25 '
        + 'ordering with the same candidates ordered by capture time. '
        + 'Relevance ordering only: sort_by temporal queries and '
        + 'adaptive queries never receive the default.',
      ),
      time_range: z.object({
        after: z.number().optional().describe('Unix timestamp (seconds). Only return entries created after this time.'),
        before: z.number().optional().describe('Unix timestamp (seconds). Only return entries created before this time.'),
      }).optional().describe(
        'Filter results to a time window (Unix seconds).',
      ),
      sort_by: z.enum(['relevance', 'chronological', 'reverse_chronological']).optional().describe(
        'Result ordering: "relevance" (default), "chronological" (oldest '
        + 'first), "reverse_chronological" (newest first).',
      ),
      role_weights: z.object({
        user: z.number().min(0).max(10).optional().describe('Weight for user-authored text. Default 1.0.'),
        assistant: z.number().min(0).max(10).optional().describe('Weight for assistant prose text. Default 0.25.'),
        tool: z.number().min(0).max(10).optional().describe('Weight for tool-event text. Default 1.0.'),
        note: z.number().min(0).max(10).optional().describe('Weight for agent-authored (curated) text. Default 1.0.'),
      }).optional().describe(
        'Per-role bm25 column weights (0-10 each), this query only. Weight '
        + '0 down-ranks but never hides: MATCH is column-agnostic, so a '
        + 'row matching only through a weight-0 role stays in the results, '
        + 'ranked lower. Default: {user: 1.0, assistant: 0.25, tool: 1.0, '
        + 'note: 1.0}.',
      ),
      scope: z.enum(['all']).optional().describe(
        'While one subagent is the only live one and the session\'s own agent is '
        + 'waiting on it, a search is read as that subagent\'s and covers its role\'s '
        + 'trail and the plan it was spawned under; "all" searches the whole store. '
        + 'Otherwise every search covers the whole store. The reply\'s scope says which ran.',
      ),
      conversation_window: z.number().int().min(0).max(10).optional().describe(
        'Also return up to N same-session entries before and after each '
        + `hit (0-10, default ${String(DEFAULT_CONVERSATION_WINDOW)}; 0 disables). Neighbors don't count `
        + 'toward top_k and are not scored; each windowed hit also carries '
        + 'window.anchor — the nearest preceding user message in its '
        + 'session. time_range filters hits, not their windows.',
      ),
      }),
    },
    // The tree-era compat params (retrieval_mode, expansion_budget,
    // include_internal, modal_query, dense_weight, sparse_weight,
    // adaptive_method) left the schema at the slim-down (2026-07-27) —
    // unknown keys from old callers are stripped at the MCP layer, so a
    // legacy call degrades to plain BM25 instead of erroring. Teaching
    // prose lives in the reference skill; schemas carry the contract.
    async ({ query, top_k, metadata_filter, media_filter, namespace_weights, exclude_namespaces, adaptive, adaptive_max, recency_weight, time_range, sort_by, role_weights, conversation_window, scope }) => {
      const t0 = Date.now()
      try {
        await ensureReady()
        const liveCtx = resolve()
        const queryOpts: import('../core/types.js').QueryOptions = {
          topK: top_k,
        }
        if (metadata_filter) queryOpts.metadataFilter = metadata_filter
        if (media_filter) {
          const mappedMediaFilter: MediaFilter = {}
          if (media_filter.filename !== undefined) mappedMediaFilter.filename = media_filter.filename
          if (media_filter.extension !== undefined) mappedMediaFilter.extension = media_filter.extension
          if (media_filter.mime_prefix !== undefined) mappedMediaFilter.mimePrefix = media_filter.mime_prefix
          queryOpts.mediaFilter = mappedMediaFilter
        }
        if (role_weights) {
          const rw: import('../core/types.js').RoleWeights = {}
          if (role_weights.user !== undefined) rw.user = role_weights.user
          if (role_weights.assistant !== undefined) rw.assistant = role_weights.assistant
          if (role_weights.tool !== undefined) rw.tool = role_weights.tool
          if (role_weights.note !== undefined) rw.note = role_weights.note
          queryOpts.roleWeights = rw
        }
        // Search-modes wave (2026-07-26): recency fusion + adaptive count.
        // Default-on at this surface (owner ruling 2026-08-01): the MCP
        // layer serves cold-start orientation, where recency is signal —
        // the shadow arm below measured 0.5 before it became the default.
        // Explicit 0 opts out; the library default stays 0.
        let adaptiveMeta: { returnedK: number; confidence: number; flat: boolean } | undefined
        // The default does NOT apply to adaptive queries: fusion suppresses
        // the score-distribution break (documented in the adaptive param),
        // and the ruling must not silently degrade the bound adaptive-count
        // promise. Passing both explicitly still composes as documented
        // (budget returned, flat disclosed).
        // Nor to sort_by temporal queries: the schema promises the weight
        // applies to relevance ordering only, and the store's own guard is
        // unreachable here because sortBy never reaches it — fusion was
        // reshaping which entries a chronological listing even contained
        // (round-3 review, S4).
        const relevanceOrdered = sort_by === undefined || sort_by === 'relevance'
        const effectiveRecency = recency_weight ?? (adaptive || !relevanceOrdered ? 0 : DEFAULT_RECENCY_WEIGHT)
        if (effectiveRecency > 0) queryOpts.recencyWeight = effectiveRecency
        if (adaptive) {
          queryOpts.adaptive = true
          if (adaptive_max !== undefined) queryOpts.adaptiveMax = adaptive_max
          queryOpts.onAdaptive = (m) => { adaptiveMeta = m }
        }
        if (conversation_window !== undefined) {
          queryOpts.conversationWindow = conversation_window
        } else {
          // Spec amendment 2026-07-05: default 2 at the MCP layer only —
          // explicit 0 opts out.
          queryOpts.conversationWindow = DEFAULT_CONVERSATION_WINDOW
        }

        let results: QueryResult[]
        const timeRange: { after?: number; before?: number } | undefined = time_range
          ? {
            ...(time_range.after != null ? { after: time_range.after } : {}),
            ...(time_range.before != null ? { before: time_range.before } : {}),
          }
          : undefined
        // Push time_range/exclude_namespaces down to the store so hits are
        // filtered BEFORE window attachment — otherwise a dropped hit leaves
        // dangling anchor refs and claims neighbors away from surviving hits
        // (adversarial-review D1/D2, 2026-07-05).
        if (timeRange) queryOpts.timeRange = timeRange
        if (exclude_namespaces && exclude_namespaces.length > 0) {
          queryOpts.excludeNamespaces = exclude_namespaces
        }
        // D150: a caller the registry resolves to the session's one live
        // subagent, with the session's own agent silent since it started
        // (a provisional stamp), searches its role's trail and the plan it
        // was spawned under, not the whole store; `scope: "all"` widens
        // it. When a subagent is live but the caller cannot be told apart
        // (the session's own agent active beside it, or several live), the
        // search is the whole store and the reply says why. Every other
        // caller searches as before.
        let scopeNote: Record<string, unknown> | undefined
        if (scope !== 'all') {
          const cc = resolveCcSession()
          const stamp = writerStamp(liveCtx, cc)
          const scoping = liveCtx as Stamping
          if (stamp.src === 'provisional' && stamp.writer && cc.ccSessionId && typeof scoping.subagentScopeFor === 'function') {
            queryOpts.laneScope = scoping.subagentScopeFor(cc.ccSessionId, stamp.writer)
            scopeNote = {
              writer: stamp.writer,
              searched: `the ${stamp.writer} role's trail and the plan it was spawned under`,
              widen: 'pass scope "all" to search the whole store',
            }
          } else if (stamp.src === 'concurrent' || stamp.src === 'ambiguous') {
            scopeNote = {
              searched: 'the whole store',
              why: stamp.src === 'concurrent'
                ? "a subagent of this session is live but the session's own agent has been active beside it, so the caller cannot be told apart and no subagent scope applies"
                : 'several subagents of this session are live, so the caller cannot be told apart and no subagent scope applies',
            }
          }
        }
        results = await liveCtx.query(query, queryOpts)
        if (time_range) {
          const { after, before } = time_range
          results = results.filter(r => {
            if (after != null && r.createdAt < after) return false
            if (before != null && r.createdAt > before) return false
            return true
          })
        }
        if (sort_by === 'chronological') {
          results.sort((a, b) => a.createdAt - b.createdAt)
        } else if (sort_by === 'reverse_chronological') {
          results.sort((a, b) => b.createdAt - a.createdAt)
        }

        // Namespace-aware re-ranking / filtering (Phase 2).
        if (exclude_namespaces && exclude_namespaces.length > 0) {
          const excludeSet = new Set(exclude_namespaces)
          results = results.filter(r => {
            const ns = (r.metadata?._namespace as string | undefined) ?? null
            return ns === null || !excludeSet.has(ns)
          })
        }
        if (namespace_weights && Object.keys(namespace_weights).length > 0) {
          // Re-rank by multiplying similarity by per-namespace weight.
          const weighted = results.map(r => {
            const ns = (r.metadata?._namespace as string | undefined) ?? null
            const w = ns !== null && namespace_weights[ns] !== undefined ? namespace_weights[ns]! : 1.0
            return { result: r, weighted: r.similarity * w }
          })
          weighted.sort((a, b) => b.weighted - a.weighted)
          results = weighted.map(x => x.result)
        }

        // A defaulted window (caller omitted the param) must not decorate
        // session-less hits with empty "no-session-key" stubs — pure response
        // bloat on curated stores. An EXPLICIT request keeps the stub as a
        // diagnostic (adversarial-review D3, 2026-07-05).
        if (conversation_window === undefined) {
          for (const r of results) {
            if (r.window && r.window.omitted === 'no-session-key') delete r.window
          }
        }

        stats.recordQuery('bm25', Date.now() - t0, results.length)

        // Recency-ruling instrumentation (dev dogfood, 2026-07-26): one
        // JSONL line per query next to the store file, with a shadow
        // fusion for un-fused relevance queries. Observation only — the
        // response below is untouched. See src/server/query-telemetry.ts.
        const telPath = getInfo().storePath
        if (telPath && telemetryEnabled()) {
          const nowS = Date.now() / 1000
          const agesOf = (rs: QueryResult[]) => rs.map((r) => Math.round(((nowS - r.createdAt) / 86_400) * 10) / 10)
          const line: Record<string, unknown> = {
            ts: Math.floor(nowS),
            q: query,
            top_k,
            recency_weight: effectiveRecency,
            adaptive: !!adaptive,
            latency_ms: Date.now() - t0,
            returned: results.length,
            ages_d: agesOf(results),
            roles: results.map((r) => (r.metadata?.['role'] as string | undefined) ?? (r.metadata?.['type'] ? 'note' : 'unknown')),
          }
          if (sort_by) line['sort_by'] = sort_by
          if (adaptiveMeta) line['_adaptive'] = adaptiveMeta
          if (relevanceOrdered && results.length > 0) {
            try {
              // The instrument inverted when 0.5 became the served
              // default (2026-08-01): a fused response shadows the pure
              // lexical ordering (weight 0); an explicit opt-out shadows
              // what the default would have served.
              const shadowWeight = effectiveRecency > 0 ? 0 : SHADOW_RECENCY_WEIGHT
              const shadowOpts = { ...queryOpts, conversationWindow: 0 }
              if (shadowWeight > 0) shadowOpts.recencyWeight = shadowWeight
              else delete shadowOpts.recencyWeight
              delete shadowOpts.adaptive
              delete shadowOpts.adaptiveMax
              delete shadowOpts.onAdaptive
              const shadow = await liveCtx.query(query, shadowOpts)
              const shadowIds = shadow.map((r) => r.nodeId)
              const actualIds = results.map((r) => r.nodeId)
              line['shadow'] = {
                weight: shadowWeight,
                overlap: actualIds.filter((id) => shadowIds.includes(id)).length,
                top1_pos: shadowIds.indexOf(actualIds[0]!),
                ages_d: agesOf(shadow),
              }
            } catch {
              // The shadow arm is an instrument; its failure never surfaces.
            }
          }
          recordQueryTelemetry(telPath, line)
          dbg('server', 'query-telemetry', { q: query.slice(0, 40), rw: recency_weight ?? 0, shadow: 'shadow' in line })
        }

        const response: Record<string, unknown> = { results }
        if (adaptiveMeta) response._adaptive = adaptiveMeta
        if (scopeNote) response.scope = scopeNote

        return maybeShield('treecontext_query', { content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }] })
      } catch (err) {
        return toolError(err)
      }
    },
  )

  // ── treecontext_status ──────────────────────────────────────────

  server.registerTool(
    'treecontext_status',
    {
      description: 'Cold-start orientation panel. Returns journal statistics plus resume_pointers — IDs, kinds (chapter summary, or bookmark for metadata.kind="bookmark") and one-line previews of entries tagged metadata.next_session=true or metadata.status="active". Call this at session start; if resume_pointers is non-empty, fetch each via treecontext_export(node_id) BEFORE other work, even when the user has already given you specific pointers. Counts reflect the current namespace only.',
      inputSchema: z.object({
        scope: z.enum(['all']).optional().describe(
          'A session in a git worktree sees that worktree\'s own resume pointers by default; '
          + '"all" lists every lane\'s.',
        ),
      }),
    },
    async ({ scope }) => {
      try { await ensureReady() } catch (err) {
        warn(`[treecontext] ensureReady failed in status: ${err instanceof Error ? err.message : String(err)}`)
      }
      const c = resolve()
      const info = getInfo()
      // D167, D242: a session registered in a linked worktree orients on
      // its self, so status lists that worktree's own pointers unless
      // asked for every lane. The main checkout's status is unchanged.
      let lane: string | undefined
      if (scope !== 'all') {
        const cc = resolveCcSession()
        const selfing = c as Stamping
        if (cc.ccSessionId !== null && !cc.ambiguous && typeof selfing.selfOfSession === 'function') {
          try {
            const self = selfing.selfOfSession(cc.ccSessionId)
            if (self?.worktree) lane = selfWriterOf(self)
          } catch (err) {
            dbg('server', 'self lookup failed in status — every lane shown', { error: err instanceof Error ? err.message : String(err) })
          }
        }
      }
      // A lane is set only for a store that keeps the registry (FlatStore).
      const status = lane !== undefined ? (c as unknown as FlatStore).status({ lane }) : c.status()
      const response: Record<string, unknown> = {
        backend: status.backend ?? null,
        store_name: info.storeName ?? null,
        store_path: info.storePath ?? null,
        namespace: serverOpts.namespace ?? info.namespace ?? c.namespace,
        session_id: typeof serverOpts.sessionId === 'function' ? serverOpts.sessionId() : (serverOpts.sessionId ?? null),
        model_name: info.modelName ?? null,
        policy,
        read_only: policy === 'read_only',
        total_nodes: status.totalNodes,
        leaf_nodes: status.leafNodes,
        internal_nodes: status.internalNodes,
        max_depth: status.maxDepth,
        stale_summary_count: status.staleSummaryCount,
        ensemble_size: (status as { ensembleSize?: number }).ensembleSize ?? 1,
      }

      if (lane !== undefined) {
        const others = status.resumePointerOtherLanes ?? 0
        response.scope = {
          lane,
          listed: `the resume pointers of this worktree's own lane (${lane})`,
          other_lanes: others,
          widen: 'pass scope "all" to list every lane\'s pointers',
        }
      }
      if (status.resumePointers && status.resumePointers.length > 0) {
        response.resume_pointers = status.resumePointers.map((p) => ({
          node_id: p.nodeId,
          // D158: each live pointer says which kind of checkpoint it is.
          kind: p.kind === 'bookmark' ? 'bookmark' : 'chapter summary',
          ...(p.supersedes ? { supersedes: p.supersedes } : {}),
          preview: p.preview,
          metadata: p.metadata,
          // createdAt is Unix SECONDS — a bare Date(p.createdAt) renders 1970.
          created_at: new Date(p.createdAt * 1000).toISOString(),
        }))
        const total = status.resumePointerTotal ?? status.resumePointers.length
        const countText =
          total > status.resumePointers.length
            ? `Showing the newest ${status.resumePointers.length} of ${total} resume pointers — ` +
              'the rest are hidden; supersede stale pointers to clean up the orientation panel.'
            : `${status.resumePointers.length} resume pointer(s) tagged for cold-start orientation.`
        response.resume_message = (response.resume_message ? response.resume_message + ' ' : '') +
          countText + ' ' +
          'Fetch each via treecontext_export(node_id) before doing other work — these reflect plans/active threads from prior sessions.'
      }

      // Storage-budget gauge: over_budget means the retention valve could
      // not bring the store under its byte budget (protected rows are never
      // destroyed to meet it) — the condition is reported, never silent.
      if (status.retention) {
        response.storage = {
          store_bytes: status.retention.storeBytes,
          budget_bytes: status.retention.budgetBytes,
          over_budget: status.retention.overBudget,
          ...(status.retention.sessionCap !== undefined ? { session_cap: status.retention.sessionCap } : {}),
        }
        if (status.retention.overBudget) {
          // Names the knob in the file's own words (D141): the operator
          // raises the budget in the config file, never in a code constant.
          response.storage_warning =
            'Store exceeds its byte budget and remaining entries are protected from ' +
            'eviction/demotion. Export and clear old entries, or raise the budget: ' +
            `set ${STORE_BUDGET_CONFIG_KEY} in treecontext.toml (project) or ~/.treecontext/config.toml.`
        }
      }

      const sessionStats = stats.toJSON() as {
        query?: { latency?: { count: number; min: number; max: number; sum: number } }
      }
      response.session_stats = sessionStats

      // Retrieval-performance panel: enough for a user who feels slowness
      // to see whether retrieval is the cause and what lever to pull.
      // Caps come from capture config (activeIndexCap); db size from the
      // store file when it is file-backed.
      const capValue = (role: 'user' | 'assistant' | 'tool'): number | 'full' => {
        const cap = activeIndexCap(role)
        return Number.isFinite(cap) ? cap : 'full'
      }
      // Source must reflect whether the env value was ACCEPTED — a rejected
      // value (non-numeric, below floor) reporting "env:…" would tell the
      // user their override took effect when it was ignored.
      const envCap = envIndexCapOverride()
      const rawEnvCap = process.env['TREECONTEXT_INDEX_CAP']
      const indexCaps: Record<string, unknown> = {
        user: capValue('user'),
        assistant: capValue('assistant'),
        tool: capValue('tool'),
        source: envCap !== null ? 'env:TREECONTEXT_INDEX_CAP' : 'default',
      }
      if (envCap === null && rawEnvCap !== undefined && rawEnvCap !== '') {
        indexCaps.env_ignored =
          `TREECONTEXT_INDEX_CAP=${rawEnvCap} was ignored (must be a number >= ${INDEX_CAP_ENV_FLOOR})`
      }
      const retrieval: Record<string, unknown> = { index_caps: indexCaps }
      try {
        if (info.storePath && info.storePath !== ':memory:') {
          retrieval.db_bytes = statSync(info.storePath).size
        }
      } catch { /* store path may not exist yet; size is advisory */ }
      const latency = sessionStats.query?.latency
      if (latency && latency.count > 0) {
        const meanMs = latency.sum / latency.count
        retrieval.query_latency_ms = {
          count: latency.count,
          mean: Math.round(meanMs * 10) / 10,
          max: Math.round(latency.max * 10) / 10,
        }
        // Advisory, not a gate: the cap sweep measured an 8000-char view
        // keeping recall within noise of full-text on tool-shaped corpora,
        // so pointing at TREECONTEXT_INDEX_CAP is safe advice.
        if (latency.count >= 5 && meanMs > 250) {
          retrieval.performance_hint =
            `Queries are averaging ${Math.round(meanMs)}ms this session. If retrieval feels slow, ` +
            `set TREECONTEXT_INDEX_CAP=8000 in the environment running the hooks: new captures' ` +
            `searchable view is bounded to that many chars (stored text is unaffected and existing ` +
            `entries keep their view). Measured cost of 8000 vs full indexing: recall within noise ` +
            `on tool-shaped text, about a third of the query latency.`
        }
      }
      response.retrieval = retrieval

      return { content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }] }
    },
  )

  // ── treecontext_delete (mutating) ───────────────────────────────

  if (policyAllows(policy, 'treecontext_delete')) server.registerTool(
    'treecontext_delete',
    {
      description: 'Delete an entry from the journal by its node_id.',
      inputSchema: z.object({
      node_id: z.string().min(1).describe(
        'The ID of the node to delete.',
      ),
      }),
    },
    async ({ node_id }) => {
      try {
        await ensureReady()
        resolve().delete(node_id)
        stats.recordDelete()
        return { content: [{ type: 'text' as const, text: JSON.stringify({ deleted: true, node_id }) }] }
      } catch (err) {
        if (err instanceof NodeNotFoundError) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Node ${node_id} not found` }) }], isError: true }
        }
        return toolError(err)
      }
    },
  )

  // ── treecontext_clear (mutating) ────────────────────────────────

  if (policyAllows(policy, 'treecontext_clear')) server.registerTool(
    'treecontext_clear',
    {
      description: "Clear this namespace's entire journal and start fresh. This is irreversible.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        await ensureReady()
        const result = resolve().clear()
        stats.recordClear()
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              cleared: result.cleared,
              previous_node_count: result.previousNodeCount,
            }, null, 2),
          }],
        }
      } catch (err) {
        return toolError(err)
      }
    },
  )

  // ── treecontext_export ──────────────────────────────────────────

  server.registerTool(
    'treecontext_export',
    {
      description: 'Fetch an entry by ID — use this to read resume pointers '
        + 'surfaced by treecontext_status (treecontext_query cannot find entries by '
        + 'UUID); an entry others refer to carries referencedBy, the newest '
        + 'referrer and the count, one hop deep. Omit node_id to export a handoff '
        + 'for a teammate: by default the chapter summaries and subagent summaries '
        + 'only; form "whole" exports the whole journal, a deliberate choice behind a '
        + 'secrets warning. With path, the server writes the handoff file itself inside '
        + 'the project directory and only the file name and counts come back; without '
        + 'it the export returns inline, capped at the newest 10000 entries. Export never '
        + 'writes the journal, so it stays available under the read_only policy — but with '
        + 'path it does write that file, read_only or not.',
      inputSchema: z.object({
      node_id: z.string().optional().describe(
        'Entry to fetch. Omit to export a handoff.',
      ),
      form: z.enum(['summaries', 'whole']).optional().describe(
        'What a handoff carries: "summaries" (the default) — the chapter summaries and '
        + 'subagent summaries; "whole" — every entry, captured tool output included.',
      ),
      path: z.string().min(1).max(4096).optional().describe(
        'Write the handoff to this file, relative to the project directory (e.g. '
        + '"handoffs/login-plan.json"). Only paths inside the project directory are accepted. '
        + 'A file carries every entry, no cap, and none of it enters the conversation.',
      ),
      secrets_acknowledged: z.boolean().default(false).describe(
        'Required true for form "whole": captured tool output can hold secrets, tokens and '
        + 'keys. Without it a whole export writes nothing and returns the warning.',
      ),
      max_export_nodes: z.number().int().min(1).max(INLINE_EXPORT_CAP).default(INLINE_EXPORT_CAP).describe(
        'Inline only: the newest this many entries are returned; the reply states how many '
        + 'were omitted. Ignored with path.',
      ),
      writer: z.string().min(1).optional().describe(
        "Instead of a handoff: one writer's trail on its own, oldest first — every entry the "
        + 'store stamped with that writer: a subagent role such as "tester", one subagent\'s '
        + 'agent id, "main" (the main checkout\'s own lane, older unstamped rows included) or '
        + '"worktree:<name>". Capped like an inline export; the reply states omitted.',
      ),
      }),
    },
    async ({ node_id, form, path, secrets_acknowledged, max_export_nodes, writer }) => {
      try {
        await ensureReady()
        if (node_id) {
          if (path !== undefined || form !== undefined) {
            throw new Error('node_id fetches one entry; form and path belong to a handoff export — pass one or the other')
          }
          const exportOpts: { maxExportNodes?: number; nodeId?: string; recordReliance?: boolean } = {
            maxExportNodes: max_export_nodes,
            nodeId: node_id,
            // Reliance bookkeeping is a WRITE. Only a full-policy server may
            // record it — read_only's contract is "consumes context but
            // never mutates it", and contributor may only add (third-pass
            // review: a --read-only sub-agent's mandated cold-start exports
            // were mutating the shared store's eviction ordering).
            recordReliance: policy === 'full',
          }
          const json = resolve().exportJson(exportOpts)
          const parsed = JSON.parse(json) as { node_count?: number }
          stats.recordExport(parsed.node_count ?? 0)
          return maybeShield('treecontext_export', { content: [{ type: 'text' as const, text: json }] })
        }
        if (writer !== undefined) {
          // D148: a writer's trail is a read, not a handoff — it bypasses
          // the summaries default and returns that writer's rows alone.
          if (path !== undefined || form !== undefined) {
            throw new Error('writer reads one writer\'s trail; form and path belong to a handoff export — pass one or the other')
          }
          const trailing = resolve() as MemoryStore & Partial<Pick<FlatStore, 'writerTrail'>>
          if (typeof trailing.writerTrail !== 'function') throw new Error('this store keeps no writer stamps')
          const trail = trailing.writerTrail(writer, max_export_nodes)
          stats.recordExport(trail.nodes.length)
          const omitted = trail.total - trail.nodes.length
          const body: Record<string, unknown> = { writer, node_count: trail.nodes.length, ...(omitted > 0 ? {
            omitted,
            omitted_note: `The trail holds ${trail.total} entries; the newest ${trail.nodes.length} are shown, oldest first. `
              + 'Narrow it with treecontext_query and its time_range, or export the whole journal to a file.',
          } : {}), nodes: trail.nodes }
          return maybeShield('treecontext_export', { content: [{ type: 'text' as const, text: JSON.stringify(body) }] })
        }
        const chosen: HandoffForm = form ?? 'summaries'
        // The path rule first (D199): a refused path writes nothing and
        // says where a handoff may go.
        let target: { abs: string; rel: string } | null = null
        if (path !== undefined) {
          const where = resolveProjectPath(projectDir, path, 'write')
          if (!where.ok) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: where.reason, project_dir: where.root }, null, 2) }],
              isError: true as const,
            }
          }
          target = where
        }
        const store = resolve()
        // D177: the whole journal is a deliberate choice, and the warning
        // comes before anything is written — this reply writes nothing.
        if (chosen === 'whole' && !secrets_acknowledged) {
          const { total } = store.handoffRows('whole', 0)
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                warning: SECRETS_WARNING,
                written: false,
                entries: total,
                message: `Nothing was written. To export the whole journal (${total} ${total === 1 ? 'entry' : 'entries'}) anyway, `
                  + 'call treecontext_export again with form "whole" and secrets_acknowledged: true.',
              }, null, 2),
            }],
          }
        }
        if (target !== null) {
          const built = buildHandoff(store, { form: chosen, project: projectName, path: target.rel })
          writeHandoffFile(target.abs, built.text)
          stats.recordExport(built.entries)
          // D170/D199: only the file's name and the counts enter the
          // conversation.
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                file: target.rel,
                entries: built.entries,
                message: `Wrote ${built.entries} ${built.entries === 1 ? 'entry' : 'entries'} to ${target.rel}.`,
              }, null, 2),
            }],
          }
        }
        const built = buildHandoff(store, { form: chosen, project: projectName, path: null, inlineLimit: max_export_nodes })
        stats.recordExport(built.entries)
        return maybeShield('treecontext_export', { content: [{ type: 'text' as const, text: built.text }] })
      } catch (err) {
        return toolError(err)
      }
    },
  )

  // ── treecontext_import (mutating) ───────────────────────────────

  if (policyAllows(policy, 'treecontext_import')) server.registerTool(
    'treecontext_import',
    {
      description: 'Import a handoff file (an exported journal) from a teammate or another agent. '
        + 'Give path to have the server read the file itself from inside the project directory '
        + '(no size cap, nothing of it enters the conversation), or data with a label for pasted content. '
        + 'Everything new lands; anything already in the store is left alone, and the reply '
        + 'counts both. Every imported entry is marked as imported from that file by you; the '
        + "file's own claims about who wrote an entry are kept on it as data, not trusted.",
      inputSchema: z.object({
      path: z.string().min(1).max(4096).optional().describe(
        "The handoff file, relative to the project directory (e.g. 'handoffs/login-plan.json'). "
        + "The server reads it; its path is recorded on every imported entry as the file it came from.",
      ),
      data: z.string().min(1).max(5 * 1024 * 1024).optional().describe(
        'Instead of path: the JSON string from a previous treecontext_export call (max 5 MB).',
      ),
      label: z.string().min(1).max(200).optional().describe(
        "With data: the handoff file's name (e.g. 'handoffs/login-plan.json'), recorded on every imported "
        + 'entry as the file it came from.',
      ),
      read_only: z.boolean().default(true).describe(
        'If true, imported nodes cannot be modified — only queried.',
      ),
      }),
    },
    async ({ path, data, label, read_only }) => {
      try {
        await ensureReady()
        let json: string
        let file: string
        if (path !== undefined) {
          if (data !== undefined || label !== undefined) {
            throw new Error('path names the file the server reads; data and label are for pasted content — pass one or the other')
          }
          const where = resolveProjectPath(projectDir, path, 'read')
          if (!where.ok) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: where.reason, project_dir: where.root }, null, 2) }],
              isError: true as const,
            }
          }
          json = readFileSync(where.abs, 'utf8')
          file = where.rel
        } else {
          if (data === undefined) throw new Error('import needs path (a handoff file in the project) or data (pasted export JSON)')
          if (label === undefined) throw new Error("data needs a label: the handoff file's name, recorded on every imported entry")
          json = data
          file = label
        }
        // The importer's own marks (D165): the file is named by its path
        // or the label, the importer is this server's session — never the
        // file's claims. A file read by path is still a handoff (D222).
        let result: Awaited<ReturnType<MemoryStore['importJson']>>
        try {
          result = await resolve().importJson(json, {
            label: file,
            readOnly: read_only,
            handoff: { file, importer: resolveCcSession().ccSessionId },
            ...(path !== undefined ? { fromFile: true } : {}),
          })
        } catch (err) {
          // A parse error quotes the text it choked on; a project file read
          // by path may hold secrets, so nothing of it is echoed (D234).
          if (err instanceof SyntaxError) throw new Error(`${file} is not a handoff file`)
          throw err
        }
        stats.recordImport(result.importedCount)
        const landed = result.importedCount
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              imported_count: landed,
              landed,
              already_present: result.alreadyPresent,
              ...(result.idConflicts > 0 ? { id_conflicts: result.idConflicts } : {}),
              ...(result.skippedEmpty > 0 ? { skipped_empty: result.skippedEmpty } : {}),
              ...(result.skippedMalformed > 0 ? { skipped_malformed: result.skippedMalformed } : {}),
              label: result.label,
              sender: result.sender ?? null,
              message: importToldMessage(result),
            }, null, 2),
          }],
        }
      } catch (err) {
        return toolError(err)
      }
    },
  )

  // ── treecontext_merge_from_agent (mutating, full-only) ──────────

  if (policyAllows(policy, 'treecontext_merge_from_agent')) server.registerTool(
    'treecontext_merge_from_agent',
    {
      description: 'Merge a sub-agent namespace\'s entries into the current namespace with provenance. Source namespace must live in the same store. Repeating a merge adds nothing: each copy carries a pointer to its source entry. Full-policy only.',
      inputSchema: z.object({
      source_namespace: z.string().min(1).max(200).describe(
        'Namespace to pull from (e.g. "agent-a"). Must differ from the current namespace.',
      ),
      label: z.string().min(1).max(200).describe(
        'Label recorded on the merged entries (e.g., "agent-a-findings").',
      ),
      node_id: z.string().optional().describe(
        'Optional entry ID in the source namespace to merge alone. Omit to merge the whole source namespace.',
      ),
      read_only: z.boolean().default(true).describe(
        'If true (default), merged nodes cannot be modified locally.',
      ),
      }),
    },
    async ({ source_namespace, label, node_id, read_only }) => {
      try {
        await ensureReady()
        const mergeOpts: { label: string; nodeId?: string; readOnly?: boolean } = {
          label,
          readOnly: read_only,
        }
        if (node_id) mergeOpts.nodeId = node_id
        const result = resolve().mergeFromNamespace(source_namespace, mergeOpts)
        stats.recordImport(result.importedCount)
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              imported_count: result.importedCount,
              // A7 (docs/project-identity.md §5.3): additive, and
              // load-bearing — without it a merge that dropped half its
              // input to the dedup predicate reads exactly like a clean
              // one.
              skipped_duplicate: result.skippedDuplicate,
              // D144: the already-carried class, so a re-run's zero is
              // legible as "all present".
              skipped_already_merged: result.skippedAlreadyMerged,
              label: result.label,
              source_namespace: result.sourceNamespace,
              replaced: result.replaced,
            }, null, 2),
          }],
        }
      } catch (err) {
        return toolError(err)
      }
    },
  )

  return server
}

// ── Server entry point ──────────────────────────────────────────────

export type McpTransport = 'stdio'

export interface StartServerOptions {
  /** SQLite database handle for the store. */
  database: Database
  /** Namespace within the store. Default: 'project'. */
  namespace?: string
  /** Run schema migrations on open. Default: true via the factory. */
  migrate?: boolean
  /** Explicit backend override forwarded to createMemoryStore. `serve
   *  --lexical` passes 'lexical' so an embedder-built (tree-era) store
   *  opens as a FlatStore over the same rows instead of refusing. See
   *  memory-store-factory.resolveBackendMode. */
  backend?: BackendMode
  /** Namespace primary-claim hook forwarded to createServer — see
   *  CreateServerOptions.lockHook. Used by the lexical CLI path, which has
   *  no CtxManager to hold and heartbeat the namespace lease. */
  lockHook?: () => void
  /** Runs first in the shutdown sequence, before the database closes —
   *  the lease-release moment (G4). */
  onShutdown?: () => void
  /** Drain-role arbitration forwarded to the IngestionLoop (G4): each
   *  tick try-acquires 'drain' and skips when held elsewhere. */
  drainLease?: { client: import('../persistence/leases.js').LeaseClient; ttlSecs: number }
  /** Forwarded to every FlatStore this server opens — renews the serve
   *  process's leases before the store's long synchronous phases (see
   *  FlatStoreOptions.maintenanceHeartbeat). */
  maintenanceHeartbeat?: () => void
  /** The project directory the server was started for — see
   *  CreateServerOptions.projectDir. */
  projectDir?: string
  /** Transport type. Default: 'stdio'. */
  transport?: McpTransport
  /** Byte threshold for output shielding. 0 = disabled. */
  shieldThreshold?: number
  /** Directory for shielded output files. */
  shieldDir?: string
  /** Store-byte budget for every FlatStore this server opens — the config
   *  file's `[retention] max_store_bytes` (D141). Absent: the default. */
  maxStoreBytes?: number
  /** Session cap for every FlatStore this server opens — the config
   *  file's `[retention] max_sessions` (D141). Absent: the default. */
  maxSessions?: number
  /** Enable conversation capture ingestion loop. Default: false. */
  capture?: boolean
  /**
   * Disable mutating tools (insert, update_summary, delete, clear,
   * feedback, import). Sub-agents connecting to a shared project store
   * pass --read-only. Default: false.
   *
   * Equivalent to `policy: 'read_only'`. `policy` takes precedence.
   */
  readOnly?: boolean
  /** Tool-access policy. See `policy.ts`. Overrides `readOnly`. */
  policy?: Policy
  /** Runtime metadata surfaced by treecontext_status. */
  info?: CreateServerOptions['info']
  /**
   * Handshake instructions variant. 'none' sends an empty string — for
   * clients whose hook channel (SessionStart reminder) already delivers
   * the orientation trigger. Default: 'brief' (the measured activation
   * winner).
   */
  instructions?: 'brief' | 'none'
  /**
   * Write the sidecar panes beside the store on each drain (see
   * `sidecar-blob.ts`). Reached only when this process owns the drain, so a
   * second server on the same store never overwrites the holder's panes.
   * Default: true.
   */
  sidecar?: boolean
}

/**
 * Per-STEP budget for the shutdown watchdog. It bounds an ASYNC stall
 * only: better-sqlite3 closes synchronously, so a long WAL checkpoint
 * blocks the very loop the timer would have to fire on and is immune by
 * construction — the deadline can only land at an await, which is
 * exactly where a wedge shows itself. Ten seconds with no step
 * completing is a wedge, not slowness.
 */
export const SHUTDOWN_STEP_BUDGET_MS = 10_000

/** The armed watchdog: `progress()` after each completed shutdown step,
 *  `clear()` when the sequence is done. */
export interface ShutdownWatchdog {
  progress: () => void
  clear: () => void
}

/**
 * The hard exit that guarantees a shutdown ENDS. The decision to exit,
 * once made, cannot be unmade by a wedged close: an event loop drowning
 * in a dead-peer write storm (the 2026-08-30 orphan spin) once kept a
 * headless server alive at 100% CPU with SIGTERM landing in the
 * shuttingDown guard forever.
 *
 * ab58c27 spelled it as one flat 5s deadline armed before any close
 * work, which could not tell a wedge from a close still MAKING PROGRESS
 * — a WAL checkpoint on a multi-GB store, or an attribution handle on a
 * slow network filesystem, outruns any fixed budget, and killing it
 * mid-flush truncates the very capture the shutdown is there to flush
 * and turns a clean exit into exit(1) (rc.6 review). So the deadline is
 * per step and re-armed by progress: each completed step buys the next
 * one a fresh window, and only a step that stalls for a WHOLE window
 * earns the hard exit. unref'd, so the deadline never holds the loop
 * open when the closes finish first.
 */
export function armShutdownWatchdog(
  budgetMs: number = SHUTDOWN_STEP_BUDGET_MS,
  exit: (code: number) => void = process.exit,
): ShutdownWatchdog {
  let timer: ReturnType<typeof setTimeout> | null = null
  const arm = (): void => {
    timer = setTimeout(() => exit(1), budgetMs)
    timer.unref()
  }
  arm()
  return {
    progress: () => {
      if (timer) clearTimeout(timer)
      arm()
    },
    clear: () => {
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}

export async function startServer(opts: StartServerOptions): Promise<void> {
  const {
    transport = 'stdio',
    shieldThreshold,
    shieldDir,
    readOnly = false,
    policy,
    info,
    instructions = 'brief',
    backend,
  } = opts
  // Legacy shield hygiene runs at STARTUP as well as shutdown (pass-3
  // review 2026-08-15): the chmod-0600 tightening is the fix for a
  // world-readable exposure on shared machines, and a fix that waits
  // for a clean shutdown leaves the window open for the whole session —
  // or forever after a SIGKILL. Best-effort, never blocks serving.
  try { cleanLegacyShieldDir() } catch { /* hygiene, not startup-critical */ }

  // One fact, one wiring (pass-2 review 2026-08-15): the maintenance
  // heartbeat defaults to the drain-lease client's renewAll. The two
  // options describe the same LeaseClient, and an embedder passing
  // drainLease without the separate heartbeat option silently lost the
  // before-VACUUM renew — the exact starvation the option was added to
  // close.
  const maintenanceHeartbeat = opts.maintenanceHeartbeat
    ?? (opts.drainLease ? () => { opts.drainLease!.client.renewAll() } : undefined)
  // The config file's [retention] keys reach EVERY handle this server
  // opens — the serving one and each drain-side namespace handle — since
  // each runs its own sweep and a handle on the default would evict
  // against a budget the operator never set (D141).
  const retention = {
    ...(opts.maxStoreBytes !== undefined ? { maxStoreBytes: opts.maxStoreBytes } : {}),
    ...(opts.maxSessions !== undefined ? { maxSessions: opts.maxSessions } : {}),
  }
  ctx = await createMemoryStore({
    database: opts.database,
    ...(backend ? { backend } : {}),
    ...(opts.namespace ? { namespace: opts.namespace } : {}),
    ...(opts.migrate !== undefined ? { migrate: opts.migrate } : {}),
    ...(maintenanceHeartbeat ? { maintenanceHeartbeat } : {}),
    ...retention,
  })
  const resolvedPolicy: Policy = effectivePolicy(policy, readOnly)
  const createOpts: CreateServerOptions = {
    policy: resolvedPolicy,
    transport,
    ...(shieldThreshold !== undefined ? { shieldThreshold } : {}),
    ...(shieldDir ? { shieldDir } : {}),
    instructions: resolveInstructions(instructions),
  }
  if (info) createOpts.info = info
  if (opts.lockHook) createOpts.lockHook = opts.lockHook
  if (opts.projectDir) createOpts.projectDir = opts.projectDir

  if (resolvedPolicy !== 'full') {
    dbg('startup', `Policy: ${resolvedPolicy} — limited tool set`)
  }

  /**
   * The sidecar panes ride on the drain, so they are wired here and nowhere
   * else — reaching this code at all means capture is on, which means this
   * process holds the store lock and owns the drain. A server that lost the
   * lock never gets here and therefore never overwrites the holder's panes
   * with numbers from a drain it did not run. That refusal is structural
   * rather than a check, which is why there is no check.
   *
   * Silently absent (no pane, no error) when: the caller turned it off, the
   * store is in-memory (there is no directory to write beside), or the
   * backend cannot report vitals.
   */
  const sidecarOptions = (c: IngestibleStore): IngestionOptions => {
    const storePath = opts.info?.storePath
    const storeName = opts.info?.storeName
    if (opts.sidecar === false || !storePath || storePath === ':memory:' || !storeName) return {}
    if (!isVitalsSource(c)) return {}
    const source = c
    return {
      onBatch: ({ failure }) =>
        publishSidecarPanes({
          source,
          storePath,
          storeName,
          // The drain's moment, taken once and used for every window on
          // both panes — see sidecar-blob.ts. Seconds, matching the
          // journal's own timestamps.
          atSec: Date.now() / 1000,
          failure,
        }),
    }
  }

  // Helper: set up the capture subsystem (IngestionLoop over staging).
  let ingestionLoop: IngestionLoop | null = null
  // C1 attribution handles: per-namespace stores the drain opened beyond
  // the serving one (tests/server/design/multi-user.md). Closed at
  // shutdown BEFORE ctx — ctx owns the shared database connection.
  const extraHandles: IngestibleStore[] = []
  const initCapture = async (): Promise<void> => {
    dbg('capture', 'initCapture called', { captureFlag: !!opts.capture, hasCtx: !!ctx })
    if (!captureEnabled(opts.capture, resolvedPolicy)) {
      if (opts.capture && resolvedPolicy === 'read_only') {
        warn(
          '[treecontext] capture requested but policy is read_only — ' +
          'captured events will not be ingested.',
        )
      }
      dbg('capture', 'capture disabled — skipping ingestion setup', {
        capture: !!opts.capture,
        policy: resolvedPolicy,
      })
      return
    }
    const c = ctx
    if (!c) {
      dbg('capture', 'no ctx available — skipping')
      return
    }
    // Staging drains straight into the store as `auto-capture` nodes,
    // governed by D6 retention (Step 6A). One store; nothing to promote.
    if (isIngestible(c)) {
      // C1: the drain serves every namespace of the store. Each staged
      // row drains into the tree its stamp names, through a cached
      // per-namespace handle (create-if-absent); the serving handle seeds
      // the cache so the single-namespace case allocates nothing new.
      const namespaceHandles = new Map<string, IngestibleStore>()
      namespaceHandles.set(opts.namespace ?? 'project', c)
      const storeFor = async (ns: string): Promise<IngestibleStore> => {
        const cached = namespaceHandles.get(ns)
        if (cached) return cached
        const h = await createMemoryStore({
          database: opts.database,
          ...(backend ? { backend } : {}),
          namespace: ns,
          ownsDatabase: false,
          migrate: false,
          // Drain-side handles insert too, so their sweeps block the
          // same event loop the serve leases heartbeat on.
          ...(maintenanceHeartbeat ? { maintenanceHeartbeat } : {}),
          ...retention,
        })
        if (!isIngestible(h)) {
          await h.close()
          throw new Error(`Backend for namespace '${ns}' lacks staging access`)
        }
        namespaceHandles.set(ns, h)
        extraHandles.push(h)
        return h
      }
      ingestionLoop = new IngestionLoop(c, {
        ...sidecarOptions(c),
        storeFor,
        ...(opts.drainLease ? { drainLease: opts.drainLease } : {}),
        // §7.8: where the drain publishes session-keyed namespace
        // annotations from echo evidence. In-memory stores have no
        // sessions/ directory to publish into.
        ...(opts.info?.storePath && opts.info.storePath !== ':memory:'
          ? { storePath: opts.info.storePath }
          : {}),
      })
      dbg('capture', 'ingestion ready')
    } else {
      warn(
        '[treecontext] capture requested but backend lacks staging access — ' +
        'captured events will not be ingested.',
      )
      return
    }
    ingestionLoop.start()
    ingestionLoopRef = ingestionLoop
    dbg('capture', 'ingestion loop started')
  }

  if (transport === 'stdio') {
    dbg('startup', 'creating stdio transport', { platform: process.platform, nodeVersion: process.version, pid: process.pid })

    // The shutdown sequence and the dead-peer watch are wired FIRST,
    // ahead of the transport and of initCapture's awaits. stdin emits
    // 'end' exactly once — the moment the transport's first read reaches
    // the EOF a departed client left behind — and a listener attached
    // after that turn of the loop hears nothing at all. Wiring it after
    // startup therefore left a client that died DURING startup (a slow
    // migration, a big store open, a namespace handle on a cold disk)
    // with an immortal orphan holding its store open and no peer to
    // notice: the exact fate the dead-peer shutdown exists to prevent
    // (carried-over rc.6 review of ab58c27). The rest of the lifecycle
    // — stdout death, signals, the last-resort handlers — still wires
    // below, once there is a session to end; the shuttingDown guard
    // makes the two wirings one shutdown regardless of which fires.
    let server: ReturnType<typeof createServer> | null = null
    let shuttingDown = false
    const shutdown = async (reason: string): Promise<void> => {
      if (shuttingDown) return
      shuttingDown = true
      const watchdog = armShutdownWatchdog()
      dbg('shutdown', `shutting down: ${reason}`)
      try {
        opts.onShutdown?.()
      } catch {
        /* lease release is best-effort; TTL expiry covers it */
      }
      cleanShieldDir(defaultShieldConfig({
        thresholdBytes: shieldThreshold ?? 0,
        ...(shieldDir ? { shieldDir } : {}),
      }))
      // Pre-lockdown releases shielded into the shared tmpdir; sweep
      // those leftovers until they are gone (F review 2026-08-15).
      cleanLegacyShieldDir()
      if (ingestionLoop) ingestionLoop.stop()
      // The namespace annotation is deliberately NOT removed here — see
      // writeNamespaceAnnotation: unlink-at-exit races a restarted
      // server's fresh write; guards defuse leftovers instead.
      // Attribution handles first — ctx owns the shared database.
      for (const h of extraHandles) {
        try { await h.close() } catch { /* shutdown is best-effort */ }
        watchdog.progress()
      }
      // Optional chaining, not an assertion: a peer that died mid-startup
      // reaches this with the transport not yet built.
      await ctx?.close()
      watchdog.progress()
      await server?.close()
      watchdog.clear()
      process.exit(0)
    }
    process.stdin.on('end', () => shutdown('stdin closed'))
    process.stdin.on('error', () => shutdown('stdin error'))

    server = createServer(undefined, createOpts)
    const t = new StdioServerTransport()
    await server.connect(t)
    dbg('startup', 'stdio transport connected')

    // C1 namespace annotation (design note §C1): tell this session's hooks
    // which namespace their captures belong to. Stdio-only — the ppid
    // identity argument (exec chain) holds only here — and advisory: any
    // serving process knows its session's namespace, drain owner or not.
    const annotationDbPath =
      info?.storePath && info.storePath !== ':memory:' ? info.storePath : null
    if (annotationDbPath) {
      writeNamespaceAnnotation(annotationDbPath, process.ppid, opts.namespace ?? 'project')
    }

    await initCapture()

    // stdout is the MCP channel itself: a peer that closed it can never
    // hear another response, so its death ends the session exactly as a
    // closed stdin does. (The CLI's storm-proofing listener swallows
    // the write error; this one acts on it.)
    process.stdout.on('error', () => shutdown('stdout closed'))
    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGHUP', () => shutdown('SIGHUP'))
    // Each says so once and starts the shutdown; once the shutdown is
    // under way they stay silent. Were the stderr guard ever to lapse,
    // every dead-stream error would re-enter here, and a handler that
    // warned each time fed the storm it was reporting (260 MB of log in
    // fifteen seconds, measured with the guard removed).
    process.on('uncaughtException', (err) => {
      if (shuttingDown) return
      warn('[treecontext] uncaught exception:', err)
      shutdown('uncaughtException')
    })
    process.on('unhandledRejection', (err) => {
      if (shuttingDown) return
      warn('[treecontext] unhandled rejection:', err)
      shutdown('unhandledRejection')
    })
    return
  }

  // The HTTP transport was tombstoned at the 0.1 corpus audit
  // (2026-08-12): its tree-era consumers (embedding daemon, shared
  // multi-client daemon) are gone, the library runs in-process, and the
  // audit proved the surface unused. The parser refuses
  // --transport http with a curated message before this is reachable.
  throw new Error(`Unsupported transport: ${transport as string}`)
}
