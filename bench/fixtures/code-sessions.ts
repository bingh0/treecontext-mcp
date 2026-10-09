/**
 * A curated coding-session journal, and the judgments over it.
 *
 * WHY THIS IS AUTHORED RATHER THAN SAMPLED: no public corpus contains what
 * this product actually stores. LongMemEval is human↔assistant chat;
 * LongMemEval-V2 is web-agent DOM. Neither has file paths, symbol names,
 * compiler error codes, stack frames, or shell invocations — the
 * vocabulary that makes a coding journal what it is, and the exact
 * vocabulary the decision to delete dense retrieval was justified on
 * ("single-author and identifier-dense, so vocabulary mismatch is the
 * exception, ~1.7% here"). That claim has never been tested on code.
 *
 * THE SESSIONS ARE FICTION, THE SHAPE IS NOT. A fictional service is used
 * rather than this repository so that nobody mistakes fixture text for
 * project history. Entry shapes follow what the hooks really capture: user
 * prompts, tool calls with their output, assistant turn-ends, and curated
 * notes.
 *
 * THE JUDGMENTS ARE THE POINT. Each query declares a `kind`, and those
 * kinds become the report's slices:
 *
 *   identifier — an exact symbol the user remembers (`drainQueue`)
 *   path       — a file path, punctuation and all
 *   error      — a compiler or runtime code (`TS2345`, `SQLITE_BUSY`)
 *   command    — a shell invocation
 *   paraphrase — the user remembers the SUBSTANCE but not the words. No
 *                term overlap with the gold entry is guaranteed.
 *   recall     — "what was I doing about X", the cold-start question
 *
 * That split is what makes this arm able to answer the embedder question
 * honestly. Lexical retrieval should be strong on the first four and weak
 * on `paraphrase`; if dense embeddings earn a seat anywhere in this
 * product, `paraphrase` and `recall` are where it will show. A fixture
 * containing only identifier queries would rig the result in BM25's
 * favour, and one containing only paraphrases would rig it against.
 *
 * HONEST LIMITATION: 199 entries across 48 sessions is still a thin
 * distractor set next to a real journal of tens of thousands, and the
 * paraphrases are as hard as their author decided to make them. Absolute
 * numbers here mean less than the CONTRAST BETWEEN SLICES, which is what
 * the arm is built to report.
 */

export interface FixtureEntry {
  id: string
  session: string
  role: 'user' | 'assistant' | 'tool' | 'note'
  text: string
}

export interface FixtureQuery {
  id: string
  query: string
  kind: 'identifier' | 'path' | 'error' | 'command' | 'paraphrase' | 'recall'
  gold: string[]
}

