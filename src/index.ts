// treecontext — platform-neutral core exports
// Platform-specific backends (persistence/node, etc.) are imported via
// subpath exports and NOT re-exported here.

// FlatStore — the journal (main entry point)
export { FlatStore } from './flat-store.js'
export type { FlatStoreOptions } from './flat-store.js'

// Core
export type {
  InsertResult,
  QueryResult,
  TreeStatus,
  QueryOptions,
  InsertOptions,
} from './core/types.js'

// Persistence (types only — adapters via subpath exports)
export type { Database, Statement, RunResult } from './persistence/database.js'

// Errors
export {
  TreecontextError,
  SchemaVersionError,
  MigrationRequiredError,
  StoreBusyError,
  NodeNotFoundError,
} from './errors/index.js'
