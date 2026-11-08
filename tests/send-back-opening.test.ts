/**
 * D382, D291, D335: a worker's send-back re-run opens on the worker line
 * the instruction block names, then the reason, then the trail. The
 * openings are read out of the block as install writes it (the same
 * reading the charter's outline binding does in
 * tests/journal/steps/journal-agent-surface.steps.ts), so a reword of
 * either side fails here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { openNodeSqlite } from '../src/persistence/node-sqlite.js'
import { FlatStore } from '../src/flat-store.js'
import { INSTRUCTIONS_CONTENT } from '../src/server/installer.js'
import { registerSelf, registerSubagent, type GitSelf } from '../src/persistence/session-registry.js'
import { registerSubagentLeg, type LegRef } from '../src/persistence/leg-registry.js'
import { composeSendBackMessage, composeFirstMessage, sendBackReason, type FirstMomentFacts } from '../src/first-moment.js'
import { hooksSendBackMessage } from '../src/hooks/subagent-stop.js'

let tmpDir: string
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'tc-sbo-')) })
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }) })

const MAIN: GitSelf = { worktree: null, branch: 'main', cwd: '/repo', toplevel: '/repo', commonDir: '/repo/.git' }

/** The quoted openings the block's worker line names. */
function blockOpenings(block: string): string[] {
  const line = block.split('\n').filter((l) => /first message opens with "?treecontext/i.test(l) && /\bworker\b/.test(l))
  expect(line.length, 'the block has no single worker line').toBe(1)
  return [...line[0]!.matchAll(/"(treecontext: [^"]+)"/g)].map((m) => m[1]!)
}
/** An opening as a pattern on a message's start; its `…` is the role. */
function openingPattern(opening: string): RegExp {
  return new RegExp(`^${opening.split('…').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(\\S+)')}`)
}
const opensWithBlockOpening = (message: string): boolean => blockOpenings(INSTRUCTIONS_CONTENT).some((o) => openingPattern(o).test(message))

async function legFacts(): Promise<{ s: FlatStore; facts: FirstMomentFacts; ref: LegRef }> {
  const path = join(tmpDir, 'sbo.db')
  const s = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(path)), retentionInterval: 1_000_000 })
  const db = new DatabaseSync(path)
  const ref: LegRef = { sessionId: 's1', agentId: 'a-builder' }
  try {
    registerSelf(db, 's1', MAIN, 100)
    registerSubagent(db, 's1', ref.agentId, 'builder', MAIN, 200)
    registerSubagentLeg(db, { sessionId: 's1', agentId: ref.agentId, role: 'builder' }, { run: 'r1', key: 'login-form', keySrc: 'inferred', checkpointer: 'builder' }, { at: 200 })
  } finally { db.close() }
  const facts = s.firstMomentFacts({ run: 'r1', key: 'login-form', role: 'builder', checkpointer: 'builder', checkpointedBy: null, self: ref })
  return { s, facts, ref }
}

describe('the send-back re-run opens with the worker line (D382)', () => {
  it('the ticket door\'s message opens with one of the block\'s openings, then the reason', async () => {
    const { s, facts } = await legFacts()
    await s.close()
    const message = composeSendBackMessage({ facts, prompt: 'go', sessionId: 's1', firstMomentId: null, rows: 2 })
    expect(blockOpenings(INSTRUCTIONS_CONTENT).length, 'the block names no openings').toBeGreaterThan(1)
    expect(opensWithBlockOpening(message), message.split('\n')[0]).toBe(true)
    expect(message.indexOf(sendBackReason('builder', 'r1', 'login-form'))).toBeGreaterThan(message.indexOf('go'))
    // The outline's reader is live: the reason alone is no opening.
    expect(opensWithBlockOpening(sendBackReason('builder', 'r1', 'login-form'))).toBe(false)
  })

  it('a `claude -p` worker\'s stop hook composes the same, so its re-run opens with a block opening', async () => {
    const { s, facts } = await legFacts()
    await s.close()
    const message = composeSendBackMessage({
      facts, prompt: 'go', sessionId: 's1', firstMomentId: null, rows: 0, firstMessage: composeFirstMessage(facts, 'go', {}),
    })
    expect(opensWithBlockOpening(message), message.split('\n')[0]).toBe(true)
  })

  it('the hooks door\'s message opens with its own first moment\'s line, then the reason', async () => {
    const { s, facts, ref } = await legFacts()
    await s.close()
    const message = hooksSendBackMessage({ facts, ref, firstMomentId: null, rows: 1 })
    const firstLine = composeFirstMessage(facts, null, { door: 'hooks', keyOwn: true }).split('\n')[0]!
    // A hooks-door leg is not a worker of the ticket door: its line is the
    // leg's (D382's road not taken), but the reason never leads.
    expect(message.startsWith(firstLine.slice(0, 60)), message.split('\n')[0]).toBe(true)
    expect(message.indexOf(sendBackReason('builder', 'r1', 'login-form'))).toBeGreaterThan(0)
  })
})
