import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { applyIdleCompaction, upsertClaudeSettingsHooks } from '../../src/server/installer.js'
import {
  decideIdleCompaction, idleCompactionRow, idleCompactionSupport, idleCompactionOf, installLine,
  parseClaudeVersion, parseTolerantJson, readClaudeVersion, readIdleCompaction, withIdleCompactionOff,
} from '../../src/server/idle-compaction.js'

// The version parse and the floors (D290, D304, D338): 2.1.290 reads the key,
// 2.1.302 adds the /config row, and nothing readable is a version.

describe('parseClaudeVersion', () => {
  test.each([
    ['2.1.289 (Claude Code)\n', '2.1.289'],
    ['2.1.302', '2.1.302'],
    ['claude v10.0.7-beta', '10.0.7'],
  ])('%j reads %s', (text, v) => expect(parseClaudeVersion(text)).toBe(v))

  test.each([[''], ['unknown'], ['2.1'], ['1.2.3.4'], [null], [undefined]])('%j cannot be read', (text) => {
    expect(parseClaudeVersion(text as string | null | undefined)).toBeNull()
  })
})

describe('idleCompactionSupport', () => {
  test.each([
    ['2.1.289', 'below-floor'],
    ['2.1.290', 'settings-line'],
    ['2.1.295', 'settings-line'],
    ['2.1.301', 'settings-line'],
    ['2.1.302', 'config-row'],
    ['2.1.316', 'config-row'],
    ['2.2.0', 'config-row'],
    ['3.0.0', 'config-row'],
    ['2.0.999', 'below-floor'],
    ['2.1.99', 'below-floor'],
    ['2.1.1000', 'config-row'],
    ['garbage', 'unreadable'],
    [null, 'unreadable'],
  ])('%s is %s', (v, support) => expect(idleCompactionSupport(v)).toBe(support))
})

describe('the setting and the decision', () => {
  test('only false is off and only true is on; anything else is the user\'s', () => {
    expect(idleCompactionOf({})).toEqual({ state: 'absent' })
    expect(idleCompactionOf({ idleCompaction: false })).toEqual({ state: 'off' })
    expect(idleCompactionOf({ idleCompaction: true })).toEqual({ state: 'on' })
    expect(idleCompactionOf({ idleCompaction: 'false' })).toEqual({ state: 'other', value: '"false"' })
    expect(idleCompactionOf({ idleCompaction: null })).toEqual({ state: 'other', value: 'null' })
  })

  test('install writes only an absent key, only for a client that reads it', () => {
    const absent = { state: 'absent' } as const
    expect(decideIdleCompaction('2.1.290', absent).action).toBe('write-off')
    expect(decideIdleCompaction('2.1.302', absent).action).toBe('write-off')
    expect(decideIdleCompaction('2.1.289', absent).action).toBe('not-applicable')
    expect(decideIdleCompaction(null, absent).action).toBe('not-applicable')
    // a key the user set is left in silence, whatever it is (D361)
    expect(decideIdleCompaction('2.1.302', { state: 'on' }).action).toBe('leave-quiet')
    expect(decideIdleCompaction('2.1.295', { state: 'on' }).action).toBe('leave-quiet')
    expect(decideIdleCompaction('2.1.302', { state: 'off' }).action).toBe('leave-quiet')
    expect(decideIdleCompaction('2.1.302', { state: 'other', value: '1' }).action).toBe('leave-quiet')
    expect(decideIdleCompaction('2.1.302', { state: 'unreadable' }).action).toBe('unreadable-file')
  })

  test('the merge adds the key and nothing else, and never replaces one that is there', () => {
    expect(withIdleCompactionOff({ model: 'x', hooks: { a: 1 } })).toEqual({ model: 'x', hooks: { a: 1 }, idleCompaction: false })
    expect(withIdleCompactionOff({ idleCompaction: true })).toBeNull()
    expect(withIdleCompactionOff({ idleCompaction: false })).toBeNull()
  })
})

