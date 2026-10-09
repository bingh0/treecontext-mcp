import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync, rmdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { dbg } from '../debug.js'

export interface ShieldConfig {
  /** Byte threshold above which responses are saved to file. 0 = disabled. Default: 0 (off). */
  thresholdBytes: number
  /** Directory for shielded output files. Default: ~/.treecontext/shield/ */
  shieldDir: string
  /** Maximum age (ms) of shielded files before cleanup. Default: 3600000 (1 hour). */
  maxAgeMs: number
  /** Tools that are NEVER shielded (always return full response). */
  neverShield: ReadonlySet<string>
  /** If non-empty, ONLY these tools are eligible for shielding. Overrides neverShield. */
  alwaysShield: ReadonlySet<string>
}

export interface ShieldResult {
  /** The (possibly replaced) text content to return to the agent. */
  text: string
  /** True if the response was shielded (saved to file). */
  shielded: boolean
  /** Absolute path to the saved file, if shielded. */
  filePath?: string
  /** Original byte size of the response, if shielded. */
  originalBytes?: number
}

/**
 * Check if a tool response should be shielded. If the text exceeds
 * the threshold and the tool is eligible, write the full response to
 * a file and return a compact reference. Otherwise return the text
 * unchanged.
 */
export function shieldResponse(
  toolName: string,
  text: string,
  config: ShieldConfig,
): ShieldResult {
  // <= 0, not === 0: a negative threshold reaching here (a config value
  // the gates upstream should have dropped) must read as disabled, not
  // as "shield every response" (F review 2026-08-15).
  if (config.thresholdBytes <= 0) {
    return { text, shielded: false }
  }

  if (config.alwaysShield && config.alwaysShield.size > 0) {
    if (!config.alwaysShield.has(toolName)) {
      return { text, shielded: false }
    }
  } else if (config.neverShield && config.neverShield.has(toolName)) {
    return { text, shielded: false }
  }

  const bytes = Buffer.byteLength(text, 'utf-8')
  if (bytes <= config.thresholdBytes) {
    return { text, shielded: false }
  }

  const filename = `${toolName}-${Date.now()}-${randomUUID().slice(0, 8)}.json`
  const filePath = join(config.shieldDir, filename)

  // Full lockdown (ruling 2026-08-15): shielded files hold verbatim
  // journal content — as sensitive as the store itself — so they get the
  // store's modes: 0700 dir, 0600 files.
  //
  // A write failure must not destroy the response it was shielding: the
  // successful result already exists in memory, and turning a disk
  // problem into a toolError threw the results away (S6). Fall back to
  // returning the content inline, with the reason in the debug log.
  try {
    mkdirSync(config.shieldDir, { recursive: true, mode: 0o700 })
    writeFileSync(filePath, text, { encoding: 'utf-8', mode: 0o600 })
  } catch (err) {
    dbg('shield', 'shield write failed; returning content inline', {
      tool: toolName, bytes, error: String(err),
    })
    return { text, shielded: false }
  }

  const reference = {
    shielded: true,
    file: filePath,
    bytes: bytes,
    tool: toolName,
    hint: `Response exceeded ${config.thresholdBytes} bytes. Full output saved to file. Use a file-read tool to access it, or re-call with smaller parameters.`
  }

  return {
    text: JSON.stringify(reference, null, 2),
    shielded: true,
    filePath,
    originalBytes: bytes
  }
}

/**
 * The names this module mints: `<tool>-<epoch-ms>-<uuid8>.json`. The
 * sweep deletes ONLY matching names — --shield-dir is unvalidated user
 * input, and an age-based sweep of an arbitrary directory is a file
 * reaper pointed wherever the config says (S3's lesson, applied here).
 * The epoch is anchored at exactly 13 digits (valid until 2286): a
 * looser \d+ also matched foreign shapes like `run-1723600000-<hex>` —
 * 10-digit unix-seconds names other tools actually produce (F review
 * 2026-08-15). shielding.test.ts pins mint and regex to each other.
 */
