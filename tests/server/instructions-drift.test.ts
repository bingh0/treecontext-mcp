/**
 * TRIGGER_CORE protocol conformance + BRIEF golden pin.
 */
import { describe, it, expect } from 'vitest'
import {
  INSTRUCTIONS_BRIEF_LEXICAL, INSTRUCTIONS_WORKER_LEXICAL, TRIGGER_CORE,
  SKILL_REFERENCE_BODY, resolveInstructions,
} from '../../src/server/instructions.js'
import {
  SESSION_REMINDER_TEXT, INSTRUCTIONS_CONTENT,
} from '../../src/server/installer.js'

/**
 * AC2.1 golden pin, retargeted at the deletion phase (2026-07-25) and
 * re-pinned 2026-10-08 when D174 added the checkpoint protocol (and
 * again that day when the handoff step named the label, D218; and
 * 2026-10-11 when step 2 said what it recovers, D264; and 2026-11-03
 * when the handoff step named the file's path, the import tool refusing
 * a label beside a path; and 2026-11-08 when the routine gained the one
 * line a worker of a run skips it by, D382): the
 * served instruction set is INSTRUCTIONS_BRIEF_LEXICAL — brief by the
 * t10 activation evidence (verbose SUPPRESSED activation and blew the
 * 2KB cap). Changing these bytes is a deliberate act: update this pin
 * and the charter's agent-surface expectations together.
 */
const GOLDEN_LEXICAL: string = [
  'SESSION START — do this BEFORE any other work:',
  '1. treecontext_status — check resume_pointers ("newest N of M" means',
  '   stale pointers need supersession cleanup).',
  '   Fetch each resume pointer via treecontext_export(node_id).',
  '2. treecontext_query("what was I working on, what was the next step") recovers the thread around the resume pointers status found.',
  'Only then respond to the user.',
  'Skip this if your first message opens with treecontext naming you a worker.',
  '',
  'Hooks capture a session on Claude Code, and on Codex CLI or Antigravity',
  'CLI where their hooks are installed and running; elsewhere only what you',
  'insert is kept. Insert the *why*: decisions, plans, rejected alternatives,',
  'constraints, findings. Attach a file as a node with media_ref (uri,',
  'mime_type) and a text description.',
  '',
  'Hits return a bounded preview ending in an availability marker -',
  'treecontext_export(node_id) fetches the whole thing. "[capture gap]"',
  'entries mark journal holes - trust them over assuming completeness.',
  '',
  'CHECKPOINTS come in two kinds:',
  '- Bookmark: when the stop hook asks, insert a short "where I am, next"',
  '  note with metadata.kind="bookmark".',
  '- Chapter summary: when the developer says "checkpoint", insert a curated',
  '  summary with metadata.next_session=true and supersedes: [the previous',
  '  chapter\'s id]. Then suggest that this is a good moment to /clear.',
  'After a /clear, your first reply opens with the re-orientation packet you',
  'received at session start, shown to the developer as is, in order:',
  'chapter, bookmark, recent developer turns.',
  'Handoff: export the chapter summaries to a file in the repository and',
  'commit it; the teammate pulls and imports it with treecontext_import',
  'and the file\'s path.',
  'When capture or recall looks wrong, run `treecontext doctor` before',
  'anything else.',
  'Long form: load the treecontext-reference skill on demand.',
  '',
  'Tag other plans with metadata.next_session=true; pass supersedes:',
  '[old_node_ids] when one replaces another. treecontext_query takes',
  'time_range and sort_by. Don\'t put project facts in global auto-memory.',
].join('\n')

/**
 * Every always-on instruction channel. Step 3 of the spec adds the
 * treecontext-reference skill body here when it states the protocol.
 */
const CHANNELS: Record<string, string> = {
  INSTRUCTIONS_BRIEF_LEXICAL,
  SESSION_REMINDER_TEXT,
  INSTRUCTIONS_CONTENT,
  SKILL_REFERENCE_BODY,
}

describe('TRIGGER_CORE protocol conformance (AC2.2)', () => {
  const protocolTools: readonly string[] = TRIGGER_CORE.steps

  it('protocol shape is the pre-registered one', () => {
    expect(protocolTools).toEqual([
      'treecontext_status',
      'treecontext_export',
      'treecontext_query',
    ])
  })

  for (const [name, text] of Object.entries(CHANNELS)) {
    it(`${name} states the protocol tools in canonical order before any other tool`, () => {
      const mentions = [...text.matchAll(/treecontext_\w+/g)].map(m => m[0])
      const firstDistinct: string[] = []
      for (const m of mentions) {
        if (!firstDistinct.includes(m)) firstDistinct.push(m)
      }
      expect(firstDistinct.slice(0, protocolTools.length)).toEqual([...protocolTools])
    })

    it(`${name} contains the "${TRIGGER_CORE.gate}" gate`, () => {
      expect(text.toLowerCase()).toContain(TRIGGER_CORE.gate.toLowerCase())
    })
  }
})

