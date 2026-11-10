/**
 * The `treecontext run` wrapper as a build before D403 ran it, a stand-in
 * (tests/journal/standins.ts, `earlierBuild`): this build's own wrapper
 * (`runCommand`, the door `treecontext run` is), its process probe without
 * the numbering and time-namespace readings earlier builds did not have
 * (`pidNamespace`, `lookInNamespace`, `seesEveryNumbering`, `timeNamespace`). So it registers its worker with no numbering of
 * processes, and its own phantom pass judges every worker by its own process
 * table, as an earlier build's did; the rest of the door, its retirement at
 * the worker's exit included, is this build's.
 *
 * argv: what `treecontext run` takes after `run`.
 */
import { hostProbe, type ProcessProbe } from '../../src/persistence/process-probe.js'

const probe = hostProbe as Partial<ProcessProbe>
delete probe.pidNamespace
delete probe.lookInNamespace
delete probe.seesEveryNumbering
delete probe.timeNamespace

const { runCommand } = await import('../../src/server/run-command.js')
const { resolveStorePath, resolveAutoStore } = await import('../../src/server/cli.js')
process.exitCode = await runCommand(process.argv.slice(2), {
  dbPathFor: (store, projectDir) => resolveStorePath(store ?? resolveAutoStore(projectDir)),
})
