/**
 * The ccr join — the wiring half of the seam, pinned.
 *
 * `pane-contract.test.ts` proves the BLOB we write is one ccr accepts.
 * This file proves the CONFIG we write is one ccr reads, which is the
 * half every closed-beta report actually died on: mac and Windows testers
 * with valid blobs and a config ccr silently ignored — a backslash path, a
 * PowerShell BOM, a bare-string entry, the wrong directory. ccr renders
 * all of those as "no panes configured" by its own survive-a-typo ruling,
 * so nothing on either side was ever wrong out loud.
 *
 * The load-bearing test is the last one: `readsBackLikeCcr` is a
 * transcription of ccr's `loadPaneConfig` (whitelist-construct, `~/`
 * expanded, relative resolved against the config's own directory, any
 * parse problem yielding NO panes) applied to the bytes we actually
 * wrote. If treecontext ever writes a config ccr would skip, that test
 * fails here rather than in a tester's terminal.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync,
  symlinkSync, lstatSync,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

import {
  ccrConfigPath, readCcrConfig, resolvePaneEntry, planWire, applyWire,
  panePathsFor, cycleHint, toJsonPath, CCR_MIN_VERSION,
} from '../../src/server/ccr-pane.js'

let dir: string
let cfg: string
// Native on every platform: on Windows a POSIX-rooted literal resolves to
// a drive-qualified path, which is what both ccr and treecontext compare.
const home = resolve('/home/tester')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-ccr-'))
  cfg = join(dir, 'ccr', 'config.json')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/**
 * What ccr resolves a raw entry to: against the CONFIG's directory, not the
 * cwd. On Windows those can be different drives — a POSIX-rooted literal
 * takes its drive letter from whatever it is resolved against — so an
 * expectation built with a bare resolve() passes on Linux and fails on a
 * runner whose temp dir is not on the checkout's drive.
 */
const asCcrSees = (raw: string): string => resolve(dirname(cfg), raw)

function write(bytes: string | Buffer): void {
  mkdirSync(dirname(cfg), { recursive: true })
  writeFileSync(cfg, bytes)
}

/**
 * ccr's own loader, transcribed from `src/pane-config.js` (v1). Kept as a
 * transcription rather than an import: treecontext must not depend on ccr
 * being installed, and a divergence should surface HERE.
 */
function readsBackLikeCcr(path: string, homeDir: string): string[] {
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch { return [] }
  if (!raw.trim()) return []
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return [] }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { panes?: unknown }).panes)) return []
  const baseDir = dirname(path)
  const out: string[] = []
  for (const entry of (parsed as { panes: unknown[] }).panes) {
    // Whitelist-construct: only the one field v1 names, off a fresh object.
    if (entry === null || typeof entry !== 'object') continue
    const p = (entry as { path?: unknown }).path
    if (typeof p !== 'string' || !p.trim()) continue
    let expanded = p
    if (expanded === '~') expanded = homeDir
    else if (expanded.startsWith('~/')) expanded = join(homeDir, expanded.slice(2))
    out.push(resolve(baseDir, expanded))
  }
  return out
}

describe('where ccr looks for its config', () => {
  it('honors CCR_CONFIG above everything', () => {
    expect(ccrConfigPath({ CCR_CONFIG: '/tmp/alt.json', XDG_CONFIG_HOME: '/xdg' }, home)).toBe('/tmp/alt.json')
  })

  it('uses XDG_CONFIG_HOME when set', () => {
    expect(ccrConfigPath({ XDG_CONFIG_HOME: '/xdg' }, home)).toBe(join('/xdg', 'ccr', 'config.json'))
  })

  it('falls back to ~/.config on EVERY platform — not %APPDATA%, not ~/Library', () => {
    // The single most-missed fact in the closed beta. ccr joins
    // homedir() + '.config' with no platform branch, so this holds on
    // Windows and macOS exactly as it does on Linux.
    expect(ccrConfigPath({}, home)).toBe(join(home, '.config', 'ccr', 'config.json'))
  })

  it('treats an empty env var as unset rather than as a path', () => {
    expect(ccrConfigPath({ CCR_CONFIG: '', XDG_CONFIG_HOME: '' }, home)).toBe(join(home, '.config', 'ccr', 'config.json'))
  })
})

