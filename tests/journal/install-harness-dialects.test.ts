/**
 * The install harness's dialect walk, graded from any platform.
 *
 * installedCommands() reads BOTH wrapper dialects, but only ONE of them is
 * ever on disk during a suite run: the batch bodies exist only after a real
 * win32 install, so the Linux and macOS lanes have never executed a single
 * batch pattern. The walk's own history is what makes that intolerable — it
 * failed silently twice, once by matching only a leading token (reaching no
 * hook script at all) and once by being POSIX-only (reaching no hook script
 * on win32), and both times the scenario passed on the MCP entry alone. The
 * second fix added the batch patterns; nothing on the green lane runs them.
 *
 * So the bodies come from FIXTURES here, and the walk is driven directly.
 * Dialect is decided by the body (isBatchBody, the one classifier both the
 * walk and its oracle in journal-install.steps.ts call), never by
 * process.platform, which is exactly what makes a batch body readable — and
 * gradeable — from Linux.
 *
 * The maintenance contract: every fixture below is spelled from an installer
 * literal, cited by line. A fixture that drifts from the product grades
 * nothing, and the charter scenario (journal-install: "nothing the installer
 * writes invokes a bare interpreter") stays the thing that proves the
 * fixtures still describe a real install — on whichever platform is running
 * it. This file proves the OTHER platform's half is not dead code.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'

import { installedCommands, isBatchBody } from './install-harness.js'

// ── The paths a real install bakes in ───────────────────────────────────
// Windows-shaped on purpose (drive letters, backslashes): the batch
// interpreter pattern demands a real Windows absolute path, and a POSIX
// path here would pass the exclusion tests for the wrong reason.
const WIN_VERIFIED = 'C:\\Program Files\\nodejs\\node.exe'
const WIN_EXECPATH = 'C:\\Users\\runneradmin\\AppData\\Local\\nvs\\node\\v24.18.0\\x64\\node.exe'
const WIN_CLI = 'C:\\Users\\runneradmin\\AppData\\Roaming\\npm\\node_modules\\treecontext\\dist\\server\\cli.js'
const POSIX_VERIFIED = '/opt/homebrew/opt/node@22/bin/node'
const POSIX_EXECPATH = '/usr/local/bin/node'
const POSIX_CLI = '/home/runner/work/treecontext/dist/server/cli.js'

/**
 * A verified win32 hook script: windowsNodeResolveSnippet's pinned branch
 * (installer.ts:268) under the hook wrapper (installer.ts:594).
 *
 * CRLF throughout, as the product writes it. That is load-bearing: the
 * patterns carry no `\r` tolerance because a CRLF body leaves the `\r` at the
 * END of the preceding line, so an exact-match assertion below is what proves
 * no capture drags one along.
 */
const BATCH_PINNED = [
  '@echo off',
  'REM treecontext: post-tool-use hook',
  'REM Installed by: treecontext install',
  'setlocal',
  `set "TC_NODE=${WIN_VERIFIED}"`,
  // The sentinel: "nothing pinned, resolve at runtime" (installer.ts:268),
  // which launcherInterpreter reads as null (installer.ts:2078).
  'if not exist "%TC_NODE%" set "TC_NODE=node"',
  `"%TC_NODE%" "${WIN_CLI}" hook post-tool-use 2>nul`,
  '',
].join('\r\n')

/**
 * The unverified win32 launcher: the snippet's other branch
 * (installer.ts:269) under the MCP launcher wrapper (installer.ts:297).
 * Its FIRST assignment is the bare-`node` sentinel; the real pin is the
 * `||` fallback behind it.
 */
const BATCH_UNVERIFIED = [
  '@echo off',
  'REM treecontext: MCP stdio launcher',
  'REM Installed by: treecontext install',
  'setlocal',
  'set "TC_NODE=node"',
  `where node >nul 2>nul || set "TC_NODE=${WIN_EXECPATH}"`,
  `"%TC_NODE%" "${WIN_CLI}" %*`,
  '',
].join('\r\n')

/**
 * The pre-2026-08 win32 launcher, quoted verbatim at installer.ts:246 — the
 * regression the bare-interpreter pattern exists to catch. It invoked
 * whatever `node` PATH offered, in parentheses, mid-line; nothing about it is
 * line-shaped, which is why the batch bare pattern is not line-anchored.
 */
const BATCH_HISTORIC = [
  '@echo off',
  'REM treecontext: MCP stdio launcher',
  `where node >nul 2>nul && (node "${WIN_CLI}" %*) || ("${WIN_EXECPATH}" "${WIN_CLI}" %*)`,
  '',
].join('\r\n')

