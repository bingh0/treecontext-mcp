import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { echoIndexBoundary, echoToolOf, isTreecontextEcho, stampEchoBoundaries } from '../../src/persistence/echo-index.js'
import { isInsertEchoTool, isStatusEchoTool } from '../../src/server/echo-correlation.js'
import { indexTextFor } from '../../src/persistence/index-text.js'
import { openNodeSqlite, setPragma } from '../../src/persistence/node-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { ftsNodeIds, ftsVocab, rawEchoes } from '../helpers/echo-capture.js'
import { IngestionLoop } from '../../src/server/ingestion.js'

const T = (tool: string): string => `mcp__treecontext__${tool}`
const echo = (tool: string, input: string, output: string, label?: string): string =>
  `Tool: ${T(tool)}\n${label ? `Label: ${label}\n` : ''}Input:\n${input}\nOutput:\n${output}`

describe('echoIndexBoundary (D261)', () => {
  it('ends a delete, merge, clear or unknown tool echo at its Input section', () => {
    for (const tool of ['treecontext_delete', 'treecontext_merge_from_agent', 'treecontext_clear', 'treecontext_future']) {
      const c = echo(tool, '{"query":"alpha"}', '{"results":["beta"]}')
      expect(c.slice(0, echoIndexBoundary(T(tool), c)!)).toBe(`Tool: ${T(tool)}\nInput:\n{"query":"alpha"}`)
    }
  })

  it('ends a query, insert, export or status echo at its first line', () => {
    for (const tool of ['treecontext_query', 'treecontext_insert', 'treecontext_export', 'treecontext_status']) {
      const c = echo(tool, '{"content":"the note"}', '{"node_id":"x"}')
      expect(c.slice(0, echoIndexBoundary(T(tool), c)!)).toBe(`Tool: ${T(tool)}`)
    }
  })

  it('ends an import echo at its Label line, or at its first line when it has none', () => {
    const labelled = echo('treecontext_import', '{"data":"handoff"}', '{}', 'handoffs/a.json')
    expect(labelled.slice(0, echoIndexBoundary(T('treecontext_import'), labelled)!)).toBe(`Tool: ${T('treecontext_import')}\nLabel: handoffs/a.json`)
    const old = echo('treecontext_import', '{"data":"handoff"}', '{}')
    expect(old.slice(0, echoIndexBoundary(T('treecontext_import'), old)!)).toBe(`Tool: ${T('treecontext_import')}`)
  })

  it('falls back to the full-tail separator, then the whole content, when there is no Output', () => {
    const tailed = `Tool: ${T('treecontext_delete')}\nInput:\n{"q":1}...\n--- FULL ---\nInput:\n{"q":1,"more":2}\n`
    expect(echoIndexBoundary(T('treecontext_delete'), tailed)).toBe(tailed.indexOf('\n--- FULL ---\n'))
    const bare = `Tool: ${T('treecontext_delete')}\nInput:\n{"q":1}`
    expect(echoIndexBoundary(T('treecontext_delete'), bare)).toBe(bare.length)
  })

  it('is null for anything that is not a treecontext echo', () => {
    expect(echoIndexBoundary('Bash', 'Tool: Bash\nInput:\n{}\nOutput:\nx')).toBeNull()
    expect(echoIndexBoundary(undefined, 'x')).toBeNull()
    expect(isTreecontextEcho('treecontext_query')).toBe(false)
    expect(isTreecontextEcho('mcp__treecontext__')).toBe(false)
  })

  it('recognizes an echo by its suffix under any server key, as the echo heals do', () => {
    expect(echoToolOf('mcp__treecontext__treecontext_query')).toBe('treecontext_query')
    expect(echoToolOf('mcp__journal__treecontext_merge_from_agent')).toBe('treecontext_merge_from_agent')
    const c = echo('treecontext_status', '{}', '{"namespace":"project"}').replace(T('treecontext_status'), 'mcp__renamed__treecontext_status')
    expect(echoIndexBoundary('mcp__renamed__treecontext_status', c)).toBe(c.indexOf('\n'))
    expect(isInsertEchoTool('mcp__renamed__treecontext_insert')).toBe(true)
    expect(isStatusEchoTool('mcp__renamed__treecontext_status')).toBe(true)
    expect(isInsertEchoTool('mcp__renamed__treecontext_status')).toBe(false)
  })
})

