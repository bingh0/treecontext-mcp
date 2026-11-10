/**
 * Edit a JSON text into a target value without rewriting what stays.
 *
 * Install changes Codex's hooks file only by taking out treecontext's own
 * parts and appending its groups (codex-hooks.ts convergeCodexHooks,
 * takeBackCodexHooks). Re-serialising the whole file would rewrite every
 * byte of the developer's: a number past 2^53 rounded (a `timeout` of
 * 9223372036854775807 printed as 9223372036854776000, which Codex 0.167.0's
 * hook discovery then panics on), escapes, spacing and key order changed,
 * and a hook whose text changes may lose the trust Codex keyed to it. So the
 * change is made as edits of the text: elements and members taken out by
 * their own spans (with the separator that joined them), new ones inserted
 * after the last kept element, and nothing else touched. Every byte outside
 * the removed spans and the insertion points is the original's.
 *
 * The edits are planned by matching the text's tree against the target
 * value: an element equal to the target's next is kept untouched; one that
 * is not is taken out, or, where the target holds it with parts removed,
 * edited by removals alone; appending is allowed only where install adds
 * (the `appendAt` rule). The result is checked: the edited text must parse
 * to the target value, or no text is returned and the caller refuses.
 */

/** A JSON value with its span in the text, `[start, end)`. */
export type SpanNode =
  | { kind: 'object'; start: number; end: number; members: SpanMember[] }
  | { kind: 'array'; start: number; end: number; items: SpanNode[] }
  | { kind: 'scalar'; start: number; end: number }

/** An object member: its key, the span from the key's quote to the value's end, and the value. */
export interface SpanMember { key: string; start: number; end: number; value: SpanNode }

/** Parse JSON text keeping each value's span. Throws on text that is not JSON. */
export function parseSpans(text: string): SpanNode {
  let i = 0
  const ws = (): void => { while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++ }
  const fail = (what: string): never => { throw new Error(`${what} at offset ${i}`) }
  const str = (): number => {
    if (text[i] !== '"') fail('expected a string')
    i++
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
    if (i >= text.length) fail('unterminated string')
    return ++i
  }
  const value = (): SpanNode => {
    ws()
    const start = i
    const c = text[i]
    if (c === '{') {
      i++
      const members: SpanMember[] = []
      ws()
      if (text[i] === '}') { i++; return { kind: 'object', start, end: i, members } }
      for (;;) {
        ws()
        const ks = i
        const ke = str()
        const key = JSON.parse(text.slice(ks, ke)) as string
        ws()
        if (text[i] !== ':') fail('expected ":"')
        i++
        const v = value()
        members.push({ key, start: ks, end: v.end, value: v })
        ws()
        if (text[i] === ',') { i++; continue }
        if (text[i] === '}') { i++; return { kind: 'object', start, end: i, members } }
        fail('expected "," or "}"')
      }
    }
    if (c === '[') {
      i++
      const items: SpanNode[] = []
      ws()
      if (text[i] === ']') { i++; return { kind: 'array', start, end: i, items } }
      for (;;) {
        items.push(value())
        ws()
        if (text[i] === ',') { i++; continue }
        if (text[i] === ']') { i++; return { kind: 'array', start, end: i, items } }
        fail('expected "," or "]"')
      }
    }
    if (c === '"') { str(); return { kind: 'scalar', start, end: i } }
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 400))
    if (!m) fail('expected a value')
    i += m![0].length
    return { kind: 'scalar', start, end: i }
  }
  const root = value()
  ws()
  if (i !== text.length) fail('text after the value')
  return root
}

/** JSON with object keys sorted, so two equal values print alike. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>).sort().map(k => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

interface Edit { start: number; end: number; text: string }
type Path = Array<string | number>

/** Where new members or elements may be inserted: a path predicate. */
export type AppendRule = (path: Path) => boolean

/** What may be written, and what is the developer's (editJsonText). */
export interface EditRules {
  /** Where new members or elements may be inserted. */
  appendAt: AppendRule
  /** Whether a value is one the caller supplies whole (its own block's
   *  parts): the only values the editor ever renders as new text. */
  owns: (value: unknown) => boolean
  /** Whether a string marks a value as the caller's: a subtree holding none
   *  is the developer's, and its text must come through unchanged. */
  ownString: (s: string) => boolean
  /** Whether a part holding the caller's strings is the caller's whole (a
   *  hook of its own, a group of only its own hooks), which the change may
   *  take out entire; any other part holding them is read element by
   *  element. Default: an object with a member whose value is a string the
   *  caller owns. */
  ownPart?: (value: unknown) => boolean
}

