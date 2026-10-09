/**
 * The HTTP transport tombstone (0.1 corpus-audit ruling, 2026-08-12).
 *
 * This file previously "tested" HTTP auth against a hand-written mimic
 * server while the real transport could not start at all — its options
 * were parsed and then dropped at the startServer call, and the mimic
 * kept the suite green over a dead surface. The audit ruled the
 * transport out: both tree-era consumers (embedding daemon, shared
 * multi-client daemon) are gone, the library runs in-process, and no
 * user ever noticed the breakage. What remains to pin is the tombstone
 * itself: stale invocations must reach a curated message, not a working
 * flag, not 'Unknown flag'.
 */
import { describe, it, expect, vi } from 'vitest'
import { parseArgs } from '../../src/server/cli.js'

function parseExpectingError(argv: string[]): string {
  const errs: string[] = []
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.join(' ')) })
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__exit:${code}`)
  }) as never)
  try {
    parseArgs(argv)
    throw new Error('expected parseArgs to refuse')
  } catch (err) {
    expect((err as Error).message).toBe('__exit:1')
    return errs.join('\n')
  } finally {
    errSpy.mockRestore()
    exitSpy.mockRestore()
  }
}

describe('HTTP transport tombstone', () => {
  it.each([['http'], ['streamable-http']])('--transport %s reaches the curated removal message', (mode) => {
    const out = parseExpectingError(['node', 'cli', 'serve', '--transport', mode])
    expect(out).toContain('HTTP transport was removed')
    expect(out).toContain('stdio-only')
  })

  it.each([
    [['--http-token', 'x']],
    [['--insecure-http']],
    [['--http-max-body-bytes', '1024']],
    [['--port', '9000']],
    [['--host', '0.0.0.0']],
  ])('%j names its removal instead of failing as an unknown flag', (flagArgs) => {
    const out = parseExpectingError(['node', 'cli', 'serve', ...flagArgs as string[]])
    expect(out).toContain('removed with the HTTP transport')
  })

  it('stdio remains the transport and the only one', () => {
    const args = parseArgs(['node', 'cli', 'serve', '--transport', 'stdio'])
    expect(args.transport).toBe('stdio')
    const out = parseExpectingError(['node', 'cli', 'serve', '--transport', 'carrier-pigeon'])
    expect(out).toContain('expected "stdio"')
  })
})
