/**
 * Store-name addressability — a dependency-free leaf so every consumer
 * (the CLI parse guard, doctor's advice fork, bindings validation,
 * stores.ts) shares one definition without dragging each other's module
 * graphs along: cli.ts importing stores.ts for this regex pulled the
 * whole migration ladder into every CLI spawn, and bindings.ts held a
 * third private copy of the same pattern (second-pass review).
 */

/** The character class of a well-formed store name. */
export const SAFE_STORE_RE = /^[A-Za-z0-9._-]+$/

/**
 * True when the CLI can address `name` — i.e. `stores rm <name>` parses.
 * Strictly tighter than SAFE_STORE_RE: '.' and '..' are in-class but are
 * traversal names, and a leading dash reads as a flag to the parser.
 * Doctor must advise an rm command ONLY for names that pass this — the
 * parse guard and the advice fork are the same predicate, so they cannot
 * disagree about which names are stranded.
 */
export function isCliAddressableStoreName(name: string): boolean {
  if (!SAFE_STORE_RE.test(name)) return false
  if (name === '.' || name === '..') return false
  if (name.startsWith('-')) return false
  return true
}
