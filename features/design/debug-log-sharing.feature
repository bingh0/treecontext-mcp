Feature: Debug logs are shareable — redact at the surface, keep fidelity at rest

  The debug logs exist to be pasted into public issues: README §9 says
  so, doctor's fix rows say so, and the wrapper discards hook stderr so
  the log file is often the only diagnostic that survives. That makes
  the PRINTING surfaces — doctor --dump-logs and doctor's crash
  excerpt — sharing surfaces, and the ruling (2026-08-15) puts the
  redaction there: the home directory, which is the username on most
  machines, becomes `~` as it prints. The files on disk keep full
  fidelity inside the 0700 logs directory — an operator reading their
  own logs sees real paths; redaction that rewrote the record would
  cost the diagnosis its accuracy to protect a file nobody else can
  read anyway.

  The deeper discipline is what never reaches the logs at all: names,
  paths, byte counts, and tool tags — never message bodies. A prompt or
  a tool result is journal content; the log channel carries plumbing.

  Scenario: dumped logs replace the home directory as they print
    Given a debug log recording an absolute path inside home
    When the logs are dumped for sharing
    Then the printed output spells that path with a tilde
    And the home directory appears nowhere in it

  Scenario: the file on disk keeps full fidelity
    Given a debug log recording an absolute path inside home
    When the logs are dumped for sharing
    Then the log file on disk still holds the real path
    # Redaction happens at print, never by rewriting the record.

  Scenario: doctor's crash excerpt is redacted
    Given a fatal log line naming a path inside home
    When doctor reports recent crashes
    Then the excerpt spells that path with a tilde
    # The excerpt lands in DEFAULT doctor output — the other surface
    # users paste into issues — not behind the dump flag.

  Scenario: doctor with dump-logs is additive
    Given a home with a recorded debug log
    When doctor runs with the dump flag
    Then the output holds both the diagnosis and the log dump
    # 0.0.x regression: --dump-logs used to REPLACE the diagnosis, so
    # the flag meant for reporting a bug stripped out the only part
    # that diagnoses one (CHANGELOG). Pinned so it cannot come back.

  Scenario: captured prompts never reach the debug logs
    Given a prompt holding a distinctive sentence is captured by the hook
    When every debug log is read
    Then the sentence appears nowhere in them
    And the logs still show the hook did its work
