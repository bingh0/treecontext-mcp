import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TS_ROOT } from '../proc.js'
import { tmpdir } from 'node:os'
import { expect } from 'vitest'
import { type Registry } from 'gherkin-node-test/vitest'
import { INSTRUCTIONS_BRIEF_LEXICAL, SKILL_REFERENCE_BODY, SKILL_REFERENCE_NAME, TRIGGER_CORE } from '../../../src/server/instructions.js'
import { SESSION_REMINDER_TEXT, INSTRUCTIONS_CONTENT, MARKER_START, MARKER_END } from '../../../src/server/installer.js'
import { CODEX_APPROVALS_FLOOR } from '../../../src/server/codex-client.js'
import { mintTicket, readTicket, type TicketFields } from '../../../src/ticket.js'
import { sendBackReason } from '../../../src/first-moment.js'
import { type RunWorld, openRunWorld, briefFor, rawRegistration } from '../run-world.js'
import { runWorker, hooksLeg, type WorkerSpec, type Outcome, type StandinRecord } from '../standins.js'
import { DEFAULT_ROLE_WEIGHTS } from '../../../src/persistence/fts.js'
import { DEFAULT_RECENCY_WEIGHT } from '../../../src/server/query-telemetry.js'
import { KEY_LOOKUP_PARAM } from '../../../src/key-lookup.js'
import { mcpOver, openLiveStore, exportNode, mediaOf, rawMediaOf, insertAttachment } from '../world.js'
import { type InstallWorld, tcCli, openInstallWorld, setFakeCodex } from '../install-harness.js'

// ── journal-agent-surface ───────────────────────────────────────────────

/** The retired machinery the lexical backend must never advertise. Named
 *  so the fence reads a needle the step first proves LIVE (a wrong needle
 *  finds nothing and stays green forever) rather than an unfalsifiable
 *  literal spelled inline.
 *
 *  Narrowed 2026-10-08 (D174): the needles used to be the bare words
 *  /checkpoint/ and /summar/, which held while no checkpoint of any kind
 *  existed. D174 put the checkpoint PROTOCOL in the handshake — notes the
 *  agent writes with treecontext_insert, the bookmark and the chapter
 *  summary — so the bare words now name something the backend does have.
 *  What it lacks is the tree era's MACHINERY: the checkpoint tools, the
 *  summarize action, stale summaries. Those are what the needles name now,
 *  and the step also refuses any treecontext_* tool name the live server
 *  does not register. */
const CHECKPOINT_NEEDLE = /treecontext_checkpoint|checkpoint_all|update_summary/i
const SUMMARIZE_NEEDLE = /summariz|stale summar/i

/**
 * The checkpoint protocol the handshake must teach (D174, D188, D173, D179,
 * D210), one named clause each, read off the whitespace-normalised text.
 * Shared by the per-clause steps and the "whole protocol" step, so the
 * card's size bound is asserted over text proven to carry all of it rather
 * than over any short string.
 */
