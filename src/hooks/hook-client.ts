/**
 * The client a hook runs for (D404, D406, D413): named in the command
 * install wrote for that client (`<script> --client <name>`), handed on by
 * the hook script to `treecontext hook <event> --client <name>`, and read
 * here from the hook process's own arguments, never from the payload: Codex
 * CLI's payloads are shaped like Claude Code's, so a payload cannot tell the
 * two apart, and a misread would take a failing Codex command for a success
 * Claude Code stated.
 *
 * A hook whose command names no client (one an earlier build wrote, a
 * copied block, a hand-made entry) runs for no named client: its events
 * state nothing about how a call ended, and the call's class is read from
 * its text, as before.
 */

/** The flag the command carries the client's name under. */
export const HOOK_CLIENT_FLAG = '--client'

/** Claude Code's name in its hook commands. */
export const CLAUDE_CODE_CLIENT = 'claude-code'

/**
 * The clients whose own events state how a tool call ended (D404): those
 * whose recorded events (D402) show a failed call arriving by an event of
 * its own, so a call that arrives by the success event succeeded. Claude
 * Code: a failed call fires PostToolUseFailure and never PostToolUse
 * (recorded, 2.1.319, tests/fixtures/claude-code-hooks). A client is added
 * only on such a recording, never by the shape of its payloads.
 */
export const CLIENTS_STATING_OUTCOME: ReadonlySet<string> = new Set([CLAUDE_CODE_CLIENT])

/** The client named by `--client <name>` (or `--client=<name>`) in a hook
 *  process's arguments, or null when none is named. */
export function hookClientFrom(argv: readonly string[] = process.argv): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === HOOK_CLIENT_FLAG) {
      const v = argv[i + 1]
      return v !== undefined && v !== '' && !v.startsWith('-') ? v : null
    }
    if (a.startsWith(`${HOOK_CLIENT_FLAG}=`)) {
      const v = a.slice(HOOK_CLIENT_FLAG.length + 1)
      return v === '' ? null : v
    }
  }
  return null
}

/** Whether the named client's own events state how a call ended. */
export function clientStatesOutcome(client: string | null): boolean {
  return client !== null && CLIENTS_STATING_OUTCOME.has(client)
}

/** Codex CLI's name in its hook commands (D406): the block install writes
 *  into `~/.codex/hooks.json` names it on every command. Codex's events
 *  state no outcome for a call (D408: a shell command's non-zero exit
 *  arrives by PostToolUse as ordinary text, and any other call that fails
 *  fires no PostToolUse at all), so it is not in CLIENTS_STATING_OUTCOME. */
export const CODEX_CLIENT = 'codex'

/** Whether the hook runs for Codex CLI, by the command install wrote. */
export function isCodexHook(argv: readonly string[] = process.argv): boolean {
  return hookClientFrom(argv) === CODEX_CLIENT
}
