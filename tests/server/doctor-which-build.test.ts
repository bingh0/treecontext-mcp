/**
 * Doctor's "which build is which" rows, at the unit level: the shim reader
 * against every shape npm writes, and the two row builders against every
 * state they can land in. The charter scenarios (journal-install.feature,
 * "doctor names the build the command on PATH would run" and "doctor says
 * so when the command is on no PATH at all") drive the real doctor through
 * a real PATH; this file pins the reader and the wording on fixtures the
 * scenarios cannot cheaply reach — a dead target, an unreadable shim, a
 * launcher pinned to another build.
 *
 * Pure functions only, so no HOME redirect: nothing here evaluates a path
 * from homedir().
 */
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

import { shimTarget, buildIdentity, commandOnPathRow, wiredBuildRow } from '../../src/server/installer.js'

const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-which-build-')))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

/** A stub package: package.json + an entry point that exists. */
function stubPackage(root: string, version: string, name = 'treecontext'): string {
  mkdirSync(join(root, 'dist', 'server'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name, version }))
  const cli = join(root, 'dist', 'server', 'cli.js')
  writeFileSync(cli, '// stub\n')
  return cli
}

const CMD_SHIM = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\treecontext\\dist\\server\\cli.js" %*', '',
].join('\r\n')

const SH_SHIM = [
  '#!/bin/sh',
  'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
  '',
  'case `uname` in',
  '    *CYGWIN*|*MINGW*|*MSYS*)',
  '        if command -v cygpath > /dev/null 2>&1; then',
  '            basedir=`cygpath -w "$basedir"`',
  '        fi',
  '    ;;',
  'esac',
  '',
  'if [ -x "$basedir/node" ]; then',
  '  exec "$basedir/node"  "$basedir/node_modules/treecontext/dist/server/cli.js" "$@"',
  'else ',
  '  exec node  "$basedir/node_modules/treecontext/dist/server/cli.js" "$@"',
  'fi',
  '',
].join('\n')

const PS1_SHIM = [
  '#!/usr/bin/env pwsh',
  '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent',
  '$exe=""',
  'if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) { $exe=".exe" }',
  'if (Test-Path "$basedir/node$exe") {',
  '  & "$basedir/node$exe"  "$basedir/node_modules/treecontext/dist/server/cli.js" $args',
  '} else {',
  '  & "node$exe"  "$basedir/node_modules/treecontext/dist/server/cli.js" $args',
  '}',
  '',
].join('\n')

describe('shimTarget: the entry point behind a command shim', () => {
  const prefix = join(tmp, 'prefix')
  const expected = resolve(prefix, ['node_modules', 'treecontext', 'dist', 'server', 'cli.js'].join(sep))

  it('reads the .cmd shim past its own node.exe probe', () => {
    mkdirSync(prefix, { recursive: true })
    const shim = join(prefix, 'treecontext.cmd')
    writeFileSync(shim, CMD_SHIM)
    expect(shimTarget(shim)).toBe(expected)
  })

  it('reads the sh shim npm writes beside it', () => {
    const shim = join(prefix, 'treecontext')
    writeFileSync(shim, SH_SHIM)
    expect(shimTarget(shim)).toBe(expected)
  })

  it('reads the .ps1 shim', () => {
    const shim = join(prefix, 'treecontext.ps1')
    writeFileSync(shim, PS1_SHIM)
    expect(shimTarget(shim)).toBe(expected)
  })

  it.skipIf(process.platform === 'win32')('follows a symlink to its real path', () => {
    const cli = stubPackage(join(tmp, 'linked', 'lib', 'node_modules', 'treecontext'), '1.0.0')
    const bin = join(tmp, 'linked', 'bin')
    mkdirSync(bin, { recursive: true })
    symlinkSync(join('..', 'lib', 'node_modules', 'treecontext', 'dist', 'server', 'cli.js'), join(bin, 'treecontext'))
    expect(shimTarget(join(bin, 'treecontext'))).toBe(cli)
  })

  it.skipIf(process.platform === 'win32')('returns a dangling symlink target rather than nothing', () => {
    const bin = join(tmp, 'dangling')
    mkdirSync(bin, { recursive: true })
    symlinkSync(join('..', 'gone', 'cli.js'), join(bin, 'treecontext'))
    expect(shimTarget(join(bin, 'treecontext'))).toBe(resolve(tmp, 'gone', 'cli.js'))
  })

  it('pins nothing for a body it does not know, and for a file that is not there', () => {
    const shim = join(prefix, 'treecontext-hand-rolled')
    writeFileSync(shim, '#!/bin/sh\nexec /somewhere/else/treecontext "$@"\n')
    expect(shimTarget(shim)).toBeNull()
    expect(shimTarget(join(prefix, 'absent'))).toBeNull()
  })
})

