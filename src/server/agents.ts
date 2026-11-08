/**
 * Agent registry for treecontext installer.
 *
 * Each agent definition describes how to detect the agent, where its MCP
 * config lives, what format that config uses, and whether hooks or
 * instruction files should be installed.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

// ── Types ──────────────────────────────────────────────────────────

export type Platform = 'linux' | 'darwin' | 'win32'

export type ConfigFormat =
  | 'json-mcpServers'  // { mcpServers: { name: { command, args } } }
  | 'json-servers'     // { servers: { name: { type: "stdio", command, args } } } — VS Code
  | 'json-opencode'    // { mcp: { name: { type: "local", command: [...] } } }
  | 'toml-codex'       // [mcp_servers.name]

export interface HookDef {
  /** Hook events to register. */
  events: string[]
  /** Path to the agent's hook settings file (platform-keyed). */
  settingsPath: Partial<Record<Platform, string>>
  /** Hook settings format. */
  format: 'claude-settings' | 'gemini-settings' | 'vscode-hooks' | 'codex-hooks' | 'cursor-hooks'
}

export interface InstructionsDef {
  /** Path to the instruction file (platform-keyed, ~ expanded at runtime). */
  path: Partial<Record<Platform, string>>
}

export interface AgentDefinition {
  name: string
  slug: string
  configFormat: ConfigFormat
  /** Directories to check for detection (platform-keyed). */
  detectDirs: Partial<Record<Platform, string[]>>
  /** Commands whose presence on PATH also means the agent is installed. */
  detectCommands?: string[]
  /** MCP config file path (platform-keyed). */
  configPath: Partial<Record<Platform, string>>
  hooks?: HookDef
  instructions?: InstructionsDef
}

// ── Path helpers ───────────────────────────────────────────────────

function home(): string {
  return homedir()
}

function appData(): string {
  return process.env.APPDATA ?? join(home(), 'AppData', 'Roaming')
}

/**
 * The file Claude Code actually reads user-scope MCP servers from.
 *
 * It is `~/.claude.json` — a sibling of the `~/.claude` config directory, not
 * a file inside it. 0.0.9-beta wrote `~/.claude/.mcp.json`, which Claude Code
 * never reads at any scope (a `.mcp.json` is project scope, and that one would
 * only apply to a session started inside `~/.claude`). The result was the
 * worst kind of failure: `install` reported success, `doctor` reported "MCP
 * configured" by reading back its own dead file, and no treecontext_* tool
 * ever appeared in a session.
 *
 * `CLAUDE_CONFIG_DIR` relocates the whole config directory — multi-instance
 * launchers set it per profile — and moves `.claude.json` *inside* it.
 */
export function claudeUserConfigPath(): string {
  const override = process.env.CLAUDE_CONFIG_DIR
  return override ? join(override, '.claude.json') : join(home(), '.claude.json')
}

/** Legacy 0.0.9-beta target, kept so `install` can clean up after itself. */
export function claudeLegacyMcpPath(): string {
  return join(home(), '.claude', '.mcp.json')
}

/** Antigravity CLI's own directory under `~/.gemini`, where its settings live. */
export function agyDir(): string {
  return join(home(), '.gemini', 'antigravity-cli')
}

/** The file Antigravity CLI reads its MCP servers from (`agy mcp add` writes it). */
export function agyMcpConfigPath(): string {
  return join(home(), '.gemini', 'config', 'mcp_config.json')
}

/** Antigravity CLI's global settings, whose `permissions` hold its allow, ask and deny rules. */
export function agySettingsPath(): string {
  return join(agyDir(), 'settings.json')
}

/** Where Antigravity CLI keeps its projects, each a JSON file of its own. */
export function agyProjectsDir(): string {
  return join(home(), '.gemini', 'config', 'projects')
}

/** Antigravity CLI's global hook configuration, which install leaves alone. */
export function agyHooksPath(): string {
  return join(home(), '.gemini', 'config', 'hooks.json')
}

// ── Agent definitions ──────────────────────────────────────────────

