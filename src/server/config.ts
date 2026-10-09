/**
 * TOML config file loader.
 *
 * Merge precedence: CLI > config file > defaults. The file shape uses
 * snake_case keys under the `[server]` and `[retention]` sections; we
 * translate to camelCase.
 *
 *   [retention]
 *   max_store_bytes = 134217728   # the store-byte budget, in bytes (D141)
 *   max_sessions = 100            # the session cap
 *
 * Per store means per project: ./treecontext.toml in the project dir wins
 * over ~/.treecontext/config.toml, so one project's store can run a larger
 * budget than the installation default.
 *
 * Auto-discovery order (first match wins):
 *   1. Explicit path passed to `loadConfigFile()`
 *   2. $TREECONTEXT_CONFIG env var
 *   3. treecontext.toml in the project directory — the root the store
 *      binding resolves (projectRootFor: the primary repository root, else
 *      the nearest `.git` ancestor, else the directory itself), from
 *      --project-dir, then $TREECONTEXT_PROJECT_DIR, then the cwd (D255)
 *   4. ~/.treecontext/config.toml
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { dbg, warn } from '../debug.js'
import { projectRootFor } from './bindings.js'

// ── Types ──────────────────────────────────────────────────────────

export interface LoadedConfig {
  server: {
    transport?: 'stdio' | 'http'
    port?: number
    host?: string
    capture?: boolean
    /** Write the sidecar panes beside the store on each drain. Default true. */
    sidecar?: boolean
    shieldThreshold?: number
    shieldDir?: string
  }
  /** `[retention]` — the store's byte budget and session cap (D141). Absent
   *  keys leave the library defaults (MAX_STORE_BYTES_DEFAULT,
   *  MAX_SESSIONS_DEFAULT) in force. */
  retention: {
    /** `max_store_bytes`: a positive integer byte count. */
    maxStoreBytes?: number
    /** `max_sessions`: a positive integer. */
    maxSessions?: number
  }
  /** Absolute path the config was loaded from (null when none found). */
  path: string | null
}

const EMPTY: LoadedConfig = {
  server: {},
  retention: {},
  path: null,
}

// ── Public API ─────────────────────────────────────────────────────

export function loadConfigFile(explicitPath: string | null, projectDir?: string): LoadedConfig {
  const path = resolvePath(explicitPath, projectDir)
  if (!path) {
    dbg('config', 'no config file found')
    return EMPTY
  }

  dbg('config', 'loading', { path })
  const text = readFileSync(path, 'utf8')
  const raw = parseToml(text) as Record<string, unknown>
  return {
    server: readServer(raw.server),
    retention: readRetention(raw.retention, path),
    path,
  }
}

function resolvePath(explicit: string | null, projectDir?: string): string | null {
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`Config file not found: ${explicit}`)
    }
    return explicit
  }
  const env = process.env.TREECONTEXT_CONFIG
  if (env && existsSync(env)) return env

  // The project directory is what the store binding resolves, not the
  // literal cwd: `serve` from repo/pkg binds the repository's store, and
  // must read the repository's file with it (D255, 2026-10-08).
  const dir = projectRootFor(projectDir ?? process.env.TREECONTEXT_PROJECT_DIR ?? process.cwd())
  const local = join(dir, 'treecontext.toml')
  if (existsSync(local)) return local

  const global = join(homedir(), '.treecontext', 'config.toml')
  if (existsSync(global)) return global

  return null
}

// ── Section parsers ────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function readServer(raw: unknown): LoadedConfig['server'] {
  const s = asRecord(raw)
  const out: LoadedConfig['server'] = {}
  // transport, port and host are parsed for tolerance only: nothing reads
  // them. The HTTP transport is tombstoned (D77) and applyConfigFile in
  // cli.ts ignores all three; the parse stays because the config-file
  // steps pin a mistyped `port` as absent from the result.
  const transport = str(s.transport)
  if (transport === 'stdio' || transport === 'http' || transport === 'streamable-http') {
    out.transport = transport === 'stdio' ? 'stdio' : 'http'
  }
  const port = num(s.port)
  if (port !== undefined) out.port = port
  const host = str(s.host)
  if (host) out.host = host
  const capture = bool(s.capture)
  if (capture !== undefined) out.capture = capture
  const sidecar = bool(s.sidecar)
  if (sidecar !== undefined) out.sidecar = sidecar
  // Same rule as the CLI flag's parse guard: negative is not a
  // threshold. Without this, `shield_threshold = -1` slid through and
  // `bytes <= -1` shielded EVERY response (F review 2026-08-15).
  const shieldThreshold = num(s.shield_threshold)
  if (shieldThreshold !== undefined && shieldThreshold >= 0) out.shieldThreshold = shieldThreshold
  const shieldDir = str(s.shield_dir)
  if (shieldDir !== undefined) out.shieldDir = shieldDir
  return out
}

/** A positive whole number, or nothing: a zero or negative budget would
 *  demote every row on the next sweep, and a fractional byte count names
 *  no budget at all — the key is dropped rather than obeyed into data
 *  churn, and the operator is told so on stderr (stdout is the MCP
 *  transport), naming the file, so a typo never passes silently. */
function positiveInt(key: string, v: unknown, path: string): number | undefined {
  if (v === undefined) return undefined
  const n = num(v)
  if (n === undefined || !Number.isInteger(n) || n < 1) {
    warn(
      `[treecontext] config ${path}: [retention] ${key} = ${JSON.stringify(v)} is not a positive whole number — ignored; the default stays in force.`,
    )
    return undefined
  }
  return n
}

function readRetention(raw: unknown, path: string): LoadedConfig['retention'] {
  const r = asRecord(raw)
  const out: LoadedConfig['retention'] = {}
  const maxStoreBytes = positiveInt('max_store_bytes', r.max_store_bytes, path)
  if (maxStoreBytes !== undefined) out.maxStoreBytes = maxStoreBytes
  const maxSessions = positiveInt('max_sessions', r.max_sessions, path)
  if (maxSessions !== undefined) out.maxSessions = maxSessions
  return out
}
