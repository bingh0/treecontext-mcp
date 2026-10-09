/**
 * Install smoke test — install the packed artifact the way a tester does, on
 * a throwaway HOME, and check that the result actually works.
 *
 * This exists because of the release history. Five consecutive betas shipped
 * an install-or-doctor defect, every one found by a tester rather than here:
 *
 *   0.0.10  the installer, against the machines it installs onto
 *   0.0.11  the server that would not start, and the doctor that said it was fine
 *   0.0.12  the diagnostic that edited what it was diagnosing
 *   0.0.13  hooks that never ran
 *   0.0.14  the other Windows shell
 *
 * The cause was structural rather than careless. This repo's own machine ran
 * the source tree directly, so the one path nobody exercised was the one every
 * tester hits first: unpack a tarball, run `install`, run `doctor`. The suite
 * tested the installer's FUNCTIONS; nothing tested the installed PRODUCT.
 *
 * So this runs after `npm pack` and drives the real artifact:
 *   1. install the tarball globally into a temp prefix,
 *   2. run the binary — it must report the version just packed,
 *   3. run `install` against a temp HOME — it must write hooks and config,
 *   4. assert every hook command it wrote is one a shell can actually run,
 *      using the same checker `doctor` ships,
 *   5. run `doctor` — no `[err]` rows.
 *
 * HOME is redirected for every step, so this never reads or writes the
 * developer's own configuration. That isolation is the whole reason it is
 * safe to run on every release.
 *
 * What it cannot catch, stated so nobody mistakes green here for coverage:
 * anything platform-specific to a machine this is not running on. 0.0.13 and
 * 0.0.14 were Windows shell defects and would have survived this gate on
 * Linux. It closes the "does the artifact install and work at all" hole, not
 * the "does it work on every OS" one — which is why CI now runs it on all
 * three, and why the two Windows-shaped assumptions below are spelled out
 * rather than left to the first person who wonders why it passed everywhere
 * except the platform the last two releases were about.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unrunnableHookCommands } from '../src/server/installer.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }
const TARBALL = join(ROOT, `treecontext-mcp-${pkg.version}.tgz`)

/**
 * Run and return BOTH streams. This tool logs to stderr by design — stdout is
 * reserved for the MCP stdio transport — so `--version` and much of `doctor`
 * arrive there. A smoke test that read only stdout would see an empty string
 * and have to decide what it meant; combining is what matches the product.
 */
function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, label: string): string {
  // Windows cannot spawn a .cmd shim directly — since the Node 20.12 fix for
  // CVE-2024-27980 that throws EINVAL rather than running it. Both things this
  // drives ARE .cmd shims there (`npm`, and the `treecontext` npm writes), so
  // the Windows path has to go through a shell. Quoting is then ours to do:
  // a runner temp path is space-free today, and relying on that silently is
  // how a green gate turns into a mystery on the first machine that isn't.
  const useShell = process.platform === 'win32'
  const q = (s: string): string => (useShell && /\s/.test(s) ? `"${s}"` : s)
  const r = spawnSync(q(cmd), args.map(q), {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300_000,
    shell: useShell,
  })
  const both = `${r.stdout ?? ''}${r.stderr ?? ''}`
  if (r.status !== 0 || r.error) {
    console.error(`install-smoke: ${label} FAILED (exit ${r.status})`)
    console.error(both || r.error?.message || '')
    process.exit(1)
  }
  return both
}

function main(): void {
  if (!existsSync(TARBALL)) {
    console.error(`install-smoke: no artifact at ${TARBALL}`)
    console.error('               run after `npm pack` (see the pack:beta script).')
    process.exit(1)
  }

  const sandbox = mkdtempSync(join(tmpdir(), 'tc-smoke-'))
  const prefix = join(sandbox, 'prefix')
  const home = join(sandbox, 'home')

  // A HOME of its own, and none of the ambient treecontext wiring: the point
  // is a machine that has never seen this tool, not this machine with a
  // different HOME. NODE_OPTIONS is dropped because an inherited --require
  // can fail inside a prefix that has no such module.
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home }
  delete env['NODE_OPTIONS']
  delete env['CLAUDE_CONFIG_DIR']
  delete env['TREECONTEXT_CONFIG']
  delete env['TREECONTEXT_BINDINGS_FILE']

  try {
    console.log(`install-smoke: installing ${pkg.version} into a throwaway HOME…`)
    run('npm', ['install', '-g', '--prefix', prefix, TARBALL], env, 'npm install -g <tarball>')

    // npm puts global shims in different places per platform: `prefix/bin/x`
    // on POSIX, `prefix\x.cmd` at the root on Windows. Testing the shim rather
    // than reaching past it into dist/ is deliberate — the shim is what a
    // tester's shell actually invokes, and 0.0.9-beta shipped a working
    // package behind a broken entrypoint.
    const bin = process.platform === 'win32'
      ? join(prefix, 'treecontext.cmd')
      : join(prefix, 'bin', 'treecontext')
    if (!existsSync(bin)) {
      console.error(`install-smoke: no binary at ${bin} — the package installed but exposes nothing`)
      process.exit(1)
    }

    // The version the binary reports is the one thing that proves the artifact
    // under test is the artifact that ran, rather than something on PATH.
    const version = run(bin, ['--version'], env, 'treecontext --version').trim()
    if (!version.includes(pkg.version)) {
      console.error(`install-smoke: binary reports "${version}", expected ${pkg.version}`)
      process.exit(1)
    }

    // `install` configures agents it DETECTS, and detection is "does this
    // agent's directory exist". An empty HOME therefore installs nothing at
    // all — correct behaviour, and a smoke test that accepted it would be
    // asserting nothing. Stand up the one directory that makes this look like
    // a machine with Claude Code on it, which is what a tester has.
    mkdirSync(join(home, '.claude'), { recursive: true })
    run(bin, ['install', '--yes'], env, 'treecontext install')

    const settings = join(home, '.claude', 'settings.json')
    if (!existsSync(settings)) {
      console.error(`install-smoke: install wrote no ${settings}`)
      process.exit(1)
    }
    // The check doctor ships, applied to what install just wrote. A hook
    // command that the shell cannot run is the defect 0.0.13 shipped, and it
    // looked exactly like success from every angle except this one.
    const dead = unrunnableHookCommands(settings)
    if (dead.length > 0) {
      console.error('install-smoke: install wrote hook commands that will not run:')
      for (const d of dead) console.error(`  ${d.reason}\n    ${d.command}`)
      process.exit(1)
    }

    const doctor = run(bin, ['doctor'], env, 'treecontext doctor')
    const errors = doctor.split('\n').filter(l => l.startsWith('[err]'))
    if (errors.length > 0) {
      console.error('install-smoke: doctor reported errors on a fresh install:')
      for (const e of errors) console.error(`  ${e}`)
      process.exit(1)
    }

    console.log(`install-smoke: ${version} installs, self-reports, wires runnable hooks, and passes doctor.`)
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

main()
