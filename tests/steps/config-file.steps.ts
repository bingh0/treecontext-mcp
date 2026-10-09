/**
 * config-file.feature bindings — gherkin-node-test executor.
 * (Executor-migration Phase 2, 2026-08-26: translated from the
 * vitest-cucumber binding; every assertion preserved verbatim.)
 *
 * Discovery ladder end-to-end, the --config parse guard,
 * installGlobalConfig's preserve rules, and the doctor/serve asymmetry
 * on a corrupt file (real CLI spawns — those behaviors live in main()).
 *
 * Scoped HOME redirects replace the old whole-module redirect:
 * config.ts and installGlobalConfig resolve homedir() per call, so the
 * global-location scenarios wrap their own sandboxed home around the
 * scenario and defer the restore (agents.ts freezes at import, but
 * nothing here consumes its frozen paths). The corrupt-config trio
 * shares one Given and spawns the real CLI — the sandbox travels via
 * the spawn's home argument, no redirect involved. The write-failure
 * and file-mode pins live in tests/server/config-write-policy.test.ts.
 */
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, vi } from 'vitest'
import type { Registry } from 'gherkin-node-test/vitest'

import { redirectHome } from '../helpers/home.js'
import { spawnCli } from '../helpers/cli-spawn.js'

import { loadConfigFile } from '../../src/server/config.js'
import { parseArgs } from '../../src/server/cli.js'
import { installGlobalConfig } from '../../src/server/installer.js'
import { storesDirIn } from '../helpers/store-fixtures.js'

interface World {
  defer: (fn: () => void | Promise<void>) => void
  scratch?: string
  fakeHome?: string
  globalConfig?: string
  projectToml?: string
  envPath?: string
  explicitPath?: string
  loaded?: ReturnType<typeof loadConfigFile>
  parseFailure?: string
  installResult?: ReturnType<typeof installGlobalConfig>
  run?: { status: number | null; out: string }
}

const CORRUPT_TOML = '[server\ncapture = maybe'
const CAPTURE_FALSE = [
  '# capture off while I evaluate the beta',
  '[server]',
  'capture = false',
  '',
].join('\n')