export const ENTRIES: FixtureEntry[] = [
  // ── s1: ingestion queue backpressure ────────────────────────────────
  { id: 'e001', session: 's1', role: 'user', text: 'the ingest worker falls over when the upstream feed bursts. can you look at the queue?' },
  { id: 'e002', session: 's1', role: 'tool', text: 'Tool: Read\nInput: {"file_path":"src/ingest/queue.ts"}\nOutput: export async function drainQueue(batch: number): Promise<DrainResult> { ... }' },
  { id: 'e003', session: 's1', role: 'assistant', text: 'drainQueue pulls a fixed batch of 500 with no regard for downstream capacity, so a burst just moves the pileup one layer down.' },
  { id: 'e004', session: 's1', role: 'note', text: 'Decision: introduce BackpressureError from drainQueue when the sink reports a full buffer, rather than growing the batch. Rejected: unbounded in-memory buffering — it converts a visible stall into an invisible OOM.' },
  { id: 'e005', session: 's1', role: 'tool', text: 'Tool: Edit\nInput: {"file_path":"src/ingest/queue.ts"}\nOutput: added BackpressureError and a drainQueue signature taking a SinkCapacity probe' },
  { id: 'e006', session: 's1', role: 'tool', text: 'Tool: Bash\nInput: {"command":"npm run test -- ingest"}\nOutput: 34 passing, 2 failing — queue.test.ts expects the old fixed-batch signature' },
  { id: 'e007', session: 's1', role: 'assistant', text: 'Updated queue.test.ts for the new signature. Full ingest suite green.' },

  // ── s2: sqlite contention ───────────────────────────────────────────
  { id: 'e008', session: 's2', role: 'user', text: 'getting intermittent write failures in staging under load' },
  { id: 'e009', session: 's2', role: 'tool', text: 'Tool: Bash\nInput: {"command":"grep -rn SQLITE_BUSY logs/"}\nOutput: logs/worker-3.log:882: SqliteError: SQLITE_BUSY: database is locked\nlogs/worker-7.log:1204: SqliteError: SQLITE_BUSY: database is locked' },
  { id: 'e010', session: 's2', role: 'assistant', text: 'Two writers on one file without WAL. SQLITE_BUSY is the default rollback journal serialising them.' },
  { id: 'e011', session: 's2', role: 'note', text: 'Decision: enable WAL mode plus a 5000ms busy_timeout in openDatabase. Rejected: a retry wrapper in application code — it papers over lock contention and hides how long writers actually wait.' },
  { id: 'e012', session: 's2', role: 'tool', text: 'Tool: Edit\nInput: {"file_path":"src/storage/openDatabase.ts"}\nOutput: db.pragma("journal_mode = WAL"); db.pragma("busy_timeout = 5000")' },
  { id: 'e013', session: 's2', role: 'tool', text: 'Tool: Bash\nInput: {"command":"npm run soak -- --writers 8 --minutes 10"}\nOutput: 10m soak, 8 concurrent writers, 0 SQLITE_BUSY, p99 write 41ms' },

  // ── s3: a type error nobody could read ──────────────────────────────
  { id: 'e014', session: 's3', role: 'user', text: 'the build is broken on main and the error is unreadable' },
  { id: 'e015', session: 's3', role: 'tool', text: 'Tool: Bash\nInput: {"command":"npx tsc --noEmit"}\nOutput: src/api/handlers.ts(88,14): error TS2345: Argument of type \'RequestContext | undefined\' is not assignable to parameter of type \'RequestContext\'.' },
  { id: 'e016', session: 's3', role: 'assistant', text: 'withContext returns RequestContext | undefined since the auth refactor, and handleUpload takes it unguarded.' },
  { id: 'e017', session: 's3', role: 'tool', text: 'Tool: Edit\nInput: {"file_path":"src/api/handlers.ts"}\nOutput: added an explicit guard that throws UnauthenticatedError instead of widening the parameter type' },
  { id: 'e018', session: 's3', role: 'note', text: 'Rejected: making the handler parameter optional to silence TS2345. That moves a missing-auth bug from compile time to runtime, which is the wrong direction.' },

  // ── s4: retries and the dead letter ruling ──────────────────────────
  { id: 'e019', session: 's4', role: 'user', text: 'uploads keep retrying forever against a bucket that returns 403. can we bound that?' },
  { id: 'e020', session: 's4', role: 'tool', text: 'Tool: Read\nInput: {"file_path":"src/upload/retry.ts"}\nOutput: while (true) { try { await put(obj) } catch { await sleep(backoff) } }' },
  { id: 'e021', session: 's4', role: 'assistant', text: 'An unbounded loop cannot distinguish a transient 503 from a permanent 403, so a misconfigured credential burns the worker forever.' },
  { id: 'e022', session: 's4', role: 'note', text: 'Decision: abandon the infinite retry loop. Permanent failures go to a dead-letter table after three attempts and the operator is paged; only 5xx and network timeouts are retried. Why: a failure nobody can see is worse than one that stops the pipeline.' },
  { id: 'e023', session: 's4', role: 'tool', text: 'Tool: Write\nInput: {"file_path":"src/upload/deadLetter.ts"}\nOutput: created deadLetter.ts with recordFailure() and listDeadLetters()' },
  { id: 'e024', session: 's4', role: 'tool', text: 'Tool: Bash\nInput: {"command":"npm run migrate -- --name add_dead_letter"}\nOutput: applied migration 014_add_dead_letter.sql' },

  // ── s5: the flaky migration test ────────────────────────────────────
  { id: 'e025', session: 's5', role: 'user', text: 'migration test fails maybe one run in five on CI, passes locally every time' },
  { id: 'e026', session: 's5', role: 'tool', text: 'Tool: Bash\nInput: {"command":"npm run test -- migrations --repeat 40"}\nOutput: 37 passing, 3 failing — "table applied_migrations already exists"' },
  { id: 'e027', session: 's5', role: 'assistant', text: 'Two test files share one temp database path derived from the date, so parallel workers collide when they start in the same second.' },
  { id: 'e028', session: 's5', role: 'note', text: 'Decision: derive the temp database path from mkdtemp rather than a timestamp, and stop sharing state across test files. The flake was never in the migration runner.' },
  { id: 'e029', session: 's5', role: 'tool', text: 'Tool: Edit\nInput: {"file_path":"tests/helpers/tempDb.ts"}\nOutput: replaced Date.now() path with mkdtempSync(join(tmpdir(), "orchard-"))' },
  { id: 'e030', session: 's5', role: 'tool', text: 'Tool: Bash\nInput: {"command":"npm run test -- migrations --repeat 100"}\nOutput: 100 passing, 0 failing' },

  // ── s6: a memory leak under the profiler ────────────────────────────
  { id: 'e031', session: 's6', role: 'user', text: 'RSS climbs about 40MB an hour on the ingest box and never comes back down' },
  { id: 'e032', session: 's6', role: 'tool', text: 'Tool: Bash\nInput: {"command":"node --heap-prof dist/worker.js --minutes 30"}\nOutput: heap profile written to heap-20260712.heapprofile; top retainer MetricsRegistry.samples (612MB)' },
  { id: 'e033', session: 's6', role: 'assistant', text: 'MetricsRegistry keeps every sample forever; nothing ever evicts. Thirty minutes of samples is already 612MB.' },
  { id: 'e034', session: 's6', role: 'note', text: 'Decision: MetricsRegistry keeps a rolling window of 10 minutes and exposes a histogram instead of raw samples. Rejected: a WeakMap keyed by sample — the samples are values, not identities, so nothing would ever be collected.' },
  { id: 'e035', session: 's6', role: 'tool', text: 'Tool: Edit\nInput: {"file_path":"src/observability/MetricsRegistry.ts"}\nOutput: added ringbuffer eviction at 10 minutes; samples[] no longer unbounded' },

  // ── s7: an auth refactor with a subtle regression ───────────────────
  { id: 'e036', session: 's7', role: 'user', text: 'move the token check out of every handler into one place' },
  { id: 'e037', session: 's7', role: 'tool', text: 'Tool: Write\nInput: {"file_path":"src/api/middleware/withContext.ts"}\nOutput: created withContext middleware resolving the caller once per request' },
  { id: 'e038', session: 's7', role: 'assistant', text: 'All twelve handlers now read ctx.caller instead of parsing the Authorization header themselves.' },
  { id: 'e039', session: 's7', role: 'tool', text: 'Tool: Bash\nInput: {"command":"npm run test -- api"}\nOutput: 88 passing, 1 failing — health endpoint now requires a token and should not' },
  { id: 'e040', session: 's7', role: 'note', text: 'Decision: withContext takes an allowlist of unauthenticated routes; /healthz and /metrics are on it. Rejected: skipping the middleware for those paths at the router level — two places to forget instead of one.' },

  // ── s8: an incident and its postmortem ──────────────────────────────
  { id: 'e041', session: 's8', role: 'user', text: 'we dropped about nine minutes of events last night, what happened' },
  { id: 'e042', session: 's8', role: 'tool', text: 'Tool: Bash\nInput: {"command":"journalctl -u orchard-ingest --since 02:00 --until 02:30"}\nOutput: 02:11:04 ECONNRESET upstream feed\n02:11:04 reconnect scheduled in 600s\n02:21:07 reconnected' },
  { id: 'e043', session: 's8', role: 'assistant', text: 'The reconnect backoff starts at ten minutes rather than growing to it, so a single ECONNRESET costs the full window even when the feed returns immediately.' },
  { id: 'e044', session: 's8', role: 'note', text: 'Decision: reconnect backoff starts at 1s and doubles to a 600s ceiling. Also: log the gap explicitly so a silent nine-minute hole is never inferred from a graph again.' },
  { id: 'e045', session: 's8', role: 'tool', text: 'Tool: Edit\nInput: {"file_path":"src/ingest/feedClient.ts"}\nOutput: replaced constant RECONNECT_DELAY_MS with exponential backoff capped at 600_000' },

  // ── s9: schema migration with a nasty default ───────────────────────
  { id: 'e046', session: 's9', role: 'user', text: 'adding a not-null column to events, it is a big table' },
  { id: 'e047', session: 's9', role: 'assistant', text: 'A NOT NULL column with a default rewrites every row in SQLite, which will lock the table for the length of the rewrite.' },
  { id: 'e048', session: 's9', role: 'note', text: 'Decision: add the column nullable, backfill in batches of 10k behind a feature flag, then tighten the constraint in a second migration. Why: one long lock on the events table is an outage; two short ones are not.' },
  { id: 'e049', session: 's9', role: 'tool', text: 'Tool: Bash\nInput: {"command":"npm run migrate -- --name add_events_region"}\nOutput: applied 015_add_events_region.sql in 84ms' },
  { id: 'e050', session: 's9', role: 'tool', text: 'Tool: Bash\nInput: {"command":"npm run backfill -- --table events --batch 10000"}\nOutput: backfilled 4,210,000 rows in 6m12s, max lock hold 38ms' },

  // ── s10: cli ergonomics ─────────────────────────────────────────────
  { id: 'e051', session: 's10', role: 'user', text: 'the cli flags are inconsistent, some take equals signs and some do not' },
  { id: 'e052', session: 's10', role: 'tool', text: 'Tool: Read\nInput: {"file_path":"src/cli/parseArgs.ts"}\nOutput: hand-rolled switch statement, 180 lines, two flags parsed with split("=") and the rest positionally' },
  { id: 'e053', session: 's10', role: 'note', text: 'Decision: keep the hand-rolled parser, normalise on space-separated flags, and reject --flag=value with a message naming the right form. Rejected: adopting a parser library for 180 lines of code we understand.' },
  { id: 'e054', session: 's10', role: 'tool', text: 'Tool: Edit\nInput: {"file_path":"src/cli/parseArgs.ts"}\nOutput: unified flag handling; unknown and malformed flags now exit 2 with usage' },

  // ── s11: performance work on the query path ─────────────────────────
  { id: 'e055', session: 's11', role: 'user', text: 'the events search endpoint got slow after the region column landed' },
  { id: 'e056', session: 's11', role: 'tool', text: 'Tool: Bash\nInput: {"command":"npm run bench -- --endpoint search"}\nOutput: p50 12ms p95 890ms p99 2.1s (was p95 40ms before 015)' },
  { id: 'e057', session: 's11', role: 'tool', text: 'Tool: Bash\nInput: {"command":"sqlite3 orchard.db \'EXPLAIN QUERY PLAN SELECT * FROM events WHERE region = ? AND ts > ?\'"}\nOutput: SCAN events' },
  { id: 'e058', session: 's11', role: 'assistant', text: 'No composite index covers the new filter, so every search scans the whole events table.' },
  { id: 'e059', session: 's11', role: 'note', text: 'Decision: add idx_events_region_ts on (region, ts). Rejected: two single-column indexes — SQLite would pick one and still scan within it.' },
  { id: 'e060', session: 's11', role: 'tool', text: 'Tool: Bash\nInput: {"command":"npm run bench -- --endpoint search"}\nOutput: p50 3ms p95 31ms p99 78ms' },

  // ── distractors: same vocabulary, different substance ───────────────
  // These exist so that ranking is non-trivial. They share terms with the
  // gold entries — queue, retry, migration, index, timeout — without
  // answering any query.
  { id: 'd001', session: 's12', role: 'tool', text: 'Tool: Bash\nInput: {"command":"npm run lint"}\nOutput: 0 problems' },
  { id: 'd002', session: 's12', role: 'user', text: 'can you bump the eslint config to the flat format' },
  { id: 'd003', session: 's12', role: 'tool', text: 'Tool: Edit\nInput: {"file_path":"eslint.config.js"}\nOutput: migrated to flat config; removed .eslintrc.json' },
  { id: 'd004', session: 's12', role: 'assistant', text: 'Lint passes on the flat config. No rule changes, only the file format.' },
  { id: 'd005', session: 's13', role: 'user', text: 'add a healthcheck endpoint for the load balancer' },
  { id: 'd006', session: 's13', role: 'tool', text: 'Tool: Write\nInput: {"file_path":"src/api/healthz.ts"}\nOutput: created /healthz returning 200 and the build sha' },
  { id: 'd007', session: 's13', role: 'tool', text: 'Tool: Bash\nInput: {"command":"curl -s localhost:8080/healthz"}\nOutput: {"ok":true,"sha":"9f2c1ab"}' },
  { id: 'd008', session: 's13', role: 'note', text: 'Healthcheck deliberately does not touch the database: a slow query should not take the instance out of rotation.' },
  { id: 'd009', session: 's14', role: 'user', text: 'the docker image is 1.2GB, can we trim it' },
  { id: 'd010', session: 's14', role: 'tool', text: 'Tool: Edit\nInput: {"file_path":"Dockerfile"}\nOutput: multi-stage build; runtime stage now node:22-slim' },
  { id: 'd011', session: 's14', role: 'tool', text: 'Tool: Bash\nInput: {"command":"docker build -t orchard:local ."}\nOutput: successfully built; image size 214MB' },
  { id: 'd012', session: 's14', role: 'note', text: 'Rejected: alpine base. The sqlite native build needed musl workarounds that cost more than the 60MB saved.' },
  { id: 'd013', session: 's15', role: 'user', text: 'write the readme quickstart' },
  { id: 'd014', session: 's15', role: 'tool', text: 'Tool: Write\nInput: {"file_path":"README.md"}\nOutput: added quickstart with install, migrate and run steps' },
  { id: 'd015', session: 's15', role: 'assistant', text: 'Quickstart covers install, npm run migrate, and starting the worker.' },
  { id: 'd016', session: 's16', role: 'user', text: 'the retry logic in the webhook sender needs a jitter' },
  { id: 'd017', session: 's16', role: 'tool', text: 'Tool: Edit\nInput: {"file_path":"src/webhooks/sender.ts"}\nOutput: added full-jitter backoff to the webhook retry loop' },
  { id: 'd018', session: 's16', role: 'assistant', text: 'Webhook retries now use full jitter, so a downstream restart no longer produces a synchronised thundering herd.' },
  { id: 'd019', session: 's16', role: 'note', text: 'Webhook retry is deliberately separate from upload retry: different failure modes, different budgets.' },
  { id: 'd020', session: 's17', role: 'tool', text: 'Tool: Bash\nInput: {"command":"npm run test -- webhooks"}\nOutput: 22 passing' },
  { id: 'd021', session: 's17', role: 'user', text: 'add an index on webhook_deliveries.created_at' },
  { id: 'd022', session: 's17', role: 'tool', text: 'Tool: Bash\nInput: {"command":"npm run migrate -- --name idx_webhook_created"}\nOutput: applied 016_idx_webhook_created.sql' },
  { id: 'd023', session: 's17', role: 'assistant', text: 'Index added. The delivery log query dropped from 300ms to 4ms.' },
  { id: 'd024', session: 's18', role: 'user', text: 'can the worker log in json' },
  { id: 'd025', session: 's18', role: 'tool', text: 'Tool: Edit\nInput: {"file_path":"src/observability/logger.ts"}\nOutput: added ORCHARD_LOG=json switching the formatter' },
  { id: 'd026', session: 's18', role: 'note', text: 'Logs go to stderr; stdout is reserved for piped output.' },
  { id: 'd027', session: 's19', role: 'user', text: 'the queue depth metric is always zero in grafana' },
  { id: 'd028', session: 's19', role: 'tool', text: 'Tool: Bash\nInput: {"command":"curl -s localhost:8080/metrics | grep queue_depth"}\nOutput: orchard_queue_depth 0' },
  { id: 'd029', session: 's19', role: 'assistant', text: 'The gauge is registered but never updated — nothing calls setQueueDepth outside the constructor.' },
  { id: 'd030', session: 's19', role: 'tool', text: 'Tool: Edit\nInput: {"file_path":"src/observability/MetricsRegistry.ts"}\nOutput: queue depth gauge now updated on every drain cycle' },
  { id: 'd031', session: 's20', role: 'user', text: 'timeout on the upstream feed handshake should be configurable' },
  { id: 'd032', session: 's20', role: 'tool', text: 'Tool: Edit\nInput: {"file_path":"src/ingest/feedClient.ts"}\nOutput: handshake timeout now reads ORCHARD_FEED_TIMEOUT_MS, default 10000' },
  { id: 'd033', session: 's20', role: 'assistant', text: 'Handshake timeout is configurable and defaults to ten seconds.' },
  { id: 'd034', session: 's21', role: 'user', text: 'we need a changelog' },
  { id: 'd035', session: 's21', role: 'tool', text: 'Tool: Write\nInput: {"file_path":"CHANGELOG.md"}\nOutput: created changelog with the 0.4 entries' },
  { id: 'd036', session: 's21', role: 'note', text: 'Changelog entries are written at release time from the merged PR titles, not per commit.' },
  { id: 'd037', session: 's22', role: 'user', text: 'the ingest suite takes four minutes, can it be faster' },
  { id: 'd038', session: 's22', role: 'tool', text: 'Tool: Bash\nInput: {"command":"npm run test -- ingest --reporter verbose"}\nOutput: slowest: feed reconnect suite 148s (real sleeps)' },
  { id: 'd039', session: 's22', role: 'assistant', text: 'The reconnect tests sleep for real. Injecting a clock would cut the suite to under a minute.' },
  { id: 'd040', session: 's22', role: 'note', text: 'Decision: inject a Clock interface into feedClient rather than mocking global timers, so the production path stays honest about time.' },
  { id: 'd041', session: 's23', role: 'user', text: 'rotate the staging credentials' },
  { id: 'd042', session: 's23', role: 'tool', text: 'Tool: Bash\nInput: {"command":"orchard secrets rotate --env staging"}\nOutput: rotated 4 secrets; workers restarted' },
  { id: 'd043', session: 's23', role: 'note', text: 'Secrets rotate quarterly. The worker reloads them on SIGHUP rather than requiring a restart.' },
  { id: 'd044', session: 's24', role: 'user', text: 'add pagination to the events endpoint' },
  { id: 'd045', session: 's24', role: 'tool', text: 'Tool: Edit\nInput: {"file_path":"src/api/handlers.ts"}\nOutput: added cursor pagination keyed on (ts, id)' },
  { id: 'd046', session: 's24', role: 'assistant', text: 'Cursor pagination is stable under concurrent inserts, unlike offset.' },
  { id: 'd047', session: 's24', role: 'note', text: 'Rejected: offset pagination. Rows shift under the reader when new events land mid-scroll.' },
  { id: 'd048', session: 's25', role: 'user', text: 'the build fails on node 20 but passes on 22' },
  { id: 'd049', session: 's25', role: 'tool', text: 'Tool: Bash\nInput: {"command":"nvm use 20 && npm run build"}\nOutput: error: Unexpected token; Object.groupBy is not a function' },
  { id: 'd050', session: 's25', role: 'assistant', text: 'Object.groupBy needs Node 21. Replaced with a reduce so the floor stays at 20.' },
  { id: 'd051', session: 's26', role: 'user', text: 'can we cache the region lookup' },
  { id: 'd052', session: 's26', role: 'tool', text: 'Tool: Edit\nInput: {"file_path":"src/api/regions.ts"}\nOutput: added a 60s TTL cache in front of the region table' },
  { id: 'd053', session: 's26', role: 'note', text: 'Region rows change monthly at most; a 60s TTL is generous and bounds staleness visibly.' },
  { id: 'd054', session: 's27', role: 'user', text: 'the worker should exit non-zero when it cannot reach the database at boot' },
  { id: 'd055', session: 's27', role: 'tool', text: 'Tool: Edit\nInput: {"file_path":"src/worker.ts"}\nOutput: boot now probes the database and exits 1 with a clear message' },
  { id: 'd056', session: 's27', role: 'assistant', text: 'A worker that starts and silently fails every job is worse than one that refuses to start.' },
  { id: 'd057', session: 's28', role: 'user', text: 'document the dead letter workflow for on-call' },
  { id: 'd058', session: 's28', role: 'tool', text: 'Tool: Write\nInput: {"file_path":"docs/runbook-dead-letter.md"}\nOutput: added a runbook covering listDeadLetters and manual replay' },
  { id: 'd059', session: 's28', role: 'assistant', text: 'Runbook covers inspecting the dead-letter table and replaying a single object.' },
  { id: 'd060', session: 's29', role: 'user', text: 'why is the docker healthcheck flapping' },
  { id: 'd061', session: 's29', role: 'tool', text: 'Tool: Bash\nInput: {"command":"docker inspect --format \'{{json .State.Health}}\' orchard"}\nOutput: 3 consecutive failures, exit 1, "connection refused"' },
  { id: 'd062', session: 's29', role: 'assistant', text: 'The healthcheck starts before the server binds. It needs a start period rather than a longer interval.' },
  { id: 'd063', session: 's29', role: 'tool', text: 'Tool: Edit\nInput: {"file_path":"Dockerfile"}\nOutput: HEALTHCHECK now has --start-period=20s' },
  { id: 'd064', session: 's30', role: 'user', text: 'add a --dry-run to the backfill command' },
  { id: 'd065', session: 's30', role: 'tool', text: 'Tool: Edit\nInput: {"file_path":"src/cli/backfill.ts"}\nOutput: --dry-run prints the batch plan and row counts without writing' },
  { id: 'd066', session: 's30', role: 'note', text: 'Every destructive command gets a dry run before it gets a --yes.' },
  { id: 'd067', session: 's31', role: 'tool', text: 'Tool: Bash\nInput: {"command":"npm audit"}\nOutput: 0 vulnerabilities' },
  { id: 'd068', session: 's31', role: 'user', text: 'pin the dependency versions' },
  { id: 'd069', session: 's31', role: 'tool', text: 'Tool: Edit\nInput: {"file_path":"package.json"}\nOutput: replaced caret ranges with exact versions' },

  // ── s32: rate limiting the public API ───────────────────────────────
  { id: 'e061', session: 's32', role: 'user', text: 'one customer is sending 4000 requests a minute and starving everyone else' },
  { id: 'e062', session: 's32', role: 'tool', text: 'Tool: Read\nInput: {"file_path":"src/api/middleware/rateLimit.ts"}\nOutput: fixed window counter, resets on the minute boundary' },
  { id: 'e063', session: 's32', role: 'assistant', text: 'A fixed window lets a caller spend its whole quota in the last second of one window and again in the first second of the next, so the effective burst is double the limit.' },
  { id: 'e064', session: 's32', role: 'note', text: 'Decision: replace the fixed window with a token bucket sized to burst 2x sustained rate. Rejected: sliding window log — accurate but stores one timestamp per request, which is the memory problem we just fixed elsewhere.' },
  { id: 'e065', session: 's32', role: 'tool', text: 'Tool: Edit\nInput: {"file_path":"src/api/middleware/rateLimit.ts"}\nOutput: replaced counter with TokenBucket; refill 100/s, capacity 200' },
  { id: 'e066', session: 's32', role: 'tool', text: 'Tool: Bash\nInput: {"command":"npm run loadtest -- --rps 4000 --tenant noisy"}\nOutput: noisy tenant throttled at 100rps, other tenants p99 unchanged at 22ms' },

  // ── s33: an expired certificate ─────────────────────────────────────
  { id: 'e067', session: 's33', role: 'user', text: 'every outbound webhook started failing an hour ago' },
  { id: 'e068', session: 's33', role: 'tool', text: 'Tool: Bash\nInput: {"command":"openssl s_client -connect hooks.partner.example:443 </dev/null"}\nOutput: verify error:num=10:certificate has expired' },
  { id: 'e069', session: 's33', role: 'assistant', text: 'Their leaf certificate expired at 02:00 UTC. Nothing on our side changed.' },
  { id: 'e070', session: 's33', role: 'note', text: 'Decision: do not add a bypass flag for TLS verification, even temporarily. Instead alert on peer certificates within 14 days of expiry so this is noticed before it becomes an outage. A disabled check is never re-enabled.' },
  { id: 'e071', session: 's33', role: 'tool', text: 'Tool: Write\nInput: {"file_path":"src/observability/certWatch.ts"}\nOutput: created certWatch with checkPeerExpiry() run daily' },

  // ── s34: configuration that failed late ─────────────────────────────
  { id: 'e072', session: 's34', role: 'user', text: 'a typo in the config took production down and we only found out on the first request' },
  { id: 'e073', session: 's34', role: 'tool', text: 'Tool: Read\nInput: {"file_path":"src/config/load.ts"}\nOutput: values read lazily via process.env at each call site' },
  { id: 'e074', session: 's34', role: 'assistant', text: 'Nothing validates the environment at boot, so a misspelled ORCHARD_REGION only surfaces when a request happens to read it.' },
  { id: 'e075', session: 's34', role: 'note', text: 'Decision: parse and validate the entire environment once at startup with a schema, and refuse to boot on a failure. Why: a process that starts successfully is a promise it can serve traffic, and lazy config breaks that promise quietly.' },
  { id: 'e076', session: 's34', role: 'tool', text: 'Tool: Edit\nInput: {"file_path":"src/config/load.ts"}\nOutput: added loadConfig() with a zod schema; boot exits 78 on invalid config' },
  { id: 'e077', session: 's34', role: 'tool', text: 'Tool: Bash\nInput: {"command":"ORCHARD_REGON=eu npm run start"}\nOutput: config error: unknown key ORCHARD_REGON (did you mean ORCHARD_REGION?); exit 78' },

  // ── s35: partial failure in a batch ─────────────────────────────────
  { id: 'e078', session: 's35', role: 'user', text: 'if one record in a batch is bad the whole batch is rejected and we lose the good ones' },
  { id: 'e079', session: 's35', role: 'tool', text: 'Tool: Read\nInput: {"file_path":"src/ingest/batchWriter.ts"}\nOutput: single transaction wrapping the whole batch; any throw rolls back everything' },
  { id: 'e080', session: 's35', role: 'note', text: 'Decision: keep the transaction but validate every record before opening it, routing rejects to the dead-letter table with their reason. Rejected: per-record transactions — 10k transactions per batch destroyed write throughput in the soak test.' },
  { id: 'e081', session: 's35', role: 'tool', text: 'Tool: Edit\nInput: {"file_path":"src/ingest/batchWriter.ts"}\nOutput: added validateBatch() partitioning into accepted and rejected before the transaction' },
  { id: 'e082', session: 's35', role: 'tool', text: 'Tool: Bash\nInput: {"command":"npm run test -- batchWriter"}\nOutput: 18 passing; a batch with 3 bad records now writes 9997 and dead-letters 3' },

  // ── s36: clock skew and ordering ────────────────────────────────────
  { id: 'e083', session: 's36', role: 'user', text: 'events sometimes appear out of order in the timeline even though they were sent in order' },
  { id: 'e084', session: 's36', role: 'tool', text: 'Tool: Bash\nInput: {"command":"chronyc tracking | head -3"}\nOutput: System time     : 0.412 seconds slow of NTP time' },
  { id: 'e085', session: 's36', role: 'assistant', text: 'Timestamps are taken on the sending worker, and the workers disagree by up to half a second, so ordering across workers is not meaningful.' },
  { id: 'e086', session: 's36', role: 'note', text: 'Decision: order by a server-assigned monotonic sequence, keep the producer timestamp as an attribute for display only. Why: wall-clock ordering across machines is a property nobody can guarantee, and pretending otherwise pushes the problem to whoever reads the timeline.' },
  { id: 'e087', session: 's36', role: 'tool', text: 'Tool: Bash\nInput: {"command":"npm run migrate -- --name add_events_seq"}\nOutput: applied 017_add_events_seq.sql' },

  // ── s37: streaming responses and slow consumers ─────────────────────
  { id: 'e088', session: 's37', role: 'user', text: 'the export endpoint holds memory until the client finishes downloading' },
  { id: 'e089', session: 's37', role: 'tool', text: 'Tool: Read\nInput: {"file_path":"src/api/export.ts"}\nOutput: rows.map(toCsv).join("\\n") built entirely before res.send' },
  { id: 'e090', session: 's37', role: 'assistant', text: 'The whole export is materialised as one string, so a 400MB export needs 400MB of heap and a slow client holds it for the duration.' },
  { id: 'e091', session: 's37', role: 'note', text: 'Decision: stream rows through a Transform into the response and let TCP backpressure govern the pace. Rejected: chunked pagination with a cursor the client re-sends — it works, but it moves the memory problem onto every caller.' },
  { id: 'e092', session: 's37', role: 'tool', text: 'Tool: Edit\nInput: {"file_path":"src/api/export.ts"}\nOutput: replaced string building with a Readable piped through csvTransform' },
  { id: 'e093', session: 's37', role: 'tool', text: 'Tool: Bash\nInput: {"command":"npm run bench -- --endpoint export --rows 2000000"}\nOutput: peak RSS 92MB (was 1.4GB); throughput 38MB/s' },

  // ── s38: a dependency upgrade that changed behaviour ────────────────
  { id: 'e094', session: 's38', role: 'user', text: 'after the driver upgrade some timestamps come back as strings' },
  { id: 'e095', session: 's38', role: 'tool', text: 'Tool: Bash\nInput: {"command":"git log --oneline -3 -- package-lock.json"}\nOutput: 4a1c9de chore: bump better-sqlite3 to 12.11.1' },
  { id: 'e096', session: 's38', role: 'assistant', text: 'The new driver stopped coercing INTEGER columns holding epoch millis into Date, so anything relying on that now sees a number.' },
  { id: 'e097', session: 's38', role: 'note', text: 'Decision: stop relying on driver coercion entirely; read raw and convert at the boundary in fromRow(). Why: a dependency that silently changes the type of your data is a dependency you should not be trusting for typing at all.' },
  { id: 'e098', session: 's38', role: 'tool', text: 'Tool: Edit\nInput: {"file_path":"src/storage/fromRow.ts"}\nOutput: explicit epochToDate() at every timestamp column' },

  // ── s39: deleting a customer’s data ─────────────────────────────────
  { id: 'e099', session: 's39', role: 'user', text: 'we have a deletion request and I want to be sure it actually removes everything' },
  { id: 'e100', session: 's39', role: 'tool', text: 'Tool: Bash\nInput: {"command":"grep -rn tenant_id src/storage/*.ts | wc -l"}\nOutput: 14' },
  { id: 'e101', session: 's39', role: 'assistant', text: 'Fourteen tables carry tenant_id, and the dead-letter table and the archive bucket both hold copies that no cascade would reach.' },
  { id: 'e102', session: 's39', role: 'note', text: 'Decision: one purgeTenant() routine that enumerates every store from a single registry, including the archive bucket, and fails loudly on an unregistered table. Rejected: cascading foreign keys — they cover the relational tables and silently miss object storage.' },
  { id: 'e103', session: 's39', role: 'tool', text: 'Tool: Write\nInput: {"file_path":"src/storage/purgeTenant.ts"}\nOutput: created purgeTenant with a STORE_REGISTRY and a completeness assertion' },
  { id: 'e104', session: 's39', role: 'tool', text: 'Tool: Bash\nInput: {"command":"npm run test -- purgeTenant"}\nOutput: 11 passing; test fails deliberately when a new table is added without registering it' },

  // ── more distractors: shared vocabulary, unrelated substance ────────
  { id: 'd070', session: 's40', role: 'user', text: 'the staging bucket is filling up with old exports' },
  { id: 'd071', session: 's40', role: 'tool', text: 'Tool: Bash\nInput: {"command":"orchard exports prune --older-than 30d --dry-run"}\nOutput: would delete 1,204 exports totalling 88GB' },
  { id: 'd072', session: 's40', role: 'note', text: 'Exports older than 30 days are pruned nightly in staging, never in production.' },
  { id: 'd073', session: 's41', role: 'user', text: 'add a request id to every log line' },
  { id: 'd074', session: 's41', role: 'tool', text: 'Tool: Edit\nInput: {"file_path":"src/observability/logger.ts"}\nOutput: logger now reads requestId from AsyncLocalStorage' },
  { id: 'd075', session: 's41', role: 'assistant', text: 'Every log line inside a request now carries the same request id without threading it through call signatures.' },
  { id: 'd076', session: 's42', role: 'user', text: 'the openapi spec is out of date' },
  { id: 'd077', session: 's42', role: 'tool', text: 'Tool: Bash\nInput: {"command":"npm run openapi:generate"}\nOutput: wrote openapi.yaml; 3 endpoints added, 1 removed' },
  { id: 'd078', session: 's42', role: 'note', text: 'The spec is generated from the route table, so it cannot drift from the handlers by hand.' },
  { id: 'd079', session: 's43', role: 'user', text: 'can we run the workers on spot instances' },
  { id: 'd080', session: 's43', role: 'assistant', text: 'Workers are already idempotent per object, so a spot eviction costs at most one retry.' },
  { id: 'd081', session: 's43', role: 'note', text: 'Rejected: spot for the API tier. A two-minute eviction notice is not enough to drain long-lived streaming responses.' },
  { id: 'd082', session: 's44', role: 'user', text: 'the integration test suite needs a real database' },
  { id: 'd083', session: 's44', role: 'tool', text: 'Tool: Edit\nInput: {"file_path":"tests/helpers/tempDb.ts"}\nOutput: added seedFixtures() so integration tests share one schema build' },
  { id: 'd084', session: 's44', role: 'tool', text: 'Tool: Bash\nInput: {"command":"npm run test -- integration"}\nOutput: 64 passing in 38s' },
  { id: 'd085', session: 's45', role: 'user', text: 'why are we still on node 20 in ci' },
  { id: 'd086', session: 's45', role: 'tool', text: 'Tool: Edit\nInput: {"file_path":".github/workflows/ci.yml"}\nOutput: matrix now covers node 20, 22 and 24' },
  { id: 'd087', session: 's45', role: 'assistant', text: 'CI covers three Node versions; 20 stays because it is the declared floor.' },
  { id: 'd088', session: 's46', role: 'user', text: 'the metrics endpoint should not be public' },
  { id: 'd089', session: 's46', role: 'tool', text: 'Tool: Edit\nInput: {"file_path":"src/api/middleware/withContext.ts"}\nOutput: /metrics moved behind an allowlisted internal CIDR' },
  { id: 'd090', session: 's46', role: 'note', text: 'Health stays public, metrics does not: one is a liveness signal, the other is operational detail.' },
  { id: 'd091', session: 's47', role: 'user', text: 'batch size for the webhook sender should be tunable' },
  { id: 'd092', session: 's47', role: 'tool', text: 'Tool: Edit\nInput: {"file_path":"src/webhooks/sender.ts"}\nOutput: batch size reads ORCHARD_WEBHOOK_BATCH, default 50' },
  { id: 'd093', session: 's48', role: 'user', text: 'document the region column' },
  { id: 'd094', session: 's48', role: 'tool', text: 'Tool: Edit\nInput: {"file_path":"docs/schema.md"}\nOutput: documented events.region and its index' },
  { id: 'd095', session: 's48', role: 'assistant', text: 'Schema doc now covers the region column and the composite index that serves it.' },
]


