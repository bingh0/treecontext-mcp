Feature: Other clients — a dated matrix and a doctor that knows each one

  Capture is promised only where it is verified live: Claude Code; Codex
  CLI from 0.167.0 with its hooks trusted; Antigravity CLI from 1.5.3
  with its named hook written. For every other client
  the documentation carries a compatibility matrix, each row
  documented-only with the date or release of the documentation it was
  checked against, never a test result it does not have. Doctor tells, for every documented client, which mode it has,
  reads the Claude settings file as-is or copies the hooks into its own
  configuration, the current state and whether it is correct, and the
  remediation.

  Rulings D152, D153, D161 of the hackathon interview, 2026-10-05 to
  2026-10-06; survey of official documentation 2026-10-05. D370 of the
  beta.3 final gate, 2026-11-01: the orchestration matrix, its own table.
  D383, D387, D388, D390 of 2026-11-07: Antigravity CLI as a tools-only
  client, the headless-readiness rows, the matrices' permission modes,
  and one tool-approval rule for the three clients. D399 of 2026-11-09:
  Gemini CLI retired as an archived platform, its rows gone and what an
  earlier install left for it named by doctor. D406, D407, D412, D413,
  D414 of 2026-11-09: Codex CLI captured from 0.167.0 through a block of
  its own, doctor reading Codex's own account of which hooks it trusts;
  Antigravity CLI captured from 1.5.3 through a named hook of its own;
  the documentation naming each minimum version.

  @D153 @D412
  Scenario: every matrix row carries its client, its events, its documentation date and one status
    Given the documentation's compatibility matrix
    When a developer reads it
    Then the developer sees every row name the client, the hook events it offers, the date or release of the documentation checked, and one status
    And the developer sees exactly three rows reading "verified live", Claude Code, Codex CLI from 0.167.0 and Antigravity CLI from 1.5.3, the rows for Codex CLI and Antigravity CLI each naming the client version and date of the recording it rests on

  @D370
  Scenario: the orchestration matrix is its own table, one cell per client and role, each with one status and its date
    Given the documentation's orchestration matrix
    When a developer reads it
    Then the developer sees a table apart from the compatibility matrix, one row each for Claude Code, Codex CLI and Antigravity CLI, and one column per orchestration role
    And the developer sees every cell carry one of "verified live", "verified through a stand-in", "documented only" or "not possible", with the date it was checked against
    And the developer sees every "not possible" cell name what the client lacks

  @D161 @D208 @D383 @D399 @D406 @D414
  Scenario Outline: doctor reports <client> as a client that <mode>
    Given <client> is installed and its hook configuration holds no treecontext hooks
    And the Claude Code hooks block is installed and VS Code's Claude-hooks setting is off
    When the developer runs doctor
    Then the developer sees doctor's row for <client> say the client <mode>
    And the row states the current installation state
    And the row names <remedy> as the remedy

    Examples:
      | client     | mode                                                            | remedy                        |
      | Codex CLI  | keeps its own hook configuration, where install writes Codex's own block from 0.167.0 | `treecontext install --agent codex` |
      | VS Code    | reads the Claude settings file when its Claude-hooks setting is on | turning that setting on    |
      | Cursor     | reads the Claude settings file by default                       | nothing                       |
      | OpenCode   | offers no shell hooks, so the tools are its whole surface       | nothing                       |
      | Antigravity CLI | keeps its own hook configuration, where install writes a named hook of its own beside the developer's from 1.5.3 | `treecontext install --agent agy` |

  @D161 @D407
  Scenario: Codex's block that matches reads present and consistent
    Given Codex CLI 0.167.0 is installed and its hook configuration holds the block this build writes for Codex, every hook of it trusted
    When the developer runs doctor
    Then the developer sees doctor's row for Codex CLI read present and consistent

  @D161 @D407
  Scenario: Codex's block that drifted reads inconsistent with its remedy
    Given Codex CLI 0.167.0 is installed and its hook configuration holds a block that differs from the one this build writes for Codex
    When the developer runs doctor
    Then the developer sees doctor's row for Codex CLI read present and inconsistent
    And the row names `treecontext install --agent codex` as the command that rewrites it

  @D407
  Scenario Outline: doctor's row for Codex CLI says whether Codex runs treecontext's hooks, when <state>
    Given Codex CLI is installed and <state>
    When the developer runs doctor
    Then the developer sees doctor's row for Codex CLI <say>
    And the row names <remedy> as the remedy
    And Codex's configuration and its record of trusted hooks are as they were before doctor ran

    Examples:
      | state                                                                                                         | say                                                                                                        | remedy                                                         |
      | install has written its block at 0.167.0 and Codex reports every hook of it trusted                           | read that Codex runs treecontext's hooks                                                                   | nothing                                                        |
      | install has written its block at 0.167.0 and Codex reports none of it trusted                                 | warn that Codex runs none of treecontext's hooks, naming each                                              | trusting them with `/hooks` in Codex                           |
      | install has written its block at 0.167.0 and Codex reports some of its hooks trusted and others not           | warn that Codex runs only some of treecontext's hooks, naming each it does not run                         | trusting them with `/hooks` in Codex                           |
      | Codex trusted the block and a hook of it has changed since                                                    | warn that Codex reports the changed hook modified since it was trusted and does not run it, naming it      | trusting them with `/hooks` in Codex                           |
      | Codex holds a trust record, at the place of a treecontext hook, that was given to a different hook            | warn that Codex reports each such treecontext hook modified since it was trusted and does not run it, naming each | trusting them with `/hooks` in Codex                     |
      | install has written its block at 0.167.0 and Codex's own account of its hooks cannot be read                  | say that the hooks are written and that doctor cannot tell whether Codex trusts them, never reading ok     | looking in `/hooks` in Codex                                   |
      | its version is 0.167.0 and no treecontext hook is written                                                     | warn that nothing of a Codex session is captured                                                           | `treecontext install --agent codex`                            |
      | its hooks file holds the verbatim copy of the Claude Code block an earlier build wrote under the experimental flag | warn that the hooks are an earlier build's copy of Claude Code's block, not Codex's own              | `treecontext install --agent codex`                            |
      | its version reads 0.166.0                                                                                     | say that Codex gets the tools only and that capture needs Codex CLI 0.167.0                                | upgrading Codex CLI to 0.167.0 or later                        |
      | its version reads 0.166.0 and its hooks file still holds the hooks an earlier install wrote                   | warn that treecontext's hooks are written for a Codex that gets the tools only                             | `treecontext install --agent codex`, which takes them back     |
      | its version cannot be read                                                                                    | say that Codex gets the tools only, its version not read                                                   | making `codex --version` answer, then `treecontext install --agent codex` |
      | its hooks file does not parse                                                                                 | warn, quoting the parse error, that doctor cannot read treecontext's hooks there                           | fixing the file by hand, never an install                      |
    # The far-side pass of 2026-11-09 found the failure this row exists
    # for: hooks written, untrusted, firing nothing, and nothing anywhere
    # saying so. Trust is Codex's record, never treecontext's to write,
    # and doctor reads it as Codex reports it, hook by hook, through
    # Codex's own app server (recorded 2026-11-09, Codex CLI 0.167.0): a
    # hook whose place holds a record given to another hook is reported
    # modified, and doctor says so in Codex's words, computing no hash.

  @D152 @D399
  Scenario: a teammate on another agent reads and writes through the tools
    Given a teammate on Antigravity CLI with the treecontext server configured and no hooks
    When the teammate inserts "ux: the login form uses the compact layout" and searches "compact layout"
    Then the teammate finds the entry
    And the documentation the teammate reads promises no capture of their session

  @D399
  Scenario: doctor names what an earlier install left for Gemini CLI, and the command it names removes that and nothing else
    Given install has wired Claude Code and Antigravity CLI, and Gemini CLI's settings hold the treecontext entry and the copied hooks an earlier install wrote beside the developer's own keys
    When the developer runs doctor, then the command its Gemini CLI row names, then doctor again
    Then the first doctor run shows no client row for Gemini CLI and one warning row saying Gemini CLI is retired, naming what is left and that command
    And after the command Gemini CLI's settings hold the developer's own keys and nothing of treecontext's
    And Claude Code's and Antigravity CLI's wiring is as install left it
    And the second doctor run shows no row for Gemini CLI

  # The headless build (D387, D388, D390, 2026-11-07): doctor says whether a
  # headless worker of each client can use the tools, and the documentation
  # says how to run one and under which permissions each cell was verified.

  @D387 @D381
  Scenario Outline: doctor's row for Codex CLI says whether a headless worker can use the tools, when its entry <state>
    Given Codex CLI is installed and its treecontext entry <state>
    When the developer runs doctor
    Then the developer sees doctor's row for Codex CLI <say>
    And the row names <remedy> as the remedy

    Examples:
      | state                                                                       | say                                                                                         | remedy                                         |
      | forwards the worker variables and approves the four tools                   | read that headless workers can use the tools                                                | nothing                                        |
      | lacks the worker variables                                                  | warn that a worker's rows would land in no lane                                             | `treecontext install --agent codex`            |
      | approves none of the four tools, with no choice of the developer's recorded | warn that a `codex exec` worker would be refused every treecontext call                     | `treecontext install --agent codex`            |
      | carries the developer's approval for treecontext_insert set to prompt       | warn that a `codex exec` worker would be refused treecontext_insert                         | the line in Codex's configuration that sets it |
      | carries the developer's default approving every tool                        | say in words that a headless worker can also clear, delete, import and merge, and not warn | nothing                                        |

  @D387 @D51
  Scenario: the command doctor's Codex row names makes its headless workers ready
    Given Codex CLI whose treecontext entry an earlier build wrote, without the worker variables or the four approvals
    When the developer runs the command doctor's row for Codex CLI names, and then doctor again
    Then the developer sees doctor's row for Codex CLI read that headless workers can use the tools

  @D387
  Scenario Outline: on Linux, doctor runs Codex's own sandbox check, which <result>
    Given a Linux machine with Codex CLI installed, whose sandbox check <result>
    When the developer runs doctor
    Then the developer sees doctor's row for Codex's sandbox <row>

    Examples:
      | result                                                       | row |
      | passes                                                       | read ok |
      | fails because the system refuses bubblewrap a user namespace | warn that a sandboxed Codex worker can read no file, name installing the bubblewrap package and an AppArmor profile that lets /usr/bin/bwrap create user namespaces, loaded with apparmor_parser, as steps for the developer to run, and say treecontext changes no system file |
      | fails for another reason                                     | warn with the check's own words |

  @D387
  Scenario: doctor shows no sandbox row where it does not apply
    Given a machine that is not Linux, or a Linux machine with no Codex CLI
    When the developer runs doctor
    Then the developer sees no row for Codex's sandbox

  @D387 @D383 @D414
  Scenario Outline: doctor's row for Antigravity CLI says whether a headless agy worker can use the tools, when <state>
    Given Antigravity CLI is installed and <state>
    When the developer runs doctor
    Then the developer sees doctor's row for Antigravity CLI <say>
    And the row names <remedy> as the remedy

    Examples:
      | state                                                   | say                                                                                                                                                   | remedy                               |
      | install has wired it and agy's permission preset is `always-proceed` | read that headless workers can use the four tools, name the preset, and say that under it every tool runs unasked | nothing |
      | install has wired it and agy's permission preset is `request-review` | read that headless workers can use the four tools, name the preset, and say that a worker needing any other tool may be refused it and return nothing unless the developer allows that tool | nothing |
      | install has wired it and agy's settings set no permission preset | read that headless workers can use the four tools, say that no preset is set, and that a worker needing any other tool may be refused it and return nothing unless the developer allows that tool | nothing |
      | agy's permission preset is a value doctor does not know | say that it does not know that preset, naming it, never guessing what it lets a worker do | nothing |
      | agy's settings file does not parse | say that it cannot read agy's permission preset, quoting the parse error, never guessing it | fixing the file by hand |
      | its MCP configuration holds no treecontext server       | warn that agy has no treecontext tools                                                                                                                | `treecontext install --agent agy`    |
      | the allow rule for treecontext_insert is missing        | warn that an `agy -p` worker would be refused treecontext_insert                                                                                      | `treecontext install --agent agy`    |
      | the developer's ask rule stands over treecontext_insert | warn that an `agy -p` worker would be refused treecontext_insert, naming the developer's rule and its file                                            | that rule, the developer's to change |

  @D390 @D387
  Scenario Outline: doctor's row for <client> shows tool approvals turned off as the developer's choice
    Given <client> wired by install, and tool approvals turned off with `treecontext config tool-approvals off`
    When the developer runs doctor
    Then the developer sees doctor's row for <client> say tool approvals are off by the developer's choice and that headless workers will be refused the four tools
    And the row does not count it as a failure
    And the row names `treecontext config tool-approvals on` as the remedy

    Examples:
      | client          |
      | Claude Code     |
      | Codex CLI       |
      | Antigravity CLI |

  @D388 @D370
  Scenario: a cell verified live says under which permissions its run was made
    Given the documentation's orchestration matrix
    When a developer reads the cells for Codex CLI and Antigravity CLI
    Then the developer sees every "verified live" cell name the permission mode its run was made in
    And the developer sees no such cell rest on a run made with a flag that bypasses the client's approvals or sandbox unless the cell says so

  @D388 @D414
  Scenario Outline: the README's headless-workers section carries the steps for <worker>
    Given the README's section on headless workers
    When a developer reads the part for <worker>
    Then the developer reads the `treecontext run` line that starts one, <shape>
    And the developer reads what install sets up for it and what is left to the developer: <left>
    And the developer reads which doctor row says whether it is ready

    Examples:
      | worker       | shape                                                                                                                                 | left                                                                                                                                                    |
      | `claude -p`  | with no `--allowedTools` for the four tools, and the warning that the flag takes several values and swallows a prompt that follows it | nothing                                                                                                                                                 |
      | `codex exec` | with the prompt on stdin                                                                                                              | on Linux, the sandbox steps doctor names                                                                                                                |
      | `agy -p`     | with `--message-arg`, since agy takes the prompt as its own value                                                                     | under any permission preset but `always-proceed`, allowing every tool beyond the four the worker needs, a shell command among them, or giving that one run the preset with agy's `--settings`, since agy may refuse it and the worker then returns nothing |

  @D388
  Scenario: the README says what a worker may do, that it skips orientation, and how a failed run reads
    Given the README's section on headless workers
    When a developer reads it
    Then the developer reads that a worker reads and writes the journal and never removes or brings in rows, its request to do so refused
    And the developer reads that a worker begins from its first message and runs no orientation
    And the developer reads that a failed or silent worker's summary row carries its exit code and the end of its error stream
    And the developer reads how to turn tool approvals off and on again
    And the developer reads a short dispatcher example for Claude Code to copy, and that treecontext installs no skill for it

  @D412 @D410
  Scenario: the README says from which Codex CLI capture runs, the step install leaves, and what a Codex entry does not hold
    Given the README
    When a developer reads its parts on Codex CLI
    Then the developer reads 0.167.0 as the minimum Codex CLI for capture, and that below it Codex gets the tools only
    And the developer reads that Codex runs treecontext's hooks only once they are trusted with `/hooks` in Codex, and that doctor says which are
    And the developer reads that a Codex shell command's entry holds the text Codex returned and no exit code
    And the developer reads that a Codex subagent is kept as a summary and is no leg
    And the developer reads that a Codex main is re-oriented at a fresh start and on a resume and gets no bookmark ask, and that an Antigravity CLI agent receives no re-orientation packet
    And the developer reads that a manual Codex compaction leaves a recovery note, an automatic one being unrecorded, and that a call Codex reported no result for, or a turn the developer interrupted, is kept and says so

  @D412 @D370
  Scenario: the orchestration matrix's Codex CLI cells say what a Codex hook can and cannot do
    Given the documentation's orchestration matrix
    When a developer reads the row for Codex CLI
    Then the developer sees the cell for a main that registers itself read "verified live" with the Codex version and date of the run
    And the developer sees the cell for a worker's own tool calls read "verified live" with the date of the live run of a ticketed Codex worker it rests on
    And the developer sees the cells for subagent legs and for the pointer read "not possible", naming the spawn message a hook cannot read

  # Antigravity CLI's hooks (D413, D414, D418, 2026-11-09, beta.4):
  # doctor reads agy's hooks from agy's own files, and a hooks file agy
  # cannot parse is named for what it costs, the developer's own hooks
  # silenced with treecontext's.

  @D414
  Scenario Outline: doctor's row for Antigravity CLI says what it found of agy's hooks, when <state>
    Given Antigravity CLI is installed and <state>
    When the developer runs doctor
    Then the developer sees doctor's row for Antigravity CLI <say>
    And the row names <remedy> as the remedy

    Examples:
      | state                                                                              | say                                                                                                       | remedy                                                |
      | its version reads 1.5.3 and its hooks file holds the named hook this build writes  | read that treecontext's hooks are present and current, and the server's mode as correct                   | nothing                                               |
      | its version reads 1.5.3 and its hooks file holds no treecontext hook               | warn that nothing of agy's sessions is captured                                                           | `treecontext install --agent agy`                     |
      | its hooks file holds the named hook an earlier build wrote, wired for fewer events | warn that the hook is an earlier build's, naming the events it lacks                                      | `treecontext install --agent agy`                     |
      | its version reads 1.5.2                                                            | read that agy is tools-only, naming 1.5.2 and 1.5.3 as the first version whose hooks install writes       | upgrading agy, then `treecontext install --agent agy` |
      | its version cannot be read                                                         | read that agy is tools-only, its version not read                                                         | upgrading agy, then `treecontext install --agent agy` |
      | its hooks file holds the named hook this build writes, switched off with `enabled: false` | say that capture is switched off there by the developer's choice, nothing of agy's sessions captured | turning it on, the developer's to do                   |
      | its hooks file holds a hook of the developer's named treecontext                   | warn that the name is taken by a hook install did not write, so nothing of agy's sessions is captured     | renaming that hook, the developer's to do              |
      | its version reads 1.6.0 and its hooks file holds the named hook this build writes  | read that treecontext's hooks are present, naming 1.6.0 beside 1.5.3, the version whose transcript capture reads | nothing                                         |
      | its hooks file does not parse                                                      | warn, quoting the parse error, that agy runs none of the hooks in that file, the developer's own included | fixing the file by hand, never an install             |

  @D414 @D384
  Scenario: the README and doctor say when a headless agy worker returns nothing because agy refused it a tool
    Given an `agy -p` worker, as Antigravity sends its events, under agy's default with no permission preset set, that reaches for a shell command no rule of agy's allows
    When the worker's run through `treecontext run` ends
    Then agy has fired no event after the refusal, and the worker printed nothing and exited with code 0
    And the worker's summary row carries agy's own line from its error stream
    And the developer reads, in the README's part for `agy -p` and in doctor's row for Antigravity CLI, which permission preset agy has, that under `always-proceed` every tool runs unasked, and that under any other a worker needing a tool beyond the four may be refused it and return nothing unless that tool is allowed or the run is given the preset
    # Found on the far-side pass of 2026-11-09 (agy 1.5.3), under agy's
    # default before `toolPermission` was set: a call headless agy could
    # not ask permission for was refused, and the turn ended with no
    # reply, no PostToolUse and no Stop. Under `always-proceed`, recorded
    # the same day, every shell command ran unasked (D414).

  @D413 @D418 @D388
  Scenario: the README names the oldest Antigravity CLI whose hooks install writes, and what its capture leaves out
    Given the README's install section, its compatibility matrix and its orchestration matrix
    When a developer reads the parts for Antigravity CLI
    Then the developer reads 1.5.3 as the first Antigravity CLI version whose hooks install writes, and that an older one stays tools-only
    And the developer reads which of agy's events install wires and that it never wires PreToolUse, with the reason
    And the developer reads that a call agy refuses in a headless run, under any permission preset but `always-proceed`, leaves no entry, that agy states no outcome for a shell command, and that a subagent is kept as a helper of the session that started it, its report kept, and is no leg
    And the developer reads every Antigravity CLI cell of the orchestration matrix with the agy version and date it was checked against
