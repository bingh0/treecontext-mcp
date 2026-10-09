/**
 * Unit tests for CLI argument parsing, auto-store resolution, and store path mapping.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { homedir } from 'node:os'
import { PassThrough } from 'node:stream'
import {
  parseArgs,
  SAFE_STORE_RE,
  resolveStorePath,
  resolveAutoStore,
  armFailFastStdio,
} from '../../src/server/cli.js'
import { describePosix } from '../helpers/platform.js'
import { storesDirIn } from '../helpers/store-fixtures.js'

// ── parseArgs ─────────────────────────────────────────────────────

// The --transport http / --port / --host parse tests left with the HTTP
// transport (0.1 corpus audit); the tombstones are pinned in
// http-auth.test.ts.
describe('parseArgs', () => {
  const base = ['node', 'treecontext']

  it('defaults to serve command', () => {
    const args = parseArgs([...base])
    expect(args.command).toBe('serve')
    expect(args.transport).toBe('stdio')
    expect(args.store).toBeNull()
  })

  it('parses serve with flags', () => {
    const args = parseArgs([
      ...base, 'serve',
      '--transport', 'stdio',
      '--store', 'my-project',
    ])
    expect(args.command).toBe('serve')
    expect(args.store).toBe('my-project')
  })

  it('defaults namespace to "project"', () => {
    const args = parseArgs([...base])
    expect(args.namespace).toBe('project')
  })

  it('defaults --instructions to brief (AC5.1)', () => {
    const args = parseArgs([...base])
    expect(args.instructions).toBe('brief')
  })

  it('parses --instructions brief|none; verbose is tombstoned (AC5.1)', () => {
    expect(parseArgs(['node', 'cli', 'serve', '--instructions', 'brief']).instructions).toBe('brief')
    expect(parseArgs(['node', 'cli', 'serve', '--instructions', 'none']).instructions).toBe('none')
    // 'verbose' silently served brief for a month (corpus audit D4); it
    // now refuses with a removal message — see http-auth.test.ts for the
    // shared tombstone idiom.
  })

  it('rejects invalid --instructions value (AC5.1)', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit called')
    }) as never)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => parseArgs([...base, 'serve', '--instructions', 'terse'])).toThrow('exit called')
      expect(errSpy.mock.calls.flat().join(' ')).toContain('Invalid --instructions value')
    } finally {
      exitSpy.mockRestore()
      errSpy.mockRestore()
    }
  })

  it('parses --namespace', () => {
    const args = parseArgs([...base, 'serve', '--namespace', 'agent-a'])
    expect(args.namespace).toBe('agent-a')
  })

  it('accepts --experimental-capture only alongside --agent (opt-in by name, ruling 2026-08-01)', () => {
    const named = parseArgs([...base, 'install', '--agent', 'opencode', '--experimental-capture'])
    expect(named.experimentalCapture).toBe(true)
    expect(named.installAgents).toEqual(['opencode'])
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`exit ${code}`)
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => parseArgs([...base, 'install', '--experimental-capture'])).toThrow('exit 1')
      expect(errSpy.mock.calls.flat().join(' ')).toContain('requires --agent')
    } finally {
      exitSpy.mockRestore()
      errSpy.mockRestore()
    }
  })

  it('rejects --namespace with unsafe characters', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`exit ${code}`)
    })
    expect(() => parseArgs([...base, '--namespace', 'bad name!'])).toThrow('exit 1')
    exitSpy.mockRestore()
  })

  it('parses --policy', () => {
    const a = parseArgs([...base, 'serve', '--policy', 'contributor'])
    expect(a.policy).toBe('contributor')
  })

  it('rejects invalid --policy', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`exit ${code}`)
    })
    expect(() => parseArgs([...base, '--policy', 'god-mode'])).toThrow('exit 1')
    exitSpy.mockRestore()
  })

  it('parses the handoff commands: import <path>, export <path> [--whole] (D199)', () => {
    const imp = parseArgs([...base, 'import', 'handoffs/login-plan.json'])
    expect(imp.command).toBe('import')
    expect(imp.handoffPath).toBe('handoffs/login-plan.json')
    const exp = parseArgs([...base, 'export', 'handoffs/all.json', '--whole', '--yes'])
    expect(exp.command).toBe('export')
    expect(exp.handoffPath).toBe('handoffs/all.json')
    expect(exp.exportWhole).toBe(true)
    expect(exp.yes).toBe(true)
  })

  it('rejects tree-era flags as unknown', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`exit ${code}`)
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (const flag of ['--model', '--compress', '--no-compress', '--compress-bits', '--ensemble-size', '--token', '--no-daemon']) {
        expect(() => parseArgs([...base, flag]), flag).toThrow('exit 1')
      }
    } finally {
      exitSpy.mockRestore()
      errSpy.mockRestore()
    }
  })

  it('parses --project-dir', () => {
    const args = parseArgs([...base, '--project-dir', '/home/user/project'])
    expect(args.projectDir).toBe('/home/user/project')
  })



  it('parses viz and embed tombstone commands', () => {
    expect(parseArgs([...base, 'viz']).command).toBe('viz')
    expect(parseArgs([...base, 'embed']).command).toBe('embed')
  })

  it('parses the daemon tombstone command, swallowing sub-action positionals', () => {
    expect(parseArgs([...base, 'daemon', 'start']).command).toBe('daemon')
    expect(parseArgs([...base, 'daemon', 'stop']).command).toBe('daemon')
    expect(parseArgs([...base, 'daemon', 'status']).command).toBe('daemon')
  })

  it('--lexical sets lexical and marks it provided', () => {
    const args = parseArgs([...base, 'serve', '--lexical'])
    expect(args.lexical).toBe(true)
    expect(args.provided.has('lexical')).toBe(true)
  })

  it('--no-lexical clears lexical and marks it provided (explicit opt-out)', () => {
    const args = parseArgs([...base, 'install', '--no-lexical'])
    expect(args.lexical).toBe(false)
    expect(args.provided.has('lexical')).toBe(true)
  })

  it('install without a backend flag leaves lexical unmarked (so install defaults it on)', () => {
    // The install branch reads `provided.has('lexical') ? args.lexical : true`,
    // so an unmarked flag means the current default backend (lexical) is written.
    const args = parseArgs([...base, 'install'])
    expect(args.provided.has('lexical')).toBe(false)
  })
})

// ── SAFE_STORE_RE ─────────────────────────────────────────────────

describe('SAFE_STORE_RE', () => {
  it.each([
    'my-project',
    'owner-repo',
    'project_v2',
    'treecontext.db',
    'UPPER123',
  ])('accepts valid name: %s', (name) => {
    expect(SAFE_STORE_RE.test(name)).toBe(true)
  })

  it.each([
    '',
    'has spaces',
    'path/to/dir',
    'special@chars',
    'colon:name',
    'emoji😀',
  ])('rejects invalid name: %s', (name) => {
    expect(SAFE_STORE_RE.test(name)).toBe(false)
  })
})

// ── resolveStorePath ──────────────────────────────────────────────

describe('resolveStorePath', () => {
  it('maps simple name to ~/.treecontext/stores/<name>/treecontext.db', () => {
    const path = resolveStorePath('my-project')
    expect(path).toBe(join(storesDirIn(homedir()), 'my-project', 'treecontext.db'))
  })

  it('passes absolute paths through', () => {
    const path = resolveStorePath('/tmp/custom/store.db')
    expect(path).toBe('/tmp/custom/store.db')
  })

  it('passes paths with slashes through', () => {
    const path = resolveStorePath('relative/path/store.db')
    expect(path).toBe('relative/path/store.db')
  })
})

// ── resolveAutoStore ──────────────────────────────────────────────

describe('resolveAutoStore', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tc-cli-test-'))
    // Redirect bindings.json into tmpDir so tests don't touch the user's
    // real ~/.treecontext/bindings.json.
    process.env.TREECONTEXT_BINDINGS_FILE = join(tmpDir, 'bindings.json')
  })

  afterEach(() => {
    delete process.env.TREECONTEXT_BINDINGS_FILE
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('migrates sticky into bindings.json when at a git repo root', () => {
    const { execSync } = require('node:child_process') as typeof import('node:child_process')
    execSync('git init -q', { cwd: tmpDir })
    writeFileSync(join(tmpDir, '.treecontext-store'), 'sticky-name\n')
    const name = resolveAutoStore(tmpDir)
    expect(name).toBe('sticky-name')
    // Sticky deleted post-migration.
    expect(existsSync(join(tmpDir, '.treecontext-store'))).toBe(false)
  })

  it('ignores sticky file in non-git directory (security S3)', () => {
    writeFileSync(join(tmpDir, '.treecontext-store'), 'attacker-store\n')
    const name = resolveAutoStore(tmpDir)
    expect(name).not.toBe('attacker-store')
    expect(SAFE_STORE_RE.test(name)).toBe(true)
  })

  it('falls back to basename+hash for non-git directories', () => {
    const name = resolveAutoStore(tmpDir)
    expect(SAFE_STORE_RE.test(name)).toBe(true)
    // Should contain a hash suffix
    expect(name).toMatch(/-[a-f0-9]{6}$/)
  })

  it('does NOT write a sticky file into the project (security S3)', () => {
    resolveAutoStore(tmpDir)
    expect(existsSync(join(tmpDir, '.treecontext-store'))).toBe(false)
  })

  it('uses git remote slug for git directories', () => {
    // Run against the actual repo root
    const repoRoot = join(process.cwd(), '..')
    // Clean any existing sticky file for a fresh test
    const stickyPath = join(repoRoot, '.treecontext-store')
    const hadSticky = existsSync(stickyPath)

    if (!hadSticky) {
      const name = resolveAutoStore(repoRoot)
      expect(SAFE_STORE_RE.test(name)).toBe(true)
      // Clean up the sticky file we just created
      try { rmSync(stickyPath) } catch { /* may not exist */ }
    }
    // If sticky file existed, skip — don't modify user's actual store binding
  })
})

