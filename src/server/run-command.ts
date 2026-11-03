/**
 * `treecontext run`: the ticket door from a shell (D291), the library's
 * spawnWorker behind a command line, so a harness or a main CLI with no
 * Node in it spawns a headless worker through the same door.
 *
 *   treecontext run [ticket] [options] -- <command> [args...]
 *
 * The ticket is minted from flags (`--run`, `--key` or `--no-key`,
 * `--role`, `--parent`, and optionally `--checkpointer`,
 * `--checkpointed-by`, `--parent-cli`, `--door` or `--no-door`), or given whole
 * (`--ticket <json>`), or read from TICKET_ENV in this command's own
 * environment, as a spawner that minted it put it there (D288).
 *
 * The worker's stdout passes through to this command's stdout as it
 * arrives, byte for byte with nothing inserted, every run's in order
 * (D307: a worker's last output is never lost from its spawner); its
 * stderr passes through to this command's stderr; the boundary is the one
 * line the door hands its spawner, on stderr after it, starting
 * `treecontext:`. The exit code is the worker's last run's own, or 128
 * plus the number of the signal that ended it; when no worker was
 * started, NOT_STARTED_EXIT (the store could not be read, D307) or
 * TICKET_REFUSED_EXIT (`--check-ticket` refused the ticket, D303). A
 * signal this command receives is passed to the worker, whose exit by
 * signal is then a cut (D292).
 */
import { readFileSync } from 'node:fs'
import { gitSelfOf } from '../hooks/git-self.js'
import { mintTicket, ticketTextIn, readTicket, type TicketFields } from '../ticket.js'
import { spawnWorker, NOT_STARTED_EXIT, DOOR_LINE_PREFIX } from '../ticket-door.js'

export const RUN_USAGE = 'treecontext run [--run <run> --role <role> (--key <key> | --no-key) --parent <session> '
  + '[--checkpointer <role>] [--checkpointed-by <role>] [--parent-cli <cli>] [--door | --no-door] | --ticket <json>] '
  + '[--prompt <text> | --prompt-file <path>] [--timeout <seconds>] [--check-ticket] [--spawner <session>] '
  + '[--message-arg] [--store X] [--project-dir D] -- <command> [args...] '
  + '(stdout: the worker\'s, byte for byte; stderr: one treecontext: line after it says how it ended)'

export interface RunArgs {
  ticketFlags: Partial<{ run: string; key: string; noKey: boolean; role: string; parent: string; parentCli: string; checkpointer: string; checkpointedBy: string; door: boolean; noDoor: boolean }>
  ticket: string | null
  prompt: string | null
  promptFile: string | null
  timeoutSecs: number | null
  checkTicket: boolean
  spawner: string | null
  messageArg: boolean
  store: string | null
  projectDir: string | null
  command: string[]
}

export class RunUsageError extends Error {}

/** `--help` or `-h` among run's own flags, before the `--` that starts the
 *  worker's command; after it, the flag is the worker's. */
export function wantsRunHelp(argv: string[]): boolean {
  const own = argv.indexOf('--') === -1 ? argv : argv.slice(0, argv.indexOf('--'))
  return own.includes('--help') || own.includes('-h')
}

/** Parse what follows `treecontext run`. */
export function parseRunArgs(argv: string[]): RunArgs {
  const a: RunArgs = {
    ticketFlags: {}, ticket: null, prompt: null, promptFile: null, timeoutSecs: null, checkTicket: false,
    spawner: null, messageArg: false, store: null, projectDir: null, command: [],
  }
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1]
    if (v === undefined || v === '--') throw new RunUsageError(`${flag} needs a value`)
    return v
  }
  let i = 0
  for (; i < argv.length; i++) {
    const f = argv[i]!
    if (f === '--') { a.command = argv.slice(i + 1); break }
    switch (f) {
      case '--run': a.ticketFlags.run = value(i, f); i++; break
      case '--key': a.ticketFlags.key = value(i, f); i++; break
      case '--no-key': a.ticketFlags.noKey = true; break
      case '--role': a.ticketFlags.role = value(i, f); i++; break
      case '--parent': a.ticketFlags.parent = value(i, f); i++; break
      case '--parent-cli': a.ticketFlags.parentCli = value(i, f); i++; break
      case '--checkpointer': a.ticketFlags.checkpointer = value(i, f); i++; break
      case '--checkpointed-by': a.ticketFlags.checkpointedBy = value(i, f); i++; break
      case '--door': a.ticketFlags.door = true; break
      case '--no-door': a.ticketFlags.noDoor = true; break
      case '--ticket': a.ticket = value(i, f); i++; break
      case '--prompt': a.prompt = value(i, f); i++; break
      case '--prompt-file': a.promptFile = value(i, f); i++; break
      case '--timeout': {
        const n = Number(value(i, f)); i++
        if (!Number.isFinite(n) || n <= 0) throw new RunUsageError('--timeout takes a number of seconds above 0')
        a.timeoutSecs = n
        break
      }
      case '--check-ticket': a.checkTicket = true; break
      case '--spawner': a.spawner = value(i, f); i++; break
      case '--message-arg': a.messageArg = true; break
      case '--store': a.store = value(i, f); i++; break
      case '--project-dir': a.projectDir = value(i, f); i++; break
      default: throw new RunUsageError(`unknown flag for run: ${f}`)
    }
  }
  if (a.command.length === 0) throw new RunUsageError('run needs the worker\'s command after --')
  if (a.prompt !== null && a.promptFile !== null) throw new RunUsageError('give --prompt or --prompt-file, not both')
  const minting = Object.keys(a.ticketFlags).length > 0
  if (minting && a.ticket !== null) throw new RunUsageError('give the ticket by flags or by --ticket, not both')
  if (minting) {
    const t = a.ticketFlags
    for (const need of ['run', 'role', 'parent'] as const) if (!t[need]) throw new RunUsageError(`minting a ticket needs --${need}`)
    if (!t.key && !t.noKey) throw new RunUsageError('minting a ticket needs --key, or --no-key for a one-off worker')
    if (t.key && t.noKey) throw new RunUsageError('give --key or --no-key, not both')
    if (t.door && t.noDoor) throw new RunUsageError('give --door or --no-door, not both')
  }
  return a
}

