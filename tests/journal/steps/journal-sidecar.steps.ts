import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { hostname, tmpdir } from 'node:os'
import { expect } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { type Registry } from 'gherkin-node-test/vitest'
import { wrapBetterSqlite } from '../../../src/persistence/better-sqlite.js'
import { runMigrations } from '../../../src/persistence/migrations.js'
import { FlatStore } from '../../../src/flat-store.js'
import { IngestionLoop } from '../../../src/server/ingestion.js'
import { LeaseClient, DRAIN_LEASE_TTL_SECS } from '../../../src/persistence/leases.js'
import { computeSidecarPanes, publishSidecarPanes } from '../../../src/server/sidecar-blob.js'
import { sandboxedSpawnEnv } from '../../helpers/cli-spawn.js'
import { storesDirIn } from '../../helpers/store-fixtures.js'
import { TS_ROOT, tsxArgv, sleep } from '../proc.js'
import { type SidecarWorld, paneContractViolations, SIDECAR_FILES, SIDECAR_STORE, ALL_PANES, ESC, DEL, readPanes, paneRows, openSidecarStore, spawnSidecarServer, waitFor, DRAIN_MS } from '../sidecar-world.js'

export const sidecarDefiner = (reg: Registry<SidecarWorld>): void => {
  // ── Wiring the join into the reader's own config ─────────────────────
  //
  // Drives the real CLI in a sandboxed home, because the promise being
  // made is about a file on someone's disk. XDG_CONFIG_HOME and CCR_CONFIG
  // are cleared explicitly: a developer's own env must not decide where
  // these scenarios write.

  const runWire = (w: SidecarWorld, ...extra: string[]): void => {
    const res = spawnSync(
      process.execPath,
      tsxArgv(join(TS_ROOT, 'src', 'server', 'cli.ts'), 'ccr', 'wire', '--store', 'paneproj', ...extra),
      { env: sandboxedSpawnEnv(w.wHome!), encoding: 'utf8' },
    )
    w.wStatus = res.status ?? -1
    w.wOutput = `${res.stdout ?? ''}${res.stderr ?? ''}`
  }

  const readerConfig = (w: SidecarWorld): string => readFileSync(w.wCfg!, 'utf8')

  const seedHome = (w: SidecarWorld): void => {
    w.wHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-ccr-wire-')))
    w.defer(() => rmSync(w.wHome!, { recursive: true, force: true }))
    w.wCfg = join(w.wHome, '.config', 'ccr', 'config.json')
  }

  const seedConfig = (w: SidecarWorld, bytes: Buffer | string): void => {
    mkdirSync(dirname(w.wCfg!), { recursive: true })
    writeFileSync(w.wCfg!, bytes)
    w.wBefore = readFileSync(w.wCfg!, 'latin1')
  }

  reg.define(/^a machine with no reader config at all$/, (w: SidecarWorld) => {
    seedHome(w)
    expect(existsSync(w.wCfg!)).toBe(false)
  })

  reg.define(/^a reader config that already lists another tool's pane and a setting of its own$/, (w: SidecarWorld) => {
    seedHome(w)
    seedConfig(w, JSON.stringify({ theme: 'dark', panes: [{ path: '/x/other-tool/sidecar.json' }] }, null, 2))
  })

  reg.define(/^a reader config saved with a byte-order mark, listing another tool's pane$/, (w: SidecarWorld) => {
    seedHome(w)
    seedConfig(w, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(JSON.stringify({ panes: [{ path: '/x/other-tool/sidecar.json' }] })),
    ]))
  })

  reg.define(/^a reader config listing an entry treecontext does not understand$/, (w: SidecarWorld) => {
    seedHome(w)
    seedConfig(w, JSON.stringify({ panes: [{ note: 'mine, not a path yet' }] }, null, 2))
  })

  reg.define(/^the entry treecontext does not understand is still there$/, (w: SidecarWorld) => {
    expect(readerConfig(w)).toContain('mine, not a path yet')
  })

  reg.define(/^a reader config that is a symlink into a dotfiles directory$/, (w: SidecarWorld) => {
    seedHome(w)
    const dots = join(w.wHome!, 'dotfiles')
    mkdirSync(dots, { recursive: true })
    w.wLinkTarget = join(dots, 'ccr-config.json')
    writeFileSync(w.wLinkTarget, JSON.stringify({ panes: [] }, null, 2))
    mkdirSync(dirname(w.wCfg!), { recursive: true })
    symlinkSync(w.wLinkTarget, w.wCfg!)
  })

  reg.define(/^the config is still a symlink$/, (w: SidecarWorld) => {
    expect(lstatSync(w.wCfg!).isSymbolicLink(), 'the dotfiles link was replaced by a regular file').toBe(true)
  })

  reg.define(/^the pane landed in the file the link points at$/, (w: SidecarWorld) => {
    const data = JSON.parse(readFileSync(w.wLinkTarget!, 'utf8')) as { panes: { path: string }[] }
    expect(data.panes.some((p) => p.path.includes('paneproj'))).toBe(true)
  })

  reg.define(/^a reader config that is not valid JSON$/, (w: SidecarWorld) => {
    seedHome(w)
    seedConfig(w, '{ "panes": [ { "path": "/x/other-tool/sidecar.json" }, ] }')
  })

  reg.define(/^the operator asks treecontext to wire this project's pane in$/, (w: SidecarWorld) => {
    runWire(w)
    if (w.wStatus === 0 && existsSync(w.wCfg!)) w.wFirstBytes = readerConfig(w)
  })

  reg.define(/^the operator asks a second time$/, (w: SidecarWorld) => {
    runWire(w)
  })

  reg.define(/^the reader's config lists this project's pane$/, (w: SidecarWorld) => {
    // Entries preserved verbatim need not carry a `path` — the config can
    // hold anything the operator wrote, and ccr skips what it cannot use.
    const data = JSON.parse(readerConfig(w)) as { panes: { path?: unknown }[] }
    const ours = data.panes.filter((p) => typeof p?.path === 'string'
      && p.path.includes('paneproj') && p.path.endsWith('sidecar.json'))
    expect(ours.length, `no pane for this project in ${readerConfig(w)}`).toBe(1)
  })

  reg.define(/^the file written carries no byte-order mark$/, (w: SidecarWorld) => {
    expect(readFileSync(w.wCfg!)[0]).toBe(0x7b)
  })

  reg.define(/^the config is byte-for-byte what the first run wrote$/, (w: SidecarWorld) => {
    expect(readerConfig(w)).toBe(w.wFirstBytes)
  })

  reg.define(/^both panes are listed, the other tool's first$/, (w: SidecarWorld) => {
    const data = JSON.parse(readerConfig(w)) as { panes: { path: string }[] }
    expect(data.panes.length).toBe(2)
    expect(data.panes[0]!.path).toBe('/x/other-tool/sidecar.json')
    expect(data.panes[1]!.path).toContain('paneproj')
  })

  reg.define(/^the other tool's setting is still there$/, (w: SidecarWorld) => {
    expect((JSON.parse(readerConfig(w)) as { theme?: string }).theme).toBe('dark')
  })

  reg.define(/^the command refuses and names the reason$/, (w: SidecarWorld) => {
    expect(w.wStatus, `expected a refusal, got: ${w.wOutput}`).not.toBe(0)
    expect(w.wOutput).toMatch(/not valid JSON/)
  })

  reg.define(/^the config is left exactly as it was$/, (w: SidecarWorld) => {
    expect(readFileSync(w.wCfg!, 'latin1')).toBe(w.wBefore)
  })

  // ── Server-wiring scenarios (real subprocesses) ──────────────────────

  reg.define(/^a server started against a store whose drain has not yet run$/, async (w: SidecarWorld) => {
    w.sHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-sidecar-boot-')))
    w.defer(() => rmSync(w.sHome!, { recursive: true, force: true }))
    w.sDir = join(storesDirIn(w.sHome), SIDECAR_STORE)
    w.sDbPath = join(w.sDir, 'treecontext.db')
    spawnSidecarServer(w)
    // The store file appears within a second; the first drain is a full
    // interval out. Sample the instant the store exists — if a pane were
    // written at startup it would already be here.
    const up = await waitFor(() => existsSync(w.sDbPath!), 20_000)
    expect(up, 'server never created its store').toBe(true)
    w.sPaneAbsentAtStartup = !existsSync(join(w.sDir, SIDECAR_FILES.journal))
  })

  reg.define(/^a reader looks beside the store for a pane$/, () => {
    // The look already happened, at the only moment when the answer is
    // meaningful — before the first drain could have completed.
  })

  reg.define(/^there is no pane file to read$/, (w: SidecarWorld) => {
    expect(w.sPaneAbsentAtStartup, 'a pane existed before any drain had run').toBe(true)
  })

  reg.define(/^staged events waiting to be drained$/, async (w: SidecarWorld) => {
    w.sHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-sidecar-drain-')))
    w.defer(() => rmSync(w.sHome!, { recursive: true, force: true }))
    w.sDir = join(storesDirIn(w.sHome), SIDECAR_STORE)
    w.sDbPath = join(w.sDir, 'treecontext.db')
    spawnSidecarServer(w)
    expect(await waitFor(() => existsSync(w.sDbPath!), 20_000), 'no store').toBe(true)
    await sleep(500)
    const raw = new BetterSqlite3(w.sDbPath)
    const ins = raw.prepare(
      'INSERT INTO staging (session_id, role, content, tool_name, timestamp, priority, processed) ' +
      'VALUES (?,?,?,?,?,?,0)',
    )
    const now = Date.now() / 1000
    for (let i = 0; i < 5; i++) ins.run('pane-session', 'user', `staged message ${i}`, null, now, 1)
    raw.close()
  })

  reg.define(/^the drain runs$/, async (w: SidecarWorld) => {
    const ok = await waitFor(() => existsSync(join(w.sDir!, SIDECAR_FILES.threads)), 4 * DRAIN_MS)
    expect(ok, 'no pane appeared within four drain intervals').toBe(true)
    readPanes(w)
  })

  reg.define(/^a pane file sits beside the store$/, (w: SidecarWorld) => {
    expect(existsSync(join(w.sDir!, SIDECAR_FILES.journal))).toBe(true)
    expect(dirname(join(w.sDir!, SIDECAR_FILES.journal))).toBe(dirname(w.sDbPath!))
  })

  reg.define(/^a reader applying the published pane contract accepts it without knowing what treecontext is$/, (w: SidecarWorld) => {
    for (const which of ALL_PANES) {
      expect(paneContractViolations(w.sPanes![which], w.sRaw![which]), `${which} pane`).toEqual([])
    }
  })

  reg.define(
    /^a healthy pane and a drain still working when the server is told to stop$/,
    async (w: SidecarWorld) => {
      const store = await openSidecarStore(w)
      await store.insert('an entry so the panes have something to report')
      const loop = new IngestionLoop(store as never, {
        intervalMs: 10,
        batchSize: 200,
        onBatch: ({ failure }) =>
          publishSidecarPanes({
            source: store, storePath: w.sDbPath!, storeName: 'paneprobe',
            atSec: Date.now() / 1000, failure,
          }),
      })
      w.defer(() => loop.stop())
      // Phase timings, printed on every run. This scenario blew the 30s budget
      // on Windows the first time it ever executed there, and the scenario is
      // entirely in-process — no child, no signal — so the cost is one of the
      // phases below and guessing which would be exactly the mistake this
      // whole exercise has been about. Cheap on POSIX, and the log is the
      // evidence if it times out again.
      //
      // RULED at the 0.1 charter pull-in (2026-08-12): the budget stays
      // vitest's DEFAULT 30s, deliberately unconfigured. The one blowout
      // was the Windows lane's first-ever execution (2026-08-05, the run
      // that also found the lane had never run at all); every full-matrix
      // Windows run since — 0.0.15 through the 0.0.16 line — has passed
      // with phases totalling ~150ms. Raising the budget would hide a
      // recurrence; a bespoke constant would be a number nobody measured.
      // The instrumentation below is the standing mitigation: if it blows
      // again, the phase log names the culprit from the killed run.
      const t0 = Date.now()
      // process.stderr.write, not console.error: vitest intercepts console and
      // buffers it per test, and a test killed by the 30s timeout never gets
      // that buffer flushed — which is precisely the run we need the numbers
      // from. A direct synchronous write survives the kill.
      const mark = (phase: string): void =>
        void process.stderr.write(`[sidecar-shutdown] ${phase}: ${String(Date.now() - t0)}ms\n`)
      loop.start()
      // Let drains complete so a HEALTHY pane exists to be overwritten —
      // without one, the scenario passes for the boring reason that there
      // was never a pane at all.
      await waitFor(() => existsSync(join(w.sDir!, SIDECAR_FILES.journal)), 5000)
      mark('first pane on disk')
      readPanes(w)
      expect(w.sPanes!.journal['status'], 'no healthy pane before the shutdown').toBe('ok')
      // A backlog large enough that a batch is genuinely mid-flight when
      // stop() lands — ingestBatch runs async inserts for up to 500ms.
      for (let i = 0; i < 300; i++) {
        store.store.insertStaging({
          sessionId: 'shutdown-probe', role: 'user',
          content: `staged row ${i} `.repeat(40),
          timestamp: Date.now() / 1000, priority: 1,
        })
      }
      mark('300 staging rows inserted')
      await sleep(20)
      loop.stop()
      mark('loop stopped')
    },
  )

  reg.define(/^the store closes behind that drain$/, async (w: SidecarWorld) => {
    await (w.store as unknown as FlatStore).close()
    // Long enough for the in-flight batch to land its `finally` against the
    // now-closed store, which is exactly when the false confession appeared.
    await sleep(600)
    readPanes(w)
  })

  reg.define(/^the pane still on disk is the healthy one$/, (w: SidecarWorld) => {
    for (const which of ALL_PANES) {
      expect(
        w.sPanes![which]['status'],
        `${which} pane accuses treecontext of failing after a clean shutdown: ` +
          String(w.sPanes![which]['message']),
      ).toBe('ok')
    }
  })

  reg.define(/^a store already held by another treecontext server$/, (w: SidecarWorld) => {
    w.sHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-sidecar-lock-')))
    w.defer(() => rmSync(w.sHome!, { recursive: true, force: true }))
    w.sDir = join(storesDirIn(w.sHome), SIDECAR_STORE)
    w.sDbPath = join(w.sDir, 'treecontext.db')
    mkdirSync(w.sDir, { recursive: true })
    // THIS process holds the drain role, as a `serve --capture` holder
    // would (same stand-in precedent as the concurrent-sessions binding)
    // — and writes no panes of its own, which isolates the claim: any
    // pane that appears was written by the server that was refused the
    // drain, the defect under test. A spawned non-capture holder no
    // longer works here: since the program-C review (finding 2), a
    // server that would not drain does not contest the drain role.
    // G4: hold the drain LEASE from this process — migrate the store
    // first (the lease table is schema), then write the row the spawned
    // server will be refused by.
    const drainDb = wrapBetterSqlite(new BetterSqlite3(w.sDbPath))
    runMigrations(drainDb, { migrate: true })
    const drainHolder = new LeaseClient(drainDb, { pid: process.pid, host: hostname() })
    drainHolder.tryAcquire('drain', DRAIN_LEASE_TTL_SECS)
    w.defer(() => {
      drainHolder.releaseAll()
      drainDb.close()
    })
  })

  reg.define(/^a second server starts against that store and is refused the drain$/, async (w: SidecarWorld) => {
    spawnSidecarServer(w)
    // Three drain intervals: long enough that a second server which DID
    // own the drain would have written several panes by now.
    await sleep(3 * DRAIN_MS)
  })

  reg.define(/^no pane appears beside the store$/, (w: SidecarWorld) => {
    const found = readdirSync(w.sDir!).filter((f) => f.startsWith('sidecar'))
    expect(found, 'a server without the drain wrote a pane').toEqual([])
  })

  reg.define(/^two consecutive drains over a journal that did not change between them$/, async (w: SidecarWorld) => {
    w.sHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-sidecar-age-')))
    w.defer(() => rmSync(w.sHome!, { recursive: true, force: true }))
    const dir = join(storesDirIn(w.sHome), SIDECAR_STORE)
    w.sDir = dir
    w.sDbPath = join(dir, 'treecontext.db')
    spawnSidecarServer(w)
    expect(await waitFor(() => existsSync(join(dir, SIDECAR_FILES.journal)), 20_000), 'no first pane').toBe(true)
  })

  reg.define(/^each drain finishes$/, async (w: SidecarWorld) => {
    const pane = join(w.sDir!, SIDECAR_FILES.journal)
    const first = statSync(pane).mtimeMs
    // Nothing is staged in this window, so the journal is unchanged and a
    // producer that skipped identical rewrites would leave the mtime put.
    await sleep(2 * DRAIN_MS + 1000)
    w.sMtimes = [first, statSync(pane).mtimeMs]
  })

  reg.define(/^the pane file is rewritten both times$/, (w: SidecarWorld) => {
    const [first, second] = w.sMtimes!
    expect(second!, 'the pane was not rewritten by a drain that changed nothing').toBeGreaterThan(first!)
  })

  // ── Producer scenarios (real store, real producer) ───────────────────

  reg.define(/^a drain that has written a pane$/, async (w: SidecarWorld) => {
    const store = await openSidecarStore(w)
    await store.insert('an entry so the pane has something to count')
    const at = Date.now() / 1000
    w.sBasisWindow = [at - 120, at + 120]
    publishSidecarPanes({ source: store, storePath: w.sDbPath!, storeName: 'paneprobe', atSec: at })
  })

  reg.define(/^the pane is read$/, (w: SidecarWorld) => readPanes(w))

  reg.define(/^it names treecontext as the producer of every claim on it$/, (w: SidecarWorld) => {
    for (const which of ALL_PANES) {
      expect(w.sPanes![which]['tool'], `${which} pane producer`).toBe('treecontext')
    }
  })

  reg.define(/^it names the drain as the moment those claims were counted$/, (w: SidecarWorld) => {
    const basis = w.sPanes!.journal['basis'] as Record<string, string>
    expect(basis['label']).toBe('drain')
    // "2026-08-04 18:57Z" — the pane marks its stamp UTC so a reader beside
    // a local wall clock does not read a correct pane as hours behind.
    expect(basis['at'], 'the basis stamp does not say which clock it is on').toMatch(/Z$/)
    const parsed = Date.parse(basis['at']!.replace(' ', 'T')) / 1000
    const [lo, hi] = w.sBasisWindow!
    expect(parsed, `basis "${basis['at']}" is not the drain's moment`).toBeGreaterThanOrEqual(lo!)
    expect(parsed).toBeLessThanOrEqual(hi!)
  })

  reg.define(/^a store holding one drained event and nothing else$/, async (w: SidecarWorld) => {
    const store = await openSidecarStore(w)
    await store.insert('the only entry in this journal', { metadata: { source: 'auto-capture' } })
  })

  reg.define(/^the drain writes the pane$/, (w: SidecarWorld) => {
    publishSidecarPanes({
      source: w.store as unknown as FlatStore,
      storePath: w.sDbPath!, storeName: 'paneprobe', atSec: Date.now() / 1000,
    })
    readPanes(w)
  })

  reg.define(
    /^the pane carries a row for captured events, for the drain backlog, for gap markers, for curated notes, and for open threads$/,
    (w: SidecarWorld) => {
      const labels = paneRows(w.sPanes!.journal).map((r) => r['label'])
      for (const want of ['capture', 'drain', 'requeued', 'gaps', 'curated', 'threads', 'journal']) {
        expect(labels, `the row floor is missing "${want}"`).toContain(want)
      }
    },
  )

  reg.define(/^a family with nothing to report is present and readable rather than missing$/, (w: SidecarWorld) => {
    // This store has no gaps and no failed drains — the two families with
    // literally nothing to say. Both must still render something a reader
    // can act on, not an empty cell.
    for (const label of ['gaps', 'requeued']) {
      const row = paneRows(w.sPanes!.journal).find((r) => r['label'] === label)
      expect(row, `"${label}" vanished when it had nothing to report`).toBeDefined()
      expect(String(row!['value']).length, `"${label}" rendered an empty value`).toBeGreaterThan(0)
    }
  })

  reg.define(/^a drain that cannot complete$/, async (w: SidecarWorld) => {
    await openSidecarStore(w)
    w.sTopic = 'staging read failed: database disk image is malformed'
  })

  reg.define(/^the pane is written$/, (w: SidecarWorld) => {
    publishSidecarPanes({
      source: w.store as unknown as FlatStore,
      storePath: w.sDbPath!, storeName: 'paneprobe',
      atSec: Date.now() / 1000, failure: w.sTopic!,
    })
    readPanes(w)
  })

  reg.define(/^the pane reports itself broken and names what failed$/, (w: SidecarWorld) => {
    for (const which of ALL_PANES) {
      expect(w.sPanes![which]['status'], `${which} pane`).toBe('broken')
      expect(String(w.sPanes![which]['message'])).toContain('malformed')
      expect(paneContractViolations(w.sPanes![which], w.sRaw![which]), `${which} pane`).toEqual([])
    }
  })

  reg.define(/^it carries no rows that a reader would draw as health$/, (w: SidecarWorld) => {
    for (const which of ALL_PANES) {
      expect(paneRows(w.sPanes![which]), `${which} pane shipped rows behind a failure`).toEqual([])
    }
  })

  reg.define(/^an unchanged journal$/, async (w: SidecarWorld) => {
    const store = await openSidecarStore(w)
    await store.insert('an entry to give the counts something to count')
    await store.insert('a thread', { metadata: { next_session: true, topic: 'the open thread' } })
  })

  reg.define(/^a pane is computed twice for the same drain moment$/, (w: SidecarWorld) => {
    const store = w.store as unknown as FlatStore
    const at = Math.floor(Date.now() / 1000)
    const once = () => JSON.stringify(computeSidecarPanes(store.vitals(at), 'paneprobe'))
    // A later moment over the same store, to show the moment is an INPUT
    // rather than something the pane reaches for on its own.
    const later = JSON.stringify(computeSidecarPanes(store.vitals(at + 3600), 'paneprobe'))
    w.sComputed = [once(), once(), later]
  })

  reg.define(/^the two panes are byte-for-byte identical$/, (w: SidecarWorld) => {
    const [a, b] = w.sComputed!
    expect(b, 'the same journal at the same moment produced two different panes').toBe(a)
  })

  reg.define(
    /^every count on them is fixed at the moment it was taken rather than recomputed against whoever reads it later$/,
    (w: SidecarWorld) => {
      const [a, , later] = w.sComputed!
      expect(later, 'the drain moment made no difference to the pane, so nothing is anchored to it').not.toBe(a)
    },
  )

  reg.define(/^a curated note whose topic carries terminal escape bytes$/, async (w: SidecarWorld) => {
    const store = await openSidecarStore(w)
    // A full SGR sequence plus a DEL: what a hostile repo, a fetched page,
    // or a mischievous agent could put through the journal into a topic.
    w.sTopic = `${ESC}[31mred alert${ESC}[0m pane title${DEL}`
    await store.insert('a close-out whose topic is hostile', {
      metadata: { next_session: true, topic: w.sTopic },
    })
  })

  reg.define(/^the topic reaches the pane as inert text$/, (w: SidecarWorld) => {
    const values = paneRows(w.sPanes!.threads).map((r) => String(r['value']))
    const hit = values.find((v) => v.includes('red alert'))
    expect(hit, `no thread row carried the topic; rows were ${JSON.stringify(values)}`).toBeDefined()
    expect(hit, 'the escape survived into the pane').not.toContain(ESC)
    expect(hit, 'the DEL byte survived into the pane').not.toContain(DEL)
  })

  reg.define(/^no escape byte from the journal survives into the file$/, (w: SidecarWorld) => {
    for (const which of ALL_PANES) {
      const bytes = w.sRaw![which]
      expect(bytes.includes(0x1b), `${which} pane file carries a raw ESC`).toBe(false)
      expect(bytes.includes(0x7f), `${which} pane file carries a raw DEL`).toBe(false)
    }
  })

  reg.define(/^a journal entry tagged to resume next session$/, async (w: SidecarWorld) => {
    const store = await openSidecarStore(w)
    w.sTopic = 'the thread this session is in the middle of'
    await store.insert('CLOSE-OUT — where to pick up', {
      metadata: { next_session: true, topic: w.sTopic },
    })
    await store.insert('an older plan this one replaced', {
      metadata: { status: 'superseded', topic: 'the finished thread' },
    })
  })

  reg.define(/^the drain writes the panes$/, (w: SidecarWorld) => {
    publishSidecarPanes({
      source: w.store as unknown as FlatStore,
      storePath: w.sDbPath!, storeName: 'paneprobe', atSec: Date.now() / 1000,
    })
    readPanes(w)
  })

  reg.define(/^one pane lists that thread under its own topic$/, (w: SidecarWorld) => {
    const values = paneRows(w.sPanes!.threads).map((r) => String(r['value']))
    expect(values, 'the open thread is not on the threads pane').toContain(w.sTopic)
  })

  reg.define(/^a thread that a later entry superseded is listed as closed rather than dropped$/, (w: SidecarWorld) => {
    const closed = paneRows(w.sPanes!.threads).find((r) => r['label'] === 'closed out')
    expect(closed, 'nothing on the pane accounts for closed threads').toBeDefined()
    expect(Number(closed!['value']), 'the superseded thread was dropped rather than counted').toBe(1)
  })

  reg.define(/^a pane being rewritten many times in succession$/, async (w: SidecarWorld) => {
    const store = await openSidecarStore(w)
    await store.insert('an entry to give the pane some bulk to write')
  })

  reg.define(/^a reader reads the file at arbitrary moments throughout$/, async (w: SidecarWorld) => {
    const store = w.store as unknown as FlatStore
    const pane = join(w.sDir!, SIDECAR_FILES.journal)
    // The reader is a SEPARATE process: writes here are synchronous, so an
    // in-process reader could never observe a partial file no matter how
    // the write was done — it would pass on a plain overwrite too.
    const reader = spawn(process.execPath, ['-e', `
      const fs = require('node:fs');
      let torn = 0, reads = 0;
      const t = setInterval(() => {
        reads++;
        try { const s = fs.readFileSync(${JSON.stringify(pane)}, 'utf8'); JSON.parse(s); }
        catch (e) { if (e && e.code !== 'ENOENT') torn++; }
      }, 1);
      setTimeout(() => { clearInterval(t); console.log(JSON.stringify({ torn, reads })); }, 2000);
    `], { stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    reader.stdout.on('data', (d: Buffer) => { out += d.toString() })
    const done = new Promise<void>((r) => reader.on('exit', () => r()))
    const until = Date.now() + 1800
    while (Date.now() < until) {
      publishSidecarPanes({ source: store, storePath: w.sDbPath!, storeName: 'paneprobe', atSec: Date.now() / 1000 })
    }
    await done
    const parsed = JSON.parse(out.trim() || '{"torn":-1,"reads":0}') as { torn: number; reads: number }
    expect(parsed.reads, 'the reader never got a read in').toBeGreaterThan(10)
    w.sTornReads = parsed.torn
  })

  reg.define(/^every read yields a whole pane, never a partial one$/, (w: SidecarWorld) => {
    expect(w.sTornReads, 'a reader caught the pane mid-write').toBe(0)
  })

  reg.define(/^no leftover temporary file is left beside the store$/, (w: SidecarWorld) => {
    const strays = readdirSync(w.sDir!).filter((f) => f.includes('.tmp.'))
    expect(strays, 'a temp file was left beside the store').toEqual([])
  })

  // ── Trail pane ───────────────────────────────────────────────────────

  reg.define(/^a journal of classified tool events alongside turns nothing classified$/, async (w: SidecarWorld) => {
    const store = await openSidecarStore(w)
    // The mix a real session produces, including the classifier's own false
    // positives — a grep whose OUTPUT merely contains the word "failed".
    const mix: Array<[string, string]> = [
      ['success', 'ls: three files, nothing unusual'],
      ['success', 'the edit applied'],
      ['success', 'tests green'],
      ['soft_fail', 'warning: deprecated flag'],
      ['error', 'Error: ENOENT no such file'],
      ['error', 'grep results: 4 matches for "failed" in the test suite'],
    ]
    for (const [exit, content] of mix) {
      await store.insert(content, { metadata: { source: 'auto-capture', exit_type: exit } })
    }
    // Entries carrying NO exit type, and enough of them to move a share.
    // Without these the two candidate denominators are the same number and
    // the scenario below cannot tell a correct pane from a wrong one — the
    // gap a mutation found, rather than a precaution.
    for (let i = 0; i < 6; i++) {
      await store.insert(`a curated note number ${i}, classified by nothing`)
    }
  })

  reg.define(/^the trail pane reports how many events were classified each way$/, (w: SidecarWorld) => {
    const rows = paneRows(w.sPanes!.trail)
    const by = (label: string) => rows.find((r) => r['label'] === label)
    for (const label of ['clean', 'soft fails', 'errors']) {
      expect(by(label), `the trail pane has no "${label}" row`).toBeDefined()
    }
    expect(String(by('clean')!['value']), 'the clean count is not the three successes').toMatch(/^3\b/)
    expect(String(by('soft fails')!['value'])).toMatch(/^1\b/)
    expect(String(by('errors')!['value']), 'the error count is not the two classified errors').toMatch(/^2\b/)
  })

  reg.define(
    /^each share is taken against the events that were classified, not against the whole journal$/,
    (w: SidecarWorld) => {
      // 6 classified (3 success) alongside 6 unclassified notes: the right
      // denominator says 50%, the whole journal says 25%.
      const clean = paneRows(w.sPanes!.trail).find((r) => r['label'] === 'clean')!
      expect(
        String(clean['value']),
        'the share is diluted by entries that carry no classification at all',
      ).toContain('50%')
    },
  )

  reg.define(/^none of those rows is coloured as a problem$/, (w: SidecarWorld) => {
    const rows = paneRows(w.sPanes!.trail)
    for (const label of ['clean', 'soft fails', 'errors']) {
      const status = rows.find((r) => r['label'] === label)!['status']
      expect(['off', 'dark'], `"${label}" is coloured ${String(status)} — a word search graded as health`)
        .toContain(String(status))
    }
  })

  reg.define(/^the row a reader would misread says what produced its number$/, (w: SidecarWorld) => {
    const errors = paneRows(w.sPanes!.trail).find((r) => r['label'] === 'errors')!
    expect(String(errors['detail']), 'the errors row does not disclose that it is text-matched')
      .toMatch(/output text/)
  })

  reg.define(/^a journal whose stored bytes exceed the retention budget$/, async (w: SidecarWorld) => {
    // A budget any real entry blows through, so the gauge reads over.
    const store = await openSidecarStore(w, { maxStoreBytes: 32 })
    await store.insert('an entry comfortably larger than a thirty-two byte budget, several times over')
  })

  reg.define(/^the trail pane reports the store as over its budget$/, (w: SidecarWorld) => {
    const row = paneRows(w.sPanes!.trail).find((r) => r['label'] === 'retention')
    expect(row, 'the trail pane has no retention row').toBeDefined()
    expect(String(row!['value'])).toBe('over budget')
  })

  reg.define(/^that row is coloured as worth a glance$/, (w: SidecarWorld) => {
    const row = paneRows(w.sPanes!.trail).find((r) => r['label'] === 'retention')!
    expect(row['status'], 'over-budget rendered as if nothing were happening').toBe('warn')
  })

  reg.define(/^a journal holding a user turn whose intent nothing here anticipated$/, async (w: SidecarWorld) => {
    const store = await openSidecarStore(w)
    w.sTopic = 'reminiscence'
    await store.insert('a user turn of a kind the classifier learned after this test was written', {
      metadata: { source: 'auto-capture', role: 'user', intent: w.sTopic },
    })
    await store.insert('a user turn of a kind it already knew', {
      metadata: { source: 'auto-capture', role: 'user', intent: 'question' },
    })
  })

  reg.define(/^the trail pane accounts for that turn alongside the ones it knows$/, (w: SidecarWorld) => {
    const row = paneRows(w.sPanes!.trail).find((r) => r['label'] === 'user turns')!
    expect(Number(row['value']), 'the unanticipated intent fell out of the total').toBe(2)
    expect(String(row['detail']), 'the unanticipated intent is not named on the pane')
      .toContain(w.sTopic!)
    expect(String(row['detail'])).toContain('question')
  })
}
