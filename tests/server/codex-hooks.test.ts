/**
 * Codex's own hooks block (D406): written in groups of its own after the
 * developer's, never moving a hook of theirs; a reinstall that changes
 * nothing changes nothing; an earlier build's copy converges; uninstall
 * takes back what install wrote and names any hook of the developer's it
 * moved. The trust Codex keys by place is read by the scenarios
 * (journal-install, journal-clients) from Codex's own `hooks/list`.
 */
import { describe, it, expect } from 'vitest'
import {
  codexHooksBlock, convergeCodexHooks, takeBackCodexHooks, codexBlockState, hookPlaces, codexHookKey, eventSnake, CODEX_HOOK_EVENTS,
  codexPlacementError, codexHooksTextFor, isTreecontextCodexHook, codexOwnPart,
} from '../../src/server/codex-hooks.js'
import { editJsonText, developerTextSurvives, parseSpans, canonicalJson } from '../../src/server/json-text-edit.js'
import { expectedHookCopy } from '../../src/server/installer.js'

const dev = (command: string, matcher?: string): Record<string, unknown> => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command }] })

describe("Codex's block", () => {
  it('holds one group per wired event, each command naming Codex, Interrupt given its 3 s', () => {
    const block = codexHooksBlock()
    expect(Object.keys(block)).toEqual(CODEX_HOOK_EVENTS.map((e) => e.event))
    expect(block['Interrupt']![0]!.hooks[0]).toMatchObject({ timeout: 3 })
    for (const g of Object.values(block)) expect(g[0]!.hooks[0]!.command).toMatch(/ --client codex$/)
  })
  it('keys a hook as Codex keys its trust', () => {
    expect(eventSnake('PostToolUse')).toBe('post_tool_use')
    expect(codexHookKey('/h/.codex/hooks.json', { event: 'SessionStart', group: 1, index: 0 })).toBe('/h/.codex/hooks.json:session_start:1:0')
  })
})

describe('converging a hooks file on the block', () => {
  it("writes treecontext's groups after the developer's and moves none of theirs", () => {
    const before = { hooks: { PostToolUse: [dev('dev-post', 'Bash')], Stop: [dev('dev-stop')] } }
    const c = convergeCodexHooks(before, codexHooksBlock())
    expect(c.changed).toBe(true)
    expect(c.moved).toEqual([])
    const places = hookPlaces(c.data['hooks'])
    expect(places.find((p) => p.command === 'dev-post')).toMatchObject({ event: 'PostToolUse', group: 0, index: 0 })
    expect(places.find((p) => p.command === 'dev-stop')).toMatchObject({ event: 'Stop', group: 0, index: 0 })
    expect(codexBlockState(c.data, codexHooksBlock()).state).toBe('current')
  })
  it('changes nothing on a second pass, and leaves a later hook of the developer where it is', () => {
    const once = convergeCodexHooks({}, codexHooksBlock()).data
    const hooks = once['hooks'] as Record<string, unknown[]>
    hooks['Stop']!.push(dev('dev-after'))
    const again = convergeCodexHooks(once, codexHooksBlock())
    expect(again.changed).toBe(false)
    expect(again.data).toEqual(once)
  })
  it("turns an earlier build's verbatim copy into Codex's own block, PostToolUseFailure and PostToolBatch gone", () => {
    const copy = { hooks: { ...structuredClone(expectedHookCopy()), PostToolUse: [dev('dev-post'), ...structuredClone(expectedHookCopy()['PostToolUse']!)] } }
    expect(codexBlockState(copy, codexHooksBlock()).state).toBe('claude-copy')
    const c = convergeCodexHooks(copy, codexHooksBlock())
    const hooks = c.data['hooks'] as Record<string, unknown>
    expect(hooks['PostToolUseFailure']).toBeUndefined()
    expect(hooks['PostToolBatch']).toBeUndefined()
    expect(codexBlockState(c.data, codexHooksBlock()).state).toBe('current')
    expect(hookPlaces(hooks).find((p) => p.command === 'dev-post')).toMatchObject({ group: 0, index: 0 })
    expect(c.written.length).toBe(Object.keys(codexHooksBlock()).length)
  })
  it("names a developer's hook that taking a group of treecontext's out moved", () => {
    const once = convergeCodexHooks({}, codexHooksBlock()).data
    const hooks = once['hooks'] as Record<string, unknown[]>
    hooks['Stop']!.push(dev('dev-after'))
    const back = takeBackCodexHooks(once)
    expect(back.moved).toEqual([{ from: { event: 'Stop', group: 1, index: 0, command: 'dev-after' }, to: { event: 'Stop', group: 0, index: 0, command: 'dev-after' } }])
    expect(back.data).toEqual({ hooks: { Stop: [dev('dev-after')] } })
  })
  it("takes back only treecontext's hooks, a developer's group sharing one of them keeping its own", () => {
    const ours = (codexHooksBlock()['Stop']![0]!.hooks[0]!).command
    const before = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'dev-a' }, { type: 'command', command: ours }] }] }, description: 'mine' }
    const back = takeBackCodexHooks(before)
    expect(back.data).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'dev-a' }] }] }, description: 'mine' })
    expect(back.moved).toEqual([])
  })
})