describe('the words', () => {
  const path = '/h/.claude/settings.json'

  test('the /config row appears from 2.1.302 and never before (install, key absent)', () => {
    const at302 = installLine({ action: 'write-off' }, '2.1.302', path, false)!
    expect(at302).toContain('turned off')
    expect(at302).toContain("the client's /config row")
    // D338's install half: 2.1.295 honors the key and has no row
    const at295 = installLine({ action: 'write-off' }, '2.1.295', path, false)!
    expect(at295).toContain('turned off')
    expect(at295).toContain('"idleCompaction": true')
    expect(at295).not.toContain('/config')
    const at290 = installLine({ action: 'write-off' }, '2.1.290', path, false)!
    expect(at290).not.toContain('/config')
    const at301 = installLine({ action: 'write-off' }, '2.1.301', path, false)!
    expect(at301).not.toContain('/config')
  })

  test("doctor's remedy: settings line alone for 2.1.295 with the key on, the /config row first from 2.1.302", () => {
    const warn295 = idleCompactionRow('2.1.295', { state: 'on' }, path)
    expect(warn295.status).toBe('warn')
    expect(warn295.fix).toBe(`set "idleCompaction": false in ${path}`)
    expect(warn295.fix).not.toContain('/config')
    const warn302 = idleCompactionRow('2.1.302', { state: 'on' }, path)
    expect(warn302.fix!.indexOf('/config')).toBeGreaterThanOrEqual(0)
    expect(warn302.fix!.indexOf('/config')).toBeLessThan(warn302.fix!.indexOf('"idleCompaction": false'))
  })

  test('the unreadable-version line asserts only what is known', () => {
    const line = installLine({ action: 'not-applicable', version: null }, null, path, false)!
    expect(line).toBe('  idle compaction: not applicable to this client (Claude Code version unknown; the setting is read from 2.1.290)')
    expect(line).not.toContain('does not read')
    expect(installLine({ action: 'not-applicable', version: '2.1.289' }, '2.1.289', path, false)).toContain('version 2.1.289 does not read')
  })

  test('doctor names a client that does not read the key, and which file the off row speaks for', () => {
    expect(idleCompactionRow('2.1.289', { state: 'absent' }, path).detail).toBe('the setting is not read by this client, version 2.1.289')
    expect(idleCompactionRow(null, { state: 'absent' }, path).detail).toBe('the setting is not read by this client, version unknown')
    const off = idleCompactionRow('2.1.302', { state: 'off' }, path)
    expect(off.status).toBe('ok')
    expect(off.detail.startsWith(`off in ${path} (only that file was read`)).toBe(true)
  })

  test('a key the user set is not mentioned at install', () => {
    expect(installLine({ action: 'leave-quiet' }, '2.1.302', path, false)).toBeNull()
  })
})

describe('applyIdleCompaction on a settings file', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
  const fileWith = (body: string | null): string => {
    const d = mkdtempSync(join(tmpdir(), 'tc-idle-'))
    dirs.push(d)
    mkdirSync(join(d, '.claude'))
    const p = join(d, '.claude', 'settings.json')
    if (body !== null) writeFileSync(p, body)
    return p
  }
  const read = (p: string): Record<string, unknown> => JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>

  test('absent file and absent key: the file is made, carrying the key off', () => {
    const p = fileWith(null)
    expect(applyIdleCompaction(p, '2.1.302', false).written).toBe(true)
    expect(read(p)).toEqual({ idleCompaction: false })
  })

  test('absent key beside foreign settings: they survive', () => {
    const p = fileWith('{"model":"opus","permissions":{"allow":["Bash(ls)"]}}')
    applyIdleCompaction(p, '2.1.290', false)
    expect(read(p)).toEqual({ model: 'opus', permissions: { allow: ['Bash(ls)'] }, idleCompaction: false })
  })

  test.each([['true'], ['false']])('the key set to %s is left byte for byte', (v) => {
    const body = `{"idleCompaction":${v},  "model":"x"}\n`
    const p = fileWith(body)
    const r = applyIdleCompaction(p, '2.1.302', false)
    expect(r.written).toBe(false)
    expect(readFileSync(p, 'utf8')).toBe(body)
  })

  test('a malformed file is never written over', () => {
    const body = '{"model": '
    const p = fileWith(body)
    expect(readIdleCompaction(p)).toEqual({ state: 'unreadable' })
    const r = applyIdleCompaction(p, '2.1.302', false)
    expect(r.written).toBe(false)
    expect(readFileSync(p, 'utf8')).toBe(body)
    // an array or a scalar is not a settings object either
    writeFileSync(p, '[1]')
    expect(readIdleCompaction(p)).toEqual({ state: 'unreadable' })
  })

  test('below the floor and unreadable versions write nothing; a dry run writes nothing', () => {
    const p = fileWith('{}')
    expect(applyIdleCompaction(p, '2.1.289', false).written).toBe(false)
    expect(applyIdleCompaction(p, null, false).written).toBe(false)
    const dry = applyIdleCompaction(p, '2.1.302', true)
    expect(dry.written).toBe(false)
    expect(dry.line).toContain('would turn off')
    expect(read(p)).toEqual({})
  })

  test('install on a client upgraded since writes the key then', () => {
    const p = fileWith('{}')
    applyIdleCompaction(p, '2.1.289', false)
    expect(read(p)).toEqual({})
    applyIdleCompaction(p, '2.1.302', false)
    expect(read(p)).toEqual({ idleCompaction: false })
  })
})

