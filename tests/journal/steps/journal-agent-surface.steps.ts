import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect } from 'vitest'
import { type Registry } from 'gherkin-node-test/vitest'
import { INSTRUCTIONS_BRIEF_LEXICAL, SKILL_REFERENCE_BODY, SKILL_REFERENCE_NAME, TRIGGER_CORE } from '../../../src/server/instructions.js'
import { SESSION_REMINDER_TEXT, INSTRUCTIONS_CONTENT } from '../../../src/server/installer.js'
import { mcpOver, openLiveStore, exportNode, mediaOf, rawMediaOf, insertAttachment } from '../world.js'
import { type InstallWorld, tcCli } from '../install-harness.js'

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
  'the handoff steps': /Handoff: export the chapter summaries to a file in the repository and commit it; the teammate pulls and imports it with treecontext_import, with the file's name as the label\./,
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
 * install harness.
 */
export interface AgentSurfaceWorld extends InstallWorld {
  /** The live handshake's instruction text, off a real transport. */
  instructions?: string
  /** The four channels that must teach one protocol, keyed by channel name. */
  channelTexts?: Record<string, string>
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
    const forbidden = /drills into subtrees|different subtrees|pure cosine|embedding fusion|multimodal model|BIRCH|dual-tree|checkpoint|internal \(summary\) nodes inherit|subtree|memory tree|full tree|primary tree|tree statistics|exported tree|source tree|graft|branch label|labeled branch/i
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

