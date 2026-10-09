/**
 * Doctor's handling of hooks on platforms `install` does not manage
 * (beta-1 field report).
 *
 * Outside CAPTURE_PLATFORMS, `install` deliberately writes no hook config —
 * so it never rewrites one either. Grading those hooks on the agent's own row
 * produced a warning whose offered fix (`install --force --agent <slug>`) is a
 * no-op by construction: a tester ran it and the warning survived unchanged.
 *
 * Own-file isolation for the same reason as doctor-interpreter.test.ts:
 * agents.ts computes AGENTS paths from homedir() at module load, so HOME must
 * be redirected before the installer module graph is imported.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { redirectHome } from '../helpers/home.js'

/**
 * The tree doctor treats as "this install" (see isCurrentInstallTarget). Under
 * vitest the modules load from source, so that is `src/`, and the one test
 * that needs a hook target inside it has to place a real file there — and
 * remove it again, since this is the repository working tree.
 */
const currentInstallRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
const inTreeHookTarget = join(currentInstallRoot, 'hooks', 'vscode', '__doctor-test-target.js')

const fakeHome = mkdtempSync(join(tmpdir(), 'tc-unmanaged-home-'))
const restoreHome = redirectHome(fakeHome)

// VS Code detected (its MCP config exists) so doctor evaluates the agent.
//
// The path comes from the registry, not a literal: `~/.config/Code/User` is
// the LINUX location, and agents.ts maps darwin to
// ~/Library/Application Support/Code/User. Spelling out the Linux path made
// every case below assert a property of Linux — on macOS the VS Code row never
// materialised and the four "Cannot read properties of undefined" cascades
// were the consequence, not the cause. Imported after redirectHome because
// agents.ts freezes its paths from homedir() at module evaluation.
const { getAgent, getConfigPath } = await import('../../src/server/agents.js')
const vscodeAgent = getAgent('vscode')
if (!vscodeAgent) throw new Error('agent registry no longer defines a vscode agent')
const vscodeMcp = getConfigPath(vscodeAgent)
if (!vscodeMcp) throw new Error(`agent registry defines no vscode config path for ${process.platform}`)
mkdirSync(dirname(vscodeMcp), { recursive: true })
writeFileSync(vscodeMcp, JSON.stringify({
  servers: { treecontext: { command: process.execPath, args: ['cli.js', '--capture'] } },
}))

