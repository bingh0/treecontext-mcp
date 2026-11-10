/**
 * What earlier builds wrote, for the tests that lay it as a leftover: the
 * per-agent hook wrappers (`tc-<agent>-<stem>`), VS Code's Copilot hooks
 * file, Cursor's hooks file, and Codex CLI's verbatim copy of the Claude
 * Code block written under `--experimental-capture`. No build since D406
 * writes any of them (the adapters they ran and the flag that opted into
 * them left the build), so their writers live here, out of the shipped
 * build, and the build keeps only the readers and removers that still have
 * to recognise them (AGENTS.md: anything that writes is in the charter or
 * out of the build).
 *
 * Each writer is the one the earlier build ran, built from the shapes the
 * build still carries for recognising them (`agentHookWrapperContent`,
 * `buildVscodeHooksConfig`, `expectedHookCopy`), so a file laid here is
 * what uninstall and doctor were written against. Unlike the earlier
 * writers, these take no dry run and no force: a test lays the file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  AGENT_HOOK_WRAPPER_STEMS, agentHookWrapperPath, agentHookWrapperContent, buildVscodeHooksConfig, expectedHookCopy, claudeHookCommand,
  type AgentHookAgent, type ActionResult,
} from '../../src/server/installer.js'
import { takeBackCodexHooks } from '../../src/server/codex-hooks.js'

const readJson = (path: string): Record<string, unknown> => {
  if (!existsSync(path)) return {}
  try { return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> } catch { return {} }
}
const writeJson = (path: string, data: unknown): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
}

/** An earlier build's per-agent hook wrappers, as its install wrote them. */
export function installAgentHookWrappers(agent: AgentHookAgent): ActionResult[] {
  return AGENT_HOOK_WRAPPER_STEMS[agent].map((stem) => {
    const path = agentHookWrapperPath(agent, stem)
    const existed = existsSync(path)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, agentHookWrapperContent(agent, stem), { mode: 0o755 })
    return { type: 'hook-script', path, status: existed ? 'updated' : 'created' }
  })
}

/** An earlier build's Copilot hooks file (VS Code), whole. */
export function upsertVscodeHooks(path: string): ActionResult {
  const status = existsSync(path) ? 'updated' : 'created'
  writeJson(path, buildVscodeHooksConfig())
  return { type: 'hook-settings', path, status }
}

/** An earlier build's entries in Cursor's hooks file, merged beside the rest. */
export function upsertCursorHooks(path: string): ActionResult {
  const cmd = (stem: string): string => claudeHookCommand(agentHookWrapperPath('cursor', stem), 'bash')
  const ours = {
    sessionStart: [{ command: cmd('session-start') }],
    beforeSubmitPrompt: [{ command: cmd('user-prompt-submit') }],
    postToolUse: [{ command: cmd('post-tool-use') }],
    preCompact: [{ command: cmd('pre-compact') }],
  }
  const existing = readJson(path)
  const status = existsSync(path) ? 'updated' : 'created'
  writeJson(path, { ...existing, version: 1, hooks: { ...((existing['hooks'] ?? {}) as Record<string, unknown>), ...ours } })
  return { type: 'hook-settings', path, status }
}

/**
 * The verbatim copy of the Claude Code block an earlier build wrote into
 * Codex's hooks.json under `--experimental-capture`: treecontext's own
 * entries taken out, the copy (its commands naming no client) appended
 * after the developer's groups of each event, the rest of the file kept.
 */
export function upsertCodexHooks(path: string): ActionResult {
  const status = existsSync(path) ? 'updated' : 'created'
  const data = takeBackCodexHooks(readJson(path)).data
  const hooks = (data['hooks'] && typeof data['hooks'] === 'object' ? data['hooks'] : {}) as Record<string, unknown[]>
  for (const [event, groups] of Object.entries(expectedHookCopy())) {
    hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event]! : []), ...structuredClone(groups)]
  }
  writeJson(path, { ...data, hooks })
  return { type: 'hook-settings', path, status }
}
