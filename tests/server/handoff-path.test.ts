/**
 * The tool door's path rule (D199; features/journal-handoff.feature, "an
 * export path outside the project is refused"): a handoff file is read or
 * written only inside the project directory the server was started for.
 * The charter scenario binds the `..` climb; this file binds the symbolic
 * link escapes the rule also closes, through the real tools over a real
 * directory tree, inspecting the disk afterwards.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import BetterSqlite3 from 'better-sqlite3'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { createServer } from '../../src/server/server.js'
import { SECRETS_WARNING, resolveProjectPath } from '../../src/handoff.js'

let dir: string
let project: string
let outside: string
beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-handoff-path-')))
  project = join(dir, 'project')
  outside = join(dir, 'outside')
  mkdirSync(project)
  mkdirSync(outside)
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

type Res = { isError?: boolean; content: Array<{ text: string }> }

async function harness(): Promise<{ client: Client; close: () => Promise<void> }> {
  const store = await FlatStore.open({ database: wrapBetterSqlite(new BetterSqlite3(join(dir, 'store.db'))), ownsDatabase: true })
  await store.insert('plan: wire the login form; next: write its tests', { metadata: { next_session: true } })
  const server = createServer(store, { projectDir: project })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 't', version: '0' })
  await server.connect(st); await client.connect(ct)
  return { client, close: async () => { await client.close(); await server.close(); await store.close() } }
}

const exportTo = async (c: Client, path: string): Promise<Res> =>
  await c.callTool({ name: 'treecontext_export', arguments: { path } }) as Res

const refusedNamingProject = (r: Res, verb: 'written' | 'read' = 'written'): void => {
  expect(r.isError).toBe(true)
  const body = JSON.parse(r.content[0]!.text) as { error: string; project_dir: string }
  expect(body.project_dir).toBe(project)
  expect(body.error).toContain(`A handoff may be ${verb} only inside the project directory, ${project}`)
  expect(body.error).toContain(`Nothing was ${verb}.`)
}

describe('the export path rule', () => {
  it('writes a plain path inside the project, creating its directories', async () => {
    const h = await harness()
    const r = await exportTo(h.client, 'handoffs/a/b.json')
    expect(r.isError).toBeFalsy()
    expect(existsSync(join(project, 'handoffs/a/b.json'))).toBe(true)
    await h.close()
  })

  it('refuses a directory link that leads out of the project, and writes nothing there', async () => {
    symlinkSync(outside, join(project, 'handoffs'))
    const h = await harness()
    refusedNamingProject(await exportTo(h.client, 'handoffs/login-plan.json'))
    expect(readdirSync(outside)).toEqual([])
    await h.close()
  })

  it('refuses a file that is itself a link, even one pointing outside', async () => {
    const target = join(outside, 'authorized_keys')
    writeFileSync(target, 'ssh-ed25519 AAAA… original\n')
    mkdirSync(join(project, 'handoffs'))
    symlinkSync(target, join(project, 'handoffs', 'login-plan.json'))
    const h = await harness()
    refusedNamingProject(await exportTo(h.client, 'handoffs/login-plan.json'))
    expect(readdirSync(outside)).toEqual(['authorized_keys'])
    expect(readFileSync(target, 'utf8')).toBe('ssh-ed25519 AAAA… original\n')
    await h.close()
  })

  it('refuses a file that is a link even when it points inside the project (D232)', async () => {
    mkdirSync(join(project, 'handoffs'))
    writeFileSync(join(project, 'notes.json'), 'mine\n')
    symlinkSync(join(project, 'notes.json'), join(project, 'handoffs', 'login-plan.json'))
    const h = await harness()
    const r = await exportTo(h.client, 'handoffs/login-plan.json')
    refusedNamingProject(r)
    expect(r.content[0]!.text).toContain('is a symbolic link')
    expect(readFileSync(join(project, 'notes.json'), 'utf8')).toBe('mine\n')
    await h.close()
  })

  it('refuses an absolute path outside and the project directory itself', async () => {
    const h = await harness()
    refusedNamingProject(await exportTo(h.client, join(outside, 'x.json')))
    refusedNamingProject(await exportTo(h.client, '.'))
    refusedNamingProject(await exportTo(h.client, 'handoffs/../../outside/x.json'))
    expect(readdirSync(outside)).toEqual([])
    await h.close()
  })

  it('accepts an absolute path that lies inside', () => {
    const r = resolveProjectPath(project, join(project, 'handoffs', 'x.json'), 'write')
    expect(r).toMatchObject({ ok: true, rel: 'handoffs/x.json' })
  })
})

describe('what is already in the project (D234)', () => {
  it('never overwrites a project file that is not a handoff', async () => {
    writeFileSync(join(project, 'package.json'), '{"name":"app"}\n')
    const h = await harness()
    const r = await exportTo(h.client, 'package.json')
    refusedNamingProject(r)
    expect(r.content[0]!.text).toContain('already exists and is not a treecontext handoff file')
    expect(readFileSync(join(project, 'package.json'), 'utf8')).toBe('{"name":"app"}\n')
    await h.close()
  })

  it('refuses the .git directory, existing hook or not', async () => {
    mkdirSync(join(project, '.git', 'hooks'), { recursive: true })
    writeFileSync(join(project, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n')
    const h = await harness()
    for (const path of ['.git/hooks/pre-commit', '.git/hooks/post-merge', '.git/handoff.json']) {
      const r = await exportTo(h.client, path)
      refusedNamingProject(r)
      expect(r.content[0]!.text).toContain("inside the repository's .git directory")
    }
    expect(readFileSync(join(project, '.git', 'hooks', 'pre-commit'), 'utf8')).toBe('#!/bin/sh\nexit 0\n')
    expect(readdirSync(join(project, '.git', 'hooks'))).toEqual(['pre-commit'])
    expect(readdirSync(join(project, '.git')).sort()).toEqual(['hooks'])
    await h.close()
  })

  it('replaces an older handoff at the same path', async () => {
    const h = await harness()
    expect((await exportTo(h.client, 'handoffs/login-plan.json')).isError).toBeFalsy()
    writeFileSync(join(project, 'handoffs/login-plan.json'),
      JSON.stringify({ exported_by: 'a@host', form: 'summaries', nodes: [] }, null, 2))
    const r = await exportTo(h.client, 'handoffs/login-plan.json')
    expect(r.isError, r.content[0]!.text).toBeFalsy()
    expect((JSON.parse(readFileSync(join(project, 'handoffs/login-plan.json'), 'utf8')) as { nodes: unknown[] }).nodes).toHaveLength(1)
    await h.close()
  })

  it('a dangling directory link and a path through a file meet the structured refusal', async () => {
    symlinkSync(join(dir, 'gone'), join(project, 'dangling'))
    writeFileSync(join(project, 'README'), 'readme\n')
    const h = await harness()
    for (const path of ['dangling/x.json', 'README/x.json']) {
      const r = await exportTo(h.client, path)
      refusedNamingProject(r)
      expect(r.content[0]!.text).toContain('does not lead to a directory inside the project')
    }
    expect(existsSync(join(dir, 'gone'))).toBe(false)
    await h.close()
  })
})

describe('the import path rule', () => {
  it('a project file that is not JSON is "not a handoff file", and nothing of it is echoed', async () => {
    writeFileSync(join(project, '.env'), 'API_KEY=sk-live-0123456789abcdef\nDB_PASSWORD=hunter2\n')
    const h = await harness()
    const r = await h.client.callTool({ name: 'treecontext_import', arguments: { path: '.env' } }) as Res
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.content[0]!.text)).toEqual({ error: '.env is not a handoff file' })
    await h.close()
  })

  it('refuses to read a file outside the project, through a link or a climb, and lands nothing', async () => {
    writeFileSync(join(outside, 'secret.json'), JSON.stringify({ nodes: [{ content: 'a secret' }] }))
    symlinkSync(join(outside, 'secret.json'), join(project, 'pulled.json'))
    const h = await harness()
    for (const path of ['pulled.json', '../outside/secret.json']) {
      const r = await h.client.callTool({ name: 'treecontext_import', arguments: { path } }) as Res
      refusedNamingProject(r, 'read')
    }
    const raw = new BetterSqlite3(join(dir, 'store.db'), { readonly: true })
    expect((raw.prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number }).n).toBe(1)
    raw.close()
    await h.close()
  })

  it('a file read by path carries no cap, past the 10000 entries of the pasted door (D170)', async () => {
    const nodes = Array.from({ length: 10_001 }, (_, i) => ({ nodeId: `n${i}`, content: `teammate entry ${i}`, createdAt: 1_700_000_000 + i }))
    writeFileSync(join(project, 'big.json'), JSON.stringify({ exported_by: 'a@host', nodes }))
    const h = await harness()
    const r = await h.client.callTool({ name: 'treecontext_import', arguments: { path: 'big.json' } }) as Res
    expect(r.isError, r.content[0]!.text).toBeFalsy()
    expect((JSON.parse(r.content[0]!.text) as { landed: number }).landed).toBe(10_001)
    await h.close()
  })

  it('refuses path together with pasted data', async () => {
    const h = await harness()
    const r = await h.client.callTool({ name: 'treecontext_import', arguments: { path: 'x.json', data: '{"nodes":[]}', label: 'x' } }) as Res
    expect(r.isError).toBe(true)
    await h.close()
  })
})

describe('the secrets warning (D177)', () => {
  it('says exactly this', () => {
    expect(SECRETS_WARNING).toBe('Captured tool output can hold secrets, tokens and keys: a whole-journal handoff carries every '
      + 'command output and file read this journal captured, to everyone who can read the file. '
      + 'Read it before you commit it.')
  })
})