export const AGENTS: AgentDefinition[] = [
  {
    name: 'Claude Code',
    slug: 'claude',
    configFormat: 'json-mcpServers',
    detectDirs: {
      linux: [join(home(), '.claude')],
      darwin: [join(home(), '.claude')],
      win32: [join(home(), '.claude')],
    },
    configPath: {
      linux: claudeUserConfigPath(),
      darwin: claudeUserConfigPath(),
      win32: claudeUserConfigPath(),
    },
    hooks: {
      events: ['SessionStart', 'PreCompact'],
      settingsPath: {
        linux: join(home(), '.claude', 'settings.json'),
        darwin: join(home(), '.claude', 'settings.json'),
        win32: join(home(), '.claude', 'settings.json'),
      },
      format: 'claude-settings',
    },
  },

  {
    name: 'Gemini CLI',
    slug: 'gemini',
    configFormat: 'json-mcpServers',
    // `~/.gemini` alone is not Gemini CLI's: Antigravity CLI makes it too.
    // Detection reads the command and Gemini CLI's own artifacts there
    // (geminiCliPresent, D383); detectDirs is not consulted for it.
    detectCommands: ['gemini'],
    detectDirs: {
      linux: [join(home(), '.gemini')],
      darwin: [join(home(), '.gemini')],
      win32: [join(home(), '.gemini')],
    },
    configPath: {
      linux: join(home(), '.gemini', 'settings.json'),
      darwin: join(home(), '.gemini', 'settings.json'),
      win32: join(home(), '.gemini', 'settings.json'),
    },
    hooks: {
      events: ['SessionStart', 'BeforeAgent', 'AfterTool', 'PreCompress'],
      settingsPath: {
        linux: join(home(), '.gemini', 'settings.json'),
        darwin: join(home(), '.gemini', 'settings.json'),
        win32: join(home(), '.gemini', 'settings.json'),
      },
      format: 'gemini-settings',
    },
    instructions: {
      path: {
        linux: join(home(), '.gemini', 'GEMINI.md'),
        darwin: join(home(), '.gemini', 'GEMINI.md'),
        win32: join(home(), '.gemini', 'GEMINI.md'),
      },
    },
  },

  {
    name: 'VS Code',
    slug: 'vscode',
    configFormat: 'json-servers',
    detectDirs: {
      linux: [join(home(), '.config', 'Code', 'User')],
      darwin: [join(home(), 'Library', 'Application Support', 'Code', 'User')],
      win32: [join(appData(), 'Code', 'User')],
    },
    configPath: {
      linux: join(home(), '.config', 'Code', 'User', 'mcp.json'),
      darwin: join(home(), 'Library', 'Application Support', 'Code', 'User', 'mcp.json'),
      win32: join(appData(), 'Code', 'User', 'mcp.json'),
    },
    hooks: {
      events: ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PreCompact'],
      settingsPath: {
        linux: join(home(), '.copilot', 'hooks', 'treecontext.json'),
        darwin: join(home(), '.copilot', 'hooks', 'treecontext.json'),
        win32: join(home(), '.copilot', 'hooks', 'treecontext.json'),
      },
      format: 'vscode-hooks',
    },
  },

  {
    name: 'Cursor',
    slug: 'cursor',
    configFormat: 'json-mcpServers',
    detectDirs: {
      linux: [join(home(), '.cursor')],
      darwin: [join(home(), '.cursor')],
      win32: [join(home(), '.cursor')],
    },
    configPath: {
      linux: join(home(), '.cursor', 'mcp.json'),
      darwin: join(home(), '.cursor', 'mcp.json'),
      win32: join(home(), '.cursor', 'mcp.json'),
    },
    hooks: {
      events: ['sessionStart', 'beforeSubmitPrompt', 'postToolUse', 'preCompact'],
      settingsPath: {
        linux: join(home(), '.cursor', 'hooks.json'),
        darwin: join(home(), '.cursor', 'hooks.json'),
        win32: join(home(), '.cursor', 'hooks.json'),
      },
      format: 'cursor-hooks',
    },
  },

  {
    name: 'Codex CLI',
    slug: 'codex',
    configFormat: 'toml-codex',
    detectDirs: {
      linux: [join(home(), '.codex')],
      darwin: [join(home(), '.codex')],
      win32: [join(home(), '.codex')],
    },
    configPath: {
      linux: join(home(), '.codex', 'config.toml'),
      darwin: join(home(), '.codex', 'config.toml'),
      win32: join(home(), '.codex', 'config.toml'),
    },
    hooks: {
      events: ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PreCompact'],
      settingsPath: {
        linux: join(home(), '.codex', 'hooks.json'),
        darwin: join(home(), '.codex', 'hooks.json'),
        win32: join(home(), '.codex', 'hooks.json'),
      },
      format: 'codex-hooks',
    },
    instructions: {
      path: {
        linux: join(home(), '.codex', 'AGENTS.md'),
        darwin: join(home(), '.codex', 'AGENTS.md'),
        win32: join(home(), '.codex', 'AGENTS.md'),
      },
    },
  },

  // Antigravity CLI (D383): a tools-only client. Its MCP entry is in
  // `~/.gemini/config/mcp_config.json`, its permission rules in
  // `~/.gemini/antigravity-cli/settings.json` (tool-approvals.ts), and its
  // instruction block is the `~/.gemini/GEMINI.md` it shares with Gemini
  // CLI. Install writes no hooks of its (fenced: its hooks stay its own).
  // The slug is the command's; the archived Antigravity IDE keeps the
  // `antigravity` slug in the uninstall sweep below.
  {
    name: 'Antigravity CLI',
    slug: 'agy',
    configFormat: 'json-mcpServers',
    detectCommands: ['agy'],
    detectDirs: {
      linux: [agyDir()],
      darwin: [agyDir()],
      win32: [agyDir()],
    },
    configPath: {
      linux: agyMcpConfigPath(),
      darwin: agyMcpConfigPath(),
      win32: agyMcpConfigPath(),
    },
    instructions: {
      path: {
        linux: join(home(), '.gemini', 'GEMINI.md'),
        darwin: join(home(), '.gemini', 'GEMINI.md'),
        win32: join(home(), '.gemini', 'GEMINI.md'),
      },
    },
  },

  {
    name: 'OpenCode',
    slug: 'opencode',
    configFormat: 'json-opencode',
    detectDirs: {
      linux: [join(home(), '.config', 'opencode')],
      darwin: [join(home(), '.config', 'opencode')],
      win32: [join(appData(), 'opencode')],
    },
    configPath: {
      linux: join(home(), '.config', 'opencode', 'opencode.json'),
      darwin: join(home(), '.config', 'opencode', 'opencode.json'),
      win32: join(appData(), 'opencode', 'opencode.json'),
    },
    instructions: {
      path: {
        linux: join(home(), '.config', 'opencode', 'AGENTS.md'),
        darwin: join(home(), '.config', 'opencode', 'AGENTS.md'),
        win32: join(appData(), 'opencode', 'AGENTS.md'),
      },
    },
  },

  // Archived-build platforms (windsurf, the Antigravity IDE, jetbrains, qwen,
  // openclaw) were removed at the 0.1 charter cold-read (2026-08-12):
  // their adapter builds were retired with the tree era, no tester ever
  // ran one, and an MCP stub with no capture story reads as a promise
  // this beta does not make. Reinstatement is an ordinary agent entry
  // plus a README platform-table row.
]