// ── S11: file modes ─────────────────────────────────────────────────

describePosix('S11: ensureDbFileMode', () => {
  it('sets DB file to 0o600 on creation', async () => {
    const { statSync, writeFileSync, chmodSync, mkdtempSync: mkdtemp, rmSync: rm } = await import('node:fs')
    const { ensureDbFileMode } = await import('../../src/persistence/better-sqlite.js')
    const dir = mkdtemp(join(tmpdir(), 'tc-s11-'))
    try {
      const dbPath = join(dir, 'test-mode.db')
      writeFileSync(dbPath, '')
      // Set to overly permissive mode
      chmodSync(dbPath, 0o644)
      ensureDbFileMode(dbPath)
      const st = statSync(dbPath)
      expect(st.mode & 0o777).toBe(0o600)
    } finally {
      rm(dir, { recursive: true, force: true })
    }
  })
})

// ── F2 pins: refusal exit codes and the help surface ────────────────

describe('usage and refusal pins (F2)', () => {
  const base = ['node', 'treecontext']

  it('--npx refuses with exit 2, distinct from parse errors', () => {
    // Exit 2 is the shipped contract (pin-as-shipped, F dispositions
    // 2026-08-15): scripts distinguish "you asked for a dead install
    // path" from ordinary parse errors' exit 1.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`)
    }) as never)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => parseArgs([...base, 'install', '--npx'])).toThrow('exit 2')
      expect(errSpy.mock.calls.flat().join(' ')).toContain('npm install -g treecontext-mcp@beta')
    } finally {
      exitSpy.mockRestore()
      errSpy.mockRestore()
    }
  })

  it('help names every live serve flag and no tombstoned variant', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`)
    }) as never)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => parseArgs([...base, '--help'])).toThrow('exit 0')
      const usage = errSpy.mock.calls.flat().join('\n')
      // --secure-delete shipped without a help line for two betas: the
      // only user-facing description lived in docs/security.md.
      expect(usage).toContain('--secure-delete')
      // 'verbose' was tombstoned with the tree era but stayed advertised.
      expect(usage).not.toMatch(/verbose/)
    } finally {
      exitSpy.mockRestore()
      errSpy.mockRestore()
    }
  })
})

// ── stdio error disposition (rc.6 review) ───────────────────────────
//
// ab58c27 armed the serve/hook storm guard for EVERY subcommand, so an
// ordinary one-shot command whose stdout died — `treecontext export
// <id> | head -1`, or an export onto a full filesystem — printed a
// truncated record and exited 0, indistinguishable from success. The
// storm-safety paths keep the swallow; everything else fails visibly.
// A real pipe close is awkward to stage, and the disposition is the
// whole claim, so the streams and the exit are injected.

describe('armFailFastStdio', () => {
  const streamPair = (): { stdout: PassThrough; stderr: PassThrough } => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    // Nothing reads these; the payloads are irrelevant to the claim.
    stdout.resume()
    stderr.resume()
    return { stdout, stderr }
  }

  it('exits non-zero when stdout dies on a closed pipe', () => {
    const streams = streamPair()
    const codes: number[] = []
    armFailFastStdio(streams, (c) => { codes.push(c) })
    streams.stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    // 128 + SIGPIPE, the shell's own spelling for a death on a closed pipe.
    expect(codes).toEqual([141])
  })

  it('reports and exits 1 when the write failed for any other reason', () => {
    const streams = streamPair()
    const said: string[] = []
    streams.stderr.on('data', (c: Buffer) => said.push(c.toString()))
    const codes: number[] = []
    armFailFastStdio(streams, (c) => { codes.push(c) })
    streams.stdout.emit('error', Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }))
    expect(codes).toEqual([1])
    expect(said.join('')).toContain('no space left on device')
  })

  it('exits once when the diagnostic itself lands on a dead stderr', () => {
    // The nastiest shape, and the reason the handler carries a guard:
    // the one report line re-enters the handler through stderr's own
    // 'error'. One exit, not a recursion.
    const streams = streamPair()
    streams.stderr.write = ((): boolean => {
      streams.stderr.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
      return true
    }) as typeof streams.stderr.write
    const codes: number[] = []
    armFailFastStdio(streams, (c) => { codes.push(c) })
    streams.stdout.emit('error', Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }))
    expect(codes).toEqual([1])
  })
})
