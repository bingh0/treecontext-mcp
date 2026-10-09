import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import BetterSqlite3 from 'better-sqlite3'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import type { World } from './world.js'
import { sandboxedSpawnEnv } from '../helpers/cli-spawn.js'
import { storesDirIn } from '../helpers/store-fixtures.js'
import { TS_ROOT, tsxArgv, sleep, killAndWait } from './proc.js'

// ── Sidecar pane world ──────────────────────────────────────────────────
//
// The pane is treecontext's half of a seam whose other half is a program
// this repo does not depend on and must never import. So conformance is
// asserted against the CONTRACT AS WRITTEN, restated here — if ccr's
// renderer and this checker ever disagree, one of them is wrong about a
// document both can read, which is a better failure than a green suite
// that only proves treecontext agrees with itself.
//
// Split of duty, deliberate: scenarios about the SERVER (no pane before a
// drain, a drain writes one, a refused server writes none, every drain
// rewrites) spawn the real `serve` command, because the wiring and the
// store lock are exactly what they claim about. Scenarios about the PANE's
// CONTENT drive the real producer function against a real store — the same
// function the server calls, one caller removed. Neither half re-implements
// the other.

/**
 * The sidecar wave's world: the core `World` plus the pane fields nothing
 * outside this wave reads. `PaneKey` is declared below, so this file owns
 * both the pane vocabulary and the world that speaks it — world.ts used to
 * import PaneKey just to declare sPanes/sRaw, which pointed the shared world
 * at one wave's harness. That edge is gone; the dependency runs one way now
 * (sidecar-world -> world), like every other harness here.
 */
export interface SidecarWorld extends World {
  sHome?: string
  sDir?: string
  sDbPath?: string
  sPaneAbsentAtStartup?: boolean
  /** ccr-wiring scenarios: the sandboxed home, the reader's config, and
   *  what the command said about it. */
  wHome?: string
  wCfg?: string
  wFirstBytes?: string
  wBefore?: string
  wStatus?: number
  wOutput?: string
  wLinkTarget?: string
  sPanes?: Record<PaneKey, Record<string, unknown>>
  sRaw?: Record<PaneKey, Buffer>
  sBasisWindow?: [number, number]
  sComputed?: string[]
  sMtimes?: number[]
  sTornReads?: number
  sTopic?: string
}

/** ccr docs/PANE-CONTRACT.md v1, restated as a checker. */
export function paneContractViolations(blob: unknown, fileBytes: Buffer): string[] {
  const bad: string[] = []
  const b = blob as Record<string, unknown>
  const isStr = (v: unknown): v is string => typeof v === 'string'
  if (b?.['v'] !== 1) bad.push(`v is ${JSON.stringify(b?.['v'])}, not the integer 1`)
  for (const k of ['tool', 'title', 'status'] as const) {
    if (!isStr(b?.[k])) bad.push(`${k} is not a string`)
  }
  if (b?.['status'] !== 'ok' && b?.['status'] !== 'broken') bad.push(`status "${String(b?.['status'])}" is outside the enum`)
  const basis = b?.['basis'] as Record<string, unknown> | undefined
  if (!basis || !isStr(basis['label']) || !isStr(basis['at'])) bad.push('basis.label/at missing or not strings')
  if (b?.['status'] === 'broken' && !(isStr(b['message']) && b['message'].length > 0)) {
    bad.push('a broken pane carries no non-empty message')
  }
  const rows = b?.['rows']
  if (!Array.isArray(rows)) {
    bad.push('rows is not an array')
  } else {
    if (rows.length > 256) bad.push(`${rows.length} rows exceeds the 256-row cap`)
    const statuses = new Set(['ok', 'warn', 'alert', 'dark', 'off'])
    rows.forEach((r: Record<string, unknown>, i) => {
      if (!isStr(r?.['label']) || !isStr(r?.['value'])) bad.push(`row ${i}: label/value not both strings`)
      if (!statuses.has(String(r?.['status']))) bad.push(`row ${i}: status "${String(r?.['status'])}" outside the enum`)
      const spark = r?.['spark']
      if (spark !== undefined) {
        if (!Array.isArray(spark) || spark.length > 32) bad.push(`row ${i}: spark is not an array of at most 32`)
        else if (!spark.every((n) => typeof n === 'number' && Number.isFinite(n))) bad.push(`row ${i}: spark holds a non-finite number`)
      }
    })
  }
  if (fileBytes.length > 256 * 1024) bad.push(`file is ${fileBytes.length} bytes, over the 256 KB cap`)
  // The bytes rule, checked on the bytes: no display string may carry
  // terminal control into a renderer. Tabs and newlines are JSON-escaped
  // by the writer, so any raw control byte here is a real leak.
  for (const byte of fileBytes) {
    if ((byte < 0x09 || (byte > 0x0d && byte < 0x20) || byte === 0x7f)) {
      bad.push(`raw control byte 0x${byte.toString(16)} reached the file`)
      break
    }
  }
  return bad
}