describe('stampEchoBoundaries (D261)', () => {
  const content = echo('treecontext_delete', '{"node_id":"alpha"}', '{"deleted":"beta"}')
  const base = { source: 'auto-capture', role: 'assistant', tool_name: T('treecontext_delete') }
  const argsEnd = content.indexOf('\nOutput:')

  it('stamps the arguments boundary and a whole-content display boundary on a fitting echo', () => {
    const m = stampEchoBoundaries(content, { ...base })!
    expect(m['_index_len']).toBe(argsEnd)
    expect(m['_preview_len']).toBe(content.length)
    expect(indexTextFor(content, m)).not.toContain('beta')
  })

  it('keeps a stamped display boundary, else takes the old index boundary (pre-018 shape)', () => {
    expect(stampEchoBoundaries(content, { ...base, _index_len: 8000, _preview_len: 50 })!['_preview_len']).toBe(50)
    expect(stampEchoBoundaries(content, { ...base, _index_len: 60 })!['_preview_len']).toBe(60)
  })

  it('never widens an index boundary already narrower than the arguments', () => {
    expect(stampEchoBoundaries(content, { ...base, _index_len: 5 })!['_index_len']).toBe(5)
  })

  it('is idempotent', () => {
    const once = stampEchoBoundaries(content, { ...base })
    expect(stampEchoBoundaries(content, once)).toEqual(once)
  })

  it('leaves curated rows, ordinary tool rows and absent metadata untouched', () => {
    const curated = { tool_name: T('treecontext_delete') }
    expect(stampEchoBoundaries(content, curated)).toBe(curated)
    const bash = { source: 'auto-capture', role: 'assistant', tool_name: 'Bash' }
    expect(stampEchoBoundaries(content, bash)).toBe(bash)
    expect(stampEchoBoundaries(content, null)).toBeNull()
  })
})

