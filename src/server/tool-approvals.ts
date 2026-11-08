import { readInstallState, updateInstallState, type InstallState, type ToolApprovalsState, type WrittenApprovals } from './install-state.js'

// ── One approval rule for the clients that run headless workers (D381, D390) ──
//
// Install pre-approves the four tools that read and write the journal,
// status, query, export and insert, in each client a headless worker runs
// in, and writes nothing for the four that remove or bring in rows, which
// keep asking, so a headless worker's request for them is refused. A rule
// or approval the developer wrote, allow, ask or deny, or a default for the
// server, always wins: install never writes over one, never adds an
// approval one of them is meant to govern, and never removes one. What
// install wrote is recorded (install-state.ts), so `config tool-approvals
// off` and uninstall remove exactly that; an off the developer chose is
// recorded too, and every later install keeps it until `config
// tool-approvals on`.
//
// The clients: Claude Code, whose grant is `mcp__treecontext__<tool>` in
// `permissions.allow` of its settings.json; Codex CLI, whose grant is
// `tools.<tool>.approval_mode = "approve"` in its treecontext entry; and
// Antigravity CLI (D383), whose grant is `mcp(treecontext/<tool>)` in
// `permissions.allow` of `~/.gemini/antigravity-cli/settings.json`, ranked
// as agy ranks its rules, deny over ask over allow. Claude Code and agy
// share one shape, an allow list beside ask and deny lists, and differ
// only in how a rule names a tool (a RuleDialect).

/** The four tools a headless worker is approved for: they read and write the journal. */
export const APPROVED_TOOLS = ['treecontext_status', 'treecontext_query', 'treecontext_export', 'treecontext_insert'] as const
/** The four that remove or bring in rows: install approves none of them, so they keep asking. */
export const ASKING_TOOLS = ['treecontext_clear', 'treecontext_delete', 'treecontext_import', 'treecontext_merge_from_agent'] as const

/** The clients install writes approvals for, by slug. */
export const APPROVAL_CLIENTS = ['claude', 'codex', 'agy'] as const
export type ApprovalClient = typeof APPROVAL_CLIENTS[number]
export const APPROVAL_CLIENT_NAMES: Readonly<Record<ApprovalClient, string>> = { claude: 'Claude Code', codex: 'Codex CLI', agy: 'Antigravity CLI' }

export function isApprovalClient(slug: string): slug is ApprovalClient {
  return (APPROVAL_CLIENTS as readonly string[]).includes(slug)
}

export const TOOL_APPROVALS_OFF_COMMAND = 'treecontext config tool-approvals off'
export const TOOL_APPROVALS_ON_COMMAND = 'treecontext config tool-approvals on'
export const NO_TOOL_APPROVALS_FLAG = 'install --no-tool-approvals'

/** A tool's short name, as the developer says it: status, query, …, merge. */
export function shortName(tool: string): string {
  return tool.replace(/^treecontext_/, '').replace(/_from_agent$/, '')
}

