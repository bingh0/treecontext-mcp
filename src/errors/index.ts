/**
 * Error hierarchy for treecontext.
 *
 * All errors extend TreecontextError so consumers can catch at the
 * boundary with a single type guard. Each subclass carries a `code`
 * string for programmatic matching.
 */

export class TreecontextError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TreecontextError'
    this.code = code
  }
}

export class SchemaVersionError extends TreecontextError {
  constructor(message: string, options?: ErrorOptions) {
    super('SCHEMA_VERSION', message, options)
    this.name = 'SchemaVersionError'
  }
}

export class MigrationRequiredError extends TreecontextError {
  constructor(message: string, options?: ErrorOptions) {
    super('MIGRATION_REQUIRED', message, options)
    this.name = 'MigrationRequiredError'
  }
}

export class StoreBusyError extends TreecontextError {
  constructor(message: string, options?: ErrorOptions) {
    super('STORE_BUSY', message, options)
    this.name = 'StoreBusyError'
  }
}

export class NodeNotFoundError extends TreecontextError {
  constructor(message: string, options?: ErrorOptions) {
    super('NODE_NOT_FOUND', message, options)
    this.name = 'NodeNotFoundError'
  }
}

export class StoreLockedError extends TreecontextError {
  readonly holder: { pid: number; host: string; startedAt: string }

  constructor(
    message: string,
    holder: { pid: number; host: string; startedAt: string },
    options?: ErrorOptions,
  ) {
    super('STORE_LOCKED', message, options)
    this.name = 'StoreLockedError'
    this.holder = holder
  }
}

export class ValidationError extends TreecontextError {
  constructor(message: string, options?: ErrorOptions) {
    super('VALIDATION', message, options)
    this.name = 'ValidationError'
  }
}

/** A `nodes.content` BLOB carried an unrecognized format flag byte, or
 *  claimed zstd encoding on a runtime whose node:zlib lacks zstd support. */
export class ContentDecodeError extends TreecontextError {
  constructor(message: string, options?: ErrorOptions) {
    super('CONTENT_DECODE', message, options)
    this.name = 'ContentDecodeError'
  }
}
