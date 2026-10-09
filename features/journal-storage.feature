Feature: Journal storage — the store is durable, bounded, and honest about loss

  The storage layer's promise is simple to state and easy to silently
  break: what the journal says it holds, it actually holds; what it had
  to discard, it says so; and it never grows without bound or falls over
  from a crash. History says "easy to silently break" is not hypothetical —
  for most of this project's life the "full journal" was a myth (only
  previews were stored) and nobody could tell, because the store looked
  full from the outside. Every scenario here is verified by opening the
  SQLite file and looking, never by trusting a status message alone.

  Charter detail (b): sqlite3 + BM25 + zstd compression of the full
  journal + a bounded index view for fast search (which may reach past
  the display preview — the two boundaries split at the index-cap
  expansion, and each row records its own).

  Retention policy, stated plainly (2026-07-29): the searchable store is
  bounded by RECENCY — a session cap, oldest whole sessions archived
  first. The byte budget does not drive eviction; it is a demotion
  backstop for outlier sessions and the over-budget signal. And the
  bound covers the searchable store alone: archive files accumulate
  indefinitely, uncompressed, by design — disk is cheap, the record is
  priceless. Total disk grows; only the .db is bounded.

  @D4
  Scenario: what goes in comes back out, byte for byte
    Given a full-fidelity event captured and ingested
    When its node is exported
    Then the content matches what the hook staged, byte for byte
    And the stored blob is zstd-compressed at rest

  @D4
  Scenario: the search index is a bounded view, the journal is the record
    Given an oversized full-fidelity event staged by the hook
    When it is ingested into the journal
    Then the FTS index holds only the recorded bounded view
    And ranking is computed from that view alone
    And the recorded boundary says exactly where the indexed view ends

  @D48
  Scenario: the store does not grow without bound
    Given a store pushed past its retention caps by continued capture
    When the valve runs
    Then the store returns under its caps
    And eviction removes oldest whole sessions, never fragments of one
    And the newest session is never evicted
    # "Caps" is deliberate: session-count retention is what bounds the
    # store in practice. The byte budget only backstops demotion.

  @D48
  Scenario: eviction demotes to cold archive, it never destroys
    Given a session about to be evicted by session-count retention
    When the valve runs
    Then the whole session is written to an archive file in export format first
    And importing that archive into a store restores the session verbatim
    # Retention bounds the SEARCHABLE store, not the historical record.
    # Disk is cheap; the record is priceless — the interaction that
    # mattered most may be an auto-captured one nobody curated, so whole
    # sessions archive, bulk and all.

  @D55
  Scenario: evicted content leaves a tombstone pointing at its archive
    Given an old session and a newer one under a session cap of one
    When the valve runs
    Then a tombstone records that the session existed and where its archive lives
    And the ordering is archive written, then tombstone, then deletion
    # A crash between any two steps must leave an over-honest store
    # (archive and tombstone with surviving content), never an
    # under-honest one.

  @D48
  Scenario: only an explicit command destroys content
    Given a store wired for months of capture under tight caps
    When valves, vacuums, and migrations run again and again over the months
    Then every entry ever captured is either live, or archived with a tombstone
    But an explicit clear or delete command removes content with no archive
    # Automatic machinery demotes; only the human deletes.

  @D55
  Scenario: demotion archives before it shrinks
    Given a store over its byte budget holding demotable full-view prose
    When the valve runs
    Then the shrunk row records its loss and the full text is in a demotion archive
    # Ruled 2026-07-31: the demotion half of "only an explicit command
    # destroys content". A shrink is always on the record — the row keeps
    # its pre-demotion length and archive path, hits carry a marker, and
    # the full text stays recoverable from the archive. Without an archive
    # destination demotion refuses outright, exactly like eviction.

  @D22
  Scenario: curated synthesis outlives auto-captured bulk
    Given a store under budget pressure holding curated notes and auto-captured events
    When the valve evicts
    Then auto-captured bulk is demoted to archive before curated notes and active plans

  @D22
  Scenario: frequently relied-on history evicts last
    Given two old sessions of equal size, one whose entries have been exported by later sessions and one never touched
    When the valve evicts
    Then the untouched session is archived first
    # Ruled 2026-07-23, option (c): reliance is measured by EXPORTS — the
    # agent fetched the full entry — not query hits, which an agent may
    # ignore (and which ranking must never feed: see the reproduction
    # clause in journal-search-modes). Frequency only reorders session
    # eviction — a session scores by its most-relied-on entry — it never
    # protects fragments: eviction stays whole-session, and the newest
    # session stays absolutely protected. If reordering proves too weak,
    # the post-MVP shape is copying hot entries forward before archiving.

  @D55
  Scenario: eviction refuses when it cannot archive
    Given a store past its session cap with no archive destination available
    When the valve runs
    Then no session is deleted
    # The store never destroys what it cannot archive: both halves of the
    # valve obey it — whole-session eviction halts, and (ruled 2026-07-31)
    # demotion refuses to shrink rather than trade the record for the
    # bound. (Bound 2026-07-29 via an archiveless in-memory store; the
    # unwritable-directory variant is pinned by the ordering scenario's
    # fault injection.)

  @D49
  Scenario: a store that cannot get under budget says so
    Given a store over budget where everything remaining is protected
    When the valve runs and fails to reclaim
    Then status reports the condition instead of staying silent
    # Open item 5 from the 2026-07-15 repair, closed 2026-07-29: status()
    # carries a retention gauge (store bytes vs budget, over_budget flag)
    # and the MCP status panel surfaces it with a storage_warning. The
    # store never destroys protected rows to meet the budget — it reports.

  @D141
  Scenario: the byte budget defaults to a size a sprint of subagents can fill
    Given a store opened with no budget configured
    When status is read
    Then the byte budget it reports is 128 MiB
    And the session cap it reports is 100
    # Ruled 2026-09-28 (D141), built 2026-10-08 at the owner's word (the
    # words are in D255's comment): subagents multiply a session's content
    # without multiplying the session count, which the old 64 MiB sizing
    # (about eight times a hundred single-agent sessions, compressed)
    # never anticipated. The cap itself did not move. The budget is a
    # demotion backstop, never an evictor (D140), and demotion narrows a
    # row's findable text to its index floor — so a larger budget demotes
    # later and can only widen what stays findable; its price is disk
    # under the .db, not recall. Row count stays bounded by the session
    # and entry caps, not by bytes, which is why D108's envelope, measured
    # by rows, is unmoved. Bound through the real door: a store opened
    # with no config file in reach, status read as the operator reads it,
    # never by reading the constant.

  @D141
  Scenario: the byte budget and the session cap are the operator's to set, per project
    Given a project whose config file sets the byte budget to 256 MiB and the session cap to 12
    When the server is started from that project and opens its store
    Then status over that server reports a budget of 256 MiB and a session cap of 12
    # D141 says "per store, through a key in the config file". The file a
    # server reads is the project's (./treecontext.toml), then the
    # installation's (~/.treecontext/config.toml), in the precedence the
    # config-file feature pins, so a store is sized by the project that
    # serves it, and every handle that server opens, drain-side included,
    # sweeps by the same figures. A value in the file is a configuration,
    # never a code constant; the defaults apply only where the file is
    # silent. The figures take effect at the next sweep. That the valve
    # evicts and demotes by whatever figures its store was opened with is
    # pinned by the D48 and D55 scenarios above; this scenario pins that
    # the file's figures are the ones it is opened with, through a real
    # serve from the project directory, never an in-process shortcut.

  @D141
  Scenario: a budget the file cannot mean leaves the default in force
    Given a project whose config file sets the byte budget to zero
    When the server is started from that project and opens its store
    Then status over that server reports the default budget
    And a store well under that budget loses nothing when the valve runs
    # A zero or negative budget obeyed would strip every demotable row on
    # the next sweep. A key that names no budget is dropped like a
    # mistyped one (config-file feature), and the default stands.

  @D141
  Scenario: an over-budget store names the knob that raises its budget
    Given a store over budget where everything remaining is protected
    When the valve runs and fails to reclaim
    Then the storage warning names the config key that raises the budget and the file it lives in
    And a config file that sets that key, spelled as the warning spells it, is read as the budget
    # The warning once said "raise maxStoreBytes", a constant no operator
    # could turn. It now sends the operator to the file and the key in the
    # words the file uses; the second clause is what keeps the warning's
    # spelling and the loader's spelling one and the same. The warning is
    # a next-sprint instruction, not a same-day chore (D178): the valve
    # never stops on it.

  @D141
  Scenario: the session cap the operator sets is the cap that bites
    Given a project whose config file sets the session cap to 150
    And a sprint of 150 sessions each carrying 150 entries, 22 500 in all
    When the valve runs after the 150th session
    Then no session is evicted until the 151st begins
    And the 151st session's arrival evicts exactly the oldest, archived and tombstoned
    # The entry-count safety net was fixed at 20 000 auto-captured entries,
    # sized to a single agent's two hundred a session across a hundred
    # sessions. Under subagents it evicted whole sessions before the
    # operator's cap was reached, so raising the cap bought nothing: the
    # 22 500 entries here would have cost seventeen sessions under the
    # old net, the oldest going until 20 000 or fewer remained. Ruled 2026-10-08 (the owner's words are in D255's comment):
    # the net scales with the cap, two hundred entries per configured
    # session, so a cap of 150 carries 30 000 and the sprint fits; the
    # hundred-session default keeps its 20 000. Eviction stays
    # whole-session and the newest is never taken.

  @D59
  Scenario: an additive migration also runs behind a backup
    Given a store one additive migration behind the current schema
    When the store is opened and migrated
    Then a backup of the store as it was lies beside it, taken before the change, with a success verdict
    And a writer active during the migration costs no row and makes no verdict fail
    # Ruled 2026-07-29 (D59): every migration runs behind a backup. The
    # runner backed up destructive steps only, so three additive steps
    # ran bare on 2026-10-08; the owner's word that day (D256's comment):
    # "always have a backup before any migration or schema update". The
    # verdict judges by containment, every row the backup holds present
    # in the migrated store and none fewer, so a session writing through
    # the window is never read as a loss.

  @D36
  Scenario: a full disk fails loudly and corrupts nothing
    Given a store on a volume with no room left to grow
    When a capture attempts to write
    Then the write fails with an explicit error
    And every previously committed entry remains intact and queryable
    # Ruled 2026-07-24 (critic pass 1 finding): the failure actor the
    # suite lacked. Bound via SQLite's own page ceiling — the same
    # SQLITE_FULL surface a full volume produces.

  @D25
  Scenario: a crash mid-write never corrupts the store
    Given a process killed during capture, ingestion, or eviction
    When the next session opens the store
    Then the database opens clean under WAL recovery
    And every event is either fully present or fully absent, never half-written
    # Power loss (ruled 2026-07-23): same consistency promise — the store
    # opens clean — but the last committed moments may be honestly lost
    # (WAL with synchronous=NORMAL). Accepted, not promised away: the
    # store never claims durability it does not have, and never trades
    # write latency for a durability level the charter does not need.

  @D80
  Scenario: concurrent sessions do not corrupt each other
    Given two live sessions pointed at the same store
    When both capture and ingest at once
    Then claims and constraints make the concurrent writers safe: every capture lands exactly once
    And the drain lease keeps draining efficient — one drain owner per store at a time
    And a second server on the same namespace serves too — the store's constraints, not a lease, are what keep writers safe
    And the other's captures are staged, not lost, and drain when the drain owner runs
    # Reworded a second time under the sanctioned-change protocol
    # (store-as-arbiter design note §6, 2026-08-13): correctness moved
    # INTO the database — curated dedup is a unique constraint, captured
    # double-fires an anchored window (a constraint cannot express a
    # window), and the drain claims its batches atomically — so
    # concurrent writers are safe by
    # construction, and the roles that remain (drain, tool-writer) are
    # heartbeat leases: the drain lease is efficiency, the namespace
    # lease is the product's second-server refusal. The cross-process
    # second-session world and the lossless staging letterbox are
    # unchanged from the first wording.
    #
    # Reworded a THIRD time (store-as-arbiter design note §8,
    # 2026-08-20): the same-namespace second-server refusal retires. It
    # protected the pre-G world of in-process dedup maps; once the two
    # clauses above became true it gated nothing correctness needed, so
    # the owner's ruling admits concurrent same-namespace servers —
    # conditional on attribution, which journal-namespaces pins. The
    # namespace lease survives as the PRIMARY CLAIM: one holder, named
    # by doctor, corroborating the hook ladder's pid rung, taken over
    # when its heartbeats stop.

  @D3
  Scenario: a poison event cannot wedge ingestion
    Given a staged event that fails ingestion repeatedly
    When the ingestion loop works the backlog
    Then it is retired to a dead-letter record after bounded attempts
    And retirement happens only after the dead-letter record exists
    And the rest of the backlog continues to drain past it

  @D59
  Scenario: schema changes never eat a store
    Given a database created by an older binary
    When a newer binary opens it
    Then the legacy store is copied aside before anything destructive runs
    And every pending migration applies, additive and destructive alike
    And the space the dropped tables held is returned to the filesystem
    And a store that cannot be written refuses rather than half-migrating
    And an older hook binary against a newer schema stages events without loss
    # Ruled 2026-08-05, replacing "additive run automatically / but
    # destructive require explicit opt-in". That split could not be
    # honoured: the runner gates the pending set as a unit, and once #19
    # (destructive) entered the ladder no store below current had
    # an additive-only pending set — so the opt-in was not a choice any
    # real store could avoid, merely one the library API never advertised.
    # The owner's ruling is that a backup makes the whole ladder safe:
    # "going to fully compliant current version schema and vacuuming makes
    # sense - it's tidy, up to date, restores disk space, and you can
    # always go back to the backup." What still refuses is a store that
    # cannot be written at all.

  @D40
  Scenario: a store built by a deleted backend refuses loudly and loses nothing
    Given a store whose recorded mode names a backend this build no longer ships
    When this build tries to open it
    Then the open fails with a message naming the recovery options
    And every row and the mode record are untouched by the refusal
    # The tree era left 2026-07-25 (git tag pre-deletion-phase). Refusal is
    # the promise: never open a store blind, never migrate it silently.

  @D48
  Scenario: deleted space is actually reclaimed
    Given a store holding months of bulky sessions
    When retention evicts most of them
    Then the file on disk shrinks once free space crosses the vacuum threshold
    # Unbounded freelist growth is invisible loss of the budget promise:
    # the store reports small while the file stays huge.