/** "a, b, c and d" */
export function andList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]!}`
}

/** "status, query, export and insert" */
export function toolWords(tools: readonly string[]): string {
  return andList(tools.map(shortName))
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

// ── The record ─────────────────────────────────────────────────────────

/** The developer's choice for a client: on (the default), off (chosen), or unknown (the record did not parse). */
export type ApprovalsChoice =
  | { state: 'on' }
  | { state: 'off'; at: string; how: 'config' | 'install' }
  | { state: 'unknown'; backup: string | null }

export function approvalsChoice(slug: ApprovalClient): ApprovalsChoice {
  const t = readInstallState().toolApprovals
  const unknown = t?.unknown?.[slug]
  if (unknown) return { state: 'unknown', backup: unknown.backup }
  const off = t?.off?.[slug]
  return off ? { state: 'off', ...off } : { state: 'on' }
}

/** Drop empty containers of the approvals record. */
function tidy(state: InstallState): InstallState {
  const t = state.toolApprovals
  if (!t) return state
  for (const k of ['off', 'unknown', 'written'] as const) if (t[k] && Object.keys(t[k]!).length === 0) delete t[k]
  if (Object.keys(t).length === 0) delete state.toolApprovals
  return state
}

/** Record the developer's choice for these clients: off, or on again; either settles an unknown. */
export function recordApprovalsChoice(slugs: readonly ApprovalClient[], choice: 'on' | 'off', how: 'config' | 'install'): void {
  updateInstallState((state) => {
    const t: ToolApprovalsState = { ...state.toolApprovals }
    const off = { ...t.off }
    const unknown = { ...t.unknown }
    const at = new Date().toISOString()
    for (const s of slugs) {
      delete unknown[s]
      if (choice === 'off') off[s] = { at, how }
      else delete off[s]
    }
    t.off = off
    t.unknown = unknown
    state.toolApprovals = t
    return tidy(state)
  })
}

/** What install recorded writing for a client, per file. */
export function writtenApprovals(slug: ApprovalClient): Record<string, WrittenApprovals> {
  return readInstallState().toolApprovals?.written?.[slug] ?? {}
}

/** Replace the record for one client file: what install wrote there now (none forgets the file). */
export function recordWrittenApprovals(slug: ApprovalClient, file: string, items: readonly string[], created: readonly string[] = []): void {
  const was = readInstallState().toolApprovals?.written?.[slug]?.[file]
  // Nothing to say that the record does not already say: no write, and no
  // record file created for a client install wrote nothing into.
  if (items.length === 0 && was === undefined) return
  if (was && JSON.stringify(was.items) === JSON.stringify(items) && JSON.stringify(was.created ?? []) === JSON.stringify(created)) return
  updateInstallState((state) => {
    const t: ToolApprovalsState = { ...state.toolApprovals }
    const written = { ...t.written }
    const files = { ...written[slug] }
    if (items.length > 0) {
      files[file] = { items: [...items], ...(created.length > 0 ? { created: [...created] } : {}), at: files[file]?.at ?? new Date().toISOString() }
    } else {
      delete files[file]
    }
    if (Object.keys(files).length > 0) written[slug] = files
    else delete written[slug]
    t.written = written
    state.toolApprovals = t
    return tidy(state)
  })
}

// ── Allow lists: Claude Code's settings.json and agy's ─────────────────

/** How a client's permission rules name a tool: the rule install writes, and whether a rule covers a tool. */
export interface RuleDialect {
  rule(tool: string): string
  covers(rule: string, tool: string): boolean
}

/** Claude Code's permission rule for one treecontext tool. */
export function claudeRule(tool: string): string {
  return `mcp__treecontext__${tool}`
}

/** Rules that name the whole treecontext server in Claude Code. */
const CLAUDE_SERVER_RULES = new Set(['mcp__treecontext', 'mcp__treecontext__*'])

function claudeRuleCovers(rule: string, tool: string): boolean {
  return rule === claudeRule(tool) || CLAUDE_SERVER_RULES.has(rule)
}

export const CLAUDE_DIALECT: RuleDialect = { rule: claudeRule, covers: claudeRuleCovers }

/** Antigravity CLI's permission rule for one treecontext tool (D383). */
export function agyRule(tool: string): string {
  return `mcp(treecontext/${tool})`
}

/** A target part of an agy rule, `*` matching anything, read against a name. */
function agyPartMatches(pattern: string, name: string): boolean {
  if (!pattern.includes('*')) return pattern === name
  const re = new RegExp(`^${pattern.split('*').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
  return re.test(name)
}

/**
 * Whether an agy rule decides a treecontext tool: `mcp(treecontext/<tool>)`,
 * `mcp(treecontext/*)` and `mcp(*)` as agy's documentation gives them, and
 * any `*` pattern in the server or tool part read the same way, so a rule
 * of the developer's that would cover the tool is never written beside.
 */
export function agyRuleCovers(rule: string, tool: string): boolean {
  const m = /^\s*mcp\s*\(\s*(.*?)\s*\)\s*$/.exec(rule)
  if (!m) return false
  const target = m[1]!
  if (target === '*') return true
  const slash = target.indexOf('/')
  if (slash < 0) return agyPartMatches(target, 'treecontext')
  return agyPartMatches(target.slice(0, slash), 'treecontext') && agyPartMatches(target.slice(slash + 1), tool)
}

export const AGY_DIALECT: RuleDialect = { rule: agyRule, covers: agyRuleCovers }

/** A rule of the developer's that decides a tool, and the list it is in. */
export interface DeveloperRule { list: 'allow' | 'ask' | 'deny'; rule: string }

/**
 * The developer's rule that governs a tool in a settings object, read the
 * way Claude Code and agy rank them: deny over ask over allow. Rules install
 * wrote (`ours`) are not the developer's.
 */
export function governingRule(data: Record<string, unknown>, tool: string, ours: ReadonlySet<string>, dialect: RuleDialect): DeveloperRule | null {
  const perms = data['permissions']
  if (!isObject(perms)) return null
  for (const list of ['deny', 'ask', 'allow'] as const) {
    const rules = perms[list]
    if (!Array.isArray(rules)) continue
    for (const r of rules) {
      if (typeof r !== 'string') continue
      if (list === 'allow' && ours.has(r)) continue
      if (dialect.covers(r, tool)) return { list, rule: r }
    }
  }
  return null
}

/** Claude Code's governing rule (governingRule in Claude Code's dialect). */
export function claudeGoverningRule(data: Record<string, unknown>, tool: string, ours: ReadonlySet<string>): DeveloperRule | null {
  return governingRule(data, tool, ours, CLAUDE_DIALECT)
}

