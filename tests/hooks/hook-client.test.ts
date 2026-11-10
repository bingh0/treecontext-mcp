/**
 * D404: the client a hook runs for is the one its command names, never the
 * payload's, and only a client whose own events state how a call ended has
 * a success stated. Below the charter: the argument the hook reads, the
 * staging mark the hook writes, the class the drain gives, the block install
 * writes and converges (D385), and doctor's row for a block an earlier build
 * wrote. The charter binds the end to end (journal-capture, journal-sidecar).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { hookClientFrom, clientStatesOutcome, CLAUDE_CODE_CLIENT } from '../../src/hooks/hook-client.js'
import { statedSuccessBy } from '../../src/hooks/post-tool-use.js'
import { exitClassOf } from '../../src/server/event-processing.js'
import {
  claudeHooksBlock, expectedHookCopy, upsertClaudeSettingsHooks, claudeHookCommandsNamingNoClient,
  hookScriptContent, withoutClientArg,
} from '../../src/server/installer.js'
import { redirectHome } from '../helpers/home.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const commandsOf = (hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>): string[] =>
  Object.values(hooks).flatMap((ms) => ms.flatMap((m) => m.hooks.map((h) => h.command)))

describe('the client a hook runs for (D404)', () => {
  it('is read from the hook process\'s own arguments, and names nothing where none is given', () => {
    expect(hookClientFrom(['node', 'cli.js', 'hook', 'post-tool-use', '--client', 'claude-code'])).toBe('claude-code')
    expect(hookClientFrom(['node', 'cli.js', 'hook', 'post-tool-use', '--client=codex'])).toBe('codex')
    expect(hookClientFrom(['node', 'cli.js', 'hook', 'post-tool-use'])).toBeNull()
    expect(hookClientFrom(['node', 'cli.js', 'hook', 'post-tool-use', '--client'])).toBeNull()
    expect(hookClientFrom(['node', 'cli.js', 'hook', 'post-tool-use', '--client', '--other'])).toBeNull()
  })

  it('states a success only on a named client\'s success event, and only for a client whose events state how a call ended', () => {
    expect(clientStatesOutcome(CLAUDE_CODE_CLIENT)).toBe(true)
    expect(clientStatesOutcome('codex')).toBe(false)
    expect(clientStatesOutcome(null)).toBe(false)
    expect(statedSuccessBy('PostToolUse', 'claude-code')).toBe('claude-code')
    expect(statedSuccessBy('PostToolUseFailure', 'claude-code')).toBeNull()
    expect(statedSuccessBy('PostToolBatch', 'claude-code')).toBeNull()
    expect(statedSuccessBy('PostToolUse', null)).toBeNull()
    expect(statedSuccessBy('PostToolUse', 'codex')).toBeNull()
    expect(statedSuccessBy(undefined, 'claude-code')).toBeNull()
  })

  it('the drain\'s class: the client\'s word where it was stated, the text otherwise', () => {
    const trouble = 'Tool: Bash\nOutput:\nerror: 0 found, 0 failed'
    expect(exitClassOf({ outcome: null, statedBy: 'claude-code', content: trouble })).toEqual({ exitType: 'success', by: 'client' })
    expect(exitClassOf({ outcome: 'failed', statedBy: null, content: 'all good' })).toEqual({ exitType: 'error', by: 'client' })
    expect(exitClassOf({ outcome: null, statedBy: null, content: trouble })).toEqual({ exitType: 'error', by: 'text' })
    expect(exitClassOf({ outcome: null, statedBy: null, content: 'warning: deprecated' })).toEqual({ exitType: 'soft_fail', by: 'text' })
    expect(exitClassOf({ outcome: null, content: 'fine' })).toEqual({ exitType: 'success', by: 'text' })
  })
})

describe('the block install writes names its client (D404)', () => {
  it('every Claude Code command names Claude Code after its script, the copy for another client names none, and each script hands its arguments on', () => {
    for (const c of commandsOf(claudeHooksBlock() as never)) expect(c, c).toMatch(/ --client claude-code$/)
    for (const c of commandsOf(expectedHookCopy() as never)) expect(c, c).not.toContain('--client')
    expect(withoutClientArg('exec "/h/.claude/hooks/tc-stop" --client claude-code')).toBe('exec "/h/.claude/hooks/tc-stop"')
    const body = hookScriptContent('post-tool-use')
    expect(body).toMatch(process.platform === 'win32' ? /hook post-tool-use %\*/ : /hook post-tool-use "\$@"/)
  })

  it('a reinstall over a block an earlier build wrote rewrites its commands to name Claude Code, and doctor\'s check names the old ones until then', () => {
    const home = mkdtempSync(join(tmpdir(), 'tc-hook-client-'))
    dirs.push(home)
    const restore = redirectHome(home)
    try {
      const settings = join(home, '.claude', 'settings.json')
      upsertClaudeSettingsHooks(settings, false)
      // The block an earlier build wrote: the same commands, naming no client,
      // beside a hook of the developer's.
      const data = JSON.parse(readFileSync(settings, 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
      for (const ms of Object.values(data.hooks)) for (const m of ms) for (const h of m.hooks) h.command = withoutClientArg(h.command)
      data.hooks['PostToolUse']!.push({ hooks: [{ command: 'my-own-hook --client mine' }] })
      writeFileSync(settings, JSON.stringify(data))
      const older = claudeHookCommandsNamingNoClient(data as never)
      expect(older.length).toBe(commandsOf(claudeHooksBlock() as never).length)
      expect(older).not.toContain('my-own-hook --client mine')
      upsertClaudeSettingsHooks(settings, false)
      const after = JSON.parse(readFileSync(settings, 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
      expect(claudeHookCommandsNamingNoClient(after as never)).toEqual([])
      expect(commandsOf(after.hooks)).toContain('my-own-hook --client mine')
    } finally { restore() }
  })
})