describe("install's own structural check, over every JSON value at every place it reads", () => {
  // Every JSON type, and the shapes nearest the ones install reads.
  const VALUES: unknown[] = [null, true, false, 0, -1, 1.5, 1e21, '', 'x', [], [null], ['x'], [[]], [{}], {}, { hooks: null }, { hooks: [] }, { command: 5 }]
  const ours = (codexHooksBlock()['Stop']![0]!.hooks[0]!).command
  // The places install reads or steps around, each a function from a value to a whole file.
  const PLACES: Array<[string, (v: unknown) => unknown]> = [
    ['the file', (v) => v],
    ['"hooks"', (v) => ({ hooks: v })],
    ['"description"', (v) => ({ description: v, hooks: {} })],
    ...CODEX_HOOK_EVENTS.map((e): [string, (v: unknown) => unknown] => [`"hooks.${e.event}"`, (v) => ({ hooks: { [e.event]: v } })]),
    ['an event install does not write', (v) => ({ hooks: { Bogus: v } })],
    ['a top-level key an earlier build wrote', (v) => ({ PostToolUse: v })],
    ['a group', (v) => ({ hooks: { Stop: [v, { hooks: [{ type: 'command', command: 'dev' }] }] } })],
    ["a group's hooks", (v) => ({ hooks: { Stop: [{ hooks: v }] } })],
    ['a hook', (v) => ({ hooks: { Stop: [{ hooks: [v, { type: 'command', command: ours }] }] } })],
    ["a hook's command", (v) => ({ hooks: { Stop: [{ hooks: [{ type: 'command', command: v }] }] } })],
    ["a group's matcher", (v) => ({ hooks: { Stop: [{ matcher: v, hooks: [{ type: 'command', command: 'dev' }] }] } })],
  ]
  it.each(PLACES)('%s: never throws, and a file it passes converges and is taken back without a throw', (_place, at) => {
    for (const v of VALUES) {
      const file = at(v)
      const verdict = codexPlacementError(file)
      expect(verdict === null || typeof verdict === 'string').toBe(true)
      if (verdict !== null) continue
      const data = file as Record<string, unknown>
      const c = convergeCodexHooks(data, codexHooksBlock())
      expect(codexBlockState(c.data, codexHooksBlock()).state).toBe('current')
      // The developer's parts the block does not write are kept as they were.
      for (const [k, val] of Object.entries((data['hooks'] ?? {}) as Record<string, unknown>)) {
        if (!(k in codexHooksBlock())) expect((c.data['hooks'] as Record<string, unknown>)[k]).toEqual(val)
      }
      for (const [k, val] of Object.entries(data)) if (k !== 'hooks' && k !== 'PostToolUse') expect(c.data[k]).toEqual(val)
      const back = takeBackCodexHooks(c.data)
      expect(codexBlockState(back.data, codexHooksBlock()).state).toBe('none')
      hookPlaces(back.data['hooks'])
    }
  })
  it('names the place and what is there, in words, for each refusal', () => {
    expect(codexPlacementError([])).toMatch(/^the file is an array, not a JSON object/)
    expect(codexPlacementError({ hooks: [] })).toMatch(/^"hooks" is an array, not an object of events/)
    expect(codexPlacementError({ hooks: { Stop: {} } })).toMatch(/^"hooks\.Stop" is an object, not an array of groups/)
    expect(codexPlacementError({ hooks: { Stop: 'x' } })).toMatch(/^"hooks\.Stop" is a string "x"/)
    // What install does not write is never judged: Codex's verdict is Codex's.
    expect(codexPlacementError({ hooks: { Bogus: {} }, mcpServers: {}, description: 5 })).toBeNull()
    expect(codexPlacementError({ hooks: { Stop: [{ matcher: 'x' }, 'x', [null]] } })).toBeNull()
  })
})