// Leftover Copilot hooks from an older install, pointing at a build that is
// not this one — exactly the state the tester was stuck in.
const staleBuild = join(fakeHome, 'old-checkout', 'ts', 'dist', 'hooks', 'vscode')
mkdirSync(staleBuild, { recursive: true })
for (const f of ['session-start.js', 'user-prompt-submit.js', 'post-tool-use.js', 'pre-compact.js']) {
  writeFileSync(join(staleBuild, f), '// stale build\n')
}
const copilotHooks = join(fakeHome, '.copilot', 'hooks')
mkdirSync(copilotHooks, { recursive: true })
const copilotHooksFile = join(copilotHooks, 'treecontext.json')
writeFileSync(copilotHooksFile, JSON.stringify({
  version: 1,
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: `node "${join(staleBuild, 'session-start.js')}"` }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node "${join(staleBuild, 'user-prompt-submit.js')}"` }] }],
    PostToolUse: [{ hooks: [{ type: 'command', command: `node "${join(staleBuild, 'post-tool-use.js')}"` }] }],
    PreCompact: [{ hooks: [{ type: 'command', command: `node "${join(staleBuild, 'pre-compact.js')}"` }] }],
  },
}))

const { doctor, buildVscodeHooksConfig } = await import('../../src/server/installer.js')

afterAll(() => {
  restoreHome()
  rmSync(fakeHome, { recursive: true, force: true })
  rmSync(inTreeHookTarget, { force: true })
})

describe('doctor: hooks on unmanaged platforms', () => {
  it('reports leftover hooks on a row whose fix actually clears them', async () => {
    const results = await doctor()

    const row = results.find(r => r.check === 'VS Code hooks (unmanaged)')
    expect(row, 'expected a dedicated row for unmanaged VS Code hooks').toBeDefined()
    expect(row!.status).toBe('warn')

    // The fix must be a command that removes them — not `install --force`,
    // which writes nothing on an unverified-capture platform.
    expect(row!.fix).toBe('treecontext uninstall --agent vscode --hooks-only')
    expect(row!.fix).not.toContain('install --force')

    // It should say why install will not fix it, name the foreign build, and
    // still offer the opt-in route for someone who wants capture there.
    expect(row!.detail).toContain(copilotHooksFile)
    expect(row!.detail).toContain('does not manage hooks')
    expect(row!.detail).toContain('different treecontext build')
    expect(row!.detail).toContain('--experimental-capture')
  }, 60_000)

  it("grades an earlier build's copy beside the Claude route as a second route, with the uninstall as its remedy (D226)", async () => {
    const results = await doctor()
    const vscode = results.find(r => r.check === 'VS Code')!

    // VS Code reads the Claude settings file itself; a copy of our hooks in
    // its own hook file is a second route, never "nothing to do".
    expect(vscode.detail).toContain(`a copy of the hooks an earlier build wrote in ${copilotHooksFile} runs beside it (two hook routes)`)
    expect(vscode.detail).toContain('remedy: to remove the second route: treecontext uninstall --agent vscode --hooks-only')
    expect(vscode.detail).not.toContain('hooks missing')
    expect(vscode.status).toBe('warn')
    expect(vscode.fix).toBe('treecontext uninstall --agent vscode --hooks-only')
  }, 60_000)

  it('says hooks are unmanaged, not broken, when none were ever written', async () => {
    rmSync(copilotHooksFile, { force: true })
    const results = await doctor()
    const vscode = results.find(r => r.check === 'VS Code')!

    // The row names VS Code's mode, its state and the remedy (D161), and
    // with nothing of ours in its own hook file, no unmanaged-hooks part.
    expect(vscode.detail).toContain('the client reads the Claude settings file when its Claude-hooks setting is on (chat.useClaudeHooks')
    expect(vscode.detail).toMatch(/state: chat\.useClaudeHooks is off/)
    expect(vscode.detail).not.toContain('install does not manage them')
    expect(vscode.status).toBe('ok')
  }, 60_000)

  it('a working copy from an earlier opt-in gets no unmanaged row, but its agent row still names the second route', async () => {
    // Hooks pointing at *this* install with a resolvable interpreter are what
    // an earlier build's `install --experimental-capture` produced. They are
    // not broken, so no unmanaged-hooks row; but VS Code also reads the
    // Claude settings file, so the agent row warns of two routes (D226).
    mkdirSync(dirname(inTreeHookTarget), { recursive: true })
    writeFileSync(inTreeHookTarget, '// stands in for a hook shipped by this build\n')
    writeFileSync(copilotHooksFile, JSON.stringify({
      version: 1,
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: `"${process.execPath}" "${inTreeHookTarget}"` }] }],
      },
    }))

    const results = await doctor()
    expect(results.find(r => r.check === 'VS Code hooks (unmanaged)')).toBeUndefined()
    const vscode = results.find(r => r.check === 'VS Code')!
    expect(vscode.detail).toContain('(two hook routes)')
    expect(vscode.fix).toBe('treecontext uninstall --agent vscode --hooks-only')
  }, 60_000)

  it('stays silent when no treecontext hooks were left behind', async () => {
    rmSync(copilotHooksFile, { force: true })
    const results = await doctor()

    expect(results.find(r => r.check === 'VS Code hooks (unmanaged)')).toBeUndefined()
    expect(results.find(r => r.check === 'VS Code')!.status).toBe('ok')
  }, 60_000)

  it('sees a missing wrapper behind Copilot\'s bash/powershell keys', async () => {
    // The Copilot schema carries the invocation under `bash`/`powershell`, not
    // `command` — and doctor's command walk read `command` only. A config in
    // the shape install actually writes, with the wrappers it names deleted,
    // was therefore invisible from every side at once: no unmanaged row, no
    // interpreter finding, and capture silently recording nothing.
    writeFileSync(copilotHooksFile, JSON.stringify(buildVscodeHooksConfig()))
    const results = await doctor()

    const row = results.find(r => r.check === 'VS Code hooks (unmanaged)')
    expect(row, 'the wrapper commands were never read at all').toBeDefined()
    expect(row!.detail).toContain('tc-vscode-session-start')
  }, 60_000)

  it('ignores a hooks file owned by something other than treecontext', async () => {
    writeFileSync(copilotHooksFile, JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'some-other-tool --run' }] }] },
    }))
    const results = await doctor()

    expect(results.find(r => r.check === 'VS Code hooks (unmanaged)')).toBeUndefined()
  }, 60_000)
})