/**
 * 120 judgments. The count is deliberate: at n=36 every comparison landed
 * at 2.2-2.8 SE — directionally clear, statistically under-powered — and
 * the binding constraint was the number of queries, not the effect size.
 *
 * Weighting is toward `paraphrase` and `recall` because that is where the
 * signal lives and where the slices were thinnest. The lexical kinds keep
 * enough queries to detect a regression if a change ever poisons them,
 * which is the risk a dense arm would introduce.
 */
export const QUERIES: FixtureQuery[] = [
  // ── identifier (20) ────────────────────────────────────────────────
  { id: 'q001', kind: 'identifier', query: 'drainQueue BackpressureError', gold: ['e004', 'e005'] },
  { id: 'q002', kind: 'identifier', query: 'MetricsRegistry samples retainer', gold: ['e032', 'e033', 'e034'] },
  { id: 'q003', kind: 'identifier', query: 'withContext middleware caller', gold: ['e037', 'e038'] },
  { id: 'q004', kind: 'identifier', query: 'listDeadLetters recordFailure', gold: ['e023'] },
  { id: 'q005', kind: 'identifier', query: 'idx_events_region_ts', gold: ['e059'] },
  { id: 'q006', kind: 'identifier', query: 'busy_timeout journal_mode WAL', gold: ['e011', 'e012'] },
  { id: 'q007', kind: 'identifier', query: 'TokenBucket refill capacity', gold: ['e065'] },
  { id: 'q008', kind: 'identifier', query: 'checkPeerExpiry certWatch', gold: ['e071'] },
  { id: 'q009', kind: 'identifier', query: 'loadConfig zod schema boot', gold: ['e076'] },
  { id: 'q010', kind: 'identifier', query: 'validateBatch accepted rejected', gold: ['e081'] },
  { id: 'q011', kind: 'identifier', query: 'purgeTenant STORE_REGISTRY', gold: ['e103'] },
  { id: 'q012', kind: 'identifier', query: 'epochToDate fromRow', gold: ['e098'] },
  { id: 'q013', kind: 'identifier', query: 'csvTransform Readable export', gold: ['e092'] },
  { id: 'q014', kind: 'identifier', query: 'SinkCapacity probe', gold: ['e005'] },
  { id: 'q015', kind: 'identifier', query: 'UnauthenticatedError guard', gold: ['e017'] },
  { id: 'q016', kind: 'identifier', query: 'mkdtempSync temp database path', gold: ['e029'] },
  { id: 'q017', kind: 'identifier', query: 'RECONNECT_DELAY_MS exponential backoff', gold: ['e045'] },
  { id: 'q018', kind: 'identifier', query: 'ORCHARD_FEED_TIMEOUT_MS handshake', gold: ['d032'] },
  { id: 'q019', kind: 'identifier', query: 'AsyncLocalStorage requestId logger', gold: ['d074'] },
  { id: 'q020', kind: 'identifier', query: 'seedFixtures integration schema', gold: ['d083'] },

  // ── path (18) ──────────────────────────────────────────────────────
  { id: 'q021', kind: 'path', query: 'src/ingest/queue.ts', gold: ['e002', 'e005'] },
  { id: 'q022', kind: 'path', query: 'src/observability/MetricsRegistry.ts', gold: ['e035', 'd030'] },
  { id: 'q023', kind: 'path', query: 'tests/helpers/tempDb.ts', gold: ['e029', 'd083'] },
  { id: 'q024', kind: 'path', query: 'src/upload/deadLetter.ts', gold: ['e023'] },
  { id: 'q025', kind: 'path', query: 'src/ingest/feedClient.ts', gold: ['e045', 'd032'] },
  { id: 'q026', kind: 'path', query: 'src/api/middleware/rateLimit.ts', gold: ['e062', 'e065'] },
  { id: 'q027', kind: 'path', query: 'src/config/load.ts', gold: ['e073', 'e076'] },
  { id: 'q028', kind: 'path', query: 'src/ingest/batchWriter.ts', gold: ['e079', 'e081'] },
  { id: 'q029', kind: 'path', query: 'src/storage/purgeTenant.ts', gold: ['e103'] },
  { id: 'q030', kind: 'path', query: 'src/api/export.ts', gold: ['e089', 'e092'] },
  { id: 'q031', kind: 'path', query: 'src/storage/openDatabase.ts', gold: ['e012'] },
  { id: 'q032', kind: 'path', query: 'src/api/handlers.ts', gold: ['e017', 'd045'] },
  { id: 'q033', kind: 'path', query: 'src/observability/certWatch.ts', gold: ['e071'] },
  { id: 'q034', kind: 'path', query: 'src/storage/fromRow.ts', gold: ['e098'] },
  { id: 'q035', kind: 'path', query: 'src/cli/parseArgs.ts', gold: ['e052', 'e054'] },
  { id: 'q036', kind: 'path', query: 'src/webhooks/sender.ts', gold: ['d017', 'd092'] },
  { id: 'q037', kind: 'path', query: 'src/api/middleware/withContext.ts', gold: ['e037', 'd089'] },
  { id: 'q038', kind: 'path', query: 'src/upload/retry.ts', gold: ['e020'] },

  // ── error (18) ─────────────────────────────────────────────────────
  { id: 'q039', kind: 'error', query: 'TS2345 RequestContext undefined', gold: ['e015', 'e016'] },
  { id: 'q040', kind: 'error', query: 'SQLITE_BUSY database is locked', gold: ['e009', 'e010'] },
  { id: 'q041', kind: 'error', query: 'ECONNRESET upstream feed', gold: ['e042', 'e043'] },
  { id: 'q042', kind: 'error', query: 'table applied_migrations already exists', gold: ['e026'] },
  { id: 'q043', kind: 'error', query: 'Object.groupBy is not a function', gold: ['d049', 'd050'] },
  { id: 'q044', kind: 'error', query: 'certificate has expired verify error num=10', gold: ['e068'] },
  { id: 'q045', kind: 'error', query: 'unknown key ORCHARD_REGON exit 78', gold: ['e077'] },
  { id: 'q046', kind: 'error', query: 'connection refused healthcheck 3 consecutive failures', gold: ['d061'] },
  { id: 'q047', kind: 'error', query: 'bucket returns 403 permanent failure', gold: ['e019', 'e021'] },
  { id: 'q048', kind: 'error', query: 'System time slow of NTP time', gold: ['e084'] },
  { id: 'q049', kind: 'error', query: 'queue.test.ts expects the old fixed-batch signature', gold: ['e006'] },
  { id: 'q050', kind: 'error', query: 'health endpoint now requires a token and should not', gold: ['e039'] },
  { id: 'q051', kind: 'error', query: 'SCAN events explain query plan', gold: ['e057'] },
  { id: 'q052', kind: 'error', query: 'orchard_queue_depth 0 gauge', gold: ['d028', 'd029'] },
  { id: 'q053', kind: 'error', query: 'timestamps come back as strings after driver upgrade', gold: ['e094', 'e096'] },
  { id: 'q054', kind: 'error', query: 'p95 890ms p99 2.1s search endpoint', gold: ['e056'] },
  { id: 'q055', kind: 'error', query: 'peak RSS 1.4GB export', gold: ['e093'] },
  { id: 'q056', kind: 'error', query: '612MB top retainer heap profile', gold: ['e032', 'e033'] },

  // ── command (16) ───────────────────────────────────────────────────
  { id: 'q057', kind: 'command', query: 'npm run soak --writers 8', gold: ['e013'] },
  { id: 'q058', kind: 'command', query: 'node --heap-prof dist/worker.js', gold: ['e032'] },
  { id: 'q059', kind: 'command', query: 'npm run backfill --table events --batch', gold: ['e050'] },
  { id: 'q060', kind: 'command', query: 'EXPLAIN QUERY PLAN events region', gold: ['e057'] },
  { id: 'q061', kind: 'command', query: 'npm run migrate --name add_dead_letter', gold: ['e024'] },
  { id: 'q062', kind: 'command', query: 'openssl s_client -connect hooks.partner.example', gold: ['e068'] },
  { id: 'q063', kind: 'command', query: 'npm run loadtest --rps 4000 --tenant noisy', gold: ['e066'] },
  { id: 'q064', kind: 'command', query: 'chronyc tracking', gold: ['e084'] },
  { id: 'q065', kind: 'command', query: 'npm run migrate --name add_events_seq', gold: ['e087'] },
  { id: 'q066', kind: 'command', query: 'npm run bench --endpoint export --rows 2000000', gold: ['e093'] },
  { id: 'q067', kind: 'command', query: 'git log --oneline package-lock.json', gold: ['e095'] },
  { id: 'q068', kind: 'command', query: 'npm run test -- migrations --repeat 40', gold: ['e026'] },
  { id: 'q069', kind: 'command', query: 'docker inspect State.Health', gold: ['d061'] },
  { id: 'q070', kind: 'command', query: 'orchard exports prune --older-than 30d', gold: ['d071'] },
  { id: 'q071', kind: 'command', query: 'orchard secrets rotate --env staging', gold: ['d042'] },
  { id: 'q072', kind: 'command', query: 'npm run openapi:generate', gold: ['d077'] },

  // ── paraphrase (30) — substance remembered, vocabulary not ─────────
  { id: 'q073', kind: 'paraphrase', query: 'why did we stop trying forever when a file will not upload', gold: ['e022'] },
  { id: 'q074', kind: 'paraphrase', query: 'what did we decide about two writers fighting over one file', gold: ['e011'] },
  { id: 'q075', kind: 'paraphrase', query: 'the fix for tests that only break when run at the same moment', gold: ['e028'] },
  { id: 'q076', kind: 'paraphrase', query: 'how we avoided locking a huge table while changing its shape', gold: ['e048'] },
  { id: 'q077', kind: 'paraphrase', query: 'why the server should refuse to start instead of failing quietly', gold: ['d056'] },
  { id: 'q078', kind: 'paraphrase', query: 'reason we kept our own argument parsing instead of a library', gold: ['e053'] },
  { id: 'q079', kind: 'paraphrase', query: 'what stopped the pipeline losing data silently for nine minutes', gold: ['e044'] },
  { id: 'q080', kind: 'paraphrase', query: 'why memory kept growing and never came back', gold: ['e034'] },
  { id: 'q081', kind: 'paraphrase', query: 'decision about page numbers shifting while someone scrolls', gold: ['d047'] },
  { id: 'q082', kind: 'paraphrase', query: 'why we did not use the smaller base image', gold: ['d012'] },
  { id: 'q083', kind: 'paraphrase', query: 'how one greedy customer stopped crowding out the others', gold: ['e064'] },
  { id: 'q084', kind: 'paraphrase', query: 'we refused to turn off a security check even for an hour', gold: ['e070'] },
  { id: 'q085', kind: 'paraphrase', query: 'making a bad setting fail immediately rather than on first use', gold: ['e075'] },
  { id: 'q086', kind: 'paraphrase', query: 'keeping the good records when a few in the group are broken', gold: ['e080'] },
  { id: 'q087', kind: 'paraphrase', query: 'machines disagreeing about what time it is broke the ordering', gold: ['e086'] },
  { id: 'q088', kind: 'paraphrase', query: 'sending results as they are produced instead of building them all first', gold: ['e091'] },
  { id: 'q089', kind: 'paraphrase', query: 'we stopped letting a library decide what type our data is', gold: ['e097'] },
  { id: 'q090', kind: 'paraphrase', query: 'making sure a customer erasure really reaches every copy', gold: ['e102'] },
  { id: 'q091', kind: 'paraphrase', query: 'why a queue that stalls visibly beats one that quietly runs out of memory', gold: ['e004'] },
  { id: 'q092', kind: 'paraphrase', query: 'the reason we did not simply widen a parameter to make the compiler quiet', gold: ['e018'] },
  { id: 'q093', kind: 'paraphrase', query: 'why one long pause is an outage and two short ones are not', gold: ['e048'] },
  { id: 'q094', kind: 'paraphrase', query: 'keeping a slow query from taking a machine out of rotation', gold: ['d008'] },
  { id: 'q095', kind: 'paraphrase', query: 'why every dangerous command gets a rehearsal before it gets a confirmation', gold: ['d066'] },
  { id: 'q096', kind: 'paraphrase', query: 'we made time injectable so the suite stops actually waiting', gold: ['d040'] },
  { id: 'q097', kind: 'paraphrase', query: 'two kinds of retrying kept separate because they fail differently', gold: ['d019'] },
  { id: 'q098', kind: 'paraphrase', query: 'a liveness signal can be public but operational detail should not be', gold: ['d090'] },
  { id: 'q099', kind: 'paraphrase', query: 'cheap machines are fine for background work but not for long lived connections', gold: ['d081'] },
  { id: 'q100', kind: 'paraphrase', query: 'one lookup that changes rarely can be held briefly without much risk', gold: ['d053'] },
  { id: 'q101', kind: 'paraphrase', query: 'the counter reset trick let someone use double their allowance', gold: ['e063'] },
  { id: 'q102', kind: 'paraphrase', query: 'we chose not to store one entry per request because of what that cost us before', gold: ['e064'] },

  // ── recall (18) — the cold-start question ─────────────────────────
  { id: 'q103', kind: 'recall', query: 'what was I working on with the flaky migration test', gold: ['e026', 'e027', 'e028'] },
  { id: 'q104', kind: 'recall', query: 'what was the outcome of the search endpoint slowdown', gold: ['e058', 'e059', 'e060'] },
  { id: 'q105', kind: 'recall', query: 'where did we get to on ingest queue backpressure', gold: ['e003', 'e004'] },
  { id: 'q106', kind: 'recall', query: 'what happened with the dropped events overnight', gold: ['e043', 'e044'] },
  { id: 'q107', kind: 'recall', query: 'status of the auth refactor and what broke', gold: ['e039', 'e040'] },
  { id: 'q108', kind: 'recall', query: 'what did we conclude about the noisy tenant', gold: ['e063', 'e064'] },
  { id: 'q109', kind: 'recall', query: 'where did the webhook outage investigation end up', gold: ['e069', 'e070'] },
  { id: 'q110', kind: 'recall', query: 'what was the config validation work', gold: ['e074', 'e075'] },
  { id: 'q111', kind: 'recall', query: 'how did the batch partial failure thread finish', gold: ['e080', 'e081'] },
  { id: 'q112', kind: 'recall', query: 'what was I doing about events appearing out of order', gold: ['e085', 'e086'] },
  { id: 'q113', kind: 'recall', query: 'the export memory work and where it landed', gold: ['e090', 'e091'] },
  { id: 'q114', kind: 'recall', query: 'what came of the driver upgrade problem', gold: ['e096', 'e097'] },
  { id: 'q115', kind: 'recall', query: 'the tenant deletion request and what we built for it', gold: ['e101', 'e102'] },
  { id: 'q116', kind: 'recall', query: 'what happened with the memory leak on the ingest box', gold: ['e033', 'e034'] },
  { id: 'q117', kind: 'recall', query: 'the cli flag inconsistency thread', gold: ['e052', 'e053'] },
  { id: 'q118', kind: 'recall', query: 'what did we do about the unreadable build error', gold: ['e016', 'e017'] },
  { id: 'q119', kind: 'recall', query: 'where did the big table migration end up', gold: ['e047', 'e048'] },
  { id: 'q120', kind: 'recall', query: 'what was the state of the retry bounding work', gold: ['e021', 'e022'] },
]