describe('buildIdentity: the package an entry point belongs to', () => {
  it('reads name, version and root two levels above the entry point', () => {
    const root = join(tmp, 'id', 'pkg')
    const cli = stubPackage(root, '0.1.0-rc.6')
    expect(buildIdentity(cli)).toEqual({ cli, root, name: 'treecontext', version: '0.1.0-rc.6' })
  })

  it('identifies a package whose entry point is absent — a checkout under tsx has cli.ts, not cli.js', () => {
    const root = join(tmp, 'id', 'src-only')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'treecontext', version: '0.1.0-rc.7' }))
    const cli = join(root, 'src', 'server', 'cli.js')
    expect(buildIdentity(cli)).toEqual({ cli, root, name: 'treecontext', version: '0.1.0-rc.7' })
  })

  it('is null for a root with no package.json', () => {
    expect(buildIdentity(join(tmp, 'id', 'nowhere', 'dist', 'server', 'cli.js'))).toBeNull()
    const bare = join(tmp, 'id', 'bare', 'dist', 'server')
    mkdirSync(bare, { recursive: true })
    writeFileSync(join(bare, 'cli.js'), '')
    expect(buildIdentity(join(bare, 'cli.js'))).toBeNull()
  })
})

describe('commandOnPathRow: the build the shell would run', () => {
  const selfRoot = join(tmp, 'self', 'checkout')
  const selfCli = stubPackage(selfRoot, '0.1.0-rc.7')

  it('names this build and says the command is absent when PATH has none', () => {
    const row = commandOnPathRow([], selfCli)
    expect(row.status).toBe('warn')
    expect(row.detail).toContain('no `treecontext` command on PATH')
    expect(row.detail).toContain(`v0.1.0-rc.7 at ${selfRoot}`)
    // A checkout's way onto PATH is a global install of itself — which npm
    // 7+ LINKS, and which only puts a bin link down if dist/ is built.
    expect(row.fix).toContain(`npm install -g "${selfRoot}"`)
    expect(row.fix).toContain('links this checkout')
    expect(row.fix).toContain('build it first')
    // Under tsx the entry point is cli.ts, so the by-hand command must not name a file that is not there.
    expect(row.fix).toContain(`node "${selfCli}"`)
  })

  it('tells a global install whose bin directory is off PATH which directory that is', () => {
    // npm's own prefix names: `<prefix>/lib/node_modules` on POSIX, and on
    // Windows %APPDATA%\npm\node_modules — the `npm` directory is part of
    // the shape, and the layout guard reads it (a project-local
    // node_modules must not qualify).
    const prefix = process.platform === 'win32' ? join(tmp, 'self', 'npm') : join(tmp, 'self', 'gprefix')
    const root = process.platform === 'win32'
      ? join(prefix, 'node_modules', 'treecontext')
      : join(prefix, 'lib', 'node_modules', 'treecontext')
    const cli = stubPackage(root, '0.1.0-rc.7')
    const row = commandOnPathRow([], cli)
    expect(row.status).toBe('warn')
    expect(row.fix).toContain(`add ${process.platform === 'win32' ? prefix : join(prefix, 'bin')} to PATH`)
  })

  it('reads a global install under the published name, treecontext-mcp, the same way', () => {
    // The fixture above is the release-candidate layout (`treecontext`);
    // from 0.1.0-beta.1 npm installs the package as `treecontext-mcp`. The
    // command is `treecontext` either way, and the layout guard reads the
    // shape, not the name.
    const prefix = process.platform === 'win32' ? join(tmp, 'self-mcp', 'npm') : join(tmp, 'self-mcp', 'gprefix')
    const root = process.platform === 'win32'
      ? join(prefix, 'node_modules', 'treecontext-mcp')
      : join(prefix, 'lib', 'node_modules', 'treecontext-mcp')
    const cli = stubPackage(root, '0.1.0-beta.1', 'treecontext-mcp')
    const row = commandOnPathRow([], cli)
    expect(row.status).toBe('warn')
    expect(row.fix).toContain(`add ${process.platform === 'win32' ? prefix : join(prefix, 'bin')} to PATH`)
  })

  it('is ok when the shim leads back to this build', () => {
    const bin = join(tmp, 'self', 'bin')
    mkdirSync(bin, { recursive: true })
    const shim = join(bin, 'treecontext')
    // A shim body pointing (relative to bin) at this build's own entry point.
    const rel = ['..', 'checkout', 'dist', 'server', 'cli.js'].join('/')
    writeFileSync(shim, `#!/bin/sh\nbasedir=$(dirname "$0")\nexec node  "$basedir/${rel}" "$@"\n`)
    const row = commandOnPathRow([shim], selfCli)
    expect(row.status).toBe('ok')
    expect(row.detail).toBe(`${shim} → this build (v0.1.0-rc.7)`)
    // The one state in which a fix may be spelled `treecontext`.
    expect(row.reachesThisBuild).toBe(true)
  })

  it('does not mistake a project-local node_modules for a global layout', () => {
    // `node node_modules/treecontext/dist/server/cli.js doctor` in some
    // project: root/../../../bin would be /bin — nonsense to add to PATH.
    const cli = stubPackage(join(tmp, 'proj', 'node_modules', 'treecontext'), '0.1.0-rc.7')
    const row = commandOnPathRow([], cli)
    expect(row.fix?.startsWith('npm install -g "'), row.fix).toBe(true)
  })

  it('names both builds, by version and root, when the shim runs another one — and ranks neither', () => {
    const otherRoot = join(tmp, 'other', 'lib', 'node_modules', 'treecontext')
    const otherCli = stubPackage(otherRoot, '2.0.0')
    const bin = join(tmp, 'other', 'bin')
    mkdirSync(bin, { recursive: true })
    const shim = join(bin, 'treecontext')
    writeFileSync(shim, `#!/bin/sh\nbasedir=$(dirname "$0")\nexec node  "$basedir/../lib/node_modules/treecontext/dist/server/cli.js" "$@"\n`)
    const row = commandOnPathRow([shim], selfCli)
    expect(row.status).toBe('warn')
    expect(row.detail).toContain(`${shim} runs treecontext v2.0.0 at ${otherRoot}`)
    expect(row.detail).toContain(`this report comes from v0.1.0-rc.7 at ${selfRoot}`)
    // Named, never ranked — asserted in the positive. The negative needle
    // this line once carried (`not.toMatch(/newer|older|…/)`) fired on
    // macOS, where the temp root is /private/var/f-OLDER-s: the exact
    // unearned-absence shape the step-source lint refuses in step files.
    expect(row.detail).toContain('gets the v2.0.0 build')
    expect(row.reachesThisBuild).toBe(false)
    // The way out leads with the one command that clears it, warns that a
    // rival bin directory ahead of npm's on PATH would keep winning, and
    // offers the other build's own doctor for an audit first.
    expect(row.fix?.startsWith(`npm install -g "${selfRoot}"`), row.fix).toBe(true)
    expect(row.fix).toContain(`precedes ${bin} on PATH`)
    expect(row.fix).toContain(`node "${otherCli}" doctor`)
  })

  it('names a rival installed under the published name by that name', () => {
    const otherRoot = join(tmp, 'other-mcp', 'lib', 'node_modules', 'treecontext-mcp')
    stubPackage(otherRoot, '2.0.0', 'treecontext-mcp')
    const bin = join(tmp, 'other-mcp', 'bin')
    mkdirSync(bin, { recursive: true })
    const shim = join(bin, 'treecontext')
    writeFileSync(shim, `#!/bin/sh\nbasedir=$(dirname "$0")\nexec node  "$basedir/../lib/node_modules/treecontext-mcp/dist/server/cli.js" "$@"\n`)
    const row = commandOnPathRow([shim], selfCli)
    expect(row.status).toBe('warn')
    expect(row.detail).toContain(`${shim} runs treecontext-mcp v2.0.0 at ${otherRoot}`)
  })

  it('names the copy, not the number, when the rival is the same version elsewhere', () => {
    const twinRoot = join(tmp, 'twin', 'lib', 'node_modules', 'treecontext')
    stubPackage(twinRoot, '0.1.0-rc.7')
    const bin = join(tmp, 'twin', 'bin')
    mkdirSync(bin, { recursive: true })
    const shim = join(bin, 'treecontext')
    writeFileSync(shim, `#!/bin/sh\nbasedir=$(dirname "$0")\nexec node  "$basedir/../lib/node_modules/treecontext/dist/server/cli.js" "$@"\n`)
    const row = commandOnPathRow([shim], selfCli)
    // Two builds, no defect — the maintainer's dogfood layout. Reported,
    // never warned about (the repo's no-nag rule), and NOT "this build":
    // a fix typed as `treecontext` would reach the other copy.
    expect(row.status).toBe('ok')
    expect(row.detail).toContain(`runs a different copy of v0.1.0-rc.7, at ${twinRoot}`)
    expect(row.reachesThisBuild).toBe(false)
  })

  it('reports a shim whose target is gone', () => {
    const bin = join(tmp, 'dead', 'bin')
    mkdirSync(bin, { recursive: true })
    const shim = join(bin, 'treecontext')
    writeFileSync(shim, `#!/bin/sh\nbasedir=$(dirname "$0")\nexec node  "$basedir/../lib/node_modules/treecontext/dist/server/cli.js" "$@"\n`)
    const row = commandOnPathRow([shim], selfCli)
    expect(row.status).toBe('warn')
    expect(row.detail).toContain('which no longer exists')
    expect(row.detail).toContain(resolve(bin, '..', 'lib', 'node_modules', 'treecontext', 'dist', 'server', 'cli.js'))
    // Measured: `npm install -g <root>` replaces a dangling shim; `npm
    // uninstall -g` leaves it ("up to date"), so it is not offered.
    expect(row.fix?.startsWith(`npm install -g "${selfRoot}"`), row.fix).toBe(true)
    expect(row.fix).toContain(`${process.platform === 'win32' ? 'del' : 'rm'} "${shim}"`)
  })

  // A shim this reader cannot follow (Volta's binary, an asdf or pnpm
  // script) is ASKED: doctor runs it with --version, as the user would.
  const opaque = (name: string, body: string): string => {
    const bin = join(tmp, 'opaque', name)
    mkdirSync(bin, { recursive: true })
    const shim = join(bin, process.platform === 'win32' ? 'treecontext.cmd' : 'treecontext')
    writeFileSync(shim, body, { mode: 0o755 })
    return shim
  }
  const printing = (version: string): string => process.platform === 'win32'
    ? `@echo off\r\necho treecontext ${version} 1>&2\r\n`
    : `#!/bin/sh\necho "treecontext ${version}" >&2\n`   // printVersion writes to stderr

  it('asks an unreadable shim, and is ok when it answers with this version', () => {
    const row = commandOnPathRow([opaque('same', printing('0.1.0-rc.7'))], selfCli)
    expect(row.status).toBe('ok')
    expect(row.detail).toContain('reports v0.1.0-rc.7, the same version as this build')
    // The same VERSION is not the same COPY: no fix may be spelled `treecontext`.
    expect(row.reachesThisBuild).toBe(false)
  })

  it('asks an unreadable shim, and names both versions when it answers with another', () => {
    const shim = opaque('other', printing('2.0.0'))
    const row = commandOnPathRow([shim], selfCli)
    expect(row.status).toBe('warn')
    expect(row.detail).toContain(`${shim} reports v2.0.0`)
    expect(row.detail).toContain('this report comes from v0.1.0-rc.7')
    expect(row.fix?.startsWith(`npm install -g "${selfRoot}"`), row.fix).toBe(true)
  })

  it('reports an unreadable shim that fails to run as a failing command, with the replacement as the fix', () => {
    const shim = opaque('broken', process.platform === 'win32'
      ? '@echo off\r\nexit /b 127\r\n'
      : '#!/bin/sh\nexec /opt/somewhere/treecontext "$@"\n')
    const row = commandOnPathRow([shim], selfCli)
    expect(row.status).toBe('warn')
    expect(row.detail).toContain('running it failed')
    expect(row.fix?.startsWith(`npm install -g "${selfRoot}"`), row.fix).toBe(true)
  })

  it('grades the first shim the shell listed — that is the one the shell runs', () => {
    // `where` lists several on Windows; the first on PATH wins there as here.
    const bin = join(tmp, 'order', 'bin')
    mkdirSync(bin, { recursive: true })
    const first = join(bin, 'treecontext')
    writeFileSync(first, `#!/bin/sh\nbasedir=$(dirname "$0")\nexec node  "$basedir/../checkout/dist/server/cli.js" "$@"\n`)
    const second = join(bin, 'treecontext.cmd')
    writeFileSync(second, `#!/bin/sh\nbasedir=$(dirname "$0")\nexec node  "$basedir/../elsewhere/dist/server/cli.js" "$@"\n`)
    stubPackage(join(tmp, 'order', 'checkout'), '0.1.0-rc.7')
    stubPackage(join(tmp, 'order', 'elsewhere'), '3.3.3')
    const row = commandOnPathRow([first, second], selfCli)
    expect(row.status).toBe('ok')
    expect(row.detail).toContain(`${first} runs a different copy of v0.1.0-rc.7`)
  })
})

