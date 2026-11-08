import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// ── Install's own record (D361, D390) ──────────────────────────────────
//
// Only install's record can tell what install wrote into a client's file
// from what the developer wrote there: the idle-compaction key (D361) and
// the tool approvals (D390), each read back by uninstall and by `config
// tool-approvals`, which remove what the record names and nothing else. The
// developer's choice to turn the approvals off is kept here too, so every
// later install honours it.

/** One client file's share of the approvals install wrote. */
export interface WrittenApprovals {
  /** What install added: Claude Code's allow rules, or Codex's tool names. */
  items: string[]
  /** Containers install created to hold them (Claude Code: `permissions`, `allow`), removed again only while empty. */
  created?: string[]
  at: string
}

export interface ToolApprovalsState {
  /** A client whose approvals the developer turned off: by `config tool-approvals off` or `install --no-tool-approvals`. */
  off?: Record<string, { at: string; how: 'config' | 'install' }>
  /** What install wrote, per client slug and file. */
  written?: Record<string, Record<string, WrittenApprovals>>
}

export interface InstallState {
  idleCompaction?: Record<string, { value: false; at: string }>
  toolApprovals?: ToolApprovalsState
}

/** treecontext's own install state, beside its config. */
export function installStatePath(): string {
  return join(homedir(), '.treecontext', 'install-state.json')
}

export function writeAtomic(file: string, content: string, mode: number): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp.${process.pid}`
  writeFileSync(tmp, content, { mode })
  try { unlinkSync(file) } catch { /* may not exist yet */ }
  renameSync(tmp, file)
}

export function readInstallState(): InstallState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(installStatePath(), 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as InstallState : {}
  } catch {
    return {}
  }
}

export function writeInstallState(state: InstallState): void {
  writeAtomic(installStatePath(), JSON.stringify(state, null, 2) + '\n', 0o600)
}
