// The command lines the README documents, read the way a developer copies
// them: from a fenced block (a line, joined across its `\` continuations, a
// trailing `# comment` dropped) or from an inline code span (which may wrap
// across a line break). The D388 bindings and tests/server/readme-commands
// hand them to the CLI's own parsers, so a flag the CLI rejects in a
// documented line fails a test, not a reader.

import { parseRunArgs, RunUsageError } from '../../src/server/run-command.js'

/** Every documented `treecontext <sub> …` command whose subcommand starts with `sub` ("run", "install", "config tool-approvals"). */
export function documentedCommands(markdown: string, sub: string): string[] {
  const out: string[] = []
  const head = new RegExp(`^treecontext ${sub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`)
  const fences = markdown.split(/^```.*$/m)
  fences.forEach((chunk, i) => {
    if (i % 2 === 1) {
      // A fenced block: one command per logical line.
      const logical = chunk.replace(/\\\n\s*/g, ' ').split('\n')
      for (const raw of logical) {
        const line = raw.replace(/\s+#.*$/, '').trim()
        const at = line.indexOf('treecontext ')
        if (at === -1) continue
        const cmd = line.slice(at).trim()
        if (head.test(cmd)) out.push(cmd)
      }
      return
    }
    for (const m of chunk.matchAll(/`([^`]+)`/g)) {
      const cmd = m[1]!.replace(/\s+/g, ' ').trim()
      if (head.test(cmd)) out.push(cmd)
    }
  })
  return [...new Set(out)]
}

/** Whether a line is a usage synopsis (optional parts in brackets, choices in parentheses) rather than a line to run. */
export function isSynopsis(cmd: string): boolean {
  return /\[--|\(--/.test(cmd)
}

/**
 * A shell line's words, as a POSIX shell splits them before expansion:
 * single and double quotes removed, a backslash escaping the next
 * character. Expansions (`$1`, `${X:-y}`) stay as their literal text,
 * which is a value like any other to the parser reading it.
 */
export function shellWords(line: string): string[] {
  const words: string[] = []
  let cur = ''
  let has = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i]
      else cur += c
      continue
    }
    if (c === '"' || c === "'") { quote = c; has = true; continue }
    if (c === '\\' && i + 1 < line.length) { cur += line[++i]; has = true; continue }
    if (/\s/.test(c)) {
      if (has) words.push(cur)
      cur = ''
      has = false
      continue
    }
    cur += c
    has = true
  }
  if (has) words.push(cur)
  return words
}

/**
 * A documented form's concrete lines: each `a|b|c` choice taken in turn,
 * each `[…]` optional part taken and left out, and `<name>` read as one of
 * the choices the README gives for it (an agent's slug).
 */
export function concreteForms(cmd: string, placeholder: Record<string, string> = {}): string[] {
  const filled = cmd.replace(/<([a-z ]+)>/g, (_m, name: string) => placeholder[name] ?? `<${name}>`)
  const opt = /\[([^\]]+)\]/.exec(filled)
  if (opt) {
    const before = filled.slice(0, opt.index)
    const after = filled.slice(opt.index + opt[0].length)
    return [...concreteForms(`${before}${opt[1]}${after}`, placeholder), ...concreteForms(`${before}${after}`, placeholder)]
      .map(s => s.replace(/\s+/g, ' ').trim())
  }
  const words = filled.split(' ')
  const choice = words.findIndex(w => /^[a-z-]+(\|[a-z-]+)+$/.test(w))
  if (choice !== -1) {
    return words[choice]!.split('|').flatMap(alt => concreteForms([...words.slice(0, choice), alt, ...words.slice(choice + 1)].join(' '), placeholder))
  }
  return [filled.replace(/\s+/g, ' ').trim()]
}

/** What run-command's own parser says of a documented `treecontext run` line: null when it parses, else its usage error. */
export function runLineRefusal(line: string): string | null {
  const words = shellWords(line)
  if (words[0] !== 'treecontext' || words[1] !== 'run') return `not a treecontext run line: ${line}`
  try {
    parseRunArgs(words.slice(2))
    return null
  } catch (e) {
    if (e instanceof RunUsageError) return e.message
    throw e
  }
}
