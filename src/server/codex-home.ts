/**
 * Codex CLI's own directory: `$CODEX_HOME` when set and not empty, else
 * `~/.codex`. What Codex CLI 0.167.0 does with it, read from a real run
 * under a throwaway HOME (2026-11-10):
 *  - every file treecontext writes for Codex is read from that directory:
 *    `hooks/list` lists `$CODEX_HOME/hooks.json`, `codex mcp list` reads
 *    `$CODEX_HOME/config.toml`, and `~/.codex` is not read at all;
 *  - an empty value is no value: `~/.codex` is read;
 *  - a relative value is resolved against Codex's own working directory;
 *  - Codex names the file by the directory's canonical path (a symlinked
 *    `CODEX_HOME`, or one with a trailing slash, is listed by where it
 *    resolves), while `~/.codex` is named as it is spelled;
 *  - a value naming a path that does not exist, or that is not a directory,
 *    makes Codex refuse to start: `Error: failed to resolve CODEX_HOME`,
 *    after `CODEX_HOME points to "<path>", but that path does not exist`
 *    (or `is not a directory`); `codex --version` still answers.
 * So treecontext writes where Codex reads, names that directory whenever it
 * is not `~/.codex`, hands every Codex it starts the resolved absolute path
 * (its probes run in other directories), and where Codex itself would refuse
 * to start it writes nothing for Codex and says why, in Codex's words.
 */
import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export type CodexHome =
  /** The directory Codex reads, and whether CODEX_HOME named it. */
  | { ok: true; dir: string; fromEnv: boolean }
  /** CODEX_HOME names a path Codex refuses: nothing is written for Codex. */
  | { ok: false; dir: string; why: string }

/** The directory Codex CLI reads its configuration and hooks from. */
export function codexHome(env: NodeJS.ProcessEnv = process.env): CodexHome {
  const raw = env['CODEX_HOME']
  if (raw === undefined || raw === '') return { ok: true, dir: join(homedir(), '.codex'), fromEnv: false }
  const abs = resolve(raw)
  let isDir: boolean
  try { isDir = statSync(abs).isDirectory() } catch {
    return { ok: false, dir: abs, why: `CODEX_HOME points to "${abs}", but that path does not exist, so Codex itself refuses to start ("failed to resolve CODEX_HOME")` }
  }
  if (!isDir) return { ok: false, dir: abs, why: `CODEX_HOME points to "${abs}", but that path is not a directory, so Codex itself refuses to start ("failed to resolve CODEX_HOME")` }
  try { return { ok: true, dir: realpathSync.native(abs), fromEnv: true } } catch (e) {
    return { ok: false, dir: abs, why: `CODEX_HOME points to "${abs}", which cannot be resolved (${e instanceof Error ? e.message : String(e)})` }
  }
}

/** The directory, whether or not Codex accepts it (callers that write check `codexHome().ok`). */
export function codexDir(): string {
  return codexHome().dir
}

/** The environment a Codex treecontext starts gets: CODEX_HOME as the
 *  absolute, resolved directory where one was set, so a probe started in
 *  another directory reads what the developer's Codex reads. */
export function codexProbeEnv(): NodeJS.ProcessEnv | undefined {
  const h = codexHome()
  return h.ok && h.fromEnv ? { ...process.env, CODEX_HOME: h.dir } : undefined
}

/** The words naming Codex's directory where it is not `~/.codex`, or null. */
export function codexHomeNote(): string | null {
  const h = codexHome()
  return h.ok && h.fromEnv ? `Codex's directory is ${h.dir} (CODEX_HOME), not ${join(homedir(), '.codex')}` : null
}
