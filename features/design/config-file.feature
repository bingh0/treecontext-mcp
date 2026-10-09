Feature: The TOML config file — discovery, tolerance, and preservation

  One loader, four sources, first match wins: an explicit --config path,
  $TREECONTEXT_CONFIG, ./treecontext.toml in the project directory, then
  ~/.treecontext/config.toml. The tolerances are deliberate and
  asymmetric by intent: a file the user NAMED must exist (--config errors
  on a missing path or a missing value), while a file discovery merely
  looked for may be absent. Values are type-gated — a wrongly-typed key
  is dropped, never fatal — but a file that does not parse at all fails
  serve loudly: an operator who asked for that configuration deserves
  the error. The two exceptions are the commands that cannot afford it:
  hook (never non-zero, dispatches before any config load) and doctor,
  which exists to diagnose exactly this file and must not die on it.

  install treats the file as the user's: an explicit capture value —
  true or false — is never flipped, a skipped file is preserved
  byte-for-byte with its comments, and a corrupt file is side-filed to
  config.toml.corrupt before the fresh template replaces it.

  Scenario: the environment config is used when it exists
    Given a config file named by the environment variable
    When configuration loads without an explicit path
    Then the environment file's values are the ones loaded

  Scenario: a set-but-missing environment config is skipped, not fatal
    Given an environment variable naming a missing file and a project config that exists
    When configuration loads without an explicit path
    Then discovery falls through to the project file
    # Asymmetric with --config on purpose: an explicit flag names one
    # file and errors when it is absent; the env var participates in
    # discovery, where absence just means "next source".

  Scenario: discovery prefers environment over project over global
    Given distinct config files at the environment, project, and global locations
    When configuration loads without an explicit path
    Then the environment file wins
    When the environment variable is cleared and configuration loads again
    Then the project file wins
    When the project file is removed and configuration loads again
    Then the global file wins

  Scenario: a wrongly-typed value is dropped, never fatal
    Given a config file whose keys carry the wrong types beside one valid key
    When configuration loads from that file
    Then the mistyped keys are absent from the result
    And the valid key survives

  Scenario: a config flag with no path is a parse error
    Given a command line ending in the config flag
    When the arguments are parsed
    Then parsing fails and names the flag
    # It used to fall back to auto-discovery silently — the one flag
    # whose whole job is naming a file loaded a different file without
    # saying so.

  Scenario: install leaves an explicit capture=false alone
    Given a global config that sets capture to false with a comment beside it
    When install writes the global config
    Then the file is skipped and its bytes survive comment and all

  Scenario: install adds capture only when it is missing
    Given a global config with other server keys but no capture value
    When install writes the global config
    Then capture is added as true
    And the other keys keep their values

  Scenario: install side-files a corrupt config before replacing it
    Given a global config holding unparseable bytes
    When install writes the global config
    Then the original bytes survive in a corrupt side-file
    And the fresh template enables capture

  Scenario: an out-of-range value is dropped like a mistyped one
    Given a config file whose shield threshold is negative
    When configuration loads from that file
    Then the threshold is absent from the result
    # Same rule the CLI flag enforces at parse. Before this pin a
    # negative threshold slid through and "bytes <= -1" shielded every
    # response, replacing 10-byte results with file references.

  Scenario: a corrupt config file does not block doctor
    Given a home whose global config file is unparseable
    When doctor runs
    Then doctor completes its report
    # doctor is the fix channel for exactly this file; before this pin
    # it died at config load with the parse error as its only output.

  Scenario: a corrupt config file does not block install
    Given a home whose global config file is unparseable
    When install runs for the reference agent
    Then install completes
    And the original bytes survive in a corrupt side-file
    And the fresh template enables capture
    # install CONTAINS the purpose-built repair for this file — the
    # side-file-and-replace above — and used to die at config load
    # before reaching it. Same defect shape as doctor's, same fix.

  Scenario: serve still refuses a corrupt config loudly
    Given a home whose global config file is unparseable
    When serve runs
    Then it exits with an error