export interface ClaudeApprovalMerge {
  /** The settings to write, or null when nothing changes. */
  data: Record<string, unknown> | null
  /** Rules this merge added. */
  added: string[]
  /** Every rule of install's in the file afterwards (the record). */
  ours: string[]
  /** Containers install has created to hold its rules, for the record. */
  created: string[]
  /** The four tools each held by a rule of the developer's, left alone. */
  developer: Array<{ tool: string; rule: DeveloperRule }>
  /** `permissions` or `permissions.allow` is not what the client reads, so nothing was added. */
  unwritable?: string
}

/**
 * Add the client's allow rule for each of the four tools where no rule of
 * the developer's (allow, ask or deny, for the tool or the whole server)
 * decides it, and nothing else. `recorded` is what install wrote before.
 * Every other key of the file stays as it is.
 */
export function withAllowRules(data: Record<string, unknown>, recorded: WrittenApprovals | undefined, dialect: RuleDialect): ClaudeApprovalMerge {
  const oursBefore = new Set(recorded?.items ?? [])
  const created = new Set(recorded?.created ?? [])
  const perms = data['permissions']
  if (perms !== undefined && !isObject(perms)) {
    return { data: null, added: [], ours: [], created: [], developer: [], unwritable: '"permissions" is not an object' }
  }
  const allow = isObject(perms) ? perms['allow'] : undefined
  if (allow !== undefined && !Array.isArray(allow)) {
    return { data: null, added: [], ours: [], created: [], developer: [], unwritable: '"permissions.allow" is not a list' }
  }
  const have = (allow ?? []) as unknown[]
  // Install's rules still in the file; one the developer removed is gone from the record.
  const ours = [...oursBefore].filter(r => have.includes(r))
  const added: string[] = []
  const developer: ClaudeApprovalMerge['developer'] = []
  for (const tool of APPROVED_TOOLS) {
    const theirs = governingRule(data, tool, new Set(ours), dialect)
    if (theirs) { developer.push({ tool, rule: theirs }); continue }
    const rule = dialect.rule(tool)
    if (ours.includes(rule)) continue
    added.push(rule)
  }
  if (added.length === 0) {
    return { data: null, added, ours, created: ours.length > 0 ? [...created] : [], developer }
  }
  if (!isObject(perms)) created.add('permissions')
  if (allow === undefined) created.add('allow')
  const nextPerms = { ...(isObject(perms) ? perms : {}), allow: [...have, ...added] }
  return { data: { ...data, permissions: nextPerms }, added, ours: [...ours, ...added], created: [...created], developer }
}

/** Claude Code's four allow rules merged into its settings (withAllowRules in Claude Code's dialect). */
export function withClaudeApprovals(data: Record<string, unknown>, recorded: WrittenApprovals | undefined): ClaudeApprovalMerge {
  return withAllowRules(data, recorded, CLAUDE_DIALECT)
}

/**
 * Take install's rules back out of a settings object: each rule the record
 * names, from `permissions.allow`, and the containers install created when
 * they are left empty. Every other rule and key stays as it is. A rule the
 * developer moved to another list is no longer install's to take.
 */
export function withoutClaudeApprovals(data: Record<string, unknown>, recorded: WrittenApprovals): { data: Record<string, unknown> | null; removed: string[] } {
  const perms = data['permissions']
  if (!isObject(perms) || !Array.isArray(perms['allow'])) return { data: null, removed: [] }
  const allow = perms['allow'] as unknown[]
  const removed = recorded.items.filter(r => allow.includes(r))
  if (removed.length === 0) return { data: null, removed }
  const left = allow.filter(r => typeof r !== 'string' || !recorded.items.includes(r))
  const created = new Set(recorded.created ?? [])
  const nextPerms: Record<string, unknown> = { ...perms }
  if (left.length === 0 && created.has('allow')) delete nextPerms['allow']
  else nextPerms['allow'] = left
  const next: Record<string, unknown> = { ...data }
  if (Object.keys(nextPerms).length === 0 && created.has('permissions')) delete next['permissions']
  else next['permissions'] = nextPerms
  return { data: next, removed }
}

/** The same take-back for agy's settings: the record decides, the shape is the same. */
export const withoutAllowRules = withoutClaudeApprovals

// ── Codex CLI: per-tool approvals in the treecontext entry ─────────────

/** The value install writes for each of the four tools. */
export const CODEX_APPROVE = 'approve'
/** The developer's default for the server's tools. */
export const CODEX_DEFAULT_KEY = 'default_tools_approval_mode'

/** The dotted key Codex itself names in its errors, for one tool's approval. */
export function codexApprovalKey(tool: string): string {
  return `mcp_servers.treecontext.tools.${tool}.approval_mode`
}

/** A tool's approval as the entry carries it, or undefined when none is set. */
export function codexApprovalOf(entry: Record<string, unknown>, tool: string): unknown {
  const tools = entry['tools']
  if (!isObject(tools)) return undefined
  const t = tools[tool]
  // Codex's own reading prints an unset key as null.
  return isObject(t) ? t['approval_mode'] ?? undefined : undefined
}