/**
 * MCP configs earlier releases wrote for the archived-build five. The
 * agents left the registry at the 0.1 cold-read, but a 0.0.x install may
 * have written a 'treecontext' entry into these files pointing at the
 * launcher UNINSTALL DELETES — dropping the registry entry without
 * keeping cleanup knowledge would strand that entry erroring on a
 * nonexistent path forever (fifth-pass review). Same pattern as
 * LEGACY_HOOK_PREFIXES: the platform is gone, its debris is still ours.
 */
export function legacyMcpConfigs(platform?: Platform): Array<{ slug: string; path: string; rootKey: 'mcpServers' | 'servers' }> {
  const p = platform ?? process.platform as Platform
  const one = (slug: string, rootKey: 'mcpServers' | 'servers', paths: Record<Platform, string>): { slug: string; path: string; rootKey: 'mcpServers' | 'servers' } =>
    ({ slug, rootKey, path: paths[p] })
  return [
    one('windsurf', 'mcpServers', {
      linux: join(home(), '.windsurf', 'mcp.json'),
      darwin: join(home(), '.windsurf', 'mcp.json'),
      win32: join(home(), '.windsurf', 'mcp.json'),
    }),
    one('antigravity', 'mcpServers', {
      linux: join(home(), '.gemini', 'antigravity', 'mcp_config.json'),
      darwin: join(home(), '.gemini', 'antigravity', 'mcp_config.json'),
      win32: join(home(), '.gemini', 'antigravity', 'mcp_config.json'),
    }),
    one('jetbrains', 'servers', {
      linux: join(home(), '.config', 'JetBrains', 'mcp.json'),
      darwin: join(home(), 'Library', 'Application Support', 'JetBrains', 'mcp.json'),
      win32: join(appData(), 'JetBrains', 'mcp.json'),
    }),
    one('qwen', 'mcpServers', {
      linux: join(home(), '.qwen', 'settings.json'),
      darwin: join(home(), '.qwen', 'settings.json'),
      win32: join(home(), '.qwen', 'settings.json'),
    }),
    one('openclaw', 'mcpServers', {
      linux: join(home(), '.openclaw', 'openclaw.json'),
      darwin: join(home(), '.openclaw', 'openclaw.json'),
      win32: join(home(), '.openclaw', 'openclaw.json'),
    }),
  ]
}

