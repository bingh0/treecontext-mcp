import { join } from 'node:path'

/**
 * Every environment variable the product resolves a home directory from —
 * not just HOME.
 *
 * `os.homedir()` reads USERPROFILE on Windows and ignores HOME entirely, and
 * src/server/agents.ts resolves the VS Code and OpenCode config
 * paths through APPDATA. A HOME-only sandbox therefore does not sandbox on
 * Windows: it leaves the code under test reading — and WRITING — the
 * developer's real profile while the assertions inspect an empty temp dir.
 *
 * That is not a hypothetical. On the first Windows CI run to ever execute this
 * suite, the skill tests installed treecontext-reference into the runner's real
 * C:\Users\runneradmin\.claude\skills and then deleted it again; the "remove
 * returns null when never installed" case failed precisely because it had just
 * removed a real installation it never made.
 *
 * LOCALAPPDATA is deliberately NOT redirected: its only reader is Git-bash
 * discovery in installer.ts, which looks up an installed program rather than
 * writing into the profile. Redirecting it would break that detection.
 */
export function homeEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    USERPROFILE: home,
    // Mirrors the real Windows layout, and the same value agents.ts falls back
    // to when APPDATA is unset — set explicitly so a sandbox never depends on
    // that fallback continuing to exist.
    APPDATA: join(home, 'AppData', 'Roaming'),
  }
}

/**
 * Point the CURRENT process's home at `home`; returns the restore function.
 *
 * ORDER MATTERS: callers that then `await import()` a product module must call
 * this FIRST. agents.ts computes its AGENTS paths from homedir() at
 * module-evaluation time, so a redirect applied after that import is silently
 * ignored and the test grades the real machine.
 */
export function redirectHome(home: string): () => void {
  const prev = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(homeEnv(home))) {
    prev.set(key, process.env[key])
    process.env[key] = value
  }
  return () => {
    for (const [key, value] of prev) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** Child-process environment with the home redirected the same way. */
export function sandboxedEnv(
  home: string,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  return { ...base, ...homeEnv(home) }
}

/**
 * Where treecontext keeps its stores under a home — the one spelling of that
 * layout, corpus-wide (store-fixtures re-exports it for its callers).
 *
 * It lives HERE and not in store-fixtures because this module imports no src:
 * the redirect-before-import files (doctor-*, prune-fault-exit) evaluate their
 * static imports before redirectHome runs, so a helper that transitively pulls
 * src freezes homedir() to the real machine and the test grades the wrong
 * home. That is not hypothetical — the 2026-08-27 one-spelling sweep broke
 * doctor-store-schema exactly that way before this function moved.
 */
export function storesDirIn(home: string): string {
  return join(home, '.treecontext', 'stores')
}