describe("install's change as text edits: the developer's bytes stay", () => {
  const texts = [
    '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo dev","timeout":9223372036854775807}]}]}}\n',
    '{\r\n\t"hooks" :\t{ "Stop" : [\r\n\t\t{ "hooks" : [ {"type":"command",\t"command":"echo \\u00e9 \\ud83d\\ude00"} ], "x": 2.50 }\r\n\t] }, "description": "d"\r\n}',
    '{"hooks":{"PreToolUse":[{"hooks":[{"command":"echo devpre","type":"command"}],"matcher":"Bash"}],"Bogus":{"a":1,"a":2}}}',
  ]
  it.each(texts)('installing and taking back again gives the text back byte for byte: %j', (text) => {
    const data = JSON.parse(text) as Record<string, unknown>
    const read = { state: 'ok' as const, data, text }
    const installed = codexHooksTextFor(read, convergeCodexHooks(data, codexHooksBlock()).data)
    expect(installed).not.toBeNull()
    expect(codexBlockState(JSON.parse(installed!) as Record<string, unknown>, codexHooksBlock()).state).toBe('current')
    const back = JSON.parse(installed!) as Record<string, unknown>
    expect(codexHooksTextFor({ state: 'ok', data: back, text: installed! }, takeBackCodexHooks(back).data)).toBe(text)
  })
  const permissive = { appendAt: () => true, owns: () => true, ownString: () => false }
  it('refuses, returning no text, where the change is not a removal or an append where install appends', () => {
    expect(editJsonText('{"a":[1,2]}', { a: [1, 2, 3] }, { ...permissive, appendAt: () => false })).toBeNull()
    expect(editJsonText('{"a":["x","tc","y"]}', { a: ['x', 'y'] }, { ...permissive, appendAt: () => false, ownString: (s) => s === 'tc' })).toBe('{"a":["x","y"]}')
  })
  it('never edits inside an object holding a key twice', () => {
    expect(editJsonText('{"a":1,"a":1}', { a: 1, b: 2 }, permissive)).toBeNull()
  })
  it("never renders a value that is not the caller's own", () => {
    expect(editJsonText('{"hooks":{}}', { hooks: { Stop: [{ hooks: [{ command: 'dev' }] }] } }, { ...permissive, owns: () => false })).toBeNull()
  })
  it("refuses a plan that would take a developer's element out and put it back rendered anew", () => {
    // Allowed to render anything, the planner reaches the reordered target
    // by taking A out and appending it again; the final check sees A's own
    // text is gone and refuses.
    expect(editJsonText('[{"x":1},{"y":2}]', [{ y: 2 }, { x: 1 }], permissive)).toBeNull()
  })

  // The review's shape: a group an earlier build shared with a developer's
  // hook, and the developer's own copy of that hook beside it, each with a
  // number past 2^53 that a re-serialisation would round.
  const tc = codexHooksBlock()['Stop']![0]!.hooks[0]!.command
  const dev = '{"type":"command","command":"dev","timeout":9007199254740993}'
  const shared = `{"hooks":{"Stop":[{"hooks":[${dev},{"type":"command","command":${JSON.stringify(tc)}}]},{"hooks":[${dev}]}]}}\n`
  const none = new Set<string>()
  it("the review's shape: take-back and install keep each developer hook's own text, the number as written", () => {
    const data = JSON.parse(shared) as Record<string, unknown>
    const back = codexHooksTextFor({ state: 'ok', data, text: shared }, takeBackCodexHooks(data, none).data, none)
    expect(back).not.toBeNull()
    expect(back!.split('9007199254740993').length - 1).toBe(2)
    expect(back).not.toContain('9007199254740992')
    expect(back).toBe(`{"hooks":{"Stop":[{"hooks":[${dev}]},{"hooks":[${dev}]}]}}\n`)
    const installed = codexHooksTextFor({ state: 'ok', data, text: shared }, convergeCodexHooks(data, codexHooksBlock(), none).data, none)
    expect(installed).not.toBeNull()
    expect(installed!.split('9007199254740993').length - 1).toBe(2)
    expect(installed).not.toContain('9007199254740992')
  })

  // A seeded generator, a fixed number of files, no clock: developer
  // groups (duplicated, mixed with treecontext's hooks, numbers past 2^53,
  // floats, escapes, spacing) and treecontext's groups in every position.
  // Install then take-back: wherever the editor answers, every developer
  // value's own text comes through, and the file parses to the plan.
  it('install then take-back over generated files keeps every developer value as written, or changes nothing', () => {
    let seed = 0x5eed
    const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
    const pick = <T,>(xs: readonly T[]): T => xs[rnd(xs.length)]!
    const block = codexHooksBlock()
    const events = Object.keys(block)
    const devHook = (): string => pick([
      '{"type":"command","command":"dev-a"}', '{"command":"dev-b","type":"command","timeout":9007199254740993}',
      '{"type":"command","command":"echo \\u00e9","x":2.50}', '{ "type" : "command" ,\t"command" : "dev-c" }',
    ])
    const tcHook = (e: string): string => JSON.stringify(block[e]![0]!.hooks[0]!)
    const group = (e: string): string => {
      const hooks = Array.from({ length: 1 + rnd(3) }, () => (rnd(3) === 0 ? tcHook(e) : devHook()))
      return `{${rnd(2) === 0 ? '"matcher":"m",' : ''}"hooks":[${hooks.join(pick([',', ', ', ',\n  ']))}]}`
    }
    let answered = 0
    for (let k = 0; k < 300; k++) {
      const evs = events.filter(() => rnd(3) === 0)
      const body = evs.map((e) => {
        const gs = Array.from({ length: 1 + rnd(3) }, () => group(e))
        if (rnd(4) === 0) gs.push(gs[0]!)
        if (rnd(3) === 0) gs.splice(rnd(gs.length + 1), 0, JSON.stringify(block[e]![0]))
        return `${JSON.stringify(e)}:${pick([' ', '\n', ''])}[${gs.join(pick([',', ',\n    ']))}]`
      }).join(',\n  ')
      const text = `{${rnd(2) === 0 ? '"description":"d",' : ''}"hooks":{${body}}}${pick(['\n', ''])}`
      const data = JSON.parse(text) as Record<string, unknown>
      const plan = convergeCodexHooks(data, block, none)
      if (!plan.changed) continue
      const installed = codexHooksTextFor({ state: 'ok', data, text }, plan.data, none)
      // A refusal changes nothing, which is allowed (the editor refuses
      // shapes it cannot reach by removals and appends, such as an earlier
      // build's hook inside a group with a matcher of the developer's).
      if (installed === null) continue
      answered++
      expect(canonicalJson(JSON.parse(installed)), text).toBe(canonicalJson(plan.data))
      const ownString = (s: string): boolean => isTreecontextCodexHook(s, none)
      const ownPart = (v: unknown): boolean => codexOwnPart(v, none)
      expect(developerTextSurvives(text, parseSpans(text), installed, ownString, () => true, ownPart), text).toBe(true)
      const back = JSON.parse(installed) as Record<string, unknown>
      const out = codexHooksTextFor({ state: 'ok', data: back, text: installed }, takeBackCodexHooks(back, none).data, none)
      if (out === null) continue
      expect(developerTextSurvives(text, parseSpans(text), out, ownString, () => true, ownPart), `${text}\n->\n${out}`).toBe(true)
    }
    // Not vacuous: most generated files take the change (119 of the 300 at
    // this seed; the rest need no change or are refused).
    expect(answered).toBeGreaterThan(100)
  })
})