/**
 * The text edited into `target`, or null where the change cannot be made
 * by taking parts out and appending, at the places `appendAt` allows,
 * values `owns` names the caller's; null too where the result does not
 * parse to `target`, or where any of the developer's values (a subtree of
 * the original holding no `ownString`, empty containers aside) is not in
 * the result as its own text, in order. Null means the caller changes
 * nothing. The editor never renders a developer's value: a plan that would
 * (a developer's element taken out to be put back) is refused, never made.
 * An object holding a key twice is never edited inside (which of the two a
 * reader takes is the reader's), only kept or taken out whole.
 */
export function editJsonText(text: string, target: unknown, rules: EditRules): string | null {
  const { appendAt, owns } = rules
  let root: SpanNode
  try { root = parseSpans(text) } catch { return null }
  const valueOf = (n: SpanNode): unknown => JSON.parse(text.slice(n.start, n.end)) as unknown
  const same = (n: SpanNode, t: unknown): boolean => canonicalJson(valueOf(n)) === canonicalJson(t)

  /** The line's leading whitespace at offset `at`. */
  const lineIndent = (at: number): string => {
    const nl = text.lastIndexOf('\n', at - 1)
    return /^[ \t]*/.exec(text.slice(nl + 1))![0]
  }
  /** A new element's text, its lines after the first indented as
   *  `indent`; only ever a value the caller owns (rules.owns). */
  let rendersOthers = false
  const render = (v: unknown, indent: string): string => {
    if (!owns(v)) rendersOthers = true
    return JSON.stringify(v, null, 2).split('\n').join(`\n${indent}`)
  }

  /** Removals and appends within one container's elements. */
  const container = (open: number, close: number, spans: Array<{ start: number; end: number }>, removed: Set<number>, appends: Array<(indent: string) => string>): Edit[] | null => {
    const n = spans.length
    // The whitespace a new element is set off by: the one before the last
    // element (after its comma), or a new line one step in.
    let gap: string
    if (n >= 2) gap = text.slice(spans[n - 2]!.end, spans[n - 1]!.start).replace(/^\s*,/, '')
    else if (n === 1) gap = text.slice(open + 1, spans[0]!.start)
    else gap = `\n${lineIndent(open)}  `
    if (!/^\s*$/.test(gap)) return null
    const indent = gap.includes('\n') ? gap.slice(gap.lastIndexOf('\n') + 1) : ''
    const added = appends.map(a => a(indent))
    const kept = [...Array(n).keys()].filter(i => !removed.has(i))
    const edits: Edit[] = []
    if (kept.length === 0) {
      if (n > 0) edits.push({ start: spans[0]!.start, end: spans[n - 1]!.end, text: added.join(`,${gap}`) })
      else if (added.length > 0) edits.push({ start: open + 1, end: close - 1, text: `${gap}${added.join(`,${gap}`)}\n${lineIndent(open)}` })
      return edits
    }
    const last = kept[kept.length - 1]!
    for (const i of removed) if (i < last) edits.push({ start: spans[i]!.start, end: spans[i + 1]!.start, text: '' })
    const trailing = [...removed].some(i => i > last)
    if (trailing || added.length > 0) {
      edits.push({ start: spans[last]!.end, end: trailing ? spans[n - 1]!.end : spans[last]!.end, text: added.map(a => `,${gap}${a}`).join('') })
    }
    return edits
  }

  const diff = (node: SpanNode, t: unknown, path: Path): Edit[] | null => {
    if (same(node, t)) return []
    if (node.kind === 'object' && t !== null && typeof t === 'object' && !Array.isArray(t)) {
      const keys = node.members.map(m => m.key)
      if (new Set(keys).size !== keys.length) return null
      const target = t as Record<string, unknown>
      const edits: Edit[] = []
      const removed = new Set<number>()
      for (const [i, m] of node.members.entries()) {
        if (!Object.hasOwn(target, m.key)) { removed.add(i); continue }
        const sub = diff(m.value, target[m.key], [...path, m.key])
        if (sub === null) return null
        edits.push(...sub)
      }
      const newKeys = Object.keys(target).filter(k => !keys.includes(k))
      if (newKeys.length > 0 && !appendAt(path)) return null
      const c = container(node.start, node.end, node.members, removed, newKeys.map(k => (indent: string) => `${JSON.stringify(k)}: ${render(target[k], indent)}`))
      return c === null ? null : [...edits, ...c]
    }
    if (node.kind === 'array' && Array.isArray(t)) {
      // In place: an element equal to the target's next is kept; one the
      // target holds with parts taken out is edited where it stands; any
      // other is taken out. What is left of the target is appended, and
      // only a value the caller owns may be (render refuses the rest).
      const edits: Edit[] = []
      const removed = new Set<number>()
      let j = 0
      node.items.forEach((item, i) => {
        if (j < t.length && same(item, t[j])) { j++; return }
        if (j < t.length) {
          const sub = diff(item, t[j], [...path, i])
          if (sub !== null) { edits.push(...sub); j++; return }
        }
        removed.add(i)
      })
      const rest = t.slice(j)
      if (rest.length > 0 && !appendAt(path)) return null
      const c = container(node.start, node.end, node.items, removed, rest.map(v => (indent: string) => render(v, indent)))
      return c === null ? null : [...edits, ...c]
    }
    return null
  }

  const edits = diff(root, target, [])
  if (edits === null || rendersOthers) return null
  edits.sort((a, b) => b.start - a.start || b.end - a.end)
  for (let k = 1; k < edits.length; k++) if (edits[k]!.end > edits[k - 1]!.start) return null
  let out = text
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  try { if (canonicalJson(JSON.parse(out)) !== canonicalJson(target)) return null } catch { return null }
  if (!developerTextSurvives(text, root, out, rules.ownString, appendAt, rules.ownPart)) return null
  return out
}

