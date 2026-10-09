Feature: Project-store bindings preserve, never clobber

  bindings.json is machine-wide state: one file holding every project's
  store binding, rewritten whole by whichever process next resolves a
  missing binding — most often a capture hook, firing in the background.
  Before this contract an unreadable file was indistinguishable from an
  empty one, so a single corrupt byte cost every other project its
  binding on the next hook fire, and a symlinked path was silently
  replaced by a fresh file. The ruling (2026-08-15): preserve, never
  clobber. Damage is side-filed where a human can recover it, a symlink
  is refused in both directions while resolution continues unpersisted,
  and a stored value that fails the safe-name rule is dropped alone —
  every neighboring entry survives.

  The second contract this file binds is continuity (ruling 2026-08-16,
  design docs/project-identity.md). A project's binding key is derived
  from facts that change during its normal life — it gains a remote, it
  gains a repo root above the directory that bound first, its remote is
  respelled ssh for https, a session runs in a linked worktree. Every one
  of those used to mint a fresh, empty store and leave the real journal
  unaddressable, silently. So: a successor identity adopts a predecessor
  only when the predecessor names the SAME directory (a root-identical
  predecessor admits no hidden sibling; a subdirectory one always can),
  ambiguity derives fresh and says so, and nothing is ever adopted
  quietly.

  The third contract is concurrency (added 2026-08-24, design
  docs/project-identity.md §3.6). Bindings are written by whichever
  hook fires next, and hooks fire in parallel: every writer holds a
  bounded lock across a re-read of the file and writes only its own
  entries over what is on disk at that moment, so two projects minting
  their first bindings in the same instant both survive. The lock is
  never load-bearing — a writer that cannot get it skips the write and
  resolution continues unpersisted, exactly like the symlink and
  unreadable refusals, and a lock left by a dead writer is broken as
  stale rather than blocking every future persist.

  Scenario: a corrupt bindings file is side-filed, never overwritten
    Given a bindings file holding unparseable bytes
    When a project resolves its store name
    Then the original bytes survive in a corrupt side-file
    And the bindings file holds the fresh binding

  Scenario: an unrecognized bindings version is preserved the same way
    Given a bindings file marked with a future version and holding another project's binding
    When a project resolves its store name
    Then the original file survives in the corrupt side-file with the other binding intact
    # A version this build does not know is somebody else's data, not
    # garbage — an older build sharing the machine with a newer one must
    # not eat the newer file's bindings.

  Scenario: a symlinked bindings file is refused for reading and writing
    Given a bindings path that is a symlink to a foreign file
    When a project resolves its store name
    Then a safe store name is still derived
    And the symlink and its target are untouched
    # Same threat model as the repo sticky file (security S3): a link
    # planted at the bindings path must neither redirect resolution nor
    # be replaced by the resolver's atomic rename.

  Scenario: concurrent first resolutions all keep their bindings
    Given six unbound project directories
    When each resolves its store name in its own process at the same moment
    Then the bindings file holds all six bindings
    # The lost-update race (tracked since rc.2): the file is rewritten
    # whole, so whichever rename landed last used to erase every other
    # first binding minted during the interval. Six real processes, one
    # bindings file, a barrier so the overlap is real — the lock and the
    # under-lock delta merge are what this scenario exercises.

  Scenario: a held bindings lock defers the write, never the answer
    Given another writer holds the bindings lock
    When a project resolves its store name
    Then a safe store name is still derived
    And no binding is persisted while the lock is held
    And the resolution after the lock is released persists the binding

  Scenario: a lock left by a dead writer cannot block persistence
    Given a bindings lock file left behind by a writer that died
    When a project resolves its store name
    Then the bindings file holds the fresh binding
    And the stale lock file is gone

  Scenario: an unsafe stored value is dropped and re-derived while its neighbors survive
    Given a bindings file where this project's entry names an unsafe store beside a valid neighbor
    When the project resolves its store name
    Then the resolved name is a freshly derived safe name
    And the neighbor's binding survives the rewrite

  Scenario: lookup reports no binding rather than an unsafe value
    Given a bindings file where this project's entry names an unsafe store beside a valid neighbor
    When the binding is looked up read-only
    Then no store name is reported
    And the bindings file is unchanged

  Scenario: backup never mints a binding for an unbound directory
    Given a project directory with no binding
    When backup runs from that directory
    Then it refuses with guidance naming a store flag
    And no binding was created
    # backup describes and copies; it must not leave a write-through
    # side effect behind for every directory it was tried from.

  Scenario: a legacy sticky answers a read-only lookup
    Given a repository with a legacy sticky file and no binding
    When the binding is looked up read-only
    Then the sticky's store name is reported
    And no binding was created and the sticky survives
    # A project that has used treecontext for months HAS a store even if
    # the one-time migration has not fired yet; a read-only surface that
    # cannot see it misdiagnoses the project as new. Migration remains
    # the write-through path's job.

  Scenario: a project that gains a remote keeps its journal
    Given a repository with no remote, bound by path to its own store
    When a remote is added and the project resolves its store name again
    Then the resolved store is the one the path binding already named
    And the new binding records source "carried-forward"
    And the path binding still names that store, untouched
    And the succession was announced to the caller
    # The observed second-project case, and four other splits on this
    # machine: scope-then-init-then-build binds by path before any code
    # exists, and the build session that adds the remote used to land
    # somewhere else entirely.

  Scenario: git init above a bound subdirectory discloses, never adopts
    Given a subdirectory bound by path to its own store, with no repository above it
    When a repository is initialized above it and the store is resolved from the subdirectory
    Then a fresh store is derived
    And the predecessor journal at the subdirectory is disclosed with its store name
    And the subdirectory's binding is untouched

  Scenario: the ssh and https spellings of one remote share a store
    Given a repository bound under the https spelling of its remote
    When the remote is respelled in scp-style ssh form and the store is resolved
    Then the resolved store is the one the https spelling named
    And the new binding records source "carried-forward"
    # The probe emits RAW spellings, not canonical ones: a predecessor's
    # fingerprint hashes the URL string it was bound under.

  Scenario: a directory bound under another spelling of its own path keeps its journal
    Given a non-git project bound under a symlinked spelling of its path
    When the project resolves through that symlinked spelling
    Then the predecessor's store is adopted and recorded carried-forward
    And the adoption is announced
    # The two-spelling residual (tracked since rc.2): path identity is
    # canonicalized through a fallback ladder, and a binding minted
    # while the ladder was degraded — an 8.3 short-form cwd, a network
    # share where native realpath fails — lives under a spelling the
    # healthy ladder never reproduces. The probe walks the ladder's
    # other rungs; every rung names the same directory, so adoption is
    # root-identical by construction (design §3.5).

  Scenario: a monorepo sibling can never be handed the other sibling's journal
    Given two package subdirectories each bound by path to their own stores
    When a repository is initialized at their common root and the store is resolved from the first package
    Then a fresh store is derived
    And the predecessor journal at the first package is disclosed, naming neither the other package nor its store
    And neither package binding is modified
    # The hazard that rewrote the design: one probe per sibling, each
    # seeing exactly one predecessor, each adopting it "unanimously" —
    # whichever hook fired first would take the other's journal.

  Scenario: two raw URL forms bound to different stores fail closed
    Given one remote whose https and scp spellings name two different stores
    When the remote is respelled a third way and the store is resolved
    Then a fresh store is derived
    And the conflict is disclosed naming both predecessor stores

  Scenario: an already-bound project is never re-pointed by succession
    Given a repository bound by its remote URL beside a stale path binding naming another store
    When the store is resolved
    Then the resolved store is the one its own binding names
    And the stale path binding is untouched

  Scenario: a linked worktree resolves to the project it was cut from
    Given a repository with no remote, bound by path to its own store
    When a linked worktree of it is added and the store is resolved from inside the worktree
    Then the resolved store is the project's own
    And no second binding was written
    # Agent orchestration spawns subagents in worktrees as a matter of
    # course; a store per worktree would scatter one project's journal
    # across as many empty stores as it has checkouts.

  Scenario: symlinked working directories of different depth cannot collapse two projects
    Given two unrelated repositories each reached through a symlink of a different depth
    When each resolves its store name through its symlink
    Then each resolves to its own project's store, and the stores differ
    # Phase-1 review F1, reproduced before it was fixed: git prints
    # --git-common-dir relative to its PHYSICAL cwd, and resolving that
    # offset against the caller's LEXICAL symlink path of a different
    # depth landed in an arbitrary ancestor — two unrelated projects,
    # one byte-identical identity, one shared journal.

  Scenario: a hand-written .git file cannot steal a path-bound project's journal
    Given a project with a worktree, bound to its own store, and two unpacked directories whose .git files name it
    When each unpacked directory resolves its store name
    Then each derives a fresh store of its own
    And the project's binding is untouched
    # Phase-1 review F2 + Phase-2 review S1 (S3): one attacker-authored
    # line in a tarball. Two spellings, both closed — `gitdir:
    # /victim/.git` fails the worktrees/ signature, and `gitdir:
    # /victim/.git/worktrees/<name>` (chained to a REAL worktree) wears
    # the full signature but fails git's own back-pointer: the
    # registration file names the genuine worktree, not the impostor.
    # Path identity only: a victim WITH a remote is the §3.3 disclosed
    # residual (a hostile checkout could already copy the raw URL).

  Scenario: a repo-local core.worktree cannot point identity at another project
    Given a project bound to its own store and a repository whose config claims the project as its worktree
    When the claiming repository resolves its store name
    Then it derives a fresh store of its own
    And the project's binding is untouched
    # Phase-3 review S1, reproduced: `git config core.worktree <victim>`
    # makes rev-parse print the VICTIM as --show-toplevel — before any
    # worktree guard can fire. A toplevel that does not contain the
    # resolving cwd is a forgery or a misconfiguration; both are
    # distrusted entirely and identity falls back to the directory
    # itself.

  Scenario: injected git config cannot lend a project a remote it does not have
    Given a repository with no remote and a hostile remote URL injected through the environment
    When the repository resolves its store name
    Then its identity is still the path identity, not the injected remote
    # Phase-3 review S2: GIT_CONFIG_COUNT/KEY_n/VALUE_n inject config
    # pairs into every git invocation, and repo-controlled env blocks
    # are a real carrier. Identity reads scrub GIT_* wholesale and pin
    # their own config scope — identity derives from the repository
    # alone.

  # ── Detection (docs/project-identity.md §4) ────────────────────────
  #
  # Succession stops new splits; it cannot see the ones already on disk.
  # A split is invisible from inside either journal — each store is
  # complete and consistent about itself — so the only surface that can
  # report one is the machine-wide diagnosis surface. doctor reads the
  # bindings FILE and the stores directory, names candidates with both
  # node counts, and writes nothing: it once left a binding behind for
  # every directory it was run from, and the check that reports the
  # binding defect must not commit it.

  Scenario: doctor names a split without writing a binding
    Given a path binding to "proj-ab12cd" and a git binding to "proj", each holding a store
    When doctor runs from an unrelated directory
    Then the split is reported as a candidate naming both stores and both node counts
    And the fix line names the merge command with the path-bound store as its source
    And the report states that the list is not exhaustive
    And bindings.json is byte-identical afterwards
    And neither store gained a write-ahead sidecar
    # The observed shape on this machine, five times over: the path side
    # bound first and the git side is where the project ended up, so the
    # merge runs path → git. Byte-identical is the load-bearing clause —
    # the seeding writes the file directly and doctor may not so much as
    # re-order it.

  Scenario: a store merely named like a derived split is not reported
    Given a path binding to "my-app-abc123" with no git binding holding "my-app"
    And a path binding to "workbench-notes" beside a git binding to "workbench"
    When doctor runs from an unrelated directory
    Then no split candidate is reported
    And neither path-bound store is named in the report
    # One decoy per half of the rule. "my-app-abc123" wears the derived
    # shape and has no partner — the shape alone is not a split, and
    # projects are genuinely named that way (finding A6), which is why
    # the report says "candidate". "workbench-notes" has a partner and
    # does not wear the shape: "notes" is not six hex digits, and a
    # matcher loose enough to pair them would hand two unrelated
    # projects a merge command.

  Scenario: a pair whose git store never landed on disk is a dangling binding, not a split
    Given a path binding to "proj-ab12cd" holding a store and a git binding to "proj" holding none
    When doctor runs from an unrelated directory
    Then the pair is reported as a dangling binding naming "proj"
    And no merge command is advised
    # Finding B (2026-08-22): merge refuses when either side has no
    # store on disk, so advising it hands the operator a command that
    # cannot run. The discrimination is the filesystem fact — no
    # database file — never the "?" node count, which also covers
    # stores that are merely unreadable and can still hear merge's own
    # refusal messages.

  # ── Self-audit (docs/project-identity.md §11a) ─────────────────────
  #
  # The split above is one question about the bindings map. These are the
  # rest of the class the program is named for — work attributed to, or
  # merged into, the wrong place, silently. They live in this file rather
  # than in the install corpus because that is what they are about: a
  # dedup key that cannot tell two entries apart, a binding pointing at a
  # journal that was never written, a store quietly failing to drain.
  # Each is invisible from inside, each reports as absence, and absence in
  # a memory tool reads as "I never wrote that down" rather than as a
  # fault. Every one of them reads and none of them writes.

  Scenario: doctor counts the dedup keys that cover more than one content
    Given a bound store whose two entries collide under one dedup key
    And a second bound store holding one entry filed twice under one key
    When doctor runs from an unrelated directory
    Then the collision is reported as one group of two rows, naming only that store
    And the report says the rows are at risk only on import and merge, and names the migration that retires the class
    And bindings.json is byte-identical and neither store file changed
    # The healthy half is the load-bearing one. Two rows of identical
    # content under one key is what dedup LOOKS like when it is working —
    # outside its window, or across sessions — so a check that compared
    # fingerprints alone would report the feature as the defect, on every
    # store on the machine.

  Scenario: doctor names a bound store that has never held anything
    Given a binding written long ago to a store holding nothing
    And a second bound store holding entries
    When doctor runs from an unrelated directory
    Then the empty store is reported with the age of its binding
    And the store holding entries is not named
    And the report states that emptiness alone proves nothing
    # The orphaned-successor shape the name heuristic cannot pair: the
    # journal is somewhere else under a name nothing relates to this one.
    # It is the AGE that carries the argument — a project bound this
    # morning and still empty is just a project nobody has captured yet.

  Scenario: doctor reports the capture debt of the store this directory is bound to
    Given a project whose store holds capture gaps of every kind and an undrained backlog
    And a second project whose store is draining cleanly
    When doctor runs from each project directory
    Then the indebted store is reported as a warning counting all its capture gaps and its oldest undrained event
    And the fix line names where those events are recorded
    And the clean project's report carries no capture-debt warning
    And neither store file changed
    # Current store, not machine-wide: this is about the drain running
    # HERE, and the sidecar pane that already computes it is opt-in wiring
    # in another program's config — so on every machine that never wired
    # it, a store that stopped draining says nothing at all.
    # ALL THREE gap kinds count — dead letters, malformed snapshots,
    # valve drops (Phase-2 review S2: filtering to one kind printed "no
    # dead letters" over a store that dropped whole sessions).

  Scenario: a deep backlog with no capture gaps warns that nothing is draining
    Given a project whose store has a backlog past the pane's warning line and no gaps
    When doctor runs from that project directory
    Then capture debt is a warning saying nothing is draining this store
    And the fix line says the backlog is waiting, not lost
    # Phase-2 review S3: a STOPPED drain writes no dead letters because
    # nothing is being attempted — zero gaps plus a deep backlog is the
    # least healthy shape there is, and it used to read [ok]. The
    # threshold is the sidecar pane's own warning line, so the two
    # surfaces grading one drain cannot disagree.
