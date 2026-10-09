/**
 * Scaffolding shared by the isolated child processes beside this file
 * (doctor-backup, log-sharing, stores-list, sweep, telemetry-fragment).
 *
 * Each exists for the same reason — a product module freezes a path from
 * homedir() at import, so the only honest sandbox is a process whose
 * module graph starts with HOME already redirected — and each had grown
 * the same blocks by hand: `main().then(exit 0, err => { print; exit 1 })`
 * in all five, and in four of them a console swap with its restore in a
 * finally. Four copies of a restore-in-finally is four chances for one of
 * them to leak a patched console into the rest of a run.
 */

/** What a captured run yields: the function's own value, and every line
 *  the console swallowed while it ran. */
export interface ConsoleCapture<T> {
  result: T
  lines: string[]
}

/**
 * Run `fn` with console.log captured line by line, restoring the real
 * console however it ends.
 *
 * console.error is silenced by default — these children print their
 * payload on stdout and the parent treats stderr as failure noise — and
 * `captureError` folds it into the same line list instead, for the child
 * whose subject (the CLI's log()) writes there because stdout is the MCP
 * protocol channel.
 */
export async function captureConsole<T>(
  fn: () => Promise<T>,
  opts: { captureError?: boolean } = {},
): Promise<ConsoleCapture<T>> {
  const lines: string[] = []
  const origLog = console.log
  const origErr = console.error
  const record = (...a: unknown[]): void => { lines.push(a.join(' ')) }
  console.log = record
  console.error = opts.captureError ? record : () => {}
  try {
    return { result: await fn(), lines }
  } finally {
    console.log = origLog
    console.error = origErr
  }
}

/**
 * The child entry point: run `main`, exit 0 when it resolves, print the
 * failure to stderr and exit 1 when it does not. An explicit exit is the
 * point — a child that merely falls off the end of main() waits on
 * whatever handles the product graph left open.
 */
export function runChildMain(main: () => Promise<void>): void {
  main().then(
    () => process.exit(0),
    (err: unknown) => {
      console.error(err)
      process.exit(1)
    },
  )
}
