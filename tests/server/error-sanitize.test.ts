import { describe, it, expect, vi, afterEach } from 'vitest'
import { sanitizeError } from '../../src/errors/sanitize.js'
import {
  NodeNotFoundError,
  StoreLockedError,
  TreecontextError,
} from '../../src/errors/index.js'

describe('sanitizeError', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('stdio + any error → full message', () => {
    const err = new Error('SQL failed: no such table nodes')
    const result = sanitizeError(err, { transport: 'stdio' })
    expect(result.message).toBe('SQL failed: no such table nodes')
    expect(result.correlationId).toBeUndefined()
  })

  it('HTTP + known error → message passed', () => {
    const err = new NodeNotFoundError('Node abc not found')
    const result = sanitizeError(err, { transport: 'http' })
    expect(result.message).toBe('Node abc not found')
    expect(result.correlationId).toBeUndefined()
  })

  it('HTTP + StoreLockedError → message passed', () => {
    const err = new StoreLockedError('locked', { pid: 1, host: 'h', startedAt: 'now' })
    const result = sanitizeError(err, { transport: 'http' })
    expect(result.message).toBe('locked')
  })

  it('HTTP + generic Error → "Internal error" + ID; stderr has real one', () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const err = new Error('SQLITE_CORRUPT: database disk image is malformed')
    const result = sanitizeError(err, { transport: 'http' })
    expect(result.message).toBe('Internal error')
    expect(result.correlationId).toMatch(/^[0-9a-f]{16}$/)
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining(result.correlationId!),
      err,
    )
  })

  it('HTTP + string error → generic message', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = sanitizeError('raw string error', { transport: 'http' })
    expect(result.message).toBe('Internal error')
    expect(result.correlationId).toBeDefined()
  })

  it('HTTP + TreecontextError subclass → message passed', () => {
    const err = new TreecontextError('CUSTOM', 'custom error')
    const result = sanitizeError(err, { transport: 'http' })
    expect(result.message).toBe('custom error')
  })
})
