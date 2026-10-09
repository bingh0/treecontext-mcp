/**
 * Session identity through the shell Claude Code really runs hooks in
 * (D251, D216).
 *
 * Claude Code hands every hook command to `/bin/sh -c`. Where /bin/sh is
 * dash (Debian, Ubuntu) a plain quoted path is FORKED, so the hook's
 * process.ppid is a short-lived sh and every pid-keyed join — the session
 * beacon, the /clear predecessor of D216, the namespace annotation —
 * misses (live probe, Claude Code 2.1.293, 2026-10-08). Install now writes
 * `exec "<wrapper>"`, and the wrapper execs node, so the hook's parent is
 * the process that ran the shell. The rest of the suite spawns hooks
 * straight from node, which is why it never saw the break.
 *
 * Everything on the dispatch path here is what install writes: the
 * settings command, run by /bin/sh -c, into the installed bash wrapper,
 * which execs. Only the wrapper's two pins are pointed at this checkout
 * (the interpreter through a one-line exec shim that loads tsx, the CLI at
 * src/server/cli.ts) — from source the installer pins a cli.js that does
 * not exist, and the wrapper's fallback would find a global install.
 */
import { describe, it, expect } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import BetterSqlite3 from 'better-sqlite3'
import { redirectHome } from '../helpers/home.js'
import { sandboxedSpawnEnv, spawnCli, CLI_TS } from '../helpers/cli-spawn.js'
import { type CaptureWorld, openCaptureWorld, hookJson } from '../journal/capture-harness.js'
import {
  installClaudeHookScripts, upsertClaudeSettingsHooks, removeClaudeSettingsHooks, upsertCodexHooks, upsertGeminiHooks,
  claudeHookCommand, claudeHookDispatch, claudeHookCommandsWithoutExec,
} from '../../src/server/installer.js'
import { UNKNOWN_PREDECESSOR } from '../../src/hooks/session-start.js'

const POSIX = process.platform !== 'win32'
const SH_IS_DASH = POSIX && (() => { try { return realpathSync('/bin/sh').endsWith('dash') } catch { return false } })()
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href

type W = CaptureWorld & { cleanups: Array<() => unknown> }
function mkWorld(): W {
  const cleanups: Array<() => unknown> = []
  return { cleanups, defer: (fn: () => unknown) => { cleanups.push(fn) } } as unknown as W
}
async function done(w: W): Promise<void> { for (const f of w.cleanups.reverse()) await f() }

function scratch(w: W, prefix: string): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
  w.defer(() => rmSync(d, { recursive: true, force: true }))
  return d
}

/** Which pid the node at the end of `sh -c <command>` sees as its parent. */
function ppidThrough(w: W, command: (wrapper: string) => string): number {
  const d = scratch(w, 'tc-ppid-')
  const probe = join(d, 'probe.cjs')
  writeFileSync(probe, 'process.stdout.write(String(process.ppid))\n')
  const wrapper = join(d, 'tc-probe')
  writeFileSync(wrapper, `#!/bin/bash\nexec "${process.execPath}" "${probe}"\n`)
  chmodSync(wrapper, 0o755)
  const r = spawnSync('/bin/sh', ['-c', command(wrapper)], { encoding: 'utf8' })
  expect(r.status, r.stderr).toBe(0)
  return Number(r.stdout.trim())
}

