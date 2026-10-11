/**
 * D270 — composeToolText: a tool event's input or output as its text.
 * The end-to-end proofs are journal-capture.feature @D270 and the two
 * D270 scenarios of tool-event-fidelity.feature; this pins the rule's
 * corners.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import * as shared from '../../src/hooks/shared.js'
import { composeToolText, shieldedPointerOf, main as postToolUseMain } from '../../src/hooks/post-tool-use.js'

describe('composeToolText (D270)', () => {
  it('returns a string unchanged, byte for byte', () => {
    expect(composeToolText('a\\nb\r\n\tc')).toBe('a\\nb\r\n\tc')
  })

  it('writes every field of an object in key order, a string field as its lines after its name', () => {
    expect(composeToolText({ stdout: 'one\r\ntwo\tthree', stderr: '', interrupted: false, isImage: false, code: 0, gone: null }))
      .toBe('stdout:\none\ntwo\tthree\nstderr:\ninterrupted: false\nisImage: false\ncode: 0\ngone: null')
  })

  it('writes a nested object under its dotted path, and an array of scalars in brackets', () => {
    expect(composeToolText({ file: { content: 'x\ny', meta: { lines: 2 } }, filenames: ['a.ts', 'b.ts'], empty: {} }))
      .toBe('file.content:\nx\ny\nfile.meta.lines: 2\nfilenames: [a.ts, b.ts]\nempty: {}')
  })

  it('writes an array of objects element by element under an indexed path', () => {
    expect(composeToolText({ edits: [{ old: 'a', new: 'b' }] })).toBe('edits[0].old:\na\nedits[0].new:\nb')
  })

  it('writes a content-block list as each text verbatim, other blocks as their type and fields', () => {
    const json = '{\n  "node_id": "x"\n}'
    expect(composeToolText([{ type: 'text', text: json }, { type: 'image', mimeType: 'image/png' }]))
      .toBe(`${json}\ntype: image\nmimeType:\nimage/png`)
  })

  it('keeps a text block text byte for byte, then its other fields', () => {
    expect(composeToolText([{ type: 'text', text: 'a\r\nb', annotations: { priority: 1 }, _meta: { k: 'v' } }]))
      .toBe('a\r\nb\nannotations.priority: 1\n_meta.k:\nv')
  })

  it('reads content blocks under a content field, and composes any other array of objects element by element', () => {
    expect(composeToolText({ content: [{ type: 'text', text: 'hello' }], isError: false }))
      .toBe('content:\nhello\nisError: false')
    expect(composeToolText({ items: [{ type: 'text', text: 'x' }] }))
      .toBe('items[0].type:\ntext\nitems[0].text:\nx')
  })

  it('keeps an empty object and scalars visible, and nothing for undefined', () => {
    expect(composeToolText({})).toBe('{}')
    expect(composeToolText([])).toBe('[]')
    expect(composeToolText(null)).toBe('null')
    expect(composeToolText(42)).toBe('42')
    expect(composeToolText(undefined)).toBe('')
  })
})

describe('post-tool-use: a shielded pointer, whatever shape wraps it (D270)', () => {
  afterEach(() => vi.restoreAllMocks())

  const ptr = { shielded: true, file: '/tmp/shield.json', bytes: 777 }
  const shapes: Array<[string, unknown]> = [
    ['the pointer object itself', ptr],
    ['a string holding its JSON', JSON.stringify(ptr)],
    ['a content-block list', [{ type: 'text', text: JSON.stringify(ptr) }]],
    ['a {content: [...]} wrapper', { content: [{ type: 'text', text: JSON.stringify(ptr) }] }],
  ]

  it.each(shapes)('is recognized as %s', (_name, response) => {
    expect(shieldedPointerOf(response)).toEqual({ file: '/tmp/shield.json', bytes: 777 })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-shield-'))
    try {
      const dbPath = path.join(dir, 'treecontext.db')
      const db = new Database(dbPath)
      db.exec(`CREATE TABLE staging (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT,
        tool_name TEXT, timestamp REAL, priority INTEGER DEFAULT 3, processed INTEGER DEFAULT 0, created_at REAL,
        index_len INTEGER, preview_len INTEGER, attempts INTEGER NOT NULL DEFAULT 0)`)
      db.close()
      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)
      vi.spyOn(shared, 'resolveDbPath').mockReturnValue(dbPath)
      vi.spyOn(shared, 'parseHookInput').mockReturnValue({
        session_id: 's', cwd: '/tmp', tool_name: 'mcp__treecontext__treecontext_export', tool_input: { node_id: 'n' },
        tool_response: response,
      })
      postToolUseMain()
      const check = new Database(dbPath)
      const row = check.prepare('SELECT content FROM staging').get() as { content: string }
      check.close()
      expect(row.content).toBe('Tool: mcp__treecontext__treecontext_export\nInput:\nnode_id:\nn\nOutput: [shielded to /tmp/shield.json, 777 bytes]')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is not read into an ordinary payload', () => {
    expect(shieldedPointerOf({ stdout: '"shielded":true' })).toBeNull()
    expect(shieldedPointerOf({ shielded: false, file: '/x' })).toBeNull()
  })
})