const PROTOCOL_CLAUSES: Record<string, RegExp> = {
  'two kinds of checkpoint': /CHECKPOINTS come in two kinds/,
  'the bookmark the stop hook writes': /Bookmark: when the stop hook asks, insert [^.]*metadata\.kind="bookmark"/,
  "the chapter summary on the developer's word": /Chapter summary: when the developer says "checkpoint", insert a curated summary with metadata\.next_session=true and supersedes: \[the previous chapter's id\]/,
  'the suggestion to clear after a chapter': /supersedes: \[the previous chapter's id\]\. Then suggest that this is a good moment to \/clear\./,
  'the packet first after a clear': /After a \/clear, your first reply opens with the re-orientation packet you received at session start, shown to the developer as is, in order: chapter, bookmark, recent developer turns\./,
  'the handoff steps': /Handoff: export the chapter summaries to a file in the repository and commit it; the teammate pulls and imports it with treecontext_import and the file's path\./,
  'doctor first': /When capture or recall looks wrong, run `treecontext doctor` before anything else\./,
  'the long form': new RegExp(`Long form: load the ${SKILL_REFERENCE_NAME} skill on demand\\.`),
}
const flat = (t: string): string => t.replace(/\s+/g, ' ')
function protocolGaps(text: string): string[] {
  const f = flat(text)
  return Object.entries(PROTOCOL_CLAUSES).filter(([, re]) => !re.test(f)).map(([name]) => name)
}
function clause(w: AgentSurfaceWorld, name: string): void {
  expect(w.instructions, 'no handshake was read').toBeTruthy()
  expect(flat(w.instructions!), `the handshake does not teach ${name}`).toMatch(PROTOCOL_CLAUSES[name]!)
}

/**
 * This wave's world, extending the INSTALL wave's rather than the core one:
 * the AGENTS.md-block scenarios run the real `init` command through
 * `tcCli`, which is the install harness and reads `w.ihome`. The alternative
 * was promoting ihome into the shared World, which would have told every
 * other wave that a redirected install home is part of their vocabulary.
 * The extension says the true thing instead: agent-surface drives the
 * install harness. Since D382 it extends the run waves' world as well: the
 * worker scenarios start a stand-in worker through the real ticket door.
 */
export interface AgentSurfaceWorld extends InstallWorld, RunWorld {
  /** D382: the files install wrote its instruction block into, by client. */
  blockFiles?: Record<string, string>
  /** D382: the block as an agent reads it out of each file. */
  blocks?: Record<string, string>
  /** The live handshake's instruction text, off a real transport. */
  instructions?: string
  /** The four channels that must teach one protocol, keyed by channel name. */
  channelTexts?: Record<string, string>
  /** The reference skill as install wrote it to disk (D264). */
  skillText?: string
}

export const agentSurfaceDefiner = (reg: Registry<AgentSurfaceWorld>): void => {
  // ── every channel teaches the same session-start protocol ────────────
  // Bound 2026-08-01 with the owner's hook-channel ruling. Instructions
  // come off the LIVE handshake (real server, real transport); the other
  // three are the exact bytes install writes to disk (installer.test.ts
  // pins that they land there verbatim). TRIGGER_CORE is the canonical
  // protocol; the unit-level drift test covers the same constants — this
  // binding adds the wire surface and the charter's side-by-side claim.
  reg.define(/^a configured install$/, async (w: AgentSurfaceWorld) => {
    await openLiveStore(w)
    const client = await mcpOver(w)
    w.channelTexts = {
      'handshake instructions': client.getInstructions() ?? '',
      'session-start hook reminder': SESSION_REMINDER_TEXT,
      'AGENTS.md block': INSTRUCTIONS_CONTENT,
      'reference skill': SKILL_REFERENCE_BODY,
    }
  })
  reg.define(/^the handshake instructions, the session-start hook reminder, the AGENTS\.md block, and the reference skill are read side by side$/, (w: AgentSurfaceWorld) => {
    expect(Object.keys(w.channelTexts!)).toHaveLength(4)
    for (const [name, text] of Object.entries(w.channelTexts!)) {
      expect(text.length, `${name} is empty`).toBeGreaterThan(0)
    }
  })
  reg.define(/^each names status, then export, then query, in that order, before any other journal tool$/, (w: AgentSurfaceWorld) => {
    for (const [name, text] of Object.entries(w.channelTexts!)) {
      const mentions = [...text.matchAll(/treecontext_\w+/g)].map((m) => m[0])
      const firstDistinct: string[] = []
      for (const m of mentions) if (!firstDistinct.includes(m)) firstDistinct.push(m)
      expect(firstDistinct.slice(0, TRIGGER_CORE.steps.length), `${name} drifts from the protocol order`).toEqual([...TRIGGER_CORE.steps])
    }
  })
  reg.define(/^each carries the gate phrase making orientation precede the user's request$/, (w: AgentSurfaceWorld) => {
    for (const [name, text] of Object.entries(w.channelTexts!)) {
      expect(text.toLowerCase(), `${name} lost the gate phrase`).toContain(TRIGGER_CORE.gate.toLowerCase())
      // Channels word the clause freely ("respond to the user", "proceed
      // with the user's request") — what must survive is that the gate
      // holds the USER's turn behind orientation.
      expect(text.toLowerCase(), `${name} does not gate the user's request`).toMatch(/only then[^.\n]*(respond|proceed)[^.\n]*user/)
    }
  })
  // D382: the one line each of the two channels carries, read where it
  // must sit to mean the protocol: the line right after the gate, inside
  // the session-start section, and the only line of the channel that says
  // so. The handshake is the live one off the transport.
  reg.define(/^the handshake and the AGENTS\.md block each say that a session whose first message opens with treecontext's line naming it a worker skips that protocol$/, (w: AgentSurfaceWorld) => {
    for (const name of ['handshake instructions', 'AGENTS.md block']) {
      const lines = w.channelTexts![name]!.split('\n')
      const said = lines.flatMap((l, i) => (workerLineOf(l) ? [i] : []))
      expect(said.length, `${name} says ${said.length} times that a worker skips the protocol`).toBe(1)
      const gate = lines.findIndex((l) => l.toLowerCase().startsWith(TRIGGER_CORE.gate.toLowerCase()))
      expect(gate, `${name} has no gate line`).toBeGreaterThan(0)
      expect(said[0], `${name}'s worker line is not the line after the gate, inside the session-start steps`).toBe(gate + 1)
    }
  })

  // D412: the capture line, read off the live handshake with its line
  // breaks taken as spaces (the card wraps at 76 columns). Which clients get
  // the re-orientation packet is the README's (ruled 2026-11-10), and the
  // card stays within its 2048 bytes (D210) with every clause the other
  // scenarios of this file pin.
  reg.define(/^they say that hooks capture a session on Claude Code, and on Codex CLI or Antigravity CLI where their hooks are installed and running, and that elsewhere only what the agent inserts is kept$/, (w: AgentSurfaceWorld) => {
    const flat = w.instructions!.replace(/\s*\n\s*/g, ' ')
    expect(flat).toContain('Hooks capture a session on Claude Code, and on Codex CLI or Antigravity CLI where their hooks are installed and running; elsewhere only what you insert is kept.')
    // The needle fires: the card before D412, as Codex itself recorded it
    // in a tool listing (tests/fixtures/codex-hooks/0.167.0/rollouts).
    const before = readFileSync(join(TS_ROOT, 'tests', 'fixtures', 'codex-hooks', '0.167.0', 'rollouts', 'headless-session.rollout.jsonl'), 'utf8')
    expect(before).toMatch(/On Claude Code, hooks auto-capture/)
    // step-lint: allow unearned-absence -- the line above proves the needle fires on the card Codex recorded before D412
    expect(flat).not.toMatch(/On Claude Code, hooks auto-capture/)
    expect(Buffer.byteLength(w.instructions!, 'utf8')).toBeLessThanOrEqual(2048)
  })
  reg.define(/^they tell the agent to attach a media_ref to file insertions$/, (w: AgentSurfaceWorld) => {
    expect(w.instructions).toMatch(/media_ref/)
    expect(w.instructions).toMatch(/attach|insert a node with media_ref/i)
  })
  reg.define(/^an entry inserted with a media reference exports with the media reference intact$/, async (w: AgentSurfaceWorld) => {
    await openLiveStore(w)
    w.nodeId = await insertAttachment(w, 'User attached the deployment topology diagram', {
      uri: 'file:///attachments/topology.png',
      mimeType: 'image/png',
    })
    expect(mediaOf(exportNode(w, w.nodeId)).uri).toBe('file:///attachments/topology.png')
    expect(rawMediaOf(w, w.nodeId).mimeType).toBe('image/png')
  })

  // Never advertise machinery the backend lacks.
  reg.define(/^a server running on the lexical backend$/, async (w: AgentSurfaceWorld) => {
    await openLiveStore(w)
  })
  reg.define(/^the MCP handshake sends its instructions$/, async (w: AgentSurfaceWorld) => {
    // The running server's advertisement over the real handshake — not the
    // pure function it is built from: a server that started advertising
    // machinery the backend lacks must fail here.
    const client = await mcpOver(w)
    w.instructions = client.getInstructions() ?? ''
  })
  // Step text reworded under D215 (amends D14): "no tree-era checkpoint or
  // summarize machinery is named". The pre-D215 wording was dropped when the
  // chunk-3 worktree merged over main's reworded feature line (2026-10-08).
  reg.define(/^no tree-era checkpoint or summarize machinery is named$/, async (w: AgentSurfaceWorld) => {
    const text = w.instructions!
    // In-world positive control (audit run 2; mutation M8 proved the hole:
    // with the server shipping '' for instructions, this scenario stayed
    // green). The prover used to live in the channel-comparison scenario,
    // over a different world field — so nothing in THIS scenario made the
    // absences falsifiable. Pin first that the same handshake string this
    // scenario read carries the protocol the server actually ships,
    // matched against the src constants rather than retyped prose, so the
    // control tracks instructions.ts and cannot drift away from it.
    const mentions = [...text.matchAll(/treecontext_\w+/g)].map((m) => m[0])
    const firstDistinct: string[] = []
    for (const m of mentions) if (!firstDistinct.includes(m)) firstDistinct.push(m)
    expect(firstDistinct.slice(0, TRIGGER_CORE.steps.length), 'the live handshake drifts from the protocol order').toEqual([...TRIGGER_CORE.steps])
    expect(text, 'the live handshake lost the gate phrase').toContain(TRIGGER_CORE.gate)
    const dropped = INSTRUCTIONS_BRIEF_LEXICAL.split('\n').filter((line) => line.length > 0 && !text.includes(line))
    expect(dropped, 'the handshake did not ship the instruction set src serves').toEqual([])
    // Needle liveness: both fence needles must fire on text that DOES
    // advertise the machinery, so a mistyped needle fails here instead of
    // passing the exclusions below forever.
    const advertising = 'Run treecontext_checkpoint_all to summarize stale nodes.'
    expect(advertising, 'the checkpoint needle is dead').toMatch(CHECKPOINT_NEEDLE)
    expect(advertising, 'the summarize needle is dead').toMatch(SUMMARIZE_NEEDLE)
    expect(text).not.toMatch(CHECKPOINT_NEEDLE)
    expect(text).not.toMatch(SUMMARIZE_NEEDLE)
    // Every tool the text names is one the live server registers: the
    // general form of "no instruction to run a tool the backend lacks".
    const registered = new Set((await w.client!.listTools()).tools.map((t) => t.name))
    expect(registered.size, 'the live server registered no tools').toBeGreaterThan(0)
    expect([...new Set(mentions)].filter((m) => !registered.has(m)), 'the handshake names tools the server lacks').toEqual([])
  })
  reg.define(/^status never demands a summarize action$/, (w: AgentSurfaceWorld) => {
    const status = w.store!.status() as unknown as Record<string, unknown>
    // A summarize demand would arrive as a required-action field in this
    // payload ('action_required' in the tree era); the lexical backend
    // computes none. But absence assertions cannot fail — both the old
    // staleSummaryCount === 0 and a later action_required-absence check
    // were dead matchers (audit run 1; the key exists nowhere in src/).
    // The control is this allow-list ratchet: ANY new status key fails
    // the step, so its author must either extend the list knowingly or —
    // if the key is a demand surface — rebuild this step with a world
    // that can exercise the demand.
    const known = new Set([
      'backend', 'totalNodes', 'leafNodes', 'internalNodes', 'staleSummaryCount',
      'maxDepth', 'totalContentChars', 'totalSummaryChars', 'staleNodeIds',
      'resumePointers', 'resumePointerTotal', 'retention',
    ])
    expect(Object.keys(status).filter((k) => !known.has(k))).toEqual([])
  })

  reg.define(/^the default instruction text fits under the cap whole$/, (w: AgentSurfaceWorld) => {
    // The reference platform's server-instructions budget, pinned at 2KB
    // (same bound instructions-drift.test.ts holds the tree variant to).
    // Resights when: the reference platform's documented
    // server-instructions budget changes away from 2KB.
    // "Fits whole" is a claim about real text: an empty handshake fits
    // any cap, so the floor comes first (item-B gate; under the
    // empty-instructions mutant this step stayed green).
    const bytes = Buffer.byteLength(w.instructions!, 'utf8')
    expect(bytes, 'an empty handshake fits every cap and proves nothing').toBeGreaterThan(0)
    expect(bytes).toBeLessThanOrEqual(2048)
  })

  reg.define(/^they describe the availability marker and name the export tool it points to$/, (w: AgentSurfaceWorld) => {
    expect(w.instructions).toMatch(/availability marker/)
    expect(w.instructions).toMatch(/treecontext_export/)
  })

  // Gap markers explained.
  reg.define(/^a journal containing capture-gap entries$/, async (w: AgentSurfaceWorld) => {
    await openLiveStore(w)
    const gapId = (
      await w.store!.insert('[capture gap] 3 events failed ingestion after retries and were dead-lettered', {
        metadata: { source: 'auto-capture', role: 'tool' },
      })
    ).nodeId
    // The world must hold what its text claims (audit run 1: this row
    // was dead state no step read) — prove the marker is retrievable.
    const found = await w.store!.query('dead-lettered', { topK: 5 })
    expect(found.map((r) => r.nodeId)).toContain(gapId)
  })
  reg.define(/^the instructions state that gap entries mark holes to be trusted over assumed completeness$/, (w: AgentSurfaceWorld) => {
    expect(w.instructions).toMatch(/capture gap/)
    expect(w.instructions).toMatch(/trust them over assuming completeness/)
  })
  // ── the checkpoint protocol in the handshake (D174, D188, D173, D179, D210)
  // Bound 2026-10-08 on the instructions, never on a model reply (D188):
  // the live handshake off a real transport, read clause by clause.
  reg.define(/^an agent connected to the server$/, async (w: AgentSurfaceWorld) => {
    await openLiveStore(w)
    await mcpOver(w)
  })
  reg.define(/^it reads the handshake instructions$/, (w: AgentSurfaceWorld) => {
    w.instructions = w.client!.getInstructions() ?? ''
    expect(w.instructions.length, 'the handshake carried no instructions').toBeGreaterThan(0)
  })
  reg.define(/^the agent reads that two kinds of checkpoint exist, the bookmark the stop hook writes and the chapter summary written on the developer's word$/, (w: AgentSurfaceWorld) => {
    clause(w, 'two kinds of checkpoint')
    clause(w, 'the bookmark the stop hook writes')
    clause(w, "the chapter summary on the developer's word")
  })
  reg.define(/^the agent reads the word that writes a chapter summary$/, (w: AgentSurfaceWorld) => {
    // The word itself, quoted, on the chapter line — and the same word the
    // reference skill and the AGENTS.md block teach, so the developer's one
    // word means one thing on every channel.
    const word = /Chapter summary: when the developer says "([^"]+)"/.exec(flat(w.instructions!))?.[1]
    expect(word, 'the handshake names no word for a chapter summary').toBe('checkpoint')
    for (const [name, text] of [['reference skill', SKILL_REFERENCE_BODY], ['AGENTS.md block', INSTRUCTIONS_CONTENT]] as const) {
      expect(flat(text), `the ${name} teaches a different word`).toContain(`when the developer says "${word}"`)
    }
  })
  reg.define(/^the agent reads what the first reply after a \/clear shows, in order$/, (w: AgentSurfaceWorld) => {
    clause(w, 'the packet first after a clear')
  })
  reg.define(/^the agent reads the steps of a handoff through the shared repository$/, async (w: AgentSurfaceWorld) => {
    clause(w, 'the handoff steps')
    // The import step names a tool this server actually registers.
    const names = (await w.client!.listTools()).tools.map((t) => t.name)
    expect(names).toContain('treecontext_import')
  })
  reg.define(/^the agent reads that its first reply after a \/clear opens with the re-orientation packet shown to the developer as is$/, (w: AgentSurfaceWorld) => {
    clause(w, 'the packet first after a clear')
  })
  reg.define(/^the agent reads that after writing a chapter summary it suggests that this is a good moment to \/clear$/, (w: AgentSurfaceWorld) => {
    clause(w, 'the suggestion to clear after a chapter')
  })
  reg.define(/^the agent reads that when capture or recall looks wrong it runs doctor before anything else$/, (w: AgentSurfaceWorld) => {
    clause(w, 'doctor first')
  })
  reg.define(/^the agent reads the whole checkpoint protocol in under 2500 characters of handshake text$/, (w: AgentSurfaceWorld) => {
    // Whole first, then small: a short handshake that dropped a clause
    // would pass any size bound.
    expect(protocolGaps(w.instructions!), 'the handshake is missing parts of the protocol').toEqual([])
    expect(w.instructions!.length).toBeLessThan(2500)
  })
  reg.define(/^the agent reads where the protocol's long form can be loaded on demand$/, (w: AgentSurfaceWorld) => {
    clause(w, 'the long form')
    // The pointer has to land: install puts a skill of that name where the
    // reference platform loads skills, and its body carries the long form
    // of the clauses the card only names.
    w.ihome = mkdtempSync(join(tmpdir(), 'tc-skill-home-'))
    w.defer(() => rmSync(w.ihome!, { recursive: true, force: true }))
    mkdirSync(join(w.ihome, '.claude'), { recursive: true })
    const run = tcCli(w, ['install', '--yes', '--agent', 'claude'])
    expect(run.status, run.out).toBe(0)
    const skill = readFileSync(join(w.ihome, '.claude', 'skills', SKILL_REFERENCE_NAME, 'SKILL.md'), 'utf8')
    for (const section of ['## Checkpoints (long form)', '## After a /clear', '## Handoff to a teammate', '## When something looks wrong']) {
      expect(skill, `the installed skill has no "${section}" section`).toContain(section)
    }
    expect(flat(skill)).toContain('when the developer says "checkpoint"')
    expect(flat(skill)).toContain('metadata.kind = "bookmark"')
    expect(skill.length, 'the long form is no longer than the card').toBeGreaterThan(w.instructions!.length)
  })

  // ── the handshake keeps its orientation query; the skill says what
  // ranks where (D264). The card off the live handshake; the skill as the
  // real `install` writes it where the reference platform loads skills;
  // both read by content, and every number the skill states compared with
  // the default the server actually serves.
  reg.define(/^it reads the handshake instructions and the reference skill$/, (w: AgentSurfaceWorld) => {
    w.instructions = w.client!.getInstructions() ?? ''
    expect(w.instructions.length, 'the handshake carried no instructions').toBeGreaterThan(0)
    w.ihome = mkdtempSync(join(tmpdir(), 'tc-skill-home-'))
    w.defer(() => rmSync(w.ihome!, { recursive: true, force: true }))
    mkdirSync(join(w.ihome, '.claude'), { recursive: true })
    const run = tcCli(w, ['install', '--yes', '--agent', 'claude'])
    expect(run.status, run.out).toBe(0)
    w.skillText = readFileSync(join(w.ihome, '.claude', 'skills', SKILL_REFERENCE_NAME, 'SKILL.md'), 'utf8')
  })
  reg.define(/^the handshake's second session-start step is the free-text orientation query, described as recovering the thread around the resume pointers$/, (w: AgentSurfaceWorld) => {
    const lines = w.instructions!.split('\n')
    const start = lines.findIndex((l) => l.startsWith('SESSION START'))
    const gate = lines.findIndex((l, i) => i > start && l.startsWith(TRIGGER_CORE.gate))
    expect(start, 'the handshake has no session-start block').toBeGreaterThanOrEqual(0)
    const steps = lines.slice(start + 1, gate).join('\n').split(/\n(?=\d\. )/)
    expect(steps.map((t) => t.slice(0, 2)), 'the session-start block lost or gained a step').toEqual(['1.', '2.'])
    // Step one finds the resume pointers; step two is the free-text query
    // the developer's words would be, and says what it is for.
    expect(flat(steps[0]!)).toMatch(/^1\. treecontext_status — check resume_pointers/)
    const two = flat(steps[1]!)
    expect(two).toMatch(/^2\. treecontext_query\("what was I working on, what was the next step"\)/)
    expect(two).toMatch(/recovers the thread around the resume pointers status found/)
    expect(w.instructions!.length).toBeLessThan(2500)
    expect(Buffer.byteLength(w.instructions!, 'utf8')).toBeLessThanOrEqual(2048)
  })
  reg.define(/^the skill's search paragraph states the ranking order: the developer's directives and curated notes first, assistant prose and captured tool output below them, treecontext's own echoes found by their tool name$/, (w: AgentSurfaceWorld) => {
    const m = /\n## Search \(treecontext_query\)\n([\s\S]*?)\n\n## /.exec(w.skillText!)
    expect(m, 'the installed skill has no search paragraph').toBeTruthy()
    const para = flat(m![1]!)
    const f = (n: number): string => n.toFixed(n === Math.trunc(n) ? 1 : String(n).split('.')[1]!.length)
    const wt = DEFAULT_ROLE_WEIGHTS
    // The order, in words and in the weights the search serves.
    const first = para.indexOf(`the developer's directives and the curated notes first (user ${f(wt.user)}, note ${f(wt.note)})`)
    const below = para.indexOf(`assistant prose and captured tool output below them (assistant ${f(wt.assistant)}, tool ${f(wt.tool)})`)
    expect(first, para).toBeGreaterThanOrEqual(0)
    expect(below, para).toBeGreaterThan(first)
    expect(wt.user).toBeGreaterThan(wt.assistant)
    expect(wt.note).toBeGreaterThan(wt.assistant)
    expect(wt.assistant).toBeGreaterThan(wt.tool)
    // The store's own echoes: found by their tool name, never by results.
    expect(para).toMatch(/treecontext calls, captured as echoes, are found by their tool name/)
    expect(para).toMatch(/never by the results they returned/)
    // Every other claim the paragraph made stays, and stays true.
    expect(para).toContain('role_weights tunes the weights per query')
    expect(para).toContain('conversation_window returns the entries around each hit')
    expect(para).toContain(`recency_weight ${DEFAULT_RECENCY_WEIGHT}`)
    expect(para).toContain('recency_weight: 0 for pure lexical ranking')
    expect(para).toContain('adaptive: true lets the score distribution set the result count')
    // The installed file carries the body install generates from.
    expect(w.skillText).toContain(SKILL_REFERENCE_BODY)
  })
  reg.define(/^the query tool offers no parameter for orientation beyond those it had$/, async (w: AgentSurfaceWorld) => {
    const query = (await w.client!.listTools()).tools.find((t) => t.name === 'treecontext_query')!
    const props = Object.keys((query.inputSchema as { properties: Record<string, unknown> }).properties).sort()
    // The parameter set as committed before D264 (HEAD f1be050): the
    // ruling declined an orientation parameter, so the set is unchanged
    // but for the one parameter a later ruling added that is no
    // orientation: the run-and-key lookup, D337's carrier (ratified D349,
    // the carrier [chosen] in DESIGN.md), which returns the key lookup's
    // reply instead of hits and is named by its constant.
    expect(props).toEqual([
      'adaptive', 'adaptive_max', 'conversation_window', 'exclude_namespaces', KEY_LOOKUP_PARAM, 'media_filter', 'metadata_filter',
      'namespace_weights', 'query', 'recency_weight', 'role_weights', 'scope', 'sort_by', 'time_range', 'top_k',
    ].sort())
  })

  // S: installing the AGENTS.md block twice yields one block.
  //
  // CLI-driven, per the register note: the real `treecontext init`
  // subprocess against a real repo file, not upsertInstructions called
  // directly (library-level idempotency is already pinned in
  // installer.test.ts — this binding owns the command surface). The
  // second run finds a STALE block, so "updated in place" is an update,
  // not a skip; the third run proves the fixed point announces itself.
  reg.define(/^a repository where the init command has already added its block$/, (w: AgentSurfaceWorld) => {
    w.ihome = mkdtempSync(join(tmpdir(), 'tc-init-home-'))
    w.defer(() => rmSync(w.ihome!, { recursive: true, force: true }))
    w.dir = mkdtempSync(join(tmpdir(), 'tc-init-repo-'))
    w.defer(() => rmSync(w.dir!, { recursive: true, force: true }))
    const target = join(w.dir, 'AGENTS.md')
    writeFileSync(target, '# My project\n\nHand-written guidance that must survive.\n')
    const first = tcCli(w, ['init'], { cwd: w.dir })
    expect(first.status, first.out).toBe(0)
    const after = readFileSync(target, 'utf8')
    expect(after.match(/<!-- treecontext:start -->/g)).toHaveLength(1)
    // Stale-ify the block body so the re-run has something to update.
    writeFileSync(target, after.replace(
      /(<!-- treecontext:start -->)[\s\S]*?(<!-- treecontext:end -->)/,
      '$1 an older block body $2',
    ))
  })
  reg.define(/^init runs again$/, (w: AgentSurfaceWorld) => {
    const rerun = tcCli(w, ['init'], { cwd: w.dir! })
    expect(rerun.status, rerun.out).toBe(0)
    expect(rerun.out).toContain('updated')
  })
  reg.define(/^the block appears once, updated in place$/, (w: AgentSurfaceWorld) => {
    const content = readFileSync(join(w.dir!, 'AGENTS.md'), 'utf8')
    expect(content.match(/<!-- treecontext:start -->/g)).toHaveLength(1)
    expect(content.match(/<!-- treecontext:end -->/g)).toHaveLength(1)
    // step-lint: allow unearned-absence -- guarded: this scenario's Given wrote 'an older block body' into a block asserted present (the stale-ify step above) — replacement proven by the pair, not absence-by-never-written
    expect(content).not.toContain('an older block body')
    expect(content).toContain('Hand-written guidance that must survive.')
    // The fixed point announces itself: a third run changes nothing and
    // says so.
    const third = tcCli(w, ['init'], { cwd: w.dir! })
    expect(third.status, third.out).toBe(0)
    expect(third.out).toContain('already contains')
    expect(readFileSync(join(w.dir!, 'AGENTS.md'), 'utf8')).toBe(content)
  })

  workerOrientationSteps(reg)
}

