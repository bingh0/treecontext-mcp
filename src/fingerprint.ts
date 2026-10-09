import { createHash } from 'node:crypto'

/**
 * Content fingerprint for exact-duplicate detection.
 *
 * Shared by the dual-tree cross-tree dedup and the lexical FlatStore so
 * both dedup identically (MVP spec AC2.7). The key is
 * `sha256(normalized).hex.slice(0, 32)` — 128 bits, for content of every
 * length — so it carries exactly one property: equal fingerprints ⟺
 * equal whitespace-normalized content (up to a 2⁻¹²⁸ accident).
 *
 * Whitespace normalization stays: collapsing runs of whitespace is the
 * DESIGNED equivalence, and two texts differing only in spacing are meant
 * to dedup.
 *
 * WHY IT IS A DIGEST (docs/project-identity.md §9.2, measured
 * 2026-08-16). Until schema v24 this returned the normalized content
 * itself under 128 chars and a STRUCTURAL key above it —
 * `head(64) + "\x00" + tail(64) + ":" + length` — with a doc comment
 * claiming a head/tail/length match was "effectively impossible for
 * genuinely different content." Measured against this project's own
 * store (10,001 nodes): 9,835 rows used the structural form, 97 keys
 * covered rows with DIFFERING content, and 219 rows (2.2%) sat in one of
 * those groups. The shape is structural, not unlucky — captured tool
 * calls share a command prefix and a result suffix and differ in a
 * middle identifier of fixed width, which is the most common shape in a
 * capture journal. Whitespace collapse also drags unequal raw lengths
 * onto equal normalized ones, a surface the head/tail design never
 * accounted for. Head/tail/length is not a hash; this is.
 *
 * The change is a strict REFINEMENT: equal content still gives equal
 * keys, so fingerprint groups only ever split, never merge — which is
 * why the curated partial-unique index cannot gain a violation from the
 * v24 rewrite (§11b).
 */
export function contentFingerprint(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim()
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 32)
}

/**
 * The pre-v24 fingerprint, frozen verbatim — migration 023's key, and
 * nothing else's.
 *
 * `arbiter-backfill.ts` runs inside a SHIPPED ladder step. Letting it
 * import the live `contentFingerprint` would have silently rewritten
 * what 023 does the day the function changed, which is precisely what
 * `022_interim_heal.ts`'s tombstone rule forbids: "a ladder position,
 * once released to any store, is never renumbered" — and editing one in
 * place is the same offence wearing a different hat, because it cannot
 * heal the stores that already climbed it. With 023 pinned here, a store
 * entering the ladder at v20 and one entering at v23 climb identical
 * rungs, and migration 024 is the only step that ever writes the digest
 * key (docs/project-identity.md §11b, design review finding 1).
 *
 * Also the honest way to build a pre-digest fixture: an old-form key in
 * a test comes from this function, never from a hand-written string.
 *
 * Do not call this from any live path.
 */
export function contentFingerprintV1(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 128) return normalized
  return `${normalized.slice(0, 64)}\x00${normalized.slice(-64)}:${normalized.length}`
}

/**
 * The v24 digest, frozen verbatim — migration 024's key, and nothing
 * else's. The same tombstone-rule debt that froze V1 for 023, paid one
 * rung down before it comes due (Phase-3 review, M3): the day a v25
 * changes the live `contentFingerprint`, stores climbing THROUGH 024
 * must still get exactly this key, and by then 024 is shipped history
 * that cannot be edited. Byte-identical to the live function today;
 * pinned so a drift fails a test instead of a store.
 *
 * Do not call this from any live path.
 */
export function contentFingerprintV2(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim()
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 32)
}