describe('wiredBuildRow: the build the agent talks to', () => {
  const selfCli = stubPackage(join(tmp, 'wired', 'self'), '0.1.0-rc.7')
  const otherCli = stubPackage(join(tmp, 'wired', 'other', 'ts'), '2.0.0')
  const posixBody = (cli: string): string => `#!/bin/sh\nTC_NODE="/usr/bin/node"\nTC_CLI="${cli}"\nexec "$TC_NODE" "$TC_CLI" "$@"\n`
  const cmdBody = (cli: string): string => `@echo off\r\nset "TC_NODE=C:\\node.exe"\r\nset "TC_CLI=${cli}"\r\n"%TC_NODE%" "%TC_CLI%" %*\r\n`

  it('is ok when the launcher pins this build', () => {
    const row = wiredBuildRow(posixBody(selfCli), selfCli, 'treecontext')
    expect(row?.status).toBe('ok')
    expect(row?.detail).toContain('run this build (v0.1.0-rc.7)')
  })

  it('names the other build and spells the fix with the command that reaches this one', () => {
    const row = wiredBuildRow(posixBody(otherCli), selfCli, `node "${selfCli}"`)
    expect(row?.status).toBe('warn')
    expect(row?.detail).toContain(`runs treecontext v2.0.0 at ${join(tmp, 'wired', 'other', 'ts')}`)
    expect(row?.detail).toContain('not this build (v0.1.0-rc.7')
    expect(row?.detail).toContain('your agent talks to it')
    // PATH does not reach this build, so the fix must not say `treecontext`.
    expect(row?.fix?.startsWith(`node "${selfCli}" install --force`), row?.fix).toBe(true)
  })

  it('reports, never warns about, a same-version copy owning the wiring', () => {
    const twinCli = stubPackage(join(tmp, 'wired', 'twin'), '0.1.0-rc.7')
    const row = wiredBuildRow(posixBody(twinCli), selfCli, `node "${selfCli}"`)
    expect(row?.status).toBe('ok')
    expect(row?.detail).toContain(`run a different copy of v0.1.0-rc.7, at ${join(tmp, 'wired', 'twin')}`)
  })

  it('reads the batch dialect too', () => {
    const row = wiredBuildRow(cmdBody(otherCli), selfCli, 'treecontext')
    expect(row?.status).toBe('warn')
    expect(row?.fix).toMatch(/^treecontext install --force/)
  })

  it('leaves an unpinned launcher to the existence grader', () => {
    // A vanished pin is graded in doctor-wired-fallback.test.ts, under a
    // redirected HOME: where the launcher's search lands depends on it.
    expect(wiredBuildRow('#!/bin/sh\nexec node "$TC_CLI"\n', selfCli, 'treecontext')).toBeNull()
  })
})