export const agentSurfaceSchemaDefiner = (reg: Registry<AgentSurfaceWorld>): void => {
  reg.define(/^a running journal server$/, async (w: AgentSurfaceWorld) => {
    await openLiveStore(w)
  })
  reg.define(/^the MCP handshake registers its tool schemas$/, async (w: AgentSurfaceWorld) => {
    await mcpOver(w)
  })
  reg.define(/^no parameter description names retrieval machinery the backend lacks$/, async (w: AgentSurfaceWorld) => {
    const tools = (await w.client!.listTools()).tools
    // Vocabulary extended at critic pass 4 (2026-07-26): the original list
    // caught the query tool's leftovers while five OTHER tools still spoke
    // tree — "a node and its subtree", "memory tree", "graft", "branch
    // label", "tree statistics". Structure the backend lacks is machinery
    // the backend lacks. (branch_diverse stays: a compat-kept enum value
    // whose own description discloses its status.)
    // The tree era's checkpoint MACHINERY is named, never the bare word
    // (narrowed 2026-11-01, unit 2 of the beta.3 build): a checkpoint is
    // the beta.3 contract's own term now, the state of a key's work (D280),
    // and the query tool's key_lookup and the insert tool describe it in
    // that word. The needle is the one the handshake scenario proves live.
    const forbidden = new RegExp(`drills into subtrees|different subtrees|pure cosine|embedding fusion|multimodal model|BIRCH|dual-tree|${CHECKPOINT_NEEDLE.source}|internal \\(summary\\) nodes inherit|subtree|memory tree|full tree|primary tree|tree statistics|exported tree|source tree|graft|branch label|labeled branch`, 'i')
    expect('Run treecontext_checkpoint_all to summarize stale nodes.', 'the narrowed checkpoint needle is dead').toMatch(forbidden)
    expect('the checkpoint in effect under a run\'s key').not.toMatch(forbidden)
    for (const t of tools) {
      const schema = JSON.stringify(t.inputSchema)
      expect(schema, `${t.name} schema advertises deleted machinery`).not.toMatch(forbidden)
      expect(t.description ?? '', `${t.name} description advertises deleted machinery`).not.toMatch(forbidden)
    }
  })
  reg.define(/^a parameter accepted only for compatibility says so in its description$/, async (w: AgentSurfaceWorld) => {
    const tools = (await w.client!.listTools()).tools
    const query = tools.find((t) => t.name === 'treecontext_query')!
    const props = (query.inputSchema as { properties: Record<string, { description?: string }> }).properties
    // The historical compat set left the schema at the slim-down
    // (2026-07-27) — absence is the strongest disclosure, and unknown
    // keys from old callers are stripped at the MCP layer rather than
    // erroring. The rule stays live in generic form for any future
    // param: a description admitting inertness must name compatibility
    // in the same breath.
    for (const dropped of ['retrieval_mode', 'expansion_budget', 'include_internal', 'modal_query', 'dense_weight', 'sparse_weight', 'adaptive_method']) {
      expect(props[dropped], `${dropped} was dropped at the slim-down — it must not return`).toBeUndefined()
    }
    for (const [name, p] of Object.entries(props)) {
      const d = p.description ?? ''
      if (/no effect|accepted for/i.test(d)) {
        expect(d, `${name} admits inertness without naming compatibility`).toMatch(/compatibilit/i)
      }
    }
  })

  // ── the tool surface is exactly the ruled set (critic pass 4) ───────
  reg.define(/^the MCP handshake registers its tools under the full policy$/, async (w: AgentSurfaceWorld) => {
    await mcpOver(w)
  })
  reg.define(/^the eight journal tools and no others are present$/, async (w: AgentSurfaceWorld) => {
    const names = (await w.client!.listTools()).tools.map((t) => t.name).sort()
    expect(names).toEqual([
      'treecontext_clear',
      'treecontext_delete',
      'treecontext_export',
      'treecontext_import',
      'treecontext_insert',
      'treecontext_merge_from_agent',
      'treecontext_query',
      'treecontext_status',
    ])
  })
}

