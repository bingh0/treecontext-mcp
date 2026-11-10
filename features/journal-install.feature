Feature: Journal install — setup is auditable, reversible, and honest

  The installer touches other people's configuration — agent settings,
  hook registrations, instruction files — which makes its promises less
  about what it adds and more about what it refuses to break: it merges
  rather than overwrites, backs up rather than clobbers, converges
  rather than duplicates, and uninstall walks every step back. And it is
  honest about verification: a capture hook sitting in your settings
  reads as a promise that capture is running, so a client gets the MCP
  tools and nothing else until its capture has been verified live at its
  version.

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

  @D402
  Scenario: every hook event the client has is wired or named as not captured
    Given the list of Claude Code's hook events, kept with the client version it was read from
    When it is compared with the hooks install wires
    Then every event on the list is either wired or named with what the journal does not capture because of it
    And every event install wires is on the list
    And an installation wired before a capture event was added is reported by doctor with the command that wires it
    # The failed-call hole (D400) stood since the first release because
    # nothing ever set the client's own event list beside the seven events
    # install wired: each event was specified, bound and reviewed by
    # itself, and the question "which events does the client have that we
    # do not hear?" had no place to be asked. The list is the client's,
    # read from its hooks reference and from what a real run fired; an
    # event treecontext does not wire is a decision with a reason on it,
    # never an omission.

  @D409
  Scenario: every hook event Codex CLI has is wired or named as not captured
    Given the list of Codex CLI's hook events, kept with the Codex version it was read from
    When it is compared with the hooks install writes for Codex
    Then every event on the list is either wired or named with what the journal does not capture because of it
    And every event install writes for Codex is on the list
    And the list names PostToolUseFailure and PostToolBatch as events Codex does not have, with what the journal does not capture on Codex because of it
    And the list marks PreToolUse, Interrupt and PreCompact wired, each with what it is for, and PostCompact not captured, with the reason

  @D409
  Scenario: the capture census counts a Codex session's calls and says which it could only infer
    Given the transcript of a headless Codex session and the store its hooks wrote, both recorded, in which Codex called a tool directly and ran shell commands through its code mode
    When the capture census counts the session's calls against the store
    Then the census counts the direct call as found by Codex's id for it
    And it counts each code-mode call by Codex's id for it where the transcript's record of the completed call carries that id, and as matched by inference where it does not
    And it says how many it found by id and how many it inferred, and why
    # Recorded live, 2026-11-09, Codex CLI 0.167.0: Codex runs most tool
    # calls inside a script of its own. Corrected 2026-11-10 from the
    # recordings: the transcript's record of a completed code-mode call
    # carries the id the hooks carry (5 of 6 in the headless recording);
    # a call the sandbox refused and a patch that failed carry none, and
    # only those are inferred. The census over a live
    # Codex session is a release dogfood check, as D402's census is: run
    # by the dogfood routine against the installed build before the
    # release, never by this scenario, which reads what was recorded.

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

  @D51 @D385
  Scenario: a forced reinstall rewrites only the agent it names
    Given a machine where install has wired two agents
    And both agents' entries have since been hand-edited to a different absolute command, and the first given a pinned store
    When install runs again with force naming only the first agent
    Then the named agent's entry carries the command and arguments this build writes
    And the pinned store the developer added to the named agent's entry is still there
    And the other agent's hand-edited configuration is byte-for-byte untouched
    # --force is consent to overwrite even a VALID entry — without it, an
    # absolute command that exists is skipped, and convergence repairs
    # only drift — and --agent bounds the consent. A scoped forced
    # reinstall is the documented repair and upgrade path; the agents
    # beside the named one must never be collateral.

  @D29 @D406 @D413
  Scenario Outline: a client below the version its capture was verified at gets tools, not capture hooks
    Given <client> whose version reads <version>
    When install runs
    Then <client> is wired for the MCP tools
    But no capture hook of treecontext's is written for it
    And the developer sees install say in one line that <client> stays tools-only until <floor>

    Examples:
      | client          | version | floor   |
      | Codex CLI       | 0.166.0 | 0.167.0 |
      | Antigravity CLI | 1.5.2   | 1.5.3   |
    # Reworded 2026-11-09 (D406, D413): the agent whose capture adapter
    # had never run against a live session is now a client below the
    # first version a live run verified, and no flag opts it in: the
    # experimental flag that did is gone (D406).

  @D57 @D406
  Scenario Outline: the experimental capture flag is refused, saying it is gone and naming each client's floor, <named>
    Given a machine with Claude Code, Codex CLI 0.167.0 and Antigravity CLI 1.5.3 installed
    When install runs with the experimental capture flag <named>
    Then the install is refused before anything is written, and the install run exits non-zero
    And the developer sees one line saying the flag is gone and that each captured client is wired by default from its version floor, naming Codex CLI 0.167.0 and Antigravity CLI 1.5.3

    Examples:
      | named                   |
      | and no agent name       |
      | naming Codex CLI        |
      | naming Antigravity CLI  |
    # Ruled 2026-08-01 (D57): the bare flag was refused, because it
    # would opt in every detected unverified platform at once; the name
    # was the consent. Reworded 2026-11-09 (D406): no client is left for
    # the flag to opt in, and the owner removed it ("why not remove it if
    # it's unnecessary?"), so every form of it is refused, in a line that
    # tells a script's author what replaced it.

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

  @D51 @D383
  Scenario: uninstall removes everything install wrote and nothing else
    Given a machine with treecontext installed alongside foreign servers and hooks
    When uninstall runs
    Then every treecontext MCP entry, permission rule install added, hook, script, and skill is gone from every agent
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

  # The headless build (D381, D383, D385, D386, D390, 2026-11-07): Codex CLI
  # and Antigravity CLI workers just work after install, the four tools that
  # read and write are approved in all three clients and the four that
  # remove or bring in rows keep asking, and a reinstall converges what
  # install owns and keeps what the developer added.

  @D385 @D51
  Scenario Outline: a reinstall converges <agent>'s entry and keeps what the developer added
    Given a <agent> entry written by an earlier build, <stale>, to which the developer has added <additions>
    When install runs again without force
    Then the entry carries the command and arguments this build writes for <agent>
    And <additions> read as the developer left them

    Examples:
      | agent       | stale                                       | additions                                                                             |
      | Codex CLI   | lacking the worker variables                | a pinned store, `--instructions none`, a default approval and a list of enabled tools |
      | Codex CLI   | starting the server in capture mode         | a pinned store and a policy flag                                                      |
      | Claude Code | naming an interpreter that no longer exists | a pinned store and an environment block                                               |

  @D386 @D406 @D413
  Scenario Outline: the server runs in capture mode for <agent> only where its capture hooks are installed
    Given <agent> is installed
    When install runs <how>
    Then the server that <agent>'s entry starts runs <mode>
    And doctor's row for <agent> reads its mode as correct

    Examples:
      | agent           | how                                         | mode            |
      | Claude Code     | as usual                                    | in capture mode |
      | Codex CLI       | at version 0.167.0                          | in capture mode |
      | Codex CLI       | at version 0.166.0                          | without capture |
      | Antigravity CLI | as usual, its version reading 1.5.3         | in capture mode |
      | Antigravity CLI | as usual, its version reading 1.5.2         | without capture |

  # Codex capture (D406, 2026-11-09): from Codex CLI 0.167.0, hooks are a
  # stable feature of the client, so install writes Codex a block of its
  # own by default. Codex runs a hook only once the developer has trusted
  # it, and Codex alone records that trust: install never writes it.

  @D406
  Scenario: install wires Codex CLI 0.167.0 for capture with its own hooks, and names the one step left
    Given Codex CLI 0.167.0 is installed, its hooks file holding a hook of the developer's that Codex counts as trusted, and its `config.toml` holding a hook of the developer's
    When install runs
    Then Codex's `hooks.json` holds treecontext's hooks, in groups of their own after the developer's, for exactly the events Codex's list marks wired, with no PostToolUseFailure or PostToolBatch
    And every hook of treecontext's names Codex CLI in its command
    And the developer's own hooks, in `hooks.json` and in `config.toml`, read as the developer left them, and Codex still counts the first trusted
    And Codex's record of trusted hooks holds nothing install wrote
    And the developer sees install say in one line that Codex runs none of treecontext's hooks until they are trusted, with `/hooks` in Codex
    # Recorded live, 2026-11-09, Codex CLI 0.167.0: an untrusted hook
    # fires nothing and says nothing, and Codex keys its trust by the
    # hook's place in the file as well as its text. A hook install moved
    # would read untrusted to Codex though nobody changed it.

  @D406
  Scenario Outline: install writes no Codex CLI hook where <case>, takes back what install wrote, and says why
    Given Codex CLI where <case>, its hooks file holding <held>
    When install runs
    Then Codex's hooks file holds <after>
    And the server Codex's entry starts runs without capture
    And the developer sees install say in one line that Codex CLI stays tools-only, <why>

    Examples:
      | case                          | held                                                                                                                    | after                                                  | why                                                                    |
      | its version reads 0.166.0     | treecontext's hooks an earlier install recorded writing at 0.167.0, beside a hook of the developer's                    | the developer's hook alone, as the developer left it   | naming 0.166.0 and that capture needs Codex CLI 0.167.0 or later       |
      | its version cannot be read    | the verbatim copy of the Claude Code block an earlier build wrote under the experimental flag, beside a hook of the developer's | the developer's hook alone, as the developer left it | saying its version could not be read                            |
      | its hooks file does not parse | a hook of the developer's and treecontext's hooks an earlier install wrote                                              | byte for byte what it held                             | quoting the parse error                                                |
    # One rule below a floor for both clients (D406, D413): install takes
    # back what install wrote, the hooks its record names or the old copy
    # known by its commands, and never a hook of the developer's. A file
    # that does not parse is the developer's to fix: install touches
    # nothing in it.

  @D406 @D385
  Scenario: a reinstall turns the copy an earlier build wrote into Codex's own block
    Given Codex CLI 0.167.0 whose hooks file holds the verbatim copy of the Claude Code block an earlier build wrote under the experimental flag, beside a hook of the developer's
    When install runs again
    Then Codex's hooks file holds Codex's own block once and nothing else of treecontext's, PostToolUseFailure and PostToolBatch gone
    And the developer's own hook reads as the developer left it
    And the developer sees install name the hooks Codex must be asked to trust again

  @D406 @D51
  Scenario Outline: uninstall takes back the hooks install wrote for Codex CLI and keeps the developer's, <case>
    Given Codex CLI 0.167.0 whose hooks file holds <ours>, after a hook of the developer's written before install ran
    When uninstall runs
    Then Codex's hooks file holds the developer's hook alone, at the place it had
    And Codex still counts the developer's hook trusted
    And Codex's treecontext entry is gone

    Examples:
      | case                              | ours                                                                                                         |
      | install's record naming its hooks | the hooks install wrote and recorded writing                                                                 |
      | no record naming them             | the verbatim copy of the Claude Code block an earlier build wrote under the experimental flag, before install kept a record |

  @D406
  Scenario: a hook the developer added after install keeps its words, and the developer is told when Codex will ask to trust it again
    Given Codex CLI 0.167.0 wired by install, and a hook of the developer's added after install for the same event and the same matcher as one of treecontext's, which Codex counts as trusted
    When install runs again and then uninstall runs
    Then after the reinstall the developer's hook is where it was, Codex still counts it trusted, and install named no hook of the developer's
    And after the uninstall the developer's hook is in Codex's hooks file with its command as the developer wrote it
    And the developer sees uninstall name the developer's hook if taking treecontext's out moved it, saying Codex will ask to trust it again
    # Codex keys its trust by a hook's place: file, event, group and
    # index. Install never puts a hook into a group of the developer's,
    # and a hook the developer adds after install is the one case where a
    # group of treecontext's can sit before one of theirs; taking it out
    # then moves theirs, and the developer must be told, not left to find
    # an untrusted hook firing nothing.

  @D406 @D385
  Scenario Outline: a reinstall where <case> <outcome>
    Given Codex CLI 0.167.0 wired by install, every hook of treecontext's trusted
    When <change>, and install runs again
    Then <then>

    Examples:
      | case                                                      | outcome                                   | change                                               | then                                                                                                   |
      | nothing changed                                           | leaves every hook's command as it was     | nothing changes                                      | every hook of treecontext's has its command byte for byte as it was, Codex still trusts each, and install names no hook to trust again |
      | an upgrade moved the Node interpreter the hook scripts name | leaves every hook's command as it was   | the Node interpreter the hook scripts name moves with an upgrade | every hook of treecontext's has its command byte for byte as it was, Codex still trusts each, and install names no hook to trust again |
      | the directory holding the hook scripts moved              | names each hook Codex will ask to trust again | the hook scripts are moved to another directory, so every command changes | install names each hook whose command changed and says Codex will ask to trust it again with `/hooks` |
    # The owner's Node upgrade routine moves the interpreter and reruns
    # install; a hook whose command text changes reads untrusted to Codex.
    # Nothing changed must mean nothing changed, byte for byte.
    # Corrected 2026-11-10 from the build: a Codex hook's command names
    # the hook script and the client, never the interpreter, which the
    # script names; a Node upgrade therefore changes no command and costs
    # no trust. The third row keeps the promise the second used to carry,
    # for a command that does change.

  @D406 @D413 @D51
  Scenario Outline: the hook scripts a client's hooks run are there whenever a client's hooks name them, <case>
    Given <machine>
    When <act>
    Then every hook script <hooks> run is there and runs

    Examples:
      | case                                            | machine                                                                      | act                                     | hooks                                              |
      | on a machine where Codex CLI is the only client | a machine with Codex CLI 0.167.0 installed and no other client               | install runs                            | Codex CLI's hooks                                  |
      | on a machine where agy is the only client       | a machine with Antigravity CLI 1.5.3 installed and no other client           | install runs                            | Antigravity CLI's named hook                       |
      | after Claude Code alone is uninstalled          | a machine with Claude Code, Codex CLI 0.167.0 and Antigravity CLI 1.5.3 wired by install | uninstall runs naming Claude Code alone | Codex CLI's hooks and Antigravity CLI's named hook |
    # The scripts live with Claude Code's today, and a scoped uninstall
    # of Claude Code took them with it; the other clients' hooks would
    # then run a script that is not there, and capture nothing.

  @D381 @D390
  Scenario: install lets a headless Codex worker use the tools that read and write, and leaves the four that remove or bring in rows asking
    Given Codex CLI is installed at a version that reads per-tool approvals
    When install runs
    Then Codex's own reading of its configuration shows the treecontext server with status, query, export and insert approved
    And it shows clear, delete, import and merge with no approval install wrote
    And Codex reads its whole configuration without refusing it

  @D381 @D385
  Scenario Outline: install never writes the approval the developer set for <tool> to <value>
    Given a Codex CLI whose treecontext entry carries the developer's approval for <tool> set to <value>
    When install runs
    Then the approval for <tool> still reads <value>
    And install says nothing about having written it

    Examples:
      | tool               | value   |
      | treecontext_insert | prompt  |
      | treecontext_delete | approve |

  @D381
  Scenario: a Codex that cannot read per-tool approvals gets none, and is told why
    Given a Codex CLI whose version reads older than the first that reads per-tool approvals
    When the developer runs install and then doctor
    Then Codex's configuration carries no per-tool approval
    And the developer sees install say in one line that Codex's headless workers need a newer Codex for the tools, naming the version
    And the developer sees doctor's row for Codex CLI say the same
    # Conditional (D381): kept only if the dogfood shows an older Codex
    # refusing the keys; dropped, by a dated docket line, if the oldest
    # Codex at hand reads them.

  @D383 @D390 @D413
  Scenario: install wires Antigravity CLI for the tools and lets a headless agy worker use the four that read and write
    Given a machine with Antigravity CLI installed, its version reading 1.5.3
    When install runs
    Then Antigravity CLI's own listing of its MCP servers reports the treecontext server
    And its permission settings allow status, query, export and insert of the treecontext server, and no other treecontext tool
    And no hook of Antigravity CLI's is written but treecontext's own named hook
    And the instruction block Antigravity CLI reads is present once

  @D399 @D51
  Scenario: install never wires Gemini CLI, even where its own command and files are there
    Given a machine with Antigravity CLI installed, and Gemini CLI's command and its own files present
    When install runs
    Then no Gemini CLI configuration is written
    And Antigravity CLI is wired for the tools

  @D399 @D413
  Scenario: the sweep for Gemini CLI leaves Antigravity CLI's hooks file alone
    Given Antigravity CLI 1.5.3 wired by install, its hooks file holding treecontext's named hook beside a hook of the developer's, and Gemini CLI's settings holding what an earlier install wrote for it
    When uninstall runs naming Gemini CLI
    Then Antigravity CLI's hooks file is byte for byte as it was
    And Gemini CLI's settings hold nothing of treecontext's
    # Both live under `~/.gemini`: the archived sweep takes Gemini CLI's
    # settings file and wrappers, never agy's `config/hooks.json`.

  @D399
  Scenario: install refuses an install naming Gemini CLI, saying it is retired
    Given a machine with Gemini CLI's command and its own files present
    When install runs naming Gemini CLI
    Then the install run exits non-zero
    And the developer sees one line saying Gemini CLI is retired, naming Antigravity CLI and the command that removes an old entry
    And no Gemini CLI configuration is written

  @D399 @D51
  Scenario: uninstall sweeps what an earlier install wrote for Gemini CLI and keeps the developer's own keys
    Given Gemini CLI's settings holding the treecontext entry and the copied hooks an earlier install wrote, beside the developer's own server, hook and keys, its hook wrappers, and the instruction block in GEMINI.md below the developer's notes
    When uninstall runs
    Then Gemini CLI's settings hold the developer's own server, hook and keys, and nothing of treecontext's
    And no Gemini CLI hook wrapper is left
    And GEMINI.md holds the developer's notes and no treecontext block

  @D399 @D383
  Scenario: the instruction block in GEMINI.md is Antigravity CLI's, and goes with Antigravity CLI's uninstall
    Given a machine with Antigravity CLI installed, Gemini CLI's own files present, and a GEMINI.md holding the developer's own notes
    When install runs and then Antigravity CLI is uninstalled
    Then after install GEMINI.md holds the treecontext block once, below the developer's notes
    And after the uninstall GEMINI.md holds the developer's notes and no treecontext block
    And Antigravity CLI's own listing of its MCP servers no longer names the treecontext server

  @D383 @D51
  Scenario: a permission rule the developer wrote for Antigravity CLI survives install and uninstall
    Given Antigravity CLI's permission settings holding the developer's allow rule for another server and ask rule for treecontext_insert
    When install runs and then uninstall runs
    Then after install the developer's two rules read as they were
    And after uninstall the rules install added are gone and the developer's two remain

  @D390
  Scenario: install says what it approved, what still asks, and the way back
    Given a machine with Claude Code, Codex CLI and Antigravity CLI installed
    When install runs
    Then the developer sees one message naming status, query, export and insert as approved in each of the three, and where
    And the message names clear, delete, import and merge as still asking
    And the message names `treecontext config tool-approvals off` and `install --no-tool-approvals` as the way back

  @D390
  Scenario Outline: turning tool approvals off and on again in <client> touches only what install wrote
    Given <client> wired by install, with the developer's own rule <rule> beside install's grants
    When the developer runs `treecontext config tool-approvals off`
    Then the developer sees it say that headless workers will now be refused the four tools, and how to turn them back on
    And <client>'s own view shows none of the four approved by install, and the developer's rule as it was
    When the developer runs `treecontext config tool-approvals on`
    Then <client>'s own view shows install's grants back for each of the four that no rule of the developer's decides, and the developer's rule as it was

    Examples:
      | client          | rule                                            |
      | Claude Code     | an ask rule for treecontext_insert              |
      | Codex CLI       | an approval set to prompt for treecontext_query |
      | Antigravity CLI | a deny rule for treecontext_export              |

  @D390
  Scenario: an install told not to approve writes no approval, and a later install keeps it that way
    Given a machine with Claude Code, Codex CLI and Antigravity CLI installed
    When install runs with `--no-tool-approvals`
    And install runs again without it
    Then none of the three carries an approval install wrote for a treecontext tool
    And the developer sees the second install say that tool approvals are off by the developer's choice, and how to turn them on

  @D390 @D51
  Scenario: Claude Code's grant sits beside the developer's own rules and leaves with uninstall
    Given Claude Code's settings holding the developer's allow rule for another server's tool and deny rule for treecontext_delete
    When install runs and then uninstall runs
    Then after install the settings allow the four treecontext tools, and the developer's two rules read as they were
    And after uninstall the four rules install added are gone and the developer's two remain

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
  Scenario Outline: install's way back on at <version> is <remedy>
    Given a Claude Code whose version reads <version> and whose settings carry no idle-compaction key
    When the developer runs install
    Then the developer sees install's one line name <remedy> as where to turn it back on

    Examples:
      | version | remedy                                                   |
      | 2.1.301 | the settings line "idleCompaction": true, no /config row |
      | 2.1.302 | the client's /config row                                 |

  @D338 @D290
  Scenario: a client that honors the key but has no /config row is told the settings line alone
    Given a Claude Code whose version reads 2.1.295 and whose settings carry no idle-compaction key
    When the developer runs install
    Then the settings file carries the idle-compaction key set to off
    And the developer sees install say in one line that idle compaction was turned off, naming the settings line "idleCompaction": true as where to turn it back on, and no /config row

  @D338 @D290
  Scenario: doctor warns with the settings line alone where the client has no /config row
    Given a Claude Code whose version reads 2.1.295 and whose settings carry the idle-compaction key set to on
    When doctor runs
    Then the developer sees doctor's row for idle compaction warn with the settings line only

  @D304
  Scenario: install writes the key on a later run once the client is upgraded
    Given a Claude Code whose version reads 2.1.289, on which install wrote no idle-compaction key
    When the client is upgraded to 2.1.302 and the developer runs install again
    Then the settings file carries the idle-compaction key set to off
    And the developer sees install say in one line that idle compaction was turned off

  # Antigravity CLI's hooks (D413, D417, 2026-11-09, beta.4): install
  # writes agy a named hook of its own into agy's own hooks file, in agy's
  # own shape, beside the developer's hooks and never over them, from the
  # first agy version whose hooks were recorded live, 1.5.3. A file agy
  # cannot parse silences every hook in it, so install never writes into
  # one; PreToolUse must decide a call's permission, so install never
  # wires it.

  @D413
  Scenario: install writes Antigravity CLI its own named hook beside the developer's
    Given an Antigravity CLI whose version reads 1.5.3, whose hooks file holds the developer's own named hook for PostToolUse, and a workspace whose `.agents/hooks.json` holds a hook of the developer's
    When install runs
    Then the hooks file holds treecontext's named hook for SessionStart, PreInvocation, PostToolUse, PostInvocation and Stop, and no hook of treecontext's for PreToolUse
    And every command of treecontext's named hook names Antigravity CLI
    And the developer's named hook reads as it was, and the workspace's `.agents/hooks.json` is byte for byte as it was
    And a real agy run fires both the developer's hook and treecontext's, and agy's log records no error for the file
    And the developer sees install say which Antigravity CLI events it wired and in which file
    # Found on the far-side pass of 2026-11-09 (agy 1.5.3): agy's hooks
    # file is keyed by hook name, not by event as Claude Code's is, and a
    # file in Claude Code's shape is refused whole, with a line only in
    # agy's own log. The run in the third Then is agy's, not a stand-in:
    # the file's shape is what agy accepts, and only agy can say so.

  @D413
  Scenario Outline: install writes no Antigravity CLI hook where <case>, and says why
    Given an Antigravity CLI where <case>
    When install runs
    Then the hooks file is byte for byte as it was, or still absent
    And the server Antigravity CLI's entry starts runs without capture
    And the developer sees install say in one line that Antigravity CLI stays tools-only, <why>

    Examples:
      | case                                                             | why                                                                                                                     |
      | the version reads 1.5.2                                          | naming 1.5.2 and 1.5.3 as the first version whose hooks install writes                                                  |
      | the version cannot be read                                       | saying the version could not be read                                                                                    |
      | the hooks file holds the developer's hook and does not parse     | quoting the parse error and saying agy runs none of the hooks in that file, the developer's included, until it is fixed |
      | the hooks file holds a hook of the developer's named treecontext | saying the name is taken by a hook install did not write                                                                |

  @D413 @D51
  Scenario: uninstall takes back the named hook install wrote and nothing else
    Given an Antigravity CLI at 1.5.3 whose hooks file install created, and another whose hooks file held the developer's own named hook before install
    When install runs and then uninstall runs on each
    Then the hooks file install created is gone
    And the other hooks file holds the developer's named hook as it was, and nothing of treecontext's

  @D413 @D51
  Scenario: with install's own record lost, uninstall knows treecontext's named hook by its commands and keeps the file
    Given an Antigravity CLI at 1.5.3 whose hooks file install created and wrote its named hook into, and install's own record since lost
    When uninstall runs
    Then the hooks file holds nothing of treecontext's
    And the hooks file is still there, install's record no longer saying install created it

  @D413
  Scenario: an Antigravity CLI below 1.5.3 has the named hook an earlier install wrote taken back
    Given an Antigravity CLI whose hooks file holds treecontext's named hook an earlier install wrote at 1.5.3, beside the developer's own named hook, and whose version now reads 1.5.2
    When install runs
    Then the hooks file holds the developer's named hook as it was, and nothing of treecontext's
    And the developer sees install say in one line that Antigravity CLI stays tools-only, naming 1.5.2 and 1.5.3

  @D413 @D385
  Scenario: a named hook the developer switched off stays off through a reinstall
    Given an Antigravity CLI at 1.5.3 whose hooks file holds treecontext's named hook, which the developer set to `enabled: false`
    When install runs again
    Then treecontext's named hook is still switched off
    And the developer sees install say that capture on Antigravity CLI is switched off there by the developer

  @D413 @D385
  Scenario: a reinstall converges the named hook an earlier build wrote and keeps the developer's
    Given an Antigravity CLI at 1.5.3 whose hooks file holds a treecontext named hook an earlier build wrote, wired for fewer events, beside the developer's own named hook
    When install runs again without force
    Then treecontext's named hook is the one this build writes
    And the developer's named hook reads as it was

  @D417 @D402
  Scenario: every hook event Antigravity CLI has is wired or named as not captured
    Given the list of Antigravity CLI's hook events, kept with the agy version it was read from
    When it is compared with the named hook install writes for Antigravity CLI
    Then every event on the list is either wired or named with what the journal does not capture because of it
    And every event install wires for Antigravity CLI is on the list
    And PreToolUse is on the list as not wired, because its hook must decide the call's permission
    And PostInvocation is on the list as wired, because a call's output is in agy's transcript only by the end of the model call that made it
    # D402's guard for a second client. agy has six events and none for a
    # prompt, a subagent, a compaction or a failed call: the list is where
    # each of those absences is written down beside what it costs.
