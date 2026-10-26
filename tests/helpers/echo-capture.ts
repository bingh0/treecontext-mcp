/**
 * Treecontext echoes, captured the way Claude Code captures them (D261).
 *
 * An echo is the PostToolUse capture of a treecontext tool call. These
 * helpers make one the way the platform does: the call goes through the
 * real MCP server, and the hook payload's `tool_response` is the ACTUAL
 * content array the client received (never a hand-built fixture), fed to
 * the real post-tool-use hook subprocess; the production drain then
 * stamps it. The readers below inspect the result in SQLite directly
 * (the verification rule): the row, its stamps and the FTS index.
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Client } from '@modelcontextprotocol/client'
import { decodeContent } from '../../src/persistence/content-codec.js'
import { openNodeSqlite } from '../../src/persistence/node-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { type CaptureWorld, openCaptureSandbox, spawnHook, drainStaging } from '../journal/capture-harness.js'
import { mcpOver } from '../journal/world.js'
import { parseToolResult } from './mcp-result.js'

/** The hook's tool name for a treecontext tool (the server key the
 *  installer registers is `treecontext`). */
export const echoTool = (tool: string): string => `mcp__treecontext__${tool}`

/** A PostToolUse payload in the reference platform's shape for an MCP call. */
export function echoPayload(
  w: CaptureWorld, tool: string, input: Record<string, unknown>, response: unknown, sessionId?: string,
): Record<string, unknown> {
  return {
    ...(sessionId ? { session_id: sessionId } : {}),
    transcript_path: join(w.proj!, 'transcript.jsonl'),
    hook_event_name: 'PostToolUse',
    permission_mode: 'default',
    tool_name: echoTool(tool),
    tool_input: input,
    tool_response: response,
  }
}

/** Call a treecontext tool through the real server and return the hook
 *  payload that echoes it, plus the parsed response. */
export async function callEchoed(
  w: CaptureWorld, client: Client, tool: string, input: Record<string, unknown>, sessionId?: string,
): Promise<{ payload: Record<string, unknown>; response: Record<string, unknown> }> {
  const res = await client.callTool({ name: tool, arguments: input })
  const content = (res as { content: Array<{ text: string }> }).content
  return {
    payload: echoPayload(w, tool, input, content, sessionId),
    response: JSON.parse(content[0]!.text) as Record<string, unknown>,
  }
}

export interface RawEcho {
  rowid: number
  nodeId: string
  toolName: string
  content: string
  /** The stored bytes as SQLite holds them (possibly zstd), for byte-for-byte comparison. */
  stored: Buffer
  metadataJson: string
  metadata: Record<string, unknown>
  indexLen: number | null
  previewLen: number | null
  indexCol: number | null
}

/** Every treecontext echo in the store, read raw through a readonly handle. */
export function rawEchoes(dbPath: string): RawEcho[] {
  const raw = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const rows = raw.prepare(
      'SELECT rowid, node_id, content, metadata_json, index_len, preview_len, index_col FROM nodes ' +
        "WHERE json_extract(metadata_json, '$.tool_name') LIKE '%\\_\\_treecontext\\_%' ESCAPE '\\' ORDER BY rowid",
    ).all() as Array<{
      rowid: number; node_id: string; content: string | Buffer; metadata_json: string
      index_len: number | null; preview_len: number | null; index_col: number | null
    }>
    return rows.map((r) => {
      const metadata = JSON.parse(r.metadata_json) as Record<string, unknown>
      return {
        rowid: r.rowid,
        nodeId: r.node_id,
        toolName: String(metadata['tool_name']),
        content: decodeContent(r.content),
        stored: Buffer.isBuffer(r.content) ? Buffer.from(r.content) : Buffer.from(r.content, 'utf8'),
        metadataJson: r.metadata_json,
        metadata,
        indexLen: r.index_len,
        previewLen: r.preview_len,
        indexCol: r.index_col,
      }
    })
  } finally {
    raw.close()
  }
}

/** The one echo of `tool` in the store. */
export function rawEcho(dbPath: string, tool: string): RawEcho {
  const all = rawEchoes(dbPath).filter((e) => e.toolName === echoTool(tool))
  if (all.length !== 1) throw new Error(`expected one ${tool} echo, found ${all.length}`)
  return all[0]!
}

/** Node ids whose FTS entry matches `term` in ANY column, read straight
 *  from nodes_fts (no ranking, no weights, no pruning): what the index
 *  holds, not what a query surface chooses to show. */
export function ftsNodeIds(dbPath: string, term: string): string[] {
  const raw = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const phrase = `"${term.replace(/"/g, '""')}"`
    return (raw.prepare(
      'SELECT n.node_id FROM nodes_fts JOIN nodes n ON n.rowid = nodes_fts.rowid WHERE nodes_fts MATCH ? ORDER BY n.rowid',
    ).all(phrase) as Array<{ node_id: string }>).map((r) => r.node_id)
  } finally {
    raw.close()
  }
}

/** The whole FTS vocabulary, per column (fts5vocab 'col'): term, column,
 *  documents and occurrences. Two snapshots compare equal exactly when
 *  the index holds the same postings, so it is the ghost-entry check a
 *  JOIN-ed query cannot be (a posting whose row is gone never joins). */
