/**
 * What makes a hook command treecontext's own: the one predicate the copy
 * writer, the remover, doctor's consistency check and Gemini CLI's presence
 * test (agents.ts) share, and the names it reads. A leaf: it imports no
 * treecontext module, so agents.ts can use it without a cycle.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export const TC_HOOK_PREFIX = 'tc-'

/** The Claude Code hook scripts `install` writes, in install order. */
export const CLAUDE_HOOK_SCRIPTS = [
  'session-reminder', 'session-start', 'pre-compact',
  'post-tool-use', 'user-prompt-submit', 'stop',
  'subagent-start', 'subagent-stop',
] as const

export const HOOK_SCRIPTS_DIR_NAME = 'hooks'

export const AGENT_HOOK_WRAPPER_STEMS = {
  gemini: ['session-start', 'before-agent', 'after-tool', 'pre-compress'],
  vscode: ['session-start', 'user-prompt-submit', 'post-tool-use', 'stop', 'pre-compact'],
  codex: ['session-start', 'user-prompt-submit', 'post-tool-use', 'pre-compact'],
  cursor: ['session-start', 'user-prompt-submit', 'post-tool-use', 'pre-compact'],
} as const

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}


/**
 * What marks a hook command in a copying client's configuration as
 * treecontext's, and nothing else: a Claude Code hook script or an earlier
 * build's per-agent wrapper IN treecontext's own hooks directory
 * (`<home>/.claude/hooks/tc-<known stem>`), an earlier build's adapter entry
 * point (`hooks/codex|gemini/<known stem>.js`), or the `treecontext hook
 * <event>` subcommand. ONE predicate, shared by the copy writer, the remover
 * and doctor's consistency check. Never a bare `/hooks/tc-`: that claimed a
 * user's `<project>/.git/hooks/tc-notify.sh`, and the rewrite deleted it.
 * Never the bare substring 'hook ' either: it once claimed `my-tool hook
 * sync`.
 */
export function normalizeHookPath(p: string): string {
  const slashed = p.replace(/\\/g, '/')
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed
}

const LEGACY_COPY_ENTRY_RE = new RegExp(
  `(?:^|[/"'\\s])hooks/(?:codex|gemini)/(?:${[...new Set([...AGENT_HOOK_WRAPPER_STEMS.codex, ...AGENT_HOOK_WRAPPER_STEMS.gemini])].join('|')})\\.js\\b`,
)
const TC_SUBCOMMAND_RE = new RegExp(
  `(?:\\btreecontext|cli\\.js"?)\\s+hook\\s+(?:${CLAUDE_HOOK_SCRIPTS.join('|')})\\b`,
)

/** Does `cmd` run one of the named scripts in treecontext's own hooks directory? */
export function runsOwnHookScript(cmd: string, names: readonly string[]): boolean {
  const c = normalizeHookPath(cmd)
  const dir = normalizeHookPath(join(homedir(), '.claude', HOOK_SCRIPTS_DIR_NAME)) + '/'
  return names.some(n => new RegExp(`${escapeRegex(dir + n)}(?:\\.cmd)?(?![\\w.-])`).test(c))
}

export const CLAUDE_SCRIPT_NAMES = CLAUDE_HOOK_SCRIPTS.map(n => `${TC_HOOK_PREFIX}${n}`)
const LEGACY_WRAPPER_NAMES = (['codex', 'gemini'] as const)
  .flatMap(a => AGENT_HOOK_WRAPPER_STEMS[a].map(st => `${TC_HOOK_PREFIX}${a}-${st}`))

export function isOwnHookCommand(cmd: unknown): boolean {
  if (typeof cmd !== 'string') return false
  if (runsOwnHookScript(cmd, [...CLAUDE_SCRIPT_NAMES, ...LEGACY_WRAPPER_NAMES])) return true
  return LEGACY_COPY_ENTRY_RE.test(normalizeHookPath(cmd)) || TC_SUBCOMMAND_RE.test(cmd)
}