/** The developer's default for the server's tools, or undefined when none is set. */
export function codexDefaultOf(entry: Record<string, unknown>): unknown {
  return entry[CODEX_DEFAULT_KEY] ?? undefined
}

export interface CodexApprovalMerge {
  /** The entry to write, or null when nothing changes. */
  entry: Record<string, unknown> | null
  added: string[]
  /** Install's own approvals taken back, since a default of the developer's now decides every tool. */
  removed: string[]
  /** Every tool install has approved in the entry afterwards (the record). */
  ours: string[]
  /** The four tools each held by an approval of the developer's, left alone. */
  developer: Array<{ tool: string; value: unknown }>
  /** The developer's default for the server, which decides every tool, left alone. */
  defaultMode?: unknown
  /** `tools` (or a tool's table) is not a table, so nothing was added there. */
  unwritable?: string
}

/**
 * Approve each of the four tools one by one where the entry sets no
 * approval for it and the developer set no default for the server; write
 * nothing for the four that keep asking, and nothing over anything the
 * developer set. `recorded` is what install approved before.
 */
export function withCodexApprovals(entry: Record<string, unknown>, recorded: readonly string[]): CodexApprovalMerge {
  const ours: string[] = []
  const developer: CodexApprovalMerge['developer'] = []
  for (const tool of APPROVED_TOOLS) {
    const v = codexApprovalOf(entry, tool)
    if (v === undefined) continue
    if (v === CODEX_APPROVE && recorded.includes(tool)) ours.push(tool)
    else developer.push({ tool, value: v })
  }
  if (codexDefaultOf(entry) !== undefined) {
    // The developer's default for the server wins (D390): install's own
    // per-tool approvals would override it, so they are taken back.
    const taken = withoutCodexApprovals(entry, recorded)
    return { entry: taken.entry, added: [], removed: taken.removed, ours: [], developer, defaultMode: codexDefaultOf(entry) }
  }
  const tools = entry['tools']
  if (tools !== undefined && !isObject(tools)) {
    return { entry: null, added: [], removed: [], ours, developer, unwritable: '"tools" is not a table' }
  }
  const nextTools: Record<string, unknown> = { ...tools }
  const added: string[] = []
  let unwritable: string | undefined
  for (const tool of APPROVED_TOOLS) {
    if (codexApprovalOf(entry, tool) !== undefined) continue
    const t = nextTools[tool]
    if (t !== undefined && !isObject(t)) { unwritable = `"tools.${tool}" is not a table`; continue }
    nextTools[tool] = { ...t, approval_mode: CODEX_APPROVE }
    added.push(tool)
  }
  if (added.length === 0) return { entry: null, added, removed: [], ours, developer, ...(unwritable ? { unwritable } : {}) }
  return { entry: { ...entry, tools: nextTools }, added, removed: [], ours: [...ours, ...added], developer, ...(unwritable ? { unwritable } : {}) }
}

/**
 * Take install's approvals back out of an entry: each recorded tool whose
 * approval still reads what install wrote, and a table install's key leaves
 * empty. A value the developer changed is theirs and stays.
 */
export function withoutCodexApprovals(entry: Record<string, unknown>, recorded: readonly string[]): { entry: Record<string, unknown> | null; removed: string[] } {
  const tools = entry['tools']
  if (!isObject(tools)) return { entry: null, removed: [] }
  const nextTools: Record<string, unknown> = { ...tools }
  const removed: string[] = []
  for (const tool of recorded) {
    const t = nextTools[tool]
    if (!isObject(t) || t['approval_mode'] !== CODEX_APPROVE) continue
    const { approval_mode: _gone, ...rest } = t
    if (Object.keys(rest).length === 0) delete nextTools[tool]
    else nextTools[tool] = rest
    removed.push(tool)
  }
  if (removed.length === 0) return { entry: null, removed }
  const next: Record<string, unknown> = { ...entry }
  if (Object.keys(nextTools).length === 0) delete next['tools']
  else next['tools'] = nextTools
  return { entry: next, removed }
}

// ── What a client's files decide, tool by tool ─────────────────────────
//
// Every echo, install message and doctor row is read from what the client's
// files say now (D390: the command "echoes the behaviour it leaves in
// force"), never from what the step meant to do: for each tool, approved by
// install's own approval, decided by a rule or approval of the developer's
// (named, with its file), or by nothing, so it asks and a headless worker is
// refused it. A rule install has no record of writing is the developer's.

export const ALL_TOOLS: readonly string[] = [...APPROVED_TOOLS, ...ASKING_TOOLS]

export type ToolDecision =
  | { by: 'install'; file: string }
  | { by: 'developer'; approves: boolean; what: string; file: string; kind?: string; rule?: string }
  | { by: 'none' }

/** Each of the eight tools, and what decides it. */
export type ClientView = Record<string, ToolDecision>

