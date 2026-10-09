/**
 * Error sanitization for MCP tool responses.
 *
 * Over HTTP, unknown errors are replaced with a generic message and a
 * correlation ID. Known-safe error classes pass their message through.
 * Over stdio (local trust), all messages pass through unmodified.
 */

import { randomBytes } from 'node:crypto'
import { warn } from '../debug.js'
import {
  TreecontextError,
} from '../errors/index.js'

/** Error classes whose messages are safe to expose over HTTP. */
const SAFE_ERRORS: ReadonlySet<string> = new Set([
  'NodeNotFoundError',
  'StoreLockedError',
  'ValidationError',
  'StoreBusyError',
  'SchemaVersionError',
  'MigrationRequiredError',
])

export interface SanitizeOptions {
  transport: 'stdio' | 'http'
}

export interface SanitizedError {
  message: string
  correlationId?: string
}

/**
 * Sanitize an error for external consumption.
 *
 * - stdio: full message (local-trust model)
 * - HTTP + known error: pass message
 * - HTTP + unknown error: generic message + correlation ID; real error
 *   logged to stderr
 */
export function sanitizeError(err: unknown, opts: SanitizeOptions): SanitizedError {
  const message = err instanceof Error ? err.message : String(err)

  // stdio is local-trust — pass everything through.
  if (opts.transport === 'stdio') {
    return { message }
  }

  // HTTP: check if the error is a known-safe type.
  if (err instanceof Error && SAFE_ERRORS.has(err.constructor.name)) {
    return { message }
  }
  if (err instanceof TreecontextError) {
    // All TreecontextError subclasses are safe by design.
    return { message }
  }

  // Unknown error — sanitize.
  const correlationId = randomBytes(8).toString('hex')
  warn(`[treecontext] Internal error [${correlationId}]:`, err)
  return {
    message: 'Internal error',
    correlationId,
  }
}
