import { readInstallState, writeInstallState, type WrittenApprovals } from './install-state.js'

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
// `permissions.allow` of its settings.json, and Codex CLI, whose grant is
// `tools.<tool>.approval_mode = "approve"` in its treecontext entry. Unit 3
// adds Antigravity CLI's allow rules here, through the same record.

/** The four tools a headless worker is approved for: they read and write the journal. */
export const APPROVED_TOOLS = ['treecontext_status', 'treecontext_query', 'treecontext_export', 'treecontext_insert'] as const
/** The four that remove or bring in rows: install approves none of them, so they keep asking. */
export const ASKING_TOOLS = ['treecontext_clear', 'treecontext_delete', 'treecontext_import', 'treecontext_merge_from_agent'] as const

/** The clients install writes approvals for, by slug. */
export const APPROVAL_CLIENTS = ['claude', 'codex'] as const
export type ApprovalClient = typeof APPROVAL_CLIENTS[number]
export const APPROVAL_CLIENT_NAMES: Readonly<Record<ApprovalClient, string>> = { claude: 'Claude Code', codex: 'Codex CLI' }

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

/** The developer turned this client's approvals off (by the config command or `install --no-tool-approvals`). */
export function approvalsOffChoice(slug: ApprovalClient): { at: string; how: 'config' | 'install' } | null {
  return readInstallState().toolApprovals?.off?.[slug] ?? null
}

export function recordApprovalsOff(slugs: readonly ApprovalClient[], how: 'config' | 'install'): void {
  const state = readInstallState()
  const at = new Date().toISOString()
  const off = { ...state.toolApprovals?.off }
  for (const s of slugs) off[s] = { at, how }
  state.toolApprovals = { ...state.toolApprovals, off }
  writeInstallState(state)
}

export function clearApprovalsOff(slugs: readonly ApprovalClient[]): void {
  const state = readInstallState()
  const off = { ...state.toolApprovals?.off }
  let changed = false
  for (const s of slugs) if (s in off) { delete off[s]; changed = true }
  if (!changed) return
  const next = { ...state.toolApprovals }
  if (Object.keys(off).length > 0) next.off = off
  else delete next.off
  state.toolApprovals = next
  if (Object.keys(next).length === 0) delete state.toolApprovals
  writeInstallState(state)
}

/** What install recorded writing for a client, per file. */
export function writtenApprovals(slug: ApprovalClient): Record<string, WrittenApprovals> {
  return readInstallState().toolApprovals?.written?.[slug] ?? {}
}

/** Replace the record for one client file: what install wrote there now (none forgets the file). */
export function recordWrittenApprovals(slug: ApprovalClient, file: string, items: readonly string[], created: readonly string[] = []): void {
  const state = readInstallState()
  const was = state.toolApprovals?.written?.[slug]?.[file]
  // Nothing to say that the record does not already say: no write, and no
  // record file created for a client install wrote nothing into.
  if (items.length === 0 && was === undefined) return
  if (was && JSON.stringify(was.items) === JSON.stringify(items) && JSON.stringify(was.created ?? []) === JSON.stringify(created)) return
  const written = { ...state.toolApprovals?.written }
  const files = { ...written[slug] }
  if (items.length > 0) {
    files[file] = { items: [...items], ...(created.length > 0 ? { created: [...created] } : {}), at: files[file]?.at ?? new Date().toISOString() }
  } else {
    delete files[file]
  }
  if (Object.keys(files).length > 0) written[slug] = files
  else delete written[slug]
  const next = { ...state.toolApprovals }
  if (Object.keys(written).length > 0) next.written = written
  else delete next.written
  state.toolApprovals = next
  if (Object.keys(next).length === 0) delete state.toolApprovals
  writeInstallState(state)
}

// ── Claude Code: `permissions.allow` in settings.json ──────────────────

/** Claude Code's permission rule for one treecontext tool. */
export function claudeRule(tool: string): string {
  return `mcp__treecontext__${tool}`
}