/**
 * NOT a body the installer writes — the false positive the batch
 * bare-interpreter lookbehind exists to exclude, which no product literal
 * exercises (mutation-checked: drop the lookbehind and every fixture above
 * still passes). A wrapper dispatching through an absolute, UNQUOTED
 * interpreter path names no bare `node`; the `node` in `...\nodejs\node` is a
 * path component. Kept beside the historic line so the assertion is one
 * command rather than none — without the lookbehind this body yields two.
 */
const BATCH_PATH_NAMED_NODE = [
  '@echo off',
  `where node >nul 2>nul && (node "${WIN_CLI}" %*) || (C:\\nodejs\\node "${WIN_CLI}" %*)`,
  '',
].join('\r\n')

/**
 * A LEGACY win32 hook wrapper, as every release before the 0.1.0-beta.1
 * package rename wrote it: probes under `node_modules\\treecontext` only.
 * Such wrappers stay on disk until `install` is re-run, so the walk still
 * has to read them. BATCH_CURRENT below is today's four-probe shape.
 *
 * Its anatomy: the TC_CLI module pin with its probe
 * fallbacks (windowsCliResolveSnippet) between the interpreter snippet and a
 * dispatch that names only variables (hookScriptContent's batch branch).
 * This is the shape the legacy fixtures above predate — without it, the
 * batch TC_CLI pin pattern and the absolute-only dispatch tightening run on
 * no fixture at all on the green lane, and a pattern typo (or an edit that
 * starts collecting the %APPDATA% fallback, which would flunk the
 * absolute-and-exists oracle) first surfaces on a windows-latest release
 * lane, or never.
 */
const BATCH_LEGACY = [
  '@echo off',
  'REM treecontext: post-tool-use hook',
  'REM Installed by: treecontext install',
  'setlocal',
  `set "TC_NODE=${WIN_VERIFIED}"`,
  'if not exist "%TC_NODE%" set "TC_NODE=node"',
  `set "TC_CLI=${WIN_CLI}"`,
  // The probe fallbacks open with an env var, not a drive letter — the
  // TC_CLI pin pattern's absolute-form demand is what keeps them out.
  'if not exist "%TC_CLI%" set "TC_CLI=%APPDATA%\\npm\\node_modules\\treecontext\\dist\\server\\cli.js"',
  'if not exist "%TC_CLI%" set "TC_CLI=%ProgramFiles%\\nodejs\\node_modules\\treecontext\\dist\\server\\cli.js"',
  '"%TC_NODE%" "%TC_CLI%" hook post-tool-use 2>nul',
  '',
].join('\r\n')

/**
 * A CURRENT win32 hook wrapper (from 0.1.0-beta.1): the same anatomy as
 * BATCH_LEGACY, with four probes — the published package name
 * `treecontext-mcp` under both prefixes first (the first existing probe
 * wins in batch), then the legacy `treecontext` under both.
 */
const BATCH_CURRENT = [
  '@echo off',
  'REM treecontext: post-tool-use hook',
  'REM Installed by: treecontext install',
  'setlocal',
  `set "TC_NODE=${WIN_VERIFIED}"`,
  'if not exist "%TC_NODE%" set "TC_NODE=node"',
  `set "TC_CLI=${WIN_CLI}"`,
  'if not exist "%TC_CLI%" set "TC_CLI=%APPDATA%\\npm\\node_modules\\treecontext-mcp\\dist\\server\\cli.js"',
  'if not exist "%TC_CLI%" set "TC_CLI=%ProgramFiles%\\nodejs\\node_modules\\treecontext-mcp\\dist\\server\\cli.js"',
  'if not exist "%TC_CLI%" set "TC_CLI=%APPDATA%\\npm\\node_modules\\treecontext\\dist\\server\\cli.js"',
  'if not exist "%TC_CLI%" set "TC_CLI=%ProgramFiles%\\nodejs\\node_modules\\treecontext\\dist\\server\\cli.js"',
  '"%TC_NODE%" "%TC_CLI%" hook post-tool-use 2>nul',
  '',
].join('\r\n')

/** posixNodeResolveSnippet (installer.ts:229 pinned, :232-234 discovery
 *  chain) under the MCP launcher's exec line (installer.ts:303). */
const posixBody = (preferred: string): string => `#!/bin/bash
# treecontext: MCP stdio launcher
# Installed by: treecontext install
${preferred}PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
TC_NODE="$(command -v node || true)"
if [ ! -x "$TC_NODE" ]; then for _n in "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.fnm/node-versions/*/installation/bin/node; do [ -x "$_n" ] && TC_NODE="$_n"; done; fi
[ -x "$TC_NODE" ] || TC_NODE="${POSIX_EXECPATH}"
fi
exec "$TC_NODE" "${POSIX_CLI}" "$@"
`
const POSIX_PINNED = posixBody(`TC_NODE="${POSIX_VERIFIED}"\nif [ ! -x "$TC_NODE" ]; then\n`)
/** The POSIX spelling of "nothing pinned" (installer.ts:230). */
const POSIX_UNVERIFIED = posixBody('TC_NODE=""\nif true; then\n')

