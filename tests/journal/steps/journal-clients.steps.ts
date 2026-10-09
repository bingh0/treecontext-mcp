import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { expect } from 'vitest'
import { type Registry } from 'gherkin-node-test/vitest'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { nodeTsArgs, sandboxedSpawnEnv } from '../../helpers/cli-spawn.js'
import { parseToolResult } from '../../helpers/mcp-result.js'
import BetterSqlite3 from 'better-sqlite3'
import { launcherCliPath } from '../../../src/server/installer.js'
import { getAgent, getHookSettingsPath } from '../../../src/server/agents.js'
import { decodeContent } from '../../../src/persistence/content-codec.js'
import { TS_ROOT } from '../proc.js'
import { type InstallWorld, tcCli, openInstallWorld, agentConfigPath, mcpLauncherIn } from '../install-harness.js'

// ── journal-clients ─────────────────────────────────────────────────────
//
// Three scenarios bound at the beta.1 build (D197): the dated matrix, read
// out of README.md itself by parsing its table; the copying client's
// tools-only install, run through the real CLI in a redirected HOME with
// doctor read off its own output; and a teammate on Gemini CLI, whose tool
// calls go through the exact server command install wrote into Gemini's
// own settings file, spawned over a real stdio transport. Doctor per client
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
}

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

/** The six clients ruled to stand (D104); the matrix carries one row each. */
const DOCUMENTED_CLIENTS = ['Claude Code', 'Codex CLI', 'Gemini CLI', 'VS Code', 'Cursor', 'OpenCode']
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

/** Treecontext-owned hook commands in a JSON hook configuration, if any. */
function ownedHookCommands(path: string): string[] {
  if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf8')
  return [...text.matchAll(/"command"\s*:\s*"([^"]*)"/g)].map(m => m[1]!)
    .filter(c => /hooks[\\/]+(codex|gemini)[\\/]|tc-(codex|gemini)-|treecontext hook/.test(c))
}

/**
 * The five documented clients other than Claude Code, as a test reads them:
 * the slug the CLI takes and what in the README matrix and doctor's row its
 * mode must say. The mode patterns are the README's own vocabulary, so
 * doctor's wording and the matrix's Mode column cannot drift apart.
 */
