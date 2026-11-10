/**
 * The process probe: what this host's operating system says about a
 * process, for the phantom pass over worker registrations (D297, D317).
 *
 * Three readings and nothing more: this host's name, whether a process
 * with an id exists here, and the moment the operating system reports
 * that process started. The start moment is what tells a worker from an
 * unrelated process that inherited its number after it ended (D317): a
 * process found with the registered id and a different start is a
 * different process. A host that cannot read a start moment (Windows
 * here, or a /proc the reader may not open) says so with null, and the
 * pass leaves the number alone rather than guess (D317's stressing case).
 *
 * The reader is an interface so a caller on another platform, or a test
 * that needs a process the host cannot stage, can hand its own; every
 * production reader passes `hostProbe`.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { hostname } from 'node:os'

export interface ProcessProbe {
  /** This host's name, as a worker registration records it. */
  host(): string
  /** Whether a process with this id exists on this host: true, false, or
   *  null when the host cannot say. */
  exists(pid: number): boolean | null
  /** The process's start moment as the operating system reports it, in
   *  unix seconds, or null when this host cannot read it. For display, and
   *  for the comparison where the host has no exact token. */
  startMoment(pid: number): number | null
  /** An exact identity of the process's start where the host has one:
   *  on Linux the boot id and the start time in clock ticks since boot
   *  (`<boot_id>:<ticks>`), neither of which a wall-clock step moves.
   *  Null where the host has none (macOS, Windows): the wall-clock moment
   *  is then compared within START_TOLERANCE_SECS. Optional, so a reader
   *  a caller hands in may leave it out. */
  startToken?(pid: number): string | null
  /** D403: which numbering of processes (pid namespace) a process's id
   *  belongs to, as this reader names it: on Linux the link
   *  `/proc/<pid>/ns/pid` (`pid:[<inode>]`), `'self'` naming the reader's
   *  own. Null where the host has no such numbering (macOS, Windows) or
   *  the link cannot be read. Optional: a probe without it (a caller's
   *  own, or an earlier build's) records and reads no numbering. */
  pidNamespace?(pid: number | 'self'): string | null
  /** D403: a worker numbered apart from this reader, looked for from
   *  outside its numbering: every process this reader can see whose
   *  numbering is `ns`, and the one among them whose id there is `pid`
   *  (its id in this reader's numbering). Optional, as pidNamespace. */
  lookInNamespace?(ns: string, pid: number, registered?: { start: number | null; token?: string | null }): NamespaceLook
  /** D403: whether this reader sees every numbering of processes on the
   *  machine, so a numbering it sees no process of has none left: its own
   *  numbering is the machine's (the kernel's fixed PROC_PID_INIT_INO) and
   *  its /proc is the one that numbering mounts (`/proc/self` names this
   *  process by its own id). Optional: a probe without it is taken to see
   *  every numbering exactly when its own is MACHINE_PID_NAMESPACE. */
  seesEveryNumbering?(): boolean
  /** D403: the time namespace of this process (`'self'`), on Linux the
   *  link `/proc/self/ns/time` (`time:[<inode>]`): /proc reports a start
   *  time shifted by the READER's time namespace, so two start readings
   *  compare only when both were read in the same one. Null where the host
   *  has none or it cannot be read. Optional, as pidNamespace. */
  timeNamespace?(pid: 'self'): string | null
}

/** What a reader saw of another numbering of processes (D403). */
export interface NamespaceLook {
  /** Some process this reader can see is numbered in it: the numbering is
   *  there, seen from outside. */
  seen: boolean
  /** The process numbered `pid` there, by its id in the reader's own
   *  numbering, or null when none was seen. */
  hostPid: number | null
  /** Some process nested in a numbering of its own could not be read
   *  and may be the worker (its id in its own numbering is `pid`, and its
   *  start is the registered one or cannot be compared), so "not seen" may
   *  be "not readable". */
  unreadable: boolean
  /** The found process's start readings, read from the reader's /proc
   *  when it was found (`hostPid` is an id in the numbering that /proc
   *  lists, which need not be the reader's own). Absent from a look that
   *  does not read them, when the reader reads them by `hostPid`. */
  start?: number | null
  token?: string | null
}

/** The machine's own numbering of processes on Linux: the kernel gives
 *  the initial pid namespace this fixed inode (PROC_PID_INIT_INO), so a
 *  reader whose own numbering is this one is in the machine's (D403). */
export const MACHINE_PID_NAMESPACE = 'pid:[4026531836]'