describe.skipIf(!POSIX)('hook dispatch through /bin/sh -c keeps the claude pid (D251)', () => {
  it('the written form, exec "<wrapper>", reaches node with the caller as its parent', () => {
    const w = mkWorld()
    try {
      expect(ppidThrough(w, (p) => claudeHookDispatch(p, 'bash', process.platform))).toBe(process.pid)
    } finally { void done(w) }
  })

  // The control only reproduces where /bin/sh forks a single command: dash.
  // bash as /bin/sh (macOS, Fedora, Arch) execs it already, so there is
  // nothing to show.
  it.skipIf(!SH_IS_DASH)('the old form, a bare quoted path, leaves dash between them', () => {
    const w = mkWorld()
    try {
      expect(ppidThrough(w, (p) => claudeHookCommand(p, 'bash'))).not.toBe(process.pid)
    } finally { void done(w) }
  })

  it('install writes every Claude hook command, and the Codex and Gemini copies, behind exec; uninstall still owns them', () => {
    const w = mkWorld()
    const home = scratch(w, 'tc-exec-home-')
    const restore = redirectHome(home)
    try {
      installClaudeHookScripts(false)
      const settings = join(home, '.claude', 'settings.json')
      writeFileSync(settings, '{}')
      upsertClaudeSettingsHooks(settings, false)
      const codex = join(home, 'codex-hooks.json')
      upsertCodexHooks(codex, false, false)
      const gemini = join(home, 'gemini-settings.json')
      writeFileSync(gemini, '{}')
      upsertGeminiHooks(gemini, false)
      for (const f of [settings, codex, gemini]) {
        const commands = [...readFileSync(f, 'utf8').matchAll(/"command": "((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string)
        expect(commands.length, f).toBeGreaterThanOrEqual(7)
        for (const c of commands) expect(c, `${f}: ${c}`).toMatch(/^exec "[^"]+\/\.claude\/hooks\/tc-[a-z-]+"$/)
      }
      const data = JSON.parse(readFileSync(settings, 'utf8')) as Record<string, unknown>
      expect(claudeHookCommandsWithoutExec(data)).toEqual([])
      removeClaudeSettingsHooks(settings, false)
      expect(readFileSync(settings, 'utf8')).not.toContain('tc-')
    } finally { restore(); void done(w) }
  })

  it('a /clear dispatched the way Claude Code runs it links the session it continues (D216)', async () => {
    const w = mkWorld()
    try {
      await openCaptureWorld(w)
      const restore = redirectHome(w.home!)
      let command: string
      try {
        installClaudeHookScripts(false)
        const settings = join(w.home!, '.claude', 'settings.json')
        writeFileSync(settings, '{}')
        upsertClaudeSettingsHooks(settings, false)
        const hooks = (JSON.parse(readFileSync(settings, 'utf8')) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>> }).hooks
        command = hooks['SessionStart']!.find((m) => m.matcher === 'clear')!.hooks.find((h) => h.command.includes('tc-session-start'))!.command
      } finally { restore() }
      // The wrapper's pins, pointed at this checkout; its exec is untouched.
      const wrapper = join(w.home!, '.claude', 'hooks', 'tc-session-start')
      const shim = join(w.home!, 'node-tsx')
      writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" --import "${TSX_LOADER}" "$@"\n`)
      chmodSync(shim, 0o755)
      const body = readFileSync(wrapper, 'utf8')
        .replace(/^TC_NODE=.*$/m, `TC_NODE="${shim}"`)
        .replace(/^TC_CLI=.*$/m, `TC_CLI="${CLI_TS}"`)
      expect(body).toMatch(/\nexec "\$TC_NODE" "\$TC_CLI" hook session-start/)
      writeFileSync(wrapper, body)

      const env = sandboxedSpawnEnv(w.home!, { TREECONTEXT_BINDINGS_FILE: join(w.home!, '.treecontext', 'bindings.json') })
      const fire = (sessionId: string, source: string): string => {
        const r = spawnSync('/bin/sh', ['-c', command], {
          input: JSON.stringify({ session_id: sessionId, cwd: w.proj, hook_event_name: 'SessionStart', source, transcript_path: join(w.proj!, 'transcript.jsonl') }),
          env, cwd: w.proj, encoding: 'utf8', timeout: 30_000,
        })
        expect(r.status, r.stderr).toBe(0)
        return String((hookJson(r.stdout)?.['hookSpecificOutput'] as Record<string, unknown> | undefined)?.['additionalContext'] ?? '')
      }
      const before = `cc-${randomBytes(6).toString('hex')}`
      const after = `cc-${randomBytes(6).toString('hex')}`
      fire(before, 'startup')
      // The beacon is keyed on the process that ran the shell — Claude Code's
      // place here — not on a shell that has already exited.
      expect(existsSync(join(w.home!, '.treecontext', 'stores')), 'the hook never reached a store').toBe(true)
      const packet = fire(after, 'clear')
      expect(packet, 'the /clear could not find the session it continues').not.toBe(UNKNOWN_PREDECESSOR)
      const raw = new BetterSqlite3(w.dbPath!, { readonly: true })
      try {
        const link = raw.prepare('SELECT value FROM store_config WHERE key = ?').get(`session_chain:${after}`) as { value: string } | undefined
        expect(link?.value, 'no session_chain link was written').toBe(JSON.stringify(before))
      } finally { raw.close() }
    } finally { await done(w) }
  })

  it('doctor grades a Claude hook command without exec as degraded session identity', () => {
    const w = mkWorld()
    const home = scratch(w, 'tc-exec-doctor-')
    try {
      expect(spawnCli(['install', '--agent', 'claude', '--yes'], { home }).status).toBe(0)
      const settings = join(home, '.claude', 'settings.json')
      const healthy = spawnCli(['doctor'], { home }).stdout
      expect(healthy).not.toMatch(/session identity/)
      writeFileSync(settings, readFileSync(settings, 'utf8').replaceAll('"exec \\"', '"\\"'))
      expect(readFileSync(settings, 'utf8')).not.toContain('exec ')
      const lines = spawnCli(['doctor'], { home }).stdout.split('\n')
      const i = lines.findIndex((l) => /session identity: degraded session identity/.test(l))
      expect(i, lines.join('\n')).toBeGreaterThanOrEqual(0)
      expect(lines[i + 1]).toMatch(/^\s+fix: treecontext install --force --agent claude$/)
    } finally { void done(w) }
  })
})
