Feature: Other clients — a dated matrix and a doctor that knows each one

  Capture is promised only where it is verified live, Claude Code alone
  today. For every other client the documentation carries a compatibility
  matrix, each row documented-only with the date or release of the
  documentation it was checked against, never a test result it does not
  have. Doctor tells, for every documented client, which mode it has,
  reads the Claude settings file as-is or copies the hooks into its own
  configuration, the current state and whether it is correct, and the
  remediation.

  Rulings D152, D153, D161 of the hackathon interview, 2026-10-05 to
  2026-10-06; survey of official documentation 2026-10-05. D370 of the
  beta.3 final gate, 2026-11-01: the orchestration matrix, its own table.
  D383, D387, D388, D390 of 2026-11-07: Antigravity CLI as a tools-only
  client, the headless-readiness rows, the matrices' permission modes,
  and one tool-approval rule for the three clients.

  @D153
  Scenario: every matrix row carries its client, its events, its documentation date and one status
    Given the documentation's compatibility matrix
    When a developer reads it
    Then the developer sees every row name the client, the hook events it offers, the date or release of the documentation checked, and one status
    And the developer sees exactly one row reading "verified live", Claude Code

  @D370
  Scenario: the orchestration matrix is its own table, one cell per client and role, each with one status and its date
    Given the documentation's orchestration matrix
    When a developer reads it
    Then the developer sees a table apart from the compatibility matrix, one row each for Claude Code, Codex CLI and Antigravity CLI, and one column per orchestration role
    And the developer sees every cell carry one of "verified live", "verified through a stand-in", "documented only" or "not possible", with the date it was checked against
    And the developer sees every "not possible" cell name what the client lacks

  @D161 @D208 @D383
  Scenario Outline: doctor reports <client> as a client that <mode>
    Given <client> is installed and its hook configuration holds no treecontext hooks
    And the Claude Code hooks block is installed and VS Code's Claude-hooks setting is off
    And the installer ran without the experimental flag
    When the developer runs doctor
    Then the developer sees doctor's row for <client> say the client <mode>
    And the row states the current installation state
    And the row names <remedy> as the remedy

    Examples:
      | client     | mode                                                            | remedy                        |
      | Codex CLI  | copies the hooks into its own configuration                     | the flagged command that copies them |
      | Gemini CLI | copies the hooks into its own translated configuration          | the flagged command that copies them |
      | VS Code    | reads the Claude settings file when its Claude-hooks setting is on | turning that setting on    |
      | Cursor     | reads the Claude settings file by default                       | nothing                       |
      | OpenCode   | offers no shell hooks, so the tools are its whole surface       | nothing                       |
      | Antigravity CLI | keeps its own hook configuration, which install leaves alone, so the tools are its whole surface | nothing |

  @D161
  Scenario: a copied configuration that matches reads present and consistent
    Given Codex CLI is installed and its hook configuration holds a copy identical to the Claude Code block
    When the developer runs doctor
    Then the developer sees doctor's row for Codex CLI read present and consistent

  @D161
  Scenario: a copied configuration that drifted reads inconsistent with its remedy
    Given Codex CLI is installed and its hook configuration holds a copy that differs from the Claude Code block
    When the developer runs doctor
    Then the developer sees doctor's row for Codex CLI read present and inconsistent
    And the row names the command that rewrites the copy

  @D161
  Scenario: a translated Gemini copy that matches reads present and consistent
    Given Gemini CLI is installed and its hook configuration holds the translated copy of the Claude Code block
    When the developer runs doctor
    Then the developer sees doctor's row for Gemini CLI read present and consistent

  @D161
  Scenario: a translated Gemini copy that drifted reads inconsistent with its remedy
    Given Gemini CLI is installed and its hook configuration holds a translated copy that differs from the Claude Code block
    When the developer runs doctor
    Then the developer sees doctor's row for Gemini CLI read present and inconsistent
    And the row names the command that rewrites the copy

  @D208
  Scenario: without the experimental flag a copying client gets tools only
    Given Codex CLI is installed
    When the developer runs the installer without the experimental flag
    Then the developer sees Codex CLI wired for the tools and no capture hooks copied
    And the developer running doctor sees the Codex CLI row name the flagged command as the way to copy them

  @D152
  Scenario: a teammate on another agent reads and writes through the tools
    Given a teammate on Gemini CLI with the treecontext server configured and no hooks
    When the teammate inserts "ux: the login form uses the compact layout" and searches "compact layout"
    Then the teammate finds the entry
    And the documentation the teammate reads promises no capture of their session

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

  @D387 @D383
  Scenario Outline: doctor's row for Antigravity CLI says whether a headless agy worker can use the tools, when <state>
    Given Antigravity CLI is installed and <state>
    When the developer runs doctor
    Then the developer sees doctor's row for Antigravity CLI <say>
    And the row names <remedy> as the remedy

    Examples:
      | state                                                   | say                                                                                                        | remedy                               |
      | install has wired it                                    | read that the tools are its whole surface and headless workers can use the four tools                    | nothing                              |
      | its MCP configuration holds no treecontext server       | warn that agy has no treecontext tools                                                                     | `treecontext install --agent agy`    |
      | the allow rule for treecontext_insert is missing        | warn that an `agy -p` worker would be refused treecontext_insert                                           | `treecontext install --agent agy`    |
      | the developer's ask rule stands over treecontext_insert | warn that an `agy -p` worker would be refused treecontext_insert, naming the developer's rule and its file | that rule, the developer's to change |

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

  @D388
  Scenario Outline: the README's headless-workers section carries the steps for <worker>
    Given the README's section on headless workers
    When a developer reads the part for <worker>
    Then the developer reads the `treecontext run` line that starts one, <shape>
    And the developer reads what install sets up for it and what is left to the developer: <left>
    And the developer reads which doctor row says whether it is ready

    Examples:
      | worker       | shape                                                                                                                                 | left                                     |
      | `claude -p`  | with no `--allowedTools` for the four tools, and the warning that the flag takes several values and swallows a prompt that follows it | nothing                                  |
      | `codex exec` | with the prompt on stdin                                                                                                              | on Linux, the sandbox steps doctor names |
      | `agy -p`     | with `--message-arg`, since agy takes the prompt as its own value                                                                     | nothing                                  |

  @D388
  Scenario: the README says what a worker may do, that it skips orientation, and how a failed run reads
    Given the README's section on headless workers
    When a developer reads it
    Then the developer reads that a worker reads and writes the journal and never removes or brings in rows, its request to do so refused
    And the developer reads that a worker begins from its first message and runs no orientation
    And the developer reads that a failed or silent worker's summary row carries its exit code and the end of its error stream
    And the developer reads how to turn tool approvals off and on again
    And the developer reads a short dispatcher example for Claude Code to copy, and that treecontext installs no skill for it
