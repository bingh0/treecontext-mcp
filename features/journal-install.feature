Feature: Journal install — setup is auditable, reversible, and honest

  The installer touches other people's configuration — agent settings,
  hook registrations, instruction files — which makes its promises less
  about what it adds and more about what it refuses to break: it merges
  rather than overwrites, backs up rather than clobbers, converges
  rather than duplicates, and uninstall walks every step back. And it is
  honest about verification: a capture hook sitting in your settings
  reads as a promise that capture is running, so unverified platforms
  get the MCP tools and nothing else unless you opt in by name.

  What counts as evidence here is narrower than elsewhere in this suite.
  For the store, the SQLite file is ground truth. For the installer it is
  not: the file we wrote is our own claim, and the promise is about what
  some *other* program then does with it. So the scenarios that cross a
  boundary — the agent's config reader, the OS's interpreter lookup, the
  command a user types — are bound against that other side, never against
  our own read-back. 0.0.9-beta is why the rule is written down: it wrote
  a registration Claude Code does not read, doctor parsed that same file
  back and reported success, and every check was green while no tool
  existed. A file we can re-read proves only that we can re-read it.

  @D51
  Scenario: install wires only the agents that are present
    Given a machine where only some of the known agents are installed
    When install runs
    Then the detected agents are wired for MCP
    And no configuration is created for agents that are not there

  @D51
  Scenario: the registration lands where the agent itself reads it
    Given a machine with the reference agent installed
    When install runs
    Then the agent's own configuration listing reports the treecontext server
    And the agent reports it at user scope, available in every project
    # Bound against the agent's CLI, not against our own file. 0.0.9-beta
    # wrote ~/.claude/.mcp.json — a path Claude Code reads at no scope —
    # and nothing in the suite could tell, because every check asked us
    # where we had put it instead of asking the agent what it could see.

  @D51
  Scenario: the command the install instructions tell you to type produces output
    Given the package installed so its command on PATH is a link to the real entry point
    When that linked command is invoked with a subcommand
    Then the subcommand prints its report
    And the command exits successfully
    # The README's verify step is `treecontext doctor`. A global npm
    # install puts a symlink on PATH, so the process entry point and the
    # module's own path differ; 0.0.9-beta compared them without
    # resolving links, decided it was imported rather than run, and every
    # subcommand printed nothing and exited 0.

  @D51
  Scenario: the dry run is the whole plan
    Given a machine with agents detected
    When install runs with the dry-run flag
    Then every path a real install would write is listed
    And nothing on disk has changed

  @D51
  Scenario: existing configuration is merged, never clobbered
    Given an agent config already holding a foreign MCP server and a foreign hook
    When install runs
    Then the treecontext entries are added
    And the foreign entries survive untouched

  @D51
  Scenario: a corrupt config file is backed up, not destroyed
    Given an agent config file that does not parse
    When install runs
    Then a fresh config is written with the treecontext entries
    And the unparseable original is preserved as a backup beside it

  @D51
  Scenario: reinstalling converges instead of duplicating
    Given a machine where install has already run
    When install runs again without force
    Then no entry is registered twice
    And an entry pointing at an interpreter that no longer exists is repaired in place
    # The repair clause is the upgrade path (AC1.5): a node version bump
    # invalidates absolute interpreter paths, and the documented fix is
    # "re-run install" — so the re-run must converge stale commands
    # without needing --force.

  @D51
  Scenario: nothing the installer writes invokes a bare interpreter
    Given a machine where install has completed
    When every hook script and MCP entry it wrote is inspected
    Then each command resolves to an absolute path that exists on this machine
    # Hooks fire under launchd- and nvm-shaped PATHs where bare `node`
    # is not found; a bare command means capture dies silently on the
    # next environment change (AC1.1–AC1.3).

  @D51
  Scenario: the interpreter install chooses can actually run this package
    Given a machine offering several interpreters, only one of which meets the Node floor and runs this package
    When install runs
    Then the interpreter baked into the wrappers is one that runs this package
    And the interpreters that cannot run it are not chosen
    # Existing and executable is the wrong test, and passing it is how
    # this shipped: on a Mac with Homebrew node first on PATH, the
    # wrappers picked an interpreter with no prebuild for it. Capture
    # wrappers exec node with stderr discarded and the dispatcher never
    # exits non-zero, so every hook "ran" and nothing was ever written.
    # Reworded 2026-10-11 (D278): the binding is gone with the native
    # driver. What an interpreter must do now is meet the floor and open
    # a database with the SQLite it carries — an older Node has no
    # `node:sqlite`, or one that warns on load and truncates text at a
    # NUL. The probe stays an exec of the candidate, never a version
    # compare: a distro Node built against a system SQLite can lack FTS5
    # at any version, and only opening finds that out.

  @D51
  Scenario: an interpreter that cannot run this package is reported, not tolerated
    Given an installation whose wrappers name an interpreter that cannot run this package
    When doctor runs
    Then the report names that interpreter as a failure
    And it says that capture would record nothing rather than reporting the hooks healthy

  @D53
  Scenario: an unwritable agent config fails loudly and changes nothing
    Given an agent config whose file or directory denies writes
    When install runs
    Then the failure names the path and the permission problem
    And the install run exits non-zero
    And every other detected agent is still wired completely
    And no partial or temporary file is left at the unwritable path
    # The file's thesis is what install refuses to break; this is the
    # failure half — journal-storage's "a full disk fails loudly and
    # corrupts nothing" for the installer. Added 2026-07-31 (adversarial
    # review F8). Per-agent isolation is the load-bearing clause: one
    # locked-down config must not abort the wiring of the agents beside it.
    # The exit clause is isolation's other half (E chunk 3): carrying on
    # past the fault must not launder a partial install into `install &&
    # next-step` success — the run ends INSTALL_PARTIAL, non-zero.

  @D51
  Scenario: a forced reinstall rewrites only the agent it names
    Given a machine where install has wired two agents
    And both agents' entries have since been hand-edited to a different absolute command
    When install runs again with force naming only the first agent
    Then the named agent's entry is restored to the canonical registration
    And the other agent's hand-edited configuration is byte-for-byte untouched
    # --force is consent to overwrite even a VALID entry — without it, an
    # absolute command that exists is skipped, and convergence repairs
    # only drift — and --agent bounds the consent. A scoped forced
    # reinstall is the documented repair and upgrade path; the agents
    # beside the named one must never be collateral.

  @D29
  Scenario: an unverified platform gets tools, not capture hooks
    Given a detected agent whose capture adapter has never run against a live session
    When install runs without the experimental capture flag
    Then the agent is wired for the MCP tools
    But no capture hooks are written for it

  @D29
  Scenario: experimental capture is an opt-in by name
    Given the same unverified agent
    When install runs with the experimental capture flag naming that agent
    Then its capture hooks are written
    And the output states plainly that capture there is unverified

  @D57
  Scenario: the experimental capture flag without a named agent is refused
    Given a machine with an unverified agent detected
    When install runs with the experimental capture flag and no agent name
    Then the install is refused before anything is written
    And the refusal says the opt-in must name an agent
    # Ruled 2026-08-01: the bare flag would opt in every detected
    # unverified platform at once — a blanket switch contradicting the
    # header's "unless you opt in by name". The name is the consent.

  @D51
  Scenario: doctor proves health rather than inferring it
    Given a working installation
    When doctor runs
    Then the database is verified by opening one and reading its SQLite version and FTS5 support, not by comparing versions
    And every failing check is accompanied by the command that fixes it
    # Binding note (2026-07-31, pre-binding): the fix-command clause is
    # universally quantified over the doctor check registry, so its
    # binding must ENUMERATE the registry — walk every registered check
    # and assert each carries a fix command — not sample one or two. A
    # sampled binding rots silently the moment a check is added.
    # Reworded 2026-10-11 (D278): "the native database binding is
    # verified by opening a database" became the line above. Proving by
    # doing is the unchanged claim; what is proved is now the SQLite the
    # running Node carries.

  @D278
  Scenario: doctor's database row names the SQLite the running Node carries
    Given a working installation
    When doctor runs
    Then the database row names the SQLite version the running Node carries and says FTS5 is compiled in
    And both facts are read by opening a database, not from a table of versions
    And no row names a native binding or a prebuild
    # The version is not ours to know ahead of time: a distro Node built
    # against a system SQLite (the Red Hat family's `--shared-sqlite`)
    # carries whatever that system has, FTS5 or not. So the row asks the
    # process (`process.versions.sqlite`, the compile options of an open
    # database), and a Node whose SQLite lacks FTS5 is an error here, at
    # install time, not a failed CREATE VIRTUAL TABLE at first capture.

  @D278
  Scenario: doctor holds the package to one Node floor
    Given a working installation
    When doctor runs
    Then the Node row reports the running version against the floor the package's manifest declares
    And the floor the row names is the manifest's, so the two cannot drift
    # The binding era kept a list of majors with a prebuild in the
    # installer and reported "no prebuild for Node N yet"; that list is
    # gone with the binding. There is one number now, `engines.node`,
    # and doctor reads it rather than repeating it.

  @D276
  Scenario: doctor says in one line that nothing is set up yet
    Given a machine where the package is installed and no agent is wired
    When the developer runs doctor
    Then the first line after the header says treecontext is not set up for any agent yet and names the one command to run
    And every warning row below it names that same command as its fix
    # A second beta tester, 2026-10-10: npm install done, doctor run as
    # the README said, a wall of warnings each ending in "fix: treecontext
    # install", read as a failed install. The rows were right; the
    # headline was missing.

  @D265
  Scenario: doctor names a staging row retried past ten times the ceiling and who spins on it
    Given a store whose staging table holds a row retried more than ten times the retry ceiling, while the drain lease names a live holder
    When the developer runs doctor
    Then the capture-debt row names that staging row, its attempt count and the drain holder's process
    And the finding's fix names the process to quit
    # The drain releases its row claims at the end of every tick, so the
    # only persisted evidence of who spins is the drain lease's holder;
    # that is the claimant D265 names. Any unprocessed row past the
    # ceiling means the dead-letter insert itself is failing, the shape a
    # migrated store leaves.

  @D265
  Scenario: the upgrading instructions say to quit every running session first
    Given the README's section on upgrading between betas
    When a developer reads it before upgrading
    Then its first instruction is to quit every running session

  @D51
  Scenario: the command doctor prints is one that clears the finding
    Given an installation with a finding doctor knows how to fix
    When the command that finding prints is run
    And doctor runs again
    Then that finding is gone from the report
    # Carrying *a* command satisfied the clause above while the command
    # did nothing: 0.0.9-beta told VS Code users to re-run install for
    # hooks install refuses to write, so the warning survived every
    # attempt. Presence was never the promise; the promise is that the
    # printed line is the way out.

  @D120
  Scenario: doctor names the build the command on PATH would run
    Given a working installation where the command on PATH is a different build
    When doctor runs with that command first on PATH
    Then the report names that build and this one, each by version and location
    And the report says the agent is wired to this one
    # 2026-09-09: a Windows tester with a 0.1.0-rc.2 global install cloned
    # the archived tree-era repository, built its 2.0.0, ran `node
    # dist/server/cli.js install` from the checkout, and reported that
    # "2.0.0 did not install an executable on path". Both doctors were
    # honest about themselves and silent about each other: neither said
    # that `treecontext` on PATH was a different build from the one
    # printing the report, so a version number read as an ordering while
    # the hooks quietly pointed at the checkout. The report never ranks
    # the two versions — across lineages the larger number was the older
    # build — it names them.

  @D120
  Scenario: doctor names the build the agent is wired to, and spells the fix through this one
    Given a working installation where the command on PATH is a different build
    And that build has since re-pinned the launcher to itself
    When doctor runs with that command first on PATH
    Then the report says the agent talks to that build
    And the fix reaches this build without going through PATH
    When the fix that finding prints is run from this build
    Then the finding is gone and the agent is wired to this one again
    # The other half of the same report. `install` bakes its own entry
    # point into the MCP launcher, so whichever build ran install last is
    # the one the agent talks to — and a `treecontext install --force`
    # typed into a shell whose PATH runs the other build would rewire the
    # agent to that build again. The fix is spelled through this build's
    # own entry point whenever PATH does not reach it — and it is run, not
    # read: the review of the first cut found this step certifying a
    # command it never executed.

  @D120
  Scenario: doctor says so when the command is on no PATH at all
    Given a checkout that was built but never installed globally
    When doctor runs with no treecontext command on PATH
    Then the report says the command is absent and where this build lives
    And the finding carries the command that puts this build on PATH
    # A checkout is never on PATH by construction — the README says to run
    # it as `node dist/server/cli.js`. That is a fact worth one line in
    # the report rather than a surprise filed as an install bug.

  @D51
  Scenario: uninstall removes everything install wrote and nothing else
    Given a machine with treecontext installed alongside foreign servers and hooks
    When uninstall runs
    Then every treecontext MCP entry, hook, script, and skill is gone from every agent
    And the foreign configuration is intact
    And the journal stores are untouched
    # The journals outlive the tool: uninstall reverses the wiring, never
    # the record. Deleting stores is a separate, manual act (README §7).

  @D51
  Scenario: hooks-only uninstall keeps the launcher its MCP registration points at
    Given a machine with treecontext installed for the reference agent
    When uninstall runs with the hooks-only flag
    Then the hook scripts are gone
    And the MCP registration still points at a launcher that exists
    # --hooks-only is the fix doctor offers for stale hooks, promised to
    # leave the MCP side working. The launcher shares the hooks
    # directory and the tc- prefix, and the sweep took it with the
    # hooks — a working registration left aimed at a file that was just
    # deleted, on the exact path users were told was safe.

  @D51
  Scenario: project instructions refresh in place
    Given a project instruction file already carrying an older treecontext block
    When init runs in that project
    Then the block is replaced by the current one without duplication
    And the rest of the file survives untouched

  # The beta.3 subagent interview (D290, D304, 2026-10-30 to 2026-10-31):
  # idle compaction destroys the prompt-cache economics the journal exists
  # to keep, so install turns it off where the client is known to read
  # the key, says so, and never touches a key the user set.

  @D290
  Scenario: install turns Claude Code's idle compaction off when the setting is absent, and says so
    Given a Claude Code whose version reads 2.1.302 and whose settings carry no idle-compaction key
    When the developer runs install
    Then the settings file carries the idle-compaction key set to off
    And the developer sees install say in one line that idle compaction was turned off, the reason, and that the client's /config row turns it back on

  @D290
  Scenario Outline: install never writes the idle-compaction key the user set to <value>
    Given a Claude Code whose version reads 2.1.302 and whose settings carry the idle-compaction key set to <value>
    When the developer runs install
    Then the settings file still carries the idle-compaction key set to <value>
    And the developer sees install say nothing about having written it

    Examples:
      | value |
      | on    |
      | off   |

  @D290
  Scenario: doctor warns while idle compaction is on, naming the /config row first
    Given a Claude Code whose version reads 2.1.302 and whose settings carry the idle-compaction key set to on
    When doctor runs
    Then the developer sees doctor's row for idle compaction warn that treecontext recommends off, with the client's /config row first and the settings line second

  @D290
  Scenario: the README's install section says idle compaction is turned off and why
    When the developer reads the README's install section
    Then the developer reads that install turns Claude Code's idle compaction off, the reason, and where to turn it back on

  @D304 @D338 @D290
  Scenario Outline: a Claude Code whose version <version> gets the idle-compaction key <written> and doctor says <row>
    Given a Claude Code whose version <version> and whose settings carry no idle-compaction key
    When the developer runs install and then doctor
    Then the settings file has the idle-compaction key <written>
    And the developer sees install say the setting is <said>
    And the developer sees doctor's row for idle compaction say <row>

    Examples:
      | version        | written     | said                           | row                                                        |
      | reads 2.1.289  | not written | not applicable to this client  | the setting is not read by this client, version 2.1.289    |
      | reads 2.1.290  | written off | turned off                     | off                                                        |
      | reads 2.1.302  | written off | turned off                     | off                                                        |
      | cannot be read | not written | not applicable to this client  | the setting is not read by this client, version unknown    |

  @D338 @D290
  Scenario: a client that honors the key but has no /config row is pointed at the settings line alone
    Given a Claude Code whose version reads 2.1.295 and whose settings carry the idle-compaction key set to on
    When the developer runs install and then doctor
    Then the developer sees install name the settings line as where to turn it back on, and no /config row
    And the developer sees doctor's row for idle compaction warn with the settings line only

  @D304
  Scenario: install writes the key on a later run once the client is upgraded
    Given a Claude Code whose version reads 2.1.289, on which install wrote no idle-compaction key
    When the client is upgraded to 2.1.302 and the developer runs install again
    Then the settings file carries the idle-compaction key set to off
    And the developer sees install say in one line that idle compaction was turned off
