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
 *    and writes its notes and checkpoints the only way a real child can:
 *    through its own tools (a real `treecontext serve` it starts with its
 *    own environment), each treecontext_insert call echoed by PostToolUse,
 *    a checkpoint under the run and key its ticket names;
 *  - fires Stop with its final message; a Stop the hook blocks is
 *    continued once with the hook's reason as its next instruction (its
 *    plan's `afterSendBack` step), and Stop fires again with
 *    `stop_hook_active`, as the client does;
 *  - prints its final message and exits.
 *
 * STANDIN_CLAUDE_PLAN (JSON) is a `ClaudePPlan`: the vocabulary, and what
 * a stand-in may and must never do, are spelled once in the stand-in
 * harness (tests/journal/standins.ts), which launches it (`runWorker`).
 * A `wait*` names a file it waits for after writing `<file>.ready`.
 * STANDIN_LOG is the file its record line goes to; STANDIN_DB the store
 * file.
 */
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { TICKET_ENV, WORKER_SESSION_ENV, readTicket } from '../../src/ticket.js'
import { sendBackReason } from '../../src/first-moment.js'
import { TS_ROOT, tsxArgv } from '../journal/proc.js'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { Client } from '@modelcontextprotocol/client'
import { CLI_TS, nodeTsArgs } from './cli-spawn.js'
import type { ClaudePPlan as Plan } from '../journal/standins.js'

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

/** A Bash call's output: the plan's `toolText` (`{i}`, `{label}`), else
 *  a test line naming this session. */
function toolOutput(label: string, i: number): string {
  return plan.toolText !== undefined
    ? plan.toolText.replaceAll('{i}', String(i)).replaceAll('{label}', label)
    : `login ${label} ${i}: green (${sessionId})`
}

function tools(n: number, label: string): void {
  for (let i = 1; i <= n; i++) {
    hook('post-tool-use', {
      hook_event_name: 'PostToolUse', permission_mode: 'default', tool_name: 'Bash',
      tool_input: { command: `npx vitest run login-${label}-${i}`, description: 'Run tests' },
      tool_response: { stdout: toolOutput(label, i), stderr: '', interrupted: false, isImage: false },
    })
  }
}

// The child's own tools: one real `treecontext serve` it starts with its
// own environment (its ticket and the lane the door named), as Claude Code
// starts the MCP server it is configured with, kept for the whole run.
let toolClient: Client | null = null
async function tools_(): Promise<Client> {
  if (toolClient) return toolClient
  const transport = new StdioClientTransport({
    command: process.execPath, args: nodeTsArgs(CLI_TS, ['serve', '--lexical', '--store', dbPath!]),
    env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)), cwd, stderr: 'ignore',
  })
  const client = new Client({ name: 'standin-claude-p', version: '0' })
  await client.connect(transport)
  toolClient = client
  return client
}

/** A treecontext_insert call through the child's tools, and its PostToolUse
 *  echo, as Claude Code fires it. */
async function insertThroughTools(input: { content: string; metadata?: Record<string, unknown> }): Promise<void> {
  const res = await (await tools_()).callTool({ name: 'treecontext_insert', arguments: input })
  hook('post-tool-use', {
    hook_event_name: 'PostToolUse', permission_mode: 'default', tool_name: 'mcp__treecontext__treecontext_insert',
    tool_input: input, tool_response: (res as { content: unknown }).content,
  })
}

async function notesThroughTools(texts: string[]): Promise<void> {
  if (texts.length === 0 || !dbPath) return
  for (const text of texts) await insertThroughTools({ content: text })
}

/** A checkpoint under the run and key its ticket names, written as a real
 *  child can write one: through its tools, never the library. */
async function writeCheckpoint(text: string): Promise<void> {
  if (!dbPath) return
  const t = readTicket(process.env[TICKET_ENV] ?? '')
  if (!t.valid || t.noKey || t.ticket.run === null || t.ticket.key === null) return
  await insertThroughTools({ content: text, metadata: { kind: 'checkpoint', run: t.ticket.run, key: t.ticket.key } })
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
for (const text of plan.checkpoints ?? []) await writeCheckpoint(text)
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
  for (const text of plan.afterSendBack?.checkpoints ?? []) await writeCheckpoint(text)
  stops.push(hook('stop', { hook_event_name: 'Stop', stop_hook_active: true, last_assistant_message: final }).stdout)
}
await (toolClient as Client | null)?.close()
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
