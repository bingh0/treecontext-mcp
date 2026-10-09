Feature: C4 read side — query hits return the preview plus an availability marker

  Query hits return full decoded content (AC2d). Post-C4 that would let a
  single tool-event hit flood the agent's context with up to 256KB. Owner
  decision D1: hits on bounded rows return the display cut plus an
  explicit marker; the full text stays one treecontext_export away. The
  marker is presentation-only — never stored, never indexed. Since the
  index-cap expansion the display cut is _preview_len when present
  (schema 18 split), falling back to _index_len for rows captured before
  it — the single-boundary shape this suite pins.
  Since program G (store-as-arbiter §4, 2026-08-13) the boundary
  COLUMNS are the read-side truth, maintained at the one place nodes
  are written — so the rewriter-safety story simplifies to its final
  form: content and its boundary columns move together, in the same
  transaction, by construction. The metadata copies are NOT mere
  annotation: they are the served form AND the interchange form —
  export, archive, and merge carry them, and an import rebuilds the
  columns from them — so every writer maintains both, and a rewriter
  that alters a boundary without owning the content it bounds violates
  this suite.
  Footguns: JF-2, JF-9.

  Scenario: a full-fidelity hit returns the preview and advertises the rest
    Given an ingested C4 tool event whose full tail exceeds its preview
    When a query matches it
    Then the hit's content is the index view followed by the availability marker
    And the marker names the full content length

  Scenario: export returns the raw full content the marker advertises
    Given a full-fidelity tool-event node
    When it is exported by node id
    Then the exported content is the complete preview plus tail with no marker

  Scenario: the marker text is not findable
    Given a full-fidelity tool-event node returned by an earlier query
    When a query is made for distinctive words from the marker text
    Then the node does not match, pinning that the marker never enters storage or the index

  Scenario: the full tail never leaks through a conversation window
    Given a full-fidelity tool event adjacent to a query hit in the same session
    When the hit is returned with a conversation window
    Then the neighbor entry's text is based on the index view before the window cap applies

  Scenario: rows without the boundary marker are returned whole, as today
    Given a curated note and a legacy preview-only tool event
    When queries match them
    Then both hits return their full decoded content with no marker

  Scenario: a demoted full-fidelity row advertises its archived tail and stays preview-findable
    Given a full-fidelity tool event demoted by the store-byte sweep
    When a query matches its preview text
    Then the hit returns the demoted preview with a marker naming the archived tail
    And preview findability is unchanged and the full event is recoverable from the demotion archive
    # Ruled 2026-07-31 (archive-before-shrink): demotion is no longer
    # silent. The sweep archives the full row before shrinking and stamps
    # _full_len + _archive_path, so the hit advertises the loss instead of
    # presenting the stump as whole.

  Scenario: supersede and demotion metadata rewrites never ghost the contentless index
    Given a full-fidelity tool event whose metadata is later rewritten by supersede and then demotion
    When the node is deleted
    Then the FTS index holds no ghost entry for it
    And the delete-time recompute sliced at the surviving _index_len matched the indexed text exactly
