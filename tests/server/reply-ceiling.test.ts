/**
 * D287: the reply ceiling. A query reply over the ceiling has its entries
 * cut, each cut entry saying so; an export over it is refused, never cut.
 * The unit here drives the pure functions with a small ceiling; the charter
 * scenario in journal-recall drives the real tools at the served ceiling.
 */
import { describe, expect, it } from 'vitest'
import { serializeUnderCeiling, exceedsCeiling, exportOverCeilingMessage, REPLY_CEILING_BYTES } from '../../src/server/reply-ceiling.js'

const hit = (id: string, content: string, window?: Record<string, unknown>): Record<string, unknown> =>
  ({ nodeId: id, content, summary: '', similarity: 1, metadata: null, ...(window ? { window } : {}) })

describe('reply ceiling (D287)', () => {
  it('returns a reply under the ceiling untouched', () => {
    const response = { results: [hit('a', 'short')] }
    const text = serializeUnderCeiling(response, 10_000)
    expect(JSON.parse(text)).toEqual(response)
    expect(text).not.toContain('_reply_ceiling')
  })

  it('cuts entry contents, window entries included, until the reply fits, and says so', () => {
    const big = 'x'.repeat(50_000)
    const response = {
      results: [
        hit('a', big, { before: [{ nodeId: 'w1', content: big }], after: [], anchor: { nodeId: 'u', content: big } }),
        hit('b', big),
        hit('c', 'small stays whole'),
      ],
    }
    const ceiling = 20_000
    const text = serializeUnderCeiling(response, ceiling)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(ceiling)
    const parsed = JSON.parse(text) as { results: Array<{ nodeId: string; content: string; window?: { before: Array<{ content: string }>; anchor: { content: string } } }>; _reply_ceiling: { ceiling_bytes: number; cut_at: number; cut_entries: number } }
    expect(parsed._reply_ceiling.ceiling_bytes).toBe(ceiling)
    expect(parsed._reply_ceiling.cut_entries).toBe(4) // a, a's window entry, a's anchor, b
    const marker = /…\[cut to fit the reply ceiling; full content 50000 chars via treecontext_export\]$/
    expect(parsed.results[0]!.content).toMatch(marker)
    expect(parsed.results[0]!.content.length).toBeLessThan(big.length)
    expect(parsed.results[0]!.window!.before[0]!.content).toMatch(marker)
    expect(parsed.results[0]!.window!.anchor.content).toMatch(marker)
    expect(parsed.results[1]!.content).toMatch(marker)
    expect(parsed.results[2]!.content).toBe('small stays whole')
    // The response object handed in is not mutated.
    expect((response.results[0]!['content'] as string).length).toBe(50_000)
  })

  it('serves the ceiling at a quarter of the client guard', () => {
    expect(REPLY_CEILING_BYTES).toBe(4 * 1024 * 1024)
    expect(REPLY_CEILING_BYTES * 4).toBe(16 * 1024 * 1024)
  })

  it('names the entry and both sizes when an export is refused', () => {
    expect(exceedsCeiling('x'.repeat(11), 10)).toBe(true)
    expect(exceedsCeiling('x'.repeat(10), 10)).toBe(false)
    const msg = exportOverCeilingMessage('abc', 5_000_001, 4_194_304)
    expect(msg).toContain('entry abc serializes to 5000001 bytes')
    expect(msg).toContain('over the reply ceiling of 4194304 bytes')
    expect(msg).toContain('16 MB')
  })
})