export const SHIELD_FILE_RE = /^[\w.-]+-\d{13}-[0-9a-f]{8}\.json$/

function sweepShieldFiles(dir: string, maxAgeMs: number): number {
  let count = 0
  const now = Date.now()
  try {
    const files = readdirSync(dir)
    for (const file of files) {
      if (!SHIELD_FILE_RE.test(file)) continue
      const filePath = join(dir, file)
      try {
        const stats = statSync(filePath)
        if (now - stats.mtimeMs > maxAgeMs) {
          unlinkSync(filePath)
          count++
        }
      } catch {
        // Silently ignore individual file errors
      }
    }
  } catch {
    // Silently ignore if directory doesn't exist
  }
  return count
}

/**
 * Remove shielded files older than maxAgeMs. Called at stdio shutdown —
 * there is no periodic sweep, so a SIGKILL'd session's files wait for
 * the next clean shutdown of a server using the same directory.
 *
 * While shielding is DISABLED the sweep still cleans the module's OWN
 * default directory — files minted before the flag was dropped keep
 * their retention instead of persisting forever (F review 2026-08-15) —
 * but never a custom --shield-dir: matching names in a user-pointed
 * directory are only probably ours; in our own default they provably
 * are.
 */
export function cleanShieldDir(config: ShieldConfig): number {
  if (config.thresholdBytes <= 0 && config.shieldDir !== defaultShieldDir()) return 0
  return sweepShieldFiles(config.shieldDir, config.maxAgeMs)
}

/** THE shield retention. One constant for the default config, the
 *  shutdown sweep, and the legacy sweep — a tuning that edited one
 *  literal previously left the others silently divergent (pass-2
 *  review 2026-08-15). */
export const SHIELD_MAX_AGE_MS = 3600000

/**
 * Sweep of the pre-lockdown default, `$TMPDIR/treecontext-shield`
 * (F review 2026-08-15): releases before the 2026-08-15 lockdown wrote
 * shields there with umask-default modes, and without this the
 * world-readable copies outlive the upgrade forever.
 *
 * The retention applies HERE TOO — "nothing writes there anymore" is
 * only true of upgraded projects: a neighboring project still on the
 * old release writes fresh shields into this shared directory, and an
 * age-0 sweep deleted a reference's file before the agent holding it
 * could read it (release-diff review). But retention alone left the
 * EXPOSURE open (pass-2 review): the sweep only runs at shutdown, so a
 * young world-readable file could sit readable for days on a shared
 * machine. Matching names are therefore chmod'd 0600 on every sweep —
 * closing the read exposure immediately — and deleted only once aged.
 * A pre-upgrade server re-writing the file does not reset its mode
 * (writeFileSync to an existing file keeps existing permissions), and
 * its own reader is the file's owner, so the tightening breaks nothing.
 */
export function cleanLegacyShieldDir(): number {
  const legacy = join(tmpdir(), 'treecontext-shield')
  try {
    for (const file of readdirSync(legacy)) {
      if (!SHIELD_FILE_RE.test(file)) continue
      try { chmodSync(join(legacy, file), 0o600) } catch { /* best effort */ }
    }
  } catch { /* absent */ }
  const count = sweepShieldFiles(legacy, SHIELD_MAX_AGE_MS)
  try { rmdirSync(legacy) } catch { /* absent, or holds foreign files */ }
  return count
}

function defaultShieldDir(): string {
  return join(homedir(), '.treecontext', 'shield')
}

export function defaultShieldConfig(overrides?: Partial<ShieldConfig>): ShieldConfig {
  return {
    thresholdBytes: 0,
    // Inside the existing 0700 ~/.treecontext umbrella, not the shared
    // world-readable tmpdir (ruling 2026-08-15: full lockdown).
    shieldDir: defaultShieldDir(),
    maxAgeMs: SHIELD_MAX_AGE_MS,
    neverShield: new Set(['treecontext_status']),
    alwaysShield: new Set(),
    ...overrides
  }
}
