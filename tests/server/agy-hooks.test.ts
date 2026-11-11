/**
 * Antigravity CLI's named hook (D413): the guards around it, each held by a
 * test of its own (unit 11's fix round). The home is redirected through
 * tests/helpers/home.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { redirectHome, sandboxedEnv } from '../helpers/home.js'
import { spawnCli } from '../helpers/cli-spawn.js'
import { writeFakeAgy } from '../journal/standins.js'
import { agyHooksBlock, agyHooksPresent, agyBlockState, AGY_HOOK_NAME } from '../../src/server/agy-hooks.js'
import { copiesRunningClaudeScripts, hookScriptContent } from '../../src/server/installer.js'

let home = ''
let restore: () => void = () => {}
const hooksFile = (): string => join(home, '.gemini', 'config', 'hooks.json')
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tc-agy-hooks-'))
  mkdirSync(join(home, '.gemini', 'config'), { recursive: true })
  mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true })
  restore = redirectHome(home)
})
afterEach(() => {
  restore()
  try { chmodSync(hooksFile(), 0o600) } catch { /* none */ }
  rmSync(home, { recursive: true, force: true })
})

describe('agy\'s named hook, read', () => {
  it('counts an earlier build\'s named hook as present, so its entry keeps draining what it stages', () => {
    const { PostInvocation: _pi, ...earlier } = agyHooksBlock()
    writeFileSync(hooksFile(), JSON.stringify({ [AGY_HOOK_NAME]: earlier }, null, 2))
    expect(agyBlockState(JSON.parse(readFileSync(hooksFile(), 'utf8')) as Record<string, unknown>).state).toBe('earlier')
    expect(agyHooksPresent()).toBe(true)
  })
  it('keeps the Claude Code hook scripts while agy\'s named hook runs them', () => {
    writeFileSync(hooksFile(), JSON.stringify({ [AGY_HOOK_NAME]: agyHooksBlock() }, null, 2))
    expect(copiesRunningClaudeScripts('linux', new Set()).map((a) => a.slug)).toContain('agy')
    expect(copiesRunningClaudeScripts('linux', new Set(['agy'])).map((a) => a.slug)).toEqual([])
  })
})

describe('agy\'s hook script answers `{}` and exit 0 whatever node does', () => {
  // The script in the dialect install writes for this platform: a POSIX
  // shell script, or the batch file Windows gets. `override` pins the
  // variable just before the script's own use of it.
  const run = (name: 'TC_CLI' | 'TC_NODE', value: string): { status: number | null; stdout: string } => {
    if (process.platform === 'win32') {
      const body = hookScriptContent('agy')
      const call = '"%TC_NODE%" "%TC_CLI%" hook'
      expect(body, 'the batch script calls node where this test pins its variable').toContain(call)
      const script = join(home, 'tc-agy.cmd')
      writeFileSync(script, body.replace(call, `set "${name}=${value}"\r\n${call}`))
      const r = spawnSync(`"${script}"`, ['Stop', '--client', 'agy'], { input: '{}', env: sandboxedEnv(home), encoding: 'utf8', timeout: 30_000, shell: true })
      return { status: r.status, stdout: r.stdout.replace(/\r\n/g, '\n') }
    }
    const body = hookScriptContent('agy').replace('if [ -x "$TC_NODE" ]', `${name}="${value}"\nif [ -x "$TC_NODE" ]`)
    const script = join(home, 'tc-agy')
    writeFileSync(script, body, { mode: 0o755 })
    const r = spawnSync('bash', [script, 'Stop', '--client', 'agy'], { input: '{}', env: sandboxedEnv(home), encoding: 'utf8', timeout: 30_000 })
    return { status: r.status, stdout: r.stdout }
  }
  it('with a CLI that throws', () => {
    const cli = join(home, 'throws.js')
    writeFileSync(cli, 'console.log("not json"); throw new Error("boom")\n')
    expect(run('TC_CLI', cli)).toEqual({ status: 0, stdout: '{}\n' })
  })
  it('with no node at all', () => {
    expect(run('TC_NODE', process.platform === 'win32' ? 'C:\\nonexistent\\node.exe' : '/nonexistent/node')).toEqual({ status: 0, stdout: '{}\n' })
  })
})

describe('uninstall over a hooks file it may not write', () => {
  it('keeps agy\'s entry in capture mode while treecontext\'s named hook remains and runs, and fails', () => {
    const bin = join(home, 'bin')
    mkdirSync(bin)
    writeFakeAgy(bin, '1.5.3')
    const env = { PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}` }
    const i = spawnCli(['install', '--yes', '--agent', 'agy'], { home, env })
    expect(i.status, i.stdout + i.stderr).toBe(0)
    chmodSync(hooksFile(), 0o444)
    const u = spawnCli(['uninstall', '--yes', '--agent', 'agy'], { home, env })
    expect(u.status).not.toBe(0)
    expect(readFileSync(hooksFile(), 'utf8')).toContain(`"${AGY_HOOK_NAME}"`)
    const mcp = join(home, '.gemini', 'config', 'mcp_config.json')
    expect(existsSync(mcp)).toBe(true)
    const args = (JSON.parse(readFileSync(mcp, 'utf8')) as { mcpServers: Record<string, { args: string[] }> }).mcpServers['treecontext']!.args
    expect(args).toContain('--capture')
  }, 120_000)
})
