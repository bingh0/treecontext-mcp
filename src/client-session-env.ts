/**
 * A spawner's client-session variables, which the ticket door never hands
 * a worker (D389). This module is the one place the named list is kept.
 *
 * A client session names itself, or opens a channel back into itself,
 * through variables it puts in the environment of every shell it runs.
 * A worker started from that shell through `treecontext run` or the
 * library call would inherit them. A worker of another vendor's model
 * would then hold a token and a socket into the session that spawned it.
 * agy passes its whole environment to its MCP servers and shells.
 *
 * The rule is a named list per client, never a prefix. A prefix rule on
 * `CLAUDE_CODE_` would also strip the client's own configuration
 * (`CLAUDE_CODE_USE_BEDROCK` and its kind). That would break a `claude -p`
 * worker on a Bedrock or Vertex account. Every variable not named here
 * reaches the worker unchanged, the client's configuration
 * (`CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_USE_BEDROCK`) and its credentials
 * among them. Each name carries the evidence it was seen. A session
 * variable that a client adds later passes until it is named here. The
 * dogfood's `env` worker, run from inside each client's shell at each
 * release, is how a new one is found.
 */

/** One client-session variable and the evidence it was seen. */
export interface ClientSessionVariable {
  name: string
  seen: string
}

const SEEN_CLAUDE_CODE = '2026-11-07: an `env` worker started through `treecontext run` from Claude Code\'s Bash inherited it (D389)'

/** D389: each client's session variables, by the client's slug. Codex
 *  CLI's and Antigravity CLI's lists start empty and are filled from the
 *  same `env` run. */
export const CLIENT_SESSION_VARIABLES: Readonly<Record<'claude-code' | 'codex' | 'agy', readonly ClientSessionVariable[]>> = {
  'claude-code': [
    { name: 'CLAUDECODE', seen: SEEN_CLAUDE_CODE },
    { name: 'CLAUDE_CODE_SESSION_ID', seen: SEEN_CLAUDE_CODE },
    { name: 'CLAUDE_CODE_CHILD_SESSION', seen: SEEN_CLAUDE_CODE },
    { name: 'CLAUDE_PID', seen: SEEN_CLAUDE_CODE },
    { name: 'CLAUDE_CODE_MESSAGING_TOKEN', seen: SEEN_CLAUDE_CODE },
    { name: 'CLAUDE_CODE_MESSAGING_SOCKET', seen: SEEN_CLAUDE_CODE },
  ],
  codex: [],
  agy: [],
}

/** Every client's session variable names, in one list. */
export const CLIENT_SESSION_VARIABLE_NAMES: readonly string[] =
  Object.values(CLIENT_SESSION_VARIABLES).flatMap((vars) => vars.map((v) => v.name))

/** Windows reads variable names without case; every other OS reads them
 *  exactly. */
const fold = (name: string): string => (process.platform === 'win32' ? name.toUpperCase() : name)

/**
 * The environment the ticket door gives a worker (D389): the spawner's
 * environment as passed or inherited, without the named client-session
 * variables, and with the door's own variables set on top. The spawner's
 * environment is copied, never changed.
 */
export function workerEnvironment(spawnerEnv: NodeJS.ProcessEnv, own: Record<string, string>): NodeJS.ProcessEnv {
  const dropped = new Set(CLIENT_SESSION_VARIABLE_NAMES.map(fold))
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(spawnerEnv)) {
    if (!dropped.has(fold(name))) env[name] = value
  }
  return { ...env, ...own }
}
