import { join } from 'node:path'
import type { Client } from '@modelcontextprotocol/client'
import { hostname } from 'node:os'
import { expect } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { type Registry } from 'gherkin-node-test/vitest'
import { wrapBetterSqlite } from '../../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../../src/flat-store.js'
import {
  writeNamespaceAnnotation,
  writeSessionBeacon,
  writeSessionNamespaceAnnotation,
  readSessionNamespaceAnnotation,
  resolveHookNamespace,
} from '../../../src/session-beacon.js'
import { nsLeaseLiveFor, NS_LEASE_TTL_SECS } from '../../../src/persistence/leases.js'
import { mcpOver, parseTool, rawAll } from '../world.js'
import { openCaptureWorld, spawnHook, drainStaging, bashPayload } from '../capture-harness.js'
// This wave rides the two heal fields journal-session-echo owns (the note
// and its echo), so it extends that interface rather than declaring a second
// name for them.
import { type EchoWorld } from './journal-session-echo.steps.js'

// ── journal-session-namespace ───────────────────────────────────────────
//
// §7.8: the drain publishes (session → namespace) from exact echo
// evidence; hooks resolve by payload session id, no process ancestry.
// Real status/insert calls produce the tool_response fed to the real
// hook subprocess; the production drain publishes; assertions read the
// annotation files and the staging/nodes tables raw.

/**
 * The namespace wave's own: what the hook ladder answered.
 *
 * It lived in journal-session-echo's before-image field until the review read
 * the three shapes that field was carrying — a name that says "the note's row
 * before the drain" and a type that says `Record<string, unknown>`, wrapped
 * around a `string | null` verdict that is neither. Its own name, its own
 * type, on this side of the split.
 */
export interface SessionNamespaceWorld extends EchoWorld {
  /** resolveHookNamespace's answer: the namespace, or null for none. */
  nsResolved?: string | null
}

