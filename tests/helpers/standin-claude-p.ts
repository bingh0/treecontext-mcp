/**
 * The stand-in `claude -p` child (journal-workers' Background: "a worker
 * here is bound through a stand-in headless process launched through the
 * real door"; journal-reorientation's `claude -p` child). The door is real
 * and so are the hooks: this process stands where Claude Code's headless
 * client would, and fires the REAL treecontext hooks the install wires,
 * as subprocesses with Claude Code's payloads, its own environment (the
 * ticket and the lane, when a spawner put them there) inherited by each,
 * exactly as the client runs its hooks:
 *
 *  - reads its prompt on stdin, as `claude -p` reads a prompt with none in
 *    its arguments;
 *  - mints its own Claude Code session id, and fires SessionStart
 *    (`source: startup`), recording the context the hook handed it, and
 *    UserPromptSubmit with its prompt;
 *  - fires PostToolUse for each tool call its plan names (a Bash call),
 *    and writes a checkpoint through the library as the worker's leg when
 *    its plan says so (the store's own writer, as the other stand-in does);
 *  - fires Stop with its final message; a Stop the hook blocks is
 *    continued once with the hook's reason as its next instruction (its
 *    plan's `afterSendBack` step), and Stop fires again with
 *    `stop_hook_active`, as the client does;
 *  - prints its final message and exits.
 *
 * STANDIN_CLAUDE_PLAN (JSON): `{ tools?: number, checkpoint?: string,
 * afterSendBack?: { checkpoint?: string, tools?: number }, final?: string,
 * exit?: number, waitBeforeStop?: string, waitAfterStop?: string,
 * invalidRow?: boolean }`; a `wait*` names a file it waits for after
 * writing `<file>.ready`. STANDIN_LOG is the file its record line goes to;
 * STANDIN_DB the store file.
 */
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openNodeSqlite } from '../../src/persistence/node-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { workerLaneOf } from '../../src/persistence/leg-registry.js'
import { TICKET_ENV, WORKER_SESSION_ENV } from '../../src/ticket.js'
import { sendBackReason } from '../../src/first-moment.js'
import { TS_ROOT, tsxArgv } from '../journal/proc.js'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { Client } from '@modelcontextprotocol/client'
import { CLI_TS, nodeTsArgs } from './cli-spawn.js'

interface Plan {
  /** Notes the child writes through its own tools: a real `treecontext
   *  serve` it starts with its own environment, each a treecontext_insert
   *  call whose PostToolUse echo it fires, as Claude Code does. */
  toolNotes?: string[]
  tools?: number; checkpoint?: string; afterSendBack?: { checkpoint?: string; tools?: number }
  final?: string; exit?: number; waitBeforeStop?: string; waitAfterStop?: string; invalidRow?: boolean
}

const plan = JSON.parse(process.env['STANDIN_CLAUDE_PLAN'] ?? '{}') as Plan
const log = process.env['STANDIN_LOG']
const dbPath = process.env['STANDIN_DB']
const sessionId = `cc-${randomBytes(6).toString('hex')}`
const cwd = process.cwd()

const chunks: Buffer[] = []
for await (const c of process.stdin) chunks.push(c as Buffer)
const prompt = Buffer.concat(chunks).toString('utf8')

function hook(name: string, payload: Record<string, unknown>): { stdout: string; status: number | null } {
  const r = spawnSync(process.execPath, tsxArgv(join(TS_ROOT, 'src', 'hooks', `${name}.ts`)), {
    input: JSON.stringify({ session_id: sessionId, cwd, transcript_path: join(cwd, `${sessionId}.jsonl`), ...payload }),
    env: process.env, cwd: TS_ROOT, encoding: 'utf8', timeout: 30_000,
  })
  return { stdout: r.stdout ?? '', status: r.status }
}