/** Whether a value holds a string the caller marks as its own. */
function holdsOwn(v: unknown, ownString: (s: string) => boolean): boolean {
  if (typeof v === 'string') return ownString(v)
  if (Array.isArray(v)) return v.some((x) => holdsOwn(x, ownString))
  if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).some((x) => holdsOwn(x, ownString))
  return false
}

/**
 * Whether every one of the developer's values in `text` is in `out` as its
 * own text, in order. A value is the developer's where its subtree holds
 * no string the caller owns: it must come through whole, unless it is a
 * container the caller may append into (`appendAt`), whose elements must
 * then come through one by one. An object holding a string the caller owns
 * as a member's value (a hook of the caller's) is the caller's and may go;
 * any other container holding the caller's strings deeper (a group the
 * developer shares with a hook of the caller's) is read element by
 * element. Empty containers are passed over: an empty `{}` or `[]` carries
 * nothing, and the change itself may fill or drop one.
 */
export function developerTextSurvives(text: string, root: SpanNode, out: string, ownString: (s: string) => boolean, appendAt: AppendRule, ownPart?: (value: unknown) => boolean): boolean {
  const spans: string[] = []
  const valueOf = (n: SpanNode): unknown => JSON.parse(text.slice(n.start, n.end)) as unknown
  const isOwnPart = ownPart ?? ((v: unknown): boolean => !!v && typeof v === 'object' && !Array.isArray(v)
    && Object.values(v as Record<string, unknown>).some((x) => typeof x === 'string' && ownString(x)))
  const walk = (n: SpanNode, whole: { start: number; end: number }, path: Path): void => {
    if (n.kind !== 'scalar' && isOwnPart(valueOf(n))) return
    const empty = (n.kind === 'object' && n.members.length === 0) || (n.kind === 'array' && n.items.length === 0)
    if (empty) return
    if (!holdsOwn(valueOf(n), ownString) && !(n.kind !== 'scalar' && appendAt(path))) { spans.push(text.slice(whole.start, whole.end)); return }
    if (n.kind === 'object') for (const m of n.members) walk(m.value, m, [...path, m.key])
    else if (n.kind === 'array') n.items.forEach((it, i) => walk(it, it, [...path, i]))
    else if (!holdsOwn(valueOf(n), ownString)) spans.push(text.slice(whole.start, whole.end))
  }
  walk(root, root, [])
  let at = 0
  for (const sp of spans) {
    const i = out.indexOf(sp, at)
    if (i === -1) return false
    at = i + sp.length
  }
  return true
}
