import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { redirectHome } from '../../helpers/home.js'
import { isAbsolute, join, relative } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { expect } from 'vitest'
import { type Registry } from 'gherkin-node-test/vitest'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { nodeTsArgs, sandboxedSpawnEnv } from '../../helpers/cli-spawn.js'
import { parseToolResult } from '../../helpers/mcp-result.js'
import { DatabaseSync } from 'node:sqlite'
import { launcherCliPath } from '../../../src/server/installer.js'
import { agyHooksPath, getAgent, getHookSettingsPath } from '../../../src/server/agents.js'
import { decodeContent } from '../../../src/persistence/content-codec.js'
import { TS_ROOT } from '../proc.js'
import { writeFakeAgy } from '../standins.js'
import { type InstallWorld, tcCli, openInstallWorld, realAgy, agentConfigPath, mcpLauncherIn, setFakeCodex, pathWithoutCodex, putAgyOnPath, agyMcpList, layEarlierGeminiInstall } from '../install-harness.js'
import { CODEX_APPROVALS_FLOOR } from '../../../src/server/codex-client.js'
import { failedRunLine } from '../../../src/first-moment.js'
import { developerTrustsCodexHooks } from '../standins.js'
import { upsertCodexHooks } from '../../helpers/earlier-build-writers.js'
import { codexHooksBlock } from '../../../src/server/codex-hooks.js'
import { type CodexListedHook } from '../../../src/server/codex-client.js'
import { spawnSync } from 'node:child_process'
import { documentedCommands, runLineRefusal } from '../../helpers/readme-commands.js'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'

// ── journal-clients ─────────────────────────────────────────────────────
//
// Three scenarios bound at the beta.1 build (D197): the dated matrix, read
// out of README.md itself by parsing its table; the copying client's
// tools-only install, run through the real CLI in a redirected HOME with
// doctor read off its own output; and a teammate on another agent, whose tool
// calls go through the exact server command install wrote into that agent's
// own configuration, spawned over a real stdio transport (Gemini CLI until
// its retirement, Antigravity CLI since D399). Doctor per client
// and the copied-configuration consistency rows bound at beta.2 (D161,
// D208): every doctor run is the real CLI in a redirected HOME, its row read
// off its own stdout, and every remedy a row names is run and doctor re-read.

/** One parsed row of the README's compatibility matrix, keyed by column. */
export type MatrixRow = Record<'client' | 'events' | 'docs' | 'mode' | 'status', string>

export interface ClientsWorld extends InstallWorld {
  /** README.md's bytes, as a developer would read them. */
  readme?: string
  /** The matrix table's rows, parsed from the README text. */
  matrix?: MatrixRow[]
  /** The teammate's agent: an MCP client over the configured server command. */
  teammate?: Client
  /** What the teammate's insert returned. */
  teammateNodeId?: string
  /** The teammate's search results, as the tool returned them. */
  teammateHits?: Array<{ nodeId?: string; content?: string }>
  /** Doctor's report, captured after the install. */
  doctorOut?: string
  /** The documented client a doctor scenario is about, by its display name. */
  clientName?: string
  /** Doctor's row for that client, parsed: the three halves and its grade. */
  clause?: DoctorClause
  /** The Claude Code hooks block as install wrote it into ~/.claude/settings.json. */
  claudeBlock?: HookBlock
  /** Doctor's row for a client, read for its approvals clause (D387, D390). */
  approval?: ApprovalRowRead
  /** The README's "Headless workers" section (D388). */
  headless?: string
  /** The part of it for one worker, read for its steps. */
  workerPart?: string
  workerKey?: string
  /** The orchestration matrix rows for Codex CLI and Antigravity CLI. */
  orchRows?: Array<{ client: string; cells: string[] }>
  /** D399: the files install wrote for the wired clients, by their bytes, before Gemini CLI's leftover is laid. */
  retiredWiring?: Record<string, string>
  /** D399: the command doctor's Gemini CLI row names. */
  retiredFix?: string
  /** D399: doctor's report after that command ran. */
  retiredDoctorAfter?: string
}

/** A client's doctor row read for whether its headless workers can use the tools. */
interface ApprovalRowRead { status: string; row: string; clause: string; remedy: string; fix: string | null }

/** A Claude-format hooks block: event → matcher entries. */
type HookBlock = Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>

/** One client's row as doctor printed it, cut into the parts D161 asks for. */
interface DoctorClause {
  row: string
  status: string
  mode: string
  state: string
  remedy: string
  /** The `fix:` line doctor printed under the row, if any. */
  fix: string | null
}

/** The clients ruled to stand (D104), Antigravity CLI since D383, Gemini CLI retired by D399; the matrix carries one row each. */
const DOCUMENTED_CLIENTS = ['Claude Code', 'Codex CLI', 'VS Code', 'Cursor', 'OpenCode', 'Antigravity CLI']
const STATUSES = ['verified live', 'documented only']

/** A markdown cell as read: emphasis and code ticks are presentation. */
const cellText = (c: string): string => c.replace(/\*\*|`/g, '').trim()

/**
 * The table under the README's "Compatibility matrix" heading. Columns are
 * found by their header names, not by position, so a reordered table still
 * reads right and a renamed column fails loudly instead of shifting cells.
 */
export function parseMatrix(readme: string): MatrixRow[] {
  const lines = readme.split('\n')
  const head = lines.findIndex(l => /^#{2,4} .*Compatibility matrix/i.test(l))
  expect(head, 'README.md has no "Compatibility matrix" heading').toBeGreaterThanOrEqual(0)
  const tableStart = lines.findIndex((l, i) => i > head && l.startsWith('|'))
  expect(tableStart, 'no table under the matrix heading').toBeGreaterThan(head)
  const table: string[] = []
  for (let i = tableStart; i < lines.length && lines[i]!.startsWith('|'); i++) table.push(lines[i]!)
  const split = (l: string): string[] => l.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(cellText)
  const header = split(table[0]!).map(h => h.toLowerCase())
  const col = (re: RegExp, name: string): number => {
    const i = header.findIndex(h => re.test(h))
    expect(i, `the matrix has no ${name} column (header: ${header.join(' | ')})`).toBeGreaterThanOrEqual(0)
    return i
  }
  const at = {
    client: col(/^client$/, 'client'),
    events: col(/hook events/, 'hook events'),
    docs: col(/documentation/, 'documentation'),
    mode: col(/^mode$/, 'mode'),
    status: col(/^status$/, 'status'),
  }
  expect(table[1], 'the matrix header has no delimiter row').toMatch(/^\|\s*-{3}/)
  return table.slice(2).map((l) => {
    const cells = split(l)
    expect(cells, `a matrix row has ${cells.length} cells, the header ${header.length}: ${l}`).toHaveLength(header.length)
    return {
      client: cells[at.client]!, events: cells[at.events]!, docs: cells[at.docs]!,
      mode: cells[at.mode]!, status: cells[at.status]!,
    }
  })
}

/** The orchestration matrix (D370): the table under the README's
 *  "Orchestration matrix" heading, its own table apart from the hook-support
 *  matrix, read as cells. Columns are the roles; rows the clients. */
export function parseOrchestrationMatrix(readme: string): { header: string[]; rows: Array<{ client: string; cells: string[] }> } {
  const lines = readme.split('\n')
  const head = lines.findIndex(l => /^#{2,4} .*Orchestration matrix/i.test(l))
  expect(head, 'README.md has no "Orchestration matrix" heading').toBeGreaterThanOrEqual(0)
  const tableStart = lines.findIndex((l, i) => i > head && l.startsWith('|'))
  expect(tableStart, 'no table under the orchestration matrix heading').toBeGreaterThan(head)
  const table: string[] = []
  for (let i = tableStart; i < lines.length && lines[i]!.startsWith('|'); i++) table.push(lines[i]!)
  const split = (l: string): string[] => l.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(cellText)
  const header = split(table[0]!)
  expect(table[1], 'the orchestration matrix header has no delimiter row').toMatch(/^\|\s*-{3}/)
  const rows = table.slice(2).map((l) => {
    const cells = split(l)
    expect(cells, `an orchestration row has ${cells.length} cells, the header ${header.length}: ${l}`).toHaveLength(header.length)
    return { client: cells[0]!, cells: cells.slice(1) }
  })
  return { header: header.slice(1), rows }
}

/** Doctor's row for one check: its header line and the lines under it. */
function doctorRow(out: string, check: string): string {
  const lines = out.split('\n')
  const i = lines.findIndex(l => new RegExp(`^\\s*\\S*\\s*${check}\\b`).test(l))
  expect(i, `doctor printed no row for ${check}:\n${out}`).toBeGreaterThanOrEqual(0)
  // The row runs until the next line at the header's indentation.
  const indent = /^\s*/.exec(lines[i]!)![0].length
  const body: string[] = [lines[i]!]
  for (const l of lines.slice(i + 1)) {
    if (l.trim() === '' || /^\s*/.exec(l)![0].length <= indent) break
    body.push(l)
  }
  return body.join('\n')
}

/**
 * The documented clients other than Claude Code, as a test reads them:
 * the slug the CLI takes and what in the README matrix and doctor's row its
 * mode must say. The mode patterns are the README's own vocabulary, so
 * doctor's wording and the matrix's Mode column cannot drift apart.
 */
const CLIENT_SLUG: Record<string, string> = {
  'Codex CLI': 'codex', 'VS Code': 'vscode', 'Cursor': 'cursor', 'OpenCode': 'opencode',
  'Antigravity CLI': 'agy',
}

/**
 * A registry path re-rooted from the real home onto the sandbox — the same
 * move agentConfigPath makes, for paths agents.ts froze at import.
 */
function reroot(real: string, home: string): string {
  const rel = relative(homedir(), real)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${real} is not under the home directory`)
  return join(home, rel)
}

/** The directory whose presence makes install and doctor detect a client. */
function clientDir(slug: string, home: string): string {
  const agent = getAgent(slug)!
  const dirs = agent.detectDirs[process.platform as 'linux'] ?? agent.detectDirs.linux!
  return reroot(dirs[0]!, home)
}

/** The client's own hook configuration file, where it has one. */
function clientHookFile(slug: string, home: string): string | null {
  // Antigravity CLI's own hooks, which install never writes (D383).
  if (slug === 'agy') return reroot(agyHooksPath(), home)
  const real = getHookSettingsPath(getAgent(slug)!)
  return real ? reroot(real, home) : null
}

/** VS Code's user settings.json, beside the mcp.json install writes. */
function vscodeSettings(home: string): string {
  return join(clientDir('vscode', home), 'settings.json')
}

/**
 * Every treecontext hook a file mentions, in any spelling any build wrote —
 * read off the raw text, so JSON and TOML alike, escaped separators and all.
 * The MCP launcher (tc-mcp-serve) shares the directory and prefix but is the
 * tools' registration, not a hook, and Gemini CLI kept both in one file.
 */
function treecontextHookMentions(path: string | null): string[] {
  if (!path || !existsSync(path)) return []
  const text = readFileSync(path, 'utf8')
  return [...text.matchAll(/hooks(?:[\\/])+(?:tc-(?!mcp-serve)[\w-]+|(?:codex|gemini|vscode|cursor)(?:[\\/]))|treecontext hook [\w-]+/g)].map(m => m[0])
}

/** Doctor, run as the developer runs it, and one client's row cut into its halves. */
function readClause(w: ClientsWorld, client: string): DoctorClause {
  const run = tcCli(w, ['doctor'])
  expect(run.status, run.out).toBe(0)
  // stdout is doctor's report; stderr carries logging and is not read here.
  w.doctorOut = run.stdout
  const row = doctorRow(run.stdout, client)
  const first = row.split('\n')[0]!
  const m = /^\[(\w+)\]\s+.*?the client (.+?); state: (.+?); remedy: (.+)$/.exec(first)
  expect(m, `doctor's ${client} row does not carry mode, state and remedy:\n${first}`).not.toBeNull()
  const fix = /^\s+fix: (.+)$/.exec(row.split('\n')[1] ?? '')?.[1] ?? null
  return { row: first, status: m![1]!, mode: m![2]!, state: m![3]!, remedy: m![4]!, fix }
}

/** A claim that capture is verified: "verified", never as part of "unverified". */
const VERIFIED_CLAIM = /(?<!un)verified/

/**
 * Doctor's row claims no verification it lacks (D153). The needle is proven
 * on both sides first, so a needle that cannot fire fails here rather than
 * passing every row.
 */
function expectNoVerifiedClaim(row: string): void {
  expect('capture verified live').toMatch(VERIFIED_CLAIM)
  expect('capture unverified').not.toMatch(VERIFIED_CLAIM)
  expect(row).not.toMatch(VERIFIED_CLAIM)
}

/** Run the command a row names, exactly as printed, through the real CLI. */
function runNamedCommand(w: ClientsWorld, command: string): void {
  const argv = command.trim().split(/\s+/)
  expect(argv[0], `the remedy is not a treecontext command: ${command}`).toBe('treecontext')
  const run = tcCli(w, argv.slice(1))
  expect(run.status, run.out).toBe(0)
}

