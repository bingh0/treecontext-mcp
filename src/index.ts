// treecontext — platform-neutral core exports
// Platform-specific backends (persistence/node, etc.) are imported via
// subpath exports and NOT re-exported here.

// FlatStore — the journal (main entry point)
export { FlatStore } from './flat-store.js'
export type { FlatStoreOptions } from './flat-store.js'

// Core
export type {
  InsertResult,
  CheckpointRefusal,
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
  RUN_ROWS_SQL, checkpointsUnder, checkpointsInEffect, inEffectAmong, nextCheckpointNumber, inEffectLine, briefsInEffect,
  briefsOfKey, runOpenOf, runClosesOf, HANDOFF_CLAIMS_KEY, CHECKPOINT_CAP_CHARS, OVER_CAP_KEY, checkpointCapRefusal, importedLegsOf, importedRunRowsOf, importedBriefsCount, numberWords,
} from './runs.js'
export type { CheckpointRecord, BriefRecord, RunReadHandle, ImportedLeg } from './runs.js'
// A run's export and the way a leg that ran elsewhere comes back (D300,
// D310, D318, D343): the one logic under the export tool, the shell and
// the library, and a leg's registration as a row of the file.
export { exportRun, buildHandoff, checkRunForm, SECRETS_WARNING, RUN_SECRETS_WARNING, IMPORT_DOOR, IMPORT_IDENTITY } from './handoff.js'
export type { RunExportRequest, RunExportResult, BuildHandoffOptions, BuiltHandoff, HandoffForm, RunLines } from './handoff.js'
export {
  SKELETON_KINDS, FIRST_MOMENTS_NOTE, PROMPT_UNSEEN_SENTENCE, isDoorLine, doorLineNote, holdsErrorTail, errorTailNote, legFactsOf, legFromFacts,
  registrationNode, registrationRowId, differingFacts,
} from './run-export.js'
export type { RunForm } from './run-export.js'
// The key lookup, the harness's and the agent's one reply (D289, D296,
// D301, D312, D336, D337, D343, D344).
export {
  LAST_SIZES_SHOWN, KEY_LOOKUP_PARAM, lookupKey, keyLookupReply, legStateOf, isKeylessLeg, lastWriteOf,
  namedCheckpointerOf, isNamedCheckpointer, checkpointerFlag, importFlag, legReturnOf, checkpointName, checkpointNameOf, checkpointsWrittenBy,
} from './key-lookup.js'
export type { LegState, KeyLookup, KeyLookupReply, LookupCheckpoint, LegReturn, RunFacts, NamedCheckpointer } from './key-lookup.js'
export {
  WORKER_AGENT_ID, NOTICED_BY_LOOKUP, NOTICED_BY_STATUS, NOTICED_BY_SESSION_START, NOTICED_BY_TICKET_DOOR,
  hasLegColumns, isLiveLeg, legWriterOf, legOf, legsOfRun, workersOfParent, workerOfSession,
  registerSubagentLeg, registerWorkerLeg, recordWorkerProcess, retireLeg, recordSendBack, settleLegKey,
  recordOpenedRun, mintWorkerSessionId, retirePhantoms, legReturnStamp, capRefusalsOf, recordCapRefusal, legOwnsKey, capRefusalOf,
} from './persistence/leg-registry.js'
export type {
  LegKind, LegDoor, LegIdentity, KeySource, LegEnding, LegRef, DeclaredParent, WorkerProcess, KeyCandidate,
  LegRegistration, LegFacts, WorkerTicket, WorkerStart, PhantomCheck, PhantomPass, CapRefusal,
} from './persistence/leg-registry.js'
export { hostProbe, START_TOLERANCE_SECS } from './persistence/process-probe.js'
// The ticket door (D288, D291, D298, D303, D307, D335, D340, D341): the
// ticket a headless worker carries in its environment, the first moment
// both doors compose, and the library spawner (`treecontext run` is the
// same call from a shell).
export {
  TICKET_ENV, WORKER_SESSION_ENV, TICKET_VERSION, REQUIRED_TICKET_FIELDS, TICKET_FIELDS, mintTicket, readTicket,
  ticketTextIn, workerSessionIn, declaresDoor, ticketMatches, trustedWorkerLane,
} from './ticket.js'
export type { TicketFields, TicketReading } from './ticket.js'
export {
  STATE_NOT_HISTORY_LINE, PROMPT_HEADING, FIRST_MOMENT_PREVIEW_LEN, FIRST_MOMENT_META_KEY, invalidInstructionsMessage,
  sendBackReason, momentText, laneRowsOf, owesCheckpoint, predecessorOf, recoveryLine, firstMomentFactsOf, composeFirstMessage,
  composeSendBackMessage, doorRowBoundaries, firstMomentMetadata, sendBackMetadata, NO_CHECKPOINTER_LINE,
} from './first-moment.js'
export type { FirstMomentFacts, Predecessor } from './first-moment.js'
export {
  spawnWorker, claimTicket, sendBackDecision, openDoorStore, notStartedLine, DOOR_BUSY_WAIT_MS, NOT_STARTED_EXIT,
  TICKET_REFUSED_EXIT, SPAWN_FAILED_EXIT, TIMEOUT_GRACE_MS, STDOUT_DRAIN_MS, DOOR_LINE_PREFIX,
} from './ticket-door.js'
export type {
  SpawnWorkerOptions, WorkerRunResult, WorkerRunRecord, WorkerEnding, SendBackInput, SendBackVerdict, ClaimedTicket,
} from './ticket-door.js'
export { SUBAGENT_SUMMARY_KIND, SEND_BACK_KIND, TICKET_REFUSED_KIND, LEG_REGISTRATION_KIND, LEG_REGISTRATION_KEY, REGISTRATION_DIFFERS_KEY, IDENTITY_ROW_KINDS, isIdentityRow } from './run-kinds.js'
export type { ProcessProbe } from './persistence/process-probe.js'