/**
 * A CURRENT POSIX agent hook wrapper (agentHookWrapperContent): TC_CLI pin +
 * glob search (posixCliResolveSnippet), and a dispatch that names only
 * variables WITHOUT exec — the exit-0 guarantee's spelling. The walk must
 * take both pins off their pin lines, and nothing off the glob list or the
 * dispatch.
 */
const POSIX_AGENT_WRAPPER = `#!/bin/bash
# treecontext: gemini session-start hook
# Installed by: treecontext install
TC_NODE="${POSIX_VERIFIED}"
if [ ! -x "$TC_NODE" ]; then
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
TC_NODE="$(command -v node || true)"
if [ ! -x "$TC_NODE" ]; then for _n in "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.fnm/node-versions/*/installation/bin/node; do [ -x "$_n" ] && TC_NODE="$_n"; done; fi
[ -x "$TC_NODE" ] || TC_NODE="${POSIX_EXECPATH}"
fi
TC_CLI="/home/runner/work/treecontext/dist/hooks/gemini/session-start.js"
if [ ! -f "$TC_CLI" ]; then for _c in /opt/homebrew/lib/node_modules/treecontext/dist/hooks/gemini/session-start.js /usr/local/lib/node_modules/treecontext/dist/hooks/gemini/session-start.js "$HOME"/.fnm/node-versions/*/installation/lib/node_modules/treecontext/dist/hooks/gemini/session-start.js "$HOME"/.nvm/versions/node/*/lib/node_modules/treecontext/dist/hooks/gemini/session-start.js; do [ -f "$_c" ] && TC_CLI="$_c"; done; fi
"$TC_NODE" "$TC_CLI" "$@"
exit 0
`

/** The harness's walk over a set of hook-script fixtures, in a throwaway
 *  home — installedCommands reads `<home>/.claude/hooks` off disk, and a
 *  fixture fed any other way would not be exercising the read. */