describe('reading a config ccr would silently ignore', () => {
  it('separates missing from empty', () => {
    expect(readCcrConfig(cfg, home).kind).toBe('missing')
    write('   \n')
    expect(readCcrConfig(cfg, home).kind).toBe('empty')
  })

  it('names a UTF-8 BOM instead of calling the file unparseable', () => {
    write(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{ "panes": [] }')]))
    const state = readCcrConfig(cfg, home)
    expect(state.kind).toBe('bom')
    // The content survives; only the encoding was fatal.
    if (state.kind === 'bom') expect(JSON.parse(state.recovered)).toEqual({ panes: [] })
  })

  it('names UTF-16 in both byte orders — what PowerShell `>` writes', () => {
    const body = '{ "panes": [] }'
    write(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, 'utf16le')]))
    expect(readCcrConfig(cfg, home).kind).toBe('utf16')

    const le = Buffer.from(body, 'utf16le')
    const be = Buffer.from(le)
    for (let i = 0; i + 1 < be.length; i += 2) { const t = be[i]!; be[i] = be[i + 1]!; be[i + 1] = t }
    write(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))
    const state = readCcrConfig(cfg, home)
    expect(state.kind).toBe('utf16')
    if (state.kind === 'utf16') expect(JSON.parse(state.recovered)).toEqual({ panes: [] })
  })

  it('separates a syntax error, a non-object, and a missing panes array', () => {
    write('{ "panes": [ { "path": "/a" }, ] }')
    expect(readCcrConfig(cfg, home).kind).toBe('unparseable')
    write('[1, 2]')
    expect(readCcrConfig(cfg, home).kind).toBe('not-object')
    write('{ "theme": "dark" }')
    expect(readCcrConfig(cfg, home).kind).toBe('no-panes')
  })

  it('classifies the entries ccr skips without a word', () => {
    write(JSON.stringify({ panes: [{ path: '/a/pane.json' }, '/b/bare.json', { nope: 1 }, { path: '  ' }] }))
    const state = readCcrConfig(cfg, home)
    expect(state.kind).toBe('ok')
    if (state.kind !== 'ok') return
    expect(state.entries.map((e) => e.shape)).toEqual(['object', 'bare-string', 'unusable', 'unusable'])
  })

  it('never throws on a directory where a file should be', () => {
    mkdirSync(cfg, { recursive: true })
    expect(() => readCcrConfig(cfg, home)).not.toThrow()
  })
})

describe('resolving an entry the way ccr does', () => {
  it('expands ~/ but not ~\\ — ccr expands only the POSIX form', () => {
    expect(resolvePaneEntry('~/x/sidecar.json', '/cfg', home)).toBe(resolve(join(home, 'x', 'sidecar.json')))
    expect(resolvePaneEntry('~\\x\\sidecar.json', '/cfg', home)).toBe(resolve('/cfg', '~\\x\\sidecar.json'))
  })

  it('resolves a relative entry against the config dir, not the project', () => {
    expect(resolvePaneEntry('sidecar.json', '/cfg/ccr', home)).toBe(resolve('/cfg/ccr', 'sidecar.json'))
  })
})