/** One settings file a client reads, as read: its data (null when it cannot be read) and what install recorded writing there. */
export interface ClaudeSettingsSource { file: string; data: Record<string, unknown> | null; recorded?: WrittenApprovals }

/** Claude Code's view across its settings files (allowListView in Claude Code's dialect). */
export function claudeView(sources: readonly ClaudeSettingsSource[]): ClientView {
  return allowListView(sources, CLAUDE_DIALECT)
}

/** Antigravity CLI's view across its global settings and the project file that applies (allowListView in agy's dialect). */
export function agyView(sources: readonly ClaudeSettingsSource[]): ClientView {
  return allowListView(sources, AGY_DIALECT)
}

/** A client's view across its settings files: deny anywhere over ask anywhere over allow (theirs, then install's). */
export function allowListView(sources: readonly ClaudeSettingsSource[], dialect: RuleDialect): ClientView {
  const view: ClientView = {}
  for (const tool of ALL_TOOLS) {
    const found: Record<'deny' | 'ask' | 'allow' | 'ours', { rule: string; file: string } | undefined> = { deny: undefined, ask: undefined, allow: undefined, ours: undefined }
    for (const src of sources) {
      const perms = src.data?.['permissions']
      if (!isObject(perms)) continue
      const ours = new Set(src.recorded?.items ?? [])
      for (const list of ['deny', 'ask', 'allow'] as const) {
        const rules = perms[list]
        if (!Array.isArray(rules)) continue
        for (const r of rules) {
          if (typeof r !== 'string' || !dialect.covers(r, tool)) continue
          const slot = list === 'allow' && ours.has(r) ? 'ours' : list
          found[slot] ??= { rule: r, file: src.file }
        }
      }
    }
    const d = found.deny ?? found.ask
    if (d) {
      const kind = `${found.deny ? 'deny' : 'ask'} rule`
      view[tool] = { by: 'developer', approves: false, what: `${kind} ${d.rule}`, file: d.file, kind, rule: d.rule }
    } else if (found.allow) {
      view[tool] = { by: 'developer', approves: true, what: `allow rule ${found.allow.rule}`, file: found.allow.file, kind: 'allow rule', rule: found.allow.rule }
    }
    else if (found.ours) view[tool] = { by: 'install', file: found.ours.file }
    else view[tool] = { by: 'none' }
  }
  return view
}

/** Codex's view of its treecontext entry: `fileOf` names the file each key came from. */
export function codexView(entry: Record<string, unknown>, recorded: readonly string[], userFile: string, fileOf: (key: string) => string = () => userFile): ClientView {
  const view: ClientView = {}
  const def = codexDefaultOf(entry)
  const defKey = `mcp_servers.treecontext.${CODEX_DEFAULT_KEY}`
  for (const tool of ALL_TOOLS) {
    const v = codexApprovalOf(entry, tool)
    if (v !== undefined) {
      const key = codexApprovalKey(tool)
      const file = fileOf(key)
      view[tool] = v === CODEX_APPROVE && recorded.includes(tool) && file === userFile
        ? { by: 'install', file }
        : { by: 'developer', approves: v === CODEX_APPROVE, what: `${key} = ${JSON.stringify(v)}`, file, kind: 'approval', rule: `${key} = ${JSON.stringify(v)}` }
    } else if (def !== undefined) {
      view[tool] = { by: 'developer', approves: def === CODEX_APPROVE, what: `${defKey} = ${JSON.stringify(def)}`, file: fileOf(defKey) }
    } else {
      view[tool] = { by: 'none' }
    }
  }
  return view
}

/** A view in words. */
export interface ViewWords {
  /** Of the four, those install's own approvals approve. */
  byInstall: string[]
  /** Of the four, those nothing approves (install would write them). */
  unapproved: string[]
  /** Of the four, those a rule of the developer's refuses. */
  developerRefuses: string[]
  /** Of the four, those a headless worker is refused: unapproved or refused by the developer. */
  refused: string[]
  /** Of the four that keep asking, those nothing approves or refuses. */
  asking: string[]
  /** Every tool a rule of the developer's decides, grouped by rule: "status and query approved by your allow rule R in F". */
  developer: string[]
  /** The developer's rules that refuse one of the four, as a remedy names them. */
  refusingRules: string[]
}