function walkOver(scripts: Record<string, string>): Array<{ source: string; command: string }> {
  const home = mkdtempSync(join(tmpdir(), 'tc-dialect-home-'))
  try {
    const hooks = join(home, '.claude', 'hooks')
    mkdirSync(hooks, { recursive: true })
    for (const [name, body] of Object.entries(scripts)) writeFileSync(join(hooks, name), body)
    return installedCommands(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

const commandsIn = (scripts: Record<string, string>): string[] => walkOver(scripts).map((f) => f.command)

describe('install-harness dialect walk', () => {
  test('the dialect comes from the body, on every platform', () => {
    expect(isBatchBody(BATCH_PINNED)).toBe(true)
    expect(isBatchBody(BATCH_UNVERIFIED)).toBe(true)
    expect(isBatchBody(BATCH_HISTORIC)).toBe(true)
    expect(isBatchBody(BATCH_CURRENT)).toBe(true)
    expect(isBatchBody(BATCH_LEGACY)).toBe(true)
    expect(isBatchBody(POSIX_PINNED)).toBe(false)
    expect(isBatchBody(POSIX_UNVERIFIED)).toBe(false)
    expect(isBatchBody(POSIX_AGENT_WRAPPER)).toBe(false)
  })

  test('a current batch wrapper yields both pins and neither probe fallback', () => {
    // Exact, in pattern order (interpreter pin, then module pin): the
    // %APPDATA%/%ProgramFiles% probe lines and the variable-only dispatch
    // must contribute nothing — collecting either hands the oracle an env
    // fragment to assert an absolute existing path about.
    const found = commandsIn({ 'tc-post-tool-use.cmd': BATCH_CURRENT })
    expect(found).toEqual([WIN_VERIFIED, WIN_CLI])
    expect(found.some((c) => c.includes('%'))).toBe(false)
  })

  test('the current batch wrapper carries four probes, treecontext-mcp first', () => {
    const probes = BATCH_CURRENT.split('\r\n').filter((l) => l.startsWith('if not exist "%TC_CLI%"'))
    expect(probes).toHaveLength(4)
    expect(probes.slice(0, 2).every((l) => l.includes('\\node_modules\\treecontext-mcp\\'))).toBe(true)
    expect(probes.slice(2).every((l) => l.includes('\\node_modules\\treecontext\\'))).toBe(true)
  })

  test('a legacy batch wrapper (pre-rename probes) yields the same two pins', () => {
    const found = commandsIn({ 'tc-post-tool-use.cmd': BATCH_LEGACY })
    expect(found).toEqual([WIN_VERIFIED, WIN_CLI])
    expect(found.some((c) => c.includes('%'))).toBe(false)
  })

  test('a current POSIX agent wrapper yields its pins and nothing from the glob list or dispatch', () => {
    const found = commandsIn({ 'tc-gemini-session-start': POSIX_AGENT_WRAPPER })
    expect(found).toEqual([
      POSIX_VERIFIED, POSIX_EXECPATH,
      '/home/runner/work/treecontext/dist/hooks/gemini/session-start.js',
    ])
    // The module glob list is a search path, and the dispatch names only
    // variables — the `node_modules` spellings and `$TC_CLI` must stay out.
    expect(found.some((c) => c.includes('node_modules'))).toBe(false)
    expect(found.some((c) => c.startsWith('$'))).toBe(false)
  })

  test('a pinned batch wrapper yields its interpreter and its script', () => {
    // Exact, in pattern order (interpreter, then script): an equality here is
    // what pins BOTH that the pin is collected and that nothing else in the
    // body is — the `if not exist` sentinel included, and no trailing `\r`.
    expect(commandsIn({ 'tc-post-tool-use.cmd': BATCH_PINNED })).toEqual([WIN_VERIFIED, WIN_CLI])
  })

  test('the batch "resolve at runtime" sentinel is not collected as a pin', () => {
    const found = commandsIn({ 'tc-mcp-serve.cmd': BATCH_UNVERIFIED })
    // The `|| set` fallback is a real pin and IS collected; the bare `node`
    // the line above it assigns means "nothing pinned" and must not be, or
    // the caller is handed an interpreter the product never chose.
    expect(found).toEqual([WIN_EXECPATH, WIN_CLI])
    expect(found).not.toContain('node')
  })

  test('the historic bare-interpreter shape is caught, and only it', () => {
    const found = walkOver({ 'tc-mcp-serve.cmd': BATCH_HISTORIC })
    // One entry, and it is the bare `node`. The quoted execPath dispatch on
    // the same line contributes nothing (it names no `set "TC_NODE=` and no
    // `%TC_NODE%`), so the charter scenario's assertion — a command must be
    // an absolute path, never the word `node` — fails on this body and on
    // nothing else in it, which is the point of the pattern.
    expect(found.map((f) => f.command)).toEqual(['node'])
    expect(found[0]!.source).toBe('tc-mcp-serve.cmd')
  })

  test('an absolute interpreter path ending in "node" is not a bare interpreter', () => {
    expect(commandsIn({ 'tc-mcp-serve.cmd': BATCH_PATH_NAMED_NODE })).toEqual(['node'])
  })

  test('a POSIX wrapper yields both pins and its script, and neither lookup', () => {
    const found = commandsIn({ 'tc-mcp-serve': POSIX_PINNED })
    expect(found).toEqual([POSIX_VERIFIED, POSIX_EXECPATH, POSIX_CLI])
    // `$(command -v node || true)` is a lookup, not a command, and the
    // version-manager glob is a search path — collecting either would hand
    // the caller a shell fragment as though it were an interpreter.
    expect(found.some((c) => c.includes('command -v'))).toBe(false)
    expect(found.some((c) => c.includes('.nvm') || c.includes('.fnm'))).toBe(false)
  })

  test('the POSIX empty pin is not collected either', () => {
    expect(commandsIn({ 'tc-mcp-serve': POSIX_UNVERIFIED })).toEqual([POSIX_EXECPATH, POSIX_CLI])
  })

  test('every script in a mixed-dialect walk is reached and tagged', () => {
    // The property that failed silently twice: it is not enough for the walk
    // to return SOME commands, each one has to be attributed to the file that
    // will run it — and a walk that reads one dialect returns a plausible
    // list while reaching none of the other's scripts.
    const found = walkOver({ 'tc-post-tool-use.cmd': BATCH_PINNED, 'tc-mcp-serve': POSIX_PINNED })
    const bySource = new Map<string, string[]>()
    for (const { source, command } of found) bySource.set(source, [...(bySource.get(source) ?? []), command])
    expect([...bySource.keys()].sort()).toEqual(['tc-mcp-serve', 'tc-post-tool-use.cmd'])
    expect(bySource.get('tc-post-tool-use.cmd')).toEqual([WIN_VERIFIED, WIN_CLI])
    expect(bySource.get('tc-mcp-serve')).toEqual([POSIX_VERIFIED, POSIX_EXECPATH, POSIX_CLI])
  })
})
