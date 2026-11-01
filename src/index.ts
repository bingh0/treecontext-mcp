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

// Legs, workers and runs (beta.3, D279–D352): the rows a run is made of,
// the registry facts a leg is registered with, and the reads over both —
// for any program holding the store file (library first, AGENTS.md 5).
export {
  CHECKPOINT_KIND, BRIEF_KIND, RUN_OPEN_KIND, RUN_CLOSE_KIND, FIRST_MOMENT_KIND, RUN_META_KEY, KEY_META_KEY,
  RUN_ROW_KINDS, RUN_DEDUP_CLASS, runRowKindOf,
  CHECKPOINT_NUMBER_KEY, SUPERSEDES_KEY, SUPERSEDES_SRC_KEY, SUPERSEDES_BY_WRITER, SUPERSEDES_BY_STORE, SUPERSEDES_PENDING,
  RESTS_ON_KEY, CHECKPOINTER_KEY, CHECKPOINTED_BY_KEY, BRIEF_FOR_KEY, OPENED_BY_KEY, OPENED_VIA_KEY, PARENT_RUN_KEY,
  PARENT_LEG_KEY, CLOSED_BY_KEY, REASON_KEY, DOOR_KEY, IDENTITY_KEY, CWD_KEY, PARENT_KEY, PARENT_SRC_KEY,
  RUN_ROWS_SQL, checkpointsUnder, checkpointsInEffect, nextCheckpointNumber, inEffectLine, briefsInEffect,
  runOpenOf, runClosesOf, legStateOf, lookupKey,
} from './runs.js'
export type { CheckpointRecord, BriefRecord, LegState, KeyLookup, RunReadHandle } from './runs.js'
export {
  WORKER_AGENT_ID, NOTICED_BY_LOOKUP, NOTICED_BY_STATUS, NOTICED_BY_SESSION_START,
  hasLegColumns, isLiveLeg, legWriterOf, legOf, legsOfRun, workersOfParent, workerOfSession,
  registerSubagentLeg, registerWorkerLeg, recordWorkerProcess, retireLeg, recordSendBack, settleLegKey,
  recordOpenedRun, mintWorkerSessionId, retirePhantoms,
} from './persistence/leg-registry.js'
export type {
  LegKind, LegDoor, LegIdentity, KeySource, LegEnding, LegRef, DeclaredParent, WorkerProcess, KeyCandidate,
  LegRegistration, LegFacts, WorkerTicket, WorkerStart, PhantomCheck, PhantomPass,
} from './persistence/leg-registry.js'
export { hostProbe, START_TOLERANCE_SECS } from './persistence/process-probe.js'
export type { ProcessProbe } from './persistence/process-probe.js'