// (Critic pass 3 additions, 2026-07-25) ────────────────────────────────

// ── D382: a ticket-door worker skips the session-start routine ──────────
//
// The worker is the hook-less stand-in (../standins.ts) started by the real
// ticket door (`treecontext run`, through runWorker); it starts the real
// `treecontext serve` over stdio with the environment the door set, and
// records what `initialize` handed it (the plan's `handshakes`). The block
// is the bytes the real `install` wrote into a redirected home. The
// outline's openings are compared with the first message the real door
// gave the worker, so a reword of either side fails it.

const RUN = 'r1'
const KEY = 'login-form'

/** A line that says a session opening with treecontext's worker line skips
 *  the routine: the handshake's and the block's. */
function workerLineOf(line: string): boolean {
  return /first message opens with "?treecontext/i.test(line) && /\bworker\b/.test(line) && /\bskips?\b/i.test(line)
}

/** The quoted openings the block's worker line names, in its order. */
function blockOpenings(block: string): string[] {
  const lines = block.split('\n').filter(workerLineOf)
  expect(lines.length, 'the block has no single worker line').toBe(1)
  return [...lines[0]!.matchAll(/"(treecontext: [^"]+)"/g)].map((m) => m[1]!)
}

/** An opening as a pattern on a message's start: the block's `…` stands
 *  for the role, which it captures. */
