/**
 * The /clear chain (D216) at its edges, against the real session-start
 * hook as a subprocess: a clear mints a new session id, and the packet is
 * built from the session the pid beacon names as the one the clear ends.
 * When no beacon names one, the packet says so — it never claims the
 * session has no checkpoint (the charter scenarios bind the main path in
 * features/journal-reorientation.feature).
 */
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { FlatStore } from '../../src/flat-store.js'
import { openNodeSqlite } from '../../src/persistence/node-sqlite.js'
import { writeSessionBeacon } from '../../src/session-beacon.js'
import { retireSubagent } from '../../src/persistence/session-registry.js'
import { retireLeg } from '../../src/persistence/leg-registry.js'
import { type CaptureWorld, openCaptureSandbox, runHook, hookJson } from '../journal/capture-harness.js'
import { TS_ROOT } from '../journal/proc.js'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

async function world(): Promise<CaptureWorld & { root: string }> {
  const w = { defer: (fn: () => void | Promise<void>) => { cleanups.push(fn) } } as CaptureWorld
  openCaptureSandbox(w)
  mkdirSync(dirname(w.dbPath!), { recursive: true })
  const store = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(w.dbPath!)), ownsDatabase: true })
  cleanups.push(() => store.close())
  w.store = store
  await store.insert('plan: the chapter before the clear; next: its tests', {
    metadata: { next_session: true, _cc_session_id: w.sessionId }, createdAt: Date.now() / 1000 - 600,
  })
  return Object.assign(w, { root: w.sessionId! })
}

function clearAs(w: CaptureWorld, newId: string): string {
  w.sessionId = newId
  const run = runHook(w, 'session-start', { hook_event_name: 'SessionStart', source: 'clear', transcript_path: join(w.proj!, 't.jsonl') })
  const out = hookJson(run.stdout)?.['hookSpecificOutput'] as Record<string, unknown> | undefined
  return String(out?.['additionalContext'] ?? '')
}

describe('session-start on /clear follows the session chain (D216)', () => {
  it('reads the predecessor named by the pid beacon, across two clears', async () => {
    const w = await world()
    writeSessionBeacon(w.dbPath!, process.pid, w.root, w.proj!, { rewrite: true })
    const first = clearAs(w, `cc-${randomBytes(6).toString('hex')}`)
    expect(first.split('\n')[0]).toMatch(/^Chapter summary, 10 minutes old .*the chapter before the clear/)
    // The second clear's beacon names the first clear's id; the chain
    // still reaches the chapter written two sessions back.
    const second = clearAs(w, `cc-${randomBytes(6).toString('hex')}`)
    expect(second.split('\n')[0]).toMatch(/^Chapter summary, 10 minutes old/)
  })

  it('says it cannot tell which session the clear continues when no beacon names one', async () => {
    const w = await world()
    // No beacon for this process: the startup hook never ran here.
    const packet = clearAs(w, `cc-${randomBytes(6).toString('hex')}`)
    expect(packet).toMatch(/could not tell which session this clear continues/)
    expect(packet).toMatch(/rather than assuming none exist/)
    expect(packet.split('\n').some((l) => l.startsWith('No chapter summary'))).toBe(false)
  })
})

