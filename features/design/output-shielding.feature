Feature: Output shielding under full lockdown

  Shielding trades an oversize tool response for a file reference: the
  full output is written to disk and the agent receives a compact
  pointer with the absolute path, the byte count, and a hint. The 2026-
  08-15 lockdown ruling sets the trust posture: shielded files hold
  verbatim journal content — as sensitive as the store itself — so they
  live under ~/.treecontext/shield inside the operator's 0700 umbrella,
  never in the shared world-readable tmpdir, with the store's own modes
  (0700 directory, 0600 files — pinned POSIX-side below the scenarios).

  The sweep runs at stdio shutdown, deletes only filenames this module
  mints, and only while shielding is enabled: --shield-dir is
  unvalidated user input, and an age sweep of an arbitrary directory is
  a file reaper pointed wherever the config says. Off by default
  (threshold 0); the alwaysShield/neverShield sets are library-level
  configuration with no CLI or TOML surface — stated, not accidental.

  Scenario: an oversize query response is replaced by a file reference
    Given a served journal with shielding at a small threshold
    And an entry large enough to cross it
    When the journal is queried for that entry
    Then the response is a reference naming the file, the bytes, and the tool
    And the file holds the full response verbatim

  Scenario: the file lands under the operator's own roof by default
    Given a served journal with shielding enabled and no shield directory configured
    When an oversize query response is shielded
    Then the file's path is inside the home treecontext shield directory

  Scenario: status is never shielded
    Given a served journal whose shield threshold is a single byte
    When status is asked for
    Then the full status report comes back inline
    # Unshieldable by construction: status is the orientation surface —
    # a session that must open a file to learn where its journal lives
    # has lost the thing status exists to provide.

  Scenario: output exactly at the threshold stays inline
    Given a shield threshold equal to the response's byte count
    When the response is considered for shielding
    Then it passes through unshielded
    # The contract is "exceeds", not "reaches" — pinned because the
    # boundary byte is where off-by-one rewrites silently change what
    # agents see.

  Scenario: a write failure returns the response inline
    Given a shield directory that cannot be created
    When an oversize response is considered for shielding
    Then the full response comes back inline
    # The successful result already exists in memory; turning a disk
    # problem into a tool error would throw the results away (S6). The
    # reason lands in the debug log.

  Scenario: an oversize export is shielded the same way
    Given a served journal with shielding at a small threshold
    And an entry large enough to cross it
    When the whole journal is exported, its secrets warning acknowledged
    Then the response is a reference and the file holds the full export

  Scenario: the shutdown sweep deletes only expired files this module minted
    # Bound through a real stdio server: the sweep hangs off stdin-end
    # shutdown (audit run 1 — the preamble contract had no scenario).
    Given a served stdio journal whose shield directory holds an aged minted file, a young minted file, and an aged foreign one
    When the server shuts down cleanly
    Then only the aged minted file is gone and the young and foreign files survive
