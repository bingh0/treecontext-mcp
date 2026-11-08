import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { spawnCli } from '../helpers/cli-spawn.js'

// Idle compaction through the real CLI (D290, D304, D338) in the corners the
// charter scenarios do not reach: no `claude` on PATH at all, and a client
// that reads the key on a machine where nothing is wired yet. Every run is in
// a redirected HOME with its own PATH; the settings file is read off disk.

const posix = process.platform !== 'win32'
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function sandbox(): string {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-idle-cli-')))
  dirs.push(home)
  mkdirSync(join(home, '.claude'), { recursive: true })
  return home
}

/** The real PATH with every directory holding a `claude` taken out. */
function pathWithoutClaude(): string {
  return (process.env['PATH'] ?? '').split(delimiter).filter((d) => {
    if (!d) return false
    try { return !readdirSync(d).some((f) => f === 'claude' || f.startsWith('claude.')) } catch { return true }
  }).join(delimiter)
}

function withClaude(home: string, output: string): string {
  const bin = join(home, 'fake-bin')
  mkdirSync(bin, { recursive: true })
  const f = join(bin, 'claude')
  writeFileSync(f, `#!/bin/sh\necho '${output}'\n`)
  chmodSync(f, 0o755)
  return `${bin}${delimiter}${pathWithoutClaude()}`
}