// D395, D396: a self registration's stop moment is declined until beta.5,
// so no writer of the build records one. Unit 5 had a /clear stop the
// self of the session it continued (stopSelf); that writer is withdrawn,
// and these pin its absence: through the real hooks, and over the source.
describe('a /clear records no stop for the self of the session it continues (D396)', () => {
  const row = (w: CaptureWorld, id: string, agent: string): { stopped_at: number | null } | undefined => {
    const db = new DatabaseSync(w.dbPath!, { readOnly: true })
    try {
      return db.prepare('SELECT stopped_at FROM session_registry WHERE session_id = ? AND agent_id = ?').get(id, agent) as { stopped_at: number | null } | undefined
    } finally { db.close() }
  }

  it('the predecessor\'s self keeps stopped_at NULL while the clear retires its live subagent; a resume leaves it NULL', async () => {
    const w = await world()
    runHook(w, 'session-start', { hook_event_name: 'SessionStart', source: 'startup', transcript_path: join(w.proj!, 't.jsonl') })
    runHook(w, 'subagent-start', { hook_event_name: 'SubagentStart', agent_id: 'a-helper', agent_type: 'Explore' })
    expect([row(w, w.root, '')?.stopped_at, row(w, w.root, 'a-helper')?.stopped_at]).toEqual([null, null])
    writeSessionBeacon(w.dbPath!, process.pid, w.root, w.proj!, { rewrite: true })
    const next = `cc-${randomBytes(6).toString('hex')}`
    clearAs(w, next)
    // The clear read its predecessor: the predecessor's live subagent is
    // retired (D240), so the clear's retire path ran on that session.
    expect(row(w, w.root, 'a-helper')?.stopped_at, 'the clear did not reach the session it continues').not.toBeNull()
    // And its self is left as it was, with no stop.
    expect(row(w, w.root, '')).toEqual({ stopped_at: null })
    expect(row(w, next, '')).toEqual({ stopped_at: null })
    w.sessionId = w.root
    runHook(w, 'session-start', { hook_event_name: 'SessionStart', source: 'resume', transcript_path: join(w.proj!, 't.jsonl') })
    expect(row(w, w.root, '')).toEqual({ stopped_at: null })
  })

  it('a library retirement named with a self\'s agent id stops no self', async () => {
    const w = await world()
    runHook(w, 'session-start', { hook_event_name: 'SessionStart', source: 'startup', transcript_path: join(w.proj!, 't.jsonl') })
    const db = new DatabaseSync(w.dbPath!)
    try {
      expect(retireSubagent(db as never, w.root, '', Date.now() / 1000)).toBe(false)
      expect(retireLeg(db as never, { sessionId: w.root, agentId: '' }, 'retired', Date.now() / 1000)).toBe(false)
    } finally { db.close() }
    expect(row(w, w.root, '')).toEqual({ stopped_at: null })
  })

  it('nothing in src sets stopped_at on a self: every statement that sets it to a moment excludes the self\'s agent id', () => {
    const offenders: string[] = []
    let setters = 0
    for (const file of tsFilesUnder(join(TS_ROOT, 'src'))) {
      for (const sql of sqlLiteralsIn(readFileSync(file, 'utf8'))) {
        const v = stoppedAtVerdict(sql)
        if (v === 'sets-moment') setters++
        if (v === 'self-reachable') offenders.push(`${file}: ${sql.replace(/\s+/g, ' ').slice(0, 160)}`)
      }
    }
    expect(offenders).toEqual([])
    // The guard sees the writers that stop a subagent or a leg (the
    // subagent retirements and retireLeg): it is not looking at nothing.
    expect(setters).toBeGreaterThanOrEqual(3)
    // The wider guard: no line of src names stopped_at outside the
    // allowlist, whatever the way its SQL is built (a concatenation
    // included), and no allowlist entry is left standing for nothing.
    const files = tsFilesUnder(join(TS_ROOT, 'src')).map((f) => ({ file: relative(TS_ROOT, f).split(sep).join('/'), src: readFileSync(f, 'utf8') }))
    expect(stoppedAtUnlisted(files)).toEqual({ unlisted: [], unused: [] })
    const sneaky = [...files, { file: 'src/persistence/session-registry.ts', src: "const q = 'UPDATE session_registry SET ' + 'stopped_at' + ' = ?'" }]
    expect(stoppedAtUnlisted(sneaky).unlisted).toHaveLength(1)
    // And it would see unit 5's withdrawn writer, were it back.
    expect(stoppedAtVerdict("UPDATE session_registry SET stopped_at = ? WHERE session_id = ? AND agent_id = '' AND stopped_at IS NULL")).toBe('self-reachable')
    expect(stoppedAtVerdict('INSERT INTO session_registry (session_id, agent_id, started_at, stopped_at) VALUES (?, \'\', ?, ?)')).toBe('self-reachable')
  })
})

/** Every place in src that names the registry's stopped_at column, by
 *  file and the line's opening text (comments stripped), each with the
 *  reason it may. A new line naming it, SQL built by concatenation
 *  included, fails the guard until it is read and listed here. */
