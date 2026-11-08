import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

// ── Install's own record (D361, D390) ──────────────────────────────────
//
// Only install's record can tell what install wrote into a client's file
// from what the developer wrote there: the idle-compaction key (D361) and
// the tool approvals (D390), each read back by uninstall and by `config
// tool-approvals`, which remove what the record names and nothing else. The
// developer's choice to turn the approvals off is kept here too, so every
// later install honours it.
//
// Every change is a locked read-modify-write, written to a temporary file
// and renamed over the record. A record that does not parse is never read
// as empty: that would forget an off the developer chose and re-approve. It
// is moved aside to `install-state.json.corrupt-<UTC moment>`, said loudly,
// and replaced by a record whose tool approvals are unknown for every
// client, so install writes none until the developer chooses again.

/** One client file's share of the approvals install wrote. */
export interface WrittenApprovals {
  /** What install added: Claude Code's allow rules, or Codex's tool names. */
  items: string[]
  /** Containers install created to hold them (Claude Code: `permissions`, `allow`), removed again only while empty. */
  created?: string[]
  at: string
}

export interface ToolApprovalsState {
  /** A client whose approvals the developer turned off: by `config tool-approvals off` or `install --no-tool-approvals`. */
  off?: Record<string, { at: string; how: 'config' | 'install' }>
  /** A client whose choice is not known: the record did not parse, and was moved to `backup` (null when it has not been moved yet). */
  unknown?: Record<string, { at: string; backup: string | null }>
  /** What install wrote, per client slug and file. */
  written?: Record<string, Record<string, WrittenApprovals>>
}

export interface InstallState {
  idleCompaction?: Record<string, { value: false; at: string }>
  toolApprovals?: ToolApprovalsState
}

/** The clients whose approvals a record that did not parse leaves unknown. */
const RECORDED_CLIENTS = ['claude', 'codex']

/** treecontext's own install state, beside its config. */
export function installStatePath(): string {
  return join(homedir(), '.treecontext', 'install-state.json')
}

/**
 * Write a file whole or not at all: a temporary file beside it, then a
 * rename over it, so a reader never sees it missing or half written. On
 * Windows a rename onto an existing file can fail, so there the old file
 * goes first, as atomicWrite in installer.ts does.
 */
export function writeAtomic(file: string, content: string, mode: number): void {
  mkdirSync(dirname(file), { recursive: true })
  sweepTemps(file)
  const tmp = `${file}.tmp.${process.pid}`
  writeFileSync(tmp, content, { mode })
  if (process.platform === 'win32') {
    try { unlinkSync(file) } catch { /* may not exist yet */ }
  }
  renameSync(tmp, file)
}

/** Leftover `<file>.tmp.<pid>` files of a process that died between its write and its rename. */
function sweepTemps(file: string): void {
  const prefix = `${basename(file)}.tmp.`
  let names: string[] = []
  try { names = readdirSync(dirname(file)) } catch { return }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const pid = Number(name.slice(prefix.length))
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || processAlive(pid)) continue
    try { unlinkSync(join(dirname(file), name)) } catch { /* gone */ }
  }
}

function unknownFor(backup: string | null): InstallState {
  const at = new Date().toISOString()
  return { toolApprovals: { unknown: Object.fromEntries(RECORDED_CLIENTS.map(c => [c, { at, backup }])) } }
}

/** The record parsed, or null when the file exists and is not a record. */
function parseRecord(file: string): InstallState | null {
  if (!existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as InstallState : null
  } catch {
    return null
  }
}

/**
 * The record as it stands. A file that does not parse reads as a record
 * whose tool approvals are unknown for every client (never as empty);
 * nothing is moved by a read, so doctor can read it without changing it.
 */
export function readInstallState(): InstallState {
  return parseRecord(installStatePath()) ?? unknownFor(null)
}

/** The UTC moment a backup is named by: YYYYMMDDTHHMMSSZ. */
function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** How long a lock may stand before it is read as left behind by a process that died. */
const LOCK_STALE_MS = 30_000
const LOCK_WAIT_MS = 10_000

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Unlink the lock only while it still holds `token`: a fresh lock another waiter took after the stale one was judged stays. */
export function removeIfHolding(lock: string, token: string): boolean {
  try {
    if (readFileSync(lock, 'utf8') !== token) return false
    unlinkSync(lock)
    return true
  } catch { return false /* another took it over */ }
}

/** Run `fn` holding the record's lock: an exclusive lock file beside it, taken over only when stale. */
function withLock<T>(fn: () => T): T {
  const lock = `${installStatePath()}.lock`
  mkdirSync(dirname(lock), { recursive: true })
  const deadline = Date.now() + LOCK_WAIT_MS
  // pid, then a random value: a lock is one holder's, whoever else reads it.
  const token = `${process.pid} ${randomBytes(8).toString('hex')}`
  for (;;) {
    try {
      const fd = openSync(lock, 'wx', 0o600)
      writeFileSync(fd, `${token}\n`)
      closeSync(fd)
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      let stale: string | null = null
      try {
        const held = readFileSync(lock, 'utf8')
        const pid = Number.parseInt(held, 10)
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS || (Number.isInteger(pid) && pid > 0 && !processAlive(pid))) stale = held
      } catch { /* gone between the two reads: try again */ }
      // Take over only the lock that was judged stale: re-read it just
      // before unlinking, so a fresh lock another waiter took in between is
      // never removed.
      if (stale !== null) {
        removeIfHolding(lock, stale)
        continue
      }
      if (Date.now() > deadline) throw new Error(`the install record ${installStatePath()} is locked by another treecontext (${lock}); try again when it has finished`)
      sleepMs(50)
    }
  }
  try {
    return fn()
  } finally {
    try { unlinkSync(lock) } catch { /* already gone */ }
  }
}

/** Move a record that does not parse aside, loudly, and leave one whose approvals are unknown. Returns the record. Call holding the lock. */
function repairLocked(): InstallState {
  const file = installStatePath()
  const parsed = parseRecord(file)
  if (parsed !== null) return parsed
  const backup = `${file}.corrupt-${stamp()}`
  renameSync(file, backup)
  console.error(`[warn] treecontext's install record ${file} could not be read; it was moved to ${backup}. `
    + 'Whether you turned tool approvals off is no longer known, so install writes none until you choose: '
    + 'treecontext config tool-approvals on, or off.')
  const fresh = unknownFor(backup)
  writeAtomic(file, JSON.stringify(fresh, null, 2) + '\n', 0o600)
  return fresh
}

/** Move a record that does not parse aside (install and the config command do this first). */
export function repairInstallState(): void {
  if (parseRecord(installStatePath()) !== null) return
  withLock(() => { repairLocked() })
}

/**
 * Change the record: under its lock, read it (repairing one that does not
 * parse), let `fn` change it in place or return a new one, and write it
 * atomically. `fn` returning false writes nothing.
 */
export function updateInstallState(fn: (state: InstallState) => InstallState | false | void): void {
  withLock(() => {
    const state = repairLocked()
    const before = JSON.stringify(state)
    const next = fn(state)
    if (next === false) return
    const out = next ?? state
    if (JSON.stringify(out) === before && existsSync(installStatePath())) return
    writeAtomic(installStatePath(), JSON.stringify(out, null, 2) + '\n', 0o600)
  })
}
