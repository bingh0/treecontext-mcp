import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { parseRunArgs, RunUsageError } from '../../src/server/run-command.js'
import { tomlBackupStem } from '../../src/server/installer.js'
import { spawnCli } from '../helpers/cli-spawn.js'
import { concreteForms, documentedCommands, isSynopsis, runLineRefusal, shellWords } from '../helpers/readme-commands.js'

// Every command line the README documents is read by the CLI's own parser
// (M6, the final review of beta.4): the D388 bindings checked the README's
// words, so a flag the CLI rejects (`--parentt`) in a documented line stayed
// green. A `treecontext run` line goes through run-command's parseRunArgs;
// each documented install, uninstall and `config tool-approvals` form runs
// through the CLI in a home of its own, with --dry-run where the command
// has one, and must not be refused.

const README = readFileSync(join(__dirname, '..', '..', 'README.md'), 'utf8')

const runRefusal = runLineRefusal

/** The flags a synopsis names, each one the parser knows (its refusal, if any, is never "unknown flag"). */
function unknownSynopsisFlags(line: string): string[] {
  const flags = [...new Set(line.match(/--[a-z][a-z-]*/g) ?? [])]
  return flags.filter((f) => {
    try { parseRunArgs([f, 'v', '--', 'x']); return false } catch (e) {
      return e instanceof RunUsageError && e.message === `unknown flag for run: ${f}`
    }
  })
}

describe("the README's treecontext run lines parse as the CLI parses them", () => {
  const lines = documentedCommands(README, 'run').filter(l => / -- /.test(l))
  test('the README documents run lines, the dispatcher\'s among them', () => {
    expect(lines.length).toBeGreaterThanOrEqual(5)
    expect(lines.some(l => l.includes('"${CLAUDE_CODE_SESSION_ID:-dispatcher}"')), lines.join('\n')).toBe(true)
  })
  test('every run line a developer copies parses with no usage error', () => {
    for (const line of lines.filter(l => !isSynopsis(l))) expect(runRefusal(line), line).toBeNull()
  })
  test("every flag the run synopsis names is one the parser knows", () => {
    const synopses = lines.filter(isSynopsis)
    expect(synopses.length).toBeGreaterThan(0)
    for (const line of synopses) expect(unknownSynopsisFlags(line), line).toEqual([])
  })
  test('a flag typo in a run line is refused, so the check above cannot pass on a line it never read', () => {
    const line = lines.find(l => !isSynopsis(l) && l.includes('--parent '))!
    expect(runRefusal(line.replace('--parent ', '--parentt '))).toBe('unknown flag for run: --parentt')
    const synopsis = lines.find(isSynopsis)!
    expect(unknownSynopsisFlags(synopsis.replace('--checkpointer', '--checkpointerr'))).toEqual(['--checkpointerr'])
  })
})

describe("the README's install, uninstall and config tool-approvals forms are not refused by the CLI", () => {
  const homes: string[] = []
  afterAll(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }) })
  const freshHome = (): string => {
    const h = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-readme-forms-')))
    homes.push(h)
    mkdirSync(join(h, '.claude', 'projects'), { recursive: true })
    return h
  }
  // `<name>` in a form is an agent's slug: Claude Code's stands for any.
  const forms = (sub: string): string[] => [...new Set(documentedCommands(README, sub).flatMap(f => concreteForms(f, { name: 'claude' })))]
  const install = forms('install')
  const uninstall = forms('uninstall')
  const config = forms('config tool-approvals')

  test('the README documents each kind of form', () => {
    expect(install).toContain('treecontext install --no-tool-approvals')
    expect(install).toContain('treecontext install --agent codex --experimental-capture')
    expect(uninstall).toContain('treecontext uninstall --agent vscode --hooks-only')
    expect(config).toContain('treecontext config tool-approvals off --agent agy')
    expect(config).toContain('treecontext config tool-approvals on')
  })

  const run = (form: string, extra: string[]): { status: number | null; out: string } => {
    const args = shellWords(form).slice(1)
    const r = spawnCli([...args, ...extra.filter(x => !args.includes(x))], { home: freshHome() })
    return { status: r.status, out: r.out }
  }

  test.each([...install, ...uninstall])('%s runs as a dry run and is not refused', (form) => {
    const r = run(form, ['--dry-run', '--yes'])
    expect(r.out, form).not.toMatch(/Unknown flag|Unexpected argument|requires --agent|No matching agents|unknown agent/)
    expect(r.status, `${form}\n${r.out}`).toBe(0)
  }, 60_000)

  test.each(config)('%s runs in a home of its own and is not refused', (form) => {
    const r = run(form, [])
    expect(r.out, form).not.toMatch(/Unknown flag|Unexpected argument|takes on or off|is not a client|are not a client/)
    expect(r.status, `${form}\n${r.out}`).toBe(0)
  }, 60_000)

  test('a typo in a documented form is refused, so the checks above cannot pass on a form they never ran', () => {
    expect(run('treecontext install --no-tool-aprovals', ['--dry-run', '--yes']).status).not.toBe(0)
    expect(run('treecontext config tool-approvals off --agent agyy', []).status).not.toBe(0)
  }, 60_000)
})

describe('the README says what the code does (the final review of beta.4)', () => {
  const flat = README.replace(/\s+/g, ' ')
  test("Codex's config.toml backup is named as install names it, by its UTC timestamp, wherever the README names it", () => {
    const named = [...README.matchAll(/config\.toml\.treecontext-bak[^`]*/g)].map(m => m[0])
    expect(named.length).toBeGreaterThanOrEqual(2)
    for (const n of named) expect(n).toBe('config.toml.treecontext-bak-<UTC timestamp>')
    expect(tomlBackupStem('/x/config.toml')).toBe('/x/config.toml.treecontext-bak-')
  })
  test("the install-state.json row names everything install's record holds", () => {
    const row = README.split('\n').find(l => l.startsWith('| `~/.treecontext/install-state.json` |'))
    expect(row).toBeDefined()
    // InstallState's own keys, said in words: the idle-compaction key, the
    // approvals written, the off chosen, the files created.
    for (const words of ['`idleCompaction` key', 'tool approvals it wrote', 'your choice to turn them off', 'the files it created']) expect(row).toContain(words)
  })
  test('a plain install wires each client it detects: no client file is said to need --agent', () => {
    const table = README.slice(README.indexOf('**Everything it writes**'), README.indexOf('**Tool approvals.**'))
    expect(table).not.toMatch(/\| with `--agent [a-z]+`:/)
    expect(table).toMatch(/where Codex CLI is detected \(or on its own with `--agent codex`\)/)
    expect(flat).toContain('For each other agent it detects (or the one `--agent` names) install writes that client\'s MCP entry')
  })
  test('the sentence about the 2026-11-08 cells points at the matrix where it sits', () => {
    const at = README.indexOf('2026-11-08 runs, each made under the permission mode it names')
    expect(at).toBeGreaterThan(-1)
    const said = /The cells (above|below) are the\s+$/.exec(README.slice(at - 40, at))?.[1]
    const table = README.indexOf('| Client | Headless worker through the ticket door |')
    expect(said).toBe(table > at ? 'below' : 'above')
  })
  test("the record's path keying and CODEX_HOME are disclosed in the troubleshooting section", () => {
    const trouble = flat.slice(flat.indexOf('## 8. Troubleshooting'))
    expect(trouble).toMatch(/names each file it wrote by its absolute path, so after your home directory moves/)
    expect(trouble).toMatch(/does not read `CODEX_HOME`/)
  })
})