/** The ticket text the command spawns with: minted from flags, given
 *  whole, or as this command's environment carries it. */
export function ticketTextFor(a: RunArgs, env: NodeJS.ProcessEnv, cwd: string): string | null {
  if (a.ticket !== null) return a.ticket
  const t = a.ticketFlags
  if (Object.keys(t).length === 0) return ticketTextIn(env)
  const where = gitSelfOf(cwd)
  const fields: TicketFields = {
    run: t.run!, role: t.role!,
    ...(t.noKey ? { noKey: true } : { key: t.key! }),
    ...(t.checkpointer ? { checkpointer: t.checkpointer } : {}),
    ...(t.checkpointedBy ? { checkpointedBy: t.checkpointedBy } : {}),
    // D316, D340: --door declares a way to write, --no-door declares none,
    // and neither leaves the ticket silent, which is read as one.
    ...(t.noDoor ? { canWrite: false } : t.door ? { canWrite: true } : {}),
    // D294: the parent as this shell can describe it: the id it was given,
    // its CLI when named, and the directory, worktree and branch it runs in.
    parent: { id: t.parent!, cli: t.parentCli ?? null, cwd, worktree: where.worktree, branch: where.branch },
  }
  return mintTicket(fields)
}

/** Run the command: returns the exit code the wrapper exits with. */
export async function runCommand(argv: string[], deps: {
  dbPathFor: (store: string | null, projectDir: string | null) => string
  stdout?: NodeJS.WritableStream
  stderr?: NodeJS.WritableStream
  env?: NodeJS.ProcessEnv
  cwd?: string
}): Promise<number> {
  const out = deps.stdout ?? process.stdout
  const err = deps.stderr ?? process.stderr
  const env = deps.env ?? process.env
  const cwd = deps.cwd ?? process.cwd()
  if (wantsRunHelp(argv)) {
    out.write(`usage: ${RUN_USAGE}\n`)
    return 0
  }
  let a: RunArgs
  try {
    a = parseRunArgs(argv)
  } catch (e) {
    if (e instanceof RunUsageError) {
      err.write(`error: ${e.message}\nusage: ${RUN_USAGE}\n`)
      return 2
    }
    throw e
  }
  const ticket = ticketTextFor(a, env, cwd)
  if (ticket === null) {
    err.write(`error: run has no ticket: mint one with --run, --key, --role and --parent, give one with --ticket, or put one in TREECONTEXT_TICKET\nusage: ${RUN_USAGE}\n`)
    return 2
  }
  let prompt = a.prompt ?? ''
  if (a.promptFile !== null) {
    try {
      prompt = readFileSync(a.promptFile === '-' ? 0 : a.promptFile, 'utf8')
    } catch (e) {
      err.write(`error: cannot read the prompt file ${a.promptFile}: ${e instanceof Error ? e.message : String(e)}\n`)
      return 2
    }
  }
  let dbPath: string
  try {
    dbPath = deps.dbPathFor(a.store, a.projectDir)
  } catch (e) {
    err.write(`${DOOR_LINE_PREFIX} the store could not be found (${e instanceof Error ? e.message : String(e)}); no worker was started and nothing was written.\n`)
    return NOT_STARTED_EXIT
  }
  const abort = new AbortController()
  const forward = (): void => { abort.abort() }
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP']
  for (const s of signals) process.on(s, forward)
  try {
    // D283, D293: the spawner of a refused ticket is who `--spawner` names
    // (a session, written in its lane when it is registered); with none,
    // it is declared as the ticket's parent, a declared row in no session's
    // lane: no hook saw this spawn, so no hook's identity is claimed.
    const parentId = readTicket(ticket).ticket.parent.id
    const spawner = a.spawner !== null ? { sessionId: a.spawner } : { role: parentId !== '' ? parentId : 'spawner' }
    const result = await spawnWorker({
      store: dbPath, ticket, prompt, command: a.command[0]!, args: a.command.slice(1), cwd, env,
      deliver: a.messageArg ? 'argv' : 'stdin', checkTicket: a.checkTicket,
      ...(a.timeoutSecs !== null ? { timeoutMs: a.timeoutSecs * 1000 } : {}),
      spawner,
      onStdout: (c) => { out.write(c) },
      signal: abort.signal,
    })
    err.write(`${result.line}\n`)
    return result.exitCode
  } finally {
    for (const s of signals) process.off(s, forward)
  }
}
