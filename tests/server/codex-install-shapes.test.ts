/**
 * Install meets a Codex hooks file (D406, D53), through the real CLI in a
 * throwaway HOME. Whether Codex loads the file is Codex's own verdict: the
 * table below holds every shape against the real Codex on PATH (0.167.0 or
 * later; skipped, saying why, where none is), and install's verdict must be
 * Codex's own, read from Codex's `hooks/list` on the file before install
 * touches it. Where Codex cannot answer, the stand-in `codex`
 * (tests/journal/standins.ts writeFakeCodex) stands in for its app server.
 * A symlinked file is written through to where it resolves, a link is never
 * replaced or deleted, a file the developer made read-only is a refusal, at
 * install and at uninstall. And doctor, when Codex lists none of
 * treecontext's hooks, never says to trust them.
 *
 * Install asks Codex from an empty directory, so no project's settings
 * decide capture for every project, and treecontext's hooks are in Codex's
 * hooks file if and only if Codex's entry serves in capture mode (D386,
 * D406), read here from the files install wrote. A put-back install cannot
 * make is said, the original text saved. Doctor reports on the project it
 * runs from, asking Codex there through a `codex` that hands only
 * `--version` and `app-server` to the real one (writeCodexPassThrough), so
 * no doctor run here starts Codex's sandbox.
 *
 * The real Codex 0.167.0 never stops loading a file it loaded because
 * install added its groups (the shapes below, and the block itself, load),
 * and install's change is text edits that leave every byte of the
 * developer's as written (json-text-edit.ts), so the one transition into
 * "rejects" the real Codex was found to make, from a re-serialisation that
 * rounded a u64::MAX `timeout` past u64, no longer happens (bound below).
 * "Loads, then rejects" is the stand-in's alone.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { parse as parseToml } from 'smol-toml'
import { spawnCli } from '../helpers/cli-spawn.js'
import { homeEnv, markClaudeCodeInstalled, redirectHome } from '../helpers/home.js'
import { writeFakeCodex, writeCodexPassThrough, developerTrustsCodexHooks } from '../journal/standins.js'
import { readCodexHooksTrust, parseCodexVersion } from '../../src/server/codex-client.js'
import { codexVerdictOf, compareVersions, blockHookKeys, codexHooksBlock, CODEX_INSTALL_PROBE_TIMEOUT_MS, CODEX_CAPTURE_FLOOR, CODEX_HOOK_EVENTS, type CodexFileVerdict } from '../../src/server/codex-hooks.js'

const homes: string[] = []
afterEach(() => {
  for (const h of homes.splice(0)) {
    // A directory a test made read-only must be writable again to be removed.
    spawnSync('chmod', ['-R', 'u+w', h])
    rmSync(h, { recursive: true, force: true })
  }
})
const home = (): string => {
  const h = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-codex-shapes-')))
  homes.push(h)
  markClaudeCodeInstalled(h)
  mkdirSync(join(h, '.codex'), { recursive: true })
  return h
}
const hooksPath = (h: string): string => join(h, '.codex', 'hooks.json')
const capture = (h: string): boolean => {
  const toml = parseToml(readFileSync(join(h, '.codex', 'config.toml'), 'utf8')) as { mcp_servers: { treecontext: { args: string[] } } }
  return toml.mcp_servers.treecontext.args.includes('--capture')
}
const install = (h: string, env?: Record<string, string>) => spawnCli(['install', '--yes', '--agent', 'codex'], { home: h, ...(env ? { env } : {}) })
const uninstall = (h: string, env?: Record<string, string>) => spawnCli(['uninstall', '--yes', '--agent', 'codex'], { home: h, ...(env ? { env } : {}) })
/** The block's commands, as install writes them under this home. */
const ourCommands = (h: string): Set<string> => {
  const data = JSON.parse(readFileSync(hooksPath(h), 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
  return new Set(CODEX_HOOK_EVENTS.map((e) => data.hooks[e.event]!.at(-1)!.hooks[0]!.command))
}
/** The block's hooks as Codex lists them (event and command), as written under this home. */
const ourHooks = (h: string): Set<string> => {
  const data = JSON.parse(readFileSync(hooksPath(h), 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
  return blockHookKeys(Object.fromEntries(CODEX_HOOK_EVENTS.map((e) => [e.event, [data.hooks[e.event]!.at(-1)!]])) as never)
}

// ── The real Codex on PATH ─────────────────────────────────────────────

const realVersion = parseCodexVersion(spawnSync('codex', ['--version'], { encoding: 'utf8' }).stdout)
const realCodex = realVersion !== null && compareVersions(realVersion, CODEX_CAPTURE_FLOOR) >= 0
const noRealCodex = realVersion === null
  ? `no codex on PATH answers --version, so Codex's own verdict cannot be read here`
  : `the codex on PATH reads ${realVersion}, below ${CODEX_CAPTURE_FLOOR}, so it is not the Codex install writes hooks for`

/** Codex's own account of its hooks for this home, asked as install asks it. */
const codexList = (h: string) => readCodexHooksTrust(h, 20_000, { PATH: process.env['PATH'] ?? '', ...homeEnv(h) })
/** Codex's own verdict on the file at this home. */
const codexSays = async (h: string, commands: ReadonlySet<string> = new Set()): Promise<CodexFileVerdict> => codexVerdictOf(await codexList(h), hooksPath(h), commands)
/** The developer's hooks Codex lists from the file (every one not of
 *  `ours`): each with its place, its command, the hash Codex keys its trust
 *  by and the trust Codex reports. */
const devListed = async (h: string, ours: ReadonlySet<string>): Promise<string[]> => {
  const t = await codexList(h)
  return t.ok ? t.hooks.filter((x) => x.sourcePath === hooksPath(h) && !ours.has(x.command)).map((x) => `${x.key} ${JSON.stringify(x.command)} ${x.currentHash ?? '(no hash)'} ${x.trustStatus}`).sort() : ['(no answer)']
}

/** Whether `a` is `b` with text inserted only: every character of `a`, in order. */
const isSubsequence = (a: string, b: string): boolean => {
  let j = 0
  for (const c of b) if (j < a.length && c === a[j]) j++
  return j === a.length
}
const OK = '{"type":"command","command":"echo dev"}'
/**
 * The reviewer's shapes and their neighbours. Codex's verdict on each is
 * read live, never written here; what is written is install's own,
 * narrower need (codexPlacementError): `false` marks the two files Codex
 * may load but install has no place in to add its groups without changing
 * a part that is not its own.
 */
const SHAPES: Array<[string, string, boolean?]> = [
  ['a valid file', `{"hooks":{"Stop":[{"hooks":[${OK}]}]}}\n`],
  ['a group with no "hooks" key beside a valid one', `{"hooks":{"Stop":[{"matcher":"x"},{"hooks":[${OK}]}]}}\n`],
  ['an unknown event whose value is not an array', `{"hooks":{"Bogus":{},"Stop":[{"hooks":[${OK}]}]}}\n`],
  ['a group in serde\'s sequence form', `{"hooks":{"Stop":[["m",[${OK}]]]}}\n`],
  ['an empty top-level array (serde\'s sequence form of the file)', '[]\n', false],
  ['"hooks" an empty array', '{"hooks":[]}\n', false],
  ['an event with no groups', '{"hooks":{"Stop":[]}}\n'],
  ['a prompt hook Codex skips', '{"hooks":{"Stop":[{"hooks":[{"type":"prompt","command":"echo dev"}]}]}}\n'],
  ['a string description', `{"description":"mine","hooks":{"Stop":[{"hooks":[${OK}]}]}}\n`],
  ['a top-level mcpServers key', `{"mcpServers":{},"hooks":{"Stop":[{"hooks":[${OK}]}]}}\n`],
  ['another top-level key', `{"other":1,"hooks":{"Stop":[{"hooks":[${OK}]}]}}\n`],
  ['a non-string description', `{"description":5,"hooks":{"Stop":[{"hooks":[${OK}]}]}}\n`],
  ['a hook without type', '{"hooks":{"Stop":[{"hooks":[{"command":"echo dev"}]}]}}\n'],
  ['a hook without command', '{"hooks":{"Stop":[{"hooks":[{"type":"command"}]}]}}\n'],
  ['a non-string command', '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":5}]}]}}\n'],
  ['a non-string matcher', `{"hooks":{"Stop":[{"matcher":5,"hooks":[${OK}]}]}}\n`],
  ['a string timeout', '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo dev","timeout":"3"}]}]}}\n'],
  ['an event that is a group, not an array', '{"hooks":{"PreToolUse":{"matcher":"Bash","hooks":[{"type":"command","command":"echo devpre"}]}}}\n'],
  ['"hooks" an array of hooks', '{"hooks":[{"type":"command","command":"echo devarr"}]}\n'],
  ['a group that is a string', `{"hooks":{"Stop":["echo notagroup",{"hooks":[${OK}]}]}}\n`],
  ['a hook that is a string', '{"hooks":{"Stop":[{"hooks":["echo devstop"]}]}}\n'],
  ['a duplicate key', `{"hooks":{"Stop":[{"hooks":[${OK}]}]},"hooks":{}}\n`],
  ['an empty file', ''],
  ['JSON that does not parse', '{"hooks":\n'],
  // What a re-serialisation would rewrite: install's change is text edits,
  // so the developer's text, and the trust Codex keyed to it, stay.
  ['a timeout of 2^63-1', '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo dev","timeout":9223372036854775807}]}]}}\n'],
  ['a float in a hook and in a group', '{"hooks":{"Stop":[{"x":2.50,"hooks":[{"type":"command","command":"echo dev","y":1.0e1}]}]}}\n'],
  ['escaped unicode in a command', '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo \\u00e9\\u0301 \\ud83d\\ude00 \\/"}]}]}}\n'],
  ['tabs, CRLF and no final newline', '{\r\n\t"hooks" :\t{ "Stop" : [\r\n\t\t{ "hooks" : [ {"type":"command",\t"command":"echo dev"} ] }\r\n\t] }\r\n}'],
  ['keys in another order', `{"hooks":{"PreToolUse":[{"hooks":[{"command":"echo devpre","type":"command"}],"matcher":"Bash"}],"Stop":[{"hooks":[${OK}]}]},"description":"mine"}\n`],
]

describe.skipIf(process.platform === 'win32' || !realCodex)(realCodex
  ? `a hooks file of each shape: install's verdict is Codex's own (the real Codex on PATH)`
  : `SKIPPED, the table of shapes against the real Codex: ${noRealCodex}`, () => {
  it.each(SHAPES)('%s', async (_name, text, placeable = true) => {
    const h = home()
    writeFileSync(hooksPath(h), text)
    const before = await codexSays(h)
    expect(before.state, 'Codex answered hooks/list').not.toBe('unknown')
    // The developer trusts every hook of theirs Codex lists, with Codex's own hashes.
    if (before.state === 'loads') await developerTrustsCodexHooks(h, h)
    const devBefore = await devListed(h, new Set())
    const run = install(h)
    const lines = run.stdout.split('\n')
    if (before.state === 'rejects') {
      // Codex does not load it: left byte for byte, Codex's own words, no capture.
      expect(run.status, run.out).toBe(0)
      expect(readFileSync(hooksPath(h), 'utf8')).toBe(text)
      expect(lines.find((l) => /Codex CLI stays tools-only/.test(l)), run.stdout).toContain(`Codex does not load its hooks file ${hooksPath(h)} (Codex says: ${before.said})`)
      expect(capture(h)).toBe(false)
      return
    }
    // Codex loads it: install never says Codex rejects it.
    expect(run.stdout).not.toMatch(/Codex does not load/)
    const left = lines.find((l) => /Codex CLI stays tools-only/.test(l))
    expect(left === undefined, run.stdout).toBe(placeable)
    if (left) {
      // Install's own narrower need: no place to add its groups without
      // changing a part that is not its own. Left byte for byte, said so.
      expect(left).toContain('Codex loads it as it is, but')
      expect(readFileSync(hooksPath(h), 'utf8')).toBe(text)
      expect(capture(h)).toBe(false)
      return
    }
    // Written beside the developer's parts, and Codex loads what install wrote.
    expect(run.status, run.out).toBe(0)
    const after = await codexSays(h, ourHooks(h))
    expect(after).toMatchObject({ state: 'loads', ours: CODEX_HOOK_EVENTS.length })
    expect(run.stdout).toContain(`Codex lists all ${CODEX_HOOK_EVENTS.length} of treecontext's hooks from ${hooksPath(h)}`)
    expect(capture(h)).toBe(true)
    // Nothing of the developer's was judged, dropped or rewritten: every hook
    // of theirs Codex listed before is listed after, at its place, with the
    // same hash and the same trust.
    expect(await devListed(h, ourCommands(h))).toEqual(devBefore)
    if (devBefore.length > 0) expect(devBefore.every((d) => d.endsWith(' trusted')), devBefore.join('\n')).toBe(true)
    // And every byte of the developer's text is where it was: the file is
    // the original with treecontext's text inserted, nothing else changed.
    const written = readFileSync(hooksPath(h), 'utf8')
    if (text.trim() !== '') expect(isSubsequence(text, written), written).toBe(true)
  }, 120_000)

  it("answers a hooks/list well inside install's bound for each read", async () => {
    const h = home()
    writeFileSync(hooksPath(h), SHAPES[0]![1])
    const started = performance.now()
    const r = await readCodexHooksTrust(h, CODEX_INSTALL_PROBE_TIMEOUT_MS, { PATH: process.env['PATH'] ?? '', ...homeEnv(h) })
    expect(r.ok).toBe(true)
    expect(performance.now() - started).toBeLessThan(CODEX_INSTALL_PROBE_TIMEOUT_MS / 2)
  }, 60_000)
})

// ── Where Codex cannot answer, or answers by a stand-in's plan ─────────

const fakeCodex = (plan: Parameters<typeof writeFakeCodex>[1]): Record<string, string> => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-fake-codex-')))
  homes.push(dir)
  writeFakeCodex(dir, plan)
  return { PATH: `${dir}:${process.env['PATH'] ?? ''}` }
}
const answer = (file: string, warnings: string[], hooks: Array<{ command: string }> = []): string => JSON.stringify({
  id: 1, result: { data: [{ cwd: '/x', hooks: hooks.map((x, i) => ({ key: `${file}:stop:${i}:0`, eventName: 'stop', command: x.command, sourcePath: file, trustStatus: 'untrusted' })), warnings, errors: [] }] },
})

describe.skipIf(process.platform === 'win32')('a Codex whose reading of its hooks file install cannot have, or that refuses what install wrote', () => {
  it('a Codex whose app server does not answer: written under install\'s own check, said "Codex\'s reading unknown", capture claimed', () => {
    const h = home()
    const env = fakeCodex({ version: '0.167.0', sandbox: { exit: 0, stderr: '' } })
    const run = install(h, env)
    expect(run.status, run.out).toBe(0)
    expect(readFileSync(hooksPath(h), 'utf8')).toContain('--client codex')
    expect(run.stdout).toMatch(/hooks: written, Codex's reading unknown: Codex's own account of its hooks could not be read \(codex app-server exited 2 before answering hooks\/list/)
    expect(capture(h)).toBe(true)
  }, 120_000)

  it("where Codex cannot answer, install judges only what it steps around: the developer's other parts are kept as they are", () => {
    const h = home()
    const mine = { description: 5, mcpServers: { x: {} }, hooks: { Bogus: {}, Stop: [{ matcher: 'x' }, ['m', []], { hooks: ['echo dev'] }] } }
    writeFileSync(hooksPath(h), JSON.stringify(mine))
    const run = install(h, fakeCodex({ version: '0.167.0', sandbox: { exit: 0, stderr: '' } }))
    expect(run.status, run.out).toBe(0)
    const after = JSON.parse(readFileSync(hooksPath(h), 'utf8')) as typeof mine & { hooks: { Stop: unknown[] } }
    expect(after.description).toBe(5)
    expect(after.mcpServers).toEqual({ x: {} })
    expect(after.hooks.Bogus).toEqual({})
    expect(after.hooks.Stop.slice(0, 3)).toEqual(mine.hooks.Stop)
    expect(capture(h)).toBe(true)
  }, 120_000)

  it('a hooks/list that never answers is cut at the bound given', async () => {
    const h = home()
    const env = fakeCodex({ version: '0.167.0', sandbox: { exit: 0, stderr: '' }, hooksList: 'hang' })
    const started = Date.now()
    const r = await readCodexHooksTrust(h, 400, { ...env, ...homeEnv(h) })
    expect(r).toEqual({ ok: false, why: 'codex app-server did not answer hooks/list within 400 ms' })
    expect(Date.now() - started).toBeLessThan(5_000)
  }, 30_000)

  it('Codex no longer loading the file as install wrote it: the file is put back byte for byte, Codex quoted, no capture, the run fails', () => {
    const h = home()
    const text = `{"hooks":{"Stop":[{"hooks":[${OK}]}]}}\n`
    writeFileSync(hooksPath(h), text)
    const said = `failed to parse hooks config ${hooksPath(h)}: invalid type: map, expected u64 at line 9 column 1`
    const env = fakeCodex({ version: '0.167.0', sandbox: { exit: 0, stderr: '' }, hooksList: [answer(hooksPath(h), [], [{ command: 'echo dev' }]), answer(hooksPath(h), [said])] })
    const run = install(h, env)
    expect(run.status, run.out).not.toBe(0)
    expect(readFileSync(hooksPath(h), 'utf8')).toBe(text)
    expect(run.stdout).toContain(`hooks: none kept — Codex does not load ${hooksPath(h)} as install wrote it (Codex says: ${said}), so install put the file back byte for byte`)
    expect(capture(h)).toBe(false)
  }, 120_000)

  it('a file install created that Codex then refuses is removed again, and its record with it', () => {
    const h = home()
    const said = `failed to read hooks config ${hooksPath(h)}: Permission denied (os error 13)`
    const env = fakeCodex({ version: '0.167.0', sandbox: { exit: 0, stderr: '' }, hooksList: [answer(hooksPath(h), []), answer(hooksPath(h), [said])] })
    const run = install(h, env)
    expect(run.status, run.out).not.toBe(0)
    expect(existsSync(hooksPath(h))).toBe(false)
    const state = JSON.parse(readFileSync(join(h, '.treecontext', 'install-state.json'), 'utf8')) as { createdFiles?: Record<string, unknown>; codexHooks?: unknown }
    expect(state.createdFiles?.[hooksPath(h)]).toBeUndefined()
    expect(state.codexHooks).toBeUndefined()
  }, 120_000)

  it('Codex loading the file but listing none of treecontext\'s hooks and saying nothing of why: the block stays, said so, and the entry drains', () => {
    const h = home()
    const env = fakeCodex({ version: '0.167.0', sandbox: { exit: 0, stderr: '' }, hooksList: [answer(hooksPath(h), []), answer(hooksPath(h), [])] })
    const run = install(h, env)
    expect(run.status, run.out).toBe(0)
    expect(readFileSync(hooksPath(h), 'utf8')).toContain('--client codex')
    expect(run.stdout).toContain(`hooks: written, but Codex runs none of treecontext's ${CODEX_HOOK_EVENTS.length} hooks now: it lists none of them from ${hooksPath(h)}. Codex says nothing of why.`)
    expect(run.stdout).not.toMatch(/Codex lists all/)
    expect(capture(h)).toBe(true)
  }, 120_000)

  it('a put-back install cannot make is said: the original text saved, Codex\'s rejection named, the run fails, and the entry drains the block left in the file', () => {
    const h = home()
    // The hooks file is a symlink into a directory of the developer's, so
    // that locking it leaves Codex's own directory writable for the entry.
    const dot = join(h, 'dotfiles')
    mkdirSync(dot)
    const text = `{"hooks":{"Stop":[{"hooks":[${OK}]}]}}\n`
    writeFileSync(join(dot, 'hooks.json'), text)
    symlinkSync(join(dot, 'hooks.json'), hooksPath(h))
    const said = `failed to parse hooks config ${hooksPath(h)}: invalid type: map, expected u64 at line 9 column 1`
    const env = fakeCodex({
      version: '0.167.0', sandbox: { exit: 0, stderr: '' },
      hooksList: [answer(hooksPath(h), [], [{ command: 'echo dev' }]), answer(hooksPath(h), [said])],
      lockBefore: { answer: 1, path: dot },
    })
    const run = install(h, env)
    expect(run.status, run.out).not.toBe(0)
    expect(run.stdout).toContain(`Codex does not load ${hooksPath(h)} as install wrote it (Codex says: ${said}), and install could not put the file back`)
    const saved = /original text is saved at (\S+); restore it by hand: cp \S+ (\S+)/.exec(run.stdout)
    expect(saved, run.stdout).not.toBeNull()
    expect(saved![1]!.startsWith(join(h, '.treecontext'))).toBe(true)
    expect(readFileSync(saved![1]!, 'utf8')).toBe(text)
    expect(saved![2]).toBe(join(dot, 'hooks.json'))
    expect(run.stdout).toContain(`as it stands, Codex rejects ${join(dot, 'hooks.json')}, so none of its hooks load, yours included`)
    expect(readFileSync(join(dot, 'hooks.json'), 'utf8')).toContain('--client codex')
    expect(capture(h)).toBe(true)
  }, 120_000)

  it('a dry run starts no app server', () => {
    const h = home()
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-fake-codex-')))
    homes.push(dir)
    writeFakeCodex(dir, { version: '0.167.0', sandbox: { exit: 0, stderr: '' }, hooksList: [answer(hooksPath(h), []), answer(hooksPath(h), [])] })
    const run = spawnCli(['install', '--yes', '--dry-run', '--agent', 'codex'], { home: h, env: { PATH: `${dir}:${process.env['PATH'] ?? ''}` } })
    expect(run.status, run.out).toBe(0)
    expect(existsSync(join(dir, 'hooks-list.count')), 'the stand-in counted an app server').toBe(false)
    expect(run.stdout).toContain('a dry run does not start Codex\'s app server')
  }, 120_000)

  it('a read of Codex that takes longer than a second says once what install waits for and the bound', () => {
    const h = home()
    const run = install(h, fakeCodex({ version: '0.167.0', sandbox: { exit: 0, stderr: '' }, hooksList: 'hang' }))
    expect(run.status, run.out).toBe(0)
    const waits = run.stdout.split('\n').filter((l) => /waiting for Codex's own reading of its hooks file/.test(l))
    expect(waits, run.stdout).toEqual([`  hooks: waiting for Codex's own reading of its hooks file (codex app-server, hooks/list), at most ${CODEX_INSTALL_PROBE_TIMEOUT_MS / 1000} s for each read…`])
  }, 120_000)

  it('below the floor, a take-back the read-only file refuses leaves the hooks, and the entry drains them', () => {
    const h = home()
    expect(install(h, fakeCodex({ version: '0.167.0', sandbox: { exit: 0, stderr: '' } })).status).toBe(0)
    chmodSync(hooksPath(h), 0o444)
    const run = install(h, fakeCodex({ version: '0.166.0', sandbox: { exit: 0, stderr: '' } }))
    expect(run.status, run.out).not.toBe(0)
    expect(readFileSync(hooksPath(h), 'utf8')).toContain('--client codex')
    expect(run.stdout).toContain('treecontext\'s hooks remain in Codex\'s hooks file, so Codex CLI\'s entry starts the server in capture mode')
    expect(capture(h)).toBe(true)
  }, 120_000)
})

// ── Symlinks and read-only files (the real Codex, or none) ─────────────

describe.skipIf(process.platform === 'win32')('a symlinked or read-only hooks file', () => {
  it('a symlink stays a symlink, and the file it points at gets the block, its mode kept', () => {
    const h = home()
    const dot = join(h, 'dotfiles')
    mkdirSync(dot)
    writeFileSync(join(dot, 'hooks.json'), '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo dev"}]}]}}\n')
    chmodSync(join(dot, 'hooks.json'), 0o640)
    symlinkSync(join(dot, 'hooks.json'), hooksPath(h))
    const run = install(h)
    expect(run.status, run.out).toBe(0)
    expect(lstatSync(hooksPath(h)).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(dot, 'hooks.json'), 'utf8')).toContain('--client codex')
    expect(statSync(join(dot, 'hooks.json')).mode & 0o777).toBe(0o640)
    expect(capture(h)).toBe(true)
  }, 120_000)

  it('a dangling symlink whose directory exists: the file is created where it points, the link kept, and uninstall never deletes the link', () => {
    const h = home()
    const dot = join(h, 'dotfiles')
    mkdirSync(dot)
    symlinkSync(join('..', 'dotfiles', 'codex-hooks.json'), hooksPath(h))
    const run = install(h)
    expect(run.status, run.out).toBe(0)
    expect(lstatSync(hooksPath(h)).isSymbolicLink()).toBe(true)
    expect(readlinkSync(hooksPath(h))).toBe(join('..', 'dotfiles', 'codex-hooks.json'))
    expect(readFileSync(join(dot, 'codex-hooks.json'), 'utf8')).toContain('--client codex')
    expect(capture(h)).toBe(true)
    const un = uninstall(h)
    expect(un.status, un.out).toBe(0)
    expect(lstatSync(hooksPath(h)).isSymbolicLink()).toBe(true)
    expect(readlinkSync(hooksPath(h))).toBe(join('..', 'dotfiles', 'codex-hooks.json'))
    expect(readFileSync(join(dot, 'codex-hooks.json'), 'utf8')).not.toContain('--client codex')
  }, 120_000)

  it('a dangling symlink whose directory does not exist is refused loudly, and nothing changes', () => {
    const h = home()
    const dest = join(h, 'nowhere', 'codex-hooks.json')
    symlinkSync(dest, hooksPath(h))
    const run = install(h)
    expect(run.status, run.out).not.toBe(0)
    expect(run.out).toContain(`${hooksPath(h)} is a symlink to ${dest}, whose directory does not exist`)
    expect(lstatSync(hooksPath(h)).isSymbolicLink()).toBe(true)
    expect(readlinkSync(hooksPath(h))).toBe(dest)
    expect(existsSync(join(h, 'nowhere'))).toBe(false)
    expect(capture(h)).toBe(false)
  }, 120_000)

  it('a symlink to a writable file in a directory that refuses the write is judged by where the write lands: refused, unchanged', () => {
    const h = home()
    const dot = join(h, 'dotfiles')
    mkdirSync(dot)
    const text = `{"hooks":{"Stop":[{"hooks":[${OK}]}]}}\n`
    writeFileSync(join(dot, 'hooks.json'), text, { mode: 0o644 })
    symlinkSync(join(dot, 'hooks.json'), hooksPath(h))
    chmodSync(dot, 0o555)
    const run = install(h)
    expect(run.status, run.out).not.toBe(0)
    expect(run.out).toContain(`${join(dot, 'hooks.json')} cannot be written (EACCES)`)
    expect(readFileSync(join(dot, 'hooks.json'), 'utf8')).toBe(text)
    expect(lstatSync(hooksPath(h)).isSymbolicLink()).toBe(true)
    expect(capture(h)).toBe(false)
  }, 120_000)

  it('a file the developer made read-only is refused loudly, unchanged, its mode kept, no capture claimed', () => {
    const h = home()
    const text = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo dev"}]}]}}\n'
    writeFileSync(hooksPath(h), text)
    chmodSync(hooksPath(h), 0o444)
    const run = install(h)
    expect(run.status, run.out).not.toBe(0)
    expect(run.out).toMatch(/hooks\.json is read-only \(mode 444\)/)
    expect(readFileSync(hooksPath(h), 'utf8')).toBe(text)
    expect(statSync(hooksPath(h)).mode & 0o777).toBe(0o444)
    expect(capture(h)).toBe(false)
  }, 120_000)

  it('uninstall over a hooks file made read-only after install fails, and says the hooks remain and still run', () => {
    const h = home()
    expect(install(h).status).toBe(0)
    const text = readFileSync(hooksPath(h), 'utf8')
    chmodSync(hooksPath(h), 0o444)
    const un = uninstall(h)
    expect(un.status, un.out).not.toBe(0)
    expect(un.stdout).toContain(`treecontext's hooks remain in ${hooksPath(h)}, and Codex still runs them once trusted`)
    expect(un.stdout).toMatch(/Uninstall incomplete: part of it was refused/)
    expect(readFileSync(hooksPath(h), 'utf8')).toBe(text)
    // The hooks remain, so the entry stays, in capture mode, to drain them.
    expect(un.stdout).toContain(`mcp entry kept in ${join(h, '.codex', 'config.toml')}, in capture mode`)
    expect(capture(h)).toBe(true)
  }, 120_000)

  it('a full uninstall over a read-only hooks file keeps the entry draining and the scripts the remaining hooks run', () => {
    const h = home()
    expect(install(h).status).toBe(0)
    chmodSync(hooksPath(h), 0o444)
    const un = spawnCli(['uninstall', '--yes'], { home: h })
    expect(un.status, un.out).not.toBe(0)
    expect(capture(h)).toBe(true)
    for (const script of ['tc-stop', 'tc-post-tool-use', 'tc-session-start']) expect(existsSync(join(h, '.claude', 'hooks', script)), script).toBe(true)
    expect(existsSync(join(h, '.claude', 'hooks', 'tc-mcp-serve')), 'the launcher the entry names').toBe(true)
  }, 120_000)

  it('uninstall deletes the hooks file install created, and nothing else was in it', () => {
    const h = home()
    expect(existsSync(hooksPath(h))).toBe(false)
    expect(install(h).status).toBe(0)
    expect(existsSync(hooksPath(h))).toBe(true)
    expect(uninstall(h).status).toBe(0)
    expect(existsSync(hooksPath(h))).toBe(false)
  }, 120_000)
})

describe.skipIf(process.platform === 'win32' || !realCodex)("doctor when Codex lists none of treecontext's hooks", () => {
  it('never reads ok, never says trust them, and quotes what Codex said', () => {
    const h = home()
    expect(install(h).status).toBe(0)
    // Hooks turned off in Codex's own configuration: the file is right,
    // and Codex loads none of it.
    const toml = join(h, '.codex', 'config.toml')
    writeFileSync(toml, `${readFileSync(toml, 'utf8')}\n[features]\nhooks = false\n`)
    // Codex's own answers, and never its sandbox (writeCodexPassThrough).
    const doctor = spawnCli(['doctor'], { home: h, env: passThrough() })
    const row = codexRow(doctor.stdout)
    expect(row, doctor.stdout).toMatch(/^\[warn\]/)
    expect(row).toMatch(/Codex lists none of treecontext's 9 hooks/)
    expect(row).toContain(`Codex's own configuration turns its hooks off for every project: [features] hooks = false, in ${toml}`)
    expect(row).toContain(`remedy: setting [features] hooks = true in ${toml}, or taking that line out, never /hooks`)
    expect(row).not.toMatch(/remedy: trusting them/)
  }, 120_000)
})

// ── One project's settings, every project's capture (the real Codex) ───

/** The real `codex` on PATH, for the pass-through doctor reads it through. */
const realCodexPath = spawnSync('sh', ['-c', 'command -v codex'], { encoding: 'utf8' }).stdout.trim()
/** PATH with a `codex` that hands only `--version` and `app-server` to the real one. */
const passThrough = (): Record<string, string> => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-codex-pass-')))
  homes.push(dir)
  writeCodexPassThrough(dir, realCodexPath)
  return { PATH: `${dir}:${process.env['PATH'] ?? ''}` }
}
/** A git project under the home that Codex trusts, its own `.codex/config.toml` holding `config` when given. */
const trustedProject = (h: string, config?: string): string => {
  const proj = join(h, 'proj')
  mkdirSync(join(proj, '.codex'), { recursive: true })
  spawnSync('git', ['init', '-q', proj])
  const toml = join(h, '.codex', 'config.toml')
  writeFileSync(toml, `${existsSync(toml) ? readFileSync(toml, 'utf8') : ''}\n[projects."${proj}"]\ntrust_level = "trusted"\n`)
  if (config !== undefined) writeFileSync(join(proj, '.codex', 'config.toml'), config)
  return proj
}
const codexRow = (out: string): string => out.split('\n').find((l) => /^\[\w+\]\s+Codex CLI:/.test(l)) ?? ''

describe.skipIf(process.platform === 'win32' || !realCodex)(realCodex
  ? "Codex's [features] hooks = false, in a project and for the user (the real Codex on PATH)"
  : `SKIPPED, Codex's [features] hooks = false against the real Codex: ${noRealCodex}`, () => {
  it("a trusted project that turns hooks off decides nothing for other projects: install asks from an empty directory it removes, and doctor in that project names the project's setting", async () => {
    const h = home()
    const proj = trustedProject(h, '[features]\nhooks = false\n')
    // Codex itself lists none of the user's hooks from that project.
    writeFileSync(hooksPath(h), `{"hooks":{"Stop":[{"hooks":[${OK}]}]}}\n`)
    const fromProj = await readCodexHooksTrust(proj, 20_000, { PATH: process.env['PATH'] ?? '', ...homeEnv(h) })
    expect(fromProj.ok && fromProj.hooks.length, 'Codex lists no hook from the project').toBe(0)
    const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-install-tmp-')))
    homes.push(tmp)
    const run = spawnCli(['install', '--yes', '--agent', 'codex'], { home: h, cwd: proj, env: { TMPDIR: tmp } })
    expect(run.status, run.out).toBe(0)
    expect(run.stdout).toContain(`hooks: Codex lists all ${CODEX_HOOK_EVENTS.length} of treecontext's hooks from ${hooksPath(h)}`)
    expect(capture(h)).toBe(true)
    expect(readdirSync(tmp).filter((f) => f.startsWith('treecontext-codex-')), 'the empty directory is removed').toEqual([])
    const doctor = spawnCli(['doctor'], { home: h, cwd: proj, env: passThrough() })
    const row = codexRow(doctor.stdout)
    expect(row, doctor.stdout).toMatch(/^\[warn\]/)
    expect(row).toContain(`Codex lists none of treecontext's ${CODEX_HOOK_EVENTS.length} hooks for this project`)
    expect(row).toContain(`Codex's own configuration turns its hooks off in this project: [features] hooks = false, in ${join(proj, '.codex', 'config.toml')}`)
    expect(row).not.toMatch(/remedy: trusting them/)
  }, 180_000)

  it("the user's own config.toml turning hooks off: the block is written, the entry drains, and install says Codex runs none now and what turns them on", () => {
    const h = home()
    const toml = join(h, '.codex', 'config.toml')
    writeFileSync(toml, '[features]\nhooks = false\n')
    const run = install(h)
    expect(run.status, run.out).toBe(0)
    expect(readFileSync(hooksPath(h), 'utf8')).toContain('--client codex')
    expect(run.stdout).toContain(`hooks: written, but Codex runs none of treecontext's ${CODEX_HOOK_EVENTS.length} hooks now: it lists none of them from ${hooksPath(h)}.`)
    expect(run.stdout).toContain(`Codex's own configuration turns its hooks off: [features] hooks = false, in ${toml}; set it to true, or take the line out, to turn them on`)
    expect(run.stdout).not.toMatch(/Codex lists all|capture is running/)
    expect(readFileSync(toml, 'utf8')).toMatch(/\[features\]\s*\nhooks = false/)
    expect(capture(h)).toBe(true)
  }, 120_000)

  it("a project's own hooks file beside the user's: what Codex says of the project's file is never the user's (Codex's verdict)", async () => {
    const h = home()
    expect(install(h).status).toBe(0)
    const proj = trustedProject(h)
    const projHooks = join(proj, '.codex', 'hooks.json')
    const env = { PATH: process.env['PATH'] ?? '', ...homeEnv(h) }
    // A project's hooks file Codex does not load: its words name that file.
    writeFileSync(projHooks, '{"hooks":\n')
    const broken = await readCodexHooksTrust(proj, 20_000, env)
    expect(broken.ok && broken.warnings.some((w) => String(w).includes(`failed to parse hooks config ${projHooks}`)), JSON.stringify(broken)).toBe(true)
    expect(codexVerdictOf(broken, hooksPath(h), ourHooks(h))).toMatchObject({ state: 'loads', ours: CODEX_HOOK_EVENTS.length })
    const doctor = spawnCli(['doctor'], { home: h, cwd: proj, env: passThrough() })
    expect(codexRow(doctor.stdout), doctor.stdout).not.toMatch(/does not load/)
    // A project's hooks file holding the same commands: Codex lists both, and only the user's are install's.
    writeFileSync(projHooks, readFileSync(hooksPath(h)))
    const both = await readCodexHooksTrust(proj, 20_000, env)
    expect(both.ok && both.hooks.filter((x) => x.sourcePath === projHooks).length).toBe(CODEX_HOOK_EVENTS.length)
    expect(codexVerdictOf(both, hooksPath(h), ourHooks(h))).toMatchObject({ state: 'loads', ours: CODEX_HOOK_EVENTS.length })
  }, 180_000)

  it("a file Codex cannot answer for (a timeout of u64::MAX) keeps every byte of the developer's: the number is never rounded into one Codex refuses", async () => {
    const h = home()
    // u64::MAX: Codex's hook discovery panics on it (no answer). A
    // re-serialisation would round it past u64, which Codex refuses to
    // parse; install's text edits leave it as written.
    const text = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo dev","timeout":18446744073709551615}]}]}}\n'
    writeFileSync(hooksPath(h), text)
    expect((await codexSays(h)).state).toBe('unknown')
    const run = install(h)
    expect(run.status, run.out).toBe(0)
    const written = readFileSync(hooksPath(h), 'utf8')
    expect(written).toContain('"timeout":18446744073709551615}')
    expect(isSubsequence(text, written)).toBe(true)
    expect(run.stdout).toMatch(/hooks: written, Codex's reading unknown: .*hook discovery task failed/)
    expect((await codexSays(h)).state, 'still no answer, never a refusal').toBe('unknown')
    expect(capture(h)).toBe(true)
  }, 120_000)
})

// ── The entry's mode and the hooks in the file, one fact (doctor) ──────

describe.skipIf(process.platform === 'win32')("doctor names an entry whose mode disagrees with Codex's hooks file", () => {
  const codex = (): Record<string, string> => fakeCodex({ version: '0.167.0', sandbox: { exit: 0, stderr: '' } })
  it('hooks in the file and an entry that does not drain them', () => {
    const h = home()
    const env = codex()
    expect(install(h, env).status).toBe(0)
    const toml = join(h, '.codex', 'config.toml')
    writeFileSync(toml, readFileSync(toml, 'utf8').replace('"--capture"', '"--no-capture"'))
    expect(capture(h)).toBe(false)
    const row = codexRow(spawnCli(['doctor'], { home: h, env }).stdout)
    expect(row).toMatch(/^\[warn\]/)
    expect(row).toContain(`but treecontext's hooks are in ${hooksPath(h)} and run once Codex trusts and loads them, and this server does not drain what they stage`)
    const doctor = spawnCli(['doctor'], { home: h, env }).stdout
    expect(doctor).toMatch(/Conversation indexer: 1 of \d+ agents? in a mode their capture hooks disagree with\n\s+fix: treecontext install --agent codex/)
  }, 120_000)
  it('an entry in capture mode and no hook of treecontext\'s in the file', () => {
    const h = home()
    const env = codex()
    expect(install(h, env).status).toBe(0)
    rmSync(hooksPath(h))
    const row = codexRow(spawnCli(['doctor'], { home: h, env }).stdout)
    expect(row).toMatch(/^\[warn\]/)
    expect(row).toContain(`but no hook of treecontext's is in ${hooksPath(h)}, so this server has nothing to drain`)
  }, 120_000)
})

// ── Codex's config.toml: read-only and symlinked (D53) ─────────────────

describe.skipIf(process.platform === 'win32')("a read-only or symlinked config.toml", () => {
  const codex = (): Record<string, string> => fakeCodex({ version: '0.167.0', sandbox: { exit: 0, stderr: '' } })
  it("install over a config.toml the developer made read-only changes nothing of Codex's and fails", () => {
    const h = home()
    const toml = join(h, '.codex', 'config.toml')
    const text = '[mcp_servers.other]\ncommand = "echo"\n'
    writeFileSync(toml, text)
    chmodSync(toml, 0o444)
    const run = install(h, codex())
    expect(run.status, run.out).not.toBe(0)
    expect(run.stdout).toContain(`none written — Codex CLI: ${toml} is read-only (mode 444)`)
    expect(readFileSync(toml, 'utf8')).toBe(text)
    expect(statSync(toml).mode & 0o777).toBe(0o444)
    expect(existsSync(hooksPath(h)), 'no hooks without the entry that drains them').toBe(false)
    expect(existsSync(join(h, '.codex', 'AGENTS.md'))).toBe(false)
    expect(readdirSync(join(h, '.codex')).filter((f) => f.includes('treecontext-bak'))).toEqual([])
  }, 120_000)

  it('uninstall over a config.toml made read-only after install changes nothing: the hooks and the entry that drains them both stay', () => {
    const h = home()
    const env = codex()
    expect(install(h, env).status).toBe(0)
    const toml = join(h, '.codex', 'config.toml')
    const hooksText = readFileSync(hooksPath(h), 'utf8')
    const tomlText = readFileSync(toml, 'utf8')
    chmodSync(toml, 0o444)
    const un = uninstall(h, env)
    expect(un.status, un.out).not.toBe(0)
    expect(un.stdout).toContain(`${toml} is read-only (mode 444); uninstall changed nothing of Codex's`)
    expect(readFileSync(hooksPath(h), 'utf8')).toBe(hooksText)
    expect(readFileSync(toml, 'utf8')).toBe(tomlText)
    expect(capture(h)).toBe(true)
  }, 120_000)

  it('a symlinked config.toml is written through to where it points, the link and the mode kept, at install and at uninstall', () => {
    const h = home()
    const env = codex()
    const dot = join(h, 'dotfiles')
    mkdirSync(dot)
    writeFileSync(join(dot, 'codex.toml'), '[mcp_servers.other]\ncommand = "echo"\n', { mode: 0o640 })
    chmodSync(join(dot, 'codex.toml'), 0o640)
    const toml = join(h, '.codex', 'config.toml')
    symlinkSync(join('..', 'dotfiles', 'codex.toml'), toml)
    const run = install(h, env)
    expect(run.status, run.out).toBe(0)
    expect(lstatSync(toml).isSymbolicLink()).toBe(true)
    expect(readlinkSync(toml)).toBe(join('..', 'dotfiles', 'codex.toml'))
    expect(statSync(join(dot, 'codex.toml')).mode & 0o777).toBe(0o640)
    expect(capture(h)).toBe(true)
    expect(readFileSync(join(dot, 'codex.toml'), 'utf8')).toContain('[mcp_servers.other]')
    const un = uninstall(h, env)
    expect(un.status, un.out).toBe(0)
    expect(lstatSync(toml).isSymbolicLink()).toBe(true)
    expect(statSync(join(dot, 'codex.toml')).mode & 0o777).toBe(0o640)
    expect(readFileSync(join(dot, 'codex.toml'), 'utf8')).not.toContain('treecontext')
  }, 120_000)
})

// ── CODEX_HOME (the real Codex on PATH) ────────────────────────────────

describe.skipIf(process.platform === 'win32' || !realCodex)(realCodex
  ? 'CODEX_HOME: install, doctor and uninstall write and read where Codex reads (the real Codex on PATH)'
  : `SKIPPED, CODEX_HOME against the real Codex: ${noRealCodex}`, () => {
  it('a CODEX_HOME reached through a symlink: everything written in its directory, named, Codex lists all of treecontext\'s hooks from it, ~/.codex untouched, and uninstall takes them back there', async () => {
    const h = home()
    const real = join(h, 'codex-real')
    mkdirSync(real)
    symlinkSync(real, join(h, 'codex-link'))
    const env = { CODEX_HOME: join(h, 'codex-link') }
    const run = install(h, env)
    expect(run.status, run.out).toBe(0)
    expect(run.stdout).toContain(`Codex's directory is ${real} (CODEX_HOME), not ${join(h, '.codex')}`)
    expect(run.stdout).toContain(`hooks: Codex lists all ${CODEX_HOOK_EVENTS.length} of treecontext's hooks from ${join(real, 'hooks.json')}`)
    for (const f of ['config.toml', 'hooks.json', 'AGENTS.md']) expect(existsSync(join(real, f)), f).toBe(true)
    expect(readdirSync(join(h, '.codex'))).toEqual([])
    // Codex's own reading of the entry, under that CODEX_HOME.
    const listed = spawnSync('codex', ['mcp', 'get', 'treecontext', '--json'], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', ...homeEnv(h), CODEX_HOME: join(h, 'codex-link') } })
    expect(listed.status, listed.stderr).toBe(0)
    expect((JSON.parse(listed.stdout) as { transport: { args: string[] } }).transport.args).toContain('--capture')
    const doctor = spawnCli(['doctor'], { home: h, env: { ...passThrough(), ...env } })
    expect(codexRow(doctor.stdout), doctor.stdout).toContain(`Codex's directory is ${real} (CODEX_HOME)`)
    expect(codexRow(doctor.stdout)).toContain(`treecontext's hooks in ${join(real, 'hooks.json')}: present and consistent`)
    const un = uninstall(h, env)
    expect(un.status, un.out).toBe(0)
    expect(un.stdout).toContain(`Codex's directory is ${real} (CODEX_HOME)`)
    expect(existsSync(join(real, 'hooks.json'))).toBe(false)
    expect(readFileSync(join(real, 'config.toml'), 'utf8')).not.toContain('treecontext')
  }, 180_000)

  it('a relative CODEX_HOME is the directory it names from where install runs', () => {
    const h = home()
    mkdirSync(join(h, 'rel-codex'))
    const run = spawnCli(['install', '--yes', '--agent', 'codex'], { home: h, cwd: h, env: { CODEX_HOME: 'rel-codex' } })
    expect(run.status, run.out).toBe(0)
    expect(existsSync(join(h, 'rel-codex', 'hooks.json'))).toBe(true)
    expect(run.stdout).toContain(`hooks: Codex lists all ${CODEX_HOOK_EVENTS.length} of treecontext's hooks from ${join(h, 'rel-codex', 'hooks.json')}`)
  }, 120_000)

  it('a CODEX_HOME that does not exist: Codex refuses to start with it, so install writes nothing anywhere for Codex and fails, and doctor says so', () => {
    const h = home()
    const missing = join(h, 'no-such-dir')
    const run = install(h, { CODEX_HOME: missing })
    expect(run.status, run.out).not.toBe(0)
    expect(run.stdout).toContain(`CODEX_HOME points to "${missing}", but that path does not exist, so Codex itself refuses to start`)
    expect(existsSync(missing)).toBe(false)
    expect(readdirSync(join(h, '.codex'))).toEqual([])
    const doctor = spawnCli(['doctor'], { home: h, env: { ...passThrough(), CODEX_HOME: missing } })
    expect(doctor.stdout).toMatch(new RegExp(`\\[warn\\]\\s+Codex CLI directory: CODEX_HOME points to "${missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}", but that path does not exist`))
  }, 120_000)

  it('CODEX_HOME empty is CODEX_HOME unset: ~/.codex, and nothing names another directory', () => {
    const h = home()
    const run = install(h, { CODEX_HOME: '' })
    expect(run.status, run.out).toBe(0)
    expect(run.stdout).not.toContain('(CODEX_HOME)')
    expect(existsSync(hooksPath(h))).toBe(true)
    expect(capture(h)).toBe(true)
  }, 120_000)
})

// ── The review of c85c5f9: never damage the developer's file, never claim
// or hide capture falsely ────────────────────────────────────────────────

describe.skipIf(process.platform === 'win32' || !realCodex)(realCodex
  ? "the review's shape against the real Codex: an earlier build's hook sharing a group with a developer's, and the developer's own copy beside it"
  : `SKIPPED, the review's shape against the real Codex: ${noRealCodex}`, () => {
  it("install and uninstall keep each developer hook at its place, with its own text, hash and trust, the number as written", async () => {
    const h = home()
    const restoreHome = redirectHome(h)
    let tc: string
    try { tc = codexHooksBlock()['Stop']![0]!.hooks[0]!.command } finally { restoreHome() }
    const dev = '{"type":"command","command":"echo dev","timeout":9223372036854775807}'
    const text = `{"hooks":{"Stop":[{"hooks":[${dev},{"type":"command","command":${JSON.stringify(tc)}}]},{"hooks":[${dev}]}]}}\n`
    writeFileSync(hooksPath(h), text)
    expect((await codexSays(h)).state).toBe('loads')
    await developerTrustsCodexHooks(h, h)
    const before = (await codexList(h))
    const devOf = (t: Awaited<ReturnType<typeof codexList>>): string[] => t.ok ? t.hooks.filter((x) => x.command === 'echo dev').map((x) => `${x.key} ${x.currentHash ?? ''} ${x.trustStatus}`) : ['(no answer)']
    const devBefore = devOf(before)
    expect(devBefore).toHaveLength(2)
    const run = install(h)
    expect(run.status, run.out).toBe(0)
    const written = readFileSync(hooksPath(h), 'utf8')
    expect(written.split('9223372036854775807').length - 1).toBe(2)
    expect(written).not.toContain('9223372036854776000')
    expect(devOf(await codexList(h))).toEqual(devBefore)
    expect(run.stdout).toContain(`Codex lists all ${CODEX_HOOK_EVENTS.length} of treecontext's hooks`)
    const un = uninstall(h)
    expect(un.status, un.out).toBe(0)
    const back = readFileSync(hooksPath(h), 'utf8')
    expect(back).toBe(`{"hooks":{"Stop":[{"hooks":[${dev}]},{"hooks":[${dev}]}]}}\n`)
    expect(devOf(await codexList(h))).toEqual(devBefore)
  }, 180_000)
})

describe.skipIf(process.platform === 'win32')("Codex's reading before and after a write, a broken file at uninstall, and another CODEX_HOME", () => {
  const rpcError = JSON.stringify({ id: 1, error: { code: -32603, message: 'hook discovery task failed: task 1 panicked' } })
  it('Codex answered before install wrote and errs on what install wrote: the file is put back, the run fails, no capture', () => {
    const h = home()
    const text = `{"hooks":{"Stop":[{"hooks":[${OK}]}]}}\n`
    writeFileSync(hooksPath(h), text)
    const env = fakeCodex({ version: '0.167.0', sandbox: { exit: 0, stderr: '' }, hooksList: [answer(hooksPath(h), [], [{ command: 'echo dev' }]), rpcError] })
    const run = install(h, env)
    expect(run.status, run.out).not.toBe(0)
    expect(readFileSync(hooksPath(h), 'utf8')).toBe(text)
    expect(run.stdout).toContain('hook discovery task failed')
    expect(capture(h)).toBe(false)
  }, 120_000)

  it('a take-back Codex then cannot load is put back, the hooks and the draining entry kept, and uninstall fails saying so', () => {
    const h = home()
    expect(install(h, fakeCodex({ version: '0.167.0', sandbox: { exit: 0, stderr: '' } })).status).toBe(0)
    const text = readFileSync(hooksPath(h), 'utf8')
    const said = `failed to parse hooks config ${hooksPath(h)}: EOF while parsing a value at line 1 column 0`
    const env = fakeCodex({ version: '0.167.0', sandbox: { exit: 0, stderr: '' }, hooksList: [answer(hooksPath(h), []), answer(hooksPath(h), [said])] })
    const un = uninstall(h, env)
    expect(un.status, un.out).not.toBe(0)
    expect(un.stdout).toContain(`Codex does not load ${hooksPath(h)} as the take-back left it (Codex says: ${said}), so it was put back byte for byte`)
    expect(readFileSync(hooksPath(h), 'utf8')).toBe(text)
    expect(capture(h)).toBe(true)
  }, 120_000)

  it('a hooks file the developer broke after install: uninstall leaves it, keeps the entry draining, fails and says what remains; doctor names one remedy', () => {
    const h = home()
    const env = fakeCodex({ version: '0.167.0', sandbox: { exit: 0, stderr: '' } })
    expect(install(h, env).status).toBe(0)
    const broken = `${readFileSync(hooksPath(h), 'utf8')}\n,,,`
    writeFileSync(hooksPath(h), broken)
    const un = uninstall(h, env)
    expect(un.status, un.out).not.toBe(0)
    expect(un.stdout).toContain(`treecontext's hooks are still written in ${hooksPath(h)}, which does not parse now, and will run when it does; repair the file and run uninstall again`)
    expect(readFileSync(hooksPath(h), 'utf8')).toBe(broken)
    expect(capture(h)).toBe(true)
    const doctor = spawnCli(['doctor'], { home: h, env }).stdout
    const row = codexRow(doctor)
    expect(row).toContain("treecontext's hooks are still written in it and run again once it parses")
    expect(row).toMatch(/remedy: fixing \S+ by hand, never an install/)
    // One row, one remedy: no second finding about the entry's mode.
    expect(row).not.toMatch(/but no hook of treecontext's is in/)
    expect(doctor).not.toMatch(/Conversation indexer: \d+ of \d+ agents? in a mode/)
  }, 120_000)

  it("a reinstall refused over a read-only file that holds treecontext's hooks keeps the entry draining", () => {
    const h = home()
    const env = fakeCodex({ version: '0.167.0', sandbox: { exit: 0, stderr: '' } })
    expect(install(h, env).status).toBe(0)
    chmodSync(hooksPath(h), 0o444)
    const run = install(h, env)
    expect(run.status, run.out).not.toBe(0)
    expect(run.out).toMatch(/hooks\.json is read-only \(mode 444\)/)
    expect(capture(h)).toBe(true)
  }, 120_000)

  it("where install's record names its hooks, uninstall takes back exactly those: a developer's hook with an earlier build's command stays", () => {
    const h = home()
    const env = fakeCodex({ version: '0.167.0', sandbox: { exit: 0, stderr: '' } })
    expect(install(h, env).status).toBe(0)
    // The developer's own hook, its command an earlier build's (the
    // verbatim copy's, naming no client), in a group of theirs.
    const lookAlike = `exec "${join(h, '.claude', 'hooks', 'tc-stop')}"`
    const data = JSON.parse(readFileSync(hooksPath(h), 'utf8')) as { hooks: Record<string, unknown[]> }
    data.hooks['Stop']!.unshift({ matcher: 'mine', hooks: [{ type: 'command', command: lookAlike }] })
    writeFileSync(hooksPath(h), JSON.stringify(data, null, 2) + '\n')
    const un = uninstall(h, env)
    expect(un.status, un.out).toBe(0)
    expect(JSON.parse(readFileSync(hooksPath(h), 'utf8'))).toEqual({ hooks: { Stop: [{ matcher: 'mine', hooks: [{ type: 'command', command: lookAlike }] }] } })
    expect(un.stdout).not.toMatch(/known by their commands/)
    // The control: with no record (an earlier build's file), the same
    // command is known by its shape, taken back, and the output says so.
    const h2 = home()
    writeFileSync(hooksPath(h2), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `exec "${join(h2, '.claude', 'hooks', 'tc-stop')}"` }] }] } }, null, 2) + '\n')
    writeFileSync(join(h2, '.codex', 'config.toml'), '')
    const un2 = uninstall(h2, env)
    expect(un2.status, un2.out).toBe(0)
    expect(un2.stdout).toMatch(/1 hook\(s\) taken out were known by their commands as treecontext's, no install record naming them/)
    expect(JSON.parse(readFileSync(hooksPath(h2), 'utf8'))).toEqual({})
  }, 120_000)

  it('install under another CODEX_HOME is named by uninstall and doctor under this one, and left alone', () => {
    const h = home()
    const env = fakeCodex({ version: '0.167.0', sandbox: { exit: 0, stderr: '' } })
    const other = join(h, 'other-codex')
    mkdirSync(other)
    expect(install(h, { ...env, CODEX_HOME: other }).status).toBe(0)
    expect(install(h, env).status).toBe(0)
    const otherText = readFileSync(join(other, 'hooks.json'), 'utf8')
    const doctor = codexRow(spawnCli(['doctor'], { home: h, env }).stdout)
    expect(doctor).toContain(`also wired under ${other}; run uninstall with CODEX_HOME set to it`)
    const un = uninstall(h, env)
    expect(un.status, un.out).toBe(0)
    expect(un.stdout).toContain(`treecontext's hooks are also wired under ${other}; run uninstall with CODEX_HOME set to it`)
    expect(readFileSync(join(other, 'hooks.json'), 'utf8')).toBe(otherText)
  }, 120_000)
})