function waitFor(path: string | undefined): void {
  if (path === undefined) return
  writeFileSync(`${path}.ready`, String(process.pid))
  const deadline = Date.now() + 60_000
  while (!existsSync(path) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
}

function tools(n: number, label: string): void {
  for (let i = 1; i <= n; i++) {
    hook('post-tool-use', {
      hook_event_name: 'PostToolUse', permission_mode: 'default', tool_name: 'Bash',
      tool_input: { command: `npx vitest run login-${label}-${i}`, description: 'Run tests' },
      tool_response: { stdout: `login ${label} ${i}: green (${sessionId})`, stderr: '', interrupted: false, isImage: false },
    })
  }
}

async function notesThroughTools(texts: string[]): Promise<void> {
  if (texts.length === 0 || !dbPath) return
  const transport = new StdioClientTransport({
    command: process.execPath, args: nodeTsArgs(CLI_TS, ['serve', '--lexical', '--store', dbPath]),
    env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)), cwd, stderr: 'ignore',
  })
  const client = new Client({ name: 'standin-claude-p', version: '0' })
  await client.connect(transport)
  try {
    for (const text of texts) {
      const input = { content: text }
      const res = await client.callTool({ name: 'treecontext_insert', arguments: input })
      hook('post-tool-use', {
        hook_event_name: 'PostToolUse', permission_mode: 'default', tool_name: 'mcp__treecontext__treecontext_insert',
        tool_input: input, tool_response: (res as { content: unknown }).content,
      })
    }
  } finally { await client.close() }
}

async function writeCheckpoint(text: string): Promise<string | null> {
  if (!dbPath) return null
  const store = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(dbPath)), retentionInterval: 1_000_000 })
  try {
    const leg = workerLaneOf((store.store.database as unknown as { prepare: DatabaseSync['prepare'] }), sessionId)
    if (!leg || leg.run === null || leg.key === null) return null
    return (await store.writeCheckpoint(text, { run: leg.run, key: leg.key, leg: { sessionId: leg.sessionId, agentId: leg.agentId } })).nodeId
  } finally { await store.close() }
}

const start = hook('session-start', { hook_event_name: 'SessionStart', source: 'startup' })
let context: string | null = null
let systemMessage: string | null = null
try {
  const out = JSON.parse(start.stdout.trim() || '{}') as Record<string, unknown>
  const hso = out['hookSpecificOutput'] as Record<string, unknown> | undefined
  context = typeof hso?.['additionalContext'] === 'string' ? hso['additionalContext'] : null
  systemMessage = typeof out['systemMessage'] === 'string' ? out['systemMessage'] : null
} catch { /* the hook said nothing parseable */ }
hook('user-prompt-submit', { hook_event_name: 'UserPromptSubmit', prompt })
tools(plan.tools ?? 0, 'first')
await notesThroughTools(plan.toolNotes ?? [])
if (plan.invalidRow) {
  hook('post-tool-use', {
    hook_event_name: 'PostToolUse', permission_mode: 'default', tool_name: 'Bash',
    tool_input: { command: 'echo "my instructions were invalid; I stop here"', description: 'Say so' },
    tool_response: { stdout: 'my instructions were invalid; I stop here', stderr: '', interrupted: false, isImage: false },
  })
}
if (plan.checkpoint !== undefined) await writeCheckpoint(plan.checkpoint)
waitFor(plan.waitBeforeStop)
const final = plan.final ?? 'done'
const stops: string[] = []
const first = hook('stop', { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: final })
stops.push(first.stdout)
let sentBack: string | null = null
try {
  const out = JSON.parse(first.stdout.trim() || '{}') as Record<string, unknown>
  if (out['decision'] === 'block') sentBack = String(out['reason'] ?? '')
} catch { /* not a decision */ }
if (sentBack !== null) {
  // The client continues the turn with the hook's reason as the next
  // instruction, then stops again, flagged as continuing because of it.
  tools(plan.afterSendBack?.tools ?? 0, 'after')
  if (plan.afterSendBack?.checkpoint !== undefined) await writeCheckpoint(plan.afterSendBack.checkpoint)
  stops.push(hook('stop', { hook_event_name: 'Stop', stop_hook_active: true, last_assistant_message: final }).stdout)
}
waitFor(plan.waitAfterStop)
if (log) {
  appendFileSync(log, `${JSON.stringify({
    pid: process.pid, ccSession: sessionId, session: process.env[WORKER_SESSION_ENV] ?? sessionId, stdin: prompt,
    rerun: prompt.startsWith(sendBackReason('', '', '').slice(0, 40)), context, systemMessage, startStdout: start.stdout, stops, sentBack,
    ticket: process.env[TICKET_ENV] ?? null, lane: process.env[WORKER_SESSION_ENV] ?? null,
  })}\n`)
}
process.stdout.write(final)
process.exitCode = plan.exit ?? 0