export const configFileDefiner = (reg: Registry<World>): void => {
  /** The old BeforeEachScenario: clean TREECONTEXT_CONFIG, a scratch dir. */
  function freshScratch(w: World): void {
    const scratch = mkdtempSync(join(tmpdir(), 'tc-config-scratch-'))
    w.defer(() => rmSync(scratch, { recursive: true, force: true }))
    const prev = process.env['TREECONTEXT_CONFIG']
    w.defer(() => {
      if (prev === undefined) delete process.env['TREECONTEXT_CONFIG']
      else process.env['TREECONTEXT_CONFIG'] = prev
    })
    delete process.env['TREECONTEXT_CONFIG']
    w.scratch = scratch
  }

  /** A sandboxed home current for the whole scenario (per-call readers). */
  function freshGlobalHome(w: World): void {
    const home = mkdtempSync(join(tmpdir(), 'tc-config-file-'))
    w.defer(() => rmSync(home, { recursive: true, force: true }))
    const restore = redirectHome(home)
    w.defer(restore)
    w.fakeHome = home
    w.globalConfig = join(home, '.treecontext', 'config.toml')
  }

  // Merged: the corrupt-config trio (doctor / install / serve) seeds
  // the same unparseable global config; each spawns the real CLI with
  // the sandboxed home, so no redirect is involved here.
  reg.define(/^a home whose global config file is unparseable$/, (w) => {
    freshScratch(w)
    const home = mkdtempSync(join(tmpdir(), 'tc-config-file-'))
    w.defer(() => rmSync(home, { recursive: true, force: true }))
    w.fakeHome = home
    w.globalConfig = join(home, '.treecontext', 'config.toml')
    mkdirSync(join(home, '.treecontext'), { recursive: true })
    writeFileSync(w.globalConfig, CORRUPT_TOML)
  })

  reg.define(/^a config file named by the environment variable$/, (w) => {
    freshScratch(w)
    const envPath = join(w.scratch!, 'from-env.toml')
    writeFileSync(envPath, '[server]\ncapture = true\n')
    process.env['TREECONTEXT_CONFIG'] = envPath
    w.envPath = envPath
  })

  reg.define(/^an environment variable naming a missing file and a project config that exists$/, (w) => {
    freshScratch(w)
    process.env['TREECONTEXT_CONFIG'] = join(w.scratch!, 'never-written.toml')
    w.projectToml = join(w.scratch!, 'treecontext.toml')
    writeFileSync(w.projectToml, '[server]\nsidecar = false\n')
  })

  reg.define(/^distinct config files at the environment, project, and global locations$/, (w) => {
    freshScratch(w)
    freshGlobalHome(w)
    const envPath = join(w.scratch!, 'env.toml')
    writeFileSync(envPath, '[server]\nshield_threshold = 1\n')
    process.env['TREECONTEXT_CONFIG'] = envPath
    w.projectToml = join(w.scratch!, 'treecontext.toml')
    writeFileSync(w.projectToml, '[server]\nshield_threshold = 2\n')
    mkdirSync(join(w.fakeHome!, '.treecontext'), { recursive: true })
    writeFileSync(w.globalConfig!, '[server]\nshield_threshold = 3\n')
  })

  reg.define(/^a config file whose keys carry the wrong types beside one valid key$/, (w) => {
    freshScratch(w)
    w.explicitPath = join(w.scratch!, 'typed.toml')
    writeFileSync(w.explicitPath, [
      '[server]',
      'capture = "yes"',        // string, not bool
      'port = "8080"',          // string, not number
      'shield_threshold = true', // bool, not number
      'sidecar = false',        // the valid key
      '',
    ].join('\n'))
  })

  reg.define(/^a command line ending in the config flag$/, (w) => {
    freshScratch(w)
  })

  reg.define(/^a global config that sets capture to false with a comment beside it$/, (w) => {
    freshScratch(w)
    freshGlobalHome(w)
    mkdirSync(join(w.fakeHome!, '.treecontext'), { recursive: true })
    writeFileSync(w.globalConfig!, CAPTURE_FALSE)
  })

  reg.define(/^a global config with other server keys but no capture value$/, (w) => {
    freshScratch(w)
    freshGlobalHome(w)
    mkdirSync(join(w.fakeHome!, '.treecontext'), { recursive: true })
    writeFileSync(w.globalConfig!, '[server]\nsidecar = false\n')
  })

  reg.define(/^a global config holding unparseable bytes$/, (w) => {
    freshScratch(w)
    freshGlobalHome(w)
    mkdirSync(join(w.fakeHome!, '.treecontext'), { recursive: true })
    writeFileSync(w.globalConfig!, CORRUPT_TOML)
  })

  reg.define(/^a config file whose shield threshold is negative$/, (w) => {
    freshScratch(w)
    w.explicitPath = join(w.scratch!, 'negative.toml')
    writeFileSync(w.explicitPath, '[server]\nshield_threshold = -1\n')
  })

  // Merged across five scenarios: the discovery ladder re-runs at each
  // step position, reading whatever the world holds now (S3 mutates the
  // env and removes the project file between invocations).
  reg.define(/^configuration loads without an explicit path$/, (w) => {
    w.loaded = loadConfigFile(null, w.scratch!)
  })

  // Merged: both type-gate scenarios load the path their Given staged.
  reg.define(/^configuration loads from that file$/, (w) => {
    w.loaded = loadConfigFile(w.explicitPath!, w.scratch!)
  })

  reg.define(/^the environment variable is cleared and configuration loads again$/, (w) => {
    delete process.env['TREECONTEXT_CONFIG']
    w.loaded = loadConfigFile(null, w.scratch!)
  })

  reg.define(/^the project file is removed and configuration loads again$/, (w) => {
    rmSync(w.projectToml!)
    w.loaded = loadConfigFile(null, w.scratch!)
  })

  reg.define(/^the arguments are parsed$/, (w) => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit 1')
    }) as never)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => parseArgs(['node', 'cli', 'serve', '--config'])).toThrow('exit 1')
      w.parseFailure = errSpy.mock.calls.flat().join(' ')
    } finally {
      exitSpy.mockRestore()
      errSpy.mockRestore()
    }
  })

  // Merged across the three install-preserve scenarios.
  reg.define(/^install writes the global config$/, (w) => {
    w.installResult = installGlobalConfig(false)
  })

  reg.define(/^doctor runs$/, (w) => {
    w.run = spawnCli(['doctor'], { home: w.fakeHome! })
  })

  reg.define(/^install runs for the reference agent$/, (w) => {
    // A .claude dir so the agent registry has a target; the assertion
    // is about the config repair, not the agent wiring.
    mkdirSync(join(w.fakeHome!, '.claude'), { recursive: true })
    w.run = spawnCli(['install', '--yes', '--agent', 'claude'], { home: w.fakeHome! })
  })

  reg.define(/^serve runs$/, (w) => {
    w.run = spawnCli(['serve', '--store', 'never-opened'], { home: w.fakeHome! })
  })

  reg.define(/^the environment file's values are the ones loaded$/, (w) => {
    expect(w.loaded!.path).toBe(w.envPath!)
    expect(w.loaded!.server.capture).toBe(true)
  })

  reg.define(/^discovery falls through to the project file$/, (w) => {
    expect(w.loaded!.path).toBe(w.projectToml)
    expect(w.loaded!.server.sidecar).toBe(false)
  })

  reg.define(/^the environment file wins$/, (w) => {
    expect(w.loaded!.server.shieldThreshold).toBe(1)
  })

  reg.define(/^the project file wins$/, (w) => {
    expect(w.loaded!.server.shieldThreshold).toBe(2)
  })

  reg.define(/^the global file wins$/, (w) => {
    expect(w.loaded!.server.shieldThreshold).toBe(3)
    expect(w.loaded!.path).toBe(w.globalConfig)
  })

  reg.define(/^the mistyped keys are absent from the result$/, (w) => {
    expect(w.loaded!.server.capture).toBeUndefined()
    expect(w.loaded!.server.port).toBeUndefined()
    expect(w.loaded!.server.shieldThreshold).toBeUndefined()
  })

  reg.define(/^the valid key survives$/, (w) => {
    expect(w.loaded!.server.sidecar).toBe(false)
  })

  reg.define(/^parsing fails and names the flag$/, (w) => {
    expect(w.parseFailure).toContain('--config requires a path')
  })

  reg.define(/^the file is skipped and its bytes survive comment and all$/, (w) => {
    expect(w.installResult!.status).toBe('skipped')
    expect(readFileSync(w.globalConfig!, 'utf8')).toBe(CAPTURE_FALSE)
  })

  reg.define(/^capture is added as true$/, (w) => {
    expect(w.installResult!.status).toBe('updated')
    expect(readFileSync(w.globalConfig!, 'utf8')).toMatch(/capture = true/)
  })

  reg.define(/^the other keys keep their values$/, (w) => {
    expect(readFileSync(w.globalConfig!, 'utf8')).toMatch(/sidecar = false/)
  })

  // Merged: the direct-install and install-CLI scenarios share this
  // observable over the same seeded corrupt bytes.
  reg.define(/^the original bytes survive in a corrupt side-file$/, (w) => {
    expect(readFileSync(`${w.globalConfig!}.corrupt`, 'utf8')).toBe(CORRUPT_TOML)
  })

  // Merged: likewise both install scenarios re-load the replaced file.
  reg.define(/^the fresh template enables capture$/, (w) => {
    const loaded = loadConfigFile(w.globalConfig!, w.scratch!)
    expect(loaded.server.capture).toBe(true)
  })

  reg.define(/^the threshold is absent from the result$/, (w) => {
    expect(w.loaded!.server.shieldThreshold).toBeUndefined()
  })

  reg.define(/^doctor completes its report$/, (w) => {
    expect(w.run!.status, w.run!.out).toBe(0)
    expect(w.run!.out).toMatch(/Global config: parse error/)
  })

  reg.define(/^install completes$/, (w) => {
    expect(w.run!.status, w.run!.out).toBe(0)
  })

  reg.define(/^it exits with an error$/, (w) => {
    expect(w.run!.status, w.run!.out).toBe(1)
    expect(existsSync(join(storesDirIn(w.fakeHome!), 'never-opened'))).toBe(false)
  })
}