/** D403: the numbering a door records for a process on a host that has
 *  numberings of processes (Linux) when it could not read its own (no
 *  /proc where it runs, as in a sandbox that mounts none): its id may be a
 *  sandbox's, so no reader judges it by its own process table. Never a
 *  kernel's name (`pid:[<inode>]`), so it matches no reader's numbering. */
export const UNREAD_PID_NAMESPACE = 'pid:[unread]'

/**
 * D403: the numbering a door records beside a process id it registers:
 * the probe's reading of its own; UNREAD_PID_NAMESPACE where the host has
 * numberings and this one could not be read; null where the probe reads
 * none (a host with no numbering, macOS and Windows, or a probe without
 * the reading), which readers take for a registration with no numbering.
 */
export function numberingToRecord(probe: ProcessProbe): string | null {
  if (!probe.pidNamespace) return null
  const own = probe.pidNamespace('self')
  if (own !== null) return own
  return process.platform === 'linux' ? UNREAD_PID_NAMESPACE : null
}

/** D403: the time namespace a door records where the host has time
 *  namespaces (Linux) and this one could not be read (a kernel before
 *  5.6, or no /proc): a start it read compares with no reader's. */
export const UNREAD_TIME_NAMESPACE = 'time:[unread]'

/**
 * D403: the time namespace a door records beside a start it read: the
 * probe's reading of its own; UNREAD_TIME_NAMESPACE where the host has
 * time namespaces and this one could not be read; null where the probe
 * reads none (macOS, Windows, a probe without the reading), which readers
 * take for a registration that records none (an earlier build's).
 */
export function timeNamespaceToRecord(probe: ProcessProbe): string | null {
  if (!probe.timeNamespace) return null
  const own = probe.timeNamespace('self')
  if (own !== null) return own
  return process.platform === 'linux' ? UNREAD_TIME_NAMESPACE : null
}

/** What a door records of a process it registers (D297, D317, D403):
 *  its start readings, the numbering its id belongs to, and the time
 *  namespace those readings were taken in. */
export function processReadings(probe: ProcessProbe, pid: number): { start: number | null; token: string | null; ns: string | null; tns: string | null } {
  return { start: probe.startMoment(pid), token: probe.startToken?.(pid) ?? null, ns: numberingToRecord(probe), tns: timeNamespaceToRecord(probe) }
}

/**
 * D403: whether a /proc hides processes from a reader that is not root: a
 * /proc mounted with `hidepid` (1, 2, `noaccess`, `invisible`) shows such
 * a reader only its own user's processes, so a numbering it sees nothing
 * of may only be hidden. Read from the /proc mount's super options in
 * `/proc/self/mountinfo` (after the ` - ` separator). Exported with the
 * text it reads, for a test.
 */
export function procHidesProcesses(mountinfo: string): boolean {
  for (const line of mountinfo.split('\n')) {
    const [pre, post] = line.split(' - ')
    if (!pre || !post) continue
    if (pre.split(' ')[4] !== PROC) continue
    const [fstype, , superOpts] = post.split(' ')
    if (fstype !== 'proc') continue
    const m = /(?:^|,)hidepid=([^,]+)/.exec(superOpts ?? '')
    if (m && m[1] !== '0' && m[1] !== 'off') return true
  }
  return false
}

/**
 * D403: whether a Linux reader sees every numbering of processes on the
 * machine, from what it read of itself: its own numbering is the
 * machine's, its /proc is that numbering's (`/proc/self` names it by its
 * own id), and that /proc hides no process from it (no `hidepid`, or the
 * reader is root). Anything unread is "no".
 */
export function seesEveryNumberingFrom(o: { ownNs: string | null; procIsOwn: boolean | null; uid: number | null; mountinfo: string | null }): boolean {
  if (o.ownNs !== MACHINE_PID_NAMESPACE || o.procIsOwn !== true) return false
  if (o.uid === 0) return true
  return o.mountinfo !== null && !procHidesProcesses(o.mountinfo)
}

/** How far two wall-clock readings of one process's start may differ and
 *  still be the same process, where the host has no exact token (macOS's
 *  `ps -o lstart` reads to the second). A process that reused the number
 *  started long after the worker's own start, never within this. */
export const START_TOLERANCE_SECS = 2

/** The ticks per second /proc reports start times in (USER_HZ, fixed at
 *  100 for every user-visible interface on Linux). */
const USER_HZ = 100