/**
 * The checkpoint protocol (D174) is taught on every channel that teaches
 * the session-start protocol and is written by install as a whole block:
 * the handshake, the AGENTS.md block, and the reference skill. The
 * session-start hook reminder is excluded on purpose — on a /clear its
 * channel carries the re-orientation packet instead (journal-reorientation).
 * The vocabulary is pinned, not the wording: the same word writes a
 * chapter, the same metadata marks a bookmark, and every channel names the
 * /clear, handoff and doctor moves.
 */
describe('checkpoint protocol conformance (D174)', () => {
  const CHECKPOINT_CHANNELS: Record<string, string> = {
    INSTRUCTIONS_BRIEF_LEXICAL, INSTRUCTIONS_CONTENT, SKILL_REFERENCE_BODY,
  }
  const flat = (t: string): string => t.replace(/\s+/g, ' ')
  for (const [name, text] of Object.entries(CHECKPOINT_CHANNELS)) {
    it(`${name} teaches the same checkpoint protocol`, () => {
      const f = flat(text)
      expect(f).toContain('when the developer says "checkpoint"')
      expect(f).toMatch(/metadata\.kind ?= ?"bookmark"/)
      expect(f).toMatch(/metadata\.next_session ?= ?true/)
      expect(f).toMatch(/good moment to \/clear/)
      expect(f).toMatch(/re-orientation packet/)
      expect(f).toMatch(/as is, in order/)
      expect(f).toMatch(/file in the repository/)
      expect(f).toContain('treecontext_import')
      expect(f).toMatch(/run `treecontext doctor` before anything else/)
    })
  }

  it('the handshake stays a card: under 2500 characters (D210)', () => {
    expect(INSTRUCTIONS_BRIEF_LEXICAL.length).toBeLessThan(2500)
    expect(INSTRUCTIONS_BRIEF_LEXICAL).toContain('treecontext-reference skill')
  })
})

describe('served-instructions golden pin (AC2.1)', () => {
  it('is byte-identical to the pinned lexical instruction set', () => {
    expect(INSTRUCTIONS_BRIEF_LEXICAL).toBe(GOLDEN_LEXICAL)
  })

  // D382: a ticket-door worker's card. Its own head in place of the
  // routine, then the ordinary card's body byte for byte ("the rest of the
  // card is unchanged").
  it('the worker card is its own head over the ordinary body, byte for byte', () => {
    const lines = GOLDEN_LEXICAL.split('\n')
    const body = lines.slice(lines.indexOf('')).join('\n')
    expect(INSTRUCTIONS_WORKER_LEXICAL).toBe([
      'WORKER START — treecontext\'s ticket door started you as a worker of a run.',
      'Your first message holds your brief and the checkpoint(s) in effect (or',
      'says there are none, or that your instructions were invalid): begin there.',
    ].join('\n') + '\n' + body)
    expect(INSTRUCTIONS_WORKER_LEXICAL).not.toContain('SESSION START')
    for (const tool of ['treecontext_status', 'what was I working on', TRIGGER_CORE.gate]) {
      expect(GOLDEN_LEXICAL, `the needle ${tool} is dead`).toContain(tool)
      expect(INSTRUCTIONS_WORKER_LEXICAL).not.toContain(tool)
    }
  })
})

describe('resolveInstructions variant selector (AC5.1)', () => {
  it('serves the lexical set for brief and verbose; none stays empty', () => {
    expect(resolveInstructions('brief')).toBe(INSTRUCTIONS_BRIEF_LEXICAL)
    // 'verbose' left the accepted variant type at the D4 corpus audit, so
    // the cast is the claim: a retired variant that still reaches the
    // resolver at runtime must fall back to the lexical set, never to ''.
    const retiredVerbose = 'verbose' as unknown as Parameters<typeof resolveInstructions>[0]
    expect(resolveInstructions(retiredVerbose)).toBe(INSTRUCTIONS_BRIEF_LEXICAL)
    expect(resolveInstructions('none')).toBe('')
  })

  it('serves the worker card only when told the worker is trusted (D382)', () => {
    expect(resolveInstructions('brief', { worker: true })).toBe(INSTRUCTIONS_WORKER_LEXICAL)
    expect(resolveInstructions('brief', { worker: false })).toBe(INSTRUCTIONS_BRIEF_LEXICAL)
    expect(resolveInstructions('none', { worker: true })).toBe('')
  })
})

describe('size budgets (AC2.3)', () => {
  it('the served set fits the Claude Code 2KB instruction cap', () => {
    expect(Buffer.byteLength(INSTRUCTIONS_BRIEF_LEXICAL, 'utf8')).toBeLessThanOrEqual(2048)
  })

  it('the worker card fits the same cap and stays a card (D382, D210)', () => {
    expect(Buffer.byteLength(INSTRUCTIONS_WORKER_LEXICAL, 'utf8')).toBeLessThanOrEqual(2048)
    expect(INSTRUCTIONS_WORKER_LEXICAL.length).toBeLessThan(2500)
  })

  it('first 512 chars are self-contained (Codex constraint)', () => {
    const head = INSTRUCTIONS_BRIEF_LEXICAL.slice(0, 512)
    expect(head).toContain('treecontext_status')
    expect(head).toContain('treecontext_query')
  })
})