/** Rules that name the whole treecontext server in Claude Code. */
const CLAUDE_SERVER_RULES = new Set(['mcp__treecontext', 'mcp__treecontext__*'])

function claudeRuleCovers(rule: string, tool: string): boolean {
  return rule === claudeRule(tool) || CLAUDE_SERVER_RULES.has(rule)
}

/** A rule of the developer's that decides a tool, and the list it is in. */
export interface DeveloperRule { list: 'allow' | 'ask' | 'deny'; rule: string }

/**
 * The developer's rule that governs a tool in a settings object, read the
 * way Claude Code ranks them: deny over ask over allow. Rules install wrote
 * (`ours`) are not the developer's.
 */
export function claudeGoverningRule(data: Record<string, unknown>, tool: string, ours: ReadonlySet<string>): DeveloperRule | null {
  const perms = data['permissions']
  if (!isObject(perms)) return null
  for (const list of ['deny', 'ask', 'allow'] as const) {
    const rules = perms[list]
    if (!Array.isArray(rules)) continue
    for (const r of rules) {
      if (typeof r !== 'string') continue
      if (list === 'allow' && ours.has(r)) continue
      if (claudeRuleCovers(r, tool)) return { list, rule: r }
    }
  }
  return null
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
  /** `permissions` or `permissions.allow` is not what Claude Code reads, so nothing was added. */
  unwritable?: string
}

/**
 * Add Claude Code's allow rule for each of the four tools where no rule of
 * the developer's (allow, ask or deny, for the tool or the whole server)
 * decides it, and nothing else. `recorded` is what install wrote before.
 */
