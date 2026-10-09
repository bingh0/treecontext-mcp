Feature: content-codec.ts — C1 zstd content codec with flag-byte fallback

  encodeContent/decodeContent round-trip node content through zstd
  compression (rows at/above the size floor) or plain TEXT (small rows /
  legacy rows), guarded by a 1-byte format flag so decode never depends on
  which runtime wrote a row.

  Scenario: small strings round-trip as plain TEXT, unchanged legacy shape
    Given a set of strings below the zstd floor, including the empty string
    When each is encoded
    Then each encodes to the identical plain string, and decodes back unchanged

  Scenario: large strings round-trip through zstd compression
    Given a string exactly at the zstd floor and a multi-megabyte string
    When each is encoded
    Then each encodes to a flagged Buffer with the zstd flag byte and decodes back to the original text

  Scenario: non-ASCII and NUL-containing content round-trips exactly
    Given strings containing emoji, CJK characters, and embedded NUL bytes, padded past the zstd floor
    When each is encoded and decoded
    Then the decoded text is identical to the original, byte for byte

  Scenario: a legacy plain-TEXT row decodes unchanged
    Given a plain string value as it would be read from an old, unmigrated row
    When it is decoded directly without going through encodeContent
    Then it is returned unchanged

  Scenario: zstd-unavailable runtimes fall back to the flag-0x00 plain form
    Given the zstd capability override is forced off
    When a large string is encoded and then decoded
    Then the encoded form carries the plain-fallback flag byte and decodes back to the original string

  Scenario: a zstd row on a runtime without zstd is refused, not corrupted
    # G1 review: engines allows Node >=22 but zstd*Sync only exists from
    # 22.15 — a store written on a newer runtime can meet an older one.
    # The refusal must be the typed error (migration 021 skips the row on
    # it; nothing may present compressed bytes as text), and the row is
    # readable again the moment a capable runtime opens the store.
    Given a string encoded through real zstd
    And the zstd capability override is then forced off
    When it is decoded
    Then a ContentDecodeError names the zstd requirement, and the same row decodes once capability returns

  Scenario: an unrecognized flag byte is treated as store corruption
    Given a buffer with an unknown leading flag byte
    When it is decoded
    Then a ContentDecodeError is thrown naming the offending byte
