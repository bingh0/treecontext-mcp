/**
 * TOML config loader tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfigFile } from '../../src/server/config.js'
import { redirectHome } from '../helpers/home.js'
import { applyConfigFile, parseArgs } from '../../src/server/cli.js'

describe('loadConfigFile', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tc-cfg-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns empty result when no config file exists', () => {
    const prevConfig = process.env.TREECONTEXT_CONFIG
    // Every home variable: loadConfigFile falls back to os.homedir(), which
    // ignores HOME on Windows, so a HOME-only redirect would let this read the
    // developer's real ~/.treecontext/config.toml and pass for the wrong reason.
    const restoreHome = redirectHome(dir)
    delete process.env.TREECONTEXT_CONFIG
    try {
      const cfg = loadConfigFile(null, dir)
      expect(cfg.path).toBeNull()
      expect(cfg.server).toEqual({})
    } finally {
      restoreHome()
      if (prevConfig !== undefined) process.env.TREECONTEXT_CONFIG = prevConfig
    }
  })

  it('loads an explicit path and maps snake_case to camelCase', () => {
    const p = join(dir, 'custom.toml')
    writeFileSync(
      p,
      [
        '[server]',
        'transport = "http"',
        'port = 9000',
        'host = "0.0.0.0"',
        'shield_threshold = 4096',
        'shield_dir = "/tmp/shield"',
      ].join('\n'),
    )
    const cfg = loadConfigFile(p)
    expect(cfg.path).toBe(p)
    expect(cfg.server.transport).toBe('http')
    expect(cfg.server.port).toBe(9000)
    expect(cfg.server.host).toBe('0.0.0.0')
    expect(cfg.server.shieldThreshold).toBe(4096)
    expect(cfg.server.shieldDir).toBe('/tmp/shield')
  })

  it('ignores retired [tree] and [embedding] sections without failing', () => {
    const p = join(dir, 'legacy.toml')
    writeFileSync(
      p,
      [
        '[tree]',
        'similarity_threshold = 0.55',
        '',
        '[embedding]',
        'model = "bge-small-en-v1.5"',
        '',
        '[server]',
        'port = 9000',
      ].join('\n'),
    )
    const cfg = loadConfigFile(p)
    expect(cfg.path).toBe(p)
    expect(cfg.server.port).toBe(9000)
  })

  it('auto-discovers treecontext.toml in the project dir', () => {
    writeFileSync(
      join(dir, 'treecontext.toml'),
      '[server]\nport = 9100\n',
    )
    const cfg = loadConfigFile(null, dir)
    expect(cfg.path).toBe(join(dir, 'treecontext.toml'))
    expect(cfg.server.port).toBe(9100)
  })

  it('rejects an explicit path that does not exist', () => {
    expect(() => loadConfigFile(join(dir, 'nope.toml'))).toThrow(/not found/)
  })

  it('normalizes transport "streamable-http" to "http"', () => {
    const p = join(dir, 'c.toml')
    writeFileSync(p, '[server]\ntransport = "streamable-http"\n')
    const cfg = loadConfigFile(p)
    expect(cfg.server.transport).toBe('http')
  })
})

describe('applyConfigFile — precedence', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-cfg-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('fills defaults when CLI flag not provided (capture/sidecar)', () => {
    const p = join(dir, 'c.toml')
    writeFileSync(p, '[server]\ncapture = true\nsidecar = false\n')
    const args = parseArgs(['node', 'cli'])
    applyConfigFile(args, loadConfigFile(p))
    expect(args.capture).toBe(true)
    expect(args.sidecar).toBe(false)
  })

  it('CLI flag beats config file', () => {
    const p = join(dir, 'c.toml')
    writeFileSync(p, '[server]\nshield_threshold = 4096\n')
    const args = parseArgs(['node', 'cli', '--shield-threshold', '1024'])
    applyConfigFile(args, loadConfigFile(p))
    expect(args.shieldThreshold).toBe(1024)
  })

  it('tombstoned transport/port/host keys are tolerated and ignored', () => {
    // Retired-key tolerance (HTTP transport removed 0.1): an old config
    // file must not break the server, and must not resurrect the flag.
    const p = join(dir, 'c.toml')
    writeFileSync(
      p,
      '[server]\ntransport = "http"\nport = 9000\nhost = "0.0.0.0"\n',
    )
    const args = parseArgs(['node', 'cli'])
    applyConfigFile(args, loadConfigFile(p))
    expect(args.transport).toBe('stdio')
  })
})
