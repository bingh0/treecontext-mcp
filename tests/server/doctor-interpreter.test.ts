/**
 * Doctor interpreter checks (AC1.4).
 *
 * Lives in its own file because agents.ts computes AGENTS paths from
 * homedir() at module load — HOME must be redirected BEFORE the installer
 * module graph is imported, which file-level isolation guarantees.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { redirectHome } from '../helpers/home.js'

const fakeHome = mkdtempSync(join(tmpdir(), 'tc-doctor-home-'))
// Every home variable, before the dynamic import below. The describe is
// POSIX-gated, but this file imports installClaudeSkill — a HOME-only redirect
// is one accidental un-skip away from writing into a real profile.
const restoreHome = redirectHome(fakeHome)

// Gemini: legacy bare-node MCP command + legacy bare-node hook command
mkdirSync(join(fakeHome, '.gemini'), { recursive: true })
writeFileSync(join(fakeHome, '.gemini', 'settings.json'), JSON.stringify({
  mcpServers: { treecontext: { command: 'node', args: ['cli.js', '--capture', '--code-index'] } },
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'node "/old/dist/hooks/gemini/session-start.js"' }] }],
    BeforeAgent: [{ hooks: [{ type: 'command', command: 'node "/old/dist/hooks/gemini/before-agent.js"' }] }],
    AfterTool: [{ hooks: [{ type: 'command', command: 'node "/old/dist/hooks/gemini/after-tool.js"' }] }],
    PreCompress: [{ hooks: [{ type: 'command', command: 'node "/old/dist/hooks/gemini/pre-compress.js"' }] }],
  },
}))

// Cursor: stale absolute interpreter (node upgraded/removed since install)
mkdirSync(join(fakeHome, '.cursor'), { recursive: true })
writeFileSync(join(fakeHome, '.cursor', 'hooks.json'), JSON.stringify({
  version: 1,
  hooks: {
    sessionStart: [{ command: '"/nonexistent/cellar/node" "/x/hooks/cursor/session-start.js"' }],
    beforeSubmitPrompt: [{ command: '"/nonexistent/cellar/node" "/x/hooks/cursor/user-prompt-submit.js"' }],
    postToolUse: [{ command: '"/nonexistent/cellar/node" "/x/hooks/cursor/post-tool-use.js"' }],
    preCompact: [{ command: '"/nonexistent/cellar/node" "/x/hooks/cursor/pre-compact.js"' }],
  },
}))

// Claude Code: legacy hook script bodies invoking bare node
const claudeHooksDir = join(fakeHome, '.claude', 'hooks')
mkdirSync(claudeHooksDir, { recursive: true })
const legacyBody = (event: string): string =>
  `#!/bin/bash\n# treecontext: ${event} hook\nexec node "/old/dist/server/cli.js" hook ${event} 2>/dev/null\nexit 0\n`
writeFileSync(join(claudeHooksDir, 'tc-session-reminder'), '#!/bin/bash\ncat << EOF\nhi\nEOF\n', { mode: 0o755 })
for (const ev of ['session-start', 'pre-compact', 'post-tool-use', 'user-prompt-submit']) {
  writeFileSync(join(claudeHooksDir, `tc-${ev}`), legacyBody(ev), { mode: 0o755 })
}

const { doctor, INSTRUCTIONS_CONTENT, installClaudeSkill } = await import('../../src/server/installer.js')

afterAll(() => {
  restoreHome()
  rmSync(fakeHome, { recursive: true, force: true })
})

/**
 * POSIX-gated for a reason in the fixtures, not a guess about the platform.
 *
 * Every Claude Code fixture above is a POSIX hook script: written to
 * `~/.claude/hooks/tc-<event>` with no extension, holding a `#!/bin/bash`
 * body. On Windows `install` writes `tc-<event>.cmd`, and doctor's presence
 * check looks for that name — so it would not read these files at all, and
 * the "bare 'node'" assertions would fail for the boring reason that doctor
 * never saw the body, not because the check regressed.
 *
 * THE GAP THIS LEAVES, stated rather than hidden: doctor's ability to flag a
 * bare-node interpreter inside a *Windows* hook body is untested. Closing it
 * means teaching this file to emit .cmd fixtures per platform, which is a
 * larger change than un-gating; it is not "already covered".
 */