export function viewWords(view: ClientView): ViewWords {
  const of = (tools: readonly string[], p: (d: ToolDecision) => boolean): string[] => tools.filter(t => p(view[t]!))
  const groups = new Map<string, { tools: string[]; approves: boolean; kind: string; rules: string[]; file: string }>()
  for (const tool of ALL_TOOLS) {
    const d = view[tool]!
    if (d.by !== 'developer') continue
    // Rules of one kind in one file read as one group: "your allow rules A and B in F".
    const kind = d.kind ?? d.what
    const k = `${kind}\0${d.file}\0${d.approves}`
    const g = groups.get(k) ?? { tools: [], approves: d.approves, kind, rules: [], file: d.file }
    g.tools.push(tool)
    if (d.rule !== undefined && !g.rules.includes(d.rule)) g.rules.push(d.rule)
    groups.set(k, g)
  }
  // Codex's approvals read as the configuration lines themselves.
  const ruleWords = (g: { kind: string; rules: string[] }): string =>
    g.rules.length === 0 ? g.kind : g.kind === 'approval' ? andList(g.rules) : g.rules.length === 1 ? `${g.kind} ${g.rules[0]}` : `${g.kind}s ${andList(g.rules)}`
  const developerRefuses = of(APPROVED_TOOLS, d => d.by === 'developer' && !d.approves)
  const unapproved = of(APPROVED_TOOLS, d => d.by === 'none')
  return {
    byInstall: of(APPROVED_TOOLS, d => d.by === 'install'),
    unapproved,
    developerRefuses,
    refused: APPROVED_TOOLS.filter(t => unapproved.includes(t) || developerRefuses.includes(t)),
    asking: of(ASKING_TOOLS, d => d.by === 'none'),
    developer: [...groups.values()].map(g => `${toolWords(g.tools)} ${g.approves ? 'approved' : 'refused'} by your ${ruleWords(g)} in ${g.file}`),
    refusingRules: [...groups.values()].filter(g => !g.approves && g.tools.some(t => (APPROVED_TOOLS as readonly string[]).includes(t))).map(g => `your ${ruleWords(g)} in ${g.file}`),
  }
}

/** One client's state in words, for install's message and the config command's echo. */
export function clientStateWords(view: ClientView, installWhere: string): string {
  const w = viewWords(view)
  const parts = [w.byInstall.length > 0 ? `${toolWords(w.byInstall)} approved by install (${installWhere})` : 'none approved by install']
  parts.push(...w.developer)
  if (w.unapproved.length > 0) parts.push(`${toolWords(w.unapproved)} not approved`)
  if (w.asking.length > 0) parts.push(`still asking: ${toolWords(w.asking)}`)
  return parts.join('; ')
}

// ── Doctor's clauses ───────────────────────────────────────────────────

/** A row's approval clause: its words, whether it warns, and its one remedy. */
export interface ApprovalClause {
  text: string
  warn: boolean
  /** The remedy the clause names: a command, a line of the developer's, or nothing to do. */
  remedy: string
  /** Set when the remedy is the row's fix (a warning). */
  fix?: string
}

const NOTHING = 'nothing to do'

/** The off state, a choice and not a failure (D390), in what the files leave in force. */
function offWords(w: ViewWords, refusedBy: string): string {
  const parts = [`off by your choice (${TOOL_APPROVALS_OFF_COMMAND} or ${NO_TOOL_APPROVALS_FLAG})`]
  if (w.refused.length > 0) parts.push(`so headless workers will be refused ${toolWords(w.refused)}, as ${refusedBy}`)
  const head = parts.join(', ')
  return [head, ...w.developer, ...(w.byInstall.length > 0 ? [`install's own approval of ${toolWords(w.byInstall)} is still there`] : [])].join('; ')
}

function unknownWords(backup: string | null): string {
  return `not known — install's record ${backup ? `could not be read and was moved to ${backup}` : 'could not be read'}, so install writes none until you choose: ${TOOL_APPROVALS_ON_COMMAND}, or off`
}

/** Claude Code's approval clause, from its effective settings files. */
export function claudeApprovalClause(view: ClientView, unreadable: readonly string[], userFile: string, choice: ApprovalsChoice): ApprovalClause {
  const label = 'tool approvals'
  const w = viewWords(view)
  const install = 'treecontext install --agent claude'
  if (choice.state === 'unknown') return { text: `${label}: ${unknownWords(choice.backup)}`, warn: true, remedy: TOOL_APPROVALS_ON_COMMAND, fix: TOOL_APPROVALS_ON_COMMAND }
  if (choice.state === 'off') {
    return { text: `${label}: ${offWords(w, 'Claude Code asks before each and a `claude -p` worker cannot be asked')}`, warn: false, remedy: TOOL_APPROVALS_ON_COMMAND }
  }
  const unread = unreadable.length > 0 ? `; ${andList(unreadable)} could not be read as settings` : ''
  if (w.refused.length === 0) {
    const where = w.byInstall.length > 0 ? [`${toolWords(w.byInstall)} allowed in ${userFile}`] : []
    const theirs = w.developer.length > 0 ? `${where.length > 0 ? '; ' : ''}${w.developer.join('; ')}` : ''
    return { text: `${label}: ${where.join('')}${theirs}, so a \`claude -p\` worker can use ${toolWords(APPROVED_TOOLS)}${unread}`, warn: unreadable.length > 0, remedy: NOTHING }
  }
  const why: string[] = []
  if (w.unapproved.length > 0) why.push(`${andList(w.unapproved)} ${w.unapproved.length === 1 ? 'is' : 'are'} not allowed in ${userFile}`)
  why.push(...w.developer)
  const remedy = w.unapproved.length > 0 ? install : `${w.refusingRules.join(' and ')}, yours to change (install leaves it)`
  return { text: `${label}: a \`claude -p\` worker would be refused ${andList(w.refused)} — ${why.join('; ')}${unread}`, warn: true, remedy, fix: remedy }
}

