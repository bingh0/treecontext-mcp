/**
 * CI diagnostic, temporary (2026-11-11): what Codex's app server answers to
 * `hooks/list` for a hooks file holding treecontext's block, printed raw, on
 * each runner. On Windows doctor reads "Codex does not load <hooks.json>"
 * for a file install wrote, and nothing on a Linux machine can say why:
 * whether Codex lists no hook there, or lists them under another spelling
 * of the path or the command than the one install compares with. Remove
 * with the step that runs it once the Windows lane is read.
 */
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-diag-codex-')))
const codexHome = join(home, '.codex')
mkdirSync(codexHome, { recursive: true })
process.env['CODEX_HOME'] = codexHome
process.env['HOME'] = home
process.env['USERPROFILE'] = home

const { codexHooksBlock, codexHooksPath, codexVerdictOf, blockHookKeys } = await import('../src/server/codex-hooks.js')
const { readCodexHooksTrust } = await import('../src/server/codex-client.js')

const block = codexHooksBlock()
const file = codexHooksPath()
writeFileSync(file, JSON.stringify({ hooks: block }, null, 2) + '\n')
const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-diag-cwd-')))
const trust = await readCodexHooksTrust(cwd)
console.log('platform:', process.platform)
console.log('file install compares with:', JSON.stringify(file))
console.log('a command of the block:', JSON.stringify(block['Stop']?.[0]?.hooks?.[0]?.command))
if (!trust.ok) {
  console.log('hooks/list failed:', trust.why)
} else {
  console.log('hooks listed:', trust.hooks.length, '| warnings:', JSON.stringify(trust.warnings), '| errors:', JSON.stringify(trust.errors))
  for (const h of trust.hooks.slice(0, 3)) console.log('  listed:', JSON.stringify(h))
  console.log('verdict:', JSON.stringify(codexVerdictOf(trust, file, blockHookKeys(block))))
}
