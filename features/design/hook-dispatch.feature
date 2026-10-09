Feature: Hook dispatch never exits non-zero

  A hook's exit code is agent-facing: the host surfaces a non-zero hook
  as an error in the user's session, so a hook that fails its own
  plumbing punishes the user for a capture problem they cannot see.
  The ruling (2026-08-15): from the moment the CLI is invoked with
  `hook`, nothing exits non-zero — junk arguments, a corrupt config
  file, an unknown event, a module that fails to load. The hook command
  consumes no configuration, so it dispatches before any TOML is read.
  Capture may be lost for a reason, never for a formality: the reason
  lands in the debug log, the one channel that survives the wrapper's
  stderr discard.

  Scenario: an unknown event exits zero and logs its name
    Given a sandboxed home
    When the hook command runs with an event no dispatcher knows
    Then the hook exits zero
    And the debug log records the unknown event by name
    # A platform can add hook events faster than this package ships
    # dispatch arms; the old default vanished without a trace, so a
    # misregistered event was indistinguishable from a healthy one.

  Scenario: a corrupt config file cannot break a hook
    Given a sandboxed home whose global config file is unparseable
    When a known hook event runs with empty input
    Then the hook exits zero
    # serve still fails loudly on the same file — an operator asked for
    # that configuration and deserves the error. The hook asked for
    # nothing: it reads no TOML, so a config typo must not cost capture
    # its exit code across every session on the machine.

  Scenario: junk in place of the event still exits zero
    Given a sandboxed home
    When the hook command runs with a flag where the event belongs
    Then the hook exits zero

  Scenario: a known event with unparseable input exits zero
    Given a sandboxed home
    When a known hook event runs with junk on stdin
    Then the hook exits zero

  Scenario: a hook is named by its first token
    Given a sandboxed home
    When the CLI runs with a flag before the hook token
    Then it is refused as an ordinary command-line error
    # One spelling, one ring (F review 2026-08-15): the installed
    # wrappers always emit `hook <event>` first, and defining that as
    # THE hook invocation puts the whole never-non-zero guarantee in
    # front of the argument parser. A flag-first spelling used to route
    # through parseArgs — whose errors exit 1 — via a second
    # hand-copied dispatch block; now it is simply not a hook.