/** Whether a Codex reads per-tool approvals, from its version. */
export type CodexApprovalSupport =
  | { state: 'reads'; version: string }
  | { state: 'below-floor'; version: string }
  | { state: 'unreadable' }

/** Codex's headless clause: the worker variables and the four approvals, from its effective treecontext entry. */
export function codexHeadlessClause(args: {
  configPath: string; entry: Record<string, unknown>; view: ClientView; workerVars: readonly string[]
  choice: ApprovalsChoice; support: CodexApprovalSupport; floor: string; note?: string
  /** Codex's own error when it refuses the configuration (its config/read). */
  refused?: string
}): ApprovalClause {
  const { configPath, entry, view, workerVars, choice, support, floor } = args
  if (args.refused) {
    const remedy = `fix that line in ${configPath}`
    return { text: `headless workers: Codex refuses its configuration, so a headless worker cannot start — Codex says: ${args.refused.replace(/\s*\n\s*/g, ' ')}`, warn: true, remedy, fix: remedy }
  }
  const label = 'headless workers'
  const install = 'treecontext install --agent codex'
  const note = args.note ? ` (${args.note})` : ''
  const problems: string[] = []
  let installFixes = false
  const w = viewWords(view)

  const raw = entry['env_vars']
  const names = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? [raw] : []
  const lacking = workerVars.filter(v => !names.includes(v))
  if (lacking.length > 0) {
    problems.push(`a worker's rows would land in no lane — the entry does not forward ${andList(lacking)} (env_vars)`)
    installFixes = true
  }

  if (choice.state === 'unknown') {
    problems.push(`tool approvals are ${unknownWords(choice.backup)}`)
    return { text: `${label}: ${problems.join('; ')}${note}`, warn: true, remedy: TOOL_APPROVALS_ON_COMMAND, fix: TOOL_APPROVALS_ON_COMMAND }
  }
  if (choice.state === 'off') {
    const words = `tool approvals are ${offWords(w, 'a `codex exec` worker runs with approval policy never and cannot be asked')}`
    if (problems.length === 0) return { text: `${label}: ${words}${note}`, warn: false, remedy: TOOL_APPROVALS_ON_COMMAND }
    return { text: `${label}: ${problems.join('; ')}; ${words}${note}`, warn: true, remedy: install, fix: install }
  }

  if (support.state !== 'reads') {
    const which = support.state === 'below-floor' ? `Codex ${support.version} cannot read per-tool approvals` : 'the codex command could not be run (codex --version), so whether it reads per-tool approvals is not known'
    problems.push(`${which}: its headless workers need Codex ${floor} or newer for the tools`)
    const remedy = installFixes ? install : `Codex ${floor} or newer (npm i -g @openai/codex), then ${install}`
    return { text: `${label}: ${problems.join('; ')}${note}`, warn: true, remedy, fix: remedy }
  }

  // A default of the developer's decides every tool; install's own per-tool
  // approvals would override it, and install takes them back (D390).
  const def = codexDefaultOf(entry)
  if (def !== undefined && def !== CODEX_APPROVE && w.byInstall.length > 0) {
    problems.push(`install's own approvals of ${toolWords(w.byInstall)} override your ${CODEX_DEFAULT_KEY} = ${JSON.stringify(def)}; install takes them back so your default decides`)
    installFixes = true
  }
  if (w.unapproved.length === APPROVED_TOOLS.length) {
    problems.push(`a \`codex exec\` worker would be refused every treecontext call — none of ${toolWords(APPROVED_TOOLS)} is approved in ${configPath}`)
    installFixes = true
  } else if (w.unapproved.length > 0) {
    problems.push(`a \`codex exec\` worker would be refused ${andList(w.unapproved)} — not approved in ${configPath}`)
    installFixes = true
  }
  if (w.developerRefuses.length > 0) {
    const every = w.developerRefuses.length === APPROVED_TOOLS.length
    problems.push(`a \`codex exec\` worker would be refused ${every ? 'every treecontext call' : andList(w.developerRefuses)} — ${w.developer.filter(d => / refused by /.test(d)).join('; ')}`)
  }
  const also = w.developer.filter(d => / approved by /.test(d))
  const alsoWords = also.length > 0 ? `; ${also.join('; ')}` : ''
  const extra = ASKING_TOOLS.filter(t => view[t]!.by === 'developer' && (view[t] as { approves: boolean }).approves)
  const canAlso = extra.length > 0 ? `, so a headless worker can also ${toolWords(extra)}` : ''

  if (problems.length === 0) {
    const first = view[w.byInstall[0] ?? '']
    const where = w.byInstall.length > 0 ? `, ${toolWords(w.byInstall)} approved in ${first?.by === 'install' ? first.file : configPath}` : ''
    const redundant = def !== undefined && w.byInstall.length > 0 ? `; your ${CODEX_DEFAULT_KEY} = ${JSON.stringify(def)} decides every tool, so the next install takes install's own approvals back` : ''
    return { text: `${label}: can use the tools — ${andList(workerVars)} forwarded${where}${alsoWords}${canAlso}${redundant}${note}`, warn: false, remedy: NOTHING }
  }
  const remedy = installFixes ? install : `${w.refusingRules.join(' and ')}, yours to change (install leaves it)`
  return { text: `${label}: ${problems.join('; ')}${alsoWords}${canAlso}${note}`, warn: true, remedy, fix: remedy }
}