const STOPPED_AT_ALLOWED: Array<{ file: string; line: string; reason: string }> = [
  { file: 'src/persistence/session-registry.ts', line: 'stopped_at REAL,', reason: 'the column\'s definition' },
  { file: 'src/persistence/session-registry.ts', line: 'cwd: string | null; toplevel', reason: 'the row type' },
  { file: 'src/persistence/session-registry.ts', line: 'cwd: r.cwd, toplevel: r.toplevel', reason: 'the row read into the registration' },
  { file: 'src/persistence/session-registry.ts', line: '`INSERT INTO session_registry (session_id, agent_id, agent_type, worktree', reason: 'a registration inserts the column as NULL (checked by the verdict test above)' },
  { file: 'src/persistence/session-registry.ts', line: 'cwd = excluded.cwd, toplevel = excluded.toplevel', reason: 're-registration clears the stop (the resume clear)' },
  { file: 'src/persistence/session-registry.ts', line: 'ON CONFLICT (session_id, agent_id) DO UPDATE SET agent_type', reason: 're-registration of a subagent clears the stop (the resume clear)' },
  { file: 'src/persistence/session-registry.ts', line: '"UPDATE session_registry SET stopped_at = ? WHERE session_id = ? AND agent_id = ? AND agent_id != \'\'', reason: 'the subagent retirement; excludes the self\'s agent id' },
  { file: 'src/persistence/session-registry.ts', line: 'WHERE session_id = ? AND agent_id != \'\' AND kind = \'subagent\' AND stopped_at IS NULL', reason: 'a registry read of live subagents' },
  { file: 'src/persistence/session-registry.ts', line: '`UPDATE session_registry SET stopped_at = ? WHERE session_id = ? AND agent_id != \'\'', reason: 'the retirement of live helpers at a start; excludes the self\'s agent id' },
  { file: 'src/persistence/session-registry.ts', line: '`SELECT * FROM session_registry WHERE session_id = ? AND agent_id != \'\' AND stopped_at IS NULL', reason: 'a registry read of the live subagents' },
  { file: 'src/persistence/leg-registry.ts', line: 'cwd: string | null; started_at: number; stopped_at', reason: 'the row type' },
  { file: 'src/persistence/leg-registry.ts', line: 'worktree: r.worktree, branch: r.branch, cwd: r.cwd, startedAt', reason: 'the row read into the leg' },
  { file: 'src/persistence/leg-registry.ts', line: '`INSERT INTO session_registry (session_id, agent_id, agent_type, worktree', reason: 'a leg\'s registration inserts the column as NULL (a worker\'s agent id is never the self\'s)' },
  { file: 'src/persistence/leg-registry.ts', line: '`UPDATE session_registry SET stopped_at = NULL', reason: 'the resume clear of a leg' },
  { file: 'src/persistence/leg-registry.ts', line: '"UPDATE session_registry SET stopped_at = ?, ended = ? WHERE session_id = ? AND agent_id = ? AND agent_id != \'\'', reason: 'the leg retirement; excludes the self\'s agent id' },
  { file: 'src/persistence/leg-registry.ts', line: '`SELECT * FROM session_registry WHERE kind = \'worker\'', reason: 'a registry read of live workers' },
  { file: 'src/persistence/leg-registry.ts', line: 'WHERE session_id = ? AND agent_id = ? AND ended IS NULL AND stopped_at IS NULL', reason: 'a registry read of a live leg' },
  { file: 'src/run-export.ts', line: 'worktree: leg.worktree, branch: leg.branch', reason: 'the leg\'s fact written to the export file' },
  { file: 'src/run-export.ts', line: 'startedAt: numOrNull(f[\'started_at\'])', reason: 'the leg\'s fact read back from a claim' },
  { file: 'src/key-lookup.ts', line: 'stopped_at: number | null', reason: 'the reply\'s type' },
  { file: 'src/key-lookup.ts', line: 'stopped_at: g.stoppedAt', reason: 'the leg\'s fact in the reply' },
]

/** Lines of a file's code (comments stripped) that name stopped_at. */
function stoppedAtLinesIn(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')
  return code.split('\n').map((l) => l.trim()).filter((l) => /\bstopped_at\b/.test(l))
}

/** The lines naming stopped_at that no allowlist entry covers; and the
 *  entries no line used. */
function stoppedAtUnlisted(files: Array<{ file: string; src: string }>): { unlisted: string[]; unused: string[] } {
  const used = new Set<number>()
  const unlisted: string[] = []
  for (const { file, src } of files) {
    for (const line of stoppedAtLinesIn(src)) {
      const i = STOPPED_AT_ALLOWED.findIndex((a) => a.file === file && line.startsWith(a.line))
      if (i === -1) unlisted.push(`${file}: ${line.slice(0, 160)}`)
      else used.add(i)
    }
  }
  return { unlisted, unused: STOPPED_AT_ALLOWED.filter((_, i) => !used.has(i)).map((a) => `${a.file}: ${a.line}`) }
}

function tsFilesUnder(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...tsFilesUnder(p))
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

/** The string and template literals of a source file that write the
 *  registry's stopped_at column (an UPDATE or an INSERT naming it). */
function sqlLiteralsIn(src: string): string[] {
  // Comments first, so a backtick or an apostrophe in prose cannot pair
  // with a literal's.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')
  return [...code.matchAll(/`[^`]*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g)]
    .map((m) => m[0].slice(1, -1))
    .filter((s) => /\bstopped_at\b/.test(s) && /^\s*(UPDATE|INSERT)\b/i.test(s))
}

/** How a statement writes stopped_at: only to NULL, to a moment on rows
 *  that can never be a self's (its WHERE excludes agent id ''), or to a
 *  moment a self's row can receive. */
function stoppedAtVerdict(sql: string): 'null-only' | 'sets-moment' | 'self-reachable' {
  const flat = sql.replace(/\s+/g, ' ')
  if (/^\s*INSERT\b/i.test(flat)) {
    const cols = /\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i.exec(flat)
    if (!cols) return 'self-reachable'
    const names = cols[1]!.split(',').map((c) => c.trim())
    const values = cols[2]!.split(',').map((c) => c.trim())
    const at = names.indexOf('stopped_at')
    const insertNull = at >= 0 && values[at]?.toUpperCase() === 'NULL'
    const conflict = /ON CONFLICT[\s\S]*\bstopped_at\s*=\s*(\S+)/i.exec(flat)?.[1]
    return insertNull && (conflict === undefined || /^NULL\b/i.test(conflict)) ? 'null-only' : 'self-reachable'
  }
  const w = flat.search(/\bWHERE\b/i)
  const setPart = w === -1 ? flat : flat.slice(0, w)
  const where = w === -1 ? '' : flat.slice(w)
  const assigns = [...setPart.matchAll(/\bstopped_at\s*=\s*([^,\s]+)/gi)].map((m) => m[1]!)
  if (assigns.every((v) => /^NULL$/i.test(v))) return 'null-only'
  return /\bagent_id\s*!=\s*''/.test(where) ? 'sets-moment' : 'self-reachable'
}
