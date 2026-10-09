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
  2026-10-06; survey of official documentation 2026-10-05.

  @D153
  Scenario: every matrix row carries its client, its events, its documentation date and one status
    Given the documentation's compatibility matrix
    When a developer reads it
    Then the developer sees every row name the client, the hook events it offers, the date or release of the documentation checked, and one status
    And the developer sees exactly one row reading "verified live", Claude Code

  @D161 @D208
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