describe.skipIf(process.platform === 'win32')('doctor interpreter diagnostics (AC1.4)', () => {
  it('flags bare-node configs and stale interpreters per agent', async () => {
    const results = await doctor()

    const gemini = results.find(r => /gemini/i.test(r.check))
    expect(gemini).toBeDefined()
    expect(gemini!.status).toBe('warn')
    expect(gemini!.detail).toContain("bare 'node'")
    expect(gemini!.fix).toContain('treecontext install')

    // Cursor is outside CAPTURE_PLATFORMS, so `install` never writes its
    // hooks and the stale-interpreter finding belongs on the unmanaged-hooks
    // row — the one whose fix can actually clear it. See
    // doctor-unmanaged-hooks.test.ts.
    const cursorHooks = results.find(r => r.check === 'Cursor hooks (unmanaged)')
    expect(cursorHooks).toBeDefined()
    expect(cursorHooks!.status).toBe('warn')
    expect(cursorHooks!.detail).toContain('interpreter missing')
    expect(cursorHooks!.fix).toBe('treecontext uninstall --agent cursor --hooks-only')

    const claude = results.find(r => /claude/i.test(r.check))
    expect(claude).toBeDefined()
    expect(claude!.status).toBe('warn')
    expect(claude!.detail).toContain("bare 'node'")

    // AC3.1 missing state: no GEMINI.md yet; AC3.3: skill not installed
    expect(gemini!.detail).toContain('instructions missing')
    expect(claude!.detail).toContain('skill missing')
  }, 60_000)

  it('reports instruction blocks as outdated, then current (AC3.1)', async () => {
    writeFileSync(
      join(fakeHome, '.gemini', 'GEMINI.md'),
      '<!-- treecontext:start -->\nstale old block\n<!-- treecontext:end -->\n',
    )
    let results = await doctor()
    let gemini = results.find(r => /gemini/i.test(r.check))!
    expect(gemini.status).toBe('warn')
    expect(gemini.detail).toContain('instructions outdated')

    writeFileSync(join(fakeHome, '.gemini', 'GEMINI.md'), `${INSTRUCTIONS_CONTENT}\n`)
    results = await doctor()
    gemini = results.find(r => /gemini/i.test(r.check))!
    expect(gemini.detail).toContain('instructions current')
  }, 60_000)

  it('reports the reference skill as installed after install (AC3.3)', async () => {
    installClaudeSkill(false)
    const results = await doctor()
    const claude = results.find(r => /claude/i.test(r.check))!
    expect(claude.detail).toContain('skill installed')
  }, 60_000)

  it("warns when --instructions none has no delivering hook channel (AC5.4)", async () => {
    const settingsPath = join(fakeHome, '.gemini', 'settings.json')
    const mcpEntry = {
      command: process.execPath,
      args: ['cli.js', '--capture', '--code-index', '--instructions', 'none'],
    }

    // No hooks installed: nothing carries the orientation trigger.
    writeFileSync(settingsPath, JSON.stringify({ mcpServers: { treecontext: mcpEntry } }))
    let results = await doctor()
    let gemini = results.find(r => /gemini/i.test(r.check))!
    expect(gemini.status).toBe('warn')
    expect(gemini.detail).toContain("instructions 'none' but hook channel not delivering")

    // Hooks installed: the hook channel carries the trigger — no warning.
    writeFileSync(settingsPath, JSON.stringify({
      mcpServers: { treecontext: mcpEntry },
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: `"${process.execPath}" "/x/hooks/gemini/session-start.js"` }] }],
      },
    }))
    results = await doctor()
    gemini = results.find(r => /gemini/i.test(r.check))!
    expect(gemini.detail).not.toContain('hook channel not delivering')
  }, 60_000)
})