export function ftsVocab(dbPath: string): string[] {
  const raw = new DatabaseSync(dbPath, { readOnly: true })
  try {
    raw.exec("CREATE VIRTUAL TABLE temp.echo_vocab USING fts5vocab(main, 'nodes_fts', 'col')")
    return (raw.prepare('SELECT term, col, doc, cnt FROM temp.echo_vocab ORDER BY term, col').all() as Array<{
      term: string; col: string; doc: number; cnt: number
    }>).map((r) => `${r.term}\t${r.col}\t${r.doc}\t${r.cnt}`)
  } finally {
    raw.close()
  }
}

export interface DrainedEcho {
  /** A curated row whose text carries the result word (the control). */
  noteId: string
  /** A word the echo's stamped index text holds. */
  indexTerm: string
  /** A word only the call's response carries, never its index text. */
  resultTerm: string
  /** The drained echo, read raw. */
  echo: RawEcho
  /** The FTS vocabulary just before the echo drained. */
  vocabBefore: string[]
}

async function openEchoStore(
  w: CaptureWorld, storeOpts: Omit<Parameters<typeof FlatStore.open>[0], 'database' | 'ownsDatabase'>,
): Promise<Client> {
  openCaptureSandbox(w)
  mkdirSync(dirname(w.dbPath!), { recursive: true })
  const store = await FlatStore.open({
    database: openNodeSqlite(new DatabaseSync(w.dbPath!)), ownsDatabase: true, ...storeOpts,
  })
  w.defer(() => store.close())
  w.store = store
  return mcpOver(w, { claudeCwd: w.proj!, info: { storePath: w.dbPath! } })
}

/**
 * A `treecontext_delete` of a real entry and its echo, through the real
 * hook and the production drain: a fitting event whose index boundary sits
 * at the end of its Input (delete, merge and clear echoes keep their
 * arguments, D261), so the index term is the deleted entry's id. A control
 * note carries the result word ("deleted"), so its absence from the echo's
 * postings is a real absence.
 */
export async function drainedDeleteEcho(w: CaptureWorld): Promise<DrainedEcho> {
  const client = await openEchoStore(w, {})
  const resultTerm = 'deleted'
  const note = parseToolResult(await client.callTool({
    name: 'treecontext_insert',
    arguments: { content: `FINDING: an entry ${resultTerm} from the journal leaves its echo behind as evidence.`, metadata: { type: 'finding' } },
  }))
  const victim = String(parseToolResult(await client.callTool({
    name: 'treecontext_insert', arguments: { content: 'scratch entry the agent removes again', metadata: { type: 'scratch' } },
  }))['node_id'])
  const { payload, response } = await callEchoed(w, client, 'treecontext_delete', { node_id: victim })
  // A real delete: the row the call named existed and is gone (the server
  // answers `deleted: true` for any id, so the row itself is the proof).
  const gone = new DatabaseSync(w.dbPath!, { readOnly: true })
  try {
    if (response['deleted'] !== true || gone.prepare('SELECT 1 FROM nodes WHERE node_id = ?').get(victim) !== undefined) {
      throw new Error('the delete did not happen: nothing real to echo')
    }
  } finally {
    gone.close()
  }
  const vocabBefore = ftsVocab(w.dbPath!)
  spawnHook(w, 'post-tool-use', payload)
  await drainStaging(w)
  return { noteId: String(note['node_id']), indexTerm: victim, resultTerm, echo: rawEcho(w.dbPath!, 'treecontext_delete'), vocabBefore }
}

/**
 * A curated note, the orientation-style query that returns it, and that
 * query's echo through the real hook and the production drain. The note is
 * long, so the query's output overflows its preview and the echo carries a
 * full tail past its display boundary: the realistic demotion candidate.
 * A query echo indexes its tool name only (D261), so the index term is the
 * tool's own token.
 */
export async function drainedQueryEcho(
  w: CaptureWorld,
  storeOpts: Omit<Parameters<typeof FlatStore.open>[0], 'database' | 'ownsDatabase'> = {},
): Promise<DrainedEcho> {
  const client = await openEchoStore(w, storeOpts)
  const resultTerm = 'brackwatermoss'
  const tail = ' The valve keeps the tail in the archive until the human deletes it.'.repeat(40)
  const note = parseToolResult(await client.callTool({
    name: 'treecontext_insert',
    arguments: { content: `lanternfish ledger finding: the archive is written before any row shrinks, ${resultTerm}.${tail}`, metadata: { type: 'finding' } },
  }))
  const { payload, response } = await callEchoed(w, client, 'treecontext_query', { query: 'lanternfish ledger', top_k: 5 })
  if (!(response['results'] as Array<{ nodeId: string }>).some((r) => r.nodeId === note['node_id'])) {
    throw new Error('the query did not return the note: no results to echo')
  }
  const vocabBefore = ftsVocab(w.dbPath!)
  spawnHook(w, 'post-tool-use', payload)
  await drainStaging(w)
  return { noteId: String(note['node_id']), indexTerm: 'treecontext_query', resultTerm, echo: rawEcho(w.dbPath!, 'treecontext_query'), vocabBefore }
}
