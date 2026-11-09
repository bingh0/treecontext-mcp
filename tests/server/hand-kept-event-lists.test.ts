/**
 * The Claude Code hook events that hand-kept prose names as wired by install
 * (README §2's settings.json row, the matrix's Claude Code row, and
 * docs/hooks/claude-code.md's table) must equal the keys of the block install
 * writes (`claudeHooksBlock()`), so a wired event cannot be added, renamed or
 * dropped in code and left stale in the docs.
 *
 * The smallest honest parse: the settings.json row's backticked names after
 * "registers N hooks:", the table's first-column backticked names, and, for
 * the matrix row (which lists events the client has, not only the wired
 * ones), that every wired event appears in it. It cannot see an event named
 * in other words, another section's prose, or a claim about what an event
 * does.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { claudeHooksBlock } from '../../src/server/installer.js'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const wired = (): string[] => Object.keys(claudeHooksBlock()).sort()
const ticks = (s: string): string[] => [...s.matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]!)

describe('hand-kept lists of the events install wires for Claude Code', () => {
  it("README's ~/.claude/settings.json row names exactly the block's events", () => {
    const row = read('README.md').split('\n').find((l) => l.startsWith('| `~/.claude/settings.json`'))
    expect(row, 'the settings.json row is gone from the README').toBeDefined()
    const m = /registers (\d+) hooks: ([^;]*)/.exec(row!)
    expect(m, 'the row no longer reads "registers N hooks: ..."').not.toBeNull()
    const named = ticks(m![2]!).sort()
    expect(named).toEqual(wired())
    expect(Number(m![1])).toBe(wired().length)
  })

  it("README's matrix row for Claude Code names every wired event", () => {
    const row = read('README.md').split('\n').find((l) => l.startsWith('| Claude Code | SessionStart'))
    expect(row, 'the matrix row for Claude Code is gone').toBeDefined()
    const cell = row!.split('|')[2]!
    const named = cell.split(',').map((x) => x.trim())
    expect(wired().filter((e) => !named.includes(e))).toEqual([])
  })

  it("docs/hooks/claude-code.md's table names exactly the block's events", () => {
    const lines = read('docs/hooks/claude-code.md').split('\n')
    const start = lines.findIndex((l) => l.startsWith('| Event | Matcher'))
    expect(start, 'the event table is gone from docs/hooks/claude-code.md').toBeGreaterThanOrEqual(0)
    const rows: string[] = []
    for (const l of lines.slice(start + 2)) { if (!l.startsWith('|')) break; rows.push(l) }
    expect(rows.map((l) => /^\| `([A-Za-z]+)`/.exec(l)![1]!).sort()).toEqual(wired())
  })
})
