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
import { readFileSync } from 'node:fs'
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
}

/** How far two wall-clock readings of one process's start may differ and
 *  still be the same process, where the host has no exact token (macOS's
 *  `ps -o lstart` reads to the second). A process that reused the number
 *  started long after the worker's own start, never within this. */
export const START_TOLERANCE_SECS = 2

/** The ticks per second /proc reports start times in (USER_HZ, fixed at
 *  100 for every user-visible interface on Linux). */
const USER_HZ = 100

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
function linuxStartTicks(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
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

function linuxStart(pid: number): number | null {
  const ticks = linuxStartTicks(pid)
  const boot = linuxBootMoment()
  if (ticks === null || boot === null) return null
  return boot + ticks / USER_HZ
}

function linuxStartToken(pid: number): string | null {
  const ticks = linuxStartTicks(pid)
  const boot = linuxBootId()
  return ticks === null || boot === null ? null : `${boot}:${ticks}`
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
