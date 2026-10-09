Feature: Journal policy tiers — the tool surface matches the trust level

  One store, three trust levels. A full agent curates and destroys; a
  contributor adds but never removes; a reader only looks. The policy is
  enforced at the tool surface — a tier's excluded tools are not refused,
  they are absent, so an agent cannot be talked into calling what its
  tier does not grant.

  @D50
  Scenario: a read-only server exposes only the reading tools
    Given a server configured with the read_only policy
    When it starts and registers its tool surface
    Then query, status, and export are the only tools registered
    And captured events are not ingested into the journal
    # Read-only means read-only on both faces: no tool mutates, and the
    # ingestion loop does not run — a reader pointed at a store must not
    # quietly become one of its writers.

  @D50
  Scenario: a contributor can add but never remove
    Given a server configured with the contributor policy
    When it starts and registers its tool surface
    Then insert is registered alongside the reading tools
    But delete, clear, import, and merge are absent

  @D50
  Scenario: a contributor's insert is a real write, not just a listed tool
    Given a live store served under the contributor policy
    When the contributor inserts a finding through the tool surface
    Then the entry is in the store for every other reader
    # The registration scenarios above pin the tool LIST per tier; this
    # one pins that the granted write face functions — a contributor's
    # finding lands in the shared store, visible to a library reader
    # holding its own handle on the same file.

  @D50
  Scenario: a contributor server ingests captured events
    Given a server configured with the contributor policy and capture requested
    When a captured event is staged
    Then the event drains into the journal
    # Capture is a write face. read_only refuses it on both faces (the
    # first scenario); contributor — whose grant is precisely "add" —
    # takes it: the drain writes only new nodes, exactly the insert
    # permission the tier already holds.

  @D82
  Scenario: reliance bookkeeping is a full-trust write a contributor export never makes
    Given a store holding an entry that later sessions fetch by id
    When a contributor server exports the entry twice
    Then the row carries no reliance count
    But the same two fetches through a full server stamp it
    # recordReliance is gated to full (third-pass review): read_only's
    # contract is "never mutates", and contributor may only ADD — the
    # reliance counter rewrites an existing row's metadata. The cost is
    # deliberate and worth naming: a store served exclusively to
    # sub-agent tiers accumulates no reliance signal, so the eviction
    # ordering journal-storage owns falls back to its oldest-first
    # baseline.

  @D50
  Scenario: merging between namespaces requires full trust
    Given servers configured with each policy tier in turn
    When each starts and registers its tool surface
    Then merge_from_agent is registered only under the full policy
    # Merging rewrites the trunk's contents from a branch — the most
    # consequential write the surface offers earns the highest bar.
