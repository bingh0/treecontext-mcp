import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { spawnCli } from '../helpers/cli-spawn.js'
import { markClaudeCodeInstalled } from '../helpers/home.js'

// Uninstall when install's record does not parse (MED-2 of the final
// review, D361, D390): only the record tells install's approvals, its
// idle-compaction key and the files it created from the developer's own,
// so uninstall removes none of them. It warns loudly, moves the record
// aside as install does, lists each client's file and the shapes install
// writes there, and exits 0, as install does over the same record.

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const json = (p: string): Record<string, unknown> => JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
const FOUR_CLAUDE = ['status', 'query', 'export', 'insert'].map(t => `mcp__treecontext__treecontext_${t}`)
const FOUR_AGY = ['status', 'query', 'export', 'insert'].map(t => `mcp(treecontext/treecontext_${t})`)

describe("uninstall without a readable record (D390)", () => {
  test('warns, moves the record aside, lists what it left by file and shape, removes none of it, and exits 0', () => {
    const h = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-lost-record-')))
    dirs.push(h)
    markClaudeCodeInstalled(h)
    mkdirSync(join(h, '.gemini', 'antigravity-cli'), { recursive: true })
    expect(spawnCli(['install', '--yes'], { home: h }).status).toBe(0)
    const claudeSettings = join(h, '.claude', 'settings.json')
    const agySettings = join(h, '.gemini', 'antigravity-cli', 'settings.json')
    expect((json(claudeSettings)['permissions'] as { allow: string[] }).allow).toEqual(FOUR_CLAUDE)
    const record = join(h, '.treecontext', 'install-state.json')
    writeFileSync(record, '{ not a record')

    const dry = spawnCli(['uninstall', '--yes', '--dry-run'], { home: h })
    expect(dry.status).toBe(0)
    expect(dry.stderr).toContain(`[warn] treecontext's install record ${record} could not be read (a real run moves it aside, as install does).`)
    expect(readFileSync(record, 'utf8')).toBe('{ not a record')

    const run = spawnCli(['uninstall', '--yes'], { home: h })
    expect(run.status, run.out).toBe(0)
    const moved = readdirSync(join(h, '.treecontext')).filter(f => f.startsWith('install-state.json.corrupt-'))
    expect(moved).toHaveLength(1)
    expect(moved[0]).toMatch(/^install-state\.json\.corrupt-\d{8}T\d{6}Z$/)
    expect(readFileSync(join(h, '.treecontext', moved[0]!), 'utf8')).toBe('{ not a record')
    expect(run.stderr).toContain(`it was moved to ${join(h, '.treecontext', moved[0]!)}`)
    expect(run.stderr).toContain("[warn] Without install's record uninstall cannot tell what install wrote from what you wrote, so it removes none of the following; remove them by hand where install wrote them:")
    expect(run.stderr).toContain(`  Claude Code: ${claudeSettings} — the permissions.allow rules mcp__treecontext__treecontext_status, mcp__treecontext__treecontext_query, mcp__treecontext__treecontext_export and mcp__treecontext__treecontext_insert, and "idleCompaction": false`)
    expect(run.stderr).toContain(`  Antigravity CLI: ${agySettings} — the permissions.allow rules mcp(treecontext/treecontext_status), mcp(treecontext/treecontext_query), mcp(treecontext/treecontext_export) and mcp(treecontext/treecontext_insert)`)
    expect(run.stdout).toMatch(/Uninstall incomplete: install's record could not be read, so what it would have named was left: see the warning above\./)
    expect(run.stdout).not.toMatch(/Uninstall complete/)
    // Nothing it could not prove install's was removed; what needs no record was.
    expect((json(claudeSettings)['permissions'] as { allow: string[] }).allow).toEqual(FOUR_CLAUDE)
    expect((json(agySettings)['permissions'] as { allow: string[] }).allow).toEqual(FOUR_AGY)
    expect(json(join(h, '.claude.json'))['mcpServers']).toEqual({})
  })

  test('a readable record: uninstall says nothing of a lost one and completes', () => {
    const h = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-lost-record-')))
    dirs.push(h)
    markClaudeCodeInstalled(h)
    expect(spawnCli(['install', '--yes'], { home: h }).status).toBe(0)
    const run = spawnCli(['uninstall', '--yes'], { home: h })
    expect(run.out).not.toMatch(/Without install's record/)
    expect(run.stdout).toContain('Uninstall complete.')
    expect(json(join(h, '.claude', 'settings.json'))['permissions']).toBeUndefined()
  })
})