/** The /proc this reader reads, which a test may point elsewhere. */
const PROC = '/proc'

/**
 * D403: whether this reader's /proc numbers processes as this process
 * does. A sandbox that numbers its own processes but keeps the machine's
 * /proc (`unshare --pid --fork` without `--mount-proc`, bwrap without
 * `--proc`) leaves `/proc/<id>` naming another process than the id this
 * process knows, and `/proc/self` the id /proc gives this process. Null
 * where /proc cannot say.
 */
function procIsOwn(): boolean | null {
  try { return readlinkSync(`${PROC}/self`) === String(process.pid) } catch { return null }
}

/**
 * D403: the entry in /proc that is the process this reader knows by `pid`.
 * The id itself where /proc is this reader's own; where it is not, the
 * process /proc lists in this reader's numbering (its `ns/pid` link this
 * reader's own) whose id there (the last of its `NSpid` line) is `pid`, or
 * null when /proc lists none. Never another process's entry: a reading
 * from it would be another process's start.
 */
function procEntryOf(pid: number): number | null {
  if (procIsOwn() !== false) return pid
  const own = linuxPidNamespace('self')
  if (own === null) return null
  let entries: string[]
  try { entries = readdirSync(PROC) } catch { return null }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue
    const p = Number(e)
    const status = linuxStatus(p)
    const ids = status === null ? null : nsPidsIn(status)
    if (ids === null || ids.at(-1) !== pid) continue
    if (linuxPidNamespace(p) === own) return p
  }
  return null
}

function linuxBootMoment(): number | null {
  try {
    const m = /^btime\s+(\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))
    return m ? Number(m[1]) : null
  } catch { return null }
}

/** The raw start time of a process in clock ticks since boot: field 22
 *  of /proc/<pid>/stat. The command name sits in parentheses and may hold
 *  spaces, so the fields after the LAST ')' start at field 3 (state);
 *  starttime is the 20th of those. */
function linuxStartTicks(entry: number, root: string = PROC): number | null {
  try {
    const stat = readFileSync(`${root}/${entry}/stat`, 'utf8')
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const ticks = Number(rest[19])
    return Number.isFinite(ticks) ? ticks : null
  } catch { return null }
}

function linuxBootId(): string | null {
  try {
    const id = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    return id === '' ? null : id
  } catch { return null }
}

/** The start moment of the process /proc lists as `entry` (an id in the
 *  numbering /proc lists, see procEntryOf). */
function linuxStartOfEntry(entry: number, root: string = PROC): number | null {
  const ticks = linuxStartTicks(entry, root)
  const boot = linuxBootMoment()
  if (ticks === null || boot === null) return null
  return boot + ticks / USER_HZ
}

function linuxStartTokenOfEntry(entry: number, root: string = PROC): string | null {
  const ticks = linuxStartTicks(entry, root)
  const boot = linuxBootId()
  return ticks === null || boot === null ? null : `${boot}:${ticks}`
}

function linuxStart(pid: number): number | null {
  const entry = procEntryOf(pid)
  return entry === null ? null : linuxStartOfEntry(entry)
}

function linuxStartToken(pid: number): string | null {
  const entry = procEntryOf(pid)
  return entry === null ? null : linuxStartTokenOfEntry(entry)
}

function psStart(pid: number): number | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000, env: { ...process.env, LC_ALL: 'C' },
    }).trim()
    if (out === '') return null
    const t = Date.parse(out)
    return Number.isFinite(t) ? t / 1000 : null
  } catch { return null }
}

/** The numbering of the process /proc lists as `entry` ('self': this
 *  process, whichever id /proc gives it). */
function linuxPidNamespace(entry: number | 'self', root: string = PROC): string | null {
  try {
    const link = readlinkSync(`${root}/${entry}/ns/pid`)
    return /^pid:\[\d+\]$/.test(link) ? link : null
  } catch { return null }
}

/** A process's /proc status, readable for any process; null when gone. */
function linuxStatus(entry: number, root: string = PROC): string | null {
  try { return readFileSync(`${root}/${entry}/status`, 'utf8') } catch { return null }
}

/** The ids of a process in each numbering it is in, outermost first, as
 *  this reader's /proc lists them (the `NSpid` line); null when absent. */
function nsPidsIn(status: string): number[] | null {
  const m = /^NSpid:\s*(.+)$/m.exec(status)
  return m ? m[1]!.trim().split(/\s+/).map(Number) : null
}