function openingPattern(opening: string): RegExp {
  const parts = opening.split('…').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`^${parts.join('(\\S+)')}`)
}

const ROUTINE_NEEDLES = ['the protocol order', 'SESSION START', TRIGGER_CORE.steps[0], 'Fetch each resume pointer', 'what was I working on', TRIGGER_CORE.gate]

/** The tool order and the words that make the routine, found in a card. */
function routineNeedles(text: string): string[] {
  const mentions = [...text.matchAll(/treecontext_\w+/g)].map((m) => m[0])
  const firstDistinct: string[] = []
  for (const m of mentions) if (!firstDistinct.includes(m)) firstDistinct.push(m)
  const found: string[] = []
  if (JSON.stringify(firstDistinct.slice(0, TRIGGER_CORE.steps.length)) === JSON.stringify([...TRIGGER_CORE.steps])) found.push(ROUTINE_NEEDLES[0]!)
  for (const n of ROUTINE_NEEDLES.slice(1)) if (text.includes(n)) found.push(n)
  return found
}

/** A card's body: everything from its first blank line. */
const bodyOf = (card: string): string => card.slice(card.indexOf('\n\n'))

function workerTicket(o: Partial<TicketFields> = {}): TicketFields {
  return { run: RUN, key: KEY, role: 'builder', checkpointer: 'reviewer', parent: { id: 'p1', cli: 'codex' }, ...o } as TicketFields
}

