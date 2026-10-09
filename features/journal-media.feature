Feature: Journal media — a description that searches, a link that points

  The journal is a text store; media stays where it lives. An attachment
  is journaled as a written description plus a URI reference — the
  description is the searchable surface, the URI is the pointer, and the
  bytes are never copied in. This is the whole media story by design: no
  thumbnailing, no transcoding, no embedding of pixels.

  A media entry is an EVENT, not an asset (ruled 2026-07-23): the journal
  records "this attachment was seen and described here", it manages no
  blobs. Each entry carries exactly one reference; several attachments
  are several entries; the same file seen twice is two events; a new
  version of a file is a new event, and the old entry stays the honest
  capture-time record. Drift detection is a convention, not a mechanism:
  put a content hash in the extracted metadata and it rides along
  verbatim.

  Charter detail (i): stored descriptions with URI links to pdf, image,
  video, and audio content.

  History: from 2026-07-19 to 2026-07-23 the lexical backend accepted a
  media reference at insert and silently dropped it — the accept-and-drop
  pattern that hid the tool_response bug, pinned then by a @bug scenario
  and fixed 2026-07-23 (references persist under metadata, the media
  filter reads them). The scenarios below are that rewrite: the charter
  shape, now bound.

  @D10
  Scenario: an attachment is journaled as description plus reference
    Given a file the user attached to the conversation
    When the agent inserts a node describing it with a media reference
    Then the entry holds the description text, the URI, and the MIME type
    And the file's bytes are absent from the store

  @D10
  Scenario: media is recalled through its description's words
    Given a journaled attachment described in the agent's words
    When a later session searches words from that description
    Then the media entry is a hit and carries its URI

  @D10
  Scenario: media can be recalled as a class
    Given journaled attachments of mixed types
    When a query filters by MIME prefix
    Then every entry whose media reference matches the prefix is returned
    And entries without a matching reference are absent
    # Both directions on purpose: "only matching returned" alone is
    # satisfied by an empty result — a dead filter would pass it.

  @D26
  Scenario: filename and extension filters honor the same two-sided contract
    Given journaled attachments with distinct filenames and extensions
    When one query filters by a filename substring and another by an exact extension
    Then each filter returns exactly the entries whose reference matches it
    And entries with no reference or a non-matching one are absent from both
    # Pinned as its own scenario by the first completeness-critic pass
    # (2026-07-24): this contract previously lived only in the comment
    # above — comment-carried contract, the class the critic audits for.

  @D26
  Scenario: several attachments are several entries
    Given three files attached in one message
    When the agent describes and inserts each one
    Then three entries exist, each holding one reference and its own description
    And each is findable by its own description's words
    And the conversation window around any of them recovers the other two
    # One description per artifact keeps recall and MIME filtering crisp;
    # the grouping lives in session adjacency, where the window already
    # reads it — no multi-ref entry, no grouping machinery.

  @D26
  Scenario: the same file attached twice is two entries
    Given a file already journaled with a morning description
    When the same file is attached again with an afternoon description
    Then both entries survive with their own descriptions and timestamps
    # No dedup for media events: each attachment is a fact about the
    # conversation, and collapsing them would falsify the record — the
    # same reasoning as the dangling-link scenario below. Bytes are never
    # stored, so duplicates cost nothing worth saving.

  @D26
  Scenario: extracted metadata rides along verbatim
    Given a media reference inserted with extracted details such as dimensions or duration
    When the entry is exported
    Then the extracted details return exactly as inserted
    # This is also the versioning seam: a content hash stored here at
    # capture makes later drift detectable, with no store machinery.

  @D26
  Scenario: a dangling link is returned honestly, not repaired or hidden
    Given a journaled attachment whose file has since moved or been deleted
    When the entry is queried and exported
    Then the description and the recorded URI return unchanged
    # The journal records that the attachment existed and where it lived
    # at capture time. Link rot is the filesystem's history, not store
    # corruption — rewriting or dropping the entry would falsify the
    # record.

  @D10
  Scenario: a media reference without a description is refused
    Given a journal accepting insertions
    When an insert attempt carries a media reference and no descriptive text
    Then the insert is rejected
    # The description IS the recall surface in a lexical store; a bare
    # URI would be unfindable by every search mode the journal has.
