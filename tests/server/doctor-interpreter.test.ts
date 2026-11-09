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

// Codex CLI: legacy bare-node MCP command + legacy bare-node hook command
// (Gemini CLI carried these fixtures until its retirement, D399).
mkdirSync(join(fakeHome, '.codex'), { recursive: true })
const codexToml = (args: string[], command = 'node'): string =>
  `[mcp_servers.treecontext]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\n`
writeFileSync(join(fakeHome, '.codex', 'config.toml'), codexToml(['cli.js', '--capture', '--code-index']))
const legacyCodexHooks = JSON.stringify({
  SessionStart: [{ hooks: [{ type: 'command', command: 'node "/old/dist/hooks/codex/session-start.js"' }] }],
  UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node "/old/dist/hooks/codex/user-prompt-submit.js"' }] }],
  PostToolUse: [{ hooks: [{ type: 'command', command: 'node "/old/dist/hooks/codex/post-tool-use.js"' }] }],
  PreCompact: [{ hooks: [{ type: 'command', command: 'node "/old/dist/hooks/codex/pre-compact.js"' }] }],
})
writeFileSync(join(fakeHome, '.codex', 'hooks.json'), legacyCodexHooks)

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

    const codex = results.find(r => r.check === 'Codex CLI')
    expect(codex).toBeDefined()
    expect(codex!.status).toBe('warn')
    expect(codex!.detail).toContain("bare 'node'")
    expect(codex!.fix).toContain('treecontext install')

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

    // AC3.1 missing state: no ~/.codex/AGENTS.md yet; AC3.3: skill not installed
    expect(codex!.detail).toContain('instructions missing')
    expect(claude!.detail).toContain('skill missing')
  }, 60_000)

  it('reports instruction blocks as outdated, then current (AC3.1)', async () => {
    writeFileSync(
      join(fakeHome, '.codex', 'AGENTS.md'),
      '<!-- treecontext:start -->\nstale old block\n<!-- treecontext:end -->\n',
    )
    let results = await doctor()
    let codex = results.find(r => r.check === 'Codex CLI')!
    expect(codex.status).toBe('warn')
    expect(codex.detail).toContain('instructions outdated')

    writeFileSync(join(fakeHome, '.codex', 'AGENTS.md'), `${INSTRUCTIONS_CONTENT}\n`)
    results = await doctor()
    codex = results.find(r => r.check === 'Codex CLI')!
    expect(codex.detail).toContain('instructions current')
  }, 60_000)

  it('reports the reference skill as installed after install (AC3.3)', async () => {
    installClaudeSkill(false)
    const results = await doctor()
    const claude = results.find(r => /claude/i.test(r.check))!
    expect(claude.detail).toContain('skill installed')
  }, 60_000)

  it("warns when --instructions none has no delivering hook channel (AC5.4)", async () => {
    const hooksPath = join(fakeHome, '.codex', 'hooks.json')
    writeFileSync(join(fakeHome, '.codex', 'config.toml'),
      codexToml(['cli.js', '--capture', '--code-index', '--instructions', 'none'], process.execPath))

    // No hooks installed: nothing carries the orientation trigger.
    writeFileSync(hooksPath, '{}')
    let results = await doctor()
    let codex = results.find(r => r.check === 'Codex CLI')!
    expect(codex.status).toBe('warn')
    expect(codex.detail).toContain("instructions 'none' but hook channel not delivering")

    // Hooks installed: the hook channel carries the trigger — no warning.
    writeFileSync(hooksPath, JSON.stringify({
      SessionStart: [{ hooks: [{ type: 'command', command: `"${process.execPath}" "/x/hooks/codex/session-start.js"` }] }],
    }))
    results = await doctor()
    codex = results.find(r => r.check === 'Codex CLI')!
    expect(codex.detail).not.toContain('hook channel not delivering')
  }, 60_000)
})
