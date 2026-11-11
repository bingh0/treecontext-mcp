import { appendFileSync, chmodSync, copyFileSync, renameSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path'
import { homedir, hostname, tmpdir } from 'node:os'
import { expect } from 'vitest'
import { type Registry } from 'gherkin-node-test/vitest'
import { spawnCli, spawnNodeTs } from '../../helpers/cli-spawn.js'
import { seedOrphanSidecar, storesDirIn } from '../../helpers/store-fixtures.js'
import { writeVerdict } from '../../../src/persistence/backup-verdict.js'
import { TS_ROOT } from '../proc.js'
import { claudeSessionStartUnwired, claudeHooksBlock, MARKER_START, MARKER_END, INSTRUCTIONS_CONTENT } from '../../../src/server/installer.js'
import { upsertCodexHooks } from '../../helpers/earlier-build-writers.js'
import { codexHooksBlock, codexBlockState } from '../../../src/server/codex-hooks.js'
import { type CodexListedHook } from '../../../src/server/codex-client.js'
import { DatabaseSync } from 'node:sqlite'
import { openNodeSqlite } from '../../../src/persistence/node-sqlite.js'
import { FlatStore } from '../../../src/flat-store.js'
import { LeaseClient, DRAIN_LEASE_TTL_SECS } from '../../../src/persistence/leases.js'
import { MAX_INGEST_ATTEMPTS } from '../../../src/persistence/capture-constants.js'
import { type InstallWorld, type CliRun, codexReading, worldAgyVersion, pathWithFakeClaude, setClaudeVersion, tcCli, agentCli, codexCli, codexConfigRead, setFakeCodex, openInstallWorld, treeOf, pathsMentioned, installedCommands, interpreterRunsPackage, isBatchBody, toPosix, mcpLauncherIn, agentConfigPath, fakeGlobalInstall, clientEntry, putAgyOnPath, agyReading, realAgy, putGeminiOnPath, markGeminiCliInstalled, layEarlierGeminiInstall, GEMINI_WRAPPER_STEMS, agyMcpList, type ClientEntry } from '../install-harness.js'
import { CODEX_APPROVALS_FLOOR } from '../../../src/server/codex-client.js'
import { startEntryAsClient, developerTrustsCodexHooks, codexHooksSeen, recordedSession, replayRecordedSession, writeFakeAgy } from '../standins.js'
import { agyHooksBlock, commandsIn, AGY_HOOK_NAME, AGY_CAPTURE_FLOOR } from '../../../src/server/agy-hooks.js'
import { sandboxedSpawnEnv } from '../../helpers/cli-spawn.js'
import { placeBuiltPackage } from '../../helpers/built-package.js'
import { openCaptureWorld, drainStaging, type CaptureWorld } from '../capture-harness.js'
import { parseCodexRollout, classify, storeViewOf, CODEX_INFER_WHY, type CensusRow } from '../../../scripts/capture-census.js'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { type EventList, readEventList, provenanceProblems, dispositionProblems, unlistedWiredProblems, recordingProblems, readClientEventList, recordedEventNames, CODEX_LIST, CLAUDE_CODE_LIST, AGY_LIST } from '../event-list.js'

export const installDefiner = (reg: Registry<InstallWorld>): void => {
  // ── install wires only the agents that are present ──────────────────
  reg.define(/^a machine where only some of the known agents are installed$/, async (w: InstallWorld) => {
    await openInstallWorld(w, ['.claude'])
  })

  reg.define(/^install runs$/, (w: InstallWorld) => {
    w.irun = tcCli(w, ['install', '--yes'])
  })

  reg.define(/^the detected agents are wired for MCP$/, (w: InstallWorld) => {
    const cfg = JSON.parse(readFileSync(join(w.ihome!, '.claude.json'), 'utf8')) as Record<string, Record<string, unknown>>
    expect(cfg['mcpServers']?.['treecontext'], 'Claude Code was detected but not wired').toBeDefined()
  })

  reg.define(/^no configuration is created for agents that are not there$/, (w: InstallWorld) => {
    for (const absent of [join('.gemini', 'settings.json'), join('.cursor', 'mcp.json'), join('.codex', 'config.toml')]) {
      expect(existsSync(join(w.ihome!, absent)), `wrote config for an absent agent: ${absent}`).toBe(false)
    }
  })

  // ── the registration lands where the agent itself reads it ──────────
  reg.define(/^a machine with the reference agent installed$/, async (w: InstallWorld) => {
    await openInstallWorld(w, ['.claude'])
    w.iproj = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-install-proj-')))
    w.defer(() => rmSync(w.iproj!, { recursive: true, force: true }))
  })

  reg.define(/^the agent's own configuration listing reports the treecontext server$/, (w: InstallWorld) => {
    const listed = agentCli(w, ['mcp', 'get', 'treecontext'])
    expect(listed.out, `the agent cannot see the server install just wrote:\n${listed.out}`)
      .toMatch(/treecontext/)
    // step-lint: allow unearned-absence -- guarded: the assertion directly above positively matches /treecontext/ in the same output and status 0 is pinned — the failure string cannot coexist with them
    expect(listed.out).not.toMatch(/No MCP servers configured/)
    expect(listed.status, 'the agent CLI could not resolve the server').toBe(0)
  })

  reg.define(/^the agent reports it at user scope, available in every project$/, (w: InstallWorld) => {
    // Asked from a directory unrelated to where install ran: "global" is a
    // claim about every project, so it has to be checked from elsewhere.
    const listed = agentCli(w, ['mcp', 'get', 'treecontext'])
    expect(listed.out).toMatch(/User config/i)
    expect(listed.out).toMatch(/all your projects/i)
  })

  // ── the linked command produces output ──────────────────────────────
  reg.define(/^the package installed so its command on PATH is a link to the real entry point$/, async (w: InstallWorld) => {
    await openInstallWorld(w, ['.claude'])
    const bin = join(w.ihome!, 'bin')
    mkdirSync(bin, { recursive: true })
    w.iLinkedCommand = join(bin, 'treecontext')
    // The shape npm creates for a global install: a symlink on PATH whose
    // target is the package's real entry point.
    symlinkSync(join(TS_ROOT, 'src', 'server', 'cli.ts'), w.iLinkedCommand)
  })

  reg.define(/^that linked command is invoked with a subcommand$/, (w: InstallWorld) => {
    // The canonical sandboxed spawn, not a hand-rolled env: this doctor run
    // must not read the developer's real config/bindings through the
    // TREECONTEXT_* seams, and a never-started spawn must still print its
    // errno instead of an empty stderr.
    w.irun = spawnNodeTs(w.iLinkedCommand!, ['doctor'], { home: w.ihome!, cwd: TS_ROOT, env: { PATH: pathWithFakeClaude(w) } })
  })

  reg.define(/^the subcommand prints its report$/, (w: InstallWorld) => {
    expect(w.irun!.stdout.trim(), 'the linked command printed nothing at all').not.toBe('')
    expect(w.irun!.stdout).toMatch(/treecontext doctor/)
    expect(w.irun!.stdout).toMatch(/SQLite: /)
  })

  reg.define(/^the command exits successfully$/, (w: InstallWorld) => {
    expect(w.irun!.status).toBe(0)
  })

  // ── the dry run is the whole plan ───────────────────────────────────
  reg.define(/^a machine with agents detected$/, async (w: InstallWorld) => {
    await openInstallWorld(w, ['.claude', '.cursor'])
  })

  reg.define(/^install runs with the dry-run flag$/, (w: InstallWorld) => {
    w.iBefore = treeOf(w.ihome!)
    w.irun = tcCli(w, ['install', '--yes', '--dry-run'])
  })

  reg.define(/^every path a real install would write is listed$/, (w: InstallWorld) => {
    const planned = pathsMentioned(w.irun!.out, w.ihome!)
    expect(planned.length, 'the dry run named no paths').toBeGreaterThan(0)
    // The plan is only "the whole plan" if a real run writes nothing the
    // plan did not name. Compare against an actual install in its own home.
    const realHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-install-real-')))
    try {
      mkdirSync(join(realHome, '.claude'), { recursive: true })
      mkdirSync(join(realHome, '.cursor'), { recursive: true })
      // The world's own files are not install's writes.
      const fixture = new Set(treeOf(realHome).map(f => `/${toPosix(f)}`))
      const real = tcCli({ ...w, ihome: realHome }, ['install', '--yes'])
      expect(real.status).toBe(0)
      // Both sides normalised to posix before comparing. The planned paths are
      // sliced off an absolute home and treeOf walks the tree, so on Windows
      // both carried '\' — the sets could never intersect, and the
      // '/.treecontext/logs' filter missed too, which is how a debug log ended
      // up reported as an unannounced config write.
      const plannedRel = new Set(planned.map(p => toPosix(p.slice(w.ihome!.length))))
      const wroteRel = treeOf(realHome)
        .map(f => `/${toPosix(f)}`)
        .filter(f => !f.startsWith('/.treecontext/logs'))   // debug logs, not config
        .filter(f => !fixture.has(f))
        .filter(f => statSync(join(realHome, f.slice(1))).isFile())
      const unannounced = wroteRel.filter(f => ![...plannedRel].some(p => p === f || f.startsWith(`${p}/`)))
      expect(unannounced, `a real install wrote paths the dry run never listed: ${unannounced.join(', ')}`).toEqual([])
    } finally {
      rmSync(realHome, { recursive: true, force: true })
    }
  })

  reg.define(/^nothing on disk has changed$/, (w: InstallWorld) => {
    expect(treeOf(w.ihome!)).toEqual(w.iBefore!)
  })

  // ── existing configuration is merged, never clobbered ───────────────
  reg.define(/^an agent config already holding a foreign MCP server and a foreign hook$/, async (w: InstallWorld) => {
    await openInstallWorld(w, ['.claude'])
    writeFileSync(join(w.ihome!, '.claude.json'), JSON.stringify({
      mcpServers: { 'foreign-server': { command: 'someone-elses-tool', args: ['--run'] } },
      projects: { '/a/repo': { lastCwd: '/a/repo' } },
    }))
    writeFileSync(join(w.ihome!, '.claude', 'settings.json'), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'someone-elses-hook' }] }] },
    }))
  })

  reg.define(/^the treecontext entries are added$/, (w: InstallWorld) => {
    const cfg = JSON.parse(readFileSync(join(w.ihome!, '.claude.json'), 'utf8')) as Record<string, Record<string, unknown>>
    expect(cfg['mcpServers']?.['treecontext']).toBeDefined()
    expect(readFileSync(join(w.ihome!, '.claude', 'settings.json'), 'utf8')).toMatch(/tc-/)
  })

  reg.define(/^the foreign entries survive untouched$/, (w: InstallWorld) => {
    const cfg = JSON.parse(readFileSync(join(w.ihome!, '.claude.json'), 'utf8')) as Record<string, Record<string, unknown>>
    expect(cfg['mcpServers']?.['foreign-server']).toEqual({ command: 'someone-elses-tool', args: ['--run'] })
    expect(cfg['projects']?.['/a/repo'], 'unrelated agent state was dropped').toEqual({ lastCwd: '/a/repo' })
    expect(readFileSync(join(w.ihome!, '.claude', 'settings.json'), 'utf8')).toMatch(/someone-elses-hook/)
  })

  // ── a corrupt config file is backed up, not destroyed ───────────────
  // The reference agent's config is two files install writes: the MCP
  // entry in ~/.claude.json and the hooks in ~/.claude/settings.json. Each
  // is an agent config file the scenario's words cover, so each is made
  // unparseable and each is held to both Thens.
  const CORRUPT_CONFIGS = [
    { rel: '.claude.json', bytes: '{ this is not json at all' },
    { rel: join('.claude', 'settings.json'), bytes: '{ these settings do not parse either,' },
  ]
  reg.define(/^an agent config file that does not parse$/, async (w: InstallWorld) => {
    await openInstallWorld(w, ['.claude'])
    for (const c of CORRUPT_CONFIGS) writeFileSync(join(w.ihome!, c.rel), c.bytes)
  })

  reg.define(/^a fresh config is written with the treecontext entries$/, (w: InstallWorld) => {
    const cfg = JSON.parse(readFileSync(join(w.ihome!, '.claude.json'), 'utf8')) as Record<string, Record<string, unknown>>
    expect(cfg['mcpServers']?.['treecontext']).toBeDefined()
    const settings = JSON.parse(readFileSync(join(w.ihome!, '.claude', 'settings.json'), 'utf8')) as { hooks?: Record<string, unknown> }
    expect(JSON.stringify(settings.hooks ?? {}), 'the rebuilt settings carry treecontext\'s hooks').toMatch(/tc-|treecontext/)
  })

  reg.define(/^the unparseable original is preserved as a backup beside it$/, (w: InstallWorld) => {
    for (const c of CORRUPT_CONFIGS) {
      const dir = dirname(join(w.ihome!, c.rel))
      const base = basename(c.rel)
      const backups = readdirSync(dir).filter(f => f.startsWith(base) && f !== base)
      expect(backups.length, `the corrupt original of ${c.rel} was destroyed`).toBeGreaterThan(0)
      const kept = backups.map(f => readFileSync(join(dir, f), 'utf8'))
      expect(kept.some(k => k.includes(c.bytes)), `no backup of ${c.rel} holds the original bytes`).toBe(true)
    }
  })

  // ── reinstalling converges instead of duplicating ───────────────────
  reg.define(/^a machine where install has already run$/, async (w: InstallWorld) => {
    await openInstallWorld(w, ['.claude'])
    expect(tcCli(w, ['install', '--yes']).status).toBe(0)
    // A node version bump invalidates absolute interpreter paths; the
    // documented fix is "re-run install", so seed exactly that state.
    const p = join(w.ihome!, '.claude.json')
    const cfg = JSON.parse(readFileSync(p, 'utf8')) as Record<string, Record<string, Record<string, unknown>>>
    cfg['mcpServers']!['treecontext']!['command'] = '/nonexistent/node-v0.0.0/bin/node'
    writeFileSync(p, JSON.stringify(cfg))
    // The canonical registration: session-start runs on every SessionStart
    // matcher, clear and resume included (D171, D187).
    const settingsPath = join(w.ihome!, '.claude', 'settings.json')
    w.iHooksBefore = readFileSync(settingsPath, 'utf8')
    const canonical = JSON.parse(w.iHooksBefore) as Record<string, unknown>
    expect(claudeSessionStartUnwired(canonical), 'install did not wire session-start on clear and resume').toEqual([])
    // …and the same upgrade path for hooks: seed the pre-beta.1 wiring,
    // session-start on startup and compact only, which doctor must name
    // with `treecontext install` as its fix.
    const hooks = (canonical['hooks'] as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>)
    for (const m of hooks['SessionStart']!) {
      if (m.matcher === 'clear' || m.matcher === 'resume') m.hooks = m.hooks.filter((h) => !h.command.includes('session-start'))
    }
    writeFileSync(settingsPath, JSON.stringify(canonical, null, 2) + '\n')
    expect(claudeSessionStartUnwired(canonical)).toEqual(['clear', 'resume'])
    const doc = tcCli(w, ['doctor']).stdout.split('\n')
    const i = doc.findIndex((l) => /re-orientation hooks: session-start is not wired on clear and resume/.test(l))
    expect(i, `doctor did not name the old wiring:\n${doc.join('\n')}`).toBeGreaterThanOrEqual(0)
    expect(doc[i + 1]).toMatch(/^\s+fix: treecontext install$/)
  })

  reg.define(/^install runs again without force$/, (w: InstallWorld) => {
    w.irun = tcCli(w, ['install', '--yes'])
    expect(w.irun.status).toBe(0)
  })

  reg.define(/^no entry is registered twice$/, (w: InstallWorld) => {
    const raw = readFileSync(join(w.ihome!, '.claude.json'), 'utf8')
    expect(raw.match(/"treecontext"/g) ?? []).toHaveLength(1)
    // Hook names legitimately recur across matchers (startup/resume/clear),
    // so counting names proves nothing. Convergence is the real claim: a
    // second install leaves the registration byte-identical rather than
    // appending another copy of itself.
    const after = readFileSync(join(w.ihome!, '.claude', 'settings.json'), 'utf8')
    expect(after, 'a second install rewrote the hook registration').toBe(w.iHooksBefore!)
  })

  reg.define(/^an entry pointing at an interpreter that no longer exists is repaired in place$/, (w: InstallWorld) => {
    const cfg = JSON.parse(readFileSync(join(w.ihome!, '.claude.json'), 'utf8')) as Record<string, Record<string, Record<string, unknown>>>
    const cmd = cfg['mcpServers']!['treecontext']!['command'] as string
    expect(cmd).not.toBe('/nonexistent/node-v0.0.0/bin/node')
    expect(existsSync(cmd), `repaired command still does not exist: ${cmd}`).toBe(true)
    // The old hook wiring is repaired in place too, and doctor agrees.
    const settings = JSON.parse(readFileSync(join(w.ihome!, '.claude', 'settings.json'), 'utf8')) as Record<string, unknown>
    expect(claudeSessionStartUnwired(settings)).toEqual([])
    expect(tcCli(w, ['doctor']).stdout.split('\n').filter((l) => l.includes('re-orientation hooks'))).toEqual([])
  })

  // ── nothing the installer writes invokes a bare interpreter ─────────
  reg.define(/^a machine where install has completed$/, async (w: InstallWorld) => {
    await openInstallWorld(w, ['.claude'])
    expect(tcCli(w, ['install', '--yes']).status).toBe(0)
  })

  reg.define(/^every hook script and MCP entry it wrote is inspected$/, (w: InstallWorld) => {
    const found = installedCommands(w.ihome!)
    // "Inspected" has to mean every one of them. A walk that silently
    // reaches none of the hook scripts would otherwise satisfy this
    // scenario using the MCP entry alone.
    const scripts = readdirSync(join(w.ihome!, '.claude', 'hooks'))
    expect(scripts.length, 'install wrote no hook scripts to inspect').toBeGreaterThan(0)
    const reached = new Set(found.map(f => f.source))
    // tc-session-reminder emits static text and runs no interpreter, so it
    // contributes nothing by design. Every script that DOES invoke one must
    // have been reached, or this scenario is inspecting less than it says.
    //
    // Both dialects' PATTERNS are deliberately spelled out here rather than
    // imported from the harness: this predicate is the ORACLE that grades the
    // harness walk, and an oracle sharing the walk's own patterns agrees with
    // it by construction — including when both are wrong. That independence is
    // the point and stays.
    //
    // What IS shared is the dialect dispatch (isBatchBody, from the BODY, as
    // installer.ts:2074 does): "which dialect is this body" has one right
    // answer, and two spellings of it could only ever disagree by being wrong.
    // Splitting on it keeps the POSIX branch the exact regex it has always
    // been. The batch branch
    // reads `%TC_NODE%` — installer.ts:594 and :297 both dispatch through it,
    // whichever resolve branch installer.ts:266-270 wrote above them — plus a
    // bare `node` invocation, the regression the scenario is named for. `\r`
    // needs no tolerance: CRLF leaves it at the end of the PRECEDING line.
    // The batch bare-node lookbehind is not decoration; without it a POSIX
    // body's nvm glob (`.../bin/node "$HOME"/...`, installer.ts:233) reads as
    // an invocation, which is why the two branches do not share one pattern.
    const requiresInterpreter = (body: string): boolean => isBatchBody(body)
      ? /%TC_NODE%|(?<![\w.\\/-])node "/.test(body)
      : /\$TC_NODE|(?:^|\n)(?:exec )?node /.test(body)
    const required = scripts.filter(s => requiresInterpreter(readFileSync(join(w.ihome!, '.claude', 'hooks', s), 'utf8')))
    // The guard above is the whole scenario's load-bearing filter, so it has to
    // be able to fail. When it matched nothing — which is precisely what the
    // POSIX-only spelling did to every win32 script — the loop below became a
    // no-op and this scenario passed while inspecting one JSON entry.
    expect(required.length, `no installed hook script names an interpreter — the ${process.platform} dialect is not being recognised`).toBeGreaterThan(0)
    for (const s of required) {
      expect(reached.has(s), `the walk extracted no command from hook script ${s}`).toBe(true)
    }
    expect(reached.has('.claude.json'), 'the walk never reached the MCP entry').toBe(true)
  })

  reg.define(/^each command resolves to an absolute path that exists on this machine$/, (w: InstallWorld) => {
    for (const { source, command } of installedCommands(w.ihome!)) {
      expect(command, `bare interpreter in ${source}`).not.toBe('node')
      expect(isAbsolute(command), `not an absolute command in ${source}: ${command}`).toBe(true)
      // The entry point must exist in one of its two real forms. This suite
      // drives the TypeScript source, where the installer resolves a `cli.js`
      // sibling of its own `cli.ts` module; a built install resolves the .js
      // that is actually there. Accepting the .ts twin keeps the existence
      // claim strict without asserting that `npm run build` has been run,
      // and a genuinely absent entry point still fails both ways.
      const exists = existsSync(command)
        || (command.endsWith('.js') && existsSync(command.replace(/\.js$/, '.ts')))
      expect(exists, `command in ${source} does not exist: ${command}`).toBe(true)
    }
  })

  // ── the interpreter install chooses can run this package ────────────
  // Step text reworded 2026-10-11 (D278): "runs this package" for "loads
  // the binding". Since the node:sqlite build these bodies probe exactly
  // what install probes: the floor, and an open of node:sqlite with FTS5.
  reg.define(/^a machine offering several interpreters, only one of which meets the Node floor and runs this package$/, async (w: InstallWorld) => {
    await openInstallWorld(w, ['.claude'])
    // A `node` that runs but cannot load native modules — the shape of a
    // Homebrew node below the floor, or one without node:sqlite.
    const badDir = join(w.ihome!, 'badbin')
    mkdirSync(badDir, { recursive: true })
    // A .cmd on Windows, for the reason spelled out in the sibling scenario
    // below: an extensionless `node` holding a bash shebang is not a `node`
    // Windows can resolve or run at all, so PATH never offered a rival and the
    // "only one interpreter loads the binding" premise was not set up. The
    // machine has to actually offer the bad interpreter for the choice to mean
    // anything.
    const win = process.platform === 'win32'
    w.iBadNode = join(badDir, win ? 'node.cmd' : 'node')
    writeFileSync(
      w.iBadNode,
      win ? '@echo off\r\nif "%1"=="-e" (echo no prebuilt binary 1>&2 & exit /b 1)\r\nexit /b 1\r\n'
        : '#!/bin/bash\nif [ "$1" = "-e" ]; then echo "no prebuilt binary" >&2; exit 1; fi\nexit 1\n',
      { mode: 0o755 },
    )
  })

  reg.define(/^the interpreter baked into the wrappers is one that runs this package$/, (w: InstallWorld) => {
    // Ask the wrapper itself which interpreter it would use, with the
    // non-loading one first on PATH — resolution is the thing under test,
    // so it has to be executed, not read.
    const wrapper = readFileSync(mcpLauncherIn(w.ihome!), 'utf8')

    if (process.platform === 'win32') {
      // EXECUTED, not read — the same standard the POSIX branch below holds
      // itself to, and now possible because the .cmd resolves in the same
      // order (verified pin → PATH) through the same shared snippet.
      //
      // Reading the baked token was all the old inverted launcher allowed: it
      // preferred `where node`, so the pinned path was the fallback and what
      // the file *said* was not what it would *run*. With the pin leading, a
      // probe that echoes %TC_NODE% with the non-loading node first on PATH
      // proves the pin actually wins — which is the whole claim.
      const lines = wrapper.split('\r\n')
      const runIdx = lines.findIndex(l => l.startsWith('"%TC_NODE%"'))
      expect(runIdx, `no dispatch line in ${mcpLauncherIn(w.ihome!)}:\n${wrapper}`).toBeGreaterThan(0)
      const probe = join(w.ihome!, 'which-node.cmd')
      writeFileSync(probe, [...lines.slice(0, runIdx), 'echo %TC_NODE%', ''].join('\r\n'))
      const r = spawnSync(process.env['COMSPEC'] ?? 'cmd.exe', ['/c', probe], {
        // Minimal env for the same reason as POSIX: the chain under test must
        // not inherit the parent's. SystemRoot is kept because cmd.exe cannot
        // start without it, and `;` is the Windows PATH separator.
        env: {
          SystemRoot: process.env['SystemRoot'] ?? 'C:\\Windows',
          USERPROFILE: w.ihome!,
          PATH: `${dirname(w.iBadNode!)};${process.env['PATH'] ?? ''}`,
        },
        encoding: 'utf8', timeout: 60_000,
      })
      const chosen = (r.stdout ?? '').trim()
      expect(chosen, `the wrapper resolved no interpreter (${r.stderr ?? ''})`).not.toBe('')
      expect(interpreterRunsPackage(chosen), `the wrapper chose ${chosen}, which cannot run this package`).toBe(true)
      return
    }

    const lines = wrapper.split('\n')
    const execIdx = lines.findIndex(l => l.includes('exec "$TC_NODE"'))
    expect(execIdx).toBeGreaterThan(0)
    const probe = join(w.ihome!, 'which-node.sh')
    writeFileSync(probe, [...lines.slice(0, execIdx), 'echo "$TC_NODE"'].join('\n'), { mode: 0o755 })
    const r = spawnSync('/bin/bash', [probe], {
      // A deliberately MINIMAL env — the resolution chain under test must not
      // inherit the parent's. POSIX-only branch, so ':' is the right separator.
      env: { HOME: w.ihome!, PATH: `${dirname(w.iBadNode!)}:${process.env['PATH'] ?? ''}` },
      encoding: 'utf8', timeout: 60_000,
    })
    const chosen = (r.stdout ?? '').trim()
    expect(chosen, 'the wrapper resolved no interpreter').not.toBe('')
    expect(interpreterRunsPackage(chosen), `the wrapper chose ${chosen}, which cannot run this package`).toBe(true)
  })

  reg.define(/^the interpreters that cannot run it are not chosen$/, (w: InstallWorld) => {
    const wrapper = readFileSync(mcpLauncherIn(w.ihome!), 'utf8')
    expect(wrapper).not.toContain(w.iBadNode!)
  })

  // ── a bad interpreter is reported, not tolerated ────────────────────
  reg.define(/^an installation whose wrappers name an interpreter that cannot run this package$/, async (w: InstallWorld) => {
    await openInstallWorld(w, ['.claude'])
    expect(tcCli(w, ['install', '--yes']).status).toBe(0)
    const badDir = join(w.ihome!, 'badbin')
    mkdirSync(badDir, { recursive: true })
    // A .cmd on Windows so it is genuinely spawnable and fails at the probe
    // rather than failing to start — the claim is about an interpreter that
    // RUNS and cannot run this package.
    const win = process.platform === 'win32'
    w.iBadNode = join(badDir, win ? 'node.cmd' : 'node')
    writeFileSync(
      w.iBadNode,
      win ? '@echo off\r\necho no prebuilt binary 1>&2\r\nexit /b 1\r\n'
        : '#!/bin/bash\necho "no prebuilt binary" >&2\nexit 1\n',
      { mode: 0o755 },
    )
    const p = mcpLauncherIn(w.ihome!)
    const body = readFileSync(p, 'utf8')
    // One shape per dialect, and they are now the same shape: overwrite the
    // pinned interpreter, which is the position that WINS on both platforms.
    //
    // This used to be a much larger Windows branch that rewrote the entire
    // `where node ... && ... || ...` dispatch line, because the pin was only
    // the fallback there — patching it alone left the runner's real node in
    // front and planted nothing. That whole problem was the precedence bug;
    // with the pin leading, the POSIX form and the .cmd form differ only in
    // how a variable assignment is spelled.
    const patched = win
      ? body.replace(/^set "TC_NODE=[^"]*"/m, `set "TC_NODE=${w.iBadNode!}"`)
      : body.replace(/^TC_NODE="[^"]*"/m, `TC_NODE="${w.iBadNode!}"`)
    expect(patched, 'the bad interpreter was never injected into the launcher').toContain(w.iBadNode!)
    writeFileSync(p, patched, { mode: 0o755 })
  })

  reg.define(/^the report names that interpreter as a failure$/, (w: InstallWorld) => {
    expect(w.irun!.out).toContain(w.iBadNode!)
    expect(w.irun!.out).toMatch(/\[err]\s+Hook interpreter/)
  })

  reg.define(/^it says that capture would record nothing rather than reporting the hooks healthy$/, (w: InstallWorld) => {
    expect(w.irun!.out).toMatch(/capture nothing|record nothing/)
  })

  // ── an unwritable agent config fails loudly and changes nothing ─────
  reg.define(/^an agent config whose file or directory denies writes$/, async (w: InstallWorld) => {
    // Three agents, the middle one unwritable: isolation is only observable
    // when there is an agent AFTER the failure to check. In the registry's
    // order: Claude Code, Cursor (blocked), Codex CLI.
    await openInstallWorld(w, ['.claude', '.cursor', '.codex'])
    // Denied by SHAPE, not by permission bits: a regular FILE sits where the
    // .cursor DIRECTORY must be, so every write beneath it fails ENOTDIR on
    // every platform. The agent is still DETECTED (detection reads that the
    // path exists), so the installer reaches the write and has to report the
    // denial.
    //
    // The previous fixture chmod'ed the directory to 0o500, which NTFS does not
    // honour: on Windows the install simply succeeded and this scenario
    // reported "a failed install reported success" — asserting a property of
    // POSIX, not of the installer. Two other cross-platform forms were measured
    // and rejected: a directory at the config file is RECOVERED from (the
    // installer treats it as corrupt JSON and backs it up — correct
    // behaviour), and a read-only config file is simply replaced, because the
    // write goes to a temp file and renames. Only removing the directory itself
    // denies the write everywhere. The shape form also drops the root caveat
    // the old fixture carried, since root cannot descend into a file either.
    // (The blocked agent was Gemini CLI until its retirement, D399.)
    rmSync(join(w.ihome!, '.cursor'), { recursive: true, force: true })
    writeFileSync(join(w.ihome!, '.cursor'), 'not a directory\n')
  })

  reg.define(/^the failure names the path and the permission problem$/, (w: InstallWorld) => {
    expect(w.irun!.status, 'a failed install reported success').not.toBe(0)
    // The load-bearing claim is that the denial is REPORTED and names the
    // path, not which errno the kernel chose. EISDIR is what a write to the
    // blocking directory yields; EACCES/EPERM are what a permission-denied
    // write yields. Pinning one spelling would make this a POSIX assertion.
    // Windows reports ENOENT for a write beneath a path that is a file; POSIX
    // reports ENOTDIR. The errno spelling is the platform's business — what
    // this pins is that a denial was REPORTED, and the `.cursor` assertion
    // below plus the non-zero status above pin which write it was.
    expect(w.irun!.out).toMatch(/ENOTDIR|ENOENT|EACCES|EPERM|not a directory|no such file|permission denied/i)
    expect(w.irun!.out).toMatch(/\.cursor/)
  })

  reg.define(/^every other detected agent is still wired completely$/, (w: InstallWorld) => {
    const cfg = JSON.parse(readFileSync(join(w.ihome!, '.claude.json'), 'utf8')) as Record<string, Record<string, unknown>>
    expect(cfg['mcpServers']?.['treecontext'], 'an agent BEFORE the failure lost its wiring').toBeDefined()
    const codex = agentConfigPath('codex', w.ihome!)
    expect(existsSync(codex), 'an agent AFTER the failure never got wired').toBe(true)
    expect(readFileSync(codex, 'utf8'), 'an agent AFTER the failure never got wired').toMatch(/^\[mcp_servers\.treecontext\]/m)
  })

  reg.define(/^the install run exits non-zero$/, (w: InstallWorld) => {
    // Isolation is not forgiveness: the run carried on past the fault to
    // wire the other agents, then ended INSTALL_PARTIAL — `install &&
    // next-step` must stop here.
    expect(w.irun!.status, 'a partial install exited 0').not.toBe(0)
  })

  reg.define(/^no partial or temporary file is left at the unwritable path$/, (w: InstallWorld) => {
    // Nothing may have been created beside or beneath the blocker: .cursor is
    // still exactly the file the fixture wrote, and the atomic temp file the
    // installer names in its error must not survive anywhere in the home.
    expect(statSync(join(w.ihome!, '.cursor')).isFile(), '.cursor is no longer the blocking file').toBe(true)
    expect(readFileSync(join(w.ihome!, '.cursor'), 'utf8')).toBe('not a directory\n')
    // `.cursor` itself is the fixture; anything else named after it — a
    // sibling, a .bak, the atomic .tmp. the installer names in its error — is
    // a partial write that outlived the failure.
    const leftovers = treeOf(w.ihome!).filter(f => f !== '.cursor' && (f.startsWith('.cursor') || f.includes('.tmp.')))
    expect(leftovers, 'a partial or temp file survived the failed write').toEqual([])
  })

  // ── a forced reinstall rewrites only the agent it names ─────────────
  reg.define(/^a machine where install has wired two agents$/, async (w: InstallWorld) => {
    await openInstallWorld(w, ['.claude', '.cursor'])
    expect(tcCli(w, ['install', '--yes']).status).toBe(0)
  })

  reg.define(/^both agents' entries have since been hand-edited to a different absolute command, and the first given a pinned store$/, (w: InstallWorld) => {
    // An absolute command that exists is exactly the shape a plain
    // reinstall keeps as the developer's (convergence repairs only a
    // command that no longer starts a server), so the rewrite below is
    // --force's doing. The canonical entry is what this build wrote before
    // the edit: the oracle for "the command and arguments this build writes".
    const claudePath = join(w.ihome!, '.claude.json')
    const cfg = JSON.parse(readFileSync(claudePath, 'utf8')) as Record<string, Record<string, Record<string, unknown>>>
    const canonical = cfg['mcpServers']!['treecontext']!
    w.iCanonicalEntry = JSON.stringify(canonical)
    w.iDeveloperArgs = ['--store', 'pinned-store']
    cfg['mcpServers']!['treecontext'] = { ...canonical, command: process.execPath, args: [...(canonical['args'] as string[]), ...w.iDeveloperArgs] }
    writeFileSync(claudePath, JSON.stringify(cfg, null, 2))
    const cursorPath = join(w.ihome!, '.cursor', 'mcp.json')
    const cursor = JSON.parse(readFileSync(cursorPath, 'utf8')) as Record<string, Record<string, Record<string, unknown>>>
    cursor['mcpServers']!['treecontext'] = { ...cursor['mcpServers']!['treecontext']!, command: process.execPath }
    writeFileSync(cursorPath, JSON.stringify(cursor, null, 2))
    w.iCursorBytes = readFileSync(cursorPath, 'utf8')
    // The edit is what Claude Code itself now reads, or the rewrite proves nothing.
    expect(clientEntry(w, 'Claude Code').command).toBe(process.execPath)
  })

  reg.define(/^install runs again with force naming only the first agent$/, (w: InstallWorld) => {
    w.irun = tcCli(w, ['install', '--yes', '--force', '--agent', 'claude'])
    expect(w.irun.status).toBe(0)
  })

  reg.define(/^the named agent's entry carries the command and arguments this build writes$/, (w: InstallWorld) => {
    // Claude Code's own reading (`claude mcp get`) is the other side: the
    // launcher this build wrote under the sandbox home, and this build's
    // arguments followed by the developer's.
    const canonical = JSON.parse(w.iCanonicalEntry!) as { command: string; args: string[] }
    expect(canonical.command).toBe(mcpLauncherIn(w.ihome!))
    const seen = clientEntry(w, 'Claude Code')
    expect(seen.command, `the hand-edited command survived a forced reinstall:\n${seen.printed}`).toBe(canonical.command)
    expect(seen.args).toEqual([...canonical.args, ...w.iDeveloperArgs!])
  })

  reg.define(/^the pinned store the developer added to the named agent's entry is still there$/, (w: InstallWorld) => {
    const seen = clientEntry(w, 'Claude Code')
    const at = seen.args.indexOf('--store')
    expect(at, `the forced reinstall dropped the developer's pinned store:\n${seen.printed}`).toBeGreaterThanOrEqual(0)
    expect(seen.args[at + 1]).toBe('pinned-store')
    // Named in the install output, too, as kept.
    expect(w.irun!.stdout).toMatch(/\.claude\.json \[updated — kept your --store pinned-store\]/)
  })

  reg.define(/^the other agent's hand-edited configuration is byte-for-byte untouched$/, (w: InstallWorld) => {
    expect(readFileSync(join(w.ihome!, '.cursor', 'mcp.json'), 'utf8')).toBe(w.iCursorBytes!)
  })

  // ── unverified platforms: tools, not hooks ──────────────────────────
  //
  // Bound to Codex CLI since the beta.2 build (D226): the flagged install
  // writes nothing for an as-is client (VS Code, Cursor), so the agent whose
  // opt-in writes capture hooks is a copying client, and its hooks are its
  // copy of the Claude Code block (D154, D225). Both halves of the opt-in
  // run on the same agent.










  // ── D406 (amending D57): the experimental flag is gone ──────────────
  // A machine with all three captured clients: Claude Code marked
  // installed, the stand-in Codex answering 0.167.0, and the real agy on
  // PATH, whose own `--version` reads 1.5.3. Every file under the home is
  // read before the run, so "before anything is written" is a byte compare.
  const homeBytes = (dir: string): Record<string, string> => {
    const out: Record<string, string> = {}
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.isFile()) out[p] = readFileSync(p, 'utf8')
      }
    }
    walk(dir)
    return out
  }
  reg.define(/^a machine with Claude Code, Codex CLI 0\.167\.0 and Antigravity CLI 1\.5\.3 installed$/, async (w: InstallWorld) => {
    await openInstallWorld(w, ['.claude', '.codex', '.gemini'])
    setFakeCodex(w, { version: '0.167.0', sandbox: { exit: 0, stderr: '' } })
    agyReading(w, '1.5.3')
    expect(worldAgyVersion(w), "the agy on PATH is not the version the Given names").toBe('1.5.3')
    ;(w as InstallWorld & { iTreeBefore?: Record<string, string> }).iTreeBefore = homeBytes(w.ihome!)
  })
  reg.define(/^install runs with the experimental capture flag (and no agent name|naming Codex CLI|naming Antigravity CLI)$/, (w: InstallWorld, named: unknown) => {
    const agent = named === 'naming Codex CLI' ? ['--agent', 'codex'] : named === 'naming Antigravity CLI' ? ['--agent', 'agy'] : []
    w.irun = tcCli(w, ['install', '--yes', ...agent, '--experimental-capture'])
  })
  reg.define(/^the install is refused before anything is written, and the install run exits non-zero$/, (w: InstallWorld) => {
    expect(w.irun!.status, w.irun!.out).not.toBe(0)
    expect(w.irun!.status).not.toBeNull()
    expect(homeBytes(w.ihome!), 'install wrote under the home before refusing').toEqual((w as InstallWorld & { iTreeBefore?: Record<string, string> }).iTreeBefore)
    // Refused before its run began: install printed nothing on stdout.
    expect(w.irun!.stdout).toBe('')
  })
  reg.define(/^the developer sees one line saying the flag is gone and that each captured client is wired by default from its version floor, naming Codex CLI 0\.167\.0 and Antigravity CLI 1\.5\.3$/, (w: InstallWorld) => {
    const said = w.irun!.out.split('\n').filter(l => l.trim() !== '')
    expect(said, w.irun!.out).toHaveLength(1)
    expect(said[0]).toMatch(/--experimental-capture is gone/)
    expect(said[0]).toMatch(/wired by default from its version floor/)
    expect(said[0]).toContain('Codex CLI 0.167.0')
    expect(said[0]).toContain('Antigravity CLI 1.5.3')
  })
  reg.define(/^install runs naming Gemini CLI$/, (w: InstallWorld) => {
    w.irun = tcCli(w, ['install', '--yes', '--agent', 'gemini'])
  })



  // ── @D402: the client's hook event list ─────────────────────────────
  // The list is tests/fixtures/claude-code-hooks/events.json; the wired
  // side is read from claudeHooksBlock(), the block install writes, and the
  // recorded side from the .ndjson sessions beside it. No event name is
  // restated here (tests/journal/event-list.ts).
  reg.define(/^the list of Claude Code's hook events, kept with the client version it was read from$/, (w: InstallWorld) => {
    const list = readEventList()
    ;(w as InstallWorld & { iEventList?: EventList }).iEventList = list
    expect(provenanceProblems(list)).toEqual([])
  })

  reg.define(/^it is compared with the hooks install wires$/, (w: InstallWorld) => {
    const list = (w as InstallWorld & { iEventList?: EventList }).iEventList!
    expect(Object.keys(claudeHooksBlock()).length, 'install wires no hook events').toBeGreaterThan(0)
    expect(list.events.length).toBeGreaterThan(0)
  })

  // D402 for Claude Code, D409 for Codex CLI: the list's client decides
  // which block install writes and which recordings it is held against.
  const listedClientOf = (list: EventList): typeof CODEX_LIST => (list.client === 'Codex CLI' ? CODEX_LIST : list.client === 'Antigravity CLI' ? AGY_LIST : CLAUDE_CODE_LIST)
  reg.define(/^every event on the list is either wired or named with what the journal does not capture because of it$/, (w: InstallWorld) => {
    const list = (w as InstallWorld & { iEventList?: EventList }).iEventList!
    const client = listedClientOf(list)
    expect(dispositionProblems(list, client.wired())).toEqual([])
    // and every event a recording shows is on the list, observed exactly
    expect(recordingProblems(list, recordedEventNames(client.dir))).toEqual([])
  })

  reg.define(/^every event install (?:wires|writes for Codex) is on the list$/, (w: InstallWorld) => {
    const list = (w as InstallWorld & { iEventList?: EventList }).iEventList!
    expect(unlistedWiredProblems(list, listedClientOf(list).wired())).toEqual([])
  })

  reg.define(/^the list of Codex CLI's hook events, kept with the Codex version it was read from$/, (w: InstallWorld) => {
    const list = readClientEventList(CODEX_LIST)
    ;(w as InstallWorld & { iEventList?: EventList }).iEventList = list
    expect(provenanceProblems(list, 'Codex CLI')).toEqual([])
    expect(list.version).toBe('0.167.0')
  })
  reg.define(/^it is compared with the hooks install writes for Codex$/, () => {
    expect(Object.keys(codexHooksBlock()).length, 'install writes no Codex hook events').toBeGreaterThan(0)
  })
  reg.define(/^the list names PostToolUseFailure and PostToolBatch as events Codex does not have, with what the journal does not capture on Codex because of it$/, (w: InstallWorld) => {
    const list = (w as InstallWorld & { iEventList?: EventList }).iEventList!
    for (const name of ['PostToolUseFailure', 'PostToolBatch']) {
      const e = list.events.find((x) => x.event === name)
      expect(e, name).toBeDefined()
      expect(e!.disposition).toBe('not-in-client')
      expect(String(e!.lost).trim().length, name).toBeGreaterThan(20)
      expect(Object.keys(codexHooksBlock())).not.toContain(name)
    }
  })
  reg.define(/^the list marks PreToolUse, Interrupt and PreCompact wired, each with what it is for, and PostCompact not captured, with the reason$/, (w: InstallWorld) => {
    const list = (w as InstallWorld & { iEventList?: EventList }).iEventList!
    for (const name of ['PreToolUse', 'Interrupt', 'PreCompact']) {
      const e = list.events.find((x) => x.event === name)!
      expect(e.disposition, name).toBe('wired')
      expect(e.when.trim().length, name).toBeGreaterThan(10)
      expect(Object.keys(codexHooksBlock())).toContain(name)
    }
    const post = list.events.find((x) => x.event === 'PostCompact')!
    expect(post.disposition).toBe('not-captured')
    expect(post.lost).toMatch(/no summary/)
  })

  reg.define(/^an installation wired before a capture event was added is reported by doctor with the command that wires it$/, async (w: InstallWorld) => {
    // The real CLI under a redirected HOME: a settings file holding
    // treecontext's entries without the two events added by D400 and D401.
    await openInstallWorld(w, ['.claude'])
    expect(tcCli(w, ['install', '--yes']).status).toBe(0)
    const settingsPath = join(w.ihome!, '.claude', 'settings.json')
    // step-lint: allow unearned-absence -- the same step, with two events removed, finds the row by this same text (the findIndex below): the needle fires
    expect(tcCli(w, ['doctor']).stdout, 'a fresh install already reports unwired events').not.toMatch(/capture events/)
    // Each event of the block install writes, in turn: removed from a wired
    // sandbox, doctor names exactly that event (its row's items, split on
    // "; ", lead with the event name), the fix command it prints is run
    // and the row is gone. A list inside doctor's function that held only
    // today's two newest events would fail here for the rest.
    const wired = Object.keys(claudeHooksBlock())
    expect(wired.length).toBeGreaterThan(2)
    for (const ev of wired) {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { hooks: Record<string, unknown> }
      expect(Object.keys(settings.hooks), `install no longer wires ${ev}`).toContain(ev)
      delete settings.hooks[ev]
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
      const doc = tcCli(w, ['doctor']).stdout.split('\n')
      const i = doc.findIndex((l) => /capture events: not wired: /.test(l))
      expect(i, `doctor did not name the old wiring without ${ev}:\n${doc.join('\n')}`).toBeGreaterThanOrEqual(0)
      const named = doc[i]!.split('not wired: ')[1]!.split('; ').map((item) => item.split(' (')[0])
      expect(named, `the row for a settings file without ${ev}`).toEqual([ev])
      const fix = /^\s+fix: (treecontext install --force --agent claude)$/.exec(doc[i + 1] ?? '')
      expect(fix, `the row names no wiring command:\n${doc.join('\n')}`).not.toBeNull()
      // The named command, run in the sandbox, wires it and the row is gone.
      expect(tcCli(w, [...fix![1]!.split(' ').slice(1), '--yes']).status).toBe(0)
      const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as { hooks: Record<string, unknown> }
      expect(Object.keys(after.hooks)).toContain(ev)
      // step-lint: allow unearned-absence -- the same loop turn found the row by this same text (the findIndex above): the needle fires
      expect(tcCli(w, ['doctor']).stdout).not.toMatch(/capture events/)
    }
  })

  // ── doctor ──────────────────────────────────────────────────────────
  reg.define(/^a working installation$/, async (w: InstallWorld) => {
    await openInstallWorld(w, ['.claude'])
    expect(tcCli(w, ['install', '--yes']).status).toBe(0)
  })

  reg.define(/^doctor runs$/, (w: InstallWorld) => {
    w.irun = tcCli(w, ['doctor'])
  })

  reg.define(/^the database is verified by opening one and reading its SQLite version and FTS5 support, not by comparing versions$/, (w: InstallWorld) => {
    // What this step does: it reads doctor's report on a healthy install.
    // The row names the SQLite version the running Node carries and says
    // FTS5 is compiled in — both read by opening a database (D278). The
    // version is pinned to the process's own, so a table of versions could
    // not pass this. No FTS5-less world runs here, so the step does not
    // show the verdict changing when the open finds no FTS5.
    const sqliteRow = /\[ok\]\s+SQLite: (\d+\.\d+\.\d+) built into this Node, FTS5 compiled in/.exec(w.irun!.out)
    expect(sqliteRow, `no SQLite row in:\n${w.irun!.out}`).not.toBeNull()
    expect(sqliteRow![1]).toBe(process.versions.sqlite)
    // "No row names a native binding or a prebuild" is the @D278 database-row
    // scenario's own clause, bound positively there, not an absence here.
  })

  // ── @D278: doctor's database row and Node row ───────────────────────
  const SQLITE_ROW = /\[ok\]\s+SQLite: (\d+\.\d+\.\d+) built into this Node, FTS5 compiled in/
  const NODE_ROW = /\[ok\]\s+Node\.js: (v\d+\.\d+\.\d+) \(floor >=(\d+\.\d+\.\d+)\)/

  reg.define(/^the database row names the SQLite version the running Node carries and says FTS5 is compiled in$/, (w: InstallWorld) => {
    const m = SQLITE_ROW.exec(w.irun!.out)
    expect(m, `no SQLite row in:\n${w.irun!.out}`).not.toBeNull()
    // Doctor ran under the test's own node (tcCli), so "the running Node"
    // is this process: the version it names is this process's SQLite.
    expect(m![1]).toBe(process.versions.sqlite)
  })

  reg.define(/^both facts are read by opening a database, not from a table of versions$/, (w: InstallWorld) => {
    // What opening a database on this Node yields, independently of doctor:
    // the row must agree with it, and it is nothing a table could know.
    const probe = new DatabaseSync(':memory:')
    try {
      const v = (probe.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v
      const fts5 = (probe.prepare('PRAGMA compile_options').all() as Array<{ compile_options: string }>)
        .some((r) => r.compile_options === 'ENABLE_FTS5')
      expect(SQLITE_ROW.exec(w.irun!.out)![1]).toBe(v)
      expect(fts5, 'this Node has no FTS5; the row above could not have said so honestly').toBe(true)
    } finally {
      probe.close()
    }
  })

  reg.define(/^no row names a native binding or a prebuild$/, (w: InstallWorld) => {
    // Every row is accounted for in the positive first: the rows that
    // replaced the binding row are present and well-formed...
    expect(w.irun!.out).toMatch(SQLITE_ROW)
    expect(w.irun!.out).toMatch(NODE_ROW)
    // ...and the words of the row they replaced are gone. The needle fired
    // at c227c81, where this report read "better-sqlite3: native binding
    // loaded and working" and doctor's Node row named prebuilds.
    // step-lint: allow unearned-absence -- the positive SQLite and Node row matches above pin the rows that replaced the binding row; the needle fired at c227c81 where this report read "better-sqlite3: native binding loaded and working"
    expect(w.irun!.out).not.toMatch(/better-sqlite3|native binding|prebuild/i)
  })

  reg.define(/^the Node row reports the running version against the floor the package's manifest declares$/, (w: InstallWorld) => {
    const m = NODE_ROW.exec(w.irun!.out)
    expect(m, `no Node row with a floor in:\n${w.irun!.out}`).not.toBeNull()
    expect(m![1]).toBe(process.version)
  })

  reg.define(/^the floor the row names is the manifest's, so the two cannot drift$/, (w: InstallWorld) => {
    // Read the manifest here, independently of the installer's reader: the
    // row's floor must be exactly what `engines.node` says.
    const pkg = JSON.parse(readFileSync(join(TS_ROOT, 'package.json'), 'utf8')) as { engines?: { node?: string } }
    const floor = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(pkg.engines?.node ?? '')
    expect(floor, 'package.json declares no numeric Node floor').not.toBeNull()
    const declared = `${floor![1]}.${floor![2]}.${floor![3] ?? '0'}`
    expect(NODE_ROW.exec(w.irun!.out)![2]).toBe(declared)
  })

  reg.define(/^every failing check is accompanied by the command that fixes it$/, (w: InstallWorld) => {
    // A healthy install reports nothing failing, so enumerating only this
    // run would pass vacuously. Enumerate a deliberately unwired home too,
    // which drives the checks that DO fail — the clause is about those.
    const degraded = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-doctor-degraded-')))
    // The degraded home also carries migration-backup residue — a shell
    // holding a live rollback, and an orphaned verdict sidecar — so the
    // backup section's warn rows face this enumeration too. They used to
    // escape it because neither enumerated world held backups, which is
    // how their advice sat in detail while this clause read green
    // (E chunk 3, cross-feature conflict repair).
    const ghostStores = storesDirIn(degraded)
    const ghost = join(ghostStores, 'ghost')
    mkdirSync(ghost, { recursive: true })
    const ghostBak = join(ghost, 'treecontext.db.pre-migration-v12.bak')
    writeFileSync(ghostBak, 'not a database - doctor sizes backups, it never opens them')
    writeVerdict(ghostBak, {
      version: 1, verdict: 'failed', backupEntries: 1, migratedEntries: 0, from: 12, to: 13, recordedAt: 0,
    })
    seedOrphanSidecar(ghostStores, 'ghost2', 13)
    let degradedOut: string
    try {
      degradedOut = tcCli({ ...w, ihome: degraded }, ['doctor']).stdout
    } finally {
      rmSync(degraded, { recursive: true, force: true })
    }
    expect(degradedOut, 'the seeded residue must drive the backup rows into the enumeration').toContain('Migration backups')

    let seen = 0
    for (const out of [w.irun!.stdout, degradedOut]) {
      const lines = out.split('\n')
      const failing = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^\[(warn|err)]/.test(l))
      for (const { l, i } of failing) {
        seen++
        // Exactly the next line: doctor prints one header line per row
        // with the row's own fix on the line after it (installer.ts print
        // loop), so a wider window would let a fix-less warn row pass on
        // its NEIGHBOR's fix line — and the seeded residue above
        // guarantees adjacent warn rows, exactly the vacuous-pass
        // geometry (review of E chunk 3).
        const next = lines[i + 1] ?? ''
        expect(next, `failing check carries no fix command: ${l}`).toMatch(/^\s+fix:/)
      }
    }
    expect(seen, 'no failing check was enumerated — the clause proved nothing').toBeGreaterThan(0)
  })

  // ── doctor's headline when nothing is wired (D276) ─────────────────
  // A fresh machine as the beta tester had it: Claude Code present, the
  // package installed the way npm lays out a global install (its command
  // first on PATH, every other treecontext command filtered off PATH),
  // and `treecontext install` never run. The real CLI under a sandboxed
  // HOME; the report read line by line.
  reg.define(/^a machine where the package is installed and no agent is wired$/, async (w: InstallWorld) => {
    await openInstallWorld(w, ['.claude'])
    const version = (JSON.parse(readFileSync(join(TS_ROOT, 'package.json'), 'utf8')) as { version: string }).version
    w.iOtherBuild = fakeGlobalInstall(w.ihome!, version)
    // A Claude Code that reads the key, so doctor's idle-compaction row is a
    // warning here like the other two (the key is absent, the client's
    // default is on) and the scenario keeps proving that EVERY warning row
    // names the one command and that the command clears every one (D290,
    // D276). The world's fake is the same on every machine.
    setClaudeVersion(w, '2.1.302')
    // Nothing of treecontext is wired: no global config, no launcher, no
    // agent entry.
    expect(existsSync(join(w.ihome!, '.treecontext', 'config.toml'))).toBe(false)
    expect(existsSync(mcpLauncherIn(w.ihome!))).toBe(false)
    expect(existsSync(join(w.ihome!, '.claude.json'))).toBe(false)
  })
  const packageOnPath = (w: InstallWorld): string => [w.iOtherBuild!.bin, ...(w.iClaudeBin ? [w.iClaudeBin] : []), ...(process.env['PATH'] ?? '').split(delimiter).filter((d) => {
    if (!d) return false
    try { return !readdirSync(d).some((f) => f === 'treecontext' || f.startsWith('treecontext.')) } catch { return true }
  })].join(delimiter)
  reg.define(/^the developer runs doctor$/, (w: InstallWorld) => {
    w.irun = spawnCli(['doctor'], { home: w.ihome!, cwd: TS_ROOT, env: { PATH: packageOnPath(w) } })
    expect(w.irun.status, w.irun.out).toBe(0)
  })
  reg.define(/^the first line after the header says treecontext is not set up for any agent yet and names the one command to run$/, (w: InstallWorld) => {
    const lines = w.irun!.stdout.split('\n')
    const platform = lines.findIndex((l) => l.startsWith('Platform: '))
    expect(lines[0], w.irun!.stdout).toMatch(/^treecontext doctor v/)
    expect(platform, w.irun!.stdout).toBeGreaterThan(0)
    expect(lines[platform + 1]).toBe('treecontext is not set up for any agent yet — run: treecontext install')
    // The package itself is found: the row for the command on PATH is no
    // warning, so the headline is the only thing standing between the
    // developer and a working install.
    expect(lines.find((l) => l.includes('Command on PATH:')), w.irun!.stdout).toMatch(/^\[ok\]/)
  })
  reg.define(/^every warning row below it names that same command as its fix$/, (w: InstallWorld) => {
    const lines = w.irun!.stdout.split('\n')
    const failing = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^\[(warn|err)]/.test(l))
    // Every row the unwired state raises: the global config, the agent and
    // the client's idle compaction, which install turns off.
    expect(failing.map(({ l }) => l.replace(/^\[\w+\]\s+/, '').split(':')[0]).sort()).toEqual(['Claude Code', 'Global config', 'Idle compaction'])
    for (const { l, i } of failing) {
      expect(lines[i + 1], `the row does not name the headline's command: ${l}`).toBe('       fix: treecontext install')
    }
    // That command clears every one of them (D51): run as the developer
    // would, then doctor again says nothing is missing.
    const install = tcCli(w, ['install', '--yes'])
    expect(install.status, install.out).toBe(0)
    const again = spawnCli(['doctor'], { home: w.ihome!, cwd: TS_ROOT, env: { PATH: packageOnPath(w) } })
    expect(again.stdout, again.out).toMatch(/^\[ok\] +Claude Code: MCP configured/m)
    const after = again.stdout.split('\n')
    expect(after.filter((l) => /^\[(warn|err)]/.test(l)), again.stdout).toEqual([])
    expect(after[after.findIndex((l) => l.startsWith('Platform: ')) + 1]).toMatch(/^\[ok\]/)
    // The headline keys on the wiring, not on what install leaves behind:
    // after an uninstall the global config and logs survive, and doctor
    // again says nothing is set up.
    const uninstall = tcCli(w, ['uninstall', '--yes'])
    expect(uninstall.status, uninstall.out).toBe(0)
    expect(existsSync(join(w.ihome!, '.treecontext', 'config.toml')), 'the uninstall left no config to test against').toBe(true)
    const gone = spawnCli(['doctor'], { home: w.ihome!, cwd: TS_ROOT, env: { PATH: packageOnPath(w) } }).stdout.split('\n')
    expect(gone[gone.findIndex((l) => l.startsWith('Platform: ')) + 1]).toBe('treecontext is not set up for any agent yet — run: treecontext install')
  })

  // ── which build is which ────────────────────────────────────────────
  reg.define(/^a working installation where the command on PATH is a different build$/, async (w: InstallWorld) => {
    await openInstallWorld(w, ['.claude'])
    expect(tcCli(w, ['install', '--yes']).status).toBe(0)
    w.iOtherBuild = fakeGlobalInstall(w.ihome!, '9.9.9-rival')
  })

  reg.define(/^doctor runs with that command first on PATH$/, (w: InstallWorld) => {
    w.irun = spawnCli(['doctor'], {
      home: w.ihome!, cwd: TS_ROOT,
      env: { PATH: pathWithFakeClaude(w, `${w.iOtherBuild!.bin}${delimiter}${process.env['PATH'] ?? ''}`) },
    })
  })

  reg.define(/^the report names that build and this one, each by version and location$/, (w: InstallWorld) => {
    const rival = w.iOtherBuild!
    const row = w.irun!.stdout.split('\n').find(l => l.startsWith('[warn] Command on PATH:'))
    expect(row, `no Command on PATH warning in:\n${w.irun!.out}`).toBeDefined()
    // That build: the version and root the fabricated shim actually leads to.
    expect(row).toContain(`v${rival.version}`)
    expect(row).toContain(rival.root)
    // This one: the checkout the report is running from, by its own version.
    const thisVersion = (JSON.parse(readFileSync(join(TS_ROOT, 'package.json'), 'utf8')) as { version: string }).version
    expect(row).toContain(`v${thisVersion} at ${realpathSync.native(TS_ROOT)}`)
    // Named, never ranked: the row says which build the command GETS, in the
    // only words the builder has for it — the version, not an ordering.
    expect(row).toContain(`gets the v${rival.version} build`)
  })

  reg.define(/^the report says the agent is wired to this one$/, (w: InstallWorld) => {
    expect(w.irun!.stdout).toMatch(/^\[ok\] +Wired build: the MCP launcher and hooks run this build/m)
  })

  reg.define(/^that build has since re-pinned the launcher to itself$/, (w: InstallWorld) => {
    // What the rival's own `install` leaves behind: the launcher's TC_CLI pin
    // rewritten to its entry point, in whichever dialect this host wrote.
    const launcher = mcpLauncherIn(w.ihome!)
    const rivalCli = join(w.iOtherBuild!.root, 'dist', 'server', 'cli.js')
    const body = readFileSync(launcher, 'utf8')
    const repinned = process.platform === 'win32'
      ? body.replace(/^set "TC_CLI=[^"]+"/m, `set "TC_CLI=${rivalCli}"`)
      : body.replace(/^TC_CLI="[^"]+"/m, `TC_CLI="${rivalCli}"`)
    expect(repinned, 'the launcher carried no TC_CLI pin to rewrite').not.toBe(body)
    writeFileSync(launcher, repinned)
  })

  reg.define(/^the report says the agent talks to that build$/, (w: InstallWorld) => {
    const rival = w.iOtherBuild!
    const row = w.irun!.stdout.split('\n').find(l => l.startsWith('[warn] Wired build:'))
    expect(row, `no Wired build warning in:\n${w.irun!.out}`).toBeDefined()
    expect(row).toContain(`runs ${rival.name} v${rival.version} at ${rival.root}`)
    expect(row).toContain('your agent talks to it')
  })

  reg.define(/^the fix reaches this build without going through PATH$/, (w: InstallWorld) => {
    // PATH runs the rival, so `treecontext install --force` would rewire the
    // agent to the rival again. The fix has to name this build's entry point.
    const lines = w.irun!.stdout.split('\n')
    const i = lines.findIndex(l => l.startsWith('[warn] Wired build:'))
    // By this build's own entry point — the one that exists: the built
    // cli.js under node, or, in this suite's world, the cli.ts twin under tsx.
    expect(lines[i + 1]).toMatch(/^\s+fix: (?:node|npx tsx) "/)
    expect(lines[i + 1]).toContain(realpathSync.native(TS_ROOT))
    expect(lines[i + 1]).toContain('install --force')
  })

  reg.define(/^a checkout that was built but never installed globally$/, async (w: InstallWorld) => {
    // The suite itself is that checkout: every tcCli spawn runs TS_ROOT's
    // src/server/cli.ts, and nothing here has put a shim for it anywhere.
    await openInstallWorld(w, ['.claude'])
  })

  reg.define(/^doctor runs with no treecontext command on PATH$/, (w: InstallWorld) => {
    // The real PATH with every directory holding a `treecontext*` removed —
    // so the lookup tool itself (`command -v`, `where`) still runs and
    // answers "nothing", which is the state under test. An empty PATH would
    // have tested "no lookup tool", and a doctor that never consulted PATH
    // at all would have passed it (adversarial review, finding 8).
    const kept = (process.env['PATH'] ?? '').split(delimiter).filter(d => {
      if (!d) return false
      try { return !readdirSync(d).some(f => f === 'treecontext' || f.startsWith('treecontext.')) } catch { return true }
    })
    expect(kept.length, 'no PATH directories survived the filter').toBeGreaterThan(0)
    w.irun = spawnCli(['doctor'], { home: w.ihome!, cwd: TS_ROOT, env: { PATH: pathWithFakeClaude(w, kept.join(delimiter)) } })
  })

  reg.define(/^the report says the command is absent and where this build lives$/, (w: InstallWorld) => {
    const row = w.irun!.stdout.split('\n').find(l => l.startsWith('[warn] Command on PATH:'))
    expect(row, `no Command on PATH warning in:\n${w.irun!.out}`).toBeDefined()
    expect(row).toMatch(/no `treecontext` command on PATH/)
    expect(row).toContain(realpathSync.native(TS_ROOT))
  })

  reg.define(/^the finding carries the command that puts this build on PATH$/, (w: InstallWorld) => {
    const lines = w.irun!.stdout.split('\n')
    const i = lines.findIndex(l => l.startsWith('[warn] Command on PATH:'))
    expect(lines[i + 1]).toMatch(/^\s+fix: npm install -g "/)
    expect(lines[i + 1]).toContain(realpathSync.native(TS_ROOT))
  })

  reg.define(/^the fix that finding prints is run from this build$/, (w: InstallWorld) => {
    // The printed command, executed — not read. Under tsx the fix names the
    // .ts twin through `npx tsx`; the suite's own loader is that tsx, so the
    // script and its arguments are lifted from the line and run through it.
    const lines = w.irun!.stdout.split('\n')
    const i = lines.findIndex(l => l.startsWith('[warn] Wired build:'))
    const fix = lines[i + 1] ?? ''
    const m = /^\s+fix: (?:node|npx tsx) "([^"]+)" (install --force)/.exec(fix)
    expect(m, `fix line is not a runnable command: ${fix}`).not.toBeNull()
    const run = spawnNodeTs(m![1]!, m![2]!.split(' '), {
      home: w.ihome!, cwd: TS_ROOT,
      env: { PATH: pathWithFakeClaude(w, `${w.iOtherBuild!.bin}${delimiter}${process.env['PATH'] ?? ''}`) },
    })
    expect(run.status, run.out).toBe(0)
    w.irun = spawnCli(['doctor'], {
      home: w.ihome!, cwd: TS_ROOT,
      env: { PATH: pathWithFakeClaude(w, `${w.iOtherBuild!.bin}${delimiter}${process.env['PATH'] ?? ''}`) },
    })
  })

  reg.define(/^the finding is gone and the agent is wired to this one again$/, (w: InstallWorld) => {
    expect(w.irun!.stdout).toMatch(/^\[ok\] +Wired build: the MCP launcher and hooks run this build/m)
  })

  reg.define(/^an installation with a finding doctor knows how to fix$/, async (w: InstallWorld) => {
    await openInstallWorld(w, ['.claude'])
    expect(tcCli(w, ['install', '--yes']).status).toBe(0)
    // Leftover hooks on a platform install does not manage: the finding that
    // shipped with a fix command that could not clear it.
    mkdirSync(dirname(agentConfigPath('vscode', w.ihome!)), { recursive: true })
    writeFileSync(agentConfigPath('vscode', w.ihome!), JSON.stringify({
      servers: { treecontext: { command: process.execPath, args: ['cli.js', '--capture'] } },
    }))
    const stale = join(w.ihome!, 'old-build', 'dist', 'hooks', 'vscode')
    mkdirSync(stale, { recursive: true })
    writeFileSync(join(stale, 'session-start.js'), '// an older build\n')
    mkdirSync(join(w.ihome!, '.copilot', 'hooks'), { recursive: true })
    writeFileSync(join(w.ihome!, '.copilot', 'hooks', 'treecontext.json'), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `node "${join(stale, 'session-start.js')}"` }] }] },
    }))
    w.iDoctorBefore = tcCli(w, ['doctor']).out
    // The fix belonging to THIS finding, not merely the first one in the
    // report. Doctor lists findings in agent order and each carries its own
    // `fix:` line; taking the first match meant that as soon as an unrelated
    // warning appeared above this one, the scenario ran that command instead
    // and then asserted this finding had cleared. On Windows exactly that
    // happened — a "Claude Code: hooks missing" warning sorted first — so the
    // scenario ran `install --force --agent claude` and blamed the VS Code
    // finding for surviving it.
    const lines = w.iDoctorBefore.split('\n')
    const findingIdx = lines.findIndex(l => /hooks \(unmanaged\)/.test(l))
    expect(findingIdx, `doctor never reported the unmanaged-hooks finding:\n${w.iDoctorBefore}`).toBeGreaterThanOrEqual(0)
    const fixLine = lines.slice(findingIdx + 1).find(l => /^\s+fix: treecontext /.test(l))
    expect(fixLine, `the unmanaged-hooks finding offered no fix:\n${w.iDoctorBefore}`).toBeTruthy()
    w.iFixCommand = fixLine!.replace(/^\s+fix: /, '').trim()
  })

  reg.define(/^the command that finding prints is run$/, (w: InstallWorld) => {
    const argv = w.iFixCommand!.split(/\s+/).slice(1)   // drop the leading "treecontext"
    const r = tcCli(w, [...argv, '--yes'])
    expect(r.status, `the offered fix failed to run:\n${r.out}`).toBe(0)
  })

  reg.define(/^doctor runs again$/, (w: InstallWorld) => {
    w.irun = tcCli(w, ['doctor'])
  })

  reg.define(/^that finding is gone from the report$/, (w: InstallWorld) => {
    expect(w.iDoctorBefore).toMatch(/hooks \(unmanaged\)/)
    // step-lint: allow unearned-absence -- guarded: the line above asserts the finding WAS present pre-fix (iDoctorBefore toMatch) — a before/after pair
    expect(w.irun!.out, 'the offered fix did not clear the finding it was printed for')
      .not.toMatch(/hooks \(unmanaged\)/)
  })

  // ── uninstall ───────────────────────────────────────────────────────
  // Every agent install writes permission rules into (D383, D390): Claude
  // Code, Codex CLI and Antigravity CLI, each beside a foreign server and a
  // rule of the developer's. Codex's and agy's entries are read through
  // their own listings; the rules through the files the clients read, since
  // Claude Code and agy print none.
  const FOREIGN_AGY = { trustedWorkspaces: ['/srv/work'], permissions: { allow: ['mcp(github/*)'], deny: ['command(sudo)'] } }
  reg.define(/^a machine with treecontext installed alongside foreign servers and hooks$/, async (w: InstallWorld) => {
    await openInstallWorld(w, ['.claude', '.codex'])
    putAgyOnPath(w)
    writeFileSync(join(w.ihome!, '.claude.json'), JSON.stringify({
      mcpServers: { 'foreign-server': { command: 'someone-elses-tool' } },
    }))
    writeFileSync(settingsFile(w), JSON.stringify({ permissions: { allow: ['mcp__github__get_issue'] } }, null, 2) + '\n')
    writeFileSync(codexConfigFile(w), '[mcp_servers.foreign]\ncommand = "someone-elses-tool"\n')
    mkdirSync(join(w.ihome!, '.gemini', 'config'), { recursive: true })
    writeFileSync(join(w.ihome!, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { 'foreign-server': { command: 'someone-elses-tool' } } }, null, 2) + '\n')
    mkdirSync(dirname(agySettingsFile(w)), { recursive: true })
    writeFileSync(agySettingsFile(w), JSON.stringify(FOREIGN_AGY, null, 2) + '\n')
    const install = tcCli(w, ['install', '--yes'])
    expect(install.status, install.out).toBe(0)
    // The positive half of the uninstall Then's absences: every entry it
    // proves gone is proven present here first, in this same world.
    const installed = JSON.parse(readFileSync(join(w.ihome!, '.claude.json'), 'utf8')) as Record<string, Record<string, unknown>>
    expect(installed['mcpServers']?.['treecontext'], 'install wrote no MCP entry').toBeDefined()
    expect(readFileSync(join(w.ihome!, '.claude', 'settings.json'), 'utf8'), 'install wrote no hook command').toMatch(/tc-/)
    expect(readdirSync(join(w.ihome!, '.claude', 'hooks')).filter(f => f.startsWith('tc-')).length, 'install wrote no hook script').toBeGreaterThan(0)
    expect(existsSync(join(w.ihome!, '.claude', 'skills', 'treecontext-reference')), 'install wrote no skill').toBe(true)
    expect(claudePermissions(w)['allow'], 'install wrote no Claude Code rule').toEqual(['mcp__github__get_issue', ...FOUR.map(t => `mcp__treecontext__${t}`)])
    expect(codexCli(w, ['mcp', 'list']).stdout, 'Codex lists no treecontext server').toMatch(/^treecontext\s/m)
    expect(Object.keys((await codexToolsSeen(w)).tools).sort(), 'install wrote no Codex approval').toEqual([...FOUR].sort())
    expect(agyMcpList(w).servers.map(s => s.name).sort(), 'agy lists no treecontext server').toEqual(['foreign-server', 'treecontext'])
    expect(agyPermissions(w)['allow'], 'install wrote no agy rule').toEqual(['mcp(github/*)', ...FOUR.map(t => `mcp(treecontext/${t})`)])
    expect(readFileSync(join(w.ihome!, '.gemini', 'GEMINI.md'), 'utf8'), 'install wrote no instruction block for agy').toContain(MARKER_START)
    // A store with a row in it — uninstall must not touch the record.
    const storeDir = join(storesDirIn(w.ihome!), 'keepme')
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(join(storeDir, 'treecontext.db'), 'journal bytes')
  })

  reg.define(/^uninstall runs$/, (w: InstallWorld) => {
    w.irun = tcCli(w, ['uninstall', '--yes'])
    expect(w.irun.status).toBe(0)
  })

  reg.define(/^every treecontext MCP entry, permission rule install added, hook, script, and skill is gone from every agent$/, (w: InstallWorld) => {
    // Claude Code: its entry, hooks, scripts, skill, and the four rules.
    const cfg = JSON.parse(readFileSync(join(w.ihome!, '.claude.json'), 'utf8')) as Record<string, Record<string, unknown>>
    expect(cfg['mcpServers']?.['treecontext']).toBeUndefined()
    const settings = readFileSync(settingsFile(w), 'utf8')
    // step-lint: allow unearned-absence -- guarded: the Given of this scenario asserts, after its install, that settings.json matches /tc-/ and holds the four rules, the MCP entry exists, tc- hook scripts exist and the skill exists — a before/after pair in this same world
    expect(settings).not.toMatch(/tc-|mcp__treecontext__/)
    const hooksDir = join(w.ihome!, '.claude', 'hooks')
    if (existsSync(hooksDir)) {
      expect(readdirSync(hooksDir).filter(f => f.startsWith('tc-'))).toEqual([])
    }
    expect(existsSync(join(w.ihome!, '.claude', 'skills', 'treecontext-reference'))).toBe(false)
    // Codex CLI: its own listing names no treecontext server, so no approval is left.
    const codexList = codexCli(w, ['mcp', 'list'])
    expect(codexList.status, codexList.out).toBe(0)
    // step-lint: allow unearned-absence -- guarded: the Given asserts Codex's own listing names treecontext after install, in this same world
    expect(codexList.stdout).not.toMatch(/^treecontext\s/m)
    // step-lint: allow unearned-absence -- guarded: the Given asserts Codex reads the four approvals after install
    expect(readFileSync(codexConfigFile(w), 'utf8')).not.toMatch(/treecontext/)
    // Antigravity CLI: its own listing, its rules, and the block it reads.
    expect(agyMcpList(w).servers.map(s => s.name)).toEqual(['foreign-server'])
    // step-lint: allow unearned-absence -- guarded: the Given asserts the four agy rules present after install
    expect(JSON.stringify(agyPermissions(w))).not.toMatch(/treecontext/)
    const gemini = join(w.ihome!, '.gemini', 'GEMINI.md')
    if (existsSync(gemini)) expect(readFileSync(gemini, 'utf8')).not.toContain(MARKER_START)
    // And install's record names nothing it wrote any more.
    expect(installRecord(w).toolApprovals?.written ?? {}).toEqual({})
  })

  reg.define(/^the foreign configuration is intact$/, (w: InstallWorld) => {
    const cfg = JSON.parse(readFileSync(join(w.ihome!, '.claude.json'), 'utf8')) as Record<string, Record<string, unknown>>
    expect(cfg['mcpServers']?.['foreign-server']).toEqual({ command: 'someone-elses-tool' })
    if (w.iAgyBin) {
      // The developer's own rules in Claude Code and agy, the foreign
      // servers of Codex and agy as each client lists them, and agy's other keys.
      expect(claudePermissions(w)).toEqual({ allow: ['mcp__github__get_issue'] })
      expect(codexCli(w, ['mcp', 'list']).stdout).toMatch(/^foreign\s+someone-elses-tool/m)
      const foreign = agyMcpList(w).servers.find(s => s.name === 'foreign-server')
      expect(foreign, 'agy no longer lists the foreign server').toEqual({ name: 'foreign-server', type: 'stdio', status: 'enabled', command: 'someone-elses-tool' })
      expect(agySettings(w)).toEqual(FOREIGN_AGY)
    }
  })

  reg.define(/^the journal stores are untouched$/, (w: InstallWorld) => {
    const kept = join(storesDirIn(w.ihome!), 'keepme', 'treecontext.db')
    expect(existsSync(kept), 'uninstall deleted a journal store').toBe(true)
    expect(readFileSync(kept, 'utf8')).toBe('journal bytes')
  })

  // ── hooks-only uninstall spares the MCP launcher ────────────────────
  const mcpLauncherName = `tc-mcp-serve${process.platform === 'win32' ? '.cmd' : ''}`

  reg.define(/^a machine with treecontext installed for the reference agent$/, async (w: InstallWorld) => {
    await openInstallWorld(w, ['.claude'])
    expect(tcCli(w, ['install', '--yes']).status).toBe(0)
  })

  reg.define(/^uninstall runs with the hooks-only flag$/, (w: InstallWorld) => {
    w.irun = tcCli(w, ['uninstall', '--yes', '--hooks-only'])
    expect(w.irun.status).toBe(0)
  })

  reg.define(/^the hook scripts are gone$/, (w: InstallWorld) => {
    const hooksDir = join(w.ihome!, '.claude', 'hooks')
    const left = readdirSync(hooksDir).filter(f => f.startsWith('tc-') && f !== mcpLauncherName)
    expect(left, 'hook scripts survived a hooks-only uninstall').toEqual([])
  })

  reg.define(/^the MCP registration still points at a launcher that exists$/, (w: InstallWorld) => {
    const cfg = JSON.parse(readFileSync(join(w.ihome!, '.claude.json'), 'utf8')) as Record<string, Record<string, { command?: string }>>
    const command = cfg['mcpServers']?.['treecontext']?.command
    expect(command, 'hooks-only uninstall removed the MCP registration itself').toBeDefined()
    expect(toPosix(command!).endsWith(`/${mcpLauncherName}`), `registration points at ${command}`).toBe(true)
    expect(existsSync(command!), 'the registered launcher no longer exists on disk').toBe(true)
  })

  // ── project instructions refresh in place ───────────────────────────
  reg.define(/^a project instruction file already carrying an older treecontext block$/, async (w: InstallWorld) => {
    await openInstallWorld(w, ['.claude'])
    w.iproj = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-install-proj-')))
    w.defer(() => rmSync(w.iproj!, { recursive: true, force: true }))
    writeFileSync(join(w.iproj, 'AGENTS.md'), [
      '# Project notes',
      '',
      'Some prose that belongs to the project.',
      '',
      '<!-- treecontext:start -->',
      'an older block that must be replaced',
      '<!-- treecontext:end -->',
      '',
      'Trailing prose that must survive.',
      '',
    ].join('\n'))
  })

  reg.define(/^init runs in that project$/, (w: InstallWorld) => {
    w.irun = tcCli(w, ['init', '--yes'], { cwd: w.iproj! })
    expect(w.irun.status).toBe(0)
  })

  reg.define(/^the block is replaced by the current one without duplication$/, (w: InstallWorld) => {
    const body = readFileSync(join(w.iproj!, 'AGENTS.md'), 'utf8')
    expect(body.match(/<!-- treecontext:start -->/g) ?? []).toHaveLength(1)
    // step-lint: allow unearned-absence -- guarded: this scenario's Given wrote 'an older block that must be replaced' into the fixture AGENTS.md; update-in-place is proven by the pair
    expect(body).not.toMatch(/an older block that must be replaced/)
  })

  reg.define(/^the rest of the file survives untouched$/, (w: InstallWorld) => {
    const body = readFileSync(join(w.iproj!, 'AGENTS.md'), 'utf8')
    expect(body).toMatch(/Some prose that belongs to the project\./)
    expect(body).toMatch(/Trailing prose that must survive\./)
  })

  // ── doctor names the runaway staging row and who spins on it (D265) ──
  // The real hook subprocess, run from this repository under a sandboxed
  // HOME, creates the store and binds this directory to it (the binding
  // doctor reads); the runaway row is staged and retried through the real
  // staging API; the drain lease is taken by a real LeaseClient naming a
  // live process; the real doctor CLI reads it all read-only.
  reg.define(/^a store whose staging table holds a row retried more than ten times the retry ceiling, while the drain lease names a live holder$/, async (w: InstallWorld) => {
    await openInstallWorld(w, ['.claude'])
    const version = (JSON.parse(readFileSync(join(TS_ROOT, 'package.json'), 'utf8')) as { version: string }).version
    w.iOtherBuild = fakeGlobalInstall(w.ihome!, version)
    const hook = spawnNodeTs(join(TS_ROOT, 'src', 'hooks', 'user-prompt-submit.ts'), [], {
      home: w.ihome!, cwd: TS_ROOT,
      input: JSON.stringify({ session_id: 'cc-runaway', cwd: TS_ROOT, hook_event_name: 'UserPromptSubmit', prompt: 'binds this directory' }),
    })
    expect(hook.status, hook.out).toBe(0)
    const bindings = JSON.parse(readFileSync(join(w.ihome!, '.treecontext', 'bindings.json'), 'utf8')) as {
      projects: Record<string, { store: string }>
    }
    const names = [...new Set(Object.values(bindings.projects).map((p) => p.store))]
    expect(names).toHaveLength(1)
    const dbPath = join(storesDirIn(w.ihome!), names[0]!, 'treecontext.db')
    // The process that spins: a live one, so the fix names a real pid.
    // It exits on its own after a minute should the deferred kill never run.
    const spinner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6); setTimeout(() => process.exit(), 60000)'], { stdio: 'ignore' })
    w.defer(() => { spinner.kill() })
    const store = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(dbPath)), ownsDatabase: true })
    try {
      const id = store.store.insertStaging({ sessionId: 'cc-runaway', role: 'user', content: 'the row the dead-letter path cannot retire', timestamp: Date.now() / 1000 - 3600 })
      let attempts = 0
      for (let i = 0; i <= 10 * MAX_INGEST_ATTEMPTS; i++) attempts = store.store.incrementStagingAttempts(id)
      expect(attempts).toBe(10 * MAX_INGEST_ATTEMPTS + 1)
      const leases = new LeaseClient(store.store.database, { pid: spinner.pid!, host: hostname(), label: 'serve:project' })
      leases.tryAcquire('drain', DRAIN_LEASE_TTL_SECS)
      w.iRunaway = { stagingId: id, attempts, holderPid: spinner.pid!, holderHost: hostname() }
    } finally {
      await store.close()
    }
    // Direct inspection: the row and the holder are what the store says.
    const raw = new DatabaseSync(dbPath, { readOnly: true })
    try {
      expect(raw.prepare('SELECT attempts, processed FROM staging WHERE id = ?').get(w.iRunaway.stagingId))
        .toEqual({ attempts: 10 * MAX_INGEST_ATTEMPTS + 1, processed: 0 })
      expect(raw.prepare("SELECT holder_pid FROM leases WHERE role = 'drain'").get()).toEqual({ holder_pid: spinner.pid })
    } finally {
      raw.close()
    }
  })

  reg.define(/^the capture-debt row names that staging row, its attempt count and the drain holder's process$/, (w: InstallWorld) => {
    const r = w.iRunaway!
    const lines = w.irun!.stdout.split('\n')
    const rows = lines.filter((l) => /^\[\w+\]\s+Capture debt:/.test(l))
    expect(rows, w.irun!.stdout).toHaveLength(1)
    const row = rows[0]!
    expect(row).toMatch(/^\[warn\]/)
    expect(row).toContain(`staging row ${r.stagingId} has been retried ${r.attempts} times`)
    expect(row).toContain(`more than ten times the retry ceiling of ${MAX_INGEST_ATTEMPTS}`)
    expect(row).toContain(`the drain is held by pid ${r.holderPid}@${r.holderHost}`)
    // What it logged is one command away, named in the detail.
    expect(row).toContain('`treecontext doctor --dump-logs`')
  })

  reg.define(/^the finding's fix names the process to quit$/, (w: InstallWorld) => {
    const r = w.iRunaway!
    const lines = w.irun!.stdout.split('\n')
    const at = lines.findIndex((l) => /^\[\w+\]\s+Capture debt:/.test(l))
    const fix = lines[at + 1] ?? ''
    // D51: the fix is the bare command that stops that process (the
    // locked-store row's shape) — a live lease held on this host.
    expect(fix, w.irun!.stdout).toBe(`       fix: ${process.platform === 'win32' ? `taskkill /F /PID ${r.holderPid}` : `kill ${r.holderPid}`}`)
  })

  // ── the README's upgrading section says quit first (D265) ───────────
  reg.define(/^the README's section on upgrading between betas$/, (w: InstallWorld) => {
    const readme = readFileSync(join(TS_ROOT, 'README.md'), 'utf8').replace(/\r\n/g, '\n')
    const start = readme.indexOf('### Upgrading between beta releases')
    expect(start, 'the README has no upgrading section').toBeGreaterThan(-1)
    const rest = readme.slice(start + '### Upgrading between beta releases'.length)
    const end = rest.search(/^#{2,3} /m)
    w.iReadmeSection = end === -1 ? rest : rest.slice(0, end)
  })

  reg.define(/^a developer reads it before upgrading$/, (w: InstallWorld) => {
    expect(w.iReadmeSection!.trim().length).toBeGreaterThan(0)
  })

  reg.define(/^its first instruction is to quit every running session$/, (w: InstallWorld) => {
    const section = w.iReadmeSection!
    const first = section.trim().split(/\n\s*\n/)[0]!.replace(/\s+/g, ' ')
    // The opening sentence is the instruction, and it comes before the install.
    expect(first).toMatch(/^First, \*\*quit every running session\*\*/)
    expect(section.indexOf('quit every running session')).toBeLessThan(section.indexOf('Install the new beta over the old one'))
    // And why: an older server keeps running against the store, and a beta.1
    // server has no step-aside.
    expect(first).toMatch(/keeps running against your store until its session ends/)
    expect(first).toMatch(/A `0\.1\.0-beta\.1` server has no such step-aside/)
  })

  // ── Claude Code's idle compaction (D290, D304, D338) ────────────────
  //
  // The world is the real CLI in a redirected HOME with a fake `claude` on
  // its PATH answering `--version` as the scenario says. The settings file
  // is seeded with neighbours that must not be taken for the key (a related
  // `autoCompactEnabled`, foreign settings), and every Then reads the file
  // on disk or the CLI's own stdout.
  const settingsFile = (w: InstallWorld): string => join(w.ihome!, '.claude', 'settings.json')
  const settingsOnDisk = (w: InstallWorld): Record<string, unknown> =>
    JSON.parse(readFileSync(settingsFile(w), 'utf8')) as Record<string, unknown>
  const seedSettings = (w: InstallWorld, key: 'absent' | 'on' | 'off'): void => {
    const seeded: Record<string, unknown> = {
      model: 'opus',
      autoCompactEnabled: true,
      permissions: { allow: ['Bash(ls:*)'] },
      ...(key === 'absent' ? {} : { idleCompaction: key === 'on' }),
    }
    mkdirSync(join(w.ihome!, '.claude'), { recursive: true })
    writeFileSync(settingsFile(w), JSON.stringify(seeded, null, 2) + '\n')
    w.iSettingsBefore = readFileSync(settingsFile(w), 'utf8')
  }
  const aClaudeCode = async (w: InstallWorld, version: string | null, key: 'absent' | 'on' | 'off'): Promise<void> => {
    await openInstallWorld(w, ['.claude'])
    setClaudeVersion(w, version)
    seedSettings(w, key)
  }
  /** The install output's lines about idle compaction. */
  const idleLines = (out: string): string[] => out.split('\n').filter(l => /idle.compaction/i.test(l))
  /** Doctor's row for idle compaction: its line and the fix line printed under it. */
  const idleRow = (out: string): string => {
    const lines = out.split('\n')
    const at = lines.findIndex(l => /^\[(ok|warn|err)\]\s+Idle compaction:/.test(l))
    expect(at, `doctor printed no row for idle compaction:\n${out}`).toBeGreaterThanOrEqual(0)
    const fix = lines[at + 1]?.trimStart().startsWith('fix:') ? `\n${lines[at + 1]}` : ''
    return `${lines[at]}${fix}`
  }
  const KEY_LINE = '"idleCompaction": false'

  reg.define(/^a Claude Code whose version (reads \d+\.\d+\.\d+|cannot be read) and whose settings carry no idle-compaction key$/,
    async (w: InstallWorld, said: unknown) => {
      const reading = String(said)
      await aClaudeCode(w, reading.startsWith('reads ') ? reading.slice('reads '.length) : null, 'absent')
      expect(Object.hasOwn(settingsOnDisk(w), 'idleCompaction'), 'the seeded settings already carry the key').toBe(false)
    })

  reg.define(/^a Claude Code whose version reads (\d+\.\d+\.\d+) and whose settings carry the idle-compaction key set to (on|off)$/,
    async (w: InstallWorld, version: unknown, value: unknown) => {
      await aClaudeCode(w, String(version), String(value) as 'on' | 'off')
      expect(settingsOnDisk(w)['idleCompaction']).toBe(value === 'on')
    })

  reg.define(/^a Claude Code whose version reads (\d+\.\d+\.\d+), on which install wrote no idle-compaction key$/,
    async (w: InstallWorld, version: unknown) => {
      await aClaudeCode(w, String(version), 'absent')
      w.irun = tcCli(w, ['install', '--yes'])
      expect(w.irun.status, w.irun.out).toBe(0)
      expect(Object.hasOwn(settingsOnDisk(w), 'idleCompaction'), 'install wrote the key for a client that does not read it').toBe(false)
    })

  reg.define(/^the developer runs install$/, (w: InstallWorld) => {
    w.irun = tcCli(w, ['install', '--yes'])
    w.iInstallRun = w.irun
    expect(w.irun.status, w.irun.out).toBe(0)
  })

  reg.define(/^the developer runs install and then doctor$/, (w: InstallWorld) => {
    w.iInstallRun = tcCli(w, ['install', '--yes'])
    expect(w.iInstallRun.status, w.iInstallRun.out).toBe(0)
    w.iDoctorRun = tcCli(w, ['doctor'])
    w.irun = w.iDoctorRun
  })

  reg.define(/^the client is upgraded to (\d+\.\d+\.\d+) and the developer runs install again$/, (w: InstallWorld, version: unknown) => {
    setClaudeVersion(w, String(version))
    w.irun = tcCli(w, ['install', '--yes'])
    w.iInstallRun = w.irun
    expect(w.irun.status, w.irun.out).toBe(0)
  })

  reg.define(/^the settings file carries the idle-compaction key set to off$/, (w: InstallWorld) => {
    const raw = readFileSync(settingsFile(w), 'utf8')
    expect(settingsOnDisk(w)['idleCompaction'], raw).toBe(false)
    expect(raw.match(/"idleCompaction"/g)?.length, 'the key is there more than once').toBe(1)
  })

  reg.define(/^the settings file still carries the idle-compaction key set to (on|off)$/, (w: InstallWorld, value: unknown) => {
    const raw = readFileSync(settingsFile(w), 'utf8')
    expect(settingsOnDisk(w)['idleCompaction'], raw).toBe(value === 'on')
    expect(raw.match(/"idleCompaction"/g)?.length, 'the key is there more than once').toBe(1)
  })

  reg.define(/^the settings file has the idle-compaction key (written off|not written)$/, (w: InstallWorld, written: unknown) => {
    const data = settingsOnDisk(w)
    if (written === 'written off') {
      expect(data['idleCompaction'], JSON.stringify(data)).toBe(false)
    } else {
      expect(Object.hasOwn(data, 'idleCompaction'), JSON.stringify(data)).toBe(false)
    }
  })

  reg.define(/^the developer sees install say in one line that idle compaction was turned off, the reason, and that the client's \/config row turns it back on$/, (w: InstallWorld) => {
    const said = idleLines(w.iInstallRun!.stdout)
    expect(said, `install's output:\n${w.iInstallRun!.stdout}`).toHaveLength(1)
    expect(said[0]).toMatch(/turned off/)
    expect(said[0]).toMatch(/prompt-cache/)
    expect(said[0]).toMatch(/\/config row/)
    expect(said[0]).toMatch(/turns it back on/)
  })

  reg.define(/^the developer sees install say in one line that idle compaction was turned off$/, (w: InstallWorld) => {
    const said = idleLines(w.iInstallRun!.stdout)
    expect(said, `install's output:\n${w.iInstallRun!.stdout}`).toHaveLength(1)
    expect(said[0]).toMatch(/turned off/)
  })

  reg.define(/^the developer sees install say in one line that idle compaction was turned off, naming the settings line "idleCompaction": true as where to turn it back on, and no \/config row$/, (w: InstallWorld) => {
    // D338 at 2.1.295: the client honors the key and has no /config row, so
    // the one line names the settings line as the way back and no row the
    // client lacks.
    const said = idleLines(w.iInstallRun!.stdout)
    expect(said, `install's output:\n${w.iInstallRun!.stdout}`).toHaveLength(1)
    expect(said[0]).toMatch(/turned off/)
    // The settings line, as the user would type it, is the way back; and
    // no /config row stands anywhere in the line, a row this client lacks.
    // The needle is proved by the outline "install's way back on at
    // <version>" whose 2.1.302 row holds the /config remedy in this same
    // build's line (the review's mutation: the /config clause prepended
    // to the settings-line remedy, caught here and nowhere by a tail).
    expect(said[0]).toMatch(/; set "idleCompaction": true there to turn it back on$/)
    expect(said[0]).not.toContain('/config') // step-lint: allow unearned-absence -- the same outline's 2.1.302 row asserts the /config remedy positively on this build
  })

  reg.define(/^the developer sees install's one line name (the settings line "idleCompaction": true, no \/config row|the client's \/config row) as where to turn it back on$/, (w: InstallWorld, remedyOf: unknown) => {
    // D338 at the 2.1.302 boundary: below it the client honors the key with
    // no /config row, so the way back is the settings line; from it, the
    // client's /config row. The remedy ends install's one line, so an exact
    // tail leaves no room for the other remedy to stand in its slot.
    const said = idleLines(w.iInstallRun!.stdout)
    expect(said, `install's output:\n${w.iInstallRun!.stdout}`).toHaveLength(1)
    expect(said[0]).toMatch(/turned off/)
    const tail = String(remedyOf).startsWith('the settings line')
      ? '; set "idleCompaction": true there to turn it back on'
      : "; the client's /config row (Idle compaction) turns it back on"
    expect(said[0]!.endsWith(tail), `install's line: ${said[0]}\nexpected it to end: ${tail}`).toBe(true)
    // The line holds one remedy: the tail's own clause is its last "; ".
    expect(said[0]!.slice(said[0]!.lastIndexOf('; ')), said[0]).toBe(tail)
    // "no /config row": the settings-line row names the /config row nowhere
    // in the line (the review's mutation prepended it as an earlier clause,
    // which a tail check let through). The needle is proved by this same
    // step's 2.1.302 row, whose tail is the /config remedy.
    if (String(remedyOf).startsWith('the settings line')) {
      expect(said[0]).not.toContain('/config') // step-lint: allow unearned-absence -- this step's 2.1.302 row asserts the /config remedy positively
    }
  })

  reg.define(/^the developer sees doctor's row for idle compaction warn with the settings line only$/, (w: InstallWorld) => {
    // D338 at 2.1.295 with the key on: the warn row's remedy is the settings
    // line alone, never a /config row this client does not have.
    const row = idleRow(w.irun!.stdout)
    expect(row).toMatch(/^\[warn\]/)
    expect(row).toContain('treecontext recommends off')
    // The fix line is the settings line and nothing else: an exact match,
    // so a /config remedy this client lacks cannot stand beside it; and the
    // row's detail line names no /config row either. The needle is proved
    // by "doctor warns while idle compaction is on, naming the /config row
    // first", which asserts /config in this same row on this build.
    expect(row.split('\n')[1]?.trim(), row).toBe(`fix: set ${KEY_LINE} in ${settingsFile(w)}`)
    expect(row).not.toContain('/config') // step-lint: allow unearned-absence -- the /config-first doctor scenario asserts the needle positively in this row
  })

  reg.define(/^the developer sees install say nothing about having written it$/, (w: InstallWorld) => {
    // D361: for a key the user set, install says nothing at all, now or on
    // any later run (D290's sib: no fighting it on every reinstall).
    expect(idleLines(w.iInstallRun!.out), `install's output:\n${w.iInstallRun!.out}`).toEqual([])
  })

  reg.define(/^the developer sees install say the setting is (turned off|not applicable to this client)$/, (w: InstallWorld, saidOf: unknown) => {
    const said = String(saidOf)
    const lines = idleLines(w.iInstallRun!.stdout)
    expect(lines, `install's output:\n${w.iInstallRun!.stdout}`).toHaveLength(1)
    expect(lines[0]).toContain(said)
    // the other claim is not made beside it
    expect(lines[0]).not.toContain(said === 'turned off' ? 'not applicable' : 'turned off')
  })

  reg.define(/^the developer sees doctor's row for idle compaction warn that treecontext recommends off, with the client's \/config row first and the settings line second$/, (w: InstallWorld) => {
    const row = idleRow(w.irun!.stdout)
    expect(row).toMatch(/^\[warn\]/)
    expect(row).toContain('treecontext recommends off')
    const configAt = row.indexOf('/config')
    const lineAt = row.indexOf(KEY_LINE)
    expect(configAt, row).toBeGreaterThan(-1)
    expect(lineAt, row).toBeGreaterThan(-1)
    expect(configAt, row).toBeLessThan(lineAt)
  })

  reg.define(/^the developer sees doctor's row for idle compaction say (off|the setting is not read by this client, version .+)$/, (w: InstallWorld, rowOf: unknown) => {
    const row = String(rowOf)
    const line = idleRow(w.iDoctorRun!.stdout)
    const detail = line.replace(/^\[ok\]\s+Idle compaction: /, '')
    expect(line, `not an ok row:\n${line}`).toMatch(/^\[ok\]\s+Idle compaction: /)
    if (row === 'off') {
      // The row says off, and which file it speaks for (D361's finding 8: a
      // project, local or managed file can set the key too).
      expect(detail.startsWith(`off in ${settingsFile(w)} (only that file was read`), line).toBe(true)
    } else {
      expect(detail, line).toBe(row)
    }
  })

  // ── the README's install section (D290) ─────────────────────────────
  reg.define(/^the developer reads the README's install section$/, (w: InstallWorld) => {
    // Section 2, "Install": the section that gives the install command and
    // the one D276's tester reads (D361). Its subsections are part of it.
    const readme = readFileSync(join(TS_ROOT, 'README.md'), 'utf8').replace(/\r\n/g, '\n')
    const start = readme.indexOf('\n## 2. Install')
    expect(start, 'the README has no install section (## 2. Install)').toBeGreaterThan(-1)
    const rest = readme.slice(start + 1)
    const end = rest.slice(3).search(/^## /m)
    w.iInstallSection = end === -1 ? rest : rest.slice(0, end + 3)
  })

  reg.define(/^the developer reads that install turns Claude Code's idle compaction off, the reason, and where to turn it back on$/, (w: InstallWorld) => {
    const paragraphs = w.iInstallSection!.split(/\n\s*\n/).map(p => p.replace(/\s+/g, ' '))
    const about = paragraphs.filter(p => /idle compaction/i.test(p))
    expect(about, 'the install section says nothing about idle compaction').toHaveLength(1)
    const p = about[0]!
    expect(p, 'it does not say install turns it off').toMatch(/`treecontext install` also turns Claude Code's idle compaction off/)
    expect(p, 'it gives no reason').toMatch(/prompt cache/i)
    expect(p, 'it does not name the /config row').toMatch(/`\/config`/)
    expect(p, 'it does not name the settings line').toContain('"idleCompaction": true')
  })
  // ── a reinstall converges what install owns (D385) ──────────────────
  //
  // A real install into a sandbox home, then the entry rewritten in an
  // earlier build's shape with the developer's additions, then a real
  // reinstall. The other side is the client's own reading of its
  // configuration: `codex mcp get treecontext` (with and without --json:
  // the JSON form prints the forwarded variables and the enabled tools, the
  // plain form the default approval) and `claude mcp get treecontext` (its
  // command, arguments and environment block). Every addition in the table
  // is printed by the client itself, so nothing here rests on a read-back
  // of our own file. The command each client prints is the launcher under
  // the sandbox home, which proves it read the sandbox's file.
  const EARLIER: Record<string, { stale: string; additions: string; args: string[]; keys: Record<string, unknown> }> = {
    'Codex CLI|lacking the worker variables': {
      stale: 'no env_vars',
      additions: 'a pinned store, `--instructions none`, a default approval and a list of enabled tools',
      args: ['--store', 'pinned-store', '--instructions', 'none'],
      keys: { default_tools_approval_mode: 'approve', enabled_tools: ['treecontext_status', 'treecontext_query', 'treecontext_export', 'treecontext_insert'] },
    },
    'Codex CLI|starting the server in capture mode': {
      stale: '--capture --debug',
      additions: 'a pinned store and a policy flag',
      args: ['--store', 'pinned-store', '--policy', 'contributor'],
      keys: {},
    },
    'Claude Code|naming an interpreter that no longer exists': {
      stale: 'a version-stamped node that is gone',
      additions: 'a pinned store and an environment block',
      args: ['--store', 'pinned-store'],
      keys: { env: { TREECONTEXT_DEV_NOTE: 'kept-by-the-developer' } },
    },
  }

  reg.define(/^a (Claude Code|Codex CLI) entry written by an earlier build, (lacking the worker variables|starting the server in capture mode|naming an interpreter that no longer exists), to which the developer has added (.+)$/,
    async (w: InstallWorld, agent: unknown, stale: unknown, additions: unknown) => {
      const row = EARLIER[`${String(agent)}|${String(stale)}`]
      expect(row, `no earlier-build shape for ${String(agent)}, ${String(stale)}`).toBeDefined()
      expect(String(additions)).toBe(row!.additions)
      w.iClient = agent as 'Claude Code' | 'Codex CLI'
      await openInstallWorld(w, w.iClient === 'Codex CLI' ? ['.claude', '.codex'] : ['.claude'])
      w.iproj = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-install-proj-')))
      w.defer(() => rmSync(w.iproj!, { recursive: true, force: true }))
      // This build's own entry first: it is the oracle for what this build
      // writes, and the launcher an earlier build would have left exists.
      expect(tcCli(w, ['install', '--yes']).status).toBe(0)
      w.iDeveloperArgs = row!.args
      w.iDeveloperKeys = row!.keys
      if (w.iClient === 'Codex CLI') {
        const path = agentConfigPath('codex', w.ihome!)
        const toml = parseToml(readFileSync(path, 'utf8')) as Record<string, Record<string, Record<string, unknown>>>
        const canonical = toml['mcp_servers']!['treecontext']!
        w.iCanonicalEntry = JSON.stringify(canonical)
        // The shape the beta.2 and beta.3 builds wrote: the server in
        // capture mode for every client, with or without the variables.
        const earlier: Record<string, unknown> = {
          command: canonical['command'],
          args: ['serve', '--transport', 'stdio', '--capture', '--debug', '--lexical', ...row!.args],
          ...(stale === 'lacking the worker variables' ? {} : { env_vars: canonical['env_vars'] }),
          ...row!.keys,
        }
        toml['mcp_servers']!['treecontext'] = earlier
        writeFileSync(path, stringifyToml(toml) + '\n')
      } else {
        const path = join(w.ihome!, '.claude.json')
        const cfg = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, Record<string, unknown>>>
        const canonical = cfg['mcpServers']!['treecontext']!
        w.iCanonicalEntry = JSON.stringify(canonical)
        // The pre-launcher shape: a version-stamped interpreter and the
        // package's module under it, both since removed by a node upgrade.
        const gone = join(w.ihome!, '.nvm', 'versions', 'node', 'v22.0.0')
        cfg['mcpServers']!['treecontext'] = {
          command: join(gone, 'bin', 'node'),
          args: [join(gone, 'lib', 'node_modules', 'treecontext-mcp', 'dist', 'server', 'cli.js'), 'serve', '--transport', 'stdio', '--capture', '--debug', '--lexical', ...row!.args],
          ...row!.keys,
        }
        writeFileSync(path, JSON.stringify(cfg, null, 2))
      }
      // The client reads the earlier shape before the reinstall, or the
      // scenario starts from something it never saw.
      const before = clientEntry(w, w.iClient)
      expect(before.args.slice(-row!.args.length)).toEqual(row!.args)
      if (stale === 'lacking the worker variables') expect(before.envNames).toEqual([])
      if (stale === 'starting the server in capture mode') expect(before.args).toContain('--capture')
      if (stale === 'naming an interpreter that no longer exists') expect(existsSync(before.command)).toBe(false)
    })

  reg.define(/^the entry carries the command and arguments this build writes for (Claude Code|Codex CLI)$/, (w: InstallWorld, agent: unknown) => {
    const canonical = JSON.parse(w.iCanonicalEntry!) as { command: string; args: string[]; env_vars?: string[] }
    const seen = clientEntry(w, agent as 'Claude Code' | 'Codex CLI')
    expect(seen.command, seen.printed).toBe(mcpLauncherIn(w.ihome!))
    expect(seen.command).toBe(canonical.command)
    // This build's arguments, then the developer's: the stale capture and
    // debug flags of a Codex entry are gone, nothing is doubled.
    expect(seen.args, seen.printed).toEqual([...canonical.args, ...w.iDeveloperArgs!])
    if (agent === 'Codex CLI') {
      expect(canonical.env_vars, 'this build writes the worker variables for Codex').toEqual(['TREECONTEXT_TICKET', 'TREECONTEXT_WORKER_SESSION'])
      expect(seen.envNames, seen.printed).toEqual(expect.arrayContaining(canonical.env_vars!))
    }
  })

  reg.define(/^(a pinned store.*) read as the developer left them$/, (w: InstallWorld, additions: unknown) => {
    const row = Object.values(EARLIER).find(r => r.additions === String(additions))
    expect(row, `no row adds ${String(additions)}`).toBeDefined()
    const seen = clientEntry(w, w.iClient as 'Claude Code' | 'Codex CLI')
    const items = (a: string[]): string[] => a.flatMap((t, i) => (t.startsWith('--') && a[i + 1] !== undefined && !a[i + 1]!.startsWith('--') ? [`${t} ${a[i + 1]}`] : []))
    for (const pair of items(row!.args)) {
      expect(items(seen.args), `the reinstall lost the developer's ${pair}:\n${seen.printed}`).toContain(pair)
    }
    const keys = row!.keys
    if ('default_tools_approval_mode' in keys) {
      expect(seen.printed, 'Codex no longer reads the default approval').toMatch(new RegExp(`^\\s*default_tools_approval_mode: ${String(keys['default_tools_approval_mode'])}$`, 'm'))
    }
    if ('enabled_tools' in keys) {
      expect(seen.json?.['enabled_tools'], 'Codex no longer reads the enabled tools').toEqual(keys['enabled_tools'])
    }
    if ('env' in keys) {
      for (const [k, v] of Object.entries(keys['env'] as Record<string, string>)) {
        expect(seen.printed, `Claude Code no longer reads ${k} in the environment block`).toContain(`${k}=${v}`)
      }
    }
    // Install said so: the entry is reported updated, keeping each addition.
    const line = w.irun!.stdout.split('\n').find(l => /^\s+mcp: .*\[updated — kept your /.test(l))
    expect(line, `install did not report the developer's additions as kept:\n${w.irun!.stdout}`).toBeDefined()
    for (const pair of items(row!.args)) expect(line).toContain(pair)
    for (const k of Object.keys(keys)) expect(line).toContain(k)
  })

  // ── capture mode only where the capture hooks are installed (D386) ──
  //
  // The other side is the server itself: the entry's command and arguments,
  // as the client reads them, started as the client starts them
  // (startEntryAsClient), and the `Mode:` line that server writes. Then
  // doctor's row for the client, off doctor's own stdout. Antigravity CLI
  // (D383) is the real `agy` on the CLI's PATH, and the entry it starts is
  // the one its own `agy mcp list` prints.
  /** The treecontext entry as Antigravity CLI itself lists it: `agy mcp list`'s command column, split as agy splits it. */
  const agyEntry = (w: InstallWorld): ClientEntry => {
    const { servers, run } = agyMcpList(w)
    const row = servers.find(s => s.name === 'treecontext')
    expect(row, `agy lists no treecontext server:\n${run.out}`).toBeDefined()
    expect(row!.status, `agy lists the treecontext server ${row!.status}`).toBe('enabled')
    const [command, ...args] = row!.command.split(/\s+/)
    return { command: command!, args, envNames: [], printed: run.stdout }
  }
  reg.define(/^(Claude Code|Codex CLI|Antigravity CLI) is installed$/, async (w: InstallWorld, agent: unknown) => {
    w.iClient = agent as 'Claude Code' | 'Codex CLI' | 'Antigravity CLI'
    await openInstallWorld(w, w.iClient === 'Codex CLI' ? ['.claude', '.codex'] : ['.claude'])
    if (w.iClient === 'Antigravity CLI') putAgyOnPath(w)
    w.iproj = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-install-proj-')))
    w.defer(() => rmSync(w.iproj!, { recursive: true, force: true }))
  })

  reg.define(/^install runs (as usual|without the experimental flag|with the experimental flag naming Codex CLI)$/, (w: InstallWorld, how: unknown) => {
    const args = how === 'with the experimental flag naming Codex CLI'
      ? ['install', '--yes', '--agent', 'codex', '--experimental-capture']
      : ['install', '--yes']
    w.irun = tcCli(w, args)
    expect(w.irun.status, w.irun.out).toBe(0)
  })

  reg.define(/^the server that (Claude Code|Codex CLI|Antigravity CLI)'s entry starts runs (in capture mode|without capture)$/, async (w: InstallWorld, agent: unknown, mode: unknown) => {
    const seen = agent === 'Antigravity CLI' ? agyEntry(w) : clientEntry(w, agent as 'Claude Code' | 'Codex CLI')
    expect(seen.command, seen.printed).toBe(mcpLauncherIn(w.ihome!))
    w.iServerMode = await startEntryAsClient(w.ihome!, seen, w.iproj!)
    expect(w.iServerMode, `the server ${String(agent)}'s entry starts (args: ${seen.args.join(' ')})`)
      .toBe(mode === 'in capture mode' ? 'conversation-indexer' : 'standard')
  })

  reg.define(/^doctor's row for (Claude Code|Codex CLI|Antigravity CLI) reads its mode as correct$/, (w: InstallWorld, agent: unknown) => {
    const doctor = tcCli(w, ['doctor'])
    const lines = doctor.stdout.split('\n')
    const i = lines.findIndex(l => new RegExp(`^\\[\\w+\\]\\s+${String(agent)}:`).test(l))
    expect(i, `doctor printed no ${String(agent)} row:\n${doctor.stdout}`).toBeGreaterThanOrEqual(0)
    const row = lines[i]!
    // The mode doctor names is the one the server ran in, and the clause
    // ends there: a mode that disagrees with the hooks carries its finding
    // inside the clause, before the comma, and the row warns.
    const clause = agent === 'Claude Code'
      ? 'mode: capture'
      : w.iServerMode === 'conversation-indexer'
        ? 'server mode: capture (this client: its own hooks)'
        : 'server mode: standard (no auto-capture) (this client: tools only)'
    expect(row, row).toContain(`: MCP configured, ${clause}, `)
    expect(row, `doctor warns on ${String(agent)}'s row:\n${row}\n${lines[i + 1] ?? ''}`).toMatch(/^\[ok\]/)
    const indexer = lines.find(l => /Conversation indexer:/.test(l))
    expect(indexer, doctor.stdout).toMatch(/^\[ok\]/)
  })

  // ── tool approvals: Codex per tool, Claude Code's grant, the way back
  //    (D381, D390) ───────────────────────────────────────────────────
  //
  // The other side for Codex is Codex itself: its app server's own reading
  // of the whole configuration (`config/read`, the request every Codex front
  // end makes for its settings, no model call), which carries each tool's
  // approval and the file each key came from; `codex mcp get --json` does
  // not print the approvals, so it is not asked for them. Claude Code has no
  // command that prints its permission rules outside its interactive
  // /permissions, so its view is read from the settings file it reads,
  // ~/.claude/settings.json, and the binding says so at each read; that the
  // client honours the rules is the dogfood's (D390, unit 2). Antigravity
  // CLI (D383) is read the same way: agy prints no permission rules (it has
  // no command that lists them outside its interactive /permissions), so
  // its rules are read from the settings file it reads,
  // ~/.gemini/antigravity-cli/settings.json, and the binding says so at each
  // read; its MCP entry is read from its own `agy mcp list`.
  const codexToolsSeen = async (w: InstallWorld): Promise<{ tools: Record<string, { approval_mode?: unknown }>; entry: Record<string, unknown>; origins: Record<string, { name?: { type?: string; file?: string } }> }> => {
    const read = await codexConfigRead(w)
    expect(read.error, `Codex refused its configuration:\n${read.raw}`).toBeUndefined()
    const servers = (read.config?.['mcp_servers'] ?? {}) as Record<string, Record<string, unknown>>
    const entry = servers['treecontext']
    expect(entry, `Codex reads no treecontext server:\n${read.raw}`).toBeDefined()
    return { tools: (entry!['tools'] ?? {}) as Record<string, { approval_mode?: unknown }>, entry: entry!, origins: read.origins ?? {} }
  }
  const FOUR = ['treecontext_status', 'treecontext_query', 'treecontext_export', 'treecontext_insert']
  const ASKING = ['treecontext_clear', 'treecontext_delete', 'treecontext_import', 'treecontext_merge_from_agent']
  const codexConfigFile = (w: InstallWorld): string => agentConfigPath('codex', w.ihome!)
  /** Claude Code's permission rules, read from the settings file it reads (it prints none of its own). */
  const claudePermissions = (w: InstallWorld): Record<string, unknown[]> =>
    ((settingsOnDisk(w)['permissions'] ?? {}) as Record<string, unknown[]>)
  const agySettingsFile = (w: InstallWorld): string => join(w.ihome!, '.gemini', 'antigravity-cli', 'settings.json')
  const agySettings = (w: InstallWorld): Record<string, unknown> =>
    existsSync(agySettingsFile(w)) ? JSON.parse(readFileSync(agySettingsFile(w), 'utf8')) as Record<string, unknown> : {}
  /** agy's permission rules, read from the settings file it reads (it prints none of its own). */
  const agyPermissions = (w: InstallWorld): Record<string, unknown[]> =>
    ((agySettings(w)['permissions'] ?? {}) as Record<string, unknown[]>)
  const installRecord = (w: InstallWorld): { toolApprovals?: { written?: Record<string, Record<string, { items: string[] }>>; off?: Record<string, unknown> } } => {
    const p = join(w.ihome!, '.treecontext', 'install-state.json')
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) as ReturnType<typeof installRecord> : {}
  }

  reg.define(/^Codex CLI is installed at a version that reads per-tool approvals$/, async (w: InstallWorld) => {
    await openInstallWorld(w, ['.claude', '.codex'])
    w.iproj = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-install-proj-')))
    w.defer(() => rmSync(w.iproj!, { recursive: true, force: true }))
    // The real Codex, read by its own --version, at or past the first
    // version verified to read per-tool approvals.
    const v = codexCli(w, ['--version'])
    expect(v.status, v.out).toBe(0)
    const version = /(\d+)\.(\d+)\.(\d+)/.exec(v.stdout)
    expect(version, `codex --version printed no version:\n${v.out}`).not.toBeNull()
    const [maj, min, pat] = CODEX_APPROVALS_FLOOR.split('.').map(Number) as [number, number, number]
    const have = [Number(version![1]), Number(version![2]), Number(version![3])]
    expect(have[0]! * 1e6 + have[1]! * 1e3 + have[2]!, `Codex ${version![0]} is older than ${CODEX_APPROVALS_FLOOR}`).toBeGreaterThanOrEqual(maj * 1e6 + min * 1e3 + pat)
  })

  reg.define(/^Codex's own reading of its configuration shows the treecontext server with status, query, export and insert approved$/, async (w: InstallWorld) => {
    expect(w.irun!.status, w.irun!.out).toBe(0)
    const seen = await codexToolsSeen(w)
    for (const tool of FOUR) {
      expect(seen.tools[tool]?.approval_mode, `Codex reads no approval for ${tool}`).toBe('approve')
      // From the user's configuration file install wrote, not a default.
      expect(seen.origins[`mcp_servers.treecontext.tools.${tool}.approval_mode`]?.name, `where Codex read ${tool}'s approval`).toEqual(expect.objectContaining({ type: 'user', file: codexConfigFile(w) }))
    }
    // One by one, never a default for the whole server (D381).
    expect(seen.entry['default_tools_approval_mode'] ?? null, 'install wrote a default approval for the whole server').toBeNull()
  })

  reg.define(/^it shows clear, delete, import and merge with no approval install wrote$/, async (w: InstallWorld) => {
    const seen = await codexToolsSeen(w)
    // The needle fires: Codex does show the approvals install wrote.
    expect(Object.keys(seen.tools).length).toBeGreaterThan(0)
    for (const tool of ASKING) {
      expect(seen.tools[tool]?.approval_mode, `Codex reads an approval for ${tool}`).toBeUndefined()
    }
    expect(seen.entry['default_tools_approval_mode'] ?? null).toBeNull()
    // And install's own record names none of them.
    const written = Object.values(installRecord(w).toolApprovals?.written?.['codex'] ?? {}).flatMap(f => f.items)
    expect(written.sort()).toEqual([...FOUR].sort())
  })

  reg.define(/^Codex reads its whole configuration without refusing it$/, (w: InstallWorld) => {
    // An approval Codex cannot read makes it refuse the whole file
    // ("unknown variant"), so its own listing is the check.
    const listed = codexCli(w, ['mcp', 'list'])
    expect(listed.status, `codex refused its configuration:\n${listed.out}`).toBe(0)
    expect(listed.stdout).toMatch(/^treecontext\s/m)
  })

  reg.define(/^a Codex CLI whose treecontext entry carries the developer's approval for (treecontext_\w+) set to (\w+)$/, async (w: InstallWorld, tool: unknown, value: unknown) => {
    await openInstallWorld(w, ['.claude', '.codex'])
    w.iproj = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-install-proj-')))
    w.defer(() => rmSync(w.iproj!, { recursive: true, force: true }))
    expect(tcCli(w, ['install', '--yes']).status).toBe(0)
    // The developer sets the tool's approval in the entry install wrote:
    // over install's own for one of the four, beside it for another tool.
    const path = codexConfigFile(w)
    const toml = parseToml(readFileSync(path, 'utf8')) as Record<string, Record<string, Record<string, unknown>>>
    const entry = toml['mcp_servers']!['treecontext']!
    const tools = (entry['tools'] ?? {}) as Record<string, Record<string, unknown>>
    tools[String(tool)] = { ...tools[String(tool)], approval_mode: String(value) }
    entry['tools'] = tools
    writeFileSync(path, stringifyToml(toml) + '\n')
    const seen = await codexToolsSeen(w)
    expect(seen.tools[String(tool)]?.approval_mode).toBe(String(value))
    w.iDeveloperBefore = JSON.stringify({ tool, value })
  })

  reg.define(/^the approval for (treecontext_\w+) still reads (\w+)$/, async (w: InstallWorld, tool: unknown, value: unknown) => {
    expect(w.irun!.status, w.irun!.out).toBe(0)
    const seen = await codexToolsSeen(w)
    expect(seen.tools[String(tool)]?.approval_mode, `Codex's reading of ${String(tool)}'s approval after install`).toBe(String(value))
    expect(seen.origins[`mcp_servers.treecontext.tools.${String(tool)}.approval_mode`]?.name?.file).toBe(codexConfigFile(w))
    // The other three of the four stay install's.
    for (const t of FOUR.filter(t => t !== tool)) expect(seen.tools[t]?.approval_mode).toBe('approve')
  })

  reg.define(/^install says nothing about having written it$/, (w: InstallWorld) => {
    const { tool } = JSON.parse(w.iDeveloperBefore!) as { tool: string }
    const short = tool.replace(/^treecontext_/, '').replace(/_from_agent$/, '')
    const lines = w.irun!.stdout.split('\n')
    // Every approvals line install printed, its per-agent line and its
    // message: none names the tool as approved by it.
    const approvals = lines.filter(l => /tool approvals|approved/.test(l))
    expect(approvals.length, `install printed nothing about approvals:\n${w.irun!.stdout}`).toBeGreaterThan(0)
    for (const l of approvals) {
      const said = /\b(?:would approve|approved) ([^;\]]*)/.exec(l)?.[1] ?? ''
      const listed = /^\s*Codex CLI: ([^(]*) (?:would be )?approved/.exec(l)?.[1] ?? ''
      expect(said, `install claims it approved ${tool}: ${l}`).not.toMatch(new RegExp(`\\b${tool}\\b`))
      expect(listed, `install's message names ${short} as approved: ${l}`).not.toMatch(new RegExp(`\\b${short}\\b`))
    }
  })

  // ── a Codex older than the floor gets none (D381) ───────────────────
  //
  // [stand-in] for the old Codex: a `codex` on the CLI's PATH answering
  // `codex-cli 0.165.0` (writeFakeCodex, standins.ts), below the oldest
  // Codex verified to read per-tool approvals. What the file then holds is
  // read by the real Codex's own reading of its configuration.
  reg.define(/^a Codex CLI whose version reads older than the first that reads per-tool approvals$/, async (w: InstallWorld) => {
    await openInstallWorld(w, ['.claude', '.codex'])
    w.iproj = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-install-proj-')))
    w.defer(() => rmSync(w.iproj!, { recursive: true, force: true }))
    expect(CODEX_APPROVALS_FLOOR).toBe('0.166.0')
    setFakeCodex(w, { version: '0.165.0', sandbox: { exit: 0, stderr: '' } })
  })

  reg.define(/^Codex's configuration carries no per-tool approval$/, async (w: InstallWorld) => {
    const seen = await codexToolsSeen(w)
    // The entry is there, its server named: the install wired it.
    expect(seen.entry['command'], 'install wrote no treecontext entry').toBeDefined()
    expect(seen.tools, 'Codex reads a per-tool approval').toEqual({})
    expect(seen.entry['default_tools_approval_mode'] ?? null).toBeNull()
  })

  const FLOOR_LINE = new RegExp(`Codex 0\\.165\\.0 cannot read per-tool approvals: its headless workers need Codex ${CODEX_APPROVALS_FLOOR.replace(/\./g, '\\.')} or newer for the tools`)
  reg.define(/^the developer sees install say in one line that Codex's headless workers need a newer Codex for the tools, naming the version$/, (w: InstallWorld) => {
    const lines = w.iInstallRun!.stdout.split('\n').filter(l => /per-tool approval/.test(l))
    expect(lines, w.iInstallRun!.stdout).toHaveLength(1)
    expect(lines[0]).toMatch(FLOOR_LINE)
  })

  reg.define(/^the developer sees doctor's row for Codex CLI say the same$/, (w: InstallWorld) => {
    const row = w.iDoctorRun!.stdout.split('\n').find(l => /^\[(ok|warn|err)\]\s+Codex CLI:/.test(l))
    expect(row, w.iDoctorRun!.stdout).toBeDefined()
    expect(row).toMatch(/^\[warn\]/)
    expect(row).toMatch(FLOOR_LINE)
  })

  // ── off and on again, per client (D390) ─────────────────────────────
  const DEV_RULE: Record<string, { client: 'Claude Code' | 'Codex CLI' | 'Antigravity CLI'; tool: string }> = {
    'an ask rule for treecontext_insert': { client: 'Claude Code', tool: 'treecontext_insert' },
    'an approval set to prompt for treecontext_query': { client: 'Codex CLI', tool: 'treecontext_query' },
    'a deny rule for treecontext_export': { client: 'Antigravity CLI', tool: 'treecontext_export' },
  }
  /** The client's view of the four and of the developer's rule. */
  const viewOf = async (w: InstallWorld): Promise<{ approvedByInstall: string[]; developerRule: string; grantForRuled: boolean }> => {
    // Install's grants are what its record names and the client's file
    // still holds.
    const recorded = (slug: string): string[] => Object.values(installRecord(w).toolApprovals?.written?.[slug] ?? {}).flatMap(f => f.items)
    if (w.iClient === 'Antigravity CLI') {
      // agy prints no permission rules: the settings file it reads is read.
      const perms = agyPermissions(w)
      const allow = (perms['allow'] ?? []) as string[]
      const ours = recorded('agy')
      const { tool } = Object.values(DEV_RULE).find(r => r.client === 'Antigravity CLI')!
      return {
        approvedByInstall: FOUR.filter(t => allow.includes(`mcp(treecontext/${t})`) && ours.includes(`mcp(treecontext/${t})`)),
        developerRule: JSON.stringify(perms['deny'] ?? null),
        grantForRuled: allow.includes(`mcp(treecontext/${tool})`) || ours.includes(`mcp(treecontext/${tool})`),
      }
    }
    if (w.iClient === 'Claude Code') {
      // Claude Code prints no permission rules: its settings file is read.
      const perms = claudePermissions(w)
      const allow = (perms['allow'] ?? []) as string[]
      const ours = recorded('claude')
      const { tool } = Object.values(DEV_RULE).find(r => r.client === 'Claude Code')!
      const rule = `mcp__treecontext__${tool}`
      return {
        approvedByInstall: FOUR.filter(t => allow.includes(`mcp__treecontext__${t}`) && ours.includes(`mcp__treecontext__${t}`)),
        developerRule: JSON.stringify(perms['ask'] ?? null),
        grantForRuled: allow.includes(rule) || ours.includes(rule),
      }
    }
    const seen = await codexToolsSeen(w)
    const ours = recorded('codex')
    const { tool } = Object.values(DEV_RULE).find(r => r.client === 'Codex CLI')!
    return {
      approvedByInstall: FOUR.filter(t => t !== tool && seen.tools[t]?.approval_mode === 'approve' && ours.includes(t)),
      developerRule: JSON.stringify(seen.tools[tool] ?? null),
      grantForRuled: ours.includes(tool),
    }
  }

  reg.define(/^(Claude Code|Codex CLI|Antigravity CLI) wired by install, with the developer's own rule (an ask rule for treecontext_insert|an approval set to prompt for treecontext_query|a deny rule for treecontext_export) beside install's grants$/, async (w: InstallWorld, client: unknown, rule: unknown) => {
    const row = DEV_RULE[String(rule)]!
    expect(row.client).toBe(client)
    w.iClient = row.client
    await openInstallWorld(w, w.iClient === 'Codex CLI' ? ['.claude', '.codex'] : ['.claude'])
    if (w.iClient === 'Antigravity CLI') putAgyOnPath(w)
    w.iproj = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-install-proj-')))
    w.defer(() => rmSync(w.iproj!, { recursive: true, force: true }))
    const install = tcCli(w, ['install', '--yes'])
    expect(install.status, install.out).toBe(0)
    // Install's grants, then the developer's rule beside them, written the
    // way the developer writes it, in the client's own file.
    if (w.iClient === 'Antigravity CLI') {
      const settings = agySettings(w)
      const perms = (settings['permissions'] ?? {}) as Record<string, unknown>
      expect(perms['allow'], 'install wrote no grant').toEqual(FOUR.map(t => `mcp(treecontext/${t})`))
      writeFileSync(agySettingsFile(w), JSON.stringify({ ...settings, permissions: { ...perms, deny: [`mcp(treecontext/${row.tool})`] } }, null, 2) + '\n')
    } else if (w.iClient === 'Claude Code') {
      const settings = settingsOnDisk(w)
      const perms = (settings['permissions'] ?? {}) as Record<string, unknown>
      expect(perms['allow'], 'install wrote no grant').toEqual(FOUR.map(t => `mcp__treecontext__${t}`))
      writeFileSync(settingsFile(w), JSON.stringify({ ...settings, permissions: { ...perms, ask: [`mcp__treecontext__${row.tool}`] } }, null, 2) + '\n')
    } else {
      const path = codexConfigFile(w)
      const toml = parseToml(readFileSync(path, 'utf8')) as Record<string, Record<string, Record<string, Record<string, Record<string, unknown>>>>>
      const tools = toml['mcp_servers']!['treecontext']!['tools']!
      expect(Object.keys(tools).sort(), 'install wrote no grant').toEqual([...FOUR].sort())
      tools[row.tool] = { approval_mode: 'prompt' }
      writeFileSync(path, stringifyToml(toml) + '\n')
    }
    const view = await viewOf(w)
    w.iDeveloperBefore = view.developerRule
    expect(w.iDeveloperBefore).toMatch(w.iClient === 'Claude Code' ? /mcp__treecontext__treecontext_insert/ : w.iClient === 'Antigravity CLI' ? /mcp\(treecontext\/treecontext_export\)/ : /"approval_mode":"prompt"/)
    w.iAfterInstall = JSON.stringify(view.approvedByInstall)
    expect(view.approvedByInstall.length, 'install approved none of the four').toBeGreaterThan(0)
  })

  reg.define(/^the developer runs `treecontext config tool-approvals (off|on)`$/, (w: InstallWorld, value: unknown) => {
    w.irun = tcCli(w, ['config', 'tool-approvals', String(value)])
    expect(w.irun.status, w.irun.out).toBe(0)
  })

  reg.define(/^the developer sees it say that headless workers will now be refused the four tools, and how to turn them back on$/, (w: InstallWorld) => {
    const out = w.irun!.stdout
    expect(out).toMatch(/^tool approvals: off for /m)
    expect(out).toMatch(/headless workers will now be refused status, query, export and insert\b/)
    expect(out).toMatch(/to turn them back on: treecontext config tool-approvals on$/m)
  })

  reg.define(/^(Claude Code|Codex CLI|Antigravity CLI)'s own view shows none of the four approved by install, and the developer's rule as it was$/, async (w: InstallWorld, client: unknown) => {
    expect(client).toBe(w.iClient)
    const view = await viewOf(w)
    expect(view.approvedByInstall, `${String(client)} still approves`).toEqual([])
    expect(view.developerRule, "the developer's rule").toBe(w.iDeveloperBefore)
  })

  reg.define(/^(Claude Code|Codex CLI|Antigravity CLI)'s own view shows install's grants back for each of the four that no rule of the developer's decides, and the developer's rule as it was$/, async (w: InstallWorld, client: unknown) => {
    expect(client).toBe(w.iClient)
    // Install's grants are back for each of the four no rule of the
    // developer's decides, and for none other: install adds no grant beside
    // the developer's rule (D390), which reads as the developer left it.
    const view = await viewOf(w)
    const { tool } = Object.values(DEV_RULE).find(r => r.client === w.iClient)!
    expect(view.approvedByInstall, `${String(client)}'s approvals after on`).toEqual(FOUR.filter(t => t !== tool))
    expect(view.grantForRuled, `install wrote a grant beside the developer's rule for ${tool}`).toBe(false)
    expect(view.developerRule, "the developer's rule").toBe(w.iDeveloperBefore)
    expect(w.irun!.stdout).toMatch(/^headless workers can use .+; clear, delete, import and merge still ask/m)
  })

  // ── Claude Code's grant beside the developer's rules (D390, D51) ────
  reg.define(/^Claude Code's settings holding the developer's allow rule for another server's tool and deny rule for treecontext_delete$/, async (w: InstallWorld) => {
    await openInstallWorld(w, ['.claude'])
    w.iClient = 'Claude Code'
    const theirs = { model: 'opus', permissions: { allow: ['mcp__github__get_issue'], deny: ['mcp__treecontext__treecontext_delete'] } }
    writeFileSync(settingsFile(w), JSON.stringify(theirs, null, 2) + '\n')
    w.iDeveloperBefore = JSON.stringify(theirs.permissions)
  })

  reg.define(/^install runs and then uninstall runs$/, (w: InstallWorld) => {
    const install = tcCli(w, ['install', '--yes'])
    expect(install.status, install.out).toBe(0)
    // Neither Claude Code nor agy prints its permission rules: the file it
    // reads is read.
    w.iAfterInstall = JSON.stringify(w.iClient === 'Antigravity CLI' ? agyPermissions(w) : claudePermissions(w))
    const uninstall = tcCli(w, ['uninstall', '--yes'])
    expect(uninstall.status, uninstall.out).toBe(0)
    w.irun = uninstall
  })

  reg.define(/^after install the settings allow the four treecontext tools, and the developer's two rules read as they were$/, (w: InstallWorld) => {
    const before = JSON.parse(w.iDeveloperBefore!) as { allow: string[]; deny: string[] }
    const after = JSON.parse(w.iAfterInstall!) as { allow: string[]; deny: string[] }
    expect(after.allow).toEqual([...before.allow, ...FOUR.map(t => `mcp__treecontext__${t}`)])
    expect(after.deny).toEqual(before.deny)
  })

  reg.define(/^after uninstall the four rules install added are gone and the developer's two remain$/, (w: InstallWorld) => {
    expect(JSON.stringify(claudePermissions(w))).toBe(w.iDeveloperBefore)
    expect(settingsOnDisk(w)['model']).toBe('opus')
    expect(w.irun!.stdout).toMatch(/tool approvals install wrote \(.*\) removed from /)
  })

  // ── Antigravity CLI, a tools-only client (D383, D390) ───────────────
  //
  // A real install under a redirected HOME with the real `agy` on the CLI's
  // PATH (putAgyOnPath; the machine's own is hidden from every child). The
  // other side for the MCP entry is agy's own `agy mcp list`, which reads
  // the redirected HOME and calls no model. agy has no command that prints
  // its permission rules outside its interactive /permissions, so the rules
  // are read from the file it reads, ~/.gemini/antigravity-cli/settings.json;
  // that `agy -p` honours them is the paid dogfood's (unit 3), as for
  // Claude Code (unit 2).
  const agyRule = (t: string): string => `mcp(treecontext/${t})`
  /** agy's own directories under ~/.gemini, as agy leaves them, with a settings key of its own. */
  const seedAgyHome = (w: InstallWorld, settings: Record<string, unknown> = { trustedWorkspaces: ['/srv/work'] }): void => {
    mkdirSync(join(w.ihome!, '.gemini', 'config', 'projects'), { recursive: true })
    mkdirSync(dirname(agySettingsFile(w)), { recursive: true })
    writeFileSync(agySettingsFile(w), JSON.stringify(settings, null, 2) + '\n')
  }
  /** Every rule in agy's settings that names a treecontext tool or the whole server, in any list. */
  const agyTreecontextRules = (w: InstallWorld): string[] => {
    const perms = agyPermissions(w)
    return ['allow', 'ask', 'deny'].flatMap(l => ((perms[l] ?? []) as unknown[]).map(String))
      .filter(r => /treecontext|^mcp\(\*\)$/.test(r))
  }
  /** The four files agy reads global rules from (D383). */
  const agyRuleFiles = (w: InstallWorld): string[] => [
    join(w.ihome!, '.gemini', 'GEMINI.md'), join(w.ihome!, '.gemini', 'AGENTS.md'),
    join(w.ihome!, '.gemini', 'config', 'GEMINI.md'), join(w.ihome!, '.gemini', 'config', 'AGENTS.md'),
  ]


  reg.define(/^Antigravity CLI's own listing of its MCP servers reports the treecontext server$/, (w: InstallWorld) => {
    expect(w.irun!.status, w.irun!.out).toBe(0)
    expect(w.irun!.stdout).toMatch(/^Detected agents: .*Antigravity CLI/m)
    const seen = agyEntry(w)
    // The server this build writes for agy: the launcher, `serve` over
    // stdio, in capture mode exactly where treecontext's named hook is in
    // agy's hooks file (D386, D413).
    expect(seen.command).toBe(mcpLauncherIn(w.ihome!))
    const hooks = join(w.ihome!, '.gemini', 'config', 'hooks.json')
    const named = existsSync(hooks) && (JSON.parse(readFileSync(hooks, 'utf8')) as Record<string, unknown>)[AGY_HOOK_NAME] !== undefined
    expect(seen.args.slice(0, 4)).toEqual(['serve', '--transport', 'stdio', named ? '--capture' : '--no-capture'])
  })

  reg.define(/^its permission settings allow status, query, export and insert of the treecontext server, and no other treecontext tool$/, (w: InstallWorld) => {
    // agy prints no permission rules: the file it reads is read.
    const perms = agyPermissions(w)
    expect(perms['allow'], 'the four allow rules').toEqual(FOUR.map(agyRule))
    // No rule for the four that keep asking, and none for the whole server.
    expect(agyTreecontextRules(w).sort()).toEqual(FOUR.map(agyRule).sort())
    for (const t of ASKING) expect(JSON.stringify(perms)).not.toContain(t)
    // agy's own key, which install does not know, stays as agy left it.
    expect(agySettings(w)['trustedWorkspaces']).toEqual(['/srv/work'])
    // And install's record names exactly the four, in that file.
    expect(installRecord(w).toolApprovals?.written?.['agy']?.[agySettingsFile(w)]?.items).toEqual(FOUR.map(agyRule))
  })


  reg.define(/^the instruction block Antigravity CLI reads is present once$/, (w: InstallWorld) => {
    const blocks = agyRuleFiles(w).flatMap(f => existsSync(f) ? readFileSync(f, 'utf8').split(MARKER_START).length - 1 : 0)
    expect(blocks.reduce((a, b) => a + b, 0), `treecontext blocks across ${agyRuleFiles(w).join(', ')}`).toBe(1)
    expect(blocks[0], 'the block is not in ~/.gemini/GEMINI.md').toBe(1)
  })

  // ── Gemini CLI retired (D399) ─────────────────────────────────────
  //
  // Real install, uninstall and doctor under a redirected HOME. Gemini CLI's
  // own command (the stand-in `gemini`, which nothing may run) and its own
  // files are laid out where a scenario means them present, so its absence
  // from every write is install's doing and not the world's. What an earlier
  // install wrote for Gemini CLI is a fixture of that build's output
  // (layEarlierGeminiInstall); agy's own `agy mcp list` is the other side for
  // agy's wiring.
  const geminiSettingsFile = (w: InstallWorld): string => join(w.ihome!, '.gemini', 'settings.json')
  const geminiMd = (w: InstallWorld): string => join(w.ihome!, '.gemini', 'GEMINI.md')
  const geminiWrappers = (w: InstallWorld): string[] => {
    const hooksDir = join(w.ihome!, '.claude', 'hooks')
    return existsSync(hooksDir) ? readdirSync(hooksDir).filter(f => f.startsWith('tc-gemini-')) : []
  }
  /** Gemini CLI there by its command and its own files (D399: install reads neither). */
  const markGeminiPresent = (w: InstallWorld): void => {
    putGeminiOnPath(w)
    markGeminiCliInstalled(w.ihome!)
  }
  /** The developer's own notes in GEMINI.md, which Antigravity CLI reads. */
  const DEVELOPER_NOTES = '# My notes\n\nAlways answer in British English.\n'
  /** Gemini CLI's settings as the developer keeps them: a server, a hook and keys of their own. */
  const GEMINI_DEVELOPER = {
    theme: 'GitHub',
    selectedAuthType: 'oauth-personal',
    mcpServers: { 'their-server': { command: 'someone-elses-tool' } },
    hooks: {
      BeforeTool: [{ matcher: 'run_shell_command', hooks: [{ type: 'command', command: '/usr/local/bin/audit-tool' }] }],
      SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: '/usr/local/bin/greet' }] }],
    },
  }

  reg.define(/^a machine with Antigravity CLI installed, and Gemini CLI's command and its own files present$/, async (w: InstallWorld) => {
    await openInstallWorld(w, [])
    putAgyOnPath(w)
    seedAgyHome(w)
    markGeminiPresent(w)
  })

  reg.define(/^a machine with Gemini CLI's command and its own files present$/, async (w: InstallWorld) => {
    await openInstallWorld(w, [])
    markGeminiPresent(w)
  })


  reg.define(/^no Gemini CLI configuration is written$/, (w: InstallWorld) => {
    // The world means Gemini CLI to be there: its own file and its command.
    expect(existsSync(join(w.ihome!, '.gemini', 'installation_id')), "the world laid out no Gemini CLI file").toBe(true)
    expect(existsSync(join(w.iGeminiBin!, process.platform === 'win32' ? 'gemini.cmd' : 'gemini')), 'the world put no gemini on PATH').toBe(true)
    // The world above holds Gemini CLI's own file and command, which the
    // build before D399 read as Gemini CLI installed and wired.
    expect(existsSync(geminiSettingsFile(w)), 'install wrote Gemini CLI configuration').toBe(false)
    expect(geminiWrappers(w), 'install wrote Gemini CLI hook wrappers').toEqual([])
    // step-lint: allow unearned-absence -- guarded: the install line it would sit in is asserted present in this same output (Detected agents, or the refusal line)
    expect(w.irun!.stdout).not.toMatch(/^Gemini CLI:/m)
    const doctor = tcCli(w, ['doctor'])
    expect(doctor.status, doctor.out).toBe(0)
    // The needle fires: this doctor run prints rows.
    expect(doctor.stdout).toMatch(/^\[(ok|warn|err)\]\s+\S/m)
    // step-lint: allow unearned-absence -- guarded: the line above proves this doctor run prints rows, and the D399 doctor scenario of journal-clients reads a Gemini CLI row where an earlier install's entry is laid
    expect(doctor.stdout).not.toMatch(/^\[\w+\]\s+Gemini CLI:/m)
  })

  reg.define(/^the developer sees one line saying Gemini CLI is retired, naming Antigravity CLI and the command that removes an old entry$/, (w: InstallWorld) => {
    const said = w.irun!.out.split('\n').filter(l => /Gemini CLI is retired/.test(l))
    expect(said, `install said it ${said.length} times:\n${w.irun!.out}`).toHaveLength(1)
    const line = said[0]!
    expect(line).toContain('Antigravity CLI')
    expect(line).toContain('treecontext install --agent agy')
    expect(line).toContain('treecontext uninstall --agent gemini')
    // D406: the flag is gone, so the line no longer names it.
    // step-lint: allow unearned-absence -- the needle is the flag's own spelling, which the refusal line of the flag outline (this file, "install runs with the experimental capture flag") is found by
    expect(line).not.toContain('--experimental-capture')
    // A refusal, said as such: no crash trace and no "unknown agent".
    // step-lint: allow unearned-absence -- the needles are the CLI's own spellings: `[treecontext] Fatal:` is what cli.ts prints for an install error it does not recognise, and `No matching agents found for:` what install prints for an unknown slug, both in src
    expect(w.irun!.out).not.toMatch(/Fatal|No matching agents/)
  })

  reg.define(/^Gemini CLI's settings holding the treecontext entry and the copied hooks an earlier install wrote, beside the developer's own server, hook and keys, its hook wrappers, and the instruction block in GEMINI\.md below the developer's notes$/, async (w: InstallWorld) => {
    await openInstallWorld(w, [])
    markGeminiPresent(w)
    layEarlierGeminiInstall(w.ihome!, GEMINI_DEVELOPER, { wrappers: true })
    writeFileSync(geminiMd(w), `${DEVELOPER_NOTES}\n${INSTRUCTIONS_CONTENT}\n`)
    // The fixture holds what the Thens read gone.
    const laid = JSON.parse(readFileSync(geminiSettingsFile(w), 'utf8')) as { mcpServers: Record<string, unknown>; hooks: Record<string, unknown[]> }
    expect(Object.keys(laid.mcpServers).sort()).toEqual(['their-server', 'treecontext'])
    expect(Object.keys(laid.hooks).sort()).toEqual(['AfterTool', 'BeforeAgent', 'BeforeTool', 'PreCompress', 'SessionStart'])
    expect(laid.hooks['SessionStart']!.length, 'the copy holds no SessionStart entry beside the developer\'s').toBeGreaterThan(1)
    expect(geminiWrappers(w).sort()).toEqual(GEMINI_WRAPPER_STEMS.map(st => `tc-gemini-${st}`).sort())
    expect(readFileSync(geminiMd(w), 'utf8')).toContain(MARKER_START)
  })

  reg.define(/^Gemini CLI's settings hold the developer's own server, hook and keys, and nothing of treecontext's$/, (w: InstallWorld) => {
    expect(w.irun!.stdout).toMatch(/^gemini \(archived\): mcp removed from /m)
    expect(w.irun!.stdout).toMatch(/^gemini \(archived\): hooks removed from /m)
    // Exactly what the developer had: every other key, server and hook stays.
    expect(JSON.parse(readFileSync(geminiSettingsFile(w), 'utf8'))).toEqual(GEMINI_DEVELOPER)
  })

  reg.define(/^no Gemini CLI hook wrapper is left$/, (w: InstallWorld) => {
    expect(geminiWrappers(w)).toEqual([])
  })

  reg.define(/^(?:after the uninstall )?GEMINI\.md holds the developer's notes and no treecontext block$/, (w: InstallWorld) => {
    const text = readFileSync(geminiMd(w), 'utf8')
    expect(text).toBe(DEVELOPER_NOTES)
    expect(text).not.toContain(MARKER_START)
  })

  reg.define(/^a machine with Antigravity CLI installed, Gemini CLI's own files present, and a GEMINI\.md holding the developer's own notes$/, async (w: InstallWorld) => {
    await openInstallWorld(w, [])
    putAgyOnPath(w)
    seedAgyHome(w)
    markGeminiPresent(w)
    writeFileSync(geminiMd(w), DEVELOPER_NOTES)
  })

  reg.define(/^install runs and then Antigravity CLI is uninstalled$/, (w: InstallWorld) => {
    const install = tcCli(w, ['install', '--yes'])
    expect(install.status, install.out).toBe(0)
    expect(install.stdout).toMatch(/^Detected agents: Antigravity CLI$/m)
    expect(agyMcpList(w).servers.map(s => s.name), 'agy lists no treecontext server after install').toEqual(['treecontext'])
    w.iAfterInstall = readFileSync(geminiMd(w), 'utf8')
    w.irun = tcCli(w, ['uninstall', '--yes', '--agent', 'agy'])
    expect(w.irun.status, w.irun.out).toBe(0)
  })

  reg.define(/^after install GEMINI\.md holds the treecontext block once, below the developer's notes$/, (w: InstallWorld) => {
    const text = w.iAfterInstall!
    expect(text.split(MARKER_START).length - 1, 'treecontext blocks in GEMINI.md').toBe(1)
    expect(text.startsWith(DEVELOPER_NOTES.trimEnd()), "the developer's notes are not where they were").toBe(true)
    const block = new RegExp(`${MARKER_START}[\\s\\S]*?${MARKER_END}`).exec(text)
    expect(block?.[0], 'the block is not the block install writes').toBe(INSTRUCTIONS_CONTENT)
    expect(text.indexOf(MARKER_START)).toBeGreaterThan(DEVELOPER_NOTES.trimEnd().length - 1)
  })

  reg.define(/^Antigravity CLI's own listing of its MCP servers no longer names the treecontext server$/, (w: InstallWorld) => {
    expect(w.irun!.stdout).toMatch(new RegExp(`^Antigravity CLI: instructions removed from ${geminiMd(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'))
    expect(agyMcpList(w).servers.map(s => s.name)).toEqual([])
  })

  reg.define(/^Antigravity CLI is wired for the tools$/, (w: InstallWorld) => {
    const seen = agyEntry(w)
    expect(seen.command).toBe(mcpLauncherIn(w.ihome!))
    // agy prints no permission rules: the file it reads is read.
    expect(agyPermissions(w)['allow']).toEqual(FOUR.map(agyRule))
  })

  reg.define(/^Antigravity CLI's permission settings holding the developer's allow rule for another server and ask rule for treecontext_insert$/, async (w: InstallWorld) => {
    await openInstallWorld(w, [])
    putAgyOnPath(w)
    const theirs = { trustedWorkspaces: ['/srv/work'], permissions: { allow: ['mcp(github/*)'], ask: [agyRule('treecontext_insert')] } }
    seedAgyHome(w, theirs)
    w.iClient = 'Antigravity CLI'
    w.iDeveloperBefore = JSON.stringify(theirs.permissions)
    w.iSettingsBefore = JSON.stringify(theirs)
  })

  reg.define(/^after install the developer's two rules read as they were$/, (w: InstallWorld) => {
    const before = JSON.parse(w.iDeveloperBefore!) as { allow: string[]; ask: string[] }
    const after = JSON.parse(w.iAfterInstall!) as { allow: string[]; ask: string[]; deny?: unknown }
    // The developer's allow rule where it was, install's beside it, and none
    // for insert, which the developer's ask rule decides.
    expect(after.allow).toEqual([...before.allow, ...FOUR.filter(t => t !== 'treecontext_insert').map(agyRule)])
    expect(after.ask).toEqual(before.ask)
    expect(after.deny).toBeUndefined()
  })

  reg.define(/^after uninstall the rules install added are gone and the developer's two remain$/, (w: InstallWorld) => {
    expect(JSON.stringify(agyPermissions(w))).toBe(w.iDeveloperBefore)
    expect(JSON.stringify(agySettings(w))).toBe(w.iSettingsBefore)
    expect(w.irun!.stdout).toMatch(/Antigravity CLI: tool approvals install wrote \(.*\) removed from /)
    expect(agyMcpList(w).servers.map(s => s.name)).toEqual([])
  })

  // ── the install message, and an install told not to approve (D390) ──
  reg.define(/^a machine with Claude Code, Codex CLI and Antigravity CLI installed$/, async (w: InstallWorld) => {
    await openInstallWorld(w, ['.claude', '.codex'])
    putAgyOnPath(w)
    seedAgyHome(w)
  })

  const THREE = ['Claude Code', 'Codex CLI', 'Antigravity CLI'] as const
  const messageOf = (out: string): string[] => {
    const lines = out.split('\n')
    const heads = lines.flatMap((l, i) => l === 'Tool approvals:' ? [i] : [])
    expect(heads, `install printed ${heads.length} approvals messages:\n${out}`).toHaveLength(1)
    const body: string[] = []
    for (const l of lines.slice(heads[0]! + 1)) { if (!l.startsWith('  ')) break; body.push(l) }
    return body
  }
  const messageLine = (body: string[], client: string): string => {
    const found = body.filter(l => l.startsWith(`  ${client}: `))
    expect(found, `the message's lines for ${client}:\n${body.join('\n')}`).toHaveLength(1)
    return found[0]!
  }

  reg.define(/^the developer sees one message naming status, query, export and insert as approved in each of the three, and where$/, async (w: InstallWorld) => {
    expect(w.irun!.status, w.irun!.out).toBe(0)
    const body = messageOf(w.irun!.stdout)
    const where: Record<string, string> = {
      'Claude Code': `permissions.allow in ${settingsFile(w)}`,
      'Codex CLI': `mcp_servers.treecontext.tools in ${codexConfigFile(w)}`,
      'Antigravity CLI': `permissions.allow in ${agySettingsFile(w)}`,
    }
    for (const c of THREE) {
      expect(messageLine(body, c)).toMatch(new RegExp(`^  ${c}: status, query, export and insert approved by install \\(${where[c]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\);`))
    }
    // What the message says is what the clients read: Codex by its own
    // reading, Claude Code and agy from the files they read (they print no rules).
    expect(claudePermissions(w)['allow']).toEqual(FOUR.map(t => `mcp__treecontext__${t}`))
    const codex = await codexToolsSeen(w)
    for (const t of FOUR) expect(codex.tools[t]?.approval_mode).toBe('approve')
    expect(agyPermissions(w)['allow']).toEqual(FOUR.map(agyRule))
  })

  reg.define(/^the message names clear, delete, import and merge as still asking$/, (w: InstallWorld) => {
    const body = messageOf(w.irun!.stdout)
    for (const c of THREE) expect(messageLine(body, c)).toMatch(/; still asking: clear, delete, import and merge$/)
  })

  reg.define(/^the message names `treecontext config tool-approvals off` and `install --no-tool-approvals` as the way back$/, (w: InstallWorld) => {
    const body = messageOf(w.irun!.stdout)
    expect(body).toContain('  the way back: treecontext config tool-approvals off, or treecontext install --no-tool-approvals')
  })

  reg.define(/^install runs with `--no-tool-approvals`$/, (w: InstallWorld) => {
    w.iInstallRun = tcCli(w, ['install', '--yes', '--no-tool-approvals'])
    expect(w.iInstallRun.status, w.iInstallRun.out).toBe(0)
  })

  reg.define(/^install runs again without it$/, (w: InstallWorld) => {
    w.irun = tcCli(w, ['install', '--yes'])
    expect(w.irun.status, w.irun.out).toBe(0)
  })

  reg.define(/^none of the three carries an approval install wrote for a treecontext tool$/, async (w: InstallWorld) => {
    // The needle fires: each of the three is wired, as its own listing or
    // file shows, so an approval would have had somewhere to go.
    expect(codexCli(w, ['mcp', 'list']).stdout).toMatch(/^treecontext\s/m)
    expect(agyEntry(w).command).toBe(mcpLauncherIn(w.ihome!))
    expect(JSON.parse(readFileSync(join(w.ihome!, '.claude.json'), 'utf8')).mcpServers.treecontext).toBeDefined()
    // step-lint: allow unearned-absence -- guarded: the install message scenario of this file asserts the same three files carry the four approvals after a plain install of the same three clients
    expect(JSON.stringify(claudePermissions(w))).not.toMatch(/mcp__treecontext/)
    expect((await codexToolsSeen(w)).tools).toEqual({})
    expect(agyTreecontextRules(w)).toEqual([])
    expect(installRecord(w).toolApprovals?.written ?? {}).toEqual({})
  })

  reg.define(/^the developer sees the second install say that tool approvals are off by the developer's choice, and how to turn them on$/, (w: InstallWorld) => {
    const body = messageOf(w.irun!.stdout)
    for (const c of THREE) expect(messageLine(body, c)).toMatch(/^  [^:]+: off by your choice — none approved by install;/)
    expect(body).toContain('  tool approvals are off by your choice for Claude Code, Codex CLI and Antigravity CLI; to turn them on: treecontext config tool-approvals on')
  })

  // ── D406: Codex's own block, beside the developer's hooks ───────────
  // The far side is the real Codex on PATH (0.167.0 on the binding host):
  // its app server's `hooks/list` is what says which hooks Codex loads and
  // trusts, read under the redirected HOME; the developer's /hooks trust is
  // the stand-in's (standins.ts developerTrustsCodexHooks), with Codex's own
  // hashes. The files are read back only for what Codex's account does not
  // carry (a group's order, a command's bytes).
  type CodexWorld = InstallWorld & {
    cxDevPlace?: string; cxState?: string; cxHeld?: string; cxReinstall?: CliRun
    cxAfterReinstall?: CodexListedHook | undefined; cxAfterUninstall?: CodexListedHook | undefined
  }
  const cxHooksFile = (w: InstallWorld): string => join(w.ihome!, '.codex', 'hooks.json')
  const cxToml = (w: InstallWorld): string => join(w.ihome!, '.codex', 'config.toml')
  const cxHooks = (w: InstallWorld): Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>> =>
    ((JSON.parse(readFileSync(cxHooksFile(w), 'utf8')) as Record<string, unknown>)['hooks'] ?? {}) as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>
  const cxState = (w: InstallWorld): string => {
    const toml = existsSync(cxToml(w)) ? parseToml(readFileSync(cxToml(w), 'utf8')) as Record<string, unknown> : {}
    return JSON.stringify(((toml['hooks'] as Record<string, unknown> | undefined)?.['state']) ?? {})
  }
  const DEV_STOP = { hooks: [{ type: 'command', command: 'notify-send "codex turn ended"' }] }
  // No client is pinned: the host's Codex is the Given's version or a newer
  // one, and where it is newer the world's PATH carries a stand-in for the
  // version line alone (install-harness codexReading), the rest Codex's own.
  const realCodexAt = (w: InstallWorld, version: string): void => {
    codexReading(w, version)
  }
  const devTrusted = async (w: CodexWorld): Promise<void> => {
    const trusted = await developerTrustsCodexHooks(w.ihome!, w.iproj ?? w.ihome!, (h) => h.command === DEV_STOP.hooks[0]!.command)
    expect(trusted).toHaveLength(1)
    w.cxDevPlace = trusted[0]!.key
    w.cxState = cxState(w)
  }
  const codexSays = async (w: InstallWorld): Promise<CodexListedHook[]> => codexHooksSeen(w.ihome!, w.iproj ?? w.ihome!)

  // ── D409: the capture census over a Codex transcript ────────────────
  // Two recorded `codex exec` sessions (tests/fixtures/codex-hooks/0.167.0):
  // no single recorded session holds both a direct call and code-mode shell
  // commands, so the subagent set's (spawn_agent and wait_agent, called
  // directly) stands beside the headless set's (six calls through code
  // mode). Each transcript is Codex's own rollout, redacted as its events
  // were (rollouts/); the store is the one its hooks wrote, the recorded
  // events replayed through the hooks install writes for Codex. The census
  // is the real script, run as the dogfood routine runs it.
  type CensusWorld = InstallWorld & CaptureWorld & { cxRollouts?: string[]; cxCensus?: CliRun; cxRows?: CensusRow[] }
  const ROLLOUTS = join(TS_ROOT, 'tests', 'fixtures', 'codex-hooks', '0.167.0', 'rollouts')
  reg.define(/^the transcript of a headless Codex session and the store its hooks wrote, both recorded, in which Codex called a tool directly and ran shell commands through its code mode$/, async (w: CensusWorld) => {
    await openCaptureWorld(w)
    w.cxRollouts = ['headless-session', 'subagent'].map((s) => join(ROLLOUTS, `${s}.rollout.jsonl`))
    for (const set of ['headless-session.ndjson', 'subagent.ndjson']) replayRecordedSession(w, recordedSession('0.167.0', set, 'codex'))
    await drainStaging(w)
    const calls = w.cxRollouts.flatMap((f) => parseCodexRollout(readFileSync(f, 'utf8'), f))
    // The premise: a direct call, and shell commands run through code mode.
    expect(calls.filter((c) => c.codex?.made === 'direct').map((c) => c.name)).toEqual(['collaborationspawn_agent', 'collaborationwait_agent'])
    expect(calls.filter((c) => c.codex?.made === 'code-mode' && c.name === 'Bash').map((c) => c.input['command'])).toEqual(['head -c 13 notes.txt', 'ls /no-such-path-fixture', 'touch /etc/tc-fixture-probe'])
    w.cxRows = classify(calls, storeViewOf(new DatabaseSync(w.dbPath!, { readOnly: true })))
  })
  reg.define(/^the capture census counts the session's calls against the store$/, (w: CensusWorld) => {
    w.cxCensus = spawnNodeTs(join(TS_ROOT, 'scripts', 'capture-census.ts'), [...w.cxRollouts!.flatMap((f) => ['--codex', f]), '--store', w.dbPath!], { home: w.home! })
    // Nothing LOST, one call inferred: the census's own exit code for that.
    expect(w.cxCensus.status, w.cxCensus.out).toBe(3)
  })
  reg.define(/^the census counts the direct call as found by Codex's id for it$/, (w: CensusWorld) => {
    const direct = w.cxRows!.filter((r) => r.call.codex?.made === 'direct')
    expect(direct.map((r) => [r.call.id.startsWith('call_'), r.call.codex!.by, r.status])).toEqual([[true, 'id', 'stored'], [true, 'id', 'stored']])
    expect(w.cxCensus!.stdout).toMatch(/found by Codex's id: 7 \(2 direct, 5 in code mode/)
  })
  reg.define(/^it counts each code-mode call by Codex's id for it where the transcript's record of the completed call carries that id, and as matched by inference where it does not$/, (w: CensusWorld) => {
    const code = w.cxRows!.filter((r) => r.call.codex?.made === 'code-mode')
    const byId = code.filter((r) => r.call.codex!.by === 'id')
    expect(byId.map((r) => [r.call.name, r.status])).toEqual([
      ['Bash', 'stored'], ['Bash', 'stored'], ['mcp__treecontext__treecontext_insert', 'stored'], ['mcp__treecontext__treecontext_query', 'stored'], ['mcp__treecontext__treecontext_export', 'stored'],
    ])
    for (const r of byId) expect(r.call.id).toMatch(/^exec-/)
    const inferred = code.filter((r) => r.call.codex!.by === 'inference')
    expect(inferred.map((r) => [r.call.name, r.call.input['command'], r.status])).toEqual([['Bash', 'touch /etc/tc-fixture-probe', 'inferred']])
    // Not vacuous: the row the inference found is the call's own, under an
    // id of Codex's the transcript never names.
    const db = new DatabaseSync(w.dbPath!, { readOnly: true })
    try {
      const ids = (db.prepare("SELECT json_extract(metadata_json, '$.tool_use_id') AS id FROM nodes WHERE json_extract(metadata_json, '$.tool_name') = 'Bash' AND content LIKE '%touch /etc/tc-fixture-probe%'").all() as Array<{ id: string }>).map((r) => r.id)
      expect(ids).toEqual(['exec-ed7d47c4-e6b1-4911-88a2-6cc988ad89ae'])
      expect(readFileSync(w.cxRollouts![0]!, 'utf8')).not.toContain(ids[0]!)
    } finally { db.close() }
  })
  reg.define(/^it says how many it found by id and how many it inferred, and why$/, (w: CensusWorld) => {
    const out = w.cxCensus!.stdout
    expect(out).toContain(`matched by inference: 1, because ${CODEX_INFER_WHY}`)
    expect(out).toContain('  inferred Bash "touch /etc/tc-fixture-probe"')
    expect(out).toMatch(/found by Codex's id: 7 /)
  })

  // ── D406, the reinstall outline: what a second install leaves of the
  // hooks Codex trusts. The trust is Codex's own (`hooks/list` on the real
  // Codex), the developer's /hooks click the stand-in's, with Codex's hashes.
  type ReinstallWorld = CodexWorld & { rxFirst?: string; rxText?: string; rxTrust?: Record<string, string>; rxScript?: string; rxNode?: string; rxOldHome?: string }
  const ourHooksSeen = async (w: InstallWorld): Promise<CodexListedHook[]> => (await codexSays(w)).filter((h) => h.sourcePath === cxHooksFile(w) && h.command.includes('--client codex'))
  const stopScript = (w: InstallWorld): string => join(w.ihome!, '.claude', 'hooks', 'tc-stop')
  reg.define(/^Codex CLI 0\.167\.0 wired by install, every hook of treecontext's trusted$/, async (w: ReinstallWorld) => {
    await openInstallWorld(w, ['.claude', '.codex'])
    realCodexAt(w, '0.167.0')
    const run = tcCli(w, ['install', '--yes'])
    expect(run.status, run.out).toBe(0)
    w.rxFirst = run.stdout
    const trusted = await developerTrustsCodexHooks(w.ihome!, w.iproj ?? w.ihome!)
    expect(trusted.filter((h) => h.command.includes('--client codex'))).toHaveLength(Object.keys(codexHooksBlock()).length)
    const seen = await ourHooksSeen(w)
    expect(seen.every((h) => h.trustStatus === 'trusted'), JSON.stringify(seen)).toBe(true)
    w.rxText = readFileSync(cxHooksFile(w), 'utf8')
    w.rxTrust = Object.fromEntries(seen.map((h) => [h.key, h.currentHash ?? '']))
    w.rxScript = readFileSync(stopScript(w), 'utf8')
  })
  reg.define(/^(nothing changes|the Node interpreter the hook scripts name moves with an upgrade|the hook scripts are moved to another directory, so every command changes), and install runs again$/, (w: ReinstallWorld, change: unknown) => {
    if (change === 'nothing changes') {
      w.irun = tcCli(w, ['install', '--yes'])
    } else if (String(change).startsWith('the Node interpreter')) {
      // The upgrade: a Node at a new place, the one the developer now runs
      // install from (the owner's nvm routine), so install's interpreter
      // probe picks it first and the hook scripts name it.
      const dir = join(w.ihome!, '.nvm', 'versions', 'node', 'v99.0.0', 'bin')
      mkdirSync(dir, { recursive: true })
      w.rxNode = join(dir, 'node')
      copyFileSync(process.execPath, w.rxNode)
      chmodSync(w.rxNode, 0o755)
      w.irun = tcCli(w, ['install', '--yes'], { node: w.rxNode })
    } else {
      // The directory holding the hook scripts is the developer's home's
      // `.claude/hooks`: it moves when the home does, Codex's directory and
      // install's record moving with it.
      w.rxOldHome = w.ihome!
      const moved = `${w.ihome!}-moved`
      renameSync(w.ihome!, moved)
      w.ihome = moved
      w.irun = tcCli(w, ['install', '--yes'])
    }
    expect(w.irun.status, w.irun.out).toBe(0)
  })
  reg.define(/^every hook of treecontext's has its command byte for byte as it was, Codex still trusts each, and install names no hook to trust again$/, async (w: ReinstallWorld) => {
    expect(readFileSync(cxHooksFile(w), 'utf8')).toBe(w.rxText)
    const seen = await ourHooksSeen(w)
    expect(Object.fromEntries(seen.map((h) => [h.key, h.currentHash ?? '']))).toEqual(w.rxTrust)
    expect(seen.map((h) => h.trustStatus)).toEqual(seen.map(() => 'trusted'))
    // The needle fires: the first install, which wrote the hooks, said it.
    expect(w.rxFirst).toMatch(/Codex will ask you to trust|Codex runs none of treecontext's hooks until you trust them/)
    // step-lint: allow unearned-absence -- the line above proves the needle fires on the first install's output
    expect(w.irun!.stdout).not.toMatch(/Codex will ask you to trust|Codex runs none of treecontext's hooks until you trust them/)
    if (w.rxNode) {
      // Not vacuous: the upgrade did reach the hook scripts, which now name
      // the new interpreter; the commands Codex hashes never named it.
      const script = readFileSync(stopScript(w), 'utf8')
      expect(script).not.toBe(w.rxScript)
      expect(script).toContain(w.rxNode)
      expect(w.rxText).not.toContain(process.execPath)
    }
  })
  reg.define(/^install names each hook whose command changed and says Codex will ask to trust it again with `\/hooks`$/, async (w: ReinstallWorld) => {
    const out = w.irun!.stdout
    const line = out.split('\n').find((l) => /Codex will ask you to trust these hooks of treecontext's again/.test(l))
    expect(line, out).toBeTruthy()
    for (const event of Object.keys(codexHooksBlock())) expect(line).toContain(`${event} group `)
    expect(out.split('\n').filter((l) => /Codex runs none of treecontext's hooks until you trust them/.test(l) && l.includes('/hooks'))).toHaveLength(1)
    // Every command changed, and Codex itself no longer counts any trusted.
    const text = readFileSync(cxHooksFile(w), 'utf8')
    // The needle fires: before the move every command named the old home.
    expect(w.rxText).toContain(`${w.rxOldHome!}/`)
    // step-lint: allow unearned-absence -- the line above proves the needle fires on the file before the move
    expect(text).not.toContain(`${w.rxOldHome!}/`)
    const seen = await ourHooksSeen(w)
    expect(seen).toHaveLength(Object.keys(codexHooksBlock()).length)
    expect(seen.filter((h) => h.trustStatus === 'trusted')).toEqual([])
  })

  reg.define(/^Codex CLI 0\.167\.0 is installed, its hooks file holding a hook of the developer's that Codex counts as trusted, and its `config\.toml` holding a hook of the developer's$/, async (w: CodexWorld) => {
    await openInstallWorld(w, ['.claude', '.codex'])
    realCodexAt(w, '0.167.0')
    writeFileSync(cxHooksFile(w), JSON.stringify({ hooks: { Stop: [DEV_STOP] } }, null, 2) + '\n')
    writeFileSync(cxToml(w), '[[hooks.UserPromptSubmit]]\n[[hooks.UserPromptSubmit.hooks]]\ntype = "command"\ncommand = "log-prompt"\n')
    await devTrusted(w)
    expect((await codexSays(w)).find((h) => h.key === w.cxDevPlace)!.trustStatus).toBe('trusted')
  })
  reg.define(/^Codex's `hooks\.json` holds treecontext's hooks, in groups of their own after the developer's, for exactly the events Codex's list marks wired, with no PostToolUseFailure or PostToolBatch$/, (w: CodexWorld) => {
    expect(w.irun!.status, w.irun!.out).toBe(0)
    const hooks = cxHooks(w)
    const wired = readClientEventList(CODEX_LIST).events.filter((e) => e.disposition === 'wired').map((e) => e.event).sort()
    const ours = Object.entries(hooks).filter(([, gs]) => gs.some((g) => g.hooks.some((h) => h.command.endsWith(' --client codex')))).map(([e]) => e).sort()
    expect(ours).toEqual(wired)
    expect(hooks['PostToolUseFailure']).toBeUndefined()
    expect(hooks['PostToolBatch']).toBeUndefined()
    for (const [event, groups] of Object.entries(hooks)) {
      const mine = groups.map((g) => g.hooks.every((h) => h.command.endsWith(' --client codex')))
      // Every group is wholly treecontext's or wholly the developer's, and
      // treecontext's come after the developer's.
      expect(groups.every((g) => g.hooks.every((h) => h.command.endsWith(' --client codex')) || g.hooks.every((h) => !h.command.endsWith(' --client codex'))), event).toBe(true)
      expect(mine.indexOf(true) === -1 || mine.slice(mine.indexOf(true)).every(Boolean), event).toBe(true)
    }
  })
  reg.define(/^every hook of treecontext's names Codex CLI in its command$/, async (w: CodexWorld) => {
    const said = await codexSays(w)
    const ours = said.filter((h) => h.command.includes('tc-'))
    expect(ours.length).toBe(Object.keys(codexHooksBlock()).length)
    for (const h of ours) expect(h.command).toMatch(/ --client codex$/)
  })
  reg.define(/^the developer's own hooks, in `hooks\.json` and in `config\.toml`, read as the developer left them, and Codex still counts the first trusted$/, async (w: CodexWorld) => {
    expect(cxHooks(w)['Stop']![0]).toEqual(DEV_STOP)
    const toml = parseToml(readFileSync(cxToml(w), 'utf8')) as { hooks: Record<string, unknown> }
    expect(toml.hooks['UserPromptSubmit']).toEqual([{ hooks: [{ type: 'command', command: 'log-prompt' }] }])
    const dev = (await codexSays(w)).find((h) => h.command === DEV_STOP.hooks[0]!.command)!
    expect(dev.key).toBe(w.cxDevPlace)
    expect(dev.trustStatus).toBe('trusted')
  })
  reg.define(/^Codex's record of trusted hooks holds nothing install wrote$/, (w: CodexWorld) => {
    expect(cxState(w)).toBe(w.cxState)
  })
  reg.define(/^the developer sees install say in one line that Codex runs none of treecontext's hooks until they are trusted, with `\/hooks` in Codex$/, (w: CodexWorld) => {
    const lines = w.irun!.stdout.split('\n').filter((l) => /Codex runs none of treecontext's hooks until you trust them/.test(l))
    expect(lines, w.irun!.stdout).toHaveLength(1)
    expect(lines[0]).toContain('/hooks')
  })

  // The verbatim copy of the Claude Code block an earlier build wrote under
  // the experimental flag: laid by that build's writer, kept out of the
  // build in tests/helpers/earlier-build-writers.ts (`upsertCodexHooks`, the
  // copy of `expectedHookCopy`), with no record of install's.
  const layEarlierCopy = (w: InstallWorld): void => {
    const r = upsertCodexHooks(cxHooksFile(w))
    expect(r.status).toBe('updated')
    expect(Object.keys(cxHooks(w))).toEqual(expect.arrayContaining(['PostToolUseFailure', 'PostToolBatch']))
  }
  const withHome = <T>(w: InstallWorld, fn: () => T): T => {
    // os.homedir() reads HOME on Linux and macOS and USERPROFILE on Windows.
    const keys = ['HOME', 'USERPROFILE'] as const
    const before = keys.map(k => process.env[k])
    for (const k of keys) process.env[k] = w.ihome!
    try { return fn() } finally {
      keys.forEach((k, i) => { if (before[i] === undefined) delete process.env[k]; else process.env[k] = before[i] })
    }
  }
  reg.define(/^Codex CLI 0\.167\.0 whose hooks file holds the verbatim copy of the Claude Code block an earlier build wrote under the experimental flag, beside a hook of the developer's$/, async (w: CodexWorld) => {
    await openInstallWorld(w, ['.claude', '.codex'])
    realCodexAt(w, '0.167.0')
    writeFileSync(cxHooksFile(w), JSON.stringify({ hooks: { Stop: [DEV_STOP] } }, null, 2) + '\n')
    await devTrusted(w)
    withHome(w, () => layEarlierCopy(w))
  })
  reg.define(/^install runs again$/, (w: CodexWorld) => {
    w.irun = tcCli(w, ['install', '--yes'])
    expect(w.irun.status, w.irun.out).toBe(0)
  })
  reg.define(/^Codex's hooks file holds Codex's own block once and nothing else of treecontext's, PostToolUseFailure and PostToolBatch gone$/, (w: CodexWorld) => {
    const data = JSON.parse(readFileSync(cxHooksFile(w), 'utf8')) as Record<string, unknown>
    expect(withHome(w, () => codexBlockState(data, codexHooksBlock()).state)).toBe('current')
    const hooks = cxHooks(w)
    expect(hooks['PostToolUseFailure']).toBeUndefined()
    expect(hooks['PostToolBatch']).toBeUndefined()
    const tc = Object.values(hooks).flatMap((gs) => gs.flatMap((g) => g.hooks.map((h) => h.command))).filter((c) => c.includes('/tc-'))
    expect(tc.length).toBe(Object.keys(codexHooksBlock()).length)
  })
  reg.define(/^the developer's own hook reads as the developer left it$/, async (w: CodexWorld) => {
    expect(cxHooks(w)['Stop']![0]).toEqual(DEV_STOP)
    const dev = (await codexSays(w)).find((h) => h.command === DEV_STOP.hooks[0]!.command)!
    expect([dev.key, dev.trustStatus]).toEqual([w.cxDevPlace, 'trusted'])
  })
  reg.define(/^the developer sees install name the hooks Codex must be asked to trust again$/, (w: CodexWorld) => {
    const line = w.irun!.stdout.split('\n').find((l) => /Codex will ask you to trust these hooks of treecontext's again/.test(l))
    expect(line, w.irun!.stdout).toBeTruthy()
    for (const event of Object.keys(codexHooksBlock())) expect(line).toContain(`${event} group `)
  })

  reg.define(/^Codex CLI 0\.167\.0 whose hooks file holds (the hooks install wrote and recorded writing|the verbatim copy of the Claude Code block an earlier build wrote under the experimental flag, before install kept a record), after a hook of the developer's written before install ran$/, async (w: CodexWorld, ours: unknown) => {
    await openInstallWorld(w, ['.claude', '.codex'])
    realCodexAt(w, '0.167.0')
    writeFileSync(cxHooksFile(w), JSON.stringify({ hooks: { Stop: [DEV_STOP] } }, null, 2) + '\n')
    await devTrusted(w)
    if (String(ours).startsWith('the hooks install wrote')) {
      const run = tcCli(w, ['install', '--yes'])
      expect(run.status, run.out).toBe(0)
      const record = JSON.parse(readFileSync(join(w.ihome!, '.treecontext', 'install-state.json'), 'utf8')) as { codexHooks?: { commands: string[] } }
      expect(record.codexHooks?.commands.length).toBe(Object.keys(codexHooksBlock()).length)
    } else {
      const run = tcCli(w, ['install', '--yes', '--agent', 'claude'])
      expect(run.status, run.out).toBe(0)
      withHome(w, () => layEarlierCopy(w))
      // The earlier build's entry for Codex, as it wrote it (the tools).
      appendFileSync(cxToml(w), '\n[mcp_servers.treecontext]\ncommand = "treecontext"\nargs = ["serve", "--transport", "stdio", "--capture"]\n')
    }
  })
  reg.define(/^Codex's hooks file holds the developer's hook alone, at the place it had$/, (w: CodexWorld) => {
    expect(existsSync(cxHooksFile(w))).toBe(true)
    expect(JSON.parse(readFileSync(cxHooksFile(w), 'utf8'))).toEqual({ hooks: { Stop: [DEV_STOP] } })
  })
  reg.define(/^Codex still counts the developer's hook trusted$/, async (w: CodexWorld) => {
    const said = await codexSays(w)
    expect(said.map((h) => [h.key, h.trustStatus])).toEqual([[w.cxDevPlace, 'trusted']])
  })
  reg.define(/^Codex's treecontext entry is gone$/, (w: CodexWorld) => {
    const toml = existsSync(cxToml(w)) ? parseToml(readFileSync(cxToml(w), 'utf8')) as Record<string, Record<string, unknown>> : {}
    expect(toml['mcp_servers']?.['treecontext']).toBeUndefined()
  })

  // ── D406: no Codex hook below the floor, an unread version, an unparsed file ──
  // The version install reads is the stand-in `codex`'s (writeFakeCodex),
  // put on the CLI's PATH; Codex's own reading of the entry is the real
  // Codex's (`codex mcp get`), and the server the entry starts is started
  // as Codex starts it.
  const NO_HOOK_CASES: Record<string, { version: string | null; held: string }> = {
    'its version reads 0.166.0': { version: '0.166.0', held: "treecontext's hooks an earlier install recorded writing at 0.167.0, beside a hook of the developer's" },
    'its version cannot be read': { version: null, held: 'the verbatim copy of the Claude Code block an earlier build wrote under the experimental flag, beside a hook of the developer\'s' },
    'its hooks file does not parse': { version: '0.167.0', held: "a hook of the developer's and treecontext's hooks an earlier install wrote" },
  }
  const fake = (w: InstallWorld, version: string | null): void => setFakeCodex(w, { version, sandbox: { exit: 0, stderr: '' } })
  reg.define(/^Codex CLI where (its version reads 0\.166\.0|its version cannot be read|its hooks file does not parse), its hooks file holding (.+)$/, async (w: CodexWorld, which: unknown, held: unknown) => {
    const c = NO_HOOK_CASES[String(which)]!
    expect(String(held)).toBe(c.held)
    await openInstallWorld(w, ['.claude', '.codex'])
    writeFileSync(cxHooksFile(w), JSON.stringify({ hooks: { Stop: [DEV_STOP] } }, null, 2) + '\n')
    if (String(which) === 'its version cannot be read') {
      const run = tcCli(w, ['install', '--yes', '--agent', 'claude'])
      expect(run.status, run.out).toBe(0)
      withHome(w, () => layEarlierCopy(w))
    } else {
      // The earlier install, at 0.167.0, wrote and recorded its hooks.
      fake(w, '0.167.0')
      const run = tcCli(w, ['install', '--yes', '--agent', 'codex'])
      expect(run.status, run.out).toBe(0)
      expect(JSON.stringify(cxHooks(w))).toContain('--client codex')
    }
    if (String(which) === 'its hooks file does not parse') {
      // The developer's edit left a trailing comma: the file no longer parses.
      writeFileSync(cxHooksFile(w), readFileSync(cxHooksFile(w), 'utf8').replace(/\n\}\n$/, ',\n}\n'))
      expect(() => JSON.parse(readFileSync(cxHooksFile(w), 'utf8'))).toThrow()
    }
    fake(w, c.version)
    w.cxHeld = readFileSync(cxHooksFile(w), 'utf8')
  })
  reg.define(/^Codex's hooks file holds (the developer's hook alone, as the developer left it|byte for byte what it held)$/, (w: CodexWorld, after: unknown) => {
    expect(w.irun!.status, w.irun!.out).toBe(0)
    if (String(after).startsWith('byte for byte')) expect(readFileSync(cxHooksFile(w), 'utf8')).toBe(w.cxHeld)
    else expect(JSON.parse(readFileSync(cxHooksFile(w), 'utf8'))).toEqual({ hooks: { Stop: [DEV_STOP] } })
  })
  reg.define(/^the server Codex's entry starts runs without capture$/, async (w: InstallWorld) => {
    const seen = clientEntry(w, 'Codex CLI')
    w.iproj ??= w.ihome!
    expect(await startEntryAsClient(w.ihome!, seen, w.iproj)).toBe('standard')
  })
  reg.define(/^the developer sees install say in one line that Codex CLI stays tools-only, (naming 0\.166\.0 and that capture needs Codex CLI 0\.167\.0 or later|saying its version could not be read|quoting the parse error)$/, (w: CodexWorld, why: unknown) => {
    const lines = w.irun!.stdout.split('\n').filter((l) => /Codex CLI stays tools-only/.test(l))
    expect(lines, w.irun!.stdout).toHaveLength(1)
    const line = lines[0]!
    if (String(why).startsWith('naming')) expect(line).toMatch(/0\.166\.0.*capture needs Codex CLI 0\.167\.0 or later/)
    else if (String(why).startsWith('saying')) expect(line).toMatch(/version could not be read/)
    else {
      let error = ''
      try { JSON.parse(w.cxHeld!) } catch (e) { error = (e as Error).message }
      expect(error).not.toBe('')
      expect(line).toContain(error)
    }
  })

  // ── D406: a hook the developer added after install ──────────────────
  reg.define(/^Codex CLI 0\.167\.0 wired by install, and a hook of the developer's added after install for the same event and the same matcher as one of treecontext's, which Codex counts as trusted$/, async (w: CodexWorld) => {
    await openInstallWorld(w, ['.claude', '.codex'])
    realCodexAt(w, '0.167.0')
    const run = tcCli(w, ['install', '--yes', '--agent', 'codex'])
    expect(run.status, run.out).toBe(0)
    const data = JSON.parse(readFileSync(cxHooksFile(w), 'utf8')) as { hooks: Record<string, unknown[]> }
    // treecontext's Stop group has no matcher; the developer's has none either.
    expect((data.hooks['Stop']![0] as { matcher?: string }).matcher).toBeUndefined()
    data.hooks['Stop']!.push(DEV_STOP)
    writeFileSync(cxHooksFile(w), JSON.stringify(data, null, 2) + '\n')
    await devTrusted(w)
    expect(w.cxDevPlace).toBe(`${cxHooksFile(w)}:stop:1:0`)
  })
  reg.define(/^install runs again and then uninstall runs$/, async (w: CodexWorld) => {
    const again = tcCli(w, ['install', '--yes', '--agent', 'codex'])
    expect(again.status, again.out).toBe(0)
    w.cxReinstall = again
    w.cxAfterReinstall = (await codexSays(w)).find((h) => h.command === DEV_STOP.hooks[0]!.command)
    w.irun = tcCli(w, ['uninstall', '--yes', '--agent', 'codex'])
    expect(w.irun.status, w.irun.out).toBe(0)
    w.cxAfterUninstall = (await codexSays(w)).find((h) => h.command === DEV_STOP.hooks[0]!.command)
  })
  reg.define(/^after the reinstall the developer's hook is where it was, Codex still counts it trusted, and install named no hook of the developer's$/, (w: CodexWorld) => {
    expect([w.cxAfterReinstall?.key, w.cxAfterReinstall?.trustStatus]).toEqual([w.cxDevPlace, 'trusted'])
    // The line install says of a developer's hook it moved, never said here.
    expect(w.cxReinstall!.stdout.split('\n').filter((l) => / moved your hook /.test(l))).toEqual([])
    expect(w.irun!.stdout).toMatch(/ moved your hook /)
  })
  reg.define(/^after the uninstall the developer's hook is in Codex's hooks file with its command as the developer wrote it$/, (w: CodexWorld) => {
    expect(JSON.parse(readFileSync(cxHooksFile(w), 'utf8'))).toEqual({ hooks: { Stop: [DEV_STOP] } })
  })
  reg.define(/^the developer sees uninstall name the developer's hook if taking treecontext's out moved it, saying Codex will ask to trust it again$/, (w: CodexWorld) => {
    // It moved: Codex now finds it at another place, its record left behind.
    expect(w.cxAfterUninstall!.key).toBe(`${cxHooksFile(w)}:stop:0:0`)
    expect(w.cxAfterUninstall!.trustStatus).not.toBe('trusted')
    const lines = w.irun!.stdout.split('\n').filter((l) => / moved your hook /.test(l))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`Stop group 1 hook 0 (${DEV_STOP.hooks[0]!.command}) to Stop group 0 hook 0`)
    expect(lines[0]).toMatch(/Codex will ask you to trust it again with \/hooks/)
  })

