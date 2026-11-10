Feature: Workers — a headless worker on any CLI, through the ticket door

  A worker is a headless process, `claude -p`, `codex exec` or `agy -p`,
  spawned by a main CLI of any of the three or by a harness, with a
  ticket in its environment that names its run, key, role, checkpointer
  and parent. The ticket is declared, never discovered. The door that
  reads it registers the worker under the parent the ticket names,
  composes its first moment from the brief and the checkpoint in effect,
  writes that first moment as the first row of the worker's own lane,
  and retires the worker at exit with its last output as the summary
  row. The store refuses nothing and checks no identity; the control is
  the trace every row carries.

  Rulings D288, D291, D292, D293, D294, D295, D297, D298, D303, D307,
  D313, D315, D316, D317, D329, D332, D335, D340, D341, D342 of the beta.3 interview, 2026-10-30 to
  2026-10-31; D372 and D374 of 2026-11-02 (a worker's status and search);
  D384 and D389 of 2026-11-07 (a failed worker's summary row; no
  client-session variable handed to a worker); D391, D393 and D397 of
  2026-11-09 (a worker's curated dedup in its own lane; a cut ends the
  worker's process group; the error stream kept open after the run);
  D403 of 2026-11-09, drafted (a worker in a sandbox that numbers its
  own processes is not judged by a reader's process table; a phantom is
  set right by its door's word at exit). The leg contract the worker fulfils is journal-legs; the
  run it belongs to is journal-runs. A worker here is bound through a
  stand-in headless process launched through the real door; what the
  model inside a real worker chooses to do is out of reach, so every
  outcome here is read from the door's output or the store.

  @D288 @D416
  Scenario Outline: a <worker> worker under a <parent> parent writes into its own lane with its role as writer
    Given a <parent> session registered as the parent "p1"
    And a <worker> worker started with a ticket naming the parent "p1", the run "r1", the key "login-form", the role "builder" and the reviewer as the one who will checkpoint
    When the worker inserts 3 notes and exits
    Then every row the worker wrote sits in the worker's own lane, stamped with the writer "builder" and the parent session "p1"
    And the parent's lane holds none of the worker's 3 notes

    Examples:
      | parent          | worker       |
      | Claude Code     | `codex exec` |
      | Codex           | `claude -p`  |
      | Antigravity CLI | `claude -p`  |
    # No Antigravity row until beta.4 (owner, 2026-11-09): an Antigravity
    # CLI main registered no self (the fence's Antigravity CLI entry, D370
    # amended by D383). From agy 1.5.3 with treecontext's named hook, its
    # SessionStart registers it (D416), so an agy main is a registered
    # parent; one below 1.5.3, or with no hook, stays the declared parent
    # of the D294 outline below. The Antigravity row's parent is
    # registered by agy's recorded SessionStart replayed through the hook
    # install writes, never by a registration the binding writes itself.

  @D288 @D384
  Scenario: a worker is retired at exit and its last output is the summary row the pointer names
    Given a `codex exec` worker with the role "builder" under the run "r1" and the key "login-form", whose ticket names the reviewer as the one who will checkpoint
    When the worker prints "submit wired; 12 tests pass" as its last output, writes "warning: cache cold" to its error stream, and exits with code 0
    Then the worker's registration reads retired
    And the spawner is handed one line pointing at a summary row reading "submit wired; 12 tests pass" with the writer "builder", and nothing from its error stream

  @D294 @D297 @D317
  Scenario: a worker's registration carries every field its ticket declared and the facts the door read
    Given a ticket minted at 09:14:00 naming the parent "p1", the run "r1", the key "login-form", the role "builder", the reviewer as the one who will checkpoint, and that the worker has a way to write
    When a `codex exec` worker starts with that ticket on the host "laptop" as the process 4242 started at 09:14:02
    Then a reader of the registration sees the parent "p1", the run "r1", the key "login-form", the role "builder", the checkpointer "reviewer", the door declared, the mint moment 09:14:00, the host "laptop", the process id 4242 and the start moment 09:14:02

  @D298
  Scenario: the ticket door composes a worker's first message from the brief, the checkpoint in effect and the spawner's prompt
    Given a brief for the builder role under the key "login-form" and checkpoint number 3 under that key, written by the builder role
    When the ticket door starts an `agy -p` worker with the spawner's prompt "wire the submit button"
    Then the worker's first message carries the brief, then checkpoint number 3 with its writer "builder" and its moment, then "wire the submit button"
    And the door's record shows the first message as the whole of the worker's input and no query issued on the worker's behalf

  @D298
  Scenario: a first moment with no checkpoint in effect is the brief and the prompt
    Given a brief for the builder role under the key "search-box" and no checkpoint under that key
    When the ticket door starts a `codex exec` worker with the spawner's prompt "build the search box"
    Then the worker's first message carries the brief, a line saying no checkpoint is in effect under "search-box", then "build the search box"
    And the first row of the worker's lane references the brief row and no checkpoint row

  @D298
  Scenario Outline: the first-moment row is the first row of the worker's lane through the <door>
    Given a brief row and a checkpoint row under the key "login-form"
    When a worker starts through the <door> with the spawner's prompt "wire the submit button"
    Then the first row of the worker's lane holds the text "wire the submit button" and references to the brief row and the checkpoint row by id
    And that row holds no copy of the brief or the checkpoint

    Examples:
      | door                                                                    |
      | door of a `codex exec` worker whose hooks do not run                    |
      | wrapper of a `claude -p` child, whose session-start hook links the lane |

  @D298
  Scenario: a worker whose hooks do not run and a `claude -p` child leave the same first-moment row, readable with plain SQL alone
    Given a brief row and a checkpoint row under the key "login-form"
    When a `codex exec` worker and a `claude -p` child each start with the spawner's prompt "wire the submit button"
    Then a reader with the store file and plain SQL sees the two first-moment rows equal column for column apart from their writer stamps, lanes and moments
    And no file outside the store is needed to read what either worker saw

  @D298
  Scenario: an empty spawner prompt still leaves the first-moment row
    Given a brief row and a checkpoint row under the key "login-form"
    When a `codex exec` worker starts with an empty spawner's prompt
    Then the first row of the worker's lane holds empty prompt text and references to the brief row and the checkpoint row by id

  @D313
  Scenario: a first-moment row keeps a pasted prompt whole behind a bounded preview
    Given a spawner's prompt of 300000 characters that pastes a configuration file
    When a `codex exec` worker starts with that prompt
    Then the worker's first-moment row holds all 300000 characters
    And an agent searching the prompt's words sees a bounded preview ending in the availability marker
    And an export of that row returns all 300000 characters

  @D315
  Scenario: a stranger's checkpoint reaches the worker's first moment flagged in words
    Given a brief for the builder role naming the builder as the checkpointer of the key "login-form"
    And the newest checkpoint in effect under the key "login-form" written by the writer "intruder"
    When the ticket door starts a builder worker
    Then the worker's first message carries that checkpoint and the sentence that its writer "intruder" is not the checkpointer the brief names
    And the worker's first-moment row carries the same flag
    And the harness looking up the key "login-form" sees the same flag in the run's facts

  @D291
  Scenario Outline: a worker whose hooks do not run that finishes without a checkpoint is run once more by the <spawner> that started it
    Given a `codex exec` worker started by the <spawner> under the key "login-form", with the ticket naming the worker as its checkpointer and declaring that it has a way to write
    When the worker exits with no checkpoint under the key "login-form" newer than its start
    Then the <spawner> runs the worker once more with the reason naming the missing checkpoint under "login-form"
    And the second run is a fresh process whose first message names that reason, with the first run's 25 inserted rows in the store for it to read

    Examples:
      | spawner                  |
      | `treecontext run` wrapper |
      | library call              |

  @D291
  Scenario: a worker whose key another writer checkpointed while it ran is not sent back
    Given a `codex exec` worker started by the wrapper under the key "login-form", with the ticket naming the worker as its checkpointer
    When the main agent writes checkpoint number 2 under "login-form" while the worker runs, and the worker then exits having written none itself
    Then the wrapper runs the worker no second time, and its registration reads retired with no send-back counted
    And the harness's lookup receives number 2 as the one in effect, flagged against the named checkpointer

  @D291
  Scenario: the wrapper never runs a worker a third time
    Given a `codex exec` worker already run once more for the missing checkpoint under the key "login-form"
    When the second run exits with no checkpoint written
    Then the wrapper starts no third run
    And the harness looking up the key "login-form" sees the leg retired as having ended without a checkpoint

  @D291
  Scenario: a worker that claimed a ticket with no wrapper gets no send-back and ends visibly without a checkpoint
    Given a `codex exec` worker that claimed a ticket by token under the key "login-form", naming itself as checkpointer, with no wrapper watching its exit
    When the worker exits with no checkpoint under the key "login-form"
    Then the harness looking up the key "login-form" sees the leg retired as having ended without a checkpoint
    And the next builder leg under the key "login-form" starts as a recovery leg

  @D291
  Scenario: a worker whose ticket names another role as checkpointer is never sent back
    Given a `codex exec` worker started by the wrapper under the key "login-form", with the ticket naming the project-manager as the one who will checkpoint
    When the worker exits with no checkpoint under the key "login-form"
    Then the wrapper starts no second run
    And the worker's registration reads retired

  @D316
  Scenario: a worker whose ticket declares no door gets no send-back
    Given an `agy -p` worker started by the wrapper under the key "login-form", with the ticket naming the worker as its checkpointer and declaring that it has no way to write to the store
    When the worker prints "done: submit wired" and exits with no checkpoint
    Then the wrapper starts no second run
    And the spawner is handed a pointer to the summary row reading "done: submit wired"
    And the harness looking up the key "login-form" sees the leg retired as having ended without a checkpoint

  @D292
  Scenario: an exit by signal is a cut, never sent back, and the next leg of the role is a recovery leg
    Given a `codex exec` worker started by the wrapper under the key "login-form", with checkpoint number 3 in effect, that inserted 25 rows and no checkpoint
    When the harness's timeout kills the worker with a signal
    Then the worker's registration reads cut, its 25 rows remain in its lane, and no summary row exists
    And the wrapper starts no second run
    And the harness looking up the key "login-form" receives checkpoint number 3 with the leg shown as cut
    And the next builder leg under the key "login-form" starts as a recovery leg

  @D292
  Scenario: a worker that exits on its own error is finished and gets the one send-back
    Given a `codex exec` worker started by the wrapper under the key "login-form", with the ticket naming the worker as its checkpointer and declaring that it has a way to write
    When the worker exits with code 1 and no checkpoint written
    Then the wrapper runs the worker once more with the reason naming the missing checkpoint under "login-form"

  @D295
  Scenario: a `claude -p` child with a ticket is registered as a worker by the hook, never as a self
    Given a ticket in the environment naming the parent "p1", the run "r1", the key "login-form" and the role "builder"
    When a `claude -p` process starts and its session-start hook fires
    Then the store holds a worker registration for it with the role "builder", the run "r1", the key "login-form" and the parent "p1", marked as the ticket door read by the hook
    And the store holds no self registration and no beacon for it
    And every row the child writes carries the writer "builder" and the parent "p1" as declared

  @D410 @D295
  Scenario: a `codex exec` worker with Codex's hooks is never registered as a self, its hooks print it nothing, and what it does lands in its own lane
    Given a `codex exec` worker at Codex CLI 0.167.0, with the hooks install wrote trusted, started by the wrapper under the key "login-form" with the role "builder"
    When its hooks receive, as Codex sends them, its start, a shell command it runs and the end of its turn
    Then the store holds no self registration for its Codex session and one first-moment row in the worker's lane
    And the shell command and the turn's last assistant message are in the worker's lane with the writer "builder"
    And none of its hooks printed anything to Codex, its first moment being the door's
    # Recorded live, 2026-11-09, Codex CLI 0.167.0: under `treecontext
    # run … -- codex exec`, every hook's environment held the ticket and
    # the worker's lane, the hooks running outside the sandbox (D410).
    # The fixture is the build's to take. A worker's hooks print nothing:
    # a Codex main's fresh start is handed the packet, a worker never.

  @D295 @D298
  Scenario: a `claude -p` child started by the wrapper is told who it is in one line, and its first moment is not spent twice
    Given a `claude -p` worker started by the wrapper under the key "login-form", with a brief and a checkpoint in effect
    When the child's session-start hook fires
    Then the context the hook emits is one line naming the worker's role, run, key and lane and its first-moment row by id, and saying no re-orientation packet follows
    And that line holds none of the brief's or the checkpoint's text, which the child already received as its prompt

  @D295
  Scenario: the stop hook's send-back is the leg's one, and the wrapper starts no run after it
    Given a `claude -p` worker started by the wrapper, naming itself as checkpointer, whose stop hook fires before its process exits
    When the worker stops with no checkpoint under the key "login-form"
    Then the stop hook sends it back once with the reason naming the missing checkpoint under "login-form"
    And when the process then exits with still no checkpoint, the wrapper starts no second run

  @D295
  Scenario: when the stop hook could not ask, the wrapper's send-back is the leg's one
    Given a `claude -p` worker started by the wrapper, naming itself as checkpointer, whose store refuses writes at the moment its stop hook fires
    When the worker stops with no checkpoint and its process exits with the store writable again
    Then the stop hook sent it back no time
    And the wrapper runs the worker once more with the reason naming the missing checkpoint under "login-form"

  @D294
  Scenario Outline: a parent no hook registered, a <main> main, is carried on each worker's registration as declared, never as a row of its own
    Given a <main> main session "c7" that never spoke to the store
    When it starts two workers through the `treecontext run` wrapper with `--parent c7` and `--parent-cli <cli>`, one from a checkout on the branch "main" and the other from a checkout on the branch "login"
    Then the store holds no registration for "c7" and no row in any lane with the writer or the session "c7"
    And each worker's registration carries the parent id "c7", the CLI "<cli>", and the directory, worktree and branch its own ticket declared, marked declared, with the ticket's mint moment
    And a reader grouping workers by declared parent sees both under "c7" with their two branches, unreconciled

    Examples:
      | main            | cli   |
      | Codex CLI       | codex |
      | Antigravity CLI | agy   |
    # Since D410 and D416 these rows are a Codex CLI or Antigravity CLI
    # main whose hooks do not run: below its floor, with its hooks
    # untrusted (Codex) or with no named hook (agy). A main whose hooks
    # run registers itself (journal-orchestration).

  @D294
  Scenario: a parent a hook did register is linked by id, never copied
    Given a Claude Code session "p1" registered by its session-start hook on the branch "login"
    When a worker starts with a ticket naming the parent "p1"
    Then the worker's registration links the parent by the id "p1"
    And the parent's branch is read from the parent's own registration, not stored again on the worker's

  @D293
  Scenario Outline: an unregistered writer's row through the <door> is accepted and traced, never refused
    Given a process the store never registered, that declares the role "builder" and the parent "c7" through the <door>
    When that process inserts the note "state: all tests pass"
    Then a reader of the row sees it stored, with when it was written, the directory, worktree and branch the door could read, the <door> as the door that wrote it, that its identity was declared by the writer and not registered by a hook, the writer stamp "builder", the declared parent "c7", and the note's text

    Examples:
      | door                                   |
      | ticket door, with a self-minted ticket |
      | library call                           |

  @D297
  Scenario Outline: a gone worker nobody retired is retired as a phantom by the next <reader> on its host
    Given a worker registration under the key "login-form" whose process on this host has exited, with nothing having retired it
    When the <reader> next reads the registry on this host
    Then the worker's registration reads retired as a phantom, with the moment it was noticed and the <reader> as what noticed it
    And the registration carries no guessed exit time, no checkpoint and no summary row

    Examples:
      | reader                      |
      | harness's lookup            |
      | status call                 |
      | session-start hook          |
      | ticket door                 |

  @D297
  Scenario: a worker on another host is left live and the reply says it cannot be checked from here
    Given a worker registration under the key "login-form" whose host is "build-02" and this host is "laptop"
    When the harness on "laptop" looks up the key "login-form"
    Then the worker's registration still reads live
    And the reply says the worker on "build-02" cannot be checked from here

  @D317
  Scenario: a reused process number is told from the worker by the process's start moment
    Given a worker registration under the key "login-form" carrying the process id 4242 and the start moment 09:14:02 on this host
    And a different process now holding the id 4242 that started at 11:30:45
    When the harness looks up the key "login-form"
    Then the worker's registration reads retired as a phantom

  @D317
  Scenario: a live worker with its own start moment stays live
    Given a worker registration under the key "login-form" carrying the process id 4242 and the start moment 09:14:02 on this host
    And the process 4242 that started at 09:14:02 still running
    When the harness looks up the key "login-form"
    Then the worker's registration still reads live

  @D317
  Scenario: a host whose process start moment cannot be read leaves the number alone, and the reply says so
    Given a worker registration under the key "login-form" carrying the process id 4242 and no start moment, on a host where the start moment could not be read
    And a process holding the id 4242
    When the harness looks up the key "login-form"
    Then the worker's registration still reads live
    And the reply says the worker cannot be told from a successor that took its number

  @D403
  Scenario Outline: a live worker is never retired as a phantom by a reader whose processes are numbered apart from its own, <case>
    Given a worker under the key "login-form", still running, started through the `treecontext run` wrapper <worker>
    When the harness <reader> looks up the key "login-form"
    Then the worker's registration still reads live

    Examples:
      | case                        | worker                                                       | reader                                                       |
      | the worker inside a sandbox | inside a sandbox on this host that numbers its own processes | on this host, outside the sandbox,                           |
      | the reader inside a sandbox | on this host, outside any sandbox,                           | inside a sandbox on this host that numbers its own processes |
      | the worker registered by an earlier build, the reader inside a sandbox | on this host, outside any sandbox, by a build that recorded no numbering, | inside a sandbox on this host that numbers its own processes |
      | the worker inside a sandbox that shows the machine's processes as its own | inside a sandbox on this host that numbers its own processes and still shows the machine's list of processes | on this host, outside the sandbox,                           |
    # Found live, 2026-11-09, on Linux: a `treecontext run` inside Codex
    # CLI's sandbox registered its worker with the number the sandbox gave
    # it (13) and the machine's real name; the next `treecontext run` from
    # a plain shell looked up process 13 in the machine's own numbering,
    # found an unrelated process with another start moment, and retired the
    # running worker as a phantom. The second row is the same mistake the
    # other way round: inside the sandbox the machine's processes are not
    # there at all, so a reader in it would take every running worker
    # outside for gone. A sandbox of this kind exists on Linux only; the
    # scenario is Linux's, and on a host that cannot make one (CI runners
    # that restrict unprivileged user namespaces) it shows as skipped or
    # wip, never green.
    # The fourth row, found by the review of 2026-11-09 and ruled in on
    # 2026-11-10: a sandbox can number its own processes and still show
    # the machine's list of them (bwrap without a process list of its
    # own, `unshare --pid` without `--mount-proc`). The door inside read
    # the start moment of whatever the machine had under the worker's
    # sandbox number, an unrelated process, and a reader outside then
    # retired the running worker as a phantom. A door that cannot read
    # its worker's start moment in its own numbering records none.

  @D403
  Scenario: a reader inside a sandbox says a worker outside it cannot be checked from there
    Given a worker under the key "login-form", still running, registered on this host outside any sandbox
    When the harness inside a sandbox on this host that numbers its own processes looks up the key "login-form"
    Then the reply says the worker runs where this reader cannot see its process, so it cannot be checked from here

  @D403
  Scenario: a worker whose sandbox has ended is retired as a phantom by a reader that can see the sandbox is gone
    Given a worker under the key "login-form" registered from inside a sandbox on this host that numbers its own processes
    And the sandbox has since ended with every process in it, nothing having retired the worker
    When the harness on this host, outside the sandbox, looks up the key "login-form"
    Then the worker's registration reads retired as a phantom, with the moment it was noticed and the harness's lookup as what noticed it
    # Resolved from the record (D403): a reader outside the sandbox can
    # see it, and without this a sandbox killed together with its door
    # leaves the worker live for good, which D307 relies on the phantom
    # pass to close.

  @D403
  Scenario Outline: a worker taken for a phantom while it ran is set right by its door when it <ends>
    Given a worker under the key "login-form", still running, started through the `treecontext run` wrapper of this build
    And a reader on this host has wrongly taken it for gone and retired it as a phantom
    When the worker <ends>
    Then the worker's registration reads <ending> at the moment it ended, no longer a phantom
    And it still shows when it was taken for a phantom and what took it for one
    And <summary>

    Examples:
      | ends                                    | ending  | summary                                     |
      | exits on its own after printing "done"  | retired | the worker's summary row holds "done"       |
      | is ended by a signal                    | cut     | the worker left no summary row              |
    # Found with the scenarios above: the door, at the worker's real exit,
    # wrote the summary row and then found the registration already ended,
    # so the store held a phantom with a summary row, a leg that both left
    # no trace and returned. The door saw the end; the pass guessed it.
    # Ruled 2026-11-10: the promise is this build's door's. A door of an
    # earlier build never corrects (run for real against the beta.3.1
    # and beta.4 doors, 2026-11-09), so a worker one of them started and
    # a reader took for gone, possible only while a sandboxed worker runs
    # across the upgrade, can stay a phantom beside its summary row. No
    # reader infers an ending from that row (D297).

  @D403 @D291
  Scenario: a worker taken for a phantom while it ran and then sent back reads live through its re-run
    Given a worker under the key "login-form", still running, started through the `treecontext run` wrapper of this build, that will exit without its checkpoint
    And a reader on this host has wrongly taken it for gone and retired it as a phantom
    When the worker exits and its door sends it back
    Then while the re-run runs, the worker's registration reads live
    And it still shows when it was taken for a phantom and what took it for one
    # Found by the review of 2026-11-09 and ruled in on 2026-11-10: the
    # send-back wrote its row and started the re-run while the
    # registration went on reading phantom, so a lookup called a running
    # worker gone until its final exit.

  @D403 @D342
  Scenario: a worker with a damaged ticket taken for a phantom while it ran is set right when its one row lands
    Given a worker whose ticket the door of this build could not read whole, still running
    And a reader on this host has wrongly taken it for gone and retired it as a phantom
    When the worker's one row lands
    Then the store records the leg as having ended with no valid instructions at the moment the row landed, no longer a phantom
    And it still shows when it was taken for a phantom and what took it for one
    # Ruled in on 2026-11-10: D403 names invalid among the endings a
    # phantom is set right to, and the outline above reaches only retired
    # and cut. An invalid ending is the worker's own row landing, not its
    # exit, so the correction comes at that row's moment.

  @D342 @D303
  Scenario Outline: a worker whose ticket is <damage> is registered with what was read, told its instructions were invalid, and ends visibly through the <door>
    Given a ticket in the environment, <damage>, so that the <door> cannot read it whole
    When the worker starts through the <door>
    Then the worker's registration sits in its own lane with every field the door could read, each unreadable field marked absent, and the raw ticket text kept
    And the store holds no self registration for it
    And the worker's first message says its instructions were invalid and asks it to write one row saying so and stop
    And the store records the leg as having ended with no valid instructions once the worker's one row lands
    And the spawner is told in the line it receives at the worker's exit that the worker ended with invalid instructions

    Examples:
      | damage                                                                  | door                                     |
      | truncated after the role "builder"                                      | door of a `codex exec` worker whose hooks do not run |
      | hand-edited so that the run is missing                                  | session-start hook of a `claude -p` child |
      | minted in an older shape that still reads as the role "reviewer"        | door of a `codex exec` worker whose hooks do not run |
      | truncated after the role "builder"                                      | session-start hook of a `claude -p` child |

  @D303
  Scenario: the ticket door that sees the fault before spawning writes the row itself and spawns nothing
    Given a spawner asking the ticket door to start a worker with a ticket truncated after the role "builder"
    When the ticket door checks the ticket before spawning
    Then the ticket door writes one row in the spawner's lane, with the spawner as its writer, saying the ticket was invalid and keeping the raw ticket text
    And no worker process is started

  @D307
  Scenario: a worker is not started while the store cannot be read, and the spawner is told
    Given a store locked by another process for longer than the busy wait
    When the ticket door is asked to start a builder worker under the key "login-form"
    Then the ticket door waits the busy wait and then starts no worker
    And the spawner is told in words that the store was unreachable and nothing was written
    And once the lock clears, the store holds no registration and no row for that worker

  @D298 @D302 @D307
  Scenario: a worker whose first-moment row the store cannot write is not registered and opens no run
    Given a brief row for the builder role naming the key "login-form", and a store that refuses the first-moment row at the moment the ticket door composes it
    When the ticket door is asked to start a builder worker under the key "login-form" on a run "r9" no leg has opened
    Then the ticket door starts no worker and the spawner is told in words that nothing was written
    And once the store takes writes again, it holds no registration for that worker, no first-moment row and no open row for "r9"

  @D307
  Scenario: a checkpoint the store cannot take at exit is lost from the store, not from the spawner
    Given a `codex exec` worker under the key "login-form", with checkpoint number 3 in effect, that prints its checkpoint as its last output
    And a store that refuses writes at the moment the worker exits
    When the worker exits
    Then the spawner is handed the worker's last output whole
    And the wrapper starts no second run
    And the harness next looking up the key "login-form" on this host receives checkpoint number 3, the earlier one in effect, with the leg retired as a phantom by that lookup

  @D329 @D298
  Scenario: a worker's first message carries both checkpoints when two are in effect
    Given checkpoint number 4 and checkpoint number 5 both in effect under the key "login-form", and a brief for the reviewer role naming the reviewer as the checkpointer
    When the ticket door starts a `codex exec` reviewer worker with the spawner's prompt "reconcile and continue"
    Then the worker's first message carries the brief, then number 4 and number 5 with a line saying two are in effect, then "reconcile and continue"
    And the first row of the worker's lane references the brief row and both checkpoint rows by id

  @D332
  Scenario: the ticket door's first message says in treecontext's own words that a checkpoint is state, not history
    Given a brief for the builder role under the key "login-form" that says nothing about checkpoints
    When the ticket door starts a `codex exec` builder worker
    Then the worker's first message says a checkpoint is the state of the work as it now stands, names what it supersedes and rests on, and never pastes the history in

  @D335 @D291
  Scenario: a worker's re-run for its missing checkpoint is the same leg in the same lane
    Given a `codex exec` worker, the process 4242 started at 09:14:02, started by the wrapper under the key "login-form", that exits with no checkpoint
    When the wrapper runs it once more as the process 4310 started at 09:20:05
    Then the store holds one registration for the leg, carrying both processes with their ids and start moments
    And the leg's lane holds one first-moment row, then the first run's rows, then a row with the second run's first message naming the missing checkpoint, then the second run's rows
    And a liveness check while the process 4310 runs reads the leg as live

  @D340 @D316
  Scenario: a ticket that says nothing about the door is read as declaring one
    Given a `codex exec` worker started by the wrapper under the key "login-form", naming itself as checkpointer, whose ticket says nothing about whether it can write
    When the worker exits with no checkpoint under the key "login-form"
    Then the wrapper runs the worker once more with the reason naming the missing checkpoint under "login-form"

  @D341
  Scenario: a ticket that says in words the worker has no key starts a one-off worker
    Given a ticket naming the parent "p1", the run "r1" and the role "explorer", and saying in words that the worker has no key
    When a `codex exec` worker starts with it, prints "src/login/Form.tsx" and exits with no checkpoint
    Then the worker's rows sit in its own lane with the writer "explorer" and the parent "p1"
    And the wrapper starts no second run
    And the harness looking up the run "r1" counts one keyless leg among the run's facts, with its summary row reading "src/login/Form.tsx"

  @D341 @D303
  Scenario: a ticket whose key is merely blank is damage
    Given a ticket naming the parent "p1", the run "r1" and the role "builder", with its key blank and no words saying the worker has no key
    When a `codex exec` worker starts with it
    Then the worker's first message says its instructions were invalid and asks it to write one row saying so and stop
    And the worker's registration keeps the raw ticket text with the key marked absent

  @D342
  Scenario: a worker whose ticket still named its run is listed under that run; one that named neither is reachable only by its exit line and parent
    Given a worker whose ticket named the parent "p1" and the run "r1" and lost its key, and another whose ticket named the parent "p1" and lost both run and key, each having written its one row and stopped
    When the harness looks up the run "r1"
    Then the harness sees the first worker under the run "r1" as having ended with no valid instructions
    And the second worker appears under no run, and a reader grouping workers by declared parent finds it under "p1" with its raw ticket text

  @D374 @D372
  Scenario: a worker of the ticket door searches the whole store and sees every lane
    Given a spawner in the main checkout holding its live chapter summary, and a worktree "subproject" holding its own
    And a worker the spawner launched through the ticket door with its brief and key
    When the worker searches through its tools and calls status
    Then its search covers the whole store, the reply saying a worker searches as its harness feeds it
    And its status lists both chapters flat, the block naming it a worker, never calling it unplaced

  @D384
  Scenario Outline: a worker that <ends> leaves a summary row that says why
    Given a `codex exec` worker with the role "builder" under the run "r1" and the key "login-form", whose ticket names the reviewer as the one who will checkpoint
    When the worker prints <output> to its output, writes "error: model gpt-x not found" to its error stream, and exits with code <code>
    Then the summary row the spawner's line points at reads <output>, then treecontext's line naming the exit code <code> and the end of its error stream, "error: model gpt-x not found"
    And the spawner received the error stream as the worker wrote it, and the output byte for byte

    Examples:
      | ends                                  | output       | code |
      | fails having printed nothing          | nothing      | 1    |
      | fails after printing part of its work | "half wired" | 2    |
      | exits cleanly having printed nothing  | nothing      | 0    |

  @D384
  Scenario: a long error stream is kept as its end
    Given a `codex exec` worker under the run "r1", whose ticket names the reviewer as the one who will checkpoint
    When the worker writes 50000 characters to its error stream, the last line "fatal: out of quota", and exits with code 1
    Then the summary row holds the last 2000 characters of the error stream, ending "fatal: out of quota", and says the earlier part was left out
    And the spawner received all 50000 characters

  @D384 @D292
  Scenario: a worker that failed, was run once more and failed again leaves its last run's reason
    Given a `codex exec` worker started by the wrapper under the key "login-form", naming itself as checkpointer
    When its first run writes "error: rate limited" to its error stream and exits with code 1, and its second run writes "error: auth expired" and exits with code 1, neither writing a checkpoint
    Then the summary row names the exit code 1 and "error: auth expired"

  @D389
  Scenario Outline: a worker started through the <spawner> from inside a Claude Code session carries none of that session's variables
    Given a spawner whose environment holds Claude Code's session variables CLAUDECODE, CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_CHILD_SESSION, CLAUDE_PID, CLAUDE_CODE_MESSAGING_TOKEN and CLAUDE_CODE_MESSAGING_SOCKET, and the settings CLAUDE_CONFIG_DIR and CLAUDE_CODE_USE_BEDROCK
    When the ticket door starts a `codex exec` worker through the <spawner>
    Then the worker's environment holds none of the six session variables
    And it holds CLAUDE_CONFIG_DIR and CLAUDE_CODE_USE_BEDROCK as the spawner had them
    And it holds the ticket and the worker's lane the door set

    Examples:
      | spawner                                        |
      | `treecontext run` wrapper                      |
      | library call, in the process's own environment |
      | library call, with an environment it passes    |

  @D391 @D288
  Scenario Outline: a <second> writing the same text as <first> leaves its own row in its own lane
    Given <first> that has inserted the note "login form: submit posts to /api/session"
    When a <second> inserts "login form: submit posts to /api/session" through its tools
    Then the store holds two rows of that text, one in each lane, each stamped with its own writer
    And the second insert's reply says its row landed, not that it was deduplicated

    Examples:
      | first                                 | second                     |
      | the main session in the main checkout | `codex exec` worker        |
      | a `codex exec` worker                 | second `codex exec` worker |

  @D393 @D292
  Scenario Outline: a worker ended by <signal> leaves no process of its group running
    Given a `codex exec` worker started by the wrapper under the key "login-form" that has started a long-running command in its own process group
    When <signal> ends the worker
    Then the worker's registration reads cut, with no summary row and no send-back
    And no process of the worker's process group is still running, the long-running command included
    # Linux and macOS only: on Windows only the direct child is ended
    # (D393), so the binding is a host skip there. The binding needs a
    # real grandchild in the worker's process group, a process the
    # stand-in worker starts and the test finds by the group's id
    # afterwards, never a simulated one. A process that left the group
    # (setsid, a detached spawn) is outside this promise (D394).

    Examples:
      | signal                                                    |
      | the wrapper's timeout                                     |
      | a kill the door did not send, sent to the worker's process |

  @D397 @D384
  Scenario: a background process the worker left writing to its error stream is not cut off when the run settles
    Given a `codex exec` worker started through the library call that starts a background process writing a line to its error stream every second, and then prints "done" and exits with code 0
    When the run has settled and the background process writes three more lines
    Then the spawner receives those three lines on its error stream
    And the background process is still running, not ended by SIGPIPE
    And the summary row the spawner's line points at reads "done"
    # The run still waits up to the 2 s drain for the stream's end before
    # it settles (D397). The binding needs a real background process the
    # stand-in worker starts, holding the worker's error stream, read by
    # the test after the run settled.

  # An `agy -p` worker with treecontext's named hook (D416, 2026-11-09,
  # beta.4): the ticket wins, as for a `claude -p` child (D295).

  @D416 @D295
  Scenario: an `agy -p` worker started by `treecontext run` is never a self, and its captured calls land in its own lane
    Given an `agy -p` worker started by the wrapper with a ticket naming the parent "p1", the run "r1", the key "login-form" and the role "builder", on an Antigravity CLI whose named hook install wrote
    When the worker's events, as Antigravity sends them, reach the hook install writes, the worker runs a shell command and inserts a note, and ingestion runs
    Then the store holds no self registration for the worker's conversation
    And the shell command's entry and the note sit in the worker's own lane, stamped with the writer "builder" and the parent session "p1"
    And the main lane holds none of the worker's rows