/**
 * D403: look for a worker numbered apart from this reader. Every process
 * this reader's /proc lists is either in the numbering /proc belongs to
 * (its `NSpid` line holds one id, readable by anyone) or nested in one of
 * its own; a nested one's numbering is read from its `ns/pid` link, which
 * another user's process, or a non-dumpable one, does not let this reader
 * read. A nested process this reader cannot read is the worker only if its
 * id in its own numbering (the last of its `NSpid` line, which anyone may
 * read) is the worker's and its start (its `stat`, which anyone may read)
 * is the registered one or cannot be compared: such a process is said
 * (`unreadable`), so not seeing the worker is never taken for its end when
 * it may only be unreadable. Any other is not the worker whoever runs it
 * (a container another user or a service runs), and is passed over.
 * Exported with its /proc for a test that builds one; production reads
 * the machine's.
 */
export function linuxLookInNamespace(
  ns: string, pid: number, registered?: { start: number | null; token?: string | null }, root: string = PROC,
): NamespaceLook {
  const look: NamespaceLook = { seen: false, hostPid: null, unreadable: false }
  let entries: string[]
  try { entries = readdirSync(root) } catch { return { ...look, unreadable: true } }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue
    const p = Number(e)
    const status = linuxStatus(p, root)
    const ids = status === null ? null : nsPidsIn(status)
    if (ids === null || ids.length <= 1) continue
    const link = linuxPidNamespace(p, root)
    if (link === null) {
      if (ids.at(-1) !== pid) continue
      const same = registered
        ? sameProcessStart(registered, { start: linuxStartOfEntry(p, root), token: linuxStartTokenOfEntry(p, root) })
        : null
      if (same !== false) look.unreadable = true
      continue
    }
    if (link !== ns) continue
    look.seen = true
    if (ids.at(-1) === pid) {
      look.hostPid = p
      look.start = linuxStartOfEntry(p, root)
      look.token = linuxStartTokenOfEntry(p, root)
    }
  }
  return look
}

/** This host's operating system, as the phantom pass reads it. */
export const hostProbe: ProcessProbe = {
  host: () => hostname(),
  exists(pid: number): boolean | null {
    if (!Number.isInteger(pid) || pid <= 0) return null
    try {
      process.kill(pid, 0)
      return true
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ESRCH') return false
      // EPERM: a process holds the id, owned by someone else.
      if (code === 'EPERM') return true
      return null
    }
  },
  startMoment(pid: number): number | null {
    if (process.platform === 'linux') return linuxStart(pid)
    if (process.platform === 'win32') return null
    return psStart(pid)
  },
  startToken(pid: number): string | null {
    return process.platform === 'linux' ? linuxStartToken(pid) : null
  },
  pidNamespace(pid: number | 'self'): string | null {
    if (process.platform !== 'linux') return null
    if (pid === 'self') return linuxPidNamespace('self')
    const entry = procEntryOf(pid)
    return entry === null ? null : linuxPidNamespace(entry)
  },
  lookInNamespace(ns: string, pid: number, registered?: { start: number | null; token?: string | null }): NamespaceLook {
    return process.platform === 'linux' ? linuxLookInNamespace(ns, pid, registered) : { seen: false, hostPid: null, unreadable: true }
  },
  seesEveryNumbering(): boolean {
    if (process.platform !== 'linux') return false
    let mountinfo: string | null
    try { mountinfo = readFileSync(`${PROC}/self/mountinfo`, 'utf8') } catch { mountinfo = null }
    return seesEveryNumberingFrom({
      ownNs: linuxPidNamespace('self'), procIsOwn: procIsOwn(),
      uid: typeof process.getuid === 'function' ? process.getuid() : null, mountinfo,
    })
  },
  timeNamespace(pid: 'self'): string | null {
    if (process.platform !== 'linux') return null
    try {
      const link = readlinkSync(`${PROC}/${pid}/ns/time`)
      return /^time:\[\d+\]$/.test(link) ? link : null
    } catch { return null }
  },
}

/** The same process, by the readings a registration carries and the
 *  readings the host gives now (D317): the exact tokens when both have
 *  one, else the wall-clock moments within START_TOLERANCE_SECS; null
 *  when neither can be compared. */
export function sameProcessStart(
  registered: { start: number | null; token?: string | null },
  now: { start: number | null; token: string | null },
): boolean | null {
  if (registered.token && now.token) return registered.token === now.token
  if (registered.start === null || now.start === null) return null
  return Math.abs(now.start - registered.start) <= START_TOLERANCE_SECS
}
