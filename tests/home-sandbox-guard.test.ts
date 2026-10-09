/**
 * The home-sandbox ratchet.
 *
 * A test that redirects only `process.env.HOME` does not sandbox on Windows:
 * `os.homedir()` reads USERPROFILE there and ignores HOME, and agents.ts
 * resolves VS Code / OpenCode config through APPDATA. The code
 * under test then reads and WRITES the developer's real profile while the
 * assertions inspect an empty temp dir.
 *
 * On the first Windows CI run to execute this suite, that cost us: the skill
 * tests installed treecontext-reference into the runner's real
 * C:\Users\runneradmin\.claude\skills and then deleted it again.
 *
 * This guard exists because the bug class is INVISIBLE on Linux and macOS —
 * there, HOME alone is sufficient, so a wrong sandbox passes locally and every
 * pre-merge check stays green. Reviewers cannot see it either. So the corpus
 * is checked mechanically instead: home redirection goes through
 * tests/helpers/home.ts, which is the one place that knows the full variable
 * set. Like every register in this suite it ratchets both ways — an
 * unregistered violation fails, and a stale exemption fails too, so the list
 * can only shrink truthfully.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const TESTS_DIR = fileURLToPath(new URL('.', import.meta.url))

/**
 * Files allowed to touch a home variable directly, each with the reason.
 * The click: remove the need, delete the entry.
 */
const EXEMPT = new Map<string, string>([
  [
    'helpers/home.ts',
    'the helper itself — it is the definition of the full variable set',
  ],
  [
    'journal/steps/journal-install.steps.ts',
    'two deliberately MINIMAL envs (not spreads of process.env) for the '
    + 'interpreter-resolution probe, one per platform branch: /bin/bash with '
    + 'HOME on POSIX, cmd.exe with USERPROFILE+SystemRoot on Windows; the '
    + 'chain under test must not inherit the parent environment',
  ],
])

const walk = (dir: string, prefix = ''): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) return walk(join(dir, e.name), rel)
    return e.name.endsWith('.ts') ? [rel] : []
  })

/** Strip line and block comments so prose about HOME never trips the scan. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

// Direct assignment (`process.env.HOME = x`) or a home key in an env object
// literal (`HOME: x`). Both are ways to build a sandbox by hand.
const DIRECT_ASSIGN = /process\.env(?:\.(?:HOME|USERPROFILE|APPDATA)\b|\[['"](?:HOME|USERPROFILE|APPDATA)['"]\])\s*=/
const ENV_LITERAL_KEY = /(?:^|[{,\s])(?:HOME|USERPROFILE|APPDATA):\s/

describe('home-sandbox guard', () => {
  const files = walk(TESTS_DIR).sort()

  test('the corpus is where the register thinks it is', () => {
    expect(files.length).toBeGreaterThan(0)
    for (const f of EXEMPT.keys()) {
      expect(files, `register entry names a missing file: ${f}`).toContain(f)
    }
  })

  test('home redirection goes through tests/helpers/home.ts', () => {
    const offenders: string[] = []
    for (const f of files) {
      if (f === 'home-sandbox-guard.test.ts') continue // this file names the vars to describe them
      const src = stripComments(readFileSync(join(TESTS_DIR, f), 'utf8'))
      const hits = src.split('\n').filter((l) => DIRECT_ASSIGN.test(l) || ENV_LITERAL_KEY.test(l))
      if (hits.length > 0 && !EXEMPT.has(f)) {
        offenders.push(`${f}: sets a home variable directly — use redirectHome()/sandboxedEnv() (${hits.length} line(s))`)
      }
      // Ratchet the other way: an exemption whose need has gone must be removed.
      if (hits.length === 0 && EXEMPT.has(f)) {
        offenders.push(`${f}: exempt but no longer sets a home variable — delete the register entry`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('the helper covers every home variable os.homedir and agents.ts consult', async () => {
    const { homeEnv } = await import('./helpers/home.js')
    const keys = Object.keys(homeEnv('/tmp/probe'))
    // HOME: POSIX. USERPROFILE: what os.homedir() reads on Windows.
    // APPDATA: what agents.ts resolves win32 VS Code/OpenCode from.
    expect(new Set(keys)).toEqual(new Set(['HOME', 'USERPROFILE', 'APPDATA']))
    // Every value must live under the sandbox root, or it is not a sandbox.
    //
    // Compared with path semantics rather than a string prefix: homeEnv builds
    // with join(), which emits the PLATFORM separator, so `startsWith(root)` is
    // itself platform-coupled. This assertion failed on Windows for precisely
    // the class of bug the guard exists to catch — noted rather than quietly
    // corrected, because it is the same mistake one level up.
    const root = join(tmpdir(), 'sandbox-probe')
    for (const v of Object.values(homeEnv(root))) {
      const rel = relative(root, v)
      expect(!rel.startsWith('..') && !isAbsolute(rel), `${v} escapes the sandbox root ${root}`).toBe(true)
    }
  })
})
