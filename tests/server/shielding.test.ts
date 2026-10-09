import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync, mkdirSync, mkdtempSync, writeFileSync, readdirSync, utimesSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { redirectHome } from '../helpers/home.js'
import { itPosix } from '../helpers/platform.js'
import {
  shieldResponse,
  cleanShieldDir,
  cleanLegacyShieldDir,
  defaultShieldConfig,
  SHIELD_FILE_RE,
} from '../../src/server/shielding.js'

describe('shielding', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = join(tmpdir(), 'treecontext-shield-test-' + randomUUID())
    mkdirSync(tempDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  describe('shieldResponse', () => {
    it('returns unchanged when threshold is 0 (disabled)', () => {
      const config = defaultShieldConfig({ thresholdBytes: 0, shieldDir: tempDir })
      const res = shieldResponse('my_tool', 'some large text', config)
      expect(res.shielded).toBe(false)
      expect(res.text).toBe('some large text')
    })

    it('returns unchanged when text is below threshold', () => {
      const config = defaultShieldConfig({ thresholdBytes: 100, shieldDir: tempDir })
      const res = shieldResponse('my_tool', 'short', config)
      expect(res.shielded).toBe(false)
      expect(res.text).toBe('short')
    })

    it('shields response when text exceeds threshold', () => {
      const config = defaultShieldConfig({ thresholdBytes: 10, shieldDir: tempDir })
      const res = shieldResponse('my_tool', 'this is somewhat long', config)
      expect(res.shielded).toBe(true)
      const json = JSON.parse(res.text)
      expect(json.shielded).toBe(true)
      expect(json.file).toMatch(/my_tool-.*\.json$/)
    })

    it('writes full response to file when shielded', () => {
      const config = defaultShieldConfig({ thresholdBytes: 5, shieldDir: tempDir })
      const text = 'this is somewhat long'
      const res = shieldResponse('my_tool', text, config)
      expect(res.shielded).toBe(true)

      const files = readdirSync(tempDir)
      expect(files.length).toBe(1)
      expect(files[0]!).toContain('my_tool-')
    })

    it('generates valid JSON reference with file path, bytes, tool name', () => {
      const config = defaultShieldConfig({ thresholdBytes: 5, shieldDir: tempDir })
      const text = 'this is somewhat long'
      const res = shieldResponse('test_tool', text, config)
      expect(res.shielded).toBe(true)
      const ref = JSON.parse(res.text)
      expect(ref.shielded).toBe(true)
      expect(ref.tool).toBe('test_tool')
      expect(ref.bytes).toBe(Buffer.byteLength(text, 'utf-8'))
      expect(ref.file).toBeTruthy()
      expect(ref.hint).toContain('Response exceeded')
    })

    it('respects neverShield set — listed tools are never shielded', () => {
      const config = defaultShieldConfig({
        thresholdBytes: 5,
        shieldDir: tempDir,
        neverShield: new Set(['treecontext_status'])
      })
      const res = shieldResponse('treecontext_status', 'this is somewhat long', config)
      expect(res.shielded).toBe(false)
    })

    it('respects alwaysShield set — only listed tools are eligible', () => {
      const config = defaultShieldConfig({
        thresholdBytes: 5,
        shieldDir: tempDir,
        alwaysShield: new Set(['my_tool']) // not my_tool2
      })
      const res = shieldResponse('my_tool2', 'this is somewhat long', config)
      expect(res.shielded).toBe(false)

      const res2 = shieldResponse('my_tool', 'this is somewhat long', config)
      expect(res2.shielded).toBe(true)
    })

    it('creates shield directory if it does not exist', () => {
      const nestedDir = join(tempDir, 'nested', 'shield')
      const config = defaultShieldConfig({ thresholdBytes: 5, shieldDir: nestedDir })
      const res = shieldResponse('my_tool', 'this is somewhat long', config)
      expect(res.shielded).toBe(true)
      const files = readdirSync(nestedDir)
      expect(files.length).toBe(1)
    })
  })

  describe('cleanShieldDir', () => {
    // Names in the shape shieldResponse mints: <tool>-<epoch-ms>-<uuid8>.json
    const shieldName = (tool: string): string => `${tool}-1700000000000-abcd1234.json`

    it('removes shield files older than maxAgeMs', () => {
      const config = defaultShieldConfig({ thresholdBytes: 10, maxAgeMs: 1000, shieldDir: tempDir })

      const file1 = join(tempDir, shieldName('tool_a'))
      const file2 = join(tempDir, shieldName('tool_b'))
      writeFileSync(file1, 'data1')
      writeFileSync(file2, 'data2')

      // Set file1 to be 2 seconds old
      const timePast = new Date(Date.now() - 2000)
      utimesSync(file1, timePast, timePast)

      const count = cleanShieldDir(config)
      expect(count).toBe(1)

      const files = readdirSync(tempDir)
      expect(files).toEqual([shieldName('tool_b')])
    })

    it('preserves shield files newer than maxAgeMs', () => {
      const config = defaultShieldConfig({ thresholdBytes: 10, maxAgeMs: 5000, shieldDir: tempDir })
      writeFileSync(join(tempDir, shieldName('tool_a')), 'data1')

      const count = cleanShieldDir(config)
      expect(count).toBe(0)
    })

    it('never deletes a file it did not name (lockdown, 2026-08-15)', () => {
      // --shield-dir is unvalidated user input; an age-based sweep of an
      // arbitrary directory must only ever take its own files. The
      // 10-digit-epoch name is the F-review near-miss: other tools mint
      // `run-<unix-seconds>-<hex>.json`, which a looser \d+ matched.
      const config = defaultShieldConfig({ thresholdBytes: 10, maxAgeMs: 1000, shieldDir: tempDir })
      const timePast = new Date(Date.now() - 60_000)
      for (const name of ['thesis-draft.json', 'run-1723600000-0badf00d.json']) {
        const foreign = join(tempDir, name)
        writeFileSync(foreign, 'not ours')
        utimesSync(foreign, timePast, timePast)
      }

      expect(cleanShieldDir(config)).toBe(0)
      expect(readdirSync(tempDir).sort()).toEqual(['run-1723600000-0badf00d.json', 'thesis-draft.json'])
    })

    it('the minted filename and the sweep regex agree', () => {
      // Nothing else ties the mint site to SHIELD_FILE_RE; if the name
      // format changes without the regex, the sweep silently orphans
      // every file the module writes from then on.
      const config = defaultShieldConfig({ thresholdBytes: 8, shieldDir: tempDir })
      const res = shieldResponse('treecontext_query', 'a text well over the threshold', config)
      expect(res.shielded).toBe(true)
      const name = res.filePath!.split(/[\\/]/).pop()!
      expect(name).toMatch(SHIELD_FILE_RE)
    })

    it('a custom dir is a no-op while shielding is disabled (lockdown, 2026-08-15)', () => {
      const config = defaultShieldConfig({ thresholdBytes: 0, maxAgeMs: 1000, shieldDir: tempDir })
      const stale = join(tempDir, shieldName('tool_a'))
      writeFileSync(stale, 'data')
      const timePast = new Date(Date.now() - 60_000)
      utimesSync(stale, timePast, timePast)

      expect(cleanShieldDir(config)).toBe(0)
      expect(readdirSync(tempDir)).toHaveLength(1)
    })

    it('the default dir keeps its retention even while disabled (F review 2026-08-15)', () => {
      // Files minted before the flag was dropped must not persist
      // forever: in the module's OWN default dir, matching names are
      // provably its own, so the disabled gate does not apply.
      const home = mkdtempSync(join(tmpdir(), 'tc-shield-off-'))
      const restore = redirectHome(home)
      try {
        const dir = join(home, '.treecontext', 'shield')
        mkdirSync(dir, { recursive: true })
        const stale = join(dir, shieldName('treecontext_query'))
        writeFileSync(stale, 'old shield dump')
        const timePast = new Date(Date.now() - 60_000)
        utimesSync(stale, timePast, timePast)

        const config = defaultShieldConfig({ thresholdBytes: 0, maxAgeMs: 1000 })
        expect(cleanShieldDir(config)).toBe(1)
        expect(readdirSync(dir)).toEqual([])
      } finally {
        restore()
        rmSync(home, { recursive: true, force: true })
      }
    })

    itPosix('the legacy tmpdir location is swept with the same retention (release-diff review)', () => {
      // Pre-lockdown releases shielded into $TMPDIR/treecontext-shield —
      // and a NEIGHBORING project still on the old release writes fresh
      // files there. Aged files go; a fresh matching file survives (an
      // agent may hold its reference right now); foreign names are
      // never touched. POSIX-only: os.tmpdir() reads $TMPDIR there,
      // which is the only seam this test can redirect.
      const fakeTmp = mkdtempSync(join(tmpdir(), 'tc-shield-legacy-'))
      const prevTmpdir = process.env['TMPDIR']
      process.env['TMPDIR'] = fakeTmp
      // Permissive umask, or the chmod assertion proves nothing: the
      // pre-upgrade producer wrote with umask-default modes, which is
      // the whole exposure.
      const prevUmask = process.umask(0o022)
      try {
        expect(tmpdir()).toBe(fakeTmp)
        const legacy = join(fakeTmp, 'treecontext-shield')
        mkdirSync(legacy, { recursive: true })
        const aged = join(legacy, shieldName('treecontext_export'))
        writeFileSync(aged, 'pre-upgrade dump')
        const twoHoursAgo = new Date(Date.now() - 2 * 3600_000)
        utimesSync(aged, twoHoursAgo, twoHoursAgo)
        const fresh = join(legacy, 'treecontext_query-1700000000001-cafe0001.json')
        writeFileSync(fresh, 'a live neighbor just wrote this')
        const foreign = join(legacy, 'foreign.json')
        writeFileSync(foreign, 'not ours')
        utimesSync(foreign, twoHoursAgo, twoHoursAgo)

        expect(cleanLegacyShieldDir()).toBe(1)
        expect(readdirSync(legacy).sort()).toEqual(['foreign.json', 'treecontext_query-1700000000001-cafe0001.json'])
        // The surviving fresh MATCHING file is no longer world-readable
        // (pass-2 review: retention alone left the exposure open for
        // days); the foreign file's mode is not ours to touch.
        expect(statSync(fresh).mode & 0o777).toBe(0o600)
        expect(statSync(foreign).mode & 0o777).toBe(0o644)
      } finally {
        process.umask(prevUmask)
        if (prevTmpdir === undefined) delete process.env['TMPDIR']
        else process.env['TMPDIR'] = prevTmpdir
        rmSync(fakeTmp, { recursive: true, force: true })
      }
    })

    it('handles non-existent directory gracefully', () => {
      const config = defaultShieldConfig({ thresholdBytes: 10, shieldDir: join(tempDir, 'non-existent') })
      expect(cleanShieldDir(config)).toBe(0)
    })
  })

  describe('defaultShieldConfig', () => {
    it('returns sensible defaults with threshold 0', () => {
      const config = defaultShieldConfig()
      expect(config.thresholdBytes).toBe(0)
      expect(config.neverShield.has('treecontext_status')).toBe(true)
    })

    it('merges overrides correctly', () => {
      const config = defaultShieldConfig({ thresholdBytes: 1024, maxAgeMs: 10 })
      expect(config.thresholdBytes).toBe(1024)
      expect(config.maxAgeMs).toBe(10)
    })
  })
})