export const sessionNamespaceDefiner = (reg: Registry<SessionNamespaceWorld>): void => {
  /** The PRODUCTION corroborator, not a stub: these scenarios bind what
   *  actually decides rung 1, so a stub here would pin nothing. */
  const corroborator = (w: SessionNamespaceWorld) => (a: { namespace: string; server_pid: number }): boolean => {
    const raw = new BetterSqlite3(w.dbPath!, { readonly: true })
    try {
      return nsLeaseLiveFor(raw, a.namespace, a.server_pid, hostname())
    } finally {
      raw.close()
    }
  }

  /** Put a namespace lease on the store with a chosen heartbeat age, so
   *  a scenario can say "still serving" or "expired" in the one term the
   *  ladder actually reads. */
  const seedNsLease = (w: SessionNamespaceWorld, namespace: string, pid: number, heartbeatAgeSecs: number): void => {
    const raw = new BetterSqlite3(w.dbPath!)
    try {
      raw.prepare(
        'INSERT OR REPLACE INTO leases (role, holder_pid, holder_host, holder_token, holder_label, acquired_at, heartbeat_at, ttl_secs) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(`ns:${namespace}`, pid, hostname(), 'tok', null, Date.now() / 1000, Date.now() / 1000 - heartbeatAgeSecs, NS_LEASE_TTL_SECS)
    } finally {
      raw.close()
    }
  }

  /** An MCP client over an arbitrary namespace handle of the world's
   *  store file — the multi-lane shape §7.8 exists for. */
  async function mcpOverNamespace(w: SessionNamespaceWorld, namespace: string): Promise<Client> {
    const store = await FlatStore.open({
      database: wrapBetterSqlite(new BetterSqlite3(w.dbPath!)),
      ownsDatabase: true,
      namespace,
    })
    w.defer(() => store.close())
    return mcpOver(w, { claudeCwd: w.proj!, info: { storePath: w.dbPath! } }, store)
  }

  function echoPayloadN(w: SessionNamespaceWorld, toolName: string, toolInput: unknown): Record<string, unknown> {
    return {
      transcript_path: join(w.proj!, 'transcript.jsonl'),
      hook_event_name: 'PostToolUse',
      permission_mode: 'default',
      tool_name: toolName,
      tool_input: toolInput,
      tool_response: w.eToolResponse,
    }
  }

  reg.define(/^a session whose orientation status call left an echo in staging$/, async (w: SessionNamespaceWorld) => {
    await openCaptureWorld(w)
    const client = await mcpOverNamespace(w, 'alpha')
    const res = await client.callTool({ name: 'treecontext_status', arguments: {} })
    w.eToolResponse = (res as { content: unknown }).content
    expect(parseTool(res)['namespace'], 'the status response must disclose its serving namespace').toBe('alpha')
    spawnHook(w, 'post-tool-use', echoPayloadN(w, 'mcp__treecontext__treecontext_status', {}))
  })
  reg.define(/^the drain processes the echo$/, async (w: SessionNamespaceWorld) => {
    await drainStaging(w)
  })
  reg.define(/^the store carries a session-keyed namespace annotation naming the serving namespace$/, (w: SessionNamespaceWorld) => {
    const annotation = readSessionNamespaceAnnotation(w.dbPath!, w.sessionId!)
    expect(annotation, 'the drain must have published the annotation').toBeTruthy()
    expect(annotation!.namespace).toBe('alpha')
    expect(annotation!.derived_from).toBe('status-echo')
  })
  reg.define(/^a later hook fire from that session stamps that namespace with no ancestry lookup$/, (w: SessionNamespaceWorld) => {
    // No pid annotation exists in this world — ancestry has nothing to
    // offer; the stamp can only come from the session rung.
    spawnHook(w, 'post-tool-use', bashPayload(w, 'npm test', 'suite green'))
    const [staged] = rawAll<{ namespace: string | null }>(
      w, "SELECT namespace FROM staging WHERE tool_name = 'Bash' ORDER BY id DESC LIMIT 1",
    )
    expect(staged!.namespace).toBe('alpha')
  })

  reg.define(/^a session with no status echo whose curated insert left an echo in staging$/, async (w: SessionNamespaceWorld) => {
    await openCaptureWorld(w)
    const client = await mcpOverNamespace(w, 'beta')
    const NOTE = 'NS NOTE: the beta lane recorded its ruling'
    const res = await client.callTool({ name: 'treecontext_insert', arguments: { content: NOTE } })
    w.eToolResponse = (res as { content: unknown }).content
    w.eNoteId = String(parseTool(res)['node_id'])
    spawnHook(w, 'post-tool-use', echoPayloadN(w, 'mcp__treecontext__treecontext_insert', { content: NOTE }))
  })
  reg.define(/^the session's namespace annotation names the healed row's namespace$/, (w: SessionNamespaceWorld) => {
    const annotation = readSessionNamespaceAnnotation(w.dbPath!, w.sessionId!)
    expect(annotation).toBeTruthy()
    expect(annotation!.namespace).toBe('beta')
    expect(annotation!.derived_from).toBe('insert-heal')
    // And the heal itself landed: identity and namespace from one echo.
    const [row] = rawAll<{ metadata_json: string }>(w, 'SELECT metadata_json FROM nodes WHERE node_id = ?', w.eNoteId!)
    expect((JSON.parse(row!.metadata_json) as Record<string, unknown>)['_cc_session_src']).toBe('echo')
  })

  reg.define(/^a server that resolved its session id only by beacon unanimity$/, async (w: SessionNamespaceWorld) => {
    await openCaptureWorld(w)
    writeSessionBeacon(w.dbPath!, 999, 'cc-beacon-only', w.proj!, { rewrite: true })
    const client = await mcpOverNamespace(w, 'gamma')
    const res = await client.callTool({ name: 'treecontext_insert', arguments: { content: 'guessed attribution only' } })
    expect(parseTool(res)['node_id'], 'the insert must land — only its attribution is a guess').toBeTruthy()
  })
  reg.define(/^its session produces no echoes$/, async (w: SessionNamespaceWorld) => {
    await drainStaging(w)
  })
  reg.define(/^no session-keyed namespace annotation exists for that session$/, (w: SessionNamespaceWorld) => {
    expect(readSessionNamespaceAnnotation(w.dbPath!, w.sessionId!)).toBeNull()
    expect(readSessionNamespaceAnnotation(w.dbPath!, 'cc-beacon-only')).toBeNull()
  })
  reg.define(/^hook fires resolve through the pid rung or not at all$/, (w: SessionNamespaceWorld) => {
    expect(resolveHookNamespace(w.dbPath!, 424242, w.sessionId!, corroborator(w))).toBeNull()
  })

  reg.define(/^a session that has produced hook events but no treecontext echoes$/, async (w: SessionNamespaceWorld) => {
    await openCaptureWorld(w)
    spawnHook(w, 'post-tool-use', bashPayload(w, 'ls', 'files listed'))
  })
  reg.define(/^the drain processes those events$/, async (w: SessionNamespaceWorld) => {
    await drainStaging(w)
  })
  reg.define(/^the rows drain into the serving namespace as before$/, (w: SessionNamespaceWorld) => {
    const rows = rawAll<{ ns: string }>(
      w,
      'SELECT t.namespace AS ns FROM nodes n JOIN trees t ON t.tree_id = n.tree_id ' +
        "WHERE json_extract(n.metadata_json, '$.source') = 'auto-capture'",
    )
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(r.ns).toBe(w.store!.namespace)
  })
  reg.define(/^no namespace is invented$/, (w: SessionNamespaceWorld) => {
    expect(readSessionNamespaceAnnotation(w.dbPath!, w.sessionId!)).toBeNull()
  })

  reg.define(/^a session-keyed annotation and a live ppid-keyed annotation that disagree$/, async (w: SessionNamespaceWorld) => {
    await openCaptureWorld(w)
    writeNamespaceAnnotation(w.dbPath!, 555, 'pid-derived-ns')
    // Still serving: a fresh heartbeat on this namespace's lease, held
    // by the very process that wrote the annotation.
    seedNsLease(w, 'pid-derived-ns', process.pid, 5)
    writeSessionNamespaceAnnotation(w.dbPath!, w.sessionId!, 'session-derived-ns', 'status-echo')
  })
  reg.define(/^a ppid-keyed annotation whose server no longer holds the namespace$/, async (w: SessionNamespaceWorld) => {
    await openCaptureWorld(w)
    // The annotation survives its server (nothing unlinks it, by
    // design) and its pid still reads alive — this IS this process. What
    // has stopped is the heartbeat: one TTL past it, the lease is
    // expired and the claim is dead by definition. Deliberately NO
    // session-keyed annotation: under the ratified session-first order
    // (ruling 2026-08-20) one would answer first and this scenario
    // would pass without ever exercising the corroboration it pins.
    writeNamespaceAnnotation(w.dbPath!, 555, 'pid-derived-ns')
    seedNsLease(w, 'pid-derived-ns', process.pid, NS_LEASE_TTL_SECS + 1)
  })
  reg.define(/^a session-keyed annotation belonging to a different session$/, async (w: SessionNamespaceWorld) => {
    await openCaptureWorld(w)
    writeSessionNamespaceAnnotation(w.dbPath!, 'cc-someone-else', 'their-ns', 'status-echo')
  })
  reg.define(/^a hook from that session resolves its namespace$/, (w: SessionNamespaceWorld) => {
    w.nsResolved = resolveHookNamespace(w.dbPath!, 555, w.sessionId!, corroborator(w))
  })
  reg.define(/^a hook from this session resolves its namespace$/, (w: SessionNamespaceWorld) => {
    w.nsResolved = resolveHookNamespace(w.dbPath!, 424242, w.sessionId!, corroborator(w))
  })
  reg.define(/^the session-keyed namespace wins$/, (w: SessionNamespaceWorld) => {
    expect(w.nsResolved).toBe('session-derived-ns')
  })
  reg.define(/^no namespace resolves$/, (w: SessionNamespaceWorld) => {
    expect(w.nsResolved).toBeNull()
  })
}