describe('wiring the pane in', () => {
  const pane = resolve('/home/tester/.treecontext/stores/proj/sidecar.json')

  it('creates the file when there is none, and ccr reads our pane back', () => {
    const plan = planWire({ panePaths: [pane], configPath: cfg, home })
    expect(plan.refusal).toBeNull()
    expect(plan.added).toEqual([pane])
    applyWire(plan)
    expect(readsBackLikeCcr(cfg, home)).toEqual([pane])
  })

  it('is idempotent — a second run changes nothing', () => {
    applyWire(planWire({ panePaths: [pane], configPath: cfg, home }))
    const before = readFileSync(cfg, 'utf8')
    const again = planWire({ panePaths: [pane], configPath: cfg, home })
    expect(again.added).toEqual([])
    expect(again.alreadyPresent).toEqual([pane])
    expect(again.content).toBeNull()
    applyWire(again)
    expect(readFileSync(cfg, 'utf8')).toBe(before)
  })

  it('preserves other keys, other panes, and their cycle order', () => {
    write(JSON.stringify({ theme: 'dark', panes: [{ path: '/x/gt.json', label: 'trace' }] }))
    applyWire(planWire({ panePaths: [pane], configPath: cfg, home }))
    const data = JSON.parse(readFileSync(cfg, 'utf8')) as {
      theme: string, panes: { path: string, label?: string }[]
    }
    expect(data.theme).toBe('dark')
    // RAW strings, as written — not resolved paths. We deliberately write
    // forward slashes (a Windows path with backslashes is invalid JSON), so
    // on Windows the stored string and the native path differ by separator.
    expect(data.panes.map((p) => p.path)).toEqual(['/x/gt.json', toJsonPath(pane)])
    // Unknown keys on someone else's entry are not ours to drop.
    expect(data.panes[0]!.label).toBe('trace')
  })

  it('rewrites a bare-string entry into the shape ccr reads, keeping it', () => {
    write(JSON.stringify({ panes: ['/x/bare.json'] }))
    const plan = planWire({ panePaths: [pane], configPath: cfg, home })
    expect(plan.repairedEntries).toBe(1)
    applyWire(plan)
    // Before: ccr saw one pane (ours). After: it sees both.
    expect(readsBackLikeCcr(cfg, home)).toEqual([asCcrSees('/x/bare.json'), pane])
  })

  it('recovers a BOM file instead of losing what it held', () => {
    write(Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(JSON.stringify({ panes: [{ path: '/x/kept.json' }] })),
    ]))
    const plan = planWire({ panePaths: [pane], configPath: cfg, home })
    expect(plan.repairedEncoding).toBe('bom')
    applyWire(plan)
    expect(readFileSync(cfg)[0]).not.toBe(0xef)
    expect(readsBackLikeCcr(cfg, home)).toEqual([asCcrSees('/x/kept.json'), pane])
  })

  it('recovers a UTF-16 file the same way', () => {
    write(Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(JSON.stringify({ panes: [{ path: '/x/kept.json' }] }), 'utf16le'),
    ]))
    const plan = planWire({ panePaths: [pane], configPath: cfg, home })
    expect(plan.repairedEncoding).toBe('utf16')
    applyWire(plan)
    expect(readsBackLikeCcr(cfg, home)).toEqual([asCcrSees('/x/kept.json'), pane])
  })

  it('refuses a syntax error rather than discarding the file, until --force', () => {
    write('{ "panes": [ { "path": "/x/a.json" }, ] }')
    const refused = planWire({ panePaths: [pane], configPath: cfg, home })
    expect(refused.refusal).toContain('not valid JSON')
    expect(refused.content).toBeNull()

    const forced = planWire({ panePaths: [pane], configPath: cfg, home, force: true })
    expect(forced.refusal).toBeNull()
    expect(forced.backedUpTo).toBe(`${cfg}.bak`)
    applyWire(forced)
    expect(existsSync(`${cfg}.bak`)).toBe(true)
    expect(readsBackLikeCcr(cfg, home)).toEqual([pane])
  })

  it('adds a panes array to a config that has other settings and none', () => {
    write(JSON.stringify({ theme: 'dark' }))
    applyWire(planWire({ panePaths: [pane], configPath: cfg, home }))
    const data = JSON.parse(readFileSync(cfg, 'utf8')) as { theme: string, panes: unknown[] }
    expect(data.theme).toBe('dark')
    expect(readsBackLikeCcr(cfg, home)).toEqual([pane])
  })

  it('writes BOM-free UTF-8 with a trailing newline', () => {
    applyWire(planWire({ panePaths: [pane], configPath: cfg, home }))
    const buf = readFileSync(cfg)
    expect(buf[0]).toBe(0x7b) // '{', no BOM
    expect(buf.toString('utf8').endsWith('\n')).toBe(true)
  })

  it('leaves no native separator in the path it writes', () => {
    // On Windows a store path is `C:\Users\…`, and inside JSON that is
    // `\U` — an illegal escape, and the most mechanical way the
    // hand-written configs failed. The conversion is separator-based
    // rather than a blind backslash replace, because a POSIX filename may
    // legally contain a backslash and rewriting it would break the path.
    // So the property to hold on EVERY platform is: nothing native left.
    const native = join('store', 'sidecar.json')
    const written = toJsonPath(native)
    expect(written).not.toContain(sep === '/' ? '\u0000never' : sep)
    expect(written).toBe('store/sidecar.json')
    // And what we write survives a JSON round-trip unchanged.
    expect(JSON.parse(JSON.stringify({ path: written })).path).toBe(written)
  })

  it('lists all three panes in cycle order when asked', () => {
    const panes = panePathsFor('/store', ['journal', 'threads', 'trail'])
    applyWire(planWire({ panePaths: panes, configPath: cfg, home }))
    expect(readsBackLikeCcr(cfg, home).map((p) => p.split(/[\\/]/).pop())).toEqual([
      'sidecar.json', 'sidecar-threads.json', 'sidecar-trail.json',
    ])
  })
})