// ── Detection ──────────────────────────────────────────────────────

/** Whether a command resolves on PATH, read from the directories themselves (no shell is run). */
export function commandOnPath(name: string, platform: Platform = process.platform as Platform): boolean {
  const dirs = (process.env['PATH'] ?? '').split(delimiter).filter(Boolean)
  const exts = platform === 'win32'
    ? ['', ...(process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(e => e.toLowerCase())]
    : ['']
  for (const d of dirs) {
    for (const e of exts) {
      try {
        const st = statSync(join(d, `${name}${e}`))
        if (st.isFile() && (platform === 'win32' || (st.mode & 0o111) !== 0)) return true
      } catch { /* not here */ }
    }
  }
  return false
}

/** The files and directories in `~/.gemini` that only Gemini CLI makes (D383). */
export const GEMINI_ARTIFACTS = ['installation_id', 'oauth_creds.json', 'google_accounts.json', 'trusted_hooks.json', 'tmp'] as const

/**
 * What in `~/.gemini` shows Gemini CLI has been there (D383): the files and
 * directories it makes (GEMINI_ARTIFACTS), and a `settings.json` holding a
 * key of its own, which is any key but the treecontext entry under
 * `mcpServers` an install writes (another server there is the developer's).
 * A `settings.json` that does not parse is not treecontext's, which writes
 * only JSON, so it counts. Antigravity CLI's own directories,
 * `antigravity-cli` and `config`, never count, and neither does
 * `~/.gemini` itself, which agy creates too. Each artifact by its name.
 */
export function geminiArtifacts(): string[] {
  const dir = join(home(), '.gemini')
  const found: string[] = GEMINI_ARTIFACTS.filter(f => existsSync(join(dir, f)))
  const settings = join(dir, 'settings.json')
  if (existsSync(settings)) {
    try {
      const data = JSON.parse(readFileSync(settings, 'utf8')) as unknown
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        found.push('settings.json')
      } else {
        const rec = data as Record<string, unknown>
        const servers = rec['mcpServers']
        const ownKey = Object.keys(rec).some(k => k !== 'mcpServers')
        const otherServer = servers !== undefined && (!servers || typeof servers !== 'object' || Array.isArray(servers)
          || Object.keys(servers).some(k => k !== 'treecontext'))
        if (ownKey || otherServer) found.push('settings.json')
      }
    } catch {
      found.push('settings.json')
    }
  }
  return found
}

/**
 * Whether Gemini CLI is installed (D383): its command on PATH, or one of
 * its own artifacts in `~/.gemini` (geminiArtifacts). The directory alone
 * proves nothing, since Antigravity CLI creates it too.
 */
export function geminiCliPresent(platform: Platform = process.platform as Platform): boolean {
  return commandOnPath('gemini', platform) || geminiArtifacts().length > 0
}

export function detectAgents(platform?: Platform): AgentDefinition[] {
  const p = platform ?? process.platform as Platform
  return AGENTS.filter(agent => {
    if (agent.slug === 'gemini') return geminiCliPresent(p)
    const dirs = agent.detectDirs[p] ?? agent.detectDirs.linux ?? []
    return dirs.some(d => existsSync(d)) || (agent.detectCommands ?? []).some(c => commandOnPath(c, p))
  })
}

export function getAgent(slug: string): AgentDefinition | undefined {
  return AGENTS.find(a => a.slug === slug)
}

export function getConfigPath(agent: AgentDefinition, platform?: Platform): string | null {
  const p = platform ?? process.platform as Platform
  const path = agent.configPath[p] ?? agent.configPath.linux
  return typeof path === 'string' ? path : (Array.isArray(path) ? path[0] ?? null : null)
}

export function getHookSettingsPath(agent: AgentDefinition, platform?: Platform): string | null {
  if (!agent.hooks?.settingsPath) return null
  const p = platform ?? process.platform as Platform
  return agent.hooks.settingsPath[p] ?? agent.hooks.settingsPath.linux ?? null
}

export function getInstructionsPath(agent: AgentDefinition, platform?: Platform): string | null {
  if (!agent.instructions?.path) return null
  const p = platform ?? process.platform as Platform
  return agent.instructions.path[p] ?? agent.instructions.path.linux ?? null
}