const settings = (home: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')) as Record<string, unknown>

describe.skipIf(!posix)('idle compaction through the CLI', () => {
  test('no claude on PATH: install writes nothing and says not applicable, doctor says version unknown', () => {
    const home = sandbox()
    const env = { PATH: pathWithoutClaude() }
    const install = spawnCli(['install', '--yes'], { home, env })
    expect(install.status, install.out).toBe(0)
    expect(install.stdout).toMatch(/idle compaction: not applicable to this client \(Claude Code version unknown/)
    expect(Object.hasOwn(settings(home), 'idleCompaction')).toBe(false)
    const doctor = spawnCli(['doctor'], { home, env })
    expect(doctor.stdout).toMatch(/^\[ok\]\s+Idle compaction: the setting is not read by this client, version unknown$/m)
  })

  test('a binary that prints no version is a client whose version cannot be read', () => {
    const home = sandbox()
    const env = { PATH: withClaude(home, 'hello') }
    const install = spawnCli(['install', '--yes'], { home, env })
    expect(install.stdout).toMatch(/idle compaction: not applicable to this client \(Claude Code version unknown/)
    expect(Object.hasOwn(settings(home), 'idleCompaction')).toBe(false)
  })

  test('nothing wired and a client that reads the key: doctor warns, its fix is install, and install clears it', () => {
    const home = sandbox()
    const env = { PATH: withClaude(home, '2.1.302 (Claude Code)') }
    const before = spawnCli(['doctor'], { home, env })
    const row = before.stdout.split('\n').findIndex((l) => /^\[warn\]\s+Idle compaction:/.test(l))
    expect(row, before.stdout).toBeGreaterThan(-1)
    expect(before.stdout.split('\n')[row + 1]).toBe('       fix: treecontext install')
    const install = spawnCli(['install', '--yes'], { home, env })
    expect(install.status, install.out).toBe(0)
    const after = spawnCli(['doctor'], { home, env })
    expect(after.stdout).toMatch(/^\[ok\]\s+Idle compaction: off in /m)
  })

  test('a dry run says what it would do and writes nothing', () => {
    const home = sandbox()
    const env = { PATH: withClaude(home, '2.1.302 (Claude Code)') }
    const dry = spawnCli(['install', '--yes', '--dry-run'], { home, env })
    expect(dry.status, dry.out).toBe(0)
    expect(dry.stdout).toMatch(/idle compaction: would turn off/)
    expect(readdirSync(join(home, '.claude'))).not.toContain('settings.json')
  })

  // ── D361: install's silence for the user's key, and uninstall's reading of install's record ──
  const withKey = (home: string, body: string): void => {
    writeFileSync(join(home, '.claude', 'settings.json'), body)
  }
  const stateFile = (home: string): string => join(home, '.treecontext', 'install-state.json')

  test('install then uninstall: the key install wrote is taken out, foreign settings stay, and the record is spent', () => {
    const home = sandbox()
    const env = { PATH: withClaude(home, '2.1.302 (Claude Code)') }
    withKey(home, '{"model":"opus","autoCompactEnabled":true}\n')
    const install = spawnCli(['install', '--yes'], { home, env })
    expect(install.status, install.out).toBe(0)
    expect(settings(home)['idleCompaction']).toBe(false)
    expect(JSON.parse(readFileSync(stateFile(home), 'utf8'))).toHaveProperty(['idleCompaction', join(home, '.claude', 'settings.json')])
    const uninstall = spawnCli(['uninstall', '--yes'], { home, env })
    expect(uninstall.status, uninstall.out).toBe(0)
    expect(uninstall.stdout).toMatch(/idle compaction setting that install wrote removed/)
    const after = settings(home)
    expect(Object.hasOwn(after, 'idleCompaction')).toBe(false)
    expect(after['model']).toBe('opus')
    expect(after['autoCompactEnabled']).toBe(true)
    expect(JSON.parse(readFileSync(stateFile(home), 'utf8'))).not.toHaveProperty('idleCompaction')
  })

  test('a false the user set: install says nothing and writes no record, uninstall leaves the key', () => {
    const home = sandbox()
    const env = { PATH: withClaude(home, '2.1.302 (Claude Code)') }
    withKey(home, '{"idleCompaction":false}\n')
    const install = spawnCli(['install', '--yes'], { home, env })
    expect(install.status, install.out).toBe(0)
    expect(install.stdout.split('\n').filter((l) => /idle.?compaction/i.test(l))).toEqual([])
    // The record file holds install's tool approvals (D390), and no
    // idle-compaction record: the key is the user's.
    const state = JSON.parse(readFileSync(stateFile(home), 'utf8')) as Record<string, unknown>
    expect(state).not.toHaveProperty('idleCompaction')
    const uninstall = spawnCli(['uninstall', '--yes'], { home, env })
    expect(uninstall.status, uninstall.out).toBe(0)
    expect(settings(home)['idleCompaction']).toBe(false)
  })

  test('install wrote it, the user flipped it to true: uninstall leaves the true, and the record is spent', () => {
    const home = sandbox()
    const env = { PATH: withClaude(home, '2.1.302 (Claude Code)') }
    expect(spawnCli(['install', '--yes'], { home, env }).status).toBe(0)
    expect(settings(home)['idleCompaction']).toBe(false)
    const flipped = { ...settings(home), idleCompaction: true }
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(flipped, null, 2))
    const uninstall = spawnCli(['uninstall', '--yes'], { home, env })
    expect(uninstall.status, uninstall.out).toBe(0)
    expect(settings(home)['idleCompaction']).toBe(true)
    expect(uninstall.stdout).not.toMatch(/idle compaction setting that install wrote removed/)
    expect(JSON.parse(readFileSync(stateFile(home), 'utf8'))).not.toHaveProperty('idleCompaction')
  })

  test('a later install says nothing about the key it wrote on an earlier run', () => {
    const home = sandbox()
    const env = { PATH: withClaude(home, '2.1.302 (Claude Code)') }
    expect(spawnCli(['install', '--yes'], { home, env }).stdout).toMatch(/idle compaction: turned off/)
    const again = spawnCli(['install', '--yes'], { home, env })
    expect(again.stdout.split('\n').filter((l) => /idle.?compaction/i.test(l))).toEqual([])
  })

  test('a settings file with a trailing comma: the true the user set stays true, model survives, install says nothing about it', () => {
    const home = sandbox()
    const env = { PATH: withClaude(home, '2.1.302 (Claude Code)') }
    withKey(home, '{\n  "model": "opus",\n  "idleCompaction": true,\n}\n')
    const install = spawnCli(['install', '--yes'], { home, env })
    expect(install.status, install.out).toBe(0)
    expect(install.stdout.split('\n').filter((l) => /idle.?compaction/i.test(l))).toEqual([])
    const after = settings(home)
    expect(after['idleCompaction']).toBe(true)
    expect(after['model']).toBe('opus')
    expect(after['hooks']).toBeDefined()
    const doctor = spawnCli(['doctor'], { home, env })
    expect(doctor.stdout).toMatch(/^\[warn\]\s+Idle compaction: on; treecontext recommends off/m)
  })
})