describe('hostile and awkward configs — the adversarial pass', () => {
  const pane = resolve('/home/tester/.treecontext/stores/proj/sidecar.json')

  it('keeps an entry it cannot interpret, rather than dropping it', () => {
    // ccr skips these, but the operator wrote them. A merge that silently
    // deletes what it does not understand is the same invisibility this
    // command exists to end.
    write(JSON.stringify({ panes: [{ note: 'mine, not a path yet' }, { path: '/x/ok.json' }] }))
    applyWire(planWire({ panePaths: [pane], configPath: cfg, home }))
    const raw = readFileSync(cfg, 'utf8')
    expect(raw).toContain('mine, not a path yet')
    expect(readsBackLikeCcr(cfg, home)).toEqual([asCcrSees('/x/ok.json'), pane])
  })

  it('never overwrites an earlier backup when --force moves a file aside', () => {
    // renameSync overwrites on POSIX and fails on Windows: one destroys
    // the earlier backup, the other leaves the bad file in place to be
    // overwritten by the write that follows.
    write('{ bad json ]')
    writeFileSync(`${cfg}.bak`, 'PRECIOUS EARLIER BACKUP')
    const plan = planWire({ panePaths: [pane], configPath: cfg, home, force: true })
    expect(plan.backedUpTo).toBe(`${cfg}.bak.2`)
    applyWire(plan)
    expect(readFileSync(`${cfg}.bak`, 'utf8')).toBe('PRECIOUS EARLIER BACKUP')
    expect(readFileSync(`${cfg}.bak.2`, 'utf8')).toBe('{ bad json ]')
    expect(readsBackLikeCcr(cfg, home)).toEqual([pane])
  })

  it('writes THROUGH a symlinked config, so a dotfiles link survives', () => {
    const real = join(dir, 'dotfiles-config.json')
    writeFileSync(real, JSON.stringify({ panes: [] }))
    mkdirSync(dirname(cfg), { recursive: true })
    symlinkSync(real, cfg)
    applyWire(planWire({ panePaths: [pane], configPath: cfg, home }))
    expect(lstatSync(cfg).isSymbolicLink()).toBe(true)
    // And the pane landed in the file the operator actually keeps.
    expect(readsBackLikeCcr(real, home)).toEqual([pane])
  })

  it('names a directory for what it is instead of calling it missing', () => {
    mkdirSync(cfg, { recursive: true })
    const state = readCcrConfig(cfg, home)
    expect(state.kind).toBe('not-a-file')
    const plan = planWire({ panePaths: [pane], configPath: cfg, home, force: true })
    // Not even --force: replacing whatever that is would not be a config edit.
    expect(plan.refusal).toContain('a directory')
    expect(plan.content).toBeNull()
  })

  it('refuses a config past the window ccr reads, instead of calling it invalid', () => {
    // Truncate-then-parse would call a valid large file "invalid JSON" —
    // and --force would move a good config aside on that verdict.
    write(JSON.stringify({ note: 'x'.repeat(70_000), panes: [{ path: '/x/ok.json' }] }))
    expect(readCcrConfig(cfg, home).kind).toBe('too-large')
    const plan = planWire({ panePaths: [pane], configPath: cfg, home, force: true })
    expect(plan.refusal).toContain('past the')
    expect(plan.content).toBeNull()
  })

  it('leaves a refused config byte-for-byte alone', () => {
    const before = '{ "panes": [ { "path": "/x/a.json" }, ] }'
    write(before)
    const plan = planWire({ panePaths: [pane], configPath: cfg, home })
    expect(plan.refusal).not.toBeNull()
    applyWire(plan)
    expect(readFileSync(cfg, 'utf8')).toBe(before)
  })
})

describe('the step no config can substitute for', () => {
  it('names the move for each host, and admits Windows Terminal has no key', () => {
    expect(cycleHint({ TMUX: '/tmp/tmux-1000/default,123,0' }).move).toContain('F3')
    expect(cycleHint({ TERM_PROGRAM: 'vscode' }).move).toContain('Space')
    const wt = cycleHint({ WT_SESSION: 'abc-123' })
    expect(wt.host).toContain('Windows Terminal')
    expect(wt.move).toContain('cycle-view')
    expect(wt.move).toContain('no key')
    expect(cycleHint({}).move).toMatch(/F3|Space|cycle-view/)
  })
})

describe('the floor we report', () => {
  it('names the ccr release that first carried panes', () => {
    expect(CCR_MIN_VERSION).toBe('0.3.0')
  })
})