const CLIENT_SLUG: Record<string, string> = {
  'Codex CLI': 'codex', 'Gemini CLI': 'gemini', 'VS Code': 'vscode', 'Cursor': 'cursor', 'OpenCode': 'opencode',
}
const MODE_FAMILY: Record<string, RegExp[]> = {
  'Codex CLI': [/copies the hooks into its own configuration/],
  'Gemini CLI': [/copies the hooks into its own translated configuration/],
  'VS Code': [/reads the Claude settings file\b.*\bwhen\b/, /chat\.useClaudeHooks/],
  'Cursor': [/reads the Claude settings file\b.*\bby default\b/],
  'OpenCode': [/no shell hooks/, /tools are its whole surface/],
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
 * tools' registration, not a hook, and Gemini keeps both in one file.
 */
function treecontextHookMentions(path: string | null): string[] {
  if (!path || !existsSync(path)) return []
  const text = readFileSync(path, 'utf8')
  return [...text.matchAll(/hooks(?:[\\/])+(?:tc-(?!mcp-serve)[\w-]+|(?:codex|gemini|vscode|cursor)(?:[\\/]))|treecontext hook [\w-]+/g)].map(m => m[0])
}

/**
 * Gemini CLI's names for Claude Code's events, written here from the record
 * (D153: same shapes, renamed events — BeforeTool, AfterTool, PreCompress —
 * no subagent events; BeforeAgent is the prompt event, with precedent in
 * src/hooks/gemini/normalize.ts). Stop has no counterpart: Gemini's
 * AfterAgent carries another payload and treats `deny` as a forced retry, so
 * it stays out until a live probe (D225). The test's own oracle, so doctor's
 * translation is checked against the record rather than against itself.
 * Claude's Windows-only `shell` key is not part of Gemini's hook entry.
 */
const GEMINI_NAME: Record<string, string | undefined> = {
  SessionStart: 'SessionStart', SessionEnd: 'SessionEnd', UserPromptSubmit: 'BeforeAgent',
  PreToolUse: 'BeforeTool', PostToolUse: 'AfterTool', PreCompact: 'PreCompress',
}
function translateForGemini(block: HookBlock): HookBlock {
  const out: HookBlock = {}
  for (const [event, matchers] of Object.entries(block)) {
    const name = GEMINI_NAME[event]
    if (!name) continue
    const copied = structuredClone(matchers).map(m => ({ ...m, hooks: m.hooks.map(({ shell: _shell, ...rest }) => rest) }))
    out[name] = [...(out[name] ?? []), ...copied]
  }
  return out
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
    w.matrix = parseMatrix(w.readme!)
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
      expect(r.mode, `${r.client}: no mode`).toMatch(/reads the Claude settings file|copies the hooks into its own|no shell hooks/)
      // One status: the cell is exactly one of the two, never both, never a
      // test result the row does not have.
      expect(STATUSES, `${r.client}: status "${r.status}" is not one status`).toContain(r.status)
    }
  })
  reg.define(/^the developer sees exactly one row reading "verified live", Claude Code$/, (w: ClientsWorld) => {
    const live = w.matrix!.filter(r => r.status === 'verified live')
    expect(live.map(r => r.client)).toEqual(['Claude Code'])
  })

  // ── without the experimental flag a copying client gets tools only (D208)
  reg.define(/^Codex CLI is installed$/, async (w: ClientsWorld) => {
    await openInstallWorld(w, ['.codex'])
  })
  reg.define(/^the developer runs the installer without the experimental flag$/, (w: ClientsWorld) => {
    w.irun = tcCli(w, ['install', '--yes'])
    expect(w.irun.status, w.irun.out).toBe(0)
    expect(w.irun.out, 'install did not detect Codex CLI').toMatch(/Detected agents:.*Codex CLI/)
  })
  reg.define(/^the developer sees Codex CLI wired for the tools and no capture hooks copied$/, (w: ClientsWorld) => {
    const toml = readFileSync(agentConfigPath('codex', w.ihome!), 'utf8')
    expect(toml, 'Codex CLI has no treecontext MCP server').toMatch(/^\[mcp_servers\.treecontext\]/m)
    expect(toml).toMatch(/^command = ".+"/m)
    // No copy in either place Codex reads hooks from, and no wrapper a copy
    // would point at.
    expect(ownedHookCommands(join(w.ihome!, '.codex', 'hooks.json')), 'capture hooks were copied into hooks.json').toEqual([])
    // config.toml holds the MCP registration and nothing else of ours: every
    // table install wrote there is an mcp_servers table, so no [hooks] copy.
    const tables = [...toml.matchAll(/^\[([^\]]+)\]/gm)].map(m => m[1]!)
    expect(tables.length).toBeGreaterThan(0)
    expect(tables.filter(t => !t.startsWith('mcp_servers')), 'config.toml carries a table other than the MCP registration').toEqual([])
    const hooksDir = join(w.ihome!, '.claude', 'hooks')
    const wrappers = existsSync(hooksDir) ? readdirSync(hooksDir).filter(f => f.startsWith('tc-codex-')) : []
    expect(wrappers, 'codex hook wrappers were written').toEqual([])
    expect(w.irun!.out).toMatch(/hooks: skipped — automatic capture is unverified on Codex CLI/)
  })
  reg.define(/^the developer running doctor sees the Codex CLI row name the flagged command as the way to copy them$/, (w: ClientsWorld) => {
    const run = tcCli(w, ['doctor'])
    w.doctorOut = run.out
    const row = doctorRow(run.out, 'Codex CLI')
    expect(row, 'the Codex row does not say the hooks were not copied').toMatch(/hooks not copied/)
    expect(row, 'the Codex row does not name the flagged command').toContain('to copy them: treecontext install --agent codex --experimental-capture')
  })

  // ── a teammate on another agent reads and writes through the tools (D152)
  reg.define(/^a teammate on Gemini CLI with the treecontext server configured and no hooks$/, async (w: ClientsWorld) => {
    await openInstallWorld(w, ['.gemini'])
    w.iproj = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-clients-proj-')))
    w.defer(() => rmSync(w.iproj!, { recursive: true, force: true }))
    mkdirSync(w.iproj, { recursive: true })
    const run = tcCli(w, ['install', '--yes', '--agent', 'gemini'])
    expect(run.status, run.out).toBe(0)
    const settingsPath = agentConfigPath('gemini', w.ihome!)
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>
    }
    const entry = settings.mcpServers?.['treecontext']
    expect(entry, 'Gemini CLI has no treecontext server configured').toBeDefined()
    expect(ownedHookCommands(settingsPath), 'capture hooks were written for Gemini CLI').toEqual([])
    // The teammate's agent launches what Gemini's settings name, the way
    // Gemini would: those args, over stdio, through the entry point the
    // configured launcher pins. One substitution, the one the install wave
    // already accepts: this suite drives the TypeScript source, so the
    // launcher's pinned cli.js is reached through its .ts twin under tsx —
    // the launcher itself would exec a dist/ build `npm test` never makes.
    expect(entry!.command, 'Gemini is not launched through the MCP launcher').toBe(mcpLauncherIn(w.ihome!))
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
    const client = new Client({ name: 'gemini-teammate', version: '0' })
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
    const db = new BetterSqlite3(dbs[0]!, { readonly: true })
    try {
      const row = db.prepare('SELECT content FROM nodes WHERE node_id = ?').get(w.teammateNodeId) as { content: Buffer | string } | undefined
      expect(row, 'the inserted entry is not in the store').toBeDefined()
      expect(decodeContent(row!.content)).toBe('ux: the login form uses the compact layout')
    } finally {
      db.close()
    }
  })
  reg.define(/^the documentation the teammate reads promises no capture of their session$/, (w: ClientsWorld) => {
    // The README: Gemini's matrix row is documented only, and the team
    // section says plainly that other agents get the tools, not capture.
    // LF-normalized so the character-count window below means the same on an
    // autocrlf (Windows) checkout.
    const readme = readFileSync(join(TS_ROOT, 'README.md'), 'utf8').replace(/\r\n/g, '\n')
    const gemini = parseMatrix(readme).find(r => r.client === 'Gemini CLI')
    expect(gemini?.status).toBe('documented only')
    const team = readme.slice(readme.indexOf('### Working as a team'))
    expect(readme.indexOf('### Working as a team'), 'README has no team section').toBeGreaterThanOrEqual(0)
    expect(team.slice(0, 2500).replace(/\s+/g, ' ')).toMatch(/Capture is verified only on Claude Code\.[^.]*Gemini[^.]*gets the tools[^.]*nothing of their session is captured/)
    // And the block install wrote into Gemini's own instructions file, which
    // the teammate's agent reads every session: capture is Claude Code's.
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
  const CLIENT_RE = '(Codex CLI|Gemini CLI|VS Code|Cursor|OpenCode)'
  reg.define(new RegExp(`^${CLIENT_RE} is installed and its hook configuration holds no treecontext hooks$`), async (w: ClientsWorld, ...captures) => {
    const [client] = captures as string[]
    w.clientName = client!
    await openInstallWorld(w, [])
    mkdirSync(clientDir(CLIENT_SLUG[client!]!, w.ihome!), { recursive: true })
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
  reg.define(/^the installer ran without the experimental flag$/, (w: ClientsWorld) => {
    w.irun = tcCli(w, ['install', '--yes'])
    expect(w.irun.status, w.irun.out).toBe(0)
    expect(w.irun.out, `install did not detect ${w.clientName}`).toMatch(new RegExp(`Detected agents:.*${w.clientName}`))
    // Said in so many words for every client with hooks to skip.
    if (w.clientName !== 'OpenCode') {
      expect(w.irun.out).toContain(`hooks: skipped — automatic capture is unverified on ${w.clientName}`)
    }
    // The client's own hook configuration still holds nothing of ours: the
    // installer writes nothing for an as-is client and copies nothing
    // without the flag (D208).
    const slug = CLIENT_SLUG[w.clientName!]!
    expect(treecontextHookMentions(clientHookFile(slug, w.ihome!)), `install wrote hooks for ${w.clientName}`).toEqual([])
    if (slug === 'codex') expect(treecontextHookMentions(join(w.ihome!, '.codex', 'config.toml'))).toEqual([])
  })
  reg.define(/^the developer runs doctor$/, (w: ClientsWorld) => {
    w.clause = readClause(w, w.clientName!)
  })
  reg.define(new RegExp(`^the developer sees doctor's row for ${CLIENT_RE} say the client (.+)$`), (w: ClientsWorld, ...captures) => {
    const [client, mode] = captures as string[]
    expect(client).toBe(w.clientName)
    const c = w.clause!
    // The mode is the README matrix's Mode cell, exactly — so a reworded
    // parenthetical on either side fails — and carries the feature's phrase.
    const readmeRow = parseMatrix(readFileSync(join(TS_ROOT, 'README.md'), 'utf8')).find(r => r.client.startsWith(client!))
    expect(readmeRow, `the README matrix has no row for ${client}`).toBeDefined()
    expect(c.mode).toBe(readmeRow!.mode)
    expect(c.mode).toContain(mode)
    for (const re of MODE_FAMILY[client!]!) {
      expect(c.mode, `doctor's mode for ${client}`).toMatch(re)
      expect(readmeRow!.mode, `the README's mode for ${client}`).toMatch(re)
    }
    // Doctor never claims capture is verified on any of these (D153).
    expectNoVerifiedClaim(c.row)
  })
  reg.define(/^the row states the current installation state$/, (w: ClientsWorld) => {
    const c = w.clause!
    const home = w.ihome!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const expected: Record<string, RegExp> = {
      'Codex CLI': new RegExp(`^hooks not copied into ${home}[\\\\/]\\.codex[\\\\/]hooks\\.json \\(capture unverified — MCP tools only\\)$`),
      'Gemini CLI': new RegExp(`^hooks not copied into ${home}[\\\\/]\\.gemini[\\\\/]settings\\.json \\(capture unverified — MCP tools only\\)$`),
      'VS Code': new RegExp(`^chat\\.useClaudeHooks is off in ${vscodeSettings(w.ihome!).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} and the Claude Code hooks block is installed$`),
      'Cursor': /^the Claude Code hooks block is installed — Cursor reads it \(capture unverified\)$/,
      'OpenCode': /^no hooks to install — MCP tools only \(nothing is captured\)$/,
    }
    expect(c.state).toMatch(expected[w.clientName!]!)
    // Tools only is the correct state without the opt-in, so the row is not
    // a warning and carries no fix line of its own.
    expect(c.status, c.row).toBe('ok')
    expect(c.fix).toBeNull()
  })
  reg.define(/^the row names (the flagged command that copies them|turning that setting on|nothing) as the remedy$/, (w: ClientsWorld, ...captures) => {
    const [remedy] = captures as string[]
    const c = w.clause!
    const slug = CLIENT_SLUG[w.clientName!]!
    if (remedy === 'nothing') {
      expect(c.remedy).toBe('nothing to do')
      return
    }
    if (remedy === 'the flagged command that copies them') {
      const command = `treecontext install --agent ${slug} --experimental-capture`
      expect(c.remedy).toBe(`to copy them: ${command}`)
      // The remedy is a command that does what it says: run it as printed,
      // and doctor's row now reads the copy present and consistent.
      runNamedCommand(w, command)
      const after = readClause(w, w.clientName!)
      expect(after.state).toMatch(/: present and consistent with the (translated )?Claude Code block/)
      expect(after.remedy).toBe('nothing to do')
      expectNoVerifiedClaim(after.row)
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

  // ── a copied configuration, verbatim (Codex CLI) or translated (Gemini CLI),
  //    read present and consistent or inconsistent with its remedy (D161) ──
  reg.define(/^(Codex CLI|Gemini CLI) is installed and its hook configuration holds (a copy identical to|a copy that differs from|the translated copy of|a translated copy that differs from) the Claude Code block$/, async (w: ClientsWorld, ...captures) => {
    const [client, how] = captures as string[]
    w.clientName = client!
    const slug = CLIENT_SLUG[client!]!
    await openInstallWorld(w, [])
    mkdirSync(clientDir(slug, w.ihome!), { recursive: true })
    // The block as the real installer writes it today, then the client wired
    // for the tools the way a no-flag install leaves it.
    let run = tcCli(w, ['install', '--yes', '--agent', 'claude'])
    expect(run.status, run.out).toBe(0)
    run = tcCli(w, ['install', '--yes', '--agent', slug])
    expect(run.status, run.out).toBe(0)
    w.claudeBlock = (JSON.parse(readFileSync(join(w.ihome!, '.claude', 'settings.json'), 'utf8')) as { hooks: HookBlock }).hooks
    let copy: HookBlock
    if (slug === 'codex') {
      copy = structuredClone(w.claudeBlock)
      // An older copy: taken before the block gained its Stop hook.
      if (how === 'a copy that differs from') delete copy['Stop']
      writeFileSync(clientHookFile('codex', w.ihome!)!, JSON.stringify({ hooks: copy }, null, 2))
    } else {
      copy = translateForGemini(w.claudeBlock)
      // Every translated event is one Gemini's own documentation offers.
      const offered = parseMatrix(readFileSync(join(TS_ROOT, 'README.md'), 'utf8')).find(r => r.client === 'Gemini CLI')!.events
      for (const e of Object.keys(copy)) expect(offered, `Gemini offers no ${e}`).toContain(e)
      if (how === 'a translated copy that differs from') {
        // One event copied across verbatim, never renamed.
        copy['PostToolUse'] = copy['AfterTool']!
        delete copy['AfterTool']
      }
      // Gemini keeps its hooks beside its MCP registration: write into the
      // settings file install wrote, keeping every key already there.
      const settingsPath = clientHookFile('gemini', w.ihome!)!
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
      expect(settings['mcpServers'], 'the tools-only install registered no server').toBeDefined()
      writeFileSync(settingsPath, JSON.stringify({ ...settings, hooks: copy }, null, 2))
    }
    expect(treecontextHookMentions(clientHookFile(slug, w.ihome!)).length, 'the copy holds no treecontext hook').toBeGreaterThan(0)
  })
  reg.define(/^the developer sees doctor's row for (Codex CLI|Gemini CLI) read present and (consistent|inconsistent)$/, (w: ClientsWorld, ...captures) => {
    const [client, verdict] = captures as string[]
    expect(client).toBe(w.clientName)
    const c = w.clause!
    const block = client === 'Gemini CLI' ? 'the translated Claude Code block' : 'the Claude Code block'
    const readmeRow = parseMatrix(readFileSync(join(TS_ROOT, 'README.md'), 'utf8')).find(r => r.client === client)
    expect(c.mode).toBe(readmeRow!.mode)
    expect(c.mode).toContain(client === 'Gemini CLI'
      ? 'copies the hooks into its own translated configuration'
      : 'copies the hooks into its own configuration')
    expect(c.state).toContain(`hooks copied into ${clientHookFile(CLIENT_SLUG[client!]!, w.ihome!)}: present and ${verdict} with ${block}`)
    expectNoVerifiedClaim(c.row)
    if (verdict === 'consistent') {
      expect(c.status, c.row).toBe('ok')
      expect(c.remedy).toBe('nothing to do')
      expect(c.fix).toBeNull()
    } else {
      expect(c.status, c.row).toBe('warn')
      // It says where the copy went wrong, in the client's own event names.
      expect(c.state).toMatch(client === 'Gemini CLI' ? /differs on .*AfterTool.*PostToolUse|differs on .*PostToolUse.*AfterTool/ : /differs on Stop\b/)
    }
  })
  reg.define(/^the row names the command that rewrites the copy$/, (w: ClientsWorld) => {
    const c = w.clause!
    const slug = CLIENT_SLUG[w.clientName!]!
    const command = `treecontext install --agent ${slug} --experimental-capture`
    expect(c.remedy).toBe(`to rewrite the copy: ${command}`)
    expect(c.fix).toBe(command)
    // Run it as printed: the copy is rewritten to the block install writes
    // today — the oracle's verbatim or translated block — and doctor reads
    // it present and consistent.
    runNamedCommand(w, command)
    const path = clientHookFile(slug, w.ihome!)!
    const written = JSON.parse(readFileSync(path, 'utf8')) as { hooks?: HookBlock; mcpServers?: unknown }
    expect(written.hooks).toEqual(slug === 'gemini' ? translateForGemini(w.claudeBlock!) : w.claudeBlock)
    if (slug === 'gemini') expect(written.mcpServers, 'the rewrite dropped the MCP registration').toBeDefined()
    const after = readClause(w, w.clientName!)
    expect(after.state).toMatch(/: present and consistent with/)
    expect(after.status).toBe('ok')
    expectNoVerifiedClaim(after.row)
  })
}