describe('a settings file Claude Code reads but strict JSON does not (D361: the user\'s key is never lost)', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
  const settingsWith = (body: string): string => {
    const d = mkdtempSync(join(tmpdir(), 'tc-idle-tol-'))
    dirs.push(d)
    mkdirSync(join(d, '.claude'))
    const p = join(d, '.claude', 'settings.json')
    writeFileSync(p, body)
    return p
  }

  test('the tolerant read accepts trailing commas and comments, and leaves strings alone', () => {
    expect(parseTolerantJson('{"a": 1,}')).toEqual({ a: 1 })
    expect(parseTolerantJson('{\n  // note\n  "a": [1, 2,], /* x */ "b": "x,}// not a comment",\n}')).toEqual({ a: [1, 2], b: 'x,}// not a comment' })
    expect(() => parseTolerantJson('{"a": ')).toThrow()
  })

  test('a trailing comma: the key true stays true, model survives, hooks land, nothing is written for the key', () => {
    const body = '{\n  "model": "opus",\n  "idleCompaction": true,\n}\n'
    const p = settingsWith(body)
    const before = readIdleCompaction(p)
    expect(before).toEqual({ state: 'on' })
    // install's order: the hooks step rewrites the file, then the idle step runs
    upsertClaudeSettingsHooks(p, false)
    const r = applyIdleCompaction(p, '2.1.302', false, before)
    expect(r.written).toBe(false)
    expect(r.line).toBeNull()
    const after = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
    expect(after['idleCompaction']).toBe(true)
    expect(after['model']).toBe('opus')
    expect(after['hooks']).toBeDefined()
  })

  test('a file that is no settings object at all is backed up, never read as "no key", and the key is not written', () => {
    const body = '{"model": "opus", "idleCompaction": tru'
    const p = settingsWith(body)
    const before = readIdleCompaction(p)
    expect(before).toEqual({ state: 'unreadable' })
    upsertClaudeSettingsHooks(p, false)
    expect(readFileSync(`${p}.bak`, 'utf8')).toBe(body)
    const r = applyIdleCompaction(p, '2.1.302', false, before)
    expect(r.written).toBe(false)
    expect(r.decision.action).toBe('unreadable-file')
    expect(JSON.parse(readFileSync(p, 'utf8'))).not.toHaveProperty('idleCompaction')
  })
})

describe('readClaudeVersion leaves nothing behind', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true } catch { return false }
  }

  test.skipIf(process.platform === 'win32')('a shell wrapper that hangs is cut at the bound with its child', async () => {
    const d = mkdtempSync(join(tmpdir(), 'tc-claude-wrap-'))
    dirs.push(d)
    const wrapper = join(d, 'claude')
    const pidFile = join(d, 'sleeper.pid')
    writeFileSync(wrapper, `#!/bin/sh\nsleep 30 &\necho $! > '${pidFile}'\nwait\n`)
    chmodSync(wrapper, 0o755)
    const t0 = Date.now()
    expect(await readClaudeVersion({ command: wrapper, timeoutMs: 400 })).toBeNull()
    expect(Date.now() - t0).toBeLessThan(5000)
    const sleeper = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
    expect(Number.isInteger(sleeper)).toBe(true)
    // the group was killed: give the OS a beat to reap, then nothing answers to the pid
    for (let i = 0; i < 50 && alive(sleeper); i += 1) await new Promise((r) => setTimeout(r, 20))
    expect(alive(sleeper), 'the wrapper\'s child is still running').toBe(false)
  })

  test.skipIf(process.platform === 'win32')('a wrapper that answers and leaves a child holding the pipe still answers, and the child is killed', async () => {
    const d = mkdtempSync(join(tmpdir(), 'tc-claude-wrap-'))
    dirs.push(d)
    const wrapper = join(d, 'claude')
    const pidFile = join(d, 'sleeper.pid')
    writeFileSync(wrapper, `#!/bin/sh\nsleep 30 &\necho $! > '${pidFile}'\necho '2.1.302 (Claude Code)'\n`)
    chmodSync(wrapper, 0o755)
    expect(await readClaudeVersion({ command: wrapper, timeoutMs: 5000 })).toBe('2.1.302')
    const sleeper = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
    for (let i = 0; i < 50 && alive(sleeper); i += 1) await new Promise((r) => setTimeout(r, 20))
    expect(alive(sleeper), 'the wrapper\'s child is still running').toBe(false)
  })

  test('a command that is not there cannot be read', async () => {
    expect(await readClaudeVersion({ command: '/nonexistent/claude-for-sure', timeoutMs: 1000 })).toBeNull()
  })
})