describe('migration 028 (D261)', () => {
  it('re-stamps and re-indexes stored echoes, and replays as a no-op', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-m028-'))
    try {
      const path = join(dir, 's.db')
      const open = (): Promise<FlatStore> => FlatStore.open({ database: openNodeSqlite(new DatabaseSync(path)), ownsDatabase: true })
      let store = await open()
      // Beta.1 shapes: an overflowing echo (both hook boundaries) and a fitting one (none).
      const tail = 'x'.repeat(50)
      const long = `${content2('alpha')}${tail}\n--- FULL ---\nOutput:\n["beta-full"] gammaword`
      await store.insert(long, { metadata: { source: 'auto-capture', role: 'assistant', tool_name: T('treecontext_query'), _index_len: long.length, _preview_len: content2('alpha').length } })
      const fit = echo('treecontext_insert', '{"content":"deltaword"}', '{"node_id":"n"}')
      await store.insert(fit, { metadata: { source: 'auto-capture', role: 'assistant', tool_name: T('treecontext_insert') } })
      expect(ftsNodeIds(path, 'gammaword')).toHaveLength(1)
      expect(ftsNodeIds(path, 'deltaword')).toHaveLength(1)
      await store.close()
      const rewind = (): void => { const raw = new DatabaseSync(path); setPragma(raw, 'user_version = 27'); raw.close() }
      rewind()
      store = await open()
      expect(ftsNodeIds(path, 'gammaword')).toEqual([])
      expect(ftsNodeIds(path, 'deltaword')).toEqual([])
      expect(ftsNodeIds(path, 'alpha')).toEqual([]) // the query's own words leave the index too
      expect(ftsNodeIds(path, 'treecontext_query')).toHaveLength(1)
      const first = rawEchoes(path)
      const vocab = ftsVocab(path)
      await store.close()
      rewind() // marker rollback: the migration runs again over stamped rows
      store = await open()
      expect(rawEchoes(path)).toEqual(first)
      expect(ftsVocab(path)).toEqual(vocab)
      await store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the echo heal (D265: echoes a still-running beta.1 server drains after the upgrade)', () => {
  it('re-stamps and re-indexes them at start and in the sweep, leaves handoff lanes and content alone, and is idempotent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-echo-heal-'))
    try {
      const path = join(dir, 's.db')
      const store = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(path)), ownsDatabase: true })
      // The beta.1 drain's way: an echo inserted with no D261 stamp, into a
      // store already at this build's head (migration 028 has run).
      const beta1 = (word: string, session = 'cc-old'): Promise<{ nodeId: string }> => {
        const c = echo('treecontext_query', `{"query":"${word}"}`, `{"results":["${word}result"]}`)
        return store.insert(c, { metadata: { source: 'auto-capture', role: 'assistant', tool_name: T('treecontext_query'), session_id: session } })
      }
      const first = await beta1('alphaword')
      const lane = await beta1('laneword', 'handoff:cc-teammate')
      const contentBefore = rawEchoes(path).map((e) => e.content)
      expect(ftsNodeIds(path, 'alphawordresult')).toEqual([first.nodeId])
      expect(ftsNodeIds(path, 'alphaword')).toEqual([first.nodeId])
      expect(ftsNodeIds(path, 'lanewordresult')).toEqual([lane.nodeId])

      const loop = new IngestionLoop(store, { intervalMs: 3_600_000, sweepIntervalMs: 3_600_000 })
      loop.start() // the start-up pass
      loop.stop()
      expect(ftsNodeIds(path, 'alphawordresult')).toEqual([]) // its results left the index
      expect(ftsNodeIds(path, 'alphaword')).toEqual([])
      expect(ftsNodeIds(path, 'treecontext_query')).toContain(first.nodeId) // found by its tool name
      expect(ftsNodeIds(path, 'lanewordresult')).toEqual([lane.nodeId]) // a handoff lane is not the heal's
      const healed = rawEchoes(path).find((e) => e.nodeId === first.nodeId)!
      const c = healed.content
      expect(healed.metadata['_index_len']).toBe(c.indexOf('\n'))
      expect(rawEchoes(path).map((e) => e.content)).toEqual(contentBefore) // content never touched

      // One drained after start: the sweep heals it.
      const later = await beta1('betaword')
      expect(ftsNodeIds(path, 'betawordresult')).toEqual([later.nodeId])
      const sweeper = new IngestionLoop(store)
      await sweeper.runSweep()
      expect(ftsNodeIds(path, 'betawordresult')).toEqual([])

      // Idempotent: another full pass changes nothing.
      const rows = rawEchoes(path)
      const vocab = ftsVocab(path)
      expect(new IngestionLoop(store).healEchoes()).toBe(0)
      expect(rawEchoes(path)).toEqual(rows)
      expect(ftsVocab(path)).toEqual(vocab)
      await store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('demoting an overflowing query echo (D261)', () => {
  it('shrinks it to its display preview, Output kept, index boundary unmoved, no result-word posting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-echo-demote-'))
    try {
      const path = join(dir, 's.db')
      const store = await FlatStore.open({
        database: openNodeSqlite(new DatabaseSync(path)), ownsDatabase: true,
        maxStoreBytes: 1, maxSessions: 1_000_000, maxAutoEntries: 1_000_000, retentionInterval: 1_000_000,
      })
      // The hook's composition of an overflowing query echo: preview, then the full tail.
      const preview = echo('treecontext_query', '{"query":"alpha"}', '{"results":[{"content":"resultword beta"}]...')
      const content = `${preview}\n--- FULL ---\nInput:\n{"query":"alpha"}\nOutput:\n{"results":[{"content":"resultword beta ${'gamma '.repeat(300)}"}]}`
      const meta = stampEchoBoundaries(content, { source: 'auto-capture', role: 'assistant', tool_name: T('treecontext_query'), _index_len: 8000, _preview_len: preview.length })!
      const { nodeId } = await store.insert(content, { metadata: meta })
      await store.insert('control note: resultword lives here', { metadata: { type: 'finding' } })
      expect(store.retentionSweep().demoted).toBe(1)
      const [after] = rawEchoes(path)
      expect(after!.nodeId).toBe(nodeId)
      expect(after!.content).toBe(preview)
      expect(after!.content).toContain('\nOutput:\n')
      expect(after!.metadata['_index_len']).toBe(content.indexOf('\n'))
      expect(ftsNodeIds(path, 'treecontext_query')).toContain(nodeId)
      const hits = ftsNodeIds(path, 'resultword')
      expect(hits).toHaveLength(1) // the control note's, never the stump's
      expect(hits).not.toContain(nodeId)
      await store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

function content2(q: string): string {
  return echo('treecontext_query', `{"query":"${q}"}`, '["beta"]')
}