// ── Antigravity CLI's row (D383, D387, D390) ───────────────────────────

/** What agy's MCP configuration holds for treecontext, as doctor read it. */
export type AgyEntryState =
  | { state: 'present'; disabled: boolean }
  | { state: 'absent' }
  | { state: 'unreadable' }

/**
 * Antigravity CLI's headless clause: its MCP entry, the four allow rules
 * across its global settings and the project file that applies here, and
 * any ask or deny rule of the developer's over one of them, named with its
 * file. An off the developer chose is a state, not a failure (D390).
 */
export function agyHeadlessClause(args: {
  mcpPath: string; entry: AgyEntryState; view: ClientView; settingsFile: string
  choice: ApprovalsChoice; unreadable: readonly string[]; unplaced: readonly string[]
}): ApprovalClause {
  const { mcpPath, entry, view, settingsFile, choice } = args
  const label = 'headless workers'
  const install = 'treecontext install --agent agy'
  if (entry.state === 'absent') {
    return { text: `${label}: agy has no treecontext tools — ${mcpPath} holds no treecontext server`, warn: true, remedy: install, fix: install }
  }
  if (entry.state === 'unreadable') {
    const remedy = `fix ${mcpPath} so it parses as JSON, then ${install}`
    return { text: `${label}: agy has no treecontext tools — ${mcpPath} does not parse, and agy refuses it`, warn: true, remedy, fix: remedy }
  }
  if (entry.disabled) {
    const remedy = `your "disabled": true on the treecontext server in ${mcpPath}, yours to change (install leaves it): agy mcp enable treecontext`
    return { text: `${label}: agy has no treecontext tools — the treecontext server is turned off ("disabled": true) in ${mcpPath}`, warn: true, remedy, fix: remedy }
  }
  const notes: string[] = []
  if (args.unreadable.length > 0) notes.push(`${andList(args.unreadable)} could not be read as settings`)
  if (args.unplaced.length > 0) notes.push(`${andList(args.unplaced)} ${args.unplaced.length === 1 ? 'holds' : 'hold'} permission rules for a project doctor cannot place, which agy may apply here`)
  const tail = notes.length > 0 ? `; ${notes.join('; ')}` : ''
  const w = viewWords(view)
  if (choice.state === 'unknown') {
    return { text: `${label}: tool approvals are ${unknownWords(choice.backup)}${tail}`, warn: true, remedy: TOOL_APPROVALS_ON_COMMAND, fix: TOOL_APPROVALS_ON_COMMAND }
  }
  if (choice.state === 'off') {
    return { text: `${label}: tool approvals are ${offWords(w, "agy's default preset asks before each and an `agy -p` worker cannot be asked")}${tail}`, warn: false, remedy: TOOL_APPROVALS_ON_COMMAND }
  }
  if (w.refused.length === 0) {
    const where = w.byInstall.length > 0 ? `, ${toolWords(w.byInstall)} allowed in ${settingsFile}` : ''
    const theirs = w.developer.length > 0 ? `; ${w.developer.join('; ')}` : ''
    const extra = ASKING_TOOLS.filter(t => view[t]!.by === 'developer' && (view[t] as { approves: boolean }).approves)
    const canAlso = extra.length > 0 ? `, so a headless worker can also ${toolWords(extra)}` : ''
    return { text: `${label}: an \`agy -p\` worker can use ${toolWords(APPROVED_TOOLS)}${where}${theirs}${canAlso}${tail}`, warn: notes.length > 0, remedy: NOTHING }
  }
  const why: string[] = []
  if (w.unapproved.length > 0) why.push(`${toolWords(w.unapproved)} ${w.unapproved.length === 1 ? 'is' : 'are'} not allowed in ${settingsFile}`)
  why.push(...w.developer.filter(d => / refused by /.test(d)))
  const remedy = w.unapproved.length > 0 ? install : `${w.refusingRules.join(' and ')}, yours to change (install leaves it)`
  return { text: `${label}: an \`agy -p\` worker would be refused ${andList(w.refused)} — ${why.join('; ')}${tail}`, warn: true, remedy, fix: remedy }
}