export function withClaudeApprovals(data: Record<string, unknown>, recorded: WrittenApprovals | undefined): ClaudeApprovalMerge {
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
    const theirs = claudeGoverningRule(data, tool, new Set(ours))
    if (theirs) { developer.push({ tool, rule: theirs }); continue }
    const rule = claudeRule(tool)
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

/**
 * Take install's rules back out of a settings object: each rule the record
 * names, from `permissions.allow`, and the containers install created when
 * they are left empty. Every other rule and key stays as it is.
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
  return isObject(t) ? t['approval_mode'] : undefined
}

export interface CodexApprovalMerge {
  /** The entry to write, or null when nothing changes. */
  entry: Record<string, unknown> | null
  added: string[]
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
  if (Object.hasOwn(entry, CODEX_DEFAULT_KEY)) {
    return { entry: null, added: [], ours, developer, defaultMode: entry[CODEX_DEFAULT_KEY] }
  }
  const tools = entry['tools']
  if (tools !== undefined && !isObject(tools)) {
    return { entry: null, added: [], ours, developer, unwritable: '"tools" is not a table' }
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
  if (added.length === 0) return { entry: null, added, ours, developer, ...(unwritable ? { unwritable } : {}) }
  return { entry: { ...entry, tools: nextTools }, added, ours: [...ours, ...added], developer, ...(unwritable ? { unwritable } : {}) }
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

/** The off state's words, a choice and not a failure (D390). */
function offWords(refusedBy: string): string {
  return `off by your choice (${TOOL_APPROVALS_OFF_COMMAND} or ${NO_TOOL_APPROVALS_FLAG}), so headless workers will be refused ${toolWords(APPROVED_TOOLS)}, as ${refusedBy}`
}

/** Claude Code's approval clause, from its settings object as the developer's file holds it. */
export function claudeApprovalClause(
  settingsPath: string, read: { state: 'absent' } | { state: 'ok'; data: Record<string, unknown> } | { state: 'unreadable' },
  off: boolean, recorded: WrittenApprovals | undefined,
): ApprovalClause {
  const label = 'tool approvals'
  if (off) return { text: `${label}: ${offWords('Claude Code asks before each and a `claude -p` worker cannot be asked')}`, warn: false, remedy: TOOL_APPROVALS_ON_COMMAND }
  const install = 'treecontext install --agent claude'
  if (read.state === 'unreadable') {
    return { text: `${label}: ${settingsPath} could not be read as a settings object, so whether a \`claude -p\` worker can use the tools is not known`, warn: true, remedy: install, fix: install }
  }
  const data = read.state === 'ok' ? read.data : {}
  const ours = new Set((recorded?.items ?? []).filter(r => {
    const allow = isObject(data['permissions']) ? (data['permissions'] as Record<string, unknown>)['allow'] : undefined
    return Array.isArray(allow) && allow.includes(r)
  }))
  const allowList = isObject(data['permissions']) && Array.isArray((data['permissions'] as Record<string, unknown>)['allow'])
    ? (data['permissions'] as Record<string, unknown>)['allow'] as unknown[] : []
  const missing: string[] = []
  const heldByDeveloper: Array<{ tool: string; rule: DeveloperRule }> = []
  for (const tool of APPROVED_TOOLS) {
    const theirs = claudeGoverningRule(data, tool, ours)
    if (theirs && theirs.list !== 'allow') { heldByDeveloper.push({ tool, rule: theirs }); continue }
    if (theirs) continue
    if (!allowList.includes(claudeRule(tool))) missing.push(tool)
  }
  // A developer's allow that reaches the asking tools is said in words.
  const wider = ASKING_TOOLS.filter(t => claudeGoverningRule(data, t, ours)?.list === 'allow')
  const also = wider.length > 0 ? `; your own allow rules also let a headless worker ${toolWords(wider)}` : ''
  if (heldByDeveloper.length === 0 && missing.length === 0) {
    return { text: `${label}: ${toolWords(APPROVED_TOOLS)} allowed in ${settingsPath}, so a \`claude -p\` worker can use them${also}`, warn: false, remedy: NOTHING }
  }
  const refused = [...heldByDeveloper.map(h => h.tool), ...missing]
  const ordered = APPROVED_TOOLS.filter(t => refused.includes(t))
  const why: string[] = []
  if (missing.length > 0) why.push(`${andList(missing)} ${missing.length === 1 ? 'is' : 'are'} not allowed in ${settingsPath}`)
  for (const h of heldByDeveloper) why.push(`your ${h.rule.list} rule ${h.rule.rule} in ${settingsPath} governs ${h.tool}`)
  const remedy = missing.length > 0
    ? install
    : `${heldByDeveloper.map(h => `your ${h.rule.list} rule ${h.rule.rule}`).join(' and ')} in ${settingsPath}, yours to change (install leaves it)`
  return {
    text: `${label}: a \`claude -p\` worker would be refused ${andList(ordered)} — ${why.join('; ')}${also}`,
    warn: true, remedy, fix: remedy,
  }
}

/** Whether a Codex reads per-tool approvals, from its version. */
export type CodexApprovalSupport =
  | { state: 'reads'; version: string }
  | { state: 'below-floor'; version: string }
  | { state: 'unreadable' }

/** Codex's headless clause: the worker variables and the four approvals, from its treecontext entry. */
export function codexHeadlessClause(
  configPath: string, entry: Record<string, unknown>, workerVars: readonly string[],
  off: boolean, support: CodexApprovalSupport, floor: string,
): ApprovalClause {
  const label = 'headless workers'
  const install = 'treecontext install --agent codex'
  const problems: string[] = []
  let installFixes = false
  const lines: string[] = []

  const raw = entry['env_vars']
  const names = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? [raw] : []
  const lacking = workerVars.filter(v => !names.includes(v))
  if (lacking.length > 0) {
    problems.push(`a worker's rows would land in no lane — the entry does not forward ${andList(lacking)} (env_vars)`)
    installFixes = true
  }

  if (off) {
    const words = `tool approvals are ${offWords('a `codex exec` worker runs with approval policy never and cannot be asked')}`
    if (problems.length === 0) return { text: `${label}: ${words}`, warn: false, remedy: TOOL_APPROVALS_ON_COMMAND }
    return { text: `${label}: ${problems.join('; ')}; ${words}`, warn: true, remedy: install, fix: install }
  }

  if (support.state !== 'reads') {
    const which = support.state === 'below-floor' ? `Codex ${support.version} cannot read per-tool approvals` : 'the Codex version could not be read (codex --version)'
    problems.push(`${which}: its headless workers need Codex ${floor} or newer for the tools`)
    const remedy = installFixes ? install : `Codex ${floor} or newer (npm i -g @openai/codex), then ${install}`
    return { text: `${label}: ${problems.join('; ')}`, warn: true, remedy, fix: remedy }
  }

  const defaultMode = Object.hasOwn(entry, CODEX_DEFAULT_KEY) ? entry[CODEX_DEFAULT_KEY] : undefined
  let also = ''
  if (defaultMode !== undefined) {
    // The developer's default decides every tool that sets none of its own.
    const unset = APPROVED_TOOLS.filter(t => codexApprovalOf(entry, t) === undefined)
    const refusedByDefault = defaultMode === CODEX_APPROVE ? [] : unset
    if (refusedByDefault.length > 0) {
      problems.push(`a \`codex exec\` worker would be refused ${andList(refusedByDefault)} — your ${CODEX_DEFAULT_KEY} = ${JSON.stringify(defaultMode)} in ${configPath} decides ${refusedByDefault.length === unset.length && unset.length === APPROVED_TOOLS.length ? 'every treecontext call' : 'them'}`)
      lines.push(`your mcp_servers.treecontext.${CODEX_DEFAULT_KEY} = ${JSON.stringify(defaultMode)}`)
    }
    if (defaultMode === CODEX_APPROVE) {
      const asking = ASKING_TOOLS.filter(t => codexApprovalOf(entry, t) === undefined)
      if (asking.length > 0) also = `; your ${CODEX_DEFAULT_KEY} = "approve" in ${configPath} approves every tool, so a headless worker can also ${toolWords(asking)}`
    }
  }
  const absent = defaultMode === undefined ? APPROVED_TOOLS.filter(t => codexApprovalOf(entry, t) === undefined) : []
  if (absent.length === APPROVED_TOOLS.length) {
    problems.push(`a \`codex exec\` worker would be refused every treecontext call — none of ${toolWords(APPROVED_TOOLS)} is approved in ${configPath}`)
    installFixes = true
  } else if (absent.length > 0) {
    problems.push(`a \`codex exec\` worker would be refused ${andList(absent)} — not approved in ${configPath}`)
    installFixes = true
  }
  for (const tool of APPROVED_TOOLS) {
    const v = codexApprovalOf(entry, tool)
    if (v === undefined || v === CODEX_APPROVE) continue
    problems.push(`a \`codex exec\` worker would be refused ${tool} — your ${codexApprovalKey(tool)} = ${JSON.stringify(v)} in ${configPath}`)
    lines.push(`your ${codexApprovalKey(tool)} = ${JSON.stringify(v)}`)
  }
  // An approval of the developer's for one of the asking tools is said in words too.
  const wider = ASKING_TOOLS.filter(t => codexApprovalOf(entry, t) === CODEX_APPROVE)
  if (wider.length > 0) also += `; your own approvals also let a headless worker ${toolWords(wider)}`

  if (problems.length === 0) {
    return { text: `${label}: can use the tools — ${andList(workerVars)} forwarded, ${toolWords(APPROVED_TOOLS)} approved in ${configPath}${also}`, warn: false, remedy: NOTHING }
  }
  const remedy = installFixes ? install : `${lines.join(' and ')} in ${configPath}, yours to change (install leaves it)`
  return { text: `${label}: ${problems.join('; ')}${also}`, warn: true, remedy, fix: remedy }
}
