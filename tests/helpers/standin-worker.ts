/**
 * The stand-in headless worker (journal-workers' Background: "a worker
 * here is bound through a stand-in headless process launched through the
 * real door"). The door is real; this process stands where the model of a
 * `claude -p`, `codex exec` or `agy -p` worker would, and does what the
 * scenario tells it, nothing more:
 *
 *  - reads its whole stdin (the first message the door gave it) and its
 *    ticket and lane from its environment, as a real worker's CLI would;
 *  - takes the ticket door's leg for itself (claimTicket: the lane the
 *    door registered it in, or, started with no door, a claim of its own
 *    ticket, D291's worker with no wrapper);
 *  - writes what its plan says through the library, as that leg: notes,
 *    a checkpoint under its key, the one row an invalid ticket asks for;
 *  - records what it received and saw (a JSON line per run in its log);
 *  - prints its last output and exits as told: a code, or hanging until
 *    a signal ends it.
 *
 * Its plan is STANDIN_PLAN (JSON): `{ first: Step, rerun?: Step, claim?:
 * { prompt?: string } }`, a Step being `{ notes?: number, label?: string,
 * texts?: string[], checkpoint?: string, invalidRow?: boolean, print?:
 * string, exit?: number | 'hang', at?: number, waitFor?: string }`:
 * `texts` are rows written as given (`viaTools`: the notes and texts go
 * through a real `treecontext serve` the worker starts, as a real worker's
 * CLI writes them, instead of the library), and `waitFor` names a file it waits
 * for before printing and exiting, having written `<waitFor>.ready` (so a
 * scenario can act while it runs, or at the moment it exits). The run
 * that opens on the door's send-back message follows `rerun`. STANDIN_DB
 * is the store file; STANDIN_LOG the file its record lines go to.
 */
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { openNodeSqlite } from '../../src/persistence/node-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { claimTicket } from '../../src/ticket-door.js'
import { TICKET_ENV, WORKER_SESSION_ENV } from '../../src/ticket.js'
import { sendBackReason } from '../../src/first-moment.js'
import { hostProbe } from '../../src/persistence/process-probe.js'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { Client } from '@modelcontextprotocol/client'
import { CLI_TS, nodeTsArgs } from './cli-spawn.js'

interface Step {
  notes?: number; label?: string; texts?: string[]; checkpoint?: string; invalidRow?: boolean; print?: string
  exit?: number | 'hang'; at?: number; waitFor?: string; viaTools?: boolean
}
interface Plan { first: Step; rerun?: Step; claim?: { prompt?: string } }

const plan = JSON.parse(process.env['STANDIN_PLAN'] ?? '{"first":{}}') as Plan
const dbPath = process.env['STANDIN_DB']
const log = process.env['STANDIN_LOG']
if (!dbPath) throw new Error('standin-worker: STANDIN_DB is not set')

// Read as a stream, as a CLI reads its prompt: a synchronous read of fd 0
// can meet EAGAIN on a pipe the runtime has made non-blocking.
const chunks: Buffer[] = []
for await (const c of process.stdin) chunks.push(c as Buffer)
const stdin = Buffer.concat(chunks).toString('utf8')
// The re-run opens on the door's send-back message (first-moment.ts).
const rerun = stdin.startsWith(sendBackReason('', '', '').slice(0, 40))
const step: Step = (rerun ? plan.rerun : plan.first) ?? {}

const store = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(dbPath)), retentionInterval: 1_000_000 })
const claim = await claimTicket({ store, ...(plan.claim?.prompt !== undefined ? { prompt: plan.claim.prompt } : {}) })
const leg = claim.leg
const reg = claim.registration
const raw = new DatabaseSync(dbPath, { readOnly: true })
const laneRows = leg ? Number((raw.prepare('SELECT COUNT(*) AS n FROM nodes WHERE session_key = ?').get(leg.sessionId) as { n: number }).n) : 0
// What a re-run can read of its first run's trail: the notes that run wrote.
const firstRunNotes = leg ? Number((raw.prepare("SELECT COUNT(*) AS n FROM nodes WHERE session_key = ? AND CAST(content AS TEXT) LIKE 'first run note %'").get(leg.sessionId) as { n: number }).n) : 0
const record = {
  pid: process.pid, start: hostProbe.startMoment(process.pid), rerun, stdin, argv: process.argv.slice(2),
  ticket: process.env[TICKET_ENV] ?? null, lane: process.env[WORKER_SESSION_ENV] ?? null,
  claimed: claim.claimed, session: leg?.sessionId ?? null, laneRowsSeen: laneRows, firstRunNotesSeen: firstRunNotes,
  firstMessage: claim.firstMessage,
}
raw.close()
const label = step.label ?? (rerun ? 'second run' : 'first run')
const at = (): Record<string, number> => (step.at !== undefined ? { createdAt: step.at } : {})
if (leg && step.viaTools) {
  // Through the tools, as a real worker's CLI writes: a real `treecontext
  // serve` this worker starts with its own environment (its ticket and the
  // lane the door named), each note a treecontext_insert call.
  const transport = new StdioClientTransport({
    command: process.execPath, args: nodeTsArgs(CLI_TS, ['serve', '--lexical', '--store', dbPath]),
    env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)), cwd: process.cwd(), stderr: 'ignore',
  })
  const client = new Client({ name: 'standin-worker', version: '0' })
  await client.connect(transport)
  try {
    for (const text of step.texts ?? []) await client.callTool({ name: 'treecontext_insert', arguments: { content: text } })
    for (let i = 1; i <= (step.notes ?? 0); i++) {
      await client.callTool({ name: 'treecontext_insert', arguments: { content: `${label} note ${i} of ${leg.sessionId}: step ${i} of the work` } })
    }
  } finally { await client.close() }
} else if (leg) {
  for (const text of step.texts ?? []) await store.insert(text, { leg, ...at() })
  for (let i = 1; i <= (step.notes ?? 0); i++) {
    await store.insert(`${label} note ${i} of ${leg.sessionId}: step ${i} of the work`, { leg, ...at() })
  }
}
if (leg) {
  if (step.invalidRow) {
    await store.insert(`my instructions were invalid (session ${leg.sessionId}); I did no work and stop here`, { leg, ...at() })
  }
  if (step.checkpoint !== undefined && reg && reg.run !== null && reg.key !== null) {
    await store.writeCheckpoint(step.checkpoint, { run: reg.run, key: reg.key, leg, ...(step.at !== undefined ? { at: step.at } : {}) })
  }
}
await store.close()
if (log) appendFileSync(log, `${JSON.stringify(record)}\n`)
if (step.waitFor !== undefined) {
  writeFileSync(`${step.waitFor}.ready`, String(process.pid))
  const deadline = Date.now() + 60_000
  while (!existsSync(step.waitFor) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
}
if (step.print !== undefined) process.stdout.write(step.print)
if (step.exit === 'hang') {
  setInterval(() => { /* until a signal ends it */ }, 1 << 30)
} else {
  process.exitCode = step.exit ?? 0
}