function standinOf(w: AgentSurfaceWorld): StandinRecord {
  const o = w.facts!['out:worker'] as Outcome | undefined
  expect(o, 'no worker was started through the door').toBeDefined()
  expect(o!.exitCode, `the worker did not end cleanly: ${o!.stderr}`).toBe(0)
  expect(o!.log.length, 'the worker recorded nothing').toBeGreaterThan(0)
  return o!.log[0]!
}

function workerOrientationSteps(reg: Registry<AgentSurfaceWorld>): void {
  // ── a worker's own server tells it to begin from its first message ──
  reg.define(/^a worker the ticket door started, with its ticket and its lane in its environment$/, async (w: AgentSurfaceWorld) => {
    await openRunWorld(w)
    await briefFor(w, 'builder', RUN, KEY, { checkpointer: 'reviewer' })
    // Its own server, then the same client's server with neither worker
    // variable: the ordinary card read in this same world, the control.
    await runWorker(w, {
      spawner: 'wrapper', prompt: 'wire the submit button', ticket: workerTicket(),
      plan: { first: { handshakes: [{}, { ticket: null, lane: null }] } },
    })
    const r = standinOf(w)
    expect(r.ticket, 'the door put no ticket in the worker\'s environment').not.toBeNull()
    expect(r.lane, 'the door named no lane in the worker\'s environment').not.toBeNull()
    expect(r.session, 'the worker is not in the lane the door named').toBe(r.lane)
    const registration = rawRegistration(w, w.legs!['worker']!)
    expect([registration['kind'], registration['agent_type'], registration['run'], registration['run_key']]).toEqual(['worker', 'builder', RUN, KEY])
    expect(r.stdin, 'the first message does not hold the brief the card says it holds').toContain(`carry the ${KEY} of ${RUN} forward`)
    expect(r.handshakes?.length, 'the worker read no handshake').toBe(2)
  })
  reg.define(/^the worker's own treecontext server sends its handshake$/, (w: AgentSurfaceWorld) => {
    w.instructions = standinOf(w).handshakes![0]!
    expect(w.instructions.length, 'the worker\'s server sent no instructions').toBeGreaterThan(0)
  })
  reg.define(/^the instructions say the worker's first message holds its brief and the checkpoint in effect, and to begin there$/, (w: AgentSurfaceWorld) => {
    expect(flat(w.instructions!)).toMatch(/Your first message holds your brief and the checkpoint\(s\) in effect[^.]*: begin there\./)
  })
  reg.define(/^the instructions name no session-start routine of status, export and query$/, (w: AgentSurfaceWorld) => {
    // The needles are live: every one fires on the ordinary card the same
    // client's server sent without the worker variables.
    const ordinary = standinOf(w).handshakes![1]!
    expect(routineNeedles(ordinary), 'a needle is dead on the ordinary card').toEqual(ROUTINE_NEEDLES)
    expect(routineNeedles(w.instructions!), 'the worker\'s card names the routine').toEqual([])
    expect(w.instructions!.split('\n').filter(workerLineOf), 'the worker\'s card tells it to skip a routine it does not name').toEqual([])
  })
  reg.define(/^the checkpoint protocol and the availability marker are still there, in under 2500 characters$/, (w: AgentSurfaceWorld) => {
    expect(protocolGaps(w.instructions!), 'the worker\'s card dropped part of the checkpoint protocol').toEqual([])
    expect(w.instructions).toMatch(/bounded preview ending in an availability marker/)
    expect(w.instructions).toMatch(/treecontext_export\(node_id\) fetches the whole thing/)
    // The rest of the card is the ordinary card's, byte for byte.
    const ordinary = standinOf(w).handshakes![1]!
    expect(w.instructions!.endsWith(bodyOf(ordinary)), 'the worker\'s card is not the ordinary body under its own head').toBe(true)
    expect(w.instructions!.length).toBeLessThan(2500)
  })

  // ── a lane named in the environment without its ticket ──────────────
  // A real registration in the lane, the door's for the builder's ticket;
  // the server beside it holds the reviewer's ticket of the same run and
  // parent, as a nested worker's client would start one. The same client
  // also starts a server with its own ticket in that lane (the control: the
  // lane is one trust would honour) and one with no worker variable at all
  // (every other session's card).
  reg.define(/^a treecontext server started with a worker lane in its environment that the ticket beside it does not describe$/, async (w: AgentSurfaceWorld) => {
    await openRunWorld(w)
    // A third producer of "every other session": a hooks-door leg live in
    // the same store (the real SubagentStart hook registered it), beside
    // which the plain serve below still gets the ordinary card.
    const leg = await hooksLeg(w, 'reviewer-leg', 'reviewer', { run: RUN, key: 'review-pass' })
    const legRow = rawRegistration(w, leg)
    expect([legRow['kind'], legRow['agent_type'], legRow['ended'], legRow['stopped_at']], 'the hooks-door leg is not live in the store').toEqual(['subagent', 'reviewer', null, null])
    const other = mintTicket(workerTicket({ role: 'reviewer' }))
    await runWorker(w, {
      spawner: 'wrapper', prompt: 'wire the submit button', ticket: workerTicket(),
      plan: { first: { handshakes: [{ ticket: other }, {}, { ticket: null, lane: null }] } },
    })
    const r = standinOf(w)
    const registration = rawRegistration(w, w.legs!['worker']!)
    expect([registration['session_id'], registration['kind'], registration['agent_type']], 'the lane holds no worker registration').toEqual([r.lane, 'worker', 'builder'])
    const read = readTicket(other)
    expect([read.valid, read.ticket.role], 'the other ticket is not a whole ticket for another role').toEqual([true, 'reviewer'])
    expect(other).not.toBe(r.ticket)
    expect(r.handshakes?.length).toBe(3)
  })
  reg.define(/^the server sends its handshake$/, (w: AgentSurfaceWorld) => {
    w.instructions = standinOf(w).handshakes![0]!
  })
  reg.define(/^the instructions carry the session-start routine as every other session's do$/, (w: AgentSurfaceWorld) => {
    const [, own, none] = standinOf(w).handshakes!
    expect(none!.length, 'the server with no worker variable sent no instructions').toBeGreaterThan(0)
    // The plain serve above ran with a hooks-door leg live in its store.
    expect(routineNeedles(none!), 'a live hooks-door leg changed the plain serve\'s card').toEqual(ROUTINE_NEEDLES)
    expect(none, 'a live hooks-door leg changed the plain serve\'s card').toBe(INSTRUCTIONS_BRIEF_LEXICAL)
    expect(w.instructions, 'the lane alone changed the handshake').toBe(none)
    expect(routineNeedles(w.instructions!)).toEqual(ROUTINE_NEEDLES)
    // The control: in the same lane, the ticket the registration describes
    // gets the worker's card, so the ticket is what decided.
    expect(own, 'the lane\'s own ticket did not get the worker\'s card').not.toBe(none)
    expect(routineNeedles(own!)).toEqual([])
  })

  // ── the instruction block's worker line ────────────────────────────
  reg.define(/^install has written its instruction block for Codex CLI and for Antigravity CLI$/, async (w: AgentSurfaceWorld) => {
    // Antigravity CLI is there by its own directory under ~/.gemini (D383);
    // its block is the one in ~/.gemini/GEMINI.md, its alone (D399).
    await openInstallWorld(w, ['.claude', '.codex', join('.gemini', 'antigravity-cli')])
    setFakeCodex(w, { version: CODEX_APPROVALS_FLOOR, sandbox: { exit: 0, stderr: '' } })
    const run = tcCli(w, ['install', '--yes'])
    expect(run.status, run.out).toBe(0)
    expect(run.stdout).toMatch(/^Detected agents: .*Antigravity CLI/m)
    w.blockFiles = {
      'Codex CLI': readFileSync(join(w.ihome!, '.codex', 'AGENTS.md'), 'utf8'),
      'Antigravity CLI': readFileSync(join(w.ihome!, '.gemini', 'GEMINI.md'), 'utf8'),
    }
  })
  reg.define(/^an agent reads the block$/, (w: AgentSurfaceWorld) => {
    w.blocks = {}
    for (const [name, file] of Object.entries(w.blockFiles!)) {
      const m = new RegExp(`${MARKER_START}[\\s\\S]*?${MARKER_END}`).exec(file)
      expect(m, `install wrote no block for ${name}`).not.toBeNull()
      expect(m![0], `the ${name} block is not the block install writes`).toBe(INSTRUCTIONS_CONTENT)
      w.blocks[name] = m![0]
    }
  })
  reg.define(/^the agent reads one line saying that a session whose first message opens with treecontext's line naming it a worker of a run, or saying its instructions were invalid, skips the session-start routine$/, (w: AgentSurfaceWorld) => {
    for (const [name, block] of Object.entries(w.blocks!)) {
      const lines = block.split('\n')
      const said = lines.filter(workerLineOf)
      expect(said.length, `the ${name} block says it ${said.length} times`).toBe(1)
      const line = said[0]!
      expect(sessionStartOf(block), `the ${name} block's worker line is outside its Session Start section`).toContain(line)
      expect(line).toMatch(/is a worker of a run: it skips these Session Start steps/)
      const openings = blockOpenings(block)
      expect(openings.filter((o) => /^treecontext: you are .*\bworker of the run$/.test(o)).length, `the ${name} line names no worker opening`).toBeGreaterThan(0)
      expect(openings, `the ${name} line does not name the invalid-instructions opening`).toContain('treecontext: your instructions were invalid')
    }
  })
  reg.define(/^the block's session-start steps are otherwise as before$/, (w: AgentSurfaceWorld) => {
    for (const [name, block] of Object.entries(w.blocks!)) {
      expect(sessionStartOf(block).filter((l) => !workerLineOf(l)), `the ${name} block's Session Start steps changed`).toEqual(SESSION_START_BEFORE_D382)
    }
  })

  // ── the door's openings and the block's ─────────────────────────────
  reg.define(/^a worker with a key and a brief in effect$/, async (w: AgentSurfaceWorld) => {
    await openRunWorld(w)
    await briefFor(w, 'builder', RUN, KEY, { checkpointer: 'reviewer' })
    w.facts!['spec'] = { spawner: 'wrapper', prompt: 'wire the submit button', ticket: workerTicket(), plan: { first: {} } } satisfies WorkerSpec
    w.facts!['role'] = 'builder'
  })
  reg.define(/^a one-off worker whose ticket says it has no key$/, async (w: AgentSurfaceWorld) => {
    await openRunWorld(w)
    w.facts!['spec'] = {
      spawner: 'wrapper', prompt: 'look over the login form', ticket: workerTicket({ key: null, noKey: true, checkpointer: null }), plan: { first: {} },
    } satisfies WorkerSpec
    w.facts!['role'] = 'builder'
  })
  reg.define(/^a worker whose ticket is truncated after the role "builder"$/, async (w: AgentSurfaceWorld) => {
    await openRunWorld(w)
    const t = mintTicket(workerTicket())
    const raw = t.slice(0, t.indexOf('"role":"builder"') + '"role":"builder"'.length)
    expect(readTicket(raw).valid, 'the truncated ticket still reads whole').toBe(false)
    w.facts!['spec'] = { spawner: 'wrapper', prompt: 'wire the submit button', ticket: raw, plan: { first: { invalidRow: true } } } satisfies WorkerSpec
    w.facts!['role'] = null
  })
  // D291's send-back (owner, 2026-11-09, the fourth row): the worker owes
  // the checkpoint under its key, exits on its own without one, and the
  // real door runs it once more; the row's first message is the one the
  // re-run's process received on its stdin, never the first run's.
  reg.define(/^a worker run once more for a missing checkpoint$/, async (w: AgentSurfaceWorld) => {
    await openRunWorld(w)
    await briefFor(w, 'builder', RUN, KEY, { checkpointer: 'builder' })
    w.facts!['spec'] = {
      spawner: 'wrapper', prompt: 'wire the submit button', ticket: workerTicket({ checkpointer: 'builder', canWrite: true }),
      plan: { first: { print: 'half wired' }, rerun: { checkpoint: 'state: submit wired after the send-back', print: 'submit wired' } },
    } satisfies WorkerSpec
    w.facts!['role'] = 'builder'
    w.facts!['run-read'] = 'the re-run'
  })
  reg.define(/^the ticket door starts the worker$/, async (w: AgentSurfaceWorld) => {
    await runWorker(w, w.facts!['spec'] as WorkerSpec)
  })
  reg.define(/^the worker's first message opens with the line the instruction block names$/, (w: AgentSurfaceWorld) => {
    let message = standinOf(w).stdin
    if (w.facts!['run-read'] === 'the re-run') {
      // The re-run's own record: the second process the door started, the
      // one that opened on the send-back, its stdin as it read it.
      const log = (w.facts!['out:worker'] as Outcome).log
      expect(log.map((r) => r.rerun), 'the door did not run the worker once more').toEqual([false, true])
      expect(log[1]!.pid, 'the re-run is not a process of its own').not.toBe(log[0]!.pid)
      message = log[1]!.stdin
      expect(message, 'the re-run was given the first run\'s message').not.toBe(log[0]!.stdin)
      expect(message, 'the re-run\'s message does not name the missing checkpoint').toContain(sendBackReason('builder', RUN, KEY))
      // The order the build settled (2026-11-08, under D382): the worker's
      // own line, then the reason, then the trail line.
      const at = (needle: string): number => message.indexOf(needle)
      expect(at(sendBackReason('builder', RUN, KEY)), 'the reason opens the re-run\'s message').toBeGreaterThan(0)
      expect(at('treecontext: your trail is in the store')).toBeGreaterThan(at(sendBackReason('builder', RUN, KEY)))
    }
    expect(message.length, 'the door gave the worker no first message').toBeGreaterThan(0)
    const openings = blockOpenings(INSTRUCTIONS_CONTENT)
    const matched = openings.map((o) => openingPattern(o).exec(message)).filter((m): m is RegExpExecArray => m !== null)
    expect(matched.length, `the first message opens with none of the block's openings ${JSON.stringify(openings)}:\n${message.split('\n')[0]}`).toBe(1)
    // The block's `…` is the role the ticket named, where the opening has one.
    const role = w.facts!['role'] as string | null
    if (role !== null) expect(matched[0]![1], 'the opening names another role').toBe(role)
    else expect(matched[0]!.length, 'the invalid-instructions opening has a role in it').toBe(1)
  })
}

/** The block's Session Start section, heading to the line before the next. */
function sessionStartOf(block: string): string[] {
  const lines = block.split('\n')
  const start = lines.indexOf('## Session Start')
  expect(start, 'the block has no Session Start section').toBeGreaterThanOrEqual(0)
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
  return lines.slice(start, end)
}

/** The block's Session Start section before D382 added its worker line. */
const SESSION_START_BEFORE_D382: string[] = [
  '## Session Start',
  '1. `treecontext_status` — check resume_pointers.',
  '   If resume_pointers non-empty, `treecontext_export(node_id)` on each.',
  '2. `treecontext_query("what was I working on, what was the next step")`',
  'Only then proceed with the user\'s request.',
  '',
]