export const clientsDefiner = (reg: Registry<ClientsWorld>): void => {
  // ── every matrix row carries its client, its events, its date and one status (D153)
  reg.define(/^the documentation's compatibility matrix$/, (w: ClientsWorld) => {
    w.readme = readFileSync(join(TS_ROOT, 'README.md'), 'utf8')
    // The matrix is THE documentation's: every hook page links to it, so a
    // developer who starts from docs/hooks lands on the same table.
    const hookDocs = readdirSync(join(TS_ROOT, 'docs', 'hooks')).filter(f => f.endsWith('.md'))
    expect(hookDocs.length).toBeGreaterThan(0)
    for (const f of hookDocs) {
      expect(readFileSync(join(TS_ROOT, 'docs', 'hooks', f), 'utf8'), `docs/hooks/${f} does not link the matrix`)
        .toContain('README.md#compatibility-matrix')
    }
  })
  reg.define(/^a developer reads it$/, (w: ClientsWorld) => {
    // The compatibility matrix's scenario reads the README; the headless
    // workers scenario (D388) reads its section.
    if (w.headless !== undefined) w.workerPart = w.headless.replace(/\s+/g, ' ')
    else w.matrix = parseMatrix(w.readme!)
  })
  reg.define(/^the developer sees every row name the client, the hook events it offers, the date or release of the documentation checked, and one status$/, (w: ClientsWorld) => {
    const rows = w.matrix!
    // One row per documented client, and no row for anything else.
    for (const c of DOCUMENTED_CLIENTS) {
      expect(rows.filter(r => r.client.startsWith(c)).map(r => r.client), `the matrix rows for ${c}`).toHaveLength(1)
    }
    expect(rows).toHaveLength(DOCUMENTED_CLIENTS.length)
    for (const r of rows) {
      expect(r.client, 'a row names no client').not.toBe('')
      // An event list, or the plain statement that the client has none.
      expect(r.events, `${r.client}: no hook events named`).toMatch(/[A-Za-z]+(, [A-Za-z]+)+|^none\b/)
      // Shape, not truth: the binding proves each row CARRIES a date or a
      // release. Whether that date is the right one is checked by reading
      // the vendor's page, never by this test — a wrong date survives the
      // binding by the ruling's own design (D153: documented, not tested).
      expect(r.docs, `${r.client}: no date or release of the documentation checked`)
        .toMatch(/\b\d{4}-\d{2}-\d{2}\b|\brelease \d/)
      expect(r.mode, `${r.client}: no mode`).toMatch(/reads the Claude settings file|copies the hooks into its own|no shell hooks|keeps its own hook configuration/)
      // One status: the cell is exactly one of the two, never both, never a
      // test result the row does not have.
      // A verified row names the recording it rests on in parentheses (D388).
    const head = r.status.replace(/ \(.*\)$/s, '')
    expect(STATUSES, `${r.client}: status "${r.status}" is not one status`).toContain(head)
    expect(head === 'documented only' ? r.status : head).toBe(head)
    }
  })

  // ── the orchestration matrix, its own table (D370) ─────────────────────
  reg.define(/^the documentation's orchestration matrix$/, (w: ClientsWorld) => {
    w.readme = readFileSync(join(TS_ROOT, 'README.md'), 'utf8')
  })
  reg.define(/^the developer sees a table apart from the compatibility matrix, one row each for Claude Code, Codex CLI and Antigravity CLI, and one column per orchestration role$/, (w: ClientsWorld) => {
    const m = parseOrchestrationMatrix(w.readme!)
    // Apart: its heading is its own, after the compatibility matrix's, and
    // the two tables do not share a line.
    const lines = w.readme!.split('\n')
    const compat = lines.findIndex(l => /^#{2,4} .*Compatibility matrix/i.test(l))
    const orch = lines.findIndex(l => /^#{2,4} .*Orchestration matrix/i.test(l))
    expect(orch, 'the orchestration matrix has no heading of its own').toBeGreaterThan(compat)
    // The compatibility matrix is still the six documented clients' and
    // nothing else: every row names one of them (Antigravity CLI is a row of
    // this table only).
    const compatRows = parseMatrix(w.readme!)
    expect(compatRows).toHaveLength(DOCUMENTED_CLIENTS.length)
    for (const r of compatRows) expect(DOCUMENTED_CLIENTS.some(c => r.client.startsWith(c)), `a compatibility row outside the documented clients: ${r.client}`).toBe(true)
    expect(m.rows.map(r => r.client)).toEqual(['Claude Code', 'Codex CLI', 'Antigravity CLI'])
    // One column per role: each names a role of the beta.3 cut, and the
    // six roles the ruling names are all there.
    const roles = m.header.map(h => h.toLowerCase())
    for (const role of ['headless worker', 'pen', 'tool calls captured', 'main that registers itself', 'subagent legs', 'pointer']) {
      expect(roles.some(h => h.includes(role)), `no column for the role "${role}" (columns: ${m.header.join(' | ')})`).toBe(true)
    }
    expect(m.header).toHaveLength(6)
  })
  reg.define(/^the developer sees every cell carry one of "verified live", "verified through a stand-in", "documented only" or "not possible", with the date it was checked against$/, (w: ClientsWorld) => {
    const m = parseOrchestrationMatrix(w.readme!)
    const ONE_STATUS = /verified live|verified through a stand-in|documented only|not possible/g
    for (const r of m.rows) for (const [i, cell] of r.cells.entries()) {
      const where = `${r.client} / ${m.header[i]}: "${cell}"`
      // Exactly one status in the cell, never two, never none.
      expect(cell.match(ONE_STATUS) ?? [], `${where} carries no single status`).toHaveLength(1)
      // Shape, not truth (as D153 reads): the cell carries the date it was
      // checked; whether the date is right is read on the vendor's page.
      expect(cell, `${where} carries no date`).toMatch(/\b\d{4}-\d{2}-\d{2}\b/)
    }
  })
  reg.define(/^the developer sees every "not possible" cell name what the client lacks$/, (w: ClientsWorld) => {
    const m = parseOrchestrationMatrix(w.readme!)
    const impossible = m.rows.flatMap(r => r.cells.filter(c => c.includes('not possible')).map(c => `${r.client}: ${c}`))
    // The needle fires: the matrix as written has such cells (Antigravity's
    // subagent legs and pointer), so a table with none is a changed table.
    expect(impossible.length, 'no "not possible" cell to read').toBeGreaterThan(0)
    for (const c of impossible) expect(c, `${c} names no gap`).toMatch(/not possible: no \w/)
  })


  // ── a teammate on another agent reads and writes through the tools (D152)
  reg.define(/^a teammate on Antigravity CLI with the treecontext server configured and no hooks$/, async (w: ClientsWorld) => {
    // Antigravity CLI is there by its own directory under ~/.gemini (D383),
    // with the real `agy` on the CLI's PATH to read back what install wrote.
    await openInstallWorld(w, [join('.gemini', 'antigravity-cli')])
    // An agy below the version whose hooks install writes (D413), so the
    // teammate has the server and no hooks; its listing is the real agy's.
    const real = realAgy()
    const bin = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-fake-agy-')))
    w.defer(() => rmSync(bin, { recursive: true, force: true }))
    writeFakeAgy(bin, '1.5.2', real)
    w.iAgyBin = bin
    w.iproj = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-clients-proj-')))
    w.defer(() => rmSync(w.iproj!, { recursive: true, force: true }))
    mkdirSync(w.iproj, { recursive: true })
    const run = tcCli(w, ['install', '--yes', '--agent', 'agy'])
    expect(run.status, run.out).toBe(0)
    const configPath = agentConfigPath('agy', w.ihome!)
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>
    }
    const entry = config.mcpServers?.['treecontext']
    expect(entry, 'Antigravity CLI has no treecontext server configured').toBeDefined()
    // agy's own listing names the server install wrote, as agy reads it.
    const listed = agyMcpList(w).servers.find(s => s.name === 'treecontext')
    expect(listed?.command.split(/\s+/)[0], 'agy does not list the treecontext server install wrote').toBe(entry!.command)
    // No hooks: agy's own hook file, and no Gemini CLI settings beside it.
    expect(existsSync(clientHookFile('agy', w.ihome!)!), 'install wrote agy hooks').toBe(false)
    expect(existsSync(join(w.ihome!, '.gemini', 'settings.json')), 'install wrote a Gemini CLI settings file').toBe(false)
    // The teammate's agent launches what agy's configuration names, the way
    // agy would: those args, over stdio, through the entry point the
    // configured launcher pins. One substitution, the one the install wave
    // already accepts: this suite drives the TypeScript source, so the
    // launcher's pinned cli.js is reached through its .ts twin under tsx —
    // the launcher itself would exec a dist/ build `npm test` never makes.
    expect(entry!.command, 'agy is not launched through the MCP launcher').toBe(mcpLauncherIn(w.ihome!))
    const pinned = launcherCliPath(readFileSync(entry!.command, 'utf8'))
    expect(pinned, 'the launcher pins no CLI').toBeTruthy()
    const cli = existsSync(pinned!) ? pinned! : pinned!.replace(/\.js$/, '.ts')
    expect(existsSync(cli), `the launcher's CLI does not exist: ${pinned}`).toBe(true)
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: nodeTsArgs(cli, entry!.args ?? []),
      env: { ...sandboxedSpawnEnv(w.ihome!), ...entry!.env } as Record<string, string>,
      cwd: w.iproj,
      stderr: 'pipe',
    })
    let serverErr = ''
    transport.stderr?.on('data', (d: Buffer) => { serverErr += d.toString() })
    const client = new Client({ name: 'agy-teammate', version: '0' })
    try {
      await client.connect(transport)
    } catch (err) {
      throw new Error(`the configured server did not start (${entry!.command} ${(entry!.args ?? []).join(' ')}): ${String(err)}\n${serverErr}`)
    }
    w.defer(async () => { await client.close() })
    w.teammate = client
  })
  reg.define(/^the teammate inserts "([^"]+)" and searches "([^"]+)"$/, async (w: ClientsWorld, ...captures) => {
    const [content, query] = captures as string[]
    const ins = parseToolResult(await w.teammate!.callTool({ name: 'treecontext_insert', arguments: { content } }))
    w.teammateNodeId = String(ins['node_id'] ?? ins['nodeId'] ?? '')
    expect(w.teammateNodeId, `insert returned no id: ${JSON.stringify(ins)}`).not.toBe('')
    const res = parseToolResult(await w.teammate!.callTool({ name: 'treecontext_query', arguments: { query, top_k: 5 } }))
    w.teammateHits = (res['results'] ?? []) as Array<{ nodeId?: string; content?: string }>
  })
  reg.define(/^the teammate finds the entry$/, (w: ClientsWorld) => {
    const hit = w.teammateHits!.find(h => h.nodeId === w.teammateNodeId)
    expect(hit, `search did not return the inserted entry: ${JSON.stringify(w.teammateHits)}`).toBeDefined()
    expect(hit!.content).toContain('compact layout')
    // And it is in the teammate's own store on disk, read straight from
    // SQLite: the tools wrote the journal, not a cache in front of it.
    const storesDir = join(w.ihome!, '.treecontext', 'stores')
    const dbs = readdirSync(storesDir, { recursive: true, encoding: 'utf8' })
      .filter(f => f.endsWith('treecontext.db')).map(f => join(storesDir, f))
    expect(dbs, `no store under the teammate's home: ${storesDir}`).toHaveLength(1)
    const db = new DatabaseSync(dbs[0]!, { readOnly: true })
    try {
      const row = db.prepare('SELECT content FROM nodes WHERE node_id = ?').get(w.teammateNodeId!) as { content: Buffer | string } | undefined
      expect(row, 'the inserted entry is not in the store').toBeDefined()
      expect(decodeContent(row!.content)).toBe('ux: the login form uses the compact layout')
    } finally {
      db.close()
    }
  })
  reg.define(/^the documentation the teammate reads promises no capture of their session$/, (w: ClientsWorld) => {
    // The README: Antigravity CLI's matrix row is documented only, and the
    // team section says plainly that other agents get the tools, not capture.
    // LF-normalized so the character-count window below means the same on an
    // autocrlf (Windows) checkout.
    const readme = readFileSync(join(TS_ROOT, 'README.md'), 'utf8').replace(/\r\n/g, '\n')
    const agy = parseMatrix(readme).find(r => r.client === 'Antigravity CLI')
    // The teammate's agy is below 1.5.3 (D413): the row promises capture
    // from 1.5.3 only, and the README says an older agy gets the tools only.
    expect(agy?.status).toMatch(/^verified live \(Antigravity CLI 1\.5\.3, .*from 1\.5\.3/)
    expect(readme.replace(/\s+/g, ' ')).toContain('below 1.5.3 Antigravity CLI, get the tools only')
    const team = readme.slice(readme.indexOf('### Working as a team'))
    expect(readme.indexOf('### Working as a team'), 'README has no team section').toBeGreaterThanOrEqual(0)
    // D412: capture is verified live on Claude Code and on Codex CLI from
    // 0.167.0; a teammate on agy with no hooks gets the tools only.
    expect(team.slice(0, 3000).replace(/\s+/g, ' ')).toMatch(/Capture is verified live on Claude Code, and on Codex CLI from 0\.167\.0[^.]*\.\*\* A teammate on Antigravity CLI[^.]*gets the tools[^.]*nothing of their session is captured/)
    // And the block install wrote into agy's own instructions file,
    // ~/.gemini/GEMINI.md, which the teammate's agent reads every session:
    // capture is Claude Code's.
    const block = readFileSync(join(w.ihome!, '.gemini', 'GEMINI.md'), 'utf8').replace(/\s+/g, ' ')
    expect(block).toContain('<!-- treecontext:start -->')
    expect(block).toMatch(/On Claude Code, conversation hooks auto-capture/)
    expect(block).toMatch(/On other agents nothing is captured for you/)
  })

  // ── doctor reports <client> as a client that <mode> (D161, D208) ──────
  //
  // Real files in a redirected HOME: the client's detection directory, the
  // Claude Code block written by the real installer, VS Code's own
  // settings.json in the JSON-with-comments form VS Code writes, then a
  // tools-only install and doctor read off its own stdout.
  const CLIENT_RE = '(Codex CLI|VS Code|Cursor|OpenCode|Antigravity CLI)'
  /** Antigravity CLI's own hook configuration, a hook of the developer's in it (D383: install leaves it alone). */
  const AGY_DEVELOPER_HOOKS = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'command', hooks: [{ type: 'command', command: '/usr/local/bin/audit-tool' }] }] } }, null, 2) + '\n'
  reg.define(new RegExp(`^${CLIENT_RE} is installed and its hook configuration holds no treecontext hooks$`), async (w: ClientsWorld, ...captures) => {
    const [client] = captures as string[]
    w.clientName = client!
    await openInstallWorld(w, [])
    mkdirSync(clientDir(CLIENT_SLUG[client!]!, w.ihome!), { recursive: true })
    if (client === 'Antigravity CLI') {
      // The real `agy` on the CLI's PATH, and its own hook file holding a
      // hook of the developer's and none of treecontext's.
      putAgyOnPath(w)
      const hooks = clientHookFile('agy', w.ihome!)!
      mkdirSync(join(hooks, '..'), { recursive: true })
      writeFileSync(hooks, AGY_DEVELOPER_HOOKS)
    }
    expect(treecontextHookMentions(clientHookFile(CLIENT_SLUG[client!]!, w.ihome!))).toEqual([])
  })
  reg.define(/^the Claude Code hooks block is installed and VS Code's Claude-hooks setting is off$/, (w: ClientsWorld) => {
    const run = tcCli(w, ['install', '--yes', '--agent', 'claude'])
    expect(run.status, run.out).toBe(0)
    const settings = JSON.parse(readFileSync(join(w.ihome!, '.claude', 'settings.json'), 'utf8')) as { hooks?: HookBlock }
    expect(settings.hooks, 'install wrote no Claude Code hooks block').toBeDefined()
    w.claudeBlock = settings.hooks!
    expect(Object.keys(w.claudeBlock), 'the Claude Code hooks block is missing events')
      .toEqual(expect.arrayContaining(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PreCompact', 'Stop']))
    if (w.clientName === 'VS Code' || w.clientName === 'Cursor' || w.clientName === 'OpenCode') {
      // The client's own entry and instructions, written by the real
      // installer: install writes no hooks for these three, so their row's
      // state is read with the tools wired.
      const wired = tcCli(w, ['install', '--yes', '--agent', CLIENT_SLUG[w.clientName]!])
      expect(wired.status, wired.out).toBe(0)
    }
    if (w.clientName === 'VS Code') {
      // Off said out loud, in the file VS Code keeps, with the comment and
      // trailing comma VS Code's own editor allows.
      writeFileSync(vscodeSettings(w.ihome!), '// VS Code user settings\n{\n  "editor.fontSize": 14,\n  "chat.useClaudeHooks": false,\n}\n')
    } else {
      // VS Code is not installed for the other four, so its setting is off
      // by absence: no settings file of VS Code's exists to turn it on.
      expect(existsSync(vscodeSettings(w.ihome!))).toBe(false)
    }
  })
  reg.define(/^the developer runs doctor$/, (w: ClientsWorld) => {
    // A client row with the D161 clause is cut into its halves; Claude
    // Code's row has none, and a sandbox scenario names no client.
    if (w.clientName && w.clientName !== 'Claude Code') {
      w.clause = readClause(w, w.clientName)
      return
    }
    const run = tcCli(w, ['doctor'])
    expect(run.status, run.out).toBe(0)
    w.doctorOut = run.stdout
  })
  reg.define(new RegExp(`^the developer sees doctor's row for ${CLIENT_RE} say the client (.+)$`), (w: ClientsWorld, ...captures) => {
    const [client, mode] = captures as string[]
    expect(client).toBe(w.clientName)
    const c = w.clause!
    // The mode is the README matrix's Mode cell, exactly, so a reworded
    // parenthetical on either side fails, and it carries the feature's phrase.
    const readmeRow = parseMatrix(readFileSync(join(TS_ROOT, 'README.md'), 'utf8')).find(r => r.client.startsWith(client!))
    expect(readmeRow, `the README matrix has no row for ${client}`).toBeDefined()
    expect(c.mode).toBe(readmeRow!.mode)
    expect(c.mode).toContain(mode)
  })
  reg.define(/^the row states the current installation state$/, (w: ClientsWorld) => {
    const c = w.clause!
    const home = w.ihome!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const expected: Record<string, RegExp> = {
      'Codex CLI': new RegExp(`^no treecontext hook is written in ${home}[\\\\/]\\.codex[\\\\/]hooks\\.json, so nothing of a Codex session is captured$`),
      'VS Code': new RegExp(`^chat\\.useClaudeHooks is off in ${vscodeSettings(w.ihome!).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} and the Claude Code hooks block is installed$`),
      'Cursor': /^the Claude Code hooks block is installed — Cursor reads it \(capture unverified\)$/,
      'OpenCode': /^no hooks to install — MCP tools only \(nothing is captured\)$/,
      'Antigravity CLI': new RegExp(`^no treecontext hook is written in ${home}[\\\\/]\\.gemini[\\\\/]config[\\\\/]hooks\\.json, so nothing of agy's sessions is captured(; agy's version reads [^;]+)?$`),
    }
    expect(c.state, `${c.row}\n  fix: ${c.fix}`).toMatch(expected[w.clientName!]!)
    if (w.clientName === 'Codex CLI' || w.clientName === 'Antigravity CLI') {
      // A client install writes hooks for, with none written: nothing of
      // its sessions is captured, which is a warning whose fix is install.
      expect(c.status, c.row).toBe('warn')
      expect(c.fix, c.row).toMatch(/^treecontext install\b/)
      return
    }
    // A client install writes no hooks for: tools only is its whole state,
    // so the row is not a warning and carries no fix line of its own.
    expect(c.status, c.row).toBe('ok')
    expect(c.fix).toBeNull()
  })
  reg.define(/^the row names (turning that setting on|nothing) as the remedy$/, (w: ClientsWorld, ...captures) => {
    const [remedy] = captures as string[]
    if (remedy === 'nothing' && w.approval) {
      // The headless clause's remedy (D387): nothing, and no fix line.
      expect(w.approval.remedy).toBe('nothing to do')
      expect(w.approval.fix, w.approval.row).toBeNull()
      return
    }
    const c = w.clause!
    if (remedy === 'nothing') {
      expect(c.remedy).toBe('nothing to do')
      return
    }
    // Turning the setting on: the remedy names it and names no install; once
    // the developer turns it on in VS Code's own file, doctor says VS Code
    // runs the installed block and there is nothing left to do.
    expect(c.remedy).toBe("to have VS Code run the Claude Code hooks: turn chat.useClaudeHooks on in VS Code's settings (capture there stays unverified)")
    writeFileSync(vscodeSettings(w.ihome!), '// VS Code user settings\n{\n  "editor.fontSize": 14,\n  "chat.useClaudeHooks": true,\n}\n')
    const after = readClause(w, 'VS Code')
    expect(after.state).toMatch(/^chat\.useClaudeHooks is on in .* and the Claude Code hooks block is installed — VS Code runs it/)
    expect(after.remedy).toBe('nothing to do')
    expectNoVerifiedClaim(after.row)
  })

  // ── D407, D161: Codex's own block, read against what Codex says ─────
  // A real install and a real doctor under a redirected HOME; the real
  // Codex on PATH (0.167.0 on the binding host) answers doctor's
  // `hooks/list`, and the developer's /hooks trust is the stand-in's, with
  // Codex's own hashes (standins.ts developerTrustsCodexHooks).
  reg.define(/^Codex CLI 0\.167\.0 is installed and its hook configuration holds (the block this build writes for Codex, every hook of it trusted|a block that differs from the one this build writes for Codex)$/, async (w: ClientsWorld, held: unknown) => {
    w.clientName = 'Codex CLI'
    await openInstallWorld(w, ['.claude', '.codex'])
    const run = tcCli(w, ['install', '--yes', '--agent', 'codex'])
    expect(run.status, run.out).toBe(0)
    await developerTrustsCodexHooks(w.ihome!, w.iproj ?? w.ihome!)
    if (String(held).startsWith('a block that differs')) {
      // One event of treecontext's own block taken out by hand.
      const file = join(w.ihome!, '.codex', 'hooks.json')
      const data = JSON.parse(readFileSync(file, 'utf8')) as { hooks: Record<string, unknown> }
      delete data.hooks['Stop']
      writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
    }
  })
  reg.define(/^the developer sees doctor's row for (Codex CLI) read present and (consistent|inconsistent)$/, (w: ClientsWorld, ...captures) => {
    const [client, verdict] = captures as string[]
    expect(client).toBe(w.clientName)
    const c = w.clause!
    const readmeRow = parseMatrix(readFileSync(join(TS_ROOT, 'README.md'), 'utf8')).find(r => r.client === client)
    expect(c.mode).toBe(readmeRow!.mode)
    expect(c.state).toContain(`treecontext's hooks in ${join(w.ihome!, '.codex', 'hooks.json')}: present and ${verdict} with Codex's block`)
    if (verdict === 'consistent') {
      expect(c.status, c.row).toBe('ok')
      expect(c.state).toContain('Codex runs treecontext\'s hooks')
      expect(c.remedy).toBe('nothing to do')
      expect(c.fix).toBeNull()
    } else {
      expect(c.status, c.row).toBe('warn')
      // It says where the block went wrong, in Codex's own event names.
      expect(c.state).toMatch(/differs on Stop\b/)
    }
  })
  reg.define(/^the row names `treecontext install --agent codex` as the command that rewrites it$/, (w: ClientsWorld) => {
    const c = w.clause!
    expect(c.remedy).toBe('treecontext install --agent codex, which rewrites them')
    expect(c.fix).toBe('treecontext install --agent codex')
    // The command does what it says: run as printed, the row reads the
    // block consistent again (its hooks then wait for /hooks, as written).
    const run = tcCli(w, ['install', '--agent', 'codex', '--yes'])
    expect(run.status, run.out).toBe(0)
    expect(readClause(w, 'Codex CLI').state).toContain(': present and consistent with Codex\'s block')
  })

  // ── doctor's Codex row says whether a headless worker can use the tools
  //    (D387, D381), and the off state as a choice (D390) ───────────────
  //
  // A real install and a real doctor under a redirected HOME, the written
  // file edited the way the Given says; each row's status is read with its
  // words, since the hollow green D387 prevents is an [ok] whose text says
  // ready. The approvals clause names its own remedy inside the row, and a
  // warning row's fix line is that remedy.
  const codexFile = (w: ClientsWorld): string => agentConfigPath('codex', w.ihome!)
  /** Doctor's row for a client, its status, its headless or approvals clause and that clause's remedy, and its fix line. */
  const approvalRow = (w: ClientsWorld, client: 'Claude Code' | 'Codex CLI' | 'Antigravity CLI', fresh = true): ApprovalRowRead => {
    if (fresh || w.doctorOut === undefined) {
      const run = tcCli(w, ['doctor'])
      expect(run.status, run.out).toBe(0)
      w.doctorOut = run.stdout
    }
    const out = w.doctorOut
    const lines = out.split('\n')
    const i = lines.findIndex(l => new RegExp(`^\\[(ok|warn|err)\\]\\s+${client}:`).test(l))
    expect(i, `doctor printed no ${client} row:\n${out}`).toBeGreaterThanOrEqual(0)
    const row = lines[i]!
    const label = client === 'Claude Code' ? 'tool approvals' : 'headless workers'
    const m = new RegExp(`${label}: (.+?); remedy: (.+?)(?:\\. Hooks: the client .*)?$`).exec(row)
    expect(m, `doctor's ${client} row says nothing about headless workers:\n${row}`).not.toBeNull()
    const fix = /^\s+fix: (.+)$/.exec(lines[i + 1] ?? '')?.[1] ?? null
    return { status: /^\[(\w+)\]/.exec(row)![1]!, row, clause: m![1]!, remedy: m![2]!, fix }
  }
  const editCodexEntry = (w: ClientsWorld, edit: (entry: Record<string, unknown>) => void): void => {
    const path = codexFile(w)
    const toml = parseToml(readFileSync(path, 'utf8')) as Record<string, Record<string, Record<string, unknown>>>
    edit(toml['mcp_servers']!['treecontext']!)
    writeFileSync(path, stringifyToml(toml) + '\n')
  }
  const CODEX_STATES: Record<string, (w: ClientsWorld) => void> = {
    'forwards the worker variables and approves the four tools': () => { /* as install wrote it */ },
    'lacks the worker variables': (w) => editCodexEntry(w, (e) => { delete e['env_vars'] }),
    'approves none of the four tools, with no choice of the developer\'s recorded': (w) => editCodexEntry(w, (e) => { delete e['tools'] }),
    'carries the developer\'s approval for treecontext_insert set to prompt': (w) => editCodexEntry(w, (e) => {
      (e['tools'] as Record<string, Record<string, unknown>>)['treecontext_insert'] = { approval_mode: 'prompt' }
    }),
    'carries the developer\'s default approving every tool': (w) => editCodexEntry(w, (e) => { e['default_tools_approval_mode'] = 'approve' }),
  }
  reg.define(/^Codex CLI is installed and its treecontext entry (.+)$/, async (w: ClientsWorld, ...captures) => {
    const [state] = captures as string[]
    const edit = CODEX_STATES[state!]
    expect(edit, `no setup for a Codex entry that ${state}`).toBeDefined()
    w.clientName = 'Codex CLI'
    await openInstallWorld(w, ['.claude', '.codex'])
    const run = tcCli(w, ['install', '--yes'])
    expect(run.status, run.out).toBe(0)
    // D406: install wrote Codex's own hooks; the developer took the one
    // step install leaves and trusted them with /hooks (the stand-in writes
    // the records with Codex's own hashes), so the row grades the rest.
    await developerTrustsCodexHooks(w.ihome!, w.iproj ?? w.ihome!)
    edit!(w)
    // No choice of the developer's is recorded for any row.
    const statePath = join(w.ihome!, '.treecontext', 'install-state.json')
    const record = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) as { toolApprovals?: { off?: unknown } } : {}
    expect(record.toolApprovals?.off).toBeUndefined()
  })
  reg.define(/^the developer sees doctor's row for Codex CLI (read that headless workers can use the tools|warn that a worker's rows would land in no lane|warn that a `codex exec` worker would be refused every treecontext call|warn that a `codex exec` worker would be refused treecontext_insert|say in words that a headless worker can also clear, delete, import and merge, and not warn)$/, (w: ClientsWorld, ...captures) => {
    const [say] = captures as string[]
    const r = approvalRow(w, 'Codex CLI', false)
    w.approval = r
    const path = codexFile(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    switch (say) {
      case 'read that headless workers can use the tools':
        expect(r.status, r.row).toBe('ok')
        expect(r.clause).toMatch(new RegExp(`^can use the tools — TREECONTEXT_TICKET and TREECONTEXT_WORKER_SESSION forwarded, status, query, export and insert approved in ${path}$`))
        break
      case "warn that a worker's rows would land in no lane":
        expect(r.status, r.row).toBe('warn')
        expect(r.clause).toMatch(/^a worker's rows would land in no lane — the entry does not forward TREECONTEXT_TICKET and TREECONTEXT_WORKER_SESSION \(env_vars\)$/)
        break
      case 'warn that a `codex exec` worker would be refused every treecontext call':
        expect(r.status, r.row).toBe('warn')
        expect(r.clause).toMatch(new RegExp(`^a \`codex exec\` worker would be refused every treecontext call — none of status, query, export and insert is approved in ${path}$`))
        break
      case 'warn that a `codex exec` worker would be refused treecontext_insert':
        expect(r.status, r.row).toBe('warn')
        expect(r.clause).toMatch(new RegExp(`^a \`codex exec\` worker would be refused treecontext_insert — insert refused by your mcp_servers\\.treecontext\\.tools\\.treecontext_insert\\.approval_mode = "prompt" in ${path}$`))
        // Refused that one alone: the anchored clause names no other tool.
        break
      default:
        expect(r.status, r.row).toBe('ok')
        expect(r.clause).toMatch(new RegExp(`^can use the tools — .* approved in ${path}; clear, delete, import and merge approved by your mcp_servers\\.treecontext\\.default_tools_approval_mode = "approve" in ${path}, so a headless worker can also clear, delete, import and merge`))
    }
  })
  reg.define(/^the row names (`treecontext install --agent codex`|the line in Codex's configuration that sets it) as the remedy$/, (w: ClientsWorld, ...captures) => {
    const [remedy] = captures as string[]
    // D407: the hooks clause's remedy, where the scenario read that clause.
    if (!w.approval && w.clause) {
      expect(remedy).toBe('`treecontext install --agent codex`')
      expect(w.clause.remedy.startsWith('treecontext install --agent codex'), w.clause.remedy).toBe(true)
      return
    }
    const r = w.approval!
    if (remedy === '`treecontext install --agent codex`') {
      expect(r.remedy).toBe('treecontext install --agent codex')
      expect(r.fix).toBe('treecontext install --agent codex')
      // The remedy does what it says: run as printed, the row reads ready.
      runNamedCommand(w, r.fix!)
      const after = approvalRow(w, 'Codex CLI')
      expect(after.status, after.row).toBe('ok')
      expect(after.clause).toMatch(/^can use the tools — /)
      return
    }
    // The developer's line, named where it is: install leaves it, and so
    // a plain install changes nothing about it.
    const line = `your mcp_servers.treecontext.tools.treecontext_insert.approval_mode = "prompt" in ${codexFile(w)}, yours to change (install leaves it)`
    expect(r.remedy).toBe(line)
    expect(r.fix).toBe(line)
    runNamedCommand(w, 'treecontext install --agent codex')
    expect(approvalRow(w, 'Codex CLI').clause).toBe(r.clause)
  })

  // ── the command doctor's Codex row names makes it ready (D387, D51) ──
  reg.define(/^Codex CLI whose treecontext entry an earlier build wrote, without the worker variables or the four approvals$/, async (w: ClientsWorld) => {
    w.clientName = 'Codex CLI'
    await openInstallWorld(w, ['.claude', '.codex'])
    const run = tcCli(w, ['install', '--yes'])
    expect(run.status, run.out).toBe(0)
    // D406: install wrote Codex's own hooks; the developer took the one
    // step install leaves and trusted them with /hooks (the stand-in writes
    // the records with Codex's own hashes), so the row grades the rest.
    await developerTrustsCodexHooks(w.ihome!, w.iproj ?? w.ihome!)
    // The beta.3 shape: the server in capture mode, no variables, no
    // approvals, and no record of any.
    editCodexEntry(w, (e) => {
      delete e['env_vars']
      delete e['tools']
      e['args'] = ['serve', '--transport', 'stdio', '--capture', '--debug', '--lexical']
    })
    rmSync(join(w.ihome!, '.treecontext', 'install-state.json'), { force: true })
    const before = approvalRow(w, 'Codex CLI')
    expect(before.status).toBe('warn')
    expect(before.clause).toMatch(/would land in no lane.*refused every treecontext call/)
    w.approval = before
  })
  reg.define(/^the developer runs the command doctor's row for Codex CLI names, and then doctor again$/, (w: ClientsWorld) => {
    const r = w.approval!
    expect(r.fix, `doctor's Codex row names no command:\n${r.row}`).not.toBeNull()
    runNamedCommand(w, r.fix!)
    w.approval = approvalRow(w, 'Codex CLI')
  })
  // ── Codex's own sandbox check, on Linux (D387) ──────────────────────
  //
  // [stand-in] for the system's answer: a `codex` on PATH whose sandbox
  // check answers by plan (writeFakeCodex, tests/journal/standins.ts). The
  // real check, which passes on the dogfood machine since its AppArmor
  // profile was loaded, is held to the same row by the real-Codex test in
  // tests/server/tool-approvals.test.ts.
  const SANDBOX_PLANS: Record<string, { exit: number; stderr: string }> = {
    passes: { exit: 0, stderr: '' },
    'fails because the system refuses bubblewrap a user namespace': { exit: 1, stderr: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted' },
    'fails for another reason': { exit: 101, stderr: "thread 'main' panicked at linux-sandbox/src/linux_run_main.rs:1193:5:\nFailed to execvp true: Permission denied (os error 13)" },
  }
  const sandboxRowOf = (out: string): string | null => {
    const lines = out.split('\n')
    const i = lines.findIndex(l => /^\[(ok|warn|err)\]\s+Codex sandbox:/.test(l))
    if (i < 0) return null
    return /^\s+fix: /.test(lines[i + 1] ?? '') ? `${lines[i]}\n${lines[i + 1]}` : lines[i]!
  }
  reg.define(/^a Linux machine with Codex CLI installed, whose sandbox check (passes|fails because the system refuses bubblewrap a user namespace|fails for another reason)$/, async (w: ClientsWorld, ...captures) => {
    const [result] = captures as string[]
    await openInstallWorld(w, ['.claude', '.codex'])
    setFakeCodex(w, { version: CODEX_APPROVALS_FLOOR, sandbox: SANDBOX_PLANS[result!]! })
    const run = tcCli(w, ['install', '--yes'])
    expect(run.status, run.out).toBe(0)
  })
  reg.define(/^the developer sees doctor's row for Codex's sandbox (read ok|warn that a sandboxed Codex worker can read no file, .+|warn with the check's own words)$/, (w: ClientsWorld, ...captures) => {
    const [row] = captures as string[]
    const printed = sandboxRowOf(w.doctorOut!)
    if (process.platform !== 'linux') {
      // The ruling's other shape (D387): Codex sandboxes with bubblewrap on
      // Linux alone, so on this OS the same Codex, with a check that would
      // answer, gets no row at all; the Linux lanes bind the rows.
      expect(w.doctorOut).toMatch(/^\[(ok|warn)\]\s+Codex CLI:/m)
      expect(printed, w.doctorOut).toBeNull()
      return
    }
    expect(printed, `doctor printed no row for Codex's sandbox:\n${w.doctorOut}`).not.toBeNull()
    if (row === 'read ok') {
      expect(printed).toMatch(/^\[ok\]\s+Codex sandbox: `codex sandbox -- true` passed/)
      return
    }
    expect(printed).toMatch(/^\[warn\]\s+Codex sandbox: `codex sandbox -- true` failed/)
    if (row === "warn with the check's own words") {
      // Quoted as the check said it, and no namespace steps it did not ask for.
      expect(printed).toContain("thread 'main' panicked at linux-sandbox/src/linux_run_main.rs:1193:5: / Failed to execvp true: Permission denied (os error 13)")
      // step-lint: allow unearned-absence -- the user-namespace row of this same outline asserts "install the bubblewrap package" and the AppArmor profile present in the same row shape
      expect(printed).not.toMatch(/apparmor|bubblewrap/i)
      return
    }
    expect(printed).toContain('bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted')
    expect(printed).toMatch(/a sandboxed Codex worker can read no file/)
    expect(printed).toMatch(/Steps for you to run, as root: install the bubblewrap package/)
    expect(printed).toContain('write an AppArmor profile that lets /usr/bin/bwrap create user namespaces at /etc/apparmor.d/bwrap: abi <abi/4.0>, include <tunables/global> profile bwrap /usr/bin/bwrap flags=(unconfined) { userns, include if exists <local/bwrap> }')
    expect(printed).toMatch(/load it with sudo apparmor_parser -r \/etc\/apparmor\.d\/bwrap/)
    expect(printed).toMatch(/treecontext changes no system file/)
  })
  reg.define(/^a machine that is not Linux, or a Linux machine with no Codex CLI$/, async (w: ClientsWorld) => {
    await openInstallWorld(w, ['.claude'])
    if (process.platform === 'linux') {
      // No Codex CLI: no codex on the CLI's PATH, though a ~/.codex an
      // uninstalled Codex left behind is still there, so doctor detects the
      // directory and must still find no Codex to check.
      w.iPathWithoutCodex = pathWithoutCodex(w)
      mkdirSync(join(w.ihome!, '.codex'), { recursive: true })
    } else {
      // Not Linux: Codex installed, with a sandbox check that would fail
      // if doctor ran it.
      mkdirSync(join(w.ihome!, '.codex'), { recursive: true })
      setFakeCodex(w, { version: CODEX_APPROVALS_FLOOR, sandbox: { exit: 1, stderr: 'bwrap: setting up uid map: Permission denied' } })
    }
    const run = tcCli(w, ['install', '--yes'])
    expect(run.status, run.out).toBe(0)
  })
  reg.define(/^the developer sees no row for Codex's sandbox$/, (w: ClientsWorld) => {
    // The needle fires: doctor printed its client rows.
    expect(w.doctorOut).toMatch(/^\[ok\]\s+Claude Code:/m)
    expect(sandboxRowOf(w.doctorOut!), w.doctorOut).toBeNull()
    // step-lint: allow unearned-absence -- the sandbox outline asserts "`codex sandbox -- true` passed" and "failed" present in doctor's report of the same shape
    expect(w.doctorOut).not.toMatch(/codex sandbox -- true/)
  })

  // ── the off state, a choice (D390, D387) ────────────────────────────
  reg.define(/^(Claude Code|Codex CLI|Antigravity CLI) wired by install, and tool approvals turned off with `treecontext config tool-approvals off`$/, async (w: ClientsWorld, ...captures) => {
    const [client] = captures as string[]
    w.clientName = client!
    await openInstallWorld(w, client === 'Codex CLI' ? ['.claude', '.codex'] : ['.claude'])
    if (client === 'Antigravity CLI') putAgyOnPath(w)
    expect(tcCli(w, ['install', '--yes']).status).toBe(0)
    if (client === 'Codex CLI') await developerTrustsCodexHooks(w.ihome!, w.iproj ?? w.ihome!)
    const off = tcCli(w, ['config', 'tool-approvals', 'off'])
    expect(off.status, off.out).toBe(0)
  })
  reg.define(/^the developer sees doctor's row for (Claude Code|Codex CLI|Antigravity CLI) say tool approvals are off by the developer's choice and that headless workers will be refused the four tools$/, (w: ClientsWorld, ...captures) => {
    const [client] = captures as string[]
    const r = approvalRow(w, client as 'Claude Code' | 'Codex CLI' | 'Antigravity CLI', false)
    w.approval = r
    expect(r.clause).toMatch(/\boff by your choice \(treecontext config tool-approvals off or install --no-tool-approvals\), so headless workers will be refused status, query, export and insert\b/)
  })
  reg.define(/^the row does not count it as a failure$/, (w: ClientsWorld) => {
    const r = w.approval!
    expect(r.status, r.row).toBe('ok')
    expect(r.fix, r.row).toBeNull()
    // The indexer's summary does not count the client as wrong either.
    expect(w.doctorOut).toMatch(/^\[ok\]\s+Conversation indexer:/m)
  })
  reg.define(/^the row names `treecontext config tool-approvals on` as the remedy$/, (w: ClientsWorld) => {
    const r = w.approval!
    expect(r.remedy).toBe('treecontext config tool-approvals on')
    // Run as printed, the approvals are back and the row reads ready.
    runNamedCommand(w, r.remedy)
    const after = approvalRow(w, w.clientName as 'Claude Code' | 'Codex CLI' | 'Antigravity CLI')
    expect(after.status, after.row).toBe('ok')
    // step-lint: allow unearned-absence -- the Then before this one in the same scenario asserts "off by your choice" present in this clause before the remedy ran
    expect(after.clause).not.toMatch(/off by your choice/)
    expect(after.clause).toMatch(w.clientName === 'Codex CLI' ? /^can use the tools — / : w.clientName === 'Antigravity CLI' ? /^an `agy -p` worker can use status, query, export and insert, allowed in / : /^status, query, export and insert allowed in /)
  })

  // ── doctor's row for Antigravity CLI (D387, D383) ───────────────────
  //
  // A real install and a real doctor under a redirected HOME with the real
  // `agy` on the CLI's PATH; the written files are edited the way the Given
  // says, and agy's own `agy mcp list` confirms the MCP half of each state
  // from the other side. agy prints no permission rules, so the rule half is
  // the file agy reads, ~/.gemini/antigravity-cli/settings.json, edited as a
  // developer edits it. Each row's status is read with its words.
  //
  // Half-lit, on purpose: the outline's states are all in agy's global
  // settings file, and its words do not reach a project file. The project
  // layer doctor also reads (agy's undocumented project-file format: the
  // nearest project by realpath, a bare "/" as a weak match, the project's
  // rules over the global ones, a rule in an undocumented shape that may
  // decide) is unit-tested in tests/server/agy-client.test.ts, not bound here.
  const agySettingsFile = (w: ClientsWorld): string => join(w.ihome!, '.gemini', 'antigravity-cli', 'settings.json')
  const editAgySettings = (w: ClientsWorld, edit: (perms: Record<string, unknown[]>) => void): void => {
    const data = JSON.parse(readFileSync(agySettingsFile(w), 'utf8')) as Record<string, unknown>
    const perms = (data['permissions'] ?? {}) as Record<string, unknown[]>
    edit(perms)
    data['permissions'] = perms
    writeFileSync(agySettingsFile(w), JSON.stringify(data, null, 2) + '\n')
  }
  const AGY_INSERT = 'mcp(treecontext/treecontext_insert)'
  const AGY_STATES: Record<string, (w: ClientsWorld) => void> = {
    'install has wired it': (w) => {
      expect(agyMcpList(w).servers.find(s => s.name === 'treecontext')?.status).toBe('enabled')
    },
    'its MCP configuration holds no treecontext server': (w) => {
      const path = agentConfigPath('agy', w.ihome!)
      const data = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers: Record<string, unknown> }
      delete data.mcpServers['treecontext']
      data.mcpServers['github'] = { command: 'github-mcp' }
      writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
      // agy itself now lists no treecontext server.
      expect(agyMcpList(w).servers.map(s => s.name)).toEqual(['github'])
    },
    'the allow rule for treecontext_insert is missing': (w) => editAgySettings(w, (p) => {
      p['allow'] = (p['allow'] ?? []).filter(r => r !== AGY_INSERT)
    }),
    "the developer's ask rule stands over treecontext_insert": (w) => editAgySettings(w, (p) => { p['ask'] = [AGY_INSERT] }),
    // D414: agy's own preset, `toolPermission` in the settings it reads.
    "install has wired it and agy's permission preset is `always-proceed`": (w) => setAgyPreset(w, 'always-proceed'),
    "install has wired it and agy's permission preset is `request-review`": (w) => setAgyPreset(w, 'request-review'),
    "install has wired it and agy's settings set no permission preset": (w) => setAgyPreset(w, undefined),
    "agy's permission preset is a value doctor does not know": (w) => setAgyPreset(w, 'yolo-mode'),
    "agy's settings file does not parse": (w) => writeFileSync(agySettingsFile(w), readFileSync(agySettingsFile(w), 'utf8').replace('{', '{,')),
  }
  const setAgyPreset = (w: ClientsWorld, preset: string | undefined): void => {
    const data = JSON.parse(readFileSync(agySettingsFile(w), 'utf8')) as Record<string, unknown>
    if (preset === undefined) delete data['toolPermission']; else data['toolPermission'] = preset
    writeFileSync(agySettingsFile(w), JSON.stringify(data, null, 2) + '\n')
  }
  reg.define(new RegExp(`^Antigravity CLI is installed and (${Object.keys(AGY_STATES).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`), async (w: ClientsWorld, ...captures) => {
    const [state] = captures as string[]
    w.clientName = 'Antigravity CLI'
    await openInstallWorld(w, [])
    putAgyOnPath(w)
    const run = tcCli(w, ['install', '--yes'])
    expect(run.status, run.out).toBe(0)
    expect(run.out).toMatch(/^Detected agents: .*Antigravity CLI/m)
    AGY_STATES[state!]!(w)
  })
  const AGY_SAYS: Record<string, (w: ClientsWorld) => void> = {
    'read that headless workers can use the four tools, name the preset, and say that under it every tool runs unasked': (w) => {
      const r = agyHeadless(w)
      expect(r.clause).toMatch(/^an `agy -p` worker can use status, query, export and insert, allowed in .*; agy's permission preset is `always-proceed`: under it every tool runs unasked/)
    },
    'read that headless workers can use the four tools, name the preset, and say that a worker needing any other tool may be refused it and return nothing unless the developer allows that tool': (w) => {
      const r = agyHeadless(w)
      expect(r.clause).toMatch(/^an `agy -p` worker can use status, query, export and insert, allowed in .*; agy's permission preset is `request-review`: a worker needing any other tool, a shell command among them, may be refused it in a headless run and return nothing .* unless you allow that tool/)
    },
    'read that headless workers can use the four tools, say that no preset is set, and that a worker needing any other tool may be refused it and return nothing unless the developer allows that tool': (w) => {
      const r = agyHeadless(w)
      expect(r.clause).toMatch(/^an `agy -p` worker can use status, query, export and insert, allowed in .*; agy's permission preset is not set \(toolPermission is absent from its settings\): a worker needing any other tool, .* may be refused it in a headless run and return nothing .* unless you allow that tool/)
    },
    'say that it does not know that preset, naming it, never guessing what it lets a worker do': (w) => {
      const r = agyHeadless(w)
      expect(r.clause).toContain('agy\'s permission preset reads "yolo-mode", a preset doctor does not know, so it does not say what it lets a headless worker do')
      // step-lint: allow unearned-absence -- the always-proceed and request-review rows of this outline find these very phrases in the same clause
      expect(r.clause).not.toMatch(/runs unasked|may be refused it in a headless run/)
    },
    'say that it cannot read agy\'s permission preset, quoting the parse error, never guessing it': (w) => {
      const r = agyHeadless(w, 'warn')
      let err = ''
      try { JSON.parse(readFileSync(agySettingsFile(w), 'utf8')) } catch (e) { err = (e as Error).message.replace(/\s+/g, ' ').trim() }
      expect(r.clause).toContain(`does not parse (${err}), and install adds no rule to it; doctor cannot read agy's permission preset from it, and does not guess it`)
      // step-lint: allow unearned-absence -- every preset row of this outline finds "permission preset is" in the same clause
      expect(r.clause).not.toMatch(/permission preset is/)
    },
    'warn that agy has no treecontext tools': (w) => {
      const r = agyHeadless(w, 'warn')
      expect(r.clause).toBe(`agy has no treecontext tools — ${agentConfigPath('agy', w.ihome!)} holds no treecontext server`)
    },
    'warn that an `agy -p` worker would be refused treecontext_insert': (w) => {
      const r = agyHeadless(w, 'warn')
      expect(r.clause).toMatch(new RegExp(`^an \`agy -p\` worker would be refused treecontext_insert — insert is not allowed in ${esc(agySettingsFile(w))}(;|$)`))
    },
    "warn that an `agy -p` worker would be refused treecontext_insert, naming the developer's rule and its file": (w) => {
      const r = agyHeadless(w, 'warn')
      expect(r.clause).toMatch(new RegExp(`^an \`agy -p\` worker would be refused treecontext_insert — insert refused by your ask rule mcp\\(treecontext/treecontext_insert\\) in ${esc(agySettingsFile(w))}(;|$)`))
    },
    // D414: the hooks half of the same row (the D161 clause).
    'read that treecontext\'s hooks are present and current, and the server\'s mode as correct': (w) => {
      expect(w.clause!.status, w.clause!.row).toBe('ok')
      expect(w.clause!.state).toMatch(/^treecontext's hooks are present in .*hooks\.json and current \(the named hook "treecontext"\)$/)
      expect(w.clause!.row).toContain('server mode: capture (this client: its own hooks)')
    },
    'warn that nothing of agy\'s sessions is captured': (w) => {
      expect(w.clause!.status).toBe('warn')
      expect(w.clause!.state).toMatch(/^no treecontext hook is written in .*, so nothing of agy's sessions is captured$/)
    },
    'warn that the hook is an earlier build\'s, naming the events it lacks': (w) => {
      expect(w.clause!.status).toBe('warn')
      expect(w.clause!.state).toMatch(/is an earlier build's, differing on PostInvocation$/)
    },
    'read that agy is tools-only, naming 1.5.2 and 1.5.3 as the first version whose hooks install writes': (w) => {
      expect(w.clause!.state).toBe('agy is tools-only: its version reads 1.5.2, and 1.5.3 is the first version whose hooks install writes')
    },
    'read that agy is tools-only, its version not read': (w) => {
      expect(w.clause!.state).toBe('agy is tools-only: its version could not be read (agy --version)')
    },
    'say that capture is switched off there by the developer\'s choice, nothing of agy\'s sessions captured': (w) => {
      expect(w.clause!.state).toMatch(/is switched off with "enabled": false, the developer's choice, so nothing of agy's sessions is captured$/)
    },
    'warn that the name is taken by a hook install did not write, so nothing of agy\'s sessions is captured': (w) => {
      expect(w.clause!.status).toBe('warn')
      expect(w.clause!.state).toMatch(/^the name "treecontext" in .* is taken by a hook install did not write, so nothing of agy's sessions is captured$/)
    },
    'read that treecontext\'s hooks are present, naming 1.6.0 beside 1.5.3, the version whose transcript capture reads': (w) => {
      expect(w.clause!.state).toMatch(/present in .* and current \(the named hook "treecontext"\); agy's version reads 1\.6\.0, and capture reads agy's transcript in the layout recorded at 1\.5\.3$/)
    },
    'warn, quoting the parse error, that agy runs none of the hooks in that file, the developer\'s own included': (w) => {
      expect(w.clause!.status).toBe('warn')
      let err = ''
      try { JSON.parse(readFileSync(agyHooksPath(w), 'utf8')) } catch (e) { err = (e as Error).message.replace(/\s+/g, ' ').trim() }
      expect(w.clause!.state).toContain(`does not parse (${err}), so agy runs none of the hooks in that file, the developer's own included`)
    },
  }
  const esc = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const agyHeadless = (w: ClientsWorld, status?: 'ok' | 'warn'): ApprovalRowRead => {
    const r = approvalRow(w, 'Antigravity CLI', false)
    w.approval = r
    if (status) expect(r.status, r.row).toBe(status)
    return r
  }
  reg.define(new RegExp(`^the developer sees doctor's row for Antigravity CLI (${Object.keys(AGY_SAYS).map(esc).join('|')})$`), (w: ClientsWorld, say: unknown) => {
    AGY_SAYS[String(say)]!(w)
  })
  const agyHooksPath = (w: ClientsWorld): string => join(w.ihome!, '.gemini', 'config', 'hooks.json')
  const AGY_HOOK_STATES: Record<string, { version: string | null; hooks?: (w: ClientsWorld) => void }> = {
    'its version reads 1.5.3 and its hooks file holds the named hook this build writes': { version: '1.5.3' },
    'its version reads 1.5.3 and its hooks file holds no treecontext hook': { version: '1.5.3', hooks: (w) => writeFileSync(agyHooksPath(w), '{\n  "audit": { "Stop": [ { "type": "command", "command": "/usr/local/bin/audit" } ] }\n}\n') },
    'its hooks file holds the named hook an earlier build wrote, wired for fewer events': { version: '1.5.3', hooks: (w) => {
      const d = JSON.parse(readFileSync(agyHooksPath(w), 'utf8')) as Record<string, Record<string, unknown>>
      delete d['treecontext']!['PostInvocation']
      writeFileSync(agyHooksPath(w), JSON.stringify(d, null, 1) + '\n')
    } },
    'its version reads 1.5.2': { version: '1.5.2' },
    'its version cannot be read': { version: null },
    'its hooks file holds the named hook this build writes, switched off with `enabled: false`': { version: '1.5.3', hooks: (w) => {
      writeFileSync(agyHooksPath(w), readFileSync(agyHooksPath(w), 'utf8').replace('"treecontext": {', '"treecontext": {\n  "enabled": false,'))
    } },
    'its hooks file holds a hook of the developer\'s named treecontext': { version: '1.5.3', hooks: (w) => writeFileSync(agyHooksPath(w), '{ "treecontext": { "Stop": [ { "type": "command", "command": "/usr/local/bin/my-tree-tool" } ] } }\n') },
    'its version reads 1.6.0 and its hooks file holds the named hook this build writes': { version: '1.6.0' },
    'its hooks file does not parse': { version: '1.5.3', hooks: (w) => writeFileSync(agyHooksPath(w), '{ "audit": { "Stop": [ ,] } }\n') },
  }
  reg.define(new RegExp(`^Antigravity CLI is installed and (${Object.keys(AGY_HOOK_STATES).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`), async (w: ClientsWorld, state: unknown) => {
    const st = AGY_HOOK_STATES[String(state)]!
    w.clientName = 'Antigravity CLI'
    await openInstallWorld(w, [])
    mkdirSync(join(w.ihome!, '.gemini', 'antigravity-cli'), { recursive: true })
    // The agy whose version install and doctor read: the stand-in.
    const bin = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-fake-agy-')))
    w.defer(() => rmSync(bin, { recursive: true, force: true }))
    // Install ran at the version the row names, or at 1.5.3 before the
    // row's change to the hooks file.
    writeFakeAgy(bin, st.hooks ? '1.5.3' : st.version)
    w.iAgyBin = bin
    const run = tcCli(w, ['install', '--yes', '--agent', 'agy'])
    expect(run.status, run.out).toBe(0)
    st.hooks?.(w)
    writeFakeAgy(bin, st.version)
  })
  reg.define(/^the row names (upgrading agy, then `treecontext install --agent agy`|turning it on, the developer's to do|renaming that hook, the developer's to do|fixing the file by hand) as the remedy$/, (w: ClientsWorld, remedy: unknown) => {
    const r = String(remedy)
    if (r === 'fixing the file by hand') {
      // The headless clause's remedy: the settings file, by hand.
      expect(w.approval!.remedy).toMatch(new RegExp(`^fix the JSON in ${agySettingsFile(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} by hand`))
      return
    }
    const want = r.replace(/`/g, '').replace('upgrading agy, then', 'upgrading agy to 1.5.3 or later, then')
    expect(w.clause!.remedy).toBe(want)
  })
  reg.define(/^the row names (`treecontext install --agent agy`|that rule, the developer's to change) as the remedy$/, (w: ClientsWorld, ...captures) => {
    const [remedy] = captures as string[]
    if (!w.approval) {
      // The hooks half of the row (D414).
      expect(w.clause!.remedy.startsWith('treecontext install --agent agy'), w.clause!.remedy).toBe(true)
      return
    }
    const r = w.approval!
    if (remedy === '`treecontext install --agent agy`') {
      expect(r.remedy).toBe('treecontext install --agent agy')
      expect(r.fix).toBe('treecontext install --agent agy')
      // The remedy does what it says: run as printed, the row reads ready,
      // and agy lists the server again.
      runNamedCommand(w, r.fix!)
      const after = approvalRow(w, 'Antigravity CLI')
      expect(after.status, after.row).toBe('ok')
      expect(after.clause).toMatch(/^an `agy -p` worker can use status, query, export and insert, /)
      expect(agyMcpList(w).servers.find(s => s.name === 'treecontext')?.status).toBe('enabled')
      return
    }
    // The developer's rule, named with its file: install leaves it, so a
    // plain install changes nothing about it.
    const line = `your ask rule ${AGY_INSERT} in ${agySettingsFile(w)}, yours to change (install leaves it)`
    expect(r.remedy).toBe(line)
    expect(r.fix).toBe(line)
    runNamedCommand(w, 'treecontext install --agent agy')
    expect(approvalRow(w, 'Antigravity CLI').clause).toBe(r.clause)
  })

  // ── the matrices name the permissions their runs were made under (D388) ─
  const MODE_WORDS = /default approvals|request-review preset|bypass-free|allow rules|approvals off/
  reg.define(/^a developer reads the cells for Codex CLI and Antigravity CLI$/, (w: ClientsWorld) => {
    const m = parseOrchestrationMatrix(w.readme!)
    w.orchRows = m.rows.filter(r => r.client === 'Codex CLI' || r.client === 'Antigravity CLI')
    expect(w.orchRows.map(r => r.client)).toEqual(['Codex CLI', 'Antigravity CLI'])
  })
  // ── the Codex CLI row, cell by cell (D412) ─────────────────────────────
  // Columns after the client's: worker, pen, tool calls captured, main,
  // subagent legs, pointer (the header is checked by the table's own step).
  const codexCell = (w: ClientsWorld, role: string): string => {
    const m = parseOrchestrationMatrix(w.readme!)
    const col = m.header.findIndex(h => h.toLowerCase().includes(role))
    expect(col, `no column for the role "${role}"`).toBeGreaterThanOrEqual(0)
    return w.orchRows!.find(r => r.client === 'Codex CLI')!.cells[col]!
  }
  reg.define(/^a developer reads the row for Codex CLI$/, (w: ClientsWorld) => {
    w.orchRows = parseOrchestrationMatrix(w.readme!).rows.filter(r => r.client === 'Codex CLI')
    expect(w.orchRows).toHaveLength(1)
  })
  reg.define(/^the developer sees the cell for a main that registers itself read "verified live" with the Codex version and date of the run$/, (w: ClientsWorld) => {
    expect(codexCell(w, 'main that registers itself')).toMatch(/^verified live \(Codex CLI \d+\.\d+\.\d+,.*\b20\d\d-\d\d-\d\d\b/)
  })
  reg.define(/^the developer sees the cell for a worker's own tool calls read "verified live" with the date of the live run of a ticketed Codex worker it rests on$/, (w: ClientsWorld) => {
    const cell = codexCell(w, 'tool calls captured')
    // A live run of a ticketed worker: `codex exec` through the ticket door,
    // dated, and resting on the census of that run's calls.
    expect(cell).toMatch(/^verified live \(codex exec \d+\.\d+\.\d+ through treecontext run,.*\b20\d\d-\d\d-\d\d\b.*census/)
  })
  reg.define(/^the developer sees the cells for subagent legs and for the pointer read "not possible", naming the spawn message a hook cannot read$/, (w: ClientsWorld) => {
    for (const role of ['subagent legs', 'pointer']) {
      expect(codexCell(w, role), `the ${role} cell`).toMatch(/^not possible: no spawn message a hook can read/)
    }
  })
  reg.define(/^the developer sees every "verified live" cell name the permission mode its run was made in$/, (w: ClientsWorld) => {
    const live = w.orchRows!.flatMap(r => r.cells.filter(c => c.includes('verified live')).map(c => `${r.client}: ${c}`))
    // The needle fires: both clients have verified-live cells.
    expect(live.length, 'no verified-live cell to read').toBeGreaterThanOrEqual(4)
    for (const c of live) expect(c, `${c} names no permission mode`).toMatch(MODE_WORDS)
  })
  reg.define(/^the developer sees no such cell rest on a run made with a flag that bypasses the client's approvals or sandbox unless the cell says so$/, (w: ClientsWorld) => {
    for (const r of w.orchRows!) for (const c of r.cells.filter(x => x.includes('verified live'))) {
      const bypassed = /--dangerously-|2026-11-01/.test(c)
      if (bypassed) expect(c, `${r.client}: a cell on a bypass run does not say so: ${c}`).toMatch(/bypass/i)
    }
    // The first runs' history is disclosed where the matrix is given.
    const orch = w.readme!.slice(w.readme!.indexOf('### Orchestration matrix'))
    expect(orch).toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(orch).toContain('--dangerously-skip-permissions')
  })

  // ── the README's headless-workers section (D388) ───────────────────────
  reg.define(/^the README's section on headless workers$/, (w: ClientsWorld) => {
    const readme = readFileSync(join(TS_ROOT, 'README.md'), 'utf8')
    const start = readme.indexOf('\n### Headless workers')
    expect(start, 'the README has no "Headless workers" section').toBeGreaterThan(-1)
    const rest = readme.slice(start + 1)
    const end = rest.slice(3).search(/^## /m)
    w.headless = end === -1 ? rest : rest.slice(0, end + 3)
  })
  const PARTS: Record<string, { from: RegExp; to: RegExp }> = {
    '`claude -p`': { from: /^\*\*Claude Code \(`claude -p`\)\.\*\*$/m, to: /^\*\*Codex CLI/m },
    '`codex exec`': { from: /^\*\*Codex CLI \(`codex exec`\)\.\*\*$/m, to: /^\*\*Antigravity CLI/m },
    '`agy -p`': { from: /^\*\*Antigravity CLI \(`agy -p`\)\.\*\*$/m, to: /^\*\*What a worker may do/m },
  }
  reg.define(/^a developer reads the part for (`claude -p`|`codex exec`|`agy -p`)$/, (w: ClientsWorld, ...captures) => {
    const part = PARTS[captures[0] as string]!
    const text = w.headless!
    const a = text.search(part.from)
    expect(a, `no part for ${captures[0]}`).toBeGreaterThan(-1)
    const rest = text.slice(a + 1)
    const b = rest.search(part.to)
    expect(b).toBeGreaterThan(-1)
    w.workerPart = rest.slice(0, b)
    w.workerKey = captures[0] as string
  })
  reg.define(/^the developer reads the `treecontext run` line that starts one, (?:.+)$/, (w: ClientsWorld) => {
    const part = w.workerPart!
    const line = /treecontext run[^`]*?-- (claude|codex|agy)[^\n]*/s.exec(part)
    expect(line, 'the part has no treecontext run line').not.toBeNull()
    // The line a developer copies is one the CLI accepts: read by
    // run-command's own parser, never only by its words (M6).
    const copied = documentedCommands(part, 'run').filter(l => / -- /.test(l))
    expect(copied, 'the part has no run line in a code block').toHaveLength(1)
    expect(runLineRefusal(copied[0]!), copied[0]).toBeNull()
    const text = part.replace(/\s+/g, ' ')
    switch (w.workerKey) {
      case '`claude -p`':
        expect(line![0]).toMatch(/-- claude -p --model sonnet/)
        expect(line![0].match(/--allowedTools/g) ?? [], 'the claude line carries --allowedTools').toEqual([])
        expect(text).toMatch(/takes several values and swallows a prompt that follows it/)
        break
      case '`codex exec`':
        expect(line![0]).toMatch(/-- codex exec -m <model> -s read-only -$/)
        expect(text).toMatch(/read its prompt on stdin/)
        break
      default:
        expect(part).toMatch(/--message-arg[^\n]*-- agy --model <model> --output-format text -p/)
        expect(text).toMatch(/agy takes the prompt as the value of `-p` itself/)
    }
  })
  reg.define(/^the developer reads what install sets up for it and what is left to the developer: (?:.+)$/, (w: ClientsWorld) => {
    const text = w.workerPart!.replace(/\s+/g, ' ')
    expect(text, 'the part says nothing of what install sets up').toMatch(/Install (approves|writes)/)
    switch (w.workerKey) {
      case '`claude -p`':
        expect(text).toMatch(/Left to you: nothing/)
        break
      case '`codex exec`':
        expect(text).toMatch(/Left to you, on Linux only/)
        expect(text).toContain('bubblewrap')
        expect(text).toContain('kernel.apparmor_restrict_unprivileged_userns=1')
        expect(text).toContain('/etc/apparmor.d/bwrap')
        expect(text).toContain('abi <abi/4.0>, include <tunables/global> profile bwrap /usr/bin/bwrap flags=(unconfined) { userns, include if exists <local/bwrap> }')
        expect(text).toContain('sudo apparmor_parser -r /etc/apparmor.d/bwrap')
        expect(text).toContain('treecontext changes no system file')
        break
      default:
        expect(text).toMatch(/Left to you: nothing/)
    }
  })
  reg.define(/^the developer reads which doctor row says whether it is ready$/, (w: ClientsWorld) => {
    const text = w.workerPart!.replace(/\s+/g, ' ')
    switch (w.workerKey) {
      case '`claude -p`': expect(text).toMatch(/Doctor's Claude Code row .*"tool approvals" clause/); break
      case '`codex exec`':
        expect(text).toMatch(/Doctor's Codex CLI row carries a "headless workers" clause/)
        expect(text).toMatch(/Doctor's "Codex sandbox" row/)
        break
      default: expect(text).toMatch(/Doctor's Antigravity CLI row, in its "headless workers" clause/)
    }
  })

  reg.define(/^the developer reads that a worker reads and writes the journal and never removes or brings in rows, its request to do so refused$/, (w: ClientsWorld) => {
    expect(w.workerPart).toMatch(/A worker reads and writes the journal: status, query, export and insert\. Clear, delete, import and merge still ask, so a headless worker's request for them is refused/)
  })
  reg.define(/^the developer reads that a worker begins from its first message and runs no orientation$/, (w: ClientsWorld) => {
    expect(w.workerPart).toMatch(/the worker begins from its first message and runs no orientation/)
    expect(w.workerPart).toContain('131,852')
    expect(w.workerPart).toContain('62,829')
  })
  reg.define(/^the developer reads that a failed or silent worker's summary row carries its exit code and the end of its error stream$/, (w: ClientsWorld) => {
    expect(w.workerPart).toMatch(/exits non-zero or prints nothing gets a summary row carrying its exit code and the end of its error stream, the last 2,000 characters/)
    // The example's first line is the summary row's own words, composed by
    // the code that writes them for a 1200-character stream kept whole;
    // the README abridges the stream and says so.
    const stream = `${'x'.repeat(1105)}\nERROR: The 'no-such-model-xyz' model is not supported when using Codex with a ChatGPT account.`
    expect([...stream].length).toBe(1200)
    const [head, ...kept] = failedRunLine({ code: 1, printedNothing: true, tail: stream, total: 1200 }).split('\n')
    const example = /```\n(treecontext: the worker exited[^\n]*)\n…\n([^\n]*)\n```/.exec(w.headless!)
    expect(example, 'no abridged failed-run example').not.toBeNull()
    expect(example![1]).toBe(head)
    expect(kept.join('\n').endsWith(example![2]!)).toBe(true)
    expect(w.workerPart!.replace(/\s+/g, ' ')).toMatch(/Abridged here: the stream was 1,200 characters, all of them in the row, and only its end is shown/)
  })
  reg.define(/^the developer reads how to turn tool approvals off and on again$/, () => {
    const readme = readFileSync(join(TS_ROOT, 'README.md'), 'utf8')
    expect(readme).toContain('treecontext config tool-approvals off [--agent claude|codex|agy]')
    expect(readme).toContain('treecontext config tool-approvals on  [--agent claude|codex|agy]')
    expect(readme).toContain('treecontext install --no-tool-approvals')
  })
  reg.define(/^the developer reads a short dispatcher example for Claude Code to copy, and that treecontext installs no skill for it$/, (w: ClientsWorld) => {
    expect(w.workerPart).toContain('treecontext installs no skill for this')
    const code = /tc-worker\(\) \{[\s\S]*?\n\}/.exec(w.headless!)
    expect(code, 'no dispatcher example').not.toBeNull()
    expect(code![0]).toContain('--prompt-file')
    expect(code![0]).toContain('-s read-only')
    expect(code![0].match(/--dangerously[\w-]*|bypass|--yolo/g) ?? [], 'the dispatcher uses a bypass flag').toEqual([])
    expect(code![0].split('\n').length).toBeLessThan(12)
    // Its run line is one the CLI accepts, `$1` and the rest read as values.
    const dispatched = documentedCommands(`\n\`\`\`\n${code![0]}\n\`\`\`\n`, 'run')
    expect(dispatched, 'the dispatcher has no run line').toHaveLength(1)
    expect(runLineRefusal(dispatched[0]!), dispatched[0]).toBeNull()
  })

  // ── Gemini CLI retired: doctor names what an earlier install left (D399)
  //
  // The real install wires Claude Code and Antigravity CLI in a redirected
  // HOME; ~/.gemini/settings.json then holds what an earlier build's
  // install wrote for Gemini CLI over the developer's own keys (a fixture
  // of that build's output, layEarlierGeminiInstall). Doctor is the real
  // CLI read off its stdout, the command its row names is run as printed,
  // and agy's own `agy mcp list` is the other side for its wiring.
  /** Gemini CLI's settings as the developer keeps them: a server, a hook of their own, and keys of Gemini CLI's. */
  const GEMINI_DEVELOPER = {
    theme: 'GitHub',
    selectedAuthType: 'oauth-personal',
    mcpServers: { 'their-server': { command: 'someone-elses-tool' } },
    hooks: { BeforeTool: [{ matcher: 'run_shell_command', hooks: [{ type: 'command', command: '/usr/local/bin/audit-tool' }] }] },
  }
  const geminiSettings = (w: ClientsWorld): string => join(w.ihome!, '.gemini', 'settings.json')
  /** Every file install wrote for Claude Code and Antigravity CLI, by its bytes, and agy's own listing. */
  const wiringOf = (w: ClientsWorld): Record<string, string> => {
    const files = [
      join(w.ihome!, '.claude.json'), join(w.ihome!, '.claude', 'settings.json'),
      join(w.ihome!, '.gemini', 'config', 'mcp_config.json'), agySettingsFile(w), join(w.ihome!, '.gemini', 'GEMINI.md'),
    ]
    const out: Record<string, string> = {}
    for (const f of files) out[f] = existsSync(f) ? readFileSync(f, 'utf8') : '(absent)'
    const hooksDir = join(w.ihome!, '.claude', 'hooks')
    out['hook scripts'] = readdirSync(hooksDir).filter(f => f.startsWith('tc-')).sort().join(' ')
    out['agy mcp list'] = JSON.stringify(agyMcpList(w).servers)
    return out
  }
  /** The `tc-gemini-*` wrappers an earlier install left in ~/.claude/hooks. */
  const geminiWrapperFiles = (w: ClientsWorld): string[] => readdirSync(join(w.ihome!, '.claude', 'hooks')).filter(f => f.startsWith('tc-gemini-'))
  /** Doctor's rows naming Gemini CLI, each with the fix line under it. */
  const geminiRows = (out: string): Array<{ row: string; fix: string | null }> => {
    const lines = out.split('\n')
    return lines.flatMap((l, i) => /^\[\w+\]\s+Gemini CLI:/.test(l)
      ? [{ row: l, fix: /^\s+fix: (.+)$/.exec(lines[i + 1] ?? '')?.[1] ?? null }]
      : [])
  }
  reg.define(/^install has wired Claude Code and Antigravity CLI, and Gemini CLI's settings hold the treecontext entry and the copied hooks an earlier install wrote beside the developer's own keys$/, async (w: ClientsWorld) => {
    await openInstallWorld(w, ['.claude', join('.gemini', 'antigravity-cli')])
    putAgyOnPath(w)
    const run = tcCli(w, ['install', '--yes'])
    expect(run.status, run.out).toBe(0)
    expect(run.stdout).toMatch(/^Detected agents: Claude Code Antigravity CLI$/m)
    expect(agyMcpList(w).servers.map(s => s.name), 'agy lists no treecontext server').toEqual(['treecontext'])
    w.retiredWiring = wiringOf(w)
    layEarlierGeminiInstall(w.ihome!, GEMINI_DEVELOPER, { wrappers: true })
    // The fixture holds what the Then reads gone: the entry, and hooks that
    // run Claude Code's scripts.
    const laid = JSON.parse(readFileSync(geminiSettings(w), 'utf8')) as { mcpServers: Record<string, unknown>; hooks: Record<string, unknown> }
    expect(Object.keys(laid.mcpServers).sort()).toEqual(['their-server', 'treecontext'])
    expect(Object.keys(laid.hooks).sort()).toEqual(['AfterTool', 'BeforeAgent', 'BeforeTool', 'PreCompress', 'SessionStart'])
    expect(geminiWrapperFiles(w), 'the fixture laid no Gemini CLI wrappers').toHaveLength(4)
  })
  reg.define(/^the developer runs doctor, then the command its Gemini CLI row names, then doctor again$/, (w: ClientsWorld) => {
    const first = tcCli(w, ['doctor'])
    expect(first.status, first.out).toBe(0)
    w.doctorOut = first.stdout
    const rows = geminiRows(first.stdout)
    expect(rows, `doctor printed ${rows.length} Gemini CLI rows:\n${first.stdout}`).toHaveLength(1)
    expect(rows[0]!.fix, `the Gemini CLI row names no command:\n${rows[0]!.row}`).not.toBeNull()
    w.retiredFix = rows[0]!.fix!
    runNamedCommand(w, w.retiredFix)
    const second = tcCli(w, ['doctor'])
    expect(second.status, second.out).toBe(0)
    w.retiredDoctorAfter = second.stdout
  })
  reg.define(/^the first doctor run shows no client row for Gemini CLI and one warning row saying Gemini CLI is retired, naming what is left and that command$/, (w: ClientsWorld) => {
    const out = w.doctorOut!
    // The needle fires: the same run prints a client row, with its clause, for agy.
    expect(out).toMatch(/^\[\w+\]\s+Antigravity CLI: .*the client keeps its own hook configuration/m)
    const [only] = geminiRows(out)
    // A warning row, not a client row: no mode, state and remedy clause.
    expect(only!.row).toMatch(/^\[warn\] Gemini CLI: Gemini CLI is retired; /)
    // step-lint: allow unearned-absence -- the same-scope positive above matches this clause shape ("the client …") on the Antigravity CLI row of this doctor run
    expect(only!.row).not.toMatch(/the client .*; state: /)
    const path = geminiSettings(w)
    expect(only!.row).toContain(`its treecontext entry in ${path}`)
    expect(only!.row).toContain(`a copy of the treecontext hooks in ${path}`)
    // The wrapper clause: counted, and where they are.
    expect(only!.row).toContain(`4 Gemini CLI hook wrappers in ${join(w.ihome!, '.claude', 'hooks')}`)
    // Antigravity CLI is wired here, so its block in GEMINI.md is not named as a leftover and the row says it stays.
    // step-lint: allow unearned-absence -- the needle is the clause doctor prints where Antigravity CLI is not wired (tests/server/gemini-retired-sweep.test.ts reads it there), and the same row's positive on the "stays" clause below proves this run's row is the wired one
    expect(only!.row).not.toContain('the treecontext block in')
    expect(only!.row).toContain("~/.gemini/GEMINI.md is Antigravity CLI's and stays")
    expect(only!.fix).toBe('treecontext uninstall --agent gemini')
  })

  reg.define(/^after the command Gemini CLI's settings hold the developer's own keys and nothing of treecontext's$/, (w: ClientsWorld) => {
    const after = JSON.parse(readFileSync(geminiSettings(w), 'utf8')) as unknown
    // The developer's keys, exactly as they were, and nothing else: the
    // entry and every hook of the copy are gone, theirs kept.
    expect(after).toEqual(GEMINI_DEVELOPER)
    // The command took the wrappers the row named, too.
    expect(geminiWrapperFiles(w)).toEqual([])
  })
  reg.define(/^Claude Code's and Antigravity CLI's wiring is as install left it$/, (w: ClientsWorld) => {
    expect(wiringOf(w)).toEqual(w.retiredWiring)
  })
  reg.define(/^the second doctor run shows no row for Gemini CLI$/, (w: ClientsWorld) => {
    const out = w.retiredDoctorAfter!
    // The needle fires: this run prints rows, the client beside it among them.
    expect(out).toMatch(/^\[\w+\]\s+Antigravity CLI:/m)
    // The first doctor run of this world printed exactly one Gemini CLI row (the When).
    expect(geminiRows(out)).toEqual([])
  })

  // ── D407: doctor's Codex row says whether Codex runs treecontext's hooks ──
  // Every state is produced in a throwaway HOME and read by doctor from the
  // Codex its PATH holds. The trust states come from the real `codex` on
  // PATH (0.167.0 on the binding host) through its own `hooks/list`, after
  // the developer's /hooks acts, which the stand-in makes with the hashes
  // Codex itself reports (standins.ts developerTrustsCodexHooks; a record
  // Codex keyed to a hook since gone is left the same way, by trusting a
  // hook and taking it out). "Cannot be read" and the two version rows are
  // the stand-in `codex` (writeFakeCodex), whose app server never answers.
  type TrustWorld = ClientsWorld & { cxFilesBefore?: Record<string, string> }
  const codexFiles = (w: ClientsWorld): Record<string, string> => {
    const dir = join(w.ihome!, '.codex')
    // Codex's configuration (config.toml, which also holds its trust
    // records, and hooks.json); the app server keeps caches of its own
    // beside them, which are Codex's writes, not doctor's.
    return Object.fromEntries(['config.toml', 'hooks.json'].filter((f) => existsSync(join(dir, f))).map((f) => [f, readFileSync(join(dir, f), 'utf8')]))
  }
  const hooksFile = (w: ClientsWorld): string => join(w.ihome!, '.codex', 'hooks.json')
  const install = (w: ClientsWorld, args: string[] = []): void => {
    const run = tcCli(w, ['install', '--yes', '--agent', 'codex', ...args])
    expect(run.status, run.out).toBe(0)
  }
  const trust = (w: ClientsWorld, which?: (h: CodexListedHook) => boolean): Promise<CodexListedHook[]> =>
    developerTrustsCodexHooks(w.ihome!, w.iproj ?? w.ihome!, which)
  const OWN = (h: CodexListedHook): boolean => h.command.endsWith(' --client codex')
  const STATES: Record<string, (w: ClientsWorld) => Promise<void>> = {
    'install has written its block at 0.167.0 and Codex reports every hook of it trusted': async (w) => {
      install(w)
      expect((await trust(w, OWN)).length).toBe(9)
    },
    'install has written its block at 0.167.0 and Codex reports none of it trusted': async (w) => { install(w) },
    'install has written its block at 0.167.0 and Codex reports some of its hooks trusted and others not': async (w) => {
      install(w)
      expect((await trust(w, (h) => OWN(h) && ['sessionStart', 'stop'].includes(h.eventName))).length).toBe(2)
    },
    // The block's Stop hook as an earlier install left it (its command one
    // word longer), trusted with the rest; install then rewrote it at the
    // same place, so Codex's record there is for the hook as it was.
    'Codex trusted the block and a hook of it has changed since': async (w) => {
      install(w)
      const data = JSON.parse(readFileSync(hooksFile(w), 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
      data.hooks['Stop']![0]!.hooks[0]!.command += ' --earlier'
      writeFileSync(hooksFile(w), JSON.stringify(data, null, 2) + '\n')
      expect((await trust(w, (h) => h.command.includes('/tc-'))).length).toBe(9)
      install(w)
    },
    // The developer trusted a Stop hook of their own, then took it out of
    // the file; install then wrote treecontext's Stop hook at that place.
    'Codex holds a trust record, at the place of a treecontext hook, that was given to a different hook': async (w) => {
      writeFileSync(hooksFile(w), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }] } }, null, 2) + '\n')
      expect((await trust(w)).map((h) => h.key)).toEqual([`${hooksFile(w)}:stop:0:0`])
      writeFileSync(hooksFile(w), '{}\n')
      install(w)
    },
    'install has written its block at 0.167.0 and Codex\'s own account of its hooks cannot be read': async (w) => {
      setFakeCodex(w, { version: '0.167.0', sandbox: { exit: 0, stderr: '' } })
      install(w)
    },
    'its version is 0.167.0 and no treecontext hook is written': async (w) => {
      install(w)
      writeFileSync(hooksFile(w), '{}\n')
    },
    'its hooks file holds the verbatim copy of the Claude Code block an earlier build wrote under the experimental flag': async (w) => {
      install(w)
      writeFileSync(hooksFile(w), '{}\n')
      const restoreHome = redirectHome(w.ihome!)
      try { upsertCodexHooks(hooksFile(w)) } finally { restoreHome() }
    },
    'its version reads 0.166.0': async (w) => {
      setFakeCodex(w, { version: '0.166.0', sandbox: { exit: 0, stderr: '' } })
      install(w)
    },
    'its version reads 0.166.0 and its hooks file still holds the hooks an earlier install wrote': async (w) => {
      setFakeCodex(w, { version: '0.167.0', sandbox: { exit: 0, stderr: '' } })
      install(w)
      setFakeCodex(w, { version: '0.166.0', sandbox: { exit: 0, stderr: '' } })
    },
    // A codex whose `--version` prints no version and exits 1.
    'its version cannot be read': async (w) => {
      setFakeCodex(w, { version: null, sandbox: { exit: 0, stderr: '' } })
      install(w)
    },
    // Install wrote its block; a hand edit then left the file unparsable.
    'its hooks file does not parse': async (w) => {
      install(w)
      writeFileSync(hooksFile(w), readFileSync(hooksFile(w), 'utf8').replace(/\}\s*$/, ',}\n'))
    },
  }
  const stateRe = Object.keys(STATES).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  reg.define(new RegExp(`^Codex CLI is installed and (${stateRe})$`), async (w: TrustWorld, state: unknown) => {
    w.clientName = 'Codex CLI'
    await openInstallWorld(w, ['.claude', '.codex'])
    if (!w.iCodexBin) expect(spawnSync('codex', ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe('codex-cli 0.167.0')
    await STATES[String(state)]!(w)
    w.cxFilesBefore = codexFiles(w)
  })
  const SAYS: Record<string, (c: DoctorClause, w: ClientsWorld) => void> = {
    'read that Codex runs treecontext\'s hooks': (c) => {
      expect(c.status, c.row).toBe('ok')
      expect(c.state).toMatch(/Codex runs treecontext's hooks: it reports every one of them trusted/)
    },
    'warn that Codex runs none of treecontext\'s hooks, naming each': (c) => {
      expect(c.status).toBe('warn')
      expect(c.state).toMatch(/Codex runs none of treecontext's hooks/)
      for (const e of Object.keys(codexHooksBlock())) expect(c.state).toContain(`${e[0]!.toLowerCase()}${e.slice(1)} (`)
    },
    'warn that Codex runs only some of treecontext\'s hooks, naming each it does not run': (c) => {
      expect(c.status).toBe('warn')
      expect(c.state).toMatch(/Codex runs only some of treecontext's hooks/)
      expect(c.state).toContain('userPromptSubmit (')
      // step-lint: allow unearned-absence -- the needles are the names Codex gives these hooks, which the none-trusted row of this outline finds in the same clause by the same `<event> (` spelling
      expect(c.state).not.toMatch(/sessionStart \(|\bstop \(/)
    },
    'warn that Codex reports the changed hook modified since it was trusted and does not run it, naming it': (c, w) => {
      expect(c.status).toBe('warn')
      expect(c.state).toContain(`stop (${hooksFile(w)}:stop:0:0)`)
      expect(c.state).toMatch(/modified since it was trusted and does not run it/)
      expect(c.state).toMatch(/Codex runs only some of treecontext's hooks/)
    },
    'warn that Codex reports each such treecontext hook modified since it was trusted and does not run it, naming each': (c, w) => {
      expect(c.status).toBe('warn')
      expect(c.state).toContain(`Codex reports stop (${hooksFile(w)}:stop:0:0) modified since it was trusted and does not run it`)
    },
    'say that the hooks are written and that doctor cannot tell whether Codex trusts them, never reading ok': (c) => {
      expect(c.status).not.toBe('ok')
      expect(c.state).toMatch(/present and consistent with Codex's block; doctor cannot tell whether Codex trusts them/)
    },
    'warn that nothing of a Codex session is captured': (c) => {
      expect(c.status).toBe('warn')
      expect(c.state).toMatch(/nothing of a Codex session is captured/)
    },
    'warn that the hooks are an earlier build\'s copy of Claude Code\'s block, not Codex\'s own': (c) => {
      expect(c.status).toBe('warn')
      expect(c.state).toMatch(/an earlier build's copy of Claude Code's block, not Codex's own/)
    },
    'say that Codex gets the tools only and that capture needs Codex CLI 0.167.0': (c) => {
      expect(c.state).toMatch(/Codex gets the tools only: its version reads 0\.166\.0, and capture needs Codex CLI 0\.167\.0/)
    },
    'warn that treecontext\'s hooks are written for a Codex that gets the tools only': (c) => {
      expect(c.status).toBe('warn')
      expect(c.state).toMatch(/treecontext's hooks are written in .* for a Codex that gets the tools only: its version reads 0\.166\.0/)
    },
    'say that Codex gets the tools only, its version not read': (c) => {
      expect(c.state).toMatch(/Codex gets the tools only: its version could not be read \(codex --version\)/)
    },
    'warn, quoting the parse error, that doctor cannot read treecontext\'s hooks there': (c, w) => {
      expect(c.status).toBe('warn')
      // The parse error is JSON.parse's own for the file as the hand edit left it.
      let parseError = ''
      try { JSON.parse(readFileSync(hooksFile(w), 'utf8')) } catch (e) { parseError = (e as Error).message }
      expect(parseError).not.toBe('')
      expect(c.state).toContain(`${hooksFile(w)} does not parse (`)
      expect(c.state).toContain(parseError)
      expect(c.state).toMatch(/nothing in it is read, treecontext's hooks or the developer's/)
    },
  }
  const sayRe = Object.keys(SAYS).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  reg.define(new RegExp(`^the developer sees doctor's row for Codex CLI (${sayRe})$`), (w: ClientsWorld, say: unknown) => {
    SAYS[String(say)]!(w.clause!, w)
  })
  reg.define(/^the row names (trusting them with `\/hooks` in Codex|looking in `\/hooks` in Codex|upgrading Codex CLI to 0\.167\.0 or later|`treecontext install --agent codex`, which takes them back|making `codex --version` answer, then `treecontext install --agent codex`|fixing the file by hand, never an install) as the remedy$/, (w: ClientsWorld, remedy: unknown) => {
    // "the file" is the hooks file, which the row names by its path.
    const want = String(remedy).replace(/`/g, '').replace('fixing the file by hand', `fixing ${w.clientName === 'Antigravity CLI' ? join(w.ihome!, '.gemini', 'config', 'hooks.json') : hooksFile(w)} by hand`)
    expect(w.clause!.remedy.startsWith(want), w.clause!.remedy).toBe(true)
  })
  reg.define(/^Codex's configuration and its record of trusted hooks are as they were before doctor ran$/, (w: TrustWorld) => {
    expect(codexFiles(w)).toEqual(w.cxFilesBefore)
  })

  // ── D412, D410: the README's parts on Codex CLI ─────────────────────
  // Read from the README itself: its "Codex CLI capture" section (§6),
  // whitespace flattened so a line break never hides a phrase.
  const codexParts = new WeakMap<ClientsWorld, string>()
  reg.define(/^the README$/, (w: ClientsWorld) => {
    codexParts.set(w, readFileSync(join(TS_ROOT, 'README.md'), 'utf8'))
  })
  reg.define(/^a developer reads its parts on Codex CLI$/, (w: ClientsWorld) => {
    const readme = codexParts.get(w)!
    const start = readme.indexOf('\n### Codex CLI capture')
    expect(start, 'the README has no "Codex CLI capture" section').toBeGreaterThan(-1)
    const rest = readme.slice(start + 1)
    const end = rest.slice(3).search(/^##+ /m)
    codexParts.set(w, (end === -1 ? rest : rest.slice(0, end + 3)).replace(/\s+/g, ' '))
  })

  // ── the matrix's verified rows (D388, D406, D413) ─────────────────────
  reg.define(/^the developer sees exactly three rows reading "verified live", Claude Code, Codex CLI from 0\.167\.0 and Antigravity CLI from 1\.5\.3, the rows for Codex CLI and Antigravity CLI each naming the client version and date of the recording it rests on$/, (w: ClientsWorld) => {
    const live = w.matrix!.filter((r) => r.status.startsWith('verified live'))
    expect(live.map((r) => r.client)).toEqual(['Claude Code', 'Codex CLI', 'Antigravity CLI'])
    const codex = live.find((r) => r.client === 'Codex CLI')!
    const agy = live.find((r) => r.client === 'Antigravity CLI')!
    expect(codex.status).toMatch(/Codex CLI 0\.167\.0, recorded 2026-11-09; from 0\.167\.0/)
    expect(agy.status).toMatch(/Antigravity CLI 1\.5\.3, recorded 2026-11-09; from 1\.5\.3/)
    // The recordings they rest on are named in the documentation cell.
    expect(codex.docs).toMatch(/recorded on Codex CLI 0\.167\.0, 2026-11-09/)
    expect(agy.docs).toMatch(/recorded on Antigravity CLI 1\.5\.3, 2026-11-09/)
  })

  // ── D423: support in tiers, and the workflow every client shares ──────
  const supportParts = new WeakMap<ClientsWorld, { table: string; workflow: string }>()
  const sectionOf = (readme: string, heading: string): string => {
    const start = readme.indexOf(`\n### ${heading}`)
    expect(start, `the README has no "${heading}" section`).toBeGreaterThan(-1)
    const rest = readme.slice(start + 1)
    const end = rest.slice(4).search(/^##+ /m)
    return (end === -1 ? rest : rest.slice(0, end + 4)).replace(/\s+/g, ' ')
  }
  reg.define(/^a developer reads its support table$/, (w: ClientsWorld) => {
    const readme = codexParts.get(w)!
    supportParts.set(w, { table: sectionOf(readme, 'Support by client: main and worker'), workflow: sectionOf(readme, 'The basic workflow: a worker of any CLI, from a shell') })
  })
  const rowOf = (w: ClientsWorld, client: string): string => {
    const line = codexParts.get(w)!.split('\n').find((l) => l.startsWith(`| ${client} | `) && /support/.test(l))
    expect(line, `the support table has no row for ${client}`).toBeDefined()
    return line!
  }
  reg.define(/^the developer reads Claude Code as the main supported in full, with workers of any CLI started through the doors, Codex CLI and Antigravity CLI among them$/, (w: ClientsWorld) => {
    expect(rowOf(w, 'Claude Code')).toMatch(/full support.*workers of any CLI, Codex CLI and Antigravity CLI among them, started through the doors/)
  })
  reg.define(/^the developer reads Codex CLI and Antigravity CLI as mains with basic support, capture through their own hooks and the tools through MCP, with no promise of parity and each difference from a Claude Code main named$/, (w: ClientsWorld) => {
    for (const c of ['Codex CLI', 'Antigravity CLI']) {
      const r = rowOf(w, c)
      expect(r).toMatch(/basic support.*capture through its (own hooks|named hook).*the tools through MCP, with no promise of parity with a Claude Code main\. Differences from a Claude Code main:/)
    }
    expect(rowOf(w, 'Codex CLI')).toMatch(/no bookmark ask and no send-back.*subagents are helpers, never legs/)
    expect(rowOf(w, 'Antigravity CLI')).toMatch(/placed in no checkout's lane.*re-orientation packet.*a call agy refuses leaves no entry.*outcome is read from its text/)
  })
  reg.define(/^the developer reads that a Codex CLI or Antigravity CLI main starting workers through the doors is not guaranteed$/, (w: ClientsWorld) => {
    expect(supportParts.get(w)!.table).toContain('A Codex CLI or Antigravity CLI main starting workers through the doors is not guaranteed')
  })
  reg.define(/^the developer reads that an Antigravity CLI main is captured but placed in no checkout's lane, and that its subagents are not linked to it$/, (w: ClientsWorld) => {
    expect(rowOf(w, 'Antigravity CLI')).toMatch(/an agy main is captured but placed in no checkout's lane.*its subagents are captured as sessions of their own and not linked to it/)
  })
  reg.define(/^a developer reads the basic workflow$/, (w: ClientsWorld) => {
    expect(supportParts.get(w)!.workflow.length).toBeGreaterThan(0)
  })
  reg.define(/^the developer reads how to start a worker of any CLI with `treecontext run` from a shell, whichever client is the main, and what the journal then holds with no hook at all: the worker's lane, its first message and its summary row$/, (w: ClientsWorld) => {
    const t = supportParts.get(w)!.workflow
    expect(t).toMatch(/Starting a worker with `treecontext run` from a shell is safe whichever client is the main, or with none at all/)
    expect(t).toMatch(/treecontext run --run .* -- <the worker's command: claude -p, codex exec -, agy -p/)
    expect(t).toMatch(/With no hook at all, the journal then holds: - \*\*the worker's lane\*\*.* - \*\*its first message\*\*.* - \*\*its summary row\*\*/)
  })

  const says = (w: ClientsWorld, ...res: RegExp[]): void => {
    const text = codexParts.get(w)!
    for (const re of res) expect(text, String(re)).toMatch(re)
  }
  reg.define(/^the developer reads 0\.167\.0 as the minimum Codex CLI for capture, and that below it Codex gets the tools only$/, (w: ClientsWorld) => {
    says(w, /The minimum Codex CLI for capture is \*\*0\.167\.0\*\*/, /Below it, or where `codex --version` cannot be read, Codex gets the tools only/)
  })
  reg.define(/^the developer reads that Codex runs treecontext's hooks only once they are trusted with `\/hooks` in Codex, and that doctor says which are$/, (w: ClientsWorld) => {
    says(w, /Codex runs a hook only once you trust it: open `\/hooks` in Codex/, /`treecontext doctor` reads Codex's own account of each hook's trust .* and says whether Codex runs treecontext's hooks, runs only some of them/)
  })
  reg.define(/^the developer reads that a Codex shell command's entry holds the text Codex returned and no exit code$/, (w: ClientsWorld) => {
    says(w, /A shell command's entry holds the one text Codex returned: no exit code/)
  })
  reg.define(/^the developer reads that a Codex subagent is kept as a summary and is no leg$/, (w: ClientsWorld) => {
    says(w, /A Codex subagent\*\* is registered, retired at its stop and kept as a summary .*; it is no leg/)
  })
  reg.define(/^the developer reads that a Codex main is re-oriented at a fresh start and on a resume and gets no bookmark ask, and that an Antigravity CLI agent receives no re-orientation packet$/, (w: ClientsWorld) => {
    says(w, /is re-oriented at a fresh start and on a resume/, /It gets no bookmark ask/, /An Antigravity CLI agent receives no re-orientation packet/)
  })
  reg.define(/^the developer reads that a manual Codex compaction leaves a recovery note, an automatic one being unrecorded, and that a call Codex reported no result for, or a turn the developer interrupted, is kept and says so$/, (w: ClientsWorld) => {
    says(w, /A manual compaction\*\* \(`\/compact`\) leaves a recovery note/, /An automatic compaction is unrecorded/,
      /journaled at its turn's end as a call Codex reported no result for/, /A turn you interrupt \(Esc\) is kept as interrupted, with a capture-gap entry naming its reply as not captured/)
  })

  // ── D413, D418, D421, D388: the README's parts for Antigravity CLI ────
  // Read from the README itself: its "Antigravity CLI capture" section
  // (§6, whitespace flattened) and agy's row of the orchestration matrix.
  reg.define(/^the README's install section, its compatibility matrix and its orchestration matrix$/, (w: ClientsWorld) => {
    w.readme = readFileSync(join(TS_ROOT, 'README.md'), 'utf8')
    for (const heading of ['\n## 2. Install', '\n### Compatibility matrix', '\n### Orchestration matrix']) {
      expect(w.readme.includes(heading), `the README has no "${heading.trim()}" heading`).toBe(true)
    }
  })
  reg.define(/^a developer reads the parts for Antigravity CLI$/, (w: ClientsWorld) => {
    const readme = w.readme!
    const start = readme.indexOf('\n### Antigravity CLI capture')
    expect(start, 'the README has no "Antigravity CLI capture" section').toBeGreaterThan(-1)
    const rest = readme.slice(start + 1)
    const end = rest.slice(3).search(/^##+ /m)
    codexParts.set(w, (end === -1 ? rest : rest.slice(0, end + 3)).replace(/\s+/g, ' '))
    w.orchRows = parseOrchestrationMatrix(readme).rows.filter(r => r.client === 'Antigravity CLI')
    expect(w.orchRows.map(r => r.client)).toEqual(['Antigravity CLI'])
  })
  reg.define(/^the developer reads 1\.5\.3 as the first Antigravity CLI version whose hooks install writes, and that an older one stays tools-only$/, (w: ClientsWorld) => {
    says(w, /The first Antigravity CLI version whose hooks install writes is \*\*1\.5\.3\*\*/, /Below it, or where `agy --version` cannot be read, agy stays tools-only/)
  })
  reg.define(/^the developer reads which of agy's events install wires and that it never wires PreToolUse, with the reason$/, (w: ClientsWorld) => {
    says(w, /Events wired:\*\* SessionStart, PreInvocation, PostToolUse, PostInvocation and Stop\./, /PreToolUse is never wired:\*\* its hook must answer with a permission decision, so it would change what agy permits/)
  })
  reg.define(/^the developer reads that a call agy refuses in a headless run, under any permission preset but `always-proceed`, leaves no entry, that agy states no outcome for a shell command, and that a subagent is captured as a session of its own, not linked to the session that started it, and is no leg$/, (w: ClientsWorld) => {
    says(w, /a call agy refuses in a headless run, under any permission preset but `always-proceed`, leaves no entry/,
      /agy states no outcome for a shell command/,
      /A subagent's conversation is captured as a session of its own, not linked to the session that started it, and is never a leg/)
  })
  reg.define(/^the developer reads every Antigravity CLI cell of the orchestration matrix with the agy version and date it was checked against$/, (w: ClientsWorld) => {
    const [row] = w.orchRows!
    // The needle fires: agy's row has a cell for each of the six roles.
    expect(row!.cells).toHaveLength(6)
    for (const cell of row!.cells) {
      expect(cell, `"${cell}" names no agy version`).toMatch(/\b1\.5\.\d+\b/)
      expect(cell, `"${cell}" carries no date`).toMatch(/\b\d{4}-\d{2}-\d{2}\b/)
    }
  })
}