// ── Antigravity CLI's named hook (D413, D417) ─────────────────────────
  //
  // A real install, uninstall and doctor under a redirected HOME. The agy a
  // version check reads is the stand-in `agy` (writeFakeAgy), answering
  // `--version` as agy 1.5.3 answers its own (the bare version); where a
  // scenario reads agy's own listing of its MCP servers, `mcp list` is the
  // real agy's (putAgyOnPath). The hooks file is read straight from disk:
  // agy has no command that lists the hooks it loaded.
  const agyHooksFile = (w: InstallWorld): string => join(w.ihome!, '.gemini', 'config', 'hooks.json')
  const agyHooksOnDisk = (w: InstallWorld): Record<string, unknown> => JSON.parse(readFileSync(agyHooksFile(w), 'utf8')) as Record<string, unknown>
  /** The developer's own named hook, in agy's shape (a PostToolUse group), and a number past 2^53. */
  const DEVELOPER_AGY_HOOK = '{\n  "audit": {\n    "PostToolUse": [ { "matcher": "run_command", "hooks": [ { "type": "command", "command": "/usr/local/bin/audit {}", "budget": 9007199254740993 } ] } ]\n  }\n}\n'
  /** The stand-in agy at `version` (null: unreadable), first on the CLI's PATH. */
  const setFakeAgy = (w: InstallWorld, version: string | null): void => {
    // Never write through a link to the real agy (putAgyOnPath's).
    if (w.iAgyBin) rmSync(join(w.iAgyBin, 'agy'), { force: true })
    if (!w.iAgyBin) {
      w.iAgyBin = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-fake-agy-')))
      w.defer(() => rmSync(w.iAgyBin!, { recursive: true, force: true }))
    }
    writeFakeAgy(w.iAgyBin, version)
  }
  const agyAt = async (w: InstallWorld, version: string | null, hooks?: string): Promise<void> => {
    await openInstallWorld(w, [])
    seedAgyHome(w)
    setFakeAgy(w, version)
    if (hooks !== undefined) writeFileSync(agyHooksFile(w), hooks)
    if (existsSync(agyHooksFile(w))) w.iDeveloperBefore = readFileSync(agyHooksFile(w), 'utf8')
    else delete w.iDeveloperBefore
  }
  const ourAgyHook = (data: Record<string, unknown>): Record<string, unknown> | undefined => data[AGY_HOOK_NAME] as Record<string, unknown> | undefined
  /** The named hook install writes, as written under the world's home. */
  const agyHooksBlockFor = (w: InstallWorld): Record<string, unknown> => JSON.parse(JSON.stringify(agyHooksBlock()).split(homedir().replace(/\\/g, '/')).join(w.ihome!.replace(/\\/g, '/'))) as Record<string, unknown>
  const agyEntryArgs = (w: InstallWorld): string[] => {
    const cfg = JSON.parse(readFileSync(join(w.ihome!, '.gemini', 'config', 'mcp_config.json'), 'utf8')) as { mcpServers: Record<string, { args: string[] }> }
    return cfg.mcpServers['treecontext']!.args
  }

  reg.define(/^a machine with Antigravity CLI installed, its version reading 1\.5\.3$/, async (w: InstallWorld) => {
    await openInstallWorld(w, ['.claude'])
    // agy's own listing, and its own version line where it still reads
    // the version the Given names (agyReading).
    agyReading(w, AGY_CAPTURE_FLOOR)
    seedAgyHome(w)
    expect(worldAgyVersion(w)).toBe(AGY_CAPTURE_FLOOR)
    w.iproj = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-install-proj-')))
    w.defer(() => rmSync(w.iproj!, { recursive: true, force: true }))
  })
  reg.define(/^no hook of Antigravity CLI's is written but treecontext's own named hook$/, (w: InstallWorld) => {
    const data = agyHooksOnDisk(w)
    expect(Object.keys(data)).toEqual([AGY_HOOK_NAME])
    expect(ourAgyHook(data)).toEqual(agyHooksBlockFor(w))
  })

  // `install runs` and the listing: shared with D383's scenarios above.
  reg.define(/^(Codex CLI|Antigravity CLI) whose version reads (\d+\.\d+\.\d+)$/, async (w: InstallWorld, client: unknown, version: unknown) => {
    if (client === 'Antigravity CLI') { await agyAt(w, String(version)); return }
    await openInstallWorld(w, ['.claude', '.codex'])
    setFakeCodex(w, { version: String(version), sandbox: { exit: 0, stderr: '' } })
  })
  reg.define(/^(Codex CLI|Antigravity CLI) is wired for the MCP tools$/, (w: InstallWorld, client: unknown) => {
    expect(w.irun!.status, w.irun!.out).toBe(0)
    if (client === 'Antigravity CLI') {
      expect(agyEntryArgs(w).slice(0, 4)).toEqual(['serve', '--transport', 'stdio', '--no-capture'])
    } else {
      const cfg = readFileSync(join(w.ihome!, '.codex', 'config.toml'), 'utf8')
      expect(cfg).toMatch(/\[mcp_servers\.treecontext\]/)
      expect(cfg).toContain('--no-capture')
    }
  })
  reg.define(/^no capture hook of treecontext's is written for it$/, (w: InstallWorld) => {
    const agy = existsSync(agyHooksFile(w)) ? readFileSync(agyHooksFile(w), 'utf8') : ''
    const codex = existsSync(join(w.ihome!, '.codex', 'hooks.json')) ? readFileSync(join(w.ihome!, '.codex', 'hooks.json'), 'utf8') : ''
    // The other client's file is checked too: neither holds a script of treecontext's.
    // step-lint: allow unearned-absence -- the capture rows of the outline that follows find these script names in the files install writes at the floor
    expect(`${agy}${codex}`).not.toMatch(/tc-(agy|post-tool-use|session-start|stop)/)
  })
  reg.define(/^the developer sees install say in one line that (Codex CLI|Antigravity CLI) stays tools-only until (\d+\.\d+\.\d+)$/, (w: InstallWorld, client: unknown, floor: unknown) => {
    const lines = w.irun!.stdout.split('\n').filter((l) => l.includes(`${String(client)} stays tools-only`))
    expect(lines, w.irun!.stdout).toHaveLength(1)
    expect(lines[0]).toContain(String(floor))
  })

  reg.define(/^an Antigravity CLI whose version reads 1\.5\.3, whose hooks file holds the developer's own named hook for PostToolUse, and a workspace whose `\.agents\/hooks\.json` holds a hook of the developer's$/, async (w: InstallWorld) => {
    await agyAt(w, AGY_CAPTURE_FLOOR, DEVELOPER_AGY_HOOK)
    w.iproj = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-install-proj-')))
    w.defer(() => rmSync(w.iproj!, { recursive: true, force: true }))
    mkdirSync(join(w.iproj, '.agents'), { recursive: true })
    writeFileSync(join(w.iproj, '.agents', 'hooks.json'), DEVELOPER_AGY_HOOK)
  })

  reg.define(/^an Antigravity CLI where (the version reads 1\.5\.2|the version cannot be read|the hooks file holds the developer's hook and does not parse|the hooks file holds a hook of the developer's named treecontext)$/, async (w: InstallWorld, which: unknown) => {
    const c = String(which)
    if (c === 'the version reads 1.5.2') await agyAt(w, '1.5.2', DEVELOPER_AGY_HOOK)
    else if (c === 'the version cannot be read') await agyAt(w, null)
    else if (c.includes('does not parse')) await agyAt(w, AGY_CAPTURE_FLOOR, DEVELOPER_AGY_HOOK.replace('"audit": {', '"audit": {,'))
    else await agyAt(w, AGY_CAPTURE_FLOOR, '{\n  "treecontext": { "Stop": [ { "type": "command", "command": "/usr/local/bin/my-tree-tool" } ] }\n}\n')
  })
  reg.define(/^the hooks file is byte for byte as it was, or still absent$/, (w: InstallWorld) => {
    if (w.iDeveloperBefore === undefined) expect(existsSync(agyHooksFile(w))).toBe(false)
    else expect(readFileSync(agyHooksFile(w), 'utf8')).toBe(w.iDeveloperBefore)
  })
  reg.define(/^the server Antigravity CLI's entry starts runs without capture$/, (w: InstallWorld) => {
    expect(agyEntryArgs(w)).toContain('--no-capture')
  })
  reg.define(/^the developer sees install say in one line that Antigravity CLI stays tools-only, (naming 1\.5\.2 and 1\.5\.3 as the first version whose hooks install writes|saying the version could not be read|quoting the parse error and saying agy runs none of the hooks in that file, the developer's included, until it is fixed|saying the name is taken by a hook install did not write|naming 1\.5\.2 and 1\.5\.3)$/, (w: InstallWorld, why: unknown) => {
    const lines = w.irun!.stdout.split('\n').filter((l) => l.includes('Antigravity CLI stays tools-only'))
    expect(lines, w.irun!.stdout).toHaveLength(1)
    const l = lines[0]!
    const y = String(why)
    if (y.startsWith('naming 1.5.2')) expect(l).toMatch(/version reads 1\.5\.2, and 1\.5\.3 is the first version whose hooks install writes/)
    else if (y.startsWith('saying the version')) expect(l).toMatch(/version could not be read/)
    else if (y.startsWith('quoting')) {
      let err = ''
      try { JSON.parse(w.iDeveloperBefore!) } catch (e) { err = (e as Error).message.replace(/\s+/g, ' ').trim() }
      expect(l).toContain(`does not parse (${err})`)
      expect(l).toMatch(/agy runs none of the hooks in that file, yours included, until it is fixed/)
    } else expect(l).toMatch(/the name "treecontext" in .* is taken by a hook install did not write/)
  })

  reg.define(/^an Antigravity CLI whose hooks file holds treecontext's named hook an earlier install wrote at 1\.5\.3, beside the developer's own named hook, and whose version now reads 1\.5\.2$/, async (w: InstallWorld) => {
    await agyAt(w, AGY_CAPTURE_FLOOR, DEVELOPER_AGY_HOOK)
    w.irun = tcCli(w, ['install', '--yes', '--agent', 'agy'])
    expect(w.irun.status, w.irun.out).toBe(0)
    expect(ourAgyHook(agyHooksOnDisk(w))).toBeDefined()
    setFakeAgy(w, '1.5.2')
  })
  reg.define(/^the hooks file holds the developer's named hook as it was, and nothing of treecontext's$/, (w: InstallWorld) => {
    expect(readFileSync(agyHooksFile(w), 'utf8')).toBe(DEVELOPER_AGY_HOOK)
  })

  reg.define(/^an Antigravity CLI at 1\.5\.3 whose hooks file install created, and another whose hooks file held the developer's own named hook before install$/, async (w: InstallWorld) => {
    await agyAt(w, AGY_CAPTURE_FLOOR)
    w.iAgyOther = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-install-home-')))
    w.defer(() => rmSync(w.iAgyOther!, { recursive: true, force: true }))
    mkdirSync(join(w.iAgyOther, '.gemini', 'config'), { recursive: true })
    mkdirSync(join(w.iAgyOther, '.gemini', 'antigravity-cli'), { recursive: true })
    mkdirSync(join(w.iAgyOther, '.claude'), { recursive: true })
    writeFileSync(join(w.iAgyOther, '.gemini', 'config', 'hooks.json'), DEVELOPER_AGY_HOOK)
  })
  reg.define(/^install runs and then uninstall runs on each$/, (w: InstallWorld) => {
    const homes = [w.ihome!, w.iAgyOther!]
    for (const home of homes) {
      const run = (args: string[]): CliRun => { const saved = w.ihome!; w.ihome = home; try { return tcCli(w, args) } finally { w.ihome = saved } }
      const i = run(['install', '--yes', '--agent', 'agy'])
      expect(i.status, i.out).toBe(0)
      expect(readFileSync(join(home, '.gemini', 'config', 'hooks.json'), 'utf8')).toContain(`"${AGY_HOOK_NAME}"`)
      const u = run(['uninstall', '--yes', '--agent', 'agy'])
      expect(u.status, u.out).toBe(0)
    }
  })
  reg.define(/^the hooks file install created is gone$/, (w: InstallWorld) => {
    expect(existsSync(agyHooksFile(w))).toBe(false)
  })
  reg.define(/^the other hooks file holds the developer's named hook as it was, and nothing of treecontext's$/, (w: InstallWorld) => {
    expect(readFileSync(join(w.iAgyOther!, '.gemini', 'config', 'hooks.json'), 'utf8')).toBe(DEVELOPER_AGY_HOOK)
  })

  reg.define(/^an Antigravity CLI at 1\.5\.3 whose hooks file install created and wrote its named hook into, and install's own record since lost$/, async (w: InstallWorld) => {
    await agyAt(w, AGY_CAPTURE_FLOOR)
    w.irun = tcCli(w, ['install', '--yes', '--agent', 'agy'])
    expect(w.irun.status, w.irun.out).toBe(0)
    const record = join(w.ihome!, '.treecontext', 'install-state.json')
    expect(JSON.parse(readFileSync(record, 'utf8'))['agyHooks']).toBeDefined()
    rmSync(record)
  })
  reg.define(/^the hooks file holds nothing of treecontext's$/, (w: InstallWorld) => {
    const text = readFileSync(agyHooksFile(w), 'utf8')
    expect(ourAgyHook(JSON.parse(text) as Record<string, unknown>)).toBeUndefined()
    expect(w.irun!.stdout).toMatch(/known by its commands as treecontext's, no install record naming it/)
  })
  reg.define(/^the hooks file is still there, install's record no longer saying install created it$/, (w: InstallWorld) => {
    expect(existsSync(agyHooksFile(w))).toBe(true)
    const record = join(w.ihome!, '.treecontext', 'install-state.json')
    const created = existsSync(record) ? (JSON.parse(readFileSync(record, 'utf8')) as { createdFiles?: Record<string, unknown> }).createdFiles ?? {} : {}
    expect(Object.keys(created)).not.toContain(agyHooksFile(w))
  })

  reg.define(/^an Antigravity CLI at 1\.5\.3 whose hooks file holds treecontext's named hook, which the developer set to `enabled: false`$/, async (w: InstallWorld) => {
    await agyAt(w, AGY_CAPTURE_FLOOR, DEVELOPER_AGY_HOOK)
    w.irun = tcCli(w, ['install', '--yes', '--agent', 'agy'])
    expect(w.irun.status, w.irun.out).toBe(0)
    // The developer's off: one key, typed into treecontext's named hook.
    const text = readFileSync(agyHooksFile(w), 'utf8')
    writeFileSync(agyHooksFile(w), text.replace(`"${AGY_HOOK_NAME}": {`, `"${AGY_HOOK_NAME}": {\n    "enabled": false,`))
    expect(ourAgyHook(agyHooksOnDisk(w))!['enabled']).toBe(false)
    w.iDeveloperBefore = readFileSync(agyHooksFile(w), 'utf8')
  })
  reg.define(/^treecontext's named hook is still switched off$/, (w: InstallWorld) => {
    expect(ourAgyHook(agyHooksOnDisk(w))!['enabled']).toBe(false)
    expect(readFileSync(agyHooksFile(w), 'utf8')).toBe(w.iDeveloperBefore)
  })
  reg.define(/^the developer sees install say that capture on Antigravity CLI is switched off there by the developer$/, (w: InstallWorld) => {
    expect(w.irun!.stdout).toMatch(/your "enabled": false on the named hook "treecontext" is kept: agy runs it only once you turn it on/)
  })

  reg.define(/^an Antigravity CLI at 1\.5\.3 whose hooks file holds a treecontext named hook an earlier build wrote, wired for fewer events, beside the developer's own named hook$/, async (w: InstallWorld) => {
    await agyAt(w, AGY_CAPTURE_FLOOR)
    // The draft before the gate's recording (D417's comment): every event
    // this build wires but PostInvocation, with this build's commands.
    const { PostInvocation: _pi, ...earlier } = agyHooksBlockFor(w)
    const text = `{\n  "audit": { "Stop": [ { "type": "command", "command": "/usr/local/bin/audit {}", "budget": 9007199254740993 } ] },\n  "treecontext": ${JSON.stringify(earlier, null, 2).split('\n').join('\n  ')}\n}\n`
    writeFileSync(agyHooksFile(w), text)
    w.iDeveloperBefore = text
  })
  reg.define(/^treecontext's named hook is the one this build writes$/, (w: InstallWorld) => {
    expect(ourAgyHook(agyHooksOnDisk(w))).toEqual(agyHooksBlockFor(w))
  })
  reg.define(/^the developer's named hook reads as it was$/, (w: InstallWorld) => {
    const text = readFileSync(agyHooksFile(w), 'utf8')
    expect(text).toContain('"audit": { "Stop": [ { "type": "command", "command": "/usr/local/bin/audit {}", "budget": 9007199254740993 } ] }')
  })

  reg.define(/^the list of Antigravity CLI's hook events, kept with the agy version it was read from$/, (w: InstallWorld) => {
    const list = readClientEventList(AGY_LIST)
    ;(w as InstallWorld & { iEventList?: EventList }).iEventList = list
    expect(provenanceProblems(list, 'Antigravity CLI')).toEqual([])
    expect(list.version).toBe(AGY_CAPTURE_FLOOR)
  })
  reg.define(/^it is compared with the named hook install writes for Antigravity CLI$/, () => { /* the Thens compare */ })
  reg.define(/^every event install wires for Antigravity CLI is on the list$/, (w: InstallWorld) => {
    expect(unlistedWiredProblems((w as InstallWorld & { iEventList?: EventList }).iEventList!, AGY_LIST.wired())).toEqual([])
  })
  reg.define(/^PreToolUse is on the list as not wired, because its hook must decide the call's permission$/, (w: InstallWorld) => {
    const e = (w as InstallWorld & { iEventList?: EventList }).iEventList!.events.find((x) => x.event === 'PreToolUse')!
    expect(e.disposition).toBe('not-captured')
    expect(e.when).toMatch(/permission decision/)
  })
  reg.define(/^PostInvocation is on the list as wired, because a call's output is in agy's transcript only by the end of the model call that made it$/, (w: InstallWorld) => {
    const e = (w as InstallWorld & { iEventList?: EventList }).iEventList!.events.find((x) => x.event === 'PostInvocation')!
    expect(e.disposition).toBe('wired')
    expect(e.when).toMatch(/result step is in agy's transcript by the PostInvocation that follows its PostToolUse/)
    expect(AGY_LIST.wired()).toContain('PostInvocation')
  })


  // ── capture mode by the hooks (D386, D406, D413): the version rows ─────
  reg.define(/^install runs (at version (\d+\.\d+\.\d+)|as usual, its version reading (\d+\.\d+\.\d+))$/, async (w: InstallWorld, _how: unknown, codexV: unknown, agyV: unknown) => {
    if (w.iClient === 'Codex CLI') {
      if (codexV === '0.167.0') realCodexAt(w, '0.167.0')
      else setFakeCodex(w, { version: String(codexV), sandbox: { exit: 0, stderr: '' } })
    } else if (agyV !== AGY_CAPTURE_FLOOR) {
      // The stand-in agy's version, its `mcp list` handed to the real agy.
      const real = realAgy()
      rmSync(join(w.iAgyBin!, 'agy'), { force: true })
      writeFakeAgy(w.iAgyBin!, String(agyV), real)
    } else {
      agyReading(w, AGY_CAPTURE_FLOOR)
      expect(worldAgyVersion(w)).toBe(AGY_CAPTURE_FLOOR)
    }
    w.irun = tcCli(w, ['install', '--yes'])
    expect(w.irun.status, w.irun.out).toBe(0)
    if (w.iClient === 'Codex CLI' && codexV === '0.167.0') {
      // The developer's /hooks: Codex runs its hooks only once trusted.
      const trusted = await developerTrustsCodexHooks(w.ihome!, w.iproj ?? w.ihome!)
      expect(trusted.length).toBeGreaterThan(0)
    }
  })

  // ── the hook scripts every client's hooks run (D406, D413) ────────────
  reg.define(/^a machine with Codex CLI 0\.167\.0 installed and no other client$/, async (w: InstallWorld) => {
    await openInstallWorld(w, ['.codex'])
    setFakeCodex(w, { version: '0.167.0', sandbox: { exit: 0, stderr: '' } })
  })
  reg.define(/^a machine with Antigravity CLI 1\.5\.3 installed and no other client$/, async (w: InstallWorld) => {
    await agyAt(w, AGY_CAPTURE_FLOOR)
  })
  reg.define(/^a machine with Claude Code, Codex CLI 0\.167\.0 and Antigravity CLI 1\.5\.3 wired by install$/, async (w: InstallWorld) => {
    await openInstallWorld(w, ['.claude', '.codex'])
    setFakeCodex(w, { version: '0.167.0', sandbox: { exit: 0, stderr: '' } })
    seedAgyHome(w)
    setFakeAgy(w, AGY_CAPTURE_FLOOR)
    const run = tcCli(w, ['install', '--yes'])
    expect(run.status, run.out).toBe(0)
  })
  reg.define(/^uninstall runs naming Claude Code alone$/, (w: InstallWorld) => {
    w.irun = tcCli(w, ['uninstall', '--yes', '--agent', 'claude'])
  })
  reg.define(/^every hook script (Codex CLI's hooks|Antigravity CLI's named hook|Codex CLI's hooks and Antigravity CLI's named hook) run is there and runs$/, (w: InstallWorld, which: unknown) => {
    const files: string[] = []
    if (String(which).includes('Codex')) files.push(join(w.ihome!, '.codex', 'hooks.json'))
    if (String(which).includes('Antigravity')) files.push(agyHooksFile(w))
    // The scripts run this build compiled, as a global install places it.
    const unplace = placeBuiltPackage(w.ihome!)
    w.defer(unplace)
    for (const f of files) {
      const commands = commandsIn(JSON.parse(readFileSync(f, 'utf8')))
        .filter((c) => c.includes(join(w.ihome!, '.claude', 'hooks')))
      expect(commands.length, `${f} names no hook script of treecontext's`).toBeGreaterThanOrEqual(5)
      for (const c of commands) {
        const script = /"([^"]+)"/.exec(c)![1]!
        expect(existsSync(script), `${script}, named in ${f}, is not there`).toBe(true)
        // Run as the client runs it: through sh, the payload on stdin.
        const r = spawnSync('sh', ['-c', c], { input: '{}', env: sandboxedSpawnEnv(w.ihome!), encoding: 'utf8', timeout: 60_000 })
        expect(r.status, `${c}: ${r.stderr}`).toBe(0)
        if (f === agyHooksFile(w)) expect(r.stdout.trim()).toBe('{}')
      }
    }
  })

  // ── the Gemini CLI sweep leaves agy's hooks file (D399, D413) ─────────
  reg.define(/^Antigravity CLI 1\.5\.3 wired by install, its hooks file holding treecontext's named hook beside a hook of the developer's, and Gemini CLI's settings holding what an earlier install wrote for it$/, async (w: InstallWorld) => {
    await agyAt(w, AGY_CAPTURE_FLOOR, DEVELOPER_AGY_HOOK)
    const run = tcCli(w, ['install', '--yes', '--agent', 'agy'])
    expect(run.status, run.out).toBe(0)
    expect(ourAgyHook(agyHooksOnDisk(w))).toBeDefined()
    layEarlierGeminiInstall(w.ihome!, GEMINI_DEVELOPER, { wrappers: true })
    // The needle the Then denies is there before the sweep.
    expect(readFileSync(geminiSettingsFile(w), 'utf8')).toMatch(/treecontext|tc-/)
    w.iDeveloperBefore = readFileSync(agyHooksFile(w), 'utf8')
  })
  reg.define(/^uninstall runs naming Gemini CLI$/, (w: InstallWorld) => {
    w.irun = tcCli(w, ['uninstall', '--yes', '--agent', 'gemini'])
    expect(w.irun.status, w.irun.out).toBe(0)
  })
  reg.define(/^Antigravity CLI's hooks file is byte for byte as it was$/, (w: InstallWorld) => {
    expect(readFileSync(agyHooksFile(w), 'utf8')).toBe(w.iDeveloperBefore)
  })
  reg.define(/^Gemini CLI's settings hold nothing of treecontext's$/, (w: InstallWorld) => {
    const text = existsSync(geminiSettingsFile(w)) ? readFileSync(geminiSettingsFile(w), 'utf8') : '{}'
    // step-lint: allow unearned-absence -- the Given asserts this needle in the same file before the sweep
    expect(text).not.toMatch(/treecontext|tc-/)
    expect(geminiWrappers(w)).toEqual([])
  })

}
