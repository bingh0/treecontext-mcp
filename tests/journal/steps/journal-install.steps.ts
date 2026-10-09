import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect } from 'vitest'
import { type Registry } from 'gherkin-node-test/vitest'
import { spawnCli, spawnNodeTs } from '../../helpers/cli-spawn.js'
import { seedOrphanSidecar, storesDirIn } from '../../helpers/store-fixtures.js'
import { writeVerdict } from '../../../src/persistence/backup-verdict.js'
import { TS_ROOT } from '../proc.js'
import { claudeSessionStartUnwired } from '../../../src/server/installer.js'
import { type InstallWorld, tcCli, agentCli, openInstallWorld, treeOf, pathsMentioned, installedCommands, interpreterLoadsBinding, isBatchBody, toPosix, mcpLauncherIn, agentConfigPath, fakeGlobalInstall } from '../install-harness.js'

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
    w.irun = spawnNodeTs(w.iLinkedCommand!, ['doctor'], { home: w.ihome!, cwd: TS_ROOT })
  })

  reg.define(/^the subcommand prints its report$/, (w: InstallWorld) => {
    expect(w.irun!.stdout.trim(), 'the linked command printed nothing at all').not.toBe('')
    expect(w.irun!.stdout).toMatch(/treecontext doctor/)
    expect(w.irun!.stdout).toMatch(/better-sqlite3/)
  })

  reg.define(/^the command exits successfully$/, (w: InstallWorld) => {
    expect(w.irun!.status).toBe(0)
  })

  // ── the dry run is the whole plan ───────────────────────────────────
  reg.define(/^a machine with agents detected$/, async (w: InstallWorld) => {
    await openInstallWorld(w, ['.claude', '.gemini'])
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
      mkdirSync(join(realHome, '.gemini'), { recursive: true })
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
  reg.define(/^an agent config file that does not parse$/, async (w: InstallWorld) => {
    await openInstallWorld(w, ['.claude'])
    writeFileSync(join(w.ihome!, '.claude.json'), '{ this is not json at all')
  })

  reg.define(/^a fresh config is written with the treecontext entries$/, (w: InstallWorld) => {
    const cfg = JSON.parse(readFileSync(join(w.ihome!, '.claude.json'), 'utf8')) as Record<string, Record<string, unknown>>
    expect(cfg['mcpServers']?.['treecontext']).toBeDefined()
  })

  reg.define(/^the unparseable original is preserved as a backup beside it$/, (w: InstallWorld) => {
    const backups = readdirSync(w.ihome!).filter(f => f.startsWith('.claude.json') && f !== '.claude.json')
    expect(backups.length, 'the corrupt original was destroyed').toBeGreaterThan(0)
    const kept = backups.map(f => readFileSync(join(w.ihome!, f), 'utf8'))
    expect(kept.some(c => c.includes('this is not json at all')), 'no backup holds the original bytes').toBe(true)
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
  reg.define(/^a machine offering several interpreters, only one of which can load the native database binding$/, async (w: InstallWorld) => {
    await openInstallWorld(w, ['.claude'])
    // A `node` that runs but cannot load native modules — the shape of a
    // Homebrew node with no prebuild for this package.
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

  reg.define(/^the interpreter baked into the wrappers is one that loads the binding$/, (w: InstallWorld) => {
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
      expect(interpreterLoadsBinding(chosen), `the wrapper chose ${chosen}, which cannot load the binding`).toBe(true)
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
    expect(interpreterLoadsBinding(chosen), `the wrapper chose ${chosen}, which cannot load the binding`).toBe(true)
  })

  reg.define(/^the interpreters that cannot load it are not chosen$/, (w: InstallWorld) => {
    const wrapper = readFileSync(mcpLauncherIn(w.ihome!), 'utf8')
    expect(wrapper).not.toContain(w.iBadNode!)
  })

  // ── a bad interpreter is reported, not tolerated ────────────────────
  reg.define(/^an installation whose wrappers name an interpreter that cannot load the native database binding$/, async (w: InstallWorld) => {
    await openInstallWorld(w, ['.claude'])
    expect(tcCli(w, ['install', '--yes']).status).toBe(0)
    const badDir = join(w.ihome!, 'badbin')
    mkdirSync(badDir, { recursive: true })
    // A .cmd on Windows so it is genuinely spawnable and fails at the binding
    // rather than failing to start — the claim is about an interpreter that
    // RUNS and cannot load better-sqlite3.
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
    // when there is an agent AFTER the failure to check.
    await openInstallWorld(w, ['.claude', '.gemini', '.cursor'])
    // Denied by SHAPE, not by permission bits: a regular FILE sits where the
    // .gemini DIRECTORY must be, so every write beneath it fails ENOTDIR on
    // every platform. The agent is still DETECTED (existsSync is true for a
    // file), so the installer reaches the write and has to report the denial.
    //
    // The previous fixture chmod'ed the directory to 0o500, which NTFS does not
    // honour: on Windows the install simply succeeded and this scenario
    // reported "a failed install reported success" — asserting a property of
    // POSIX, not of the installer. Two other cross-platform forms were measured
    // and rejected: a directory at settings.json is RECOVERED from (the
    // installer treats it as corrupt JSON and backs it up — correct
    // behaviour), and a read-only settings.json is simply replaced, because the
    // write goes to a temp file and renames. Only removing the directory itself
    // denies the write everywhere. The shape form also drops the root caveat
    // the old fixture carried, since root cannot descend into a file either.
    rmSync(join(w.ihome!, '.gemini'), { recursive: true, force: true })
    writeFileSync(join(w.ihome!, '.gemini'), 'not a directory\n')
  })

  reg.define(/^the failure names the path and the permission problem$/, (w: InstallWorld) => {
    expect(w.irun!.status, 'a failed install reported success').not.toBe(0)
    // The load-bearing claim is that the denial is REPORTED and names the
    // path, not which errno the kernel chose. EISDIR is what a write to the
    // blocking directory yields; EACCES/EPERM are what a permission-denied
    // write yields. Pinning one spelling would make this a POSIX assertion.
    // Windows reports ENOENT for a write beneath a path that is a file; POSIX
    // reports ENOTDIR. The errno spelling is the platform's business — what
    // this pins is that a denial was REPORTED, and the `.gemini` assertion
    // below plus the non-zero status above pin which write it was.
    expect(w.irun!.out).toMatch(/ENOTDIR|ENOENT|EACCES|EPERM|not a directory|no such file|permission denied/i)
    expect(w.irun!.out).toMatch(/\.gemini/)
  })

  reg.define(/^every other detected agent is still wired completely$/, (w: InstallWorld) => {
    const cfg = JSON.parse(readFileSync(join(w.ihome!, '.claude.json'), 'utf8')) as Record<string, Record<string, unknown>>
    expect(cfg['mcpServers']?.['treecontext'], 'an agent BEFORE the failure lost its wiring').toBeDefined()
    const cursor = join(w.ihome!, '.cursor', 'mcp.json')
    expect(existsSync(cursor), 'an agent AFTER the failure never got wired').toBe(true)
    const cur = JSON.parse(readFileSync(cursor, 'utf8')) as Record<string, Record<string, unknown>>
    expect(cur['mcpServers']?.['treecontext']).toBeDefined()
  })

  reg.define(/^the install run exits non-zero$/, (w: InstallWorld) => {
    // Isolation is not forgiveness: the run carried on past the fault to
    // wire the other agents, then ended INSTALL_PARTIAL — `install &&
    // next-step` must stop here.
    expect(w.irun!.status, 'a partial install exited 0').not.toBe(0)
  })

  reg.define(/^no partial or temporary file is left at the unwritable path$/, (w: InstallWorld) => {
    // Nothing may have been created beside or beneath the blocker: .gemini is
    // still exactly the file the fixture wrote, and the atomic temp file the
    // installer names in its error must not survive anywhere in the home.
    expect(statSync(join(w.ihome!, '.gemini')).isFile(), '.gemini is no longer the blocking file').toBe(true)
    expect(readFileSync(join(w.ihome!, '.gemini'), 'utf8')).toBe('not a directory\n')
    // `.gemini` itself is the fixture; anything else named after it — a
    // sibling, a .bak, the atomic .tmp. the installer names in its error — is
    // a partial write that outlived the failure.
    const leftovers = treeOf(w.ihome!).filter(f => f !== '.gemini' && (f.startsWith('.gemini') || f.includes('.tmp.')))
    expect(leftovers, 'a partial or temp file survived the failed write').toEqual([])
  })

  // ── a forced reinstall rewrites only the agent it names ─────────────
  reg.define(/^a machine where install has wired two agents$/, async (w: InstallWorld) => {
    await openInstallWorld(w, ['.claude', '.cursor'])
    expect(tcCli(w, ['install', '--yes']).status).toBe(0)
  })

  reg.define(/^both agents' entries have since been hand-edited to a different absolute command$/, (w: InstallWorld) => {
    // An absolute command that exists is exactly the shape a plain
    // reinstall SKIPS (convergence repairs only drift) — so the restore
    // below is --force's doing, not convergence's.
    // Displace the entry with the hand edit and return a snapshot of
    // the CANONICAL entry it displaced — the restore assertion compares
    // against what install originally wrote, not the vandalism. (The
    // old helper was named `edit` and returned the pre-edit entry; a
    // mutator whose return value describes what it destroyed read as a
    // bug — E-review PLAUSIBLE nit, fixed at the pass-2 cleanup batch.)
    const displaceEntry = (path: string): string => {
      const cfg = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, unknown>>
      const canonical = cfg['mcpServers']!['treecontext'] as Record<string, unknown>
      cfg['mcpServers']!['treecontext'] = { ...canonical, command: process.execPath, args: [] }
      writeFileSync(path, JSON.stringify(cfg, null, 2))
      return JSON.stringify(canonical)
    }
    w.iCanonicalEntry = displaceEntry(join(w.ihome!, '.claude.json'))
    displaceEntry(join(w.ihome!, '.cursor', 'mcp.json'))
    w.iCursorBytes = readFileSync(join(w.ihome!, '.cursor', 'mcp.json'), 'utf8')
  })

  reg.define(/^install runs again with force naming only the first agent$/, (w: InstallWorld) => {
    w.irun = tcCli(w, ['install', '--yes', '--force', '--agent', 'claude'])
    expect(w.irun.status).toBe(0)
  })

  reg.define(/^the named agent's entry is restored to the canonical registration$/, (w: InstallWorld) => {
    const cfg = JSON.parse(readFileSync(join(w.ihome!, '.claude.json'), 'utf8')) as Record<string, Record<string, unknown>>
    const entry = cfg['mcpServers']!['treecontext'] as Record<string, unknown>
    expect(entry['command'], 'the hand-edit survived a forced reinstall').not.toBe(process.execPath)
    expect(JSON.stringify(entry)).toBe(w.iCanonicalEntry!)
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
  const unverifiedAgent = async (w: InstallWorld): Promise<void> => {
    await openInstallWorld(w, ['.claude'])
    mkdirSync(dirname(agentConfigPath('codex', w.ihome!)), { recursive: true })
  }
  const codexHooksJson = (w: InstallWorld): string => join(dirname(agentConfigPath('codex', w.ihome!)), 'hooks.json')

  reg.define(/^a detected agent whose capture adapter has never run against a live session$/, unverifiedAgent)

  reg.define(/^install runs without the experimental capture flag$/, (w: InstallWorld) => {
    w.irun = tcCli(w, ['install', '--yes'])
    expect(w.irun.status).toBe(0)
  })

  reg.define(/^the agent is wired for the MCP tools$/, (w: InstallWorld) => {
    const toml = readFileSync(agentConfigPath('codex', w.ihome!), 'utf8')
    expect(toml).toMatch(/^\[mcp_servers\.treecontext\]/m)
  })

  reg.define(/^no capture hooks are written for it$/, (w: InstallWorld) => {
    expect(existsSync(codexHooksJson(w))).toBe(false)
    const tables = [...readFileSync(agentConfigPath('codex', w.ihome!), 'utf8').matchAll(/^\[([^\]]+)\]/gm)].map(m => m[1]!)
    expect(tables.every(t => t.startsWith('mcp_servers')), `config.toml tables: ${tables.join(', ')}`).toBe(true)
  })

  reg.define(/^the same unverified agent$/, unverifiedAgent)

  reg.define(/^install runs with the experimental capture flag naming that agent$/, (w: InstallWorld) => {
    w.irun = tcCli(w, ['install', '--yes', '--agent', 'codex', '--experimental-capture'])
    expect(w.irun.status).toBe(0)
  })

  reg.define(/^its capture hooks are written$/, (w: InstallWorld) => {
    // Written: Codex's own hooks.json holds the copy, and doctor reads it
    // present and consistent with the block this build installs.
    expect(existsSync(codexHooksJson(w))).toBe(true)
    const copy = JSON.parse(readFileSync(codexHooksJson(w), 'utf8')) as { hooks?: Record<string, unknown> }
    expect(Object.keys(copy.hooks ?? {})).toEqual(expect.arrayContaining(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PreCompact', 'Stop']))
    const doctor = tcCli(w, ['doctor'])
    const row = doctor.stdout.split('\n').find(l => /^\[\w+\]\s+Codex CLI:/.test(l))
    expect(row, doctor.out).toMatch(/present and consistent with the Claude Code block/)
    // "Written" has to mean written RUNNABLE: every command the copy names
    // is a script install wrote, and each script's pinned interpreter and
    // module are absolute and exist — the same oracle the charter scenario
    // applies to the Claude scripts. The .ts twin is accepted for the reason
    // the charter step documents: this suite drives the TypeScript source.
    const named = [...JSON.stringify(copy).matchAll(/hooks(?:[\\/]|\\\\)+(tc-[a-z-]+)/g)].map(m => m[1]!)
    expect(named.length, 'the copy names no script').toBeGreaterThan(0)
    const ext = process.platform === 'win32' ? '.cmd' : ''
    for (const n of new Set(named)) {
      expect(existsSync(join(w.ihome!, '.claude', 'hooks', `${n}${ext}`)), `the copy runs ${n}, which install did not write`).toBe(true)
    }
    // The orientation reminder only prints text; every other script execs
    // an interpreter, and those are graded.
    const scripts = installedCommands(w.ihome!).filter(f => named.includes(f.source.replace(/\.cmd$/, '')))
    expect(new Set(scripts.map(s => s.source)).size, 'no script the copy runs could be graded').toBe(new Set(named).size - 1)
    for (const { source, command } of scripts) {
      expect(command, `bare interpreter in ${source}`).not.toBe('node')
      expect(isAbsolute(command), `not an absolute command in ${source}: ${command}`).toBe(true)
      const exists = existsSync(command)
        || (command.endsWith('.js') && existsSync(command.replace(/\.js$/, '.ts')))
      expect(exists, `command in ${source} does not exist: ${command}`).toBe(true)
    }
  })

  reg.define(/^the output states plainly that capture there is unverified$/, (w: InstallWorld) => {
    expect(w.irun!.out).toMatch(/unverified/i)
  })

  reg.define(/^a machine with an unverified agent detected$/, async (w: InstallWorld) => {
    await openInstallWorld(w, ['.claude'])
    mkdirSync(dirname(agentConfigPath('vscode', w.ihome!)), { recursive: true })
    w.iBefore = treeOf(w.ihome!)
  })

  reg.define(/^install runs with the experimental capture flag and no agent name$/, (w: InstallWorld) => {
    w.irun = tcCli(w, ['install', '--yes', '--experimental-capture'])
  })

  reg.define(/^the install is refused before anything is written$/, (w: InstallWorld) => {
    expect(w.irun!.status).not.toBe(0)
    expect(treeOf(w.ihome!)).toEqual(w.iBefore!)
  })

  reg.define(/^the refusal says the opt-in must name an agent$/, (w: InstallWorld) => {
    expect(w.irun!.out).toMatch(/--agent/)
    expect(w.irun!.out).toMatch(/name an agent|by name/i)
  })

  // ── doctor ──────────────────────────────────────────────────────────
  reg.define(/^a working installation$/, async (w: InstallWorld) => {
    await openInstallWorld(w, ['.claude'])
    expect(tcCli(w, ['install', '--yes']).status).toBe(0)
  })

  reg.define(/^doctor runs$/, (w: InstallWorld) => {
    w.irun = tcCli(w, ['doctor'])
  })

  reg.define(/^the native database binding is verified by opening a database, not by comparing versions$/, (w: InstallWorld) => {
    expect(w.irun!.out).toMatch(/better-sqlite3:.*(loaded and working|stale native binding|failed to load)/)
    // What this step does: it reads doctor's report on a healthy install.
    // The match above pins the binding row to one of doctor's three
    // verdicts; the match below pins this install's verdict as "loaded
    // and working". No broken-binding world runs here, so the step does
    // not show the verdict changing when an open fails.
    expect(w.irun!.out).toMatch(/native binding loaded and working/)
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

  // ── which build is which ────────────────────────────────────────────
  reg.define(/^a working installation where the command on PATH is a different build$/, async (w: InstallWorld) => {
    await openInstallWorld(w, ['.claude'])
    expect(tcCli(w, ['install', '--yes']).status).toBe(0)
    w.iOtherBuild = fakeGlobalInstall(w.ihome!, '9.9.9-rival')
  })

  reg.define(/^doctor runs with that command first on PATH$/, (w: InstallWorld) => {
    w.irun = spawnCli(['doctor'], {
      home: w.ihome!, cwd: TS_ROOT,
      env: { PATH: `${w.iOtherBuild!.bin}${delimiter}${process.env['PATH'] ?? ''}` },
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
    w.irun = spawnCli(['doctor'], { home: w.ihome!, cwd: TS_ROOT, env: { PATH: kept.join(delimiter) } })
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
      env: { PATH: `${w.iOtherBuild!.bin}${delimiter}${process.env['PATH'] ?? ''}` },
    })
    expect(run.status, run.out).toBe(0)
    w.irun = spawnCli(['doctor'], {
      home: w.ihome!, cwd: TS_ROOT,
      env: { PATH: `${w.iOtherBuild!.bin}${delimiter}${process.env['PATH'] ?? ''}` },
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
  reg.define(/^a machine with treecontext installed alongside foreign servers and hooks$/, async (w: InstallWorld) => {
    await openInstallWorld(w, ['.claude'])
    writeFileSync(join(w.ihome!, '.claude.json'), JSON.stringify({
      mcpServers: { 'foreign-server': { command: 'someone-elses-tool' } },
    }))
    expect(tcCli(w, ['install', '--yes']).status).toBe(0)
    // The positive half of the uninstall Then's absences: every entry it
    // proves gone is proven present here first, in this same world.
    const installed = JSON.parse(readFileSync(join(w.ihome!, '.claude.json'), 'utf8')) as Record<string, Record<string, unknown>>
    expect(installed['mcpServers']?.['treecontext'], 'install wrote no MCP entry').toBeDefined()
    expect(readFileSync(join(w.ihome!, '.claude', 'settings.json'), 'utf8'), 'install wrote no hook command').toMatch(/tc-/)
    expect(readdirSync(join(w.ihome!, '.claude', 'hooks')).filter(f => f.startsWith('tc-')).length, 'install wrote no hook script').toBeGreaterThan(0)
    expect(existsSync(join(w.ihome!, '.claude', 'skills', 'treecontext-reference')), 'install wrote no skill').toBe(true)
    // A store with a row in it — uninstall must not touch the record.
    const storeDir = join(storesDirIn(w.ihome!), 'keepme')
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(join(storeDir, 'treecontext.db'), 'journal bytes')
  })

  reg.define(/^uninstall runs$/, (w: InstallWorld) => {
    w.irun = tcCli(w, ['uninstall', '--yes'])
    expect(w.irun.status).toBe(0)
  })

  reg.define(/^every treecontext MCP entry, hook, script, and skill is gone from every agent$/, (w: InstallWorld) => {
    const cfg = JSON.parse(readFileSync(join(w.ihome!, '.claude.json'), 'utf8')) as Record<string, Record<string, unknown>>
    expect(cfg['mcpServers']?.['treecontext']).toBeUndefined()
    const settings = join(w.ihome!, '.claude', 'settings.json')
    // step-lint: allow unearned-absence -- guarded: the Given of this scenario asserts, after its install, that settings.json matches /tc-/, the MCP entry exists, tc- hook scripts exist and the skill exists — a before/after pair in this same world
    if (existsSync(settings)) expect(readFileSync(settings, 'utf8')).not.toMatch(/tc-/)
    const hooksDir = join(w.ihome!, '.claude', 'hooks')
    if (existsSync(hooksDir)) {
      expect(readdirSync(hooksDir).filter(f => f.startsWith('tc-'))).toEqual([])
    }
    expect(existsSync(join(w.ihome!, '.claude', 'skills', 'treecontext-reference'))).toBe(false)
  })

  reg.define(/^the foreign configuration is intact$/, (w: InstallWorld) => {
    const cfg = JSON.parse(readFileSync(join(w.ihome!, '.claude.json'), 'utf8')) as Record<string, Record<string, unknown>>
    expect(cfg['mcpServers']?.['foreign-server']).toEqual({ command: 'someone-elses-tool' })
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
}