// Mirrors the producer's own map. Deliberately restated rather than
// imported: if a pane is added there and not here, the readPanes loop
// stops covering it, and a scenario asserting "every pane" would quietly
// mean "every pane I remembered".
export const SIDECAR_FILES = {
  journal: 'sidecar.json', threads: 'sidecar-threads.json', trail: 'sidecar-trail.json',
} as const
export type PaneKey = keyof typeof SIDECAR_FILES
export const ALL_PANES = Object.keys(SIDECAR_FILES) as PaneKey[]

/** Built from char codes so this file never contains a raw control byte. */
export const ESC = String.fromCharCode(0x1b)
export const DEL = String.fromCharCode(0x7f)

export function readPanes(w: SidecarWorld): void {
  const out = {} as NonNullable<SidecarWorld['sPanes']>
  const raw = {} as NonNullable<SidecarWorld['sRaw']>
  for (const which of ALL_PANES) {
    const p = join(w.sDir!, SIDECAR_FILES[which])
    raw[which] = readFileSync(p)
    out[which] = JSON.parse(raw[which].toString('utf8')) as Record<string, unknown>
  }
  w.sPanes = out
  w.sRaw = raw
}

export const paneRows = (pane: Record<string, unknown>): Array<Record<string, unknown>> =>
  pane['rows'] as Array<Record<string, unknown>>

/** The store every sidecar scenario runs against: the directory this harness
 *  seeds, and the `--store` name the spawned server is pointed at. One
 *  constant, because a server serving a different store than the harness
 *  seeded writes its panes where nothing looks. */
export const SIDECAR_STORE = 'paneprobe'

/** A real store in a real directory, with the panes' own home beside it. */
export async function openSidecarStore(w: SidecarWorld, opts: { maxStoreBytes?: number } = {}): Promise<FlatStore> {
  w.sHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-sidecar-')))
  w.defer(() => rmSync(w.sHome!, { recursive: true, force: true }))
  w.sDir = join(storesDirIn(w.sHome), SIDECAR_STORE)
  mkdirSync(w.sDir, { recursive: true })
  w.sDbPath = join(w.sDir, 'treecontext.db')
  const store = await FlatStore.open({
    database: wrapBetterSqlite(new BetterSqlite3(w.sDbPath)),
    ownsDatabase: true,
    ...opts,
  })
  w.defer(() => store.close())
  w.store = store
  return store
}

/**
 * Spawn the real `serve` command against this wave's private HOME and store.
 *
 * No options: every scenario here serves the one seeded store out of the one
 * sandbox home, with capture ON — the drain is what writes a pane, so a
 * captureless server has nothing to say about panes. It carried a
 * `{ home, store, capture }` object until the extraction review found all four
 * call sites passing the identical literal and the `--no-capture` branch
 * unreached. If a scenario ever needs to vary one, give THAT one an argument
 * (a defaulted flag, not a required object) rather than restoring all three.
 */
export function spawnSidecarServer(w: SidecarWorld): void {
  const env = sandboxedSpawnEnv(w.sHome!)
  const child = spawn(process.execPath, tsxArgv(
    join(TS_ROOT, 'src', 'server', 'cli.ts'), 'serve',
    '--transport', 'stdio', '--lexical', '--store', SIDECAR_STORE, '--capture',
  ), { env, cwd: TS_ROOT, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdout.resume()
  child.stderr.resume()
  w.defer(killAndWait(child))
}

export async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  for (let i = 0; i * 100 < ms; i++) {
    if (pred()) return true
    await sleep(100)
  }
  return pred()
}

/** The drain's cadence (IngestionLoop default). Waits are multiples of it. */
export const DRAIN_MS = 5000

