/**
 * The mature journal's shape (D266): constants, vocabularies, the seeded
 * generator and the shell-event templates. Pure data and pure functions,
 * no vitest and no I/O, so the charter suite (tests/helpers/mature-journal.ts)
 * and the bench arm (bench/arms/mature-journal.ts) build the same journal
 * from one spelling. Changing anything here changes the corpus both read:
 * the arm's provenance hash covers the texts and kinds a build reports
 * (and so whatever here changes them), and the journal scenarios re-seed.
 */

// ── Shape (one place) ─────────────────────────────────────────────────

export const MATURE = {
  seed: 0x5eed_2026,
  /** Day offsets of the sessions, oldest first; one session per day. */
  sessionDays: [0, 1, 3, 4, 6, 8],
  /** The newest session starts this many days before "now". */
  newestDaysAgo: 1,
  turnsPerSession: 5,
  shellEventsPerTurn: 8,
  /** Concurrent hook subprocesses. */
  spawnLimit: 12,
} as const

export const ORIENTATION_QUERY = 'what was I working on, what was the next step'

/** The oldest session's opening developer turn: the strongest lexical
 *  match for the orientation query in the whole journal, on a thread
 *  long since finished (the recency scenario's old twin). */
export const OLD_THREAD =
  'Working on the ingestion valve refactor. Next step was tombstone ordering; next step after that, the budget report. Working through it step by step — refactor complete.'

/** The newest session's chapter checkpoint: the latest active thread. */
export const FRESH_PLAN = 'PLAN: working on the release checklist; next step is the signing-key rotation'

/** A word that appears in exactly one shell event's output, nowhere else. */
export const SHELL_ONLY_TERM = 'kestrelfault4471'

export interface Topic {
  name: string
  area: string
  files: string[]
  words: string[]
  decision: string
  finding: string
  checkpoint: string
  bookmark: string
}

export const TOPICS: Topic[] = [
  {
    name: 'ingestion valve', area: 'server', files: ['src/server/ingestion.ts', 'src/persistence/store.ts'],
    words: ['valve', 'drain', 'staging', 'batch', 'claim', 'dead-letter', 'poison', 'backlog'],
    decision: 'DECISION: the drain claims staging rows in batches of fifty and dead-letters a row after three failed attempts.',
    finding: 'FINDING: backlog drains kept honest chronology only after created_at came from the hook, not the drain clock.',
    checkpoint: 'CHAPTER: ingestion valve refactor landed. Next step: tombstone ordering, then the budget report.',
    bookmark: 'Working on the valve refactor; merged and green. Next step: tombstone ordering in the retention sweep.',
  },
  {
    name: 'tombstone ordering', area: 'retention', files: ['src/flat-store.ts', 'src/persistence/backup.ts'],
    words: ['tombstone', 'archive', 'eviction', 'sweep', 'fsync', 'budget', 'session', 'retention'],
    decision: 'DECISION: the sweep archives a whole session and fsyncs the archive before any row moves; tombstones follow.',
    finding: 'FINDING: eviction without an archive destination must demote and refuse, never delete.',
    checkpoint: 'CHAPTER: tombstone ordering done, archive before tombstone before delete. Next step: the budget report.',
    bookmark: 'Working on retention; the suite is green. Next step: the budget report in the status panel.',
  },
  {
    name: 'budget report', area: 'status', files: ['src/server/server.ts', 'src/server/status-panel.ts'],
    words: ['budget', 'gauge', 'bytes', 'panel', 'status', 'over_budget', 'valve', 'report'],
    decision: 'DECISION: the status panel reports store bytes against the budget from the same byte gauge the valve reads.',
    finding: 'FINDING: LENGTH() on TEXT counts characters, so the byte gauge casts content to BLOB.',
    checkpoint: 'CHAPTER: budget report shipped in status. Next step: audit the hook payload shapes.',
    bookmark: 'Working on the budget gauge; it reads bytes now. Next step: audit the PostToolUse payload shapes.',
  },
  {
    name: 'hook payload shapes', area: 'hooks', files: ['src/hooks/post-tool-use.ts', 'src/hooks/shared.ts'],
    words: ['payload', 'tool_response', 'preview', 'tail', 'boundary', 'hook', 'staging', 'transcript'],
    decision: 'DECISION: the hook reads tool_response before tool_output; the flagship platform sends only the former.',
    finding: 'FINDING: a shielded output never enters the full tail; the file pointer is its full-fidelity copy.',
    checkpoint: 'CHAPTER: payload shapes pinned against live probes. Next step: a replay guard for the migration ladder.',
    bookmark: 'Working on payload probes; recorded. Next step: replay-safe guards for the migration ladder.',
  },
  {
    name: 'migration ladder', area: 'persistence', files: ['src/persistence/migrations.ts', 'src/persistence/migrations/guards.ts'],
    words: ['migration', 'ladder', 'additive', 'destructive', 'backup', 'verdict', 'schema', 'replay'],
    decision: 'DECISION: every additive migration tolerates marker-rollback replay through the shared guards.',
    finding: 'FINDING: VACUUM INTO renumbers rowids of tables without an integer primary key; copy files for fixtures.',
    checkpoint: 'CHAPTER: migration ladder guarded and verdict-checked. Next step: the release checklist.',
    bookmark: 'Working on the ladder; the replay guard is merged. Next step: draft the release checklist.',
  },
  {
    name: 'release checklist', area: 'release', files: ['package.json', 'CHANGELOG.md'],
    words: ['release', 'checklist', 'signing', 'tarball', 'manifest', 'provenance', 'changelog', 'publish'],
    decision: 'DECISION: the release tarball is built from a clean checkout and its manifest compared with the ship list.',
    finding: 'FINDING: the provenance attestation needs the signing key rotated before the publish job runs.',
    checkpoint: FRESH_PLAN,
    bookmark: 'Working on the release; the manifest matches the ship list. Next step: rotate the signing key.',
  },
]

export const FILLER = [
  'the', 'store', 'journal', 'row', 'index', 'query', 'column', 'weight', 'content', 'metadata', 'node',
  'session', 'test', 'suite', 'scenario', 'binding', 'fixture', 'helper', 'module', 'function', 'error',
  'result', 'value', 'option', 'config', 'path', 'file', 'line', 'check', 'case', 'update', 'insert', 'delete',
]

/** Developer turns and assistant turns are English, as they are in a
 *  real journal: the function words of the orientation query ("what",
 *  "was", "I", "on", "the") are everyday words of a conversation, not
 *  words only an echo of that query carries. `{w}` is a topic word,
 *  `{f}` a file of the topic. */
export const PROMPTS = [
  'I think the {w} is wrong here. What was the reason we kept the {w} path?',
  'Can you check what the {w} does when the {w} is empty? I was seeing errors from {f}.',
  'Let us fix the {w} first. I want the suite green before we touch the {w}.',
  'What happens to the {w} if the {w} fails halfway through?',
  'OK, that was it. Commit it and move on to the {w}.',
  'I do not like the {w} name. What would you call it?',
  'Run the tests for {f} again, I think one of them was flaky.',
  'OK, what is the next step for the {w}?',
  'I was working on the {w} in {f} before lunch. Can you pick it up from there?',
  'What was the {w} doing on the last run?',
]
export const SAID = [
  'I changed the {w} so the {w} runs first. The suite is green; what was failing was the {w} fixture in {f}.',
  'I traced it: the {w} was reading the {w} before the {w} landed. Fixed in {f} and tested.',
  'Done. I updated {f} and the tests pass. The {w} was the only caller of the {w}.',
  'I could not reproduce the {w} failure; it was the stale {w} in the fixture. I rebuilt it.',
  'The {w} now checks the {w} up front. I left a comment in {f} on what it guards against.',
]

// ── Seeded generator ──────────────────────────────────────────────────

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class Gen {
  private readonly rnd: () => number
  constructor(seed: number) { this.rnd = mulberry32(seed) }
  int(n: number): number { return Math.floor(this.rnd() * n) }
  rnd01(): number { return this.rnd() }
  pick<T>(xs: readonly T[]): T { return xs[this.int(xs.length)]! }
  hex(n: number): string { let s = ''; for (let i = 0; i < n; i++) s += '0123456789abcdef'[this.int(16)]; return s }
  /** Fill a template's `{w}` (topic words) and `{f}` (topic files). */
  fill(t: Topic, template: string): string {
    return template.replace(/\{w\}/g, () => this.pick(t.words)).replace(/\{f\}/g, () => this.pick(t.files))
  }
  sentence(t: Topic, len: number): string {
    const out: string[] = []
    for (let i = 0; i < len; i++) out.push(this.rnd() < 0.45 ? this.pick(t.words) : this.pick(FILLER))
    return out.join(' ')
  }
}

export function shellEvent(g: Gen, t: Topic, k: number, turn: number, i: number): { toolName: string; input: Record<string, unknown>; response: unknown } {
  const n = turn * 100 + i
  const kind = i % 6
  const file = t.files[i % t.files.length]!
  const lines = (count: number, f: (j: number) => string): string => Array.from({ length: count }, (_, j) => f(j)).join('\n')
  if (kind === 0) {
    // A test run: the bulk of a real journal.
    const out = lines(30 + g.int(25), (j) =>
      j % 9 === 0
        ? ` ✓ tests/${t.area}/${t.words[j % t.words.length]}.test.ts (${3 + g.int(20)} tests) ${50 + g.int(900)}ms`
        : j % 17 === 5 ? `   ✓ what happens when the ${g.pick(t.words)} is empty ${g.int(40)}ms`
        : `   ✓ ${g.sentence(t, 6 + g.int(6))} ${g.int(40)}ms`) +
      `\n\n Running on node 22 with ${g.int(16) + 1} workers\n Test Files  ${8 + g.int(5)} passed\n      Tests  ${120 + g.int(80)} passed\n   Duration  ${(2 + g.rnd01()).toFixed(2)}s`
    return { toolName: 'Bash', input: { command: `npx vitest run tests/${t.area} --reporter=dot -t "${t.words[n % t.words.length]} ${n}"`, description: 'Run the area tests' }, response: bash(out) }
  }
  if (kind === 1) {
    // History: commit subjects in the developer's words, the orientation
    // query's own among them ("working on", "next step").
    const out = lines(12 + g.int(6), (j) => {
      const subj = j === 0 && n % 3 === 0
        ? `wip: working on ${t.name}, next step ${g.pick(t.words)}`
        : j === 1 && n % 2 === 0 ? `fix: the ${g.pick(t.words)} was ${g.pick(['off by one', 'read twice', 'never flushed', 'racing the drain'])}` : `${g.pick(t.words)}: ${g.sentence(t, 5 + g.int(5))}`
      return `${g.hex(7)} ${subj}`
    })
    return { toolName: 'Bash', input: { command: `git log --oneline -n ${12 + n} -- ${file}`, description: 'Recent history' }, response: bash(out) }
  }
  if (kind === 2) {
    // A source read: code with TODO comments in the same vocabulary.
    const content = lines(40 + g.int(30), (j) =>
      j === 7 && n % 4 === 1
        ? `${j + 1}\t  // TODO next step: ${g.sentence(t, 6)} (working on it in ${t.name})`
        : j === 3 && n % 2 === 0 ? `${j + 1}\t  // what this was guarding: ${g.sentence(t, 6)}`
        : `${j + 1}\t  ${g.pick(['const', 'if (', 'return', 'await', 'export function', 'for (const'])} ${g.pick(t.words).replace(/[^a-z]/g, '')}${g.int(9)} = ${g.pick(FILLER)}(${g.pick(t.words).replace(/[^a-z]/g, '')})`)
    return {
      toolName: 'Read',
      input: { file_path: `/home/dev/project/${file}`, offset: 1 + n * 40, limit: 80 },
      response: { type: 'text', file: { filePath: `/home/dev/project/${file}`, content, numLines: 80, startLine: 1 + n * 40, totalLines: 2400 } },
    }
  }
  if (kind === 3) {
    const word = t.words[n % t.words.length]!.replace(/[^a-z_]/g, '')
    const content = lines(10 + g.int(10), (j) => `${t.files[j % t.files.length]}:${10 + g.int(2000)}:    ${g.sentence(t, 7)} ${word}`)
    return {
      toolName: 'Grep',
      input: { pattern: `${word}${n}|${word}`, path: 'src', output_mode: 'content', '-n': true },
      response: { mode: 'content', numFiles: t.files.length, filenames: [], content, numLines: content.split('\n').length },
    }
  }
  if (kind === 4) {
    const out = `On branch ${t.area}-${k}\nChanges not staged for commit:\n` +
      lines(4 + g.int(6), () => `\tmodified:   ${g.pick(t.files)}`) + `\n\n${lines(6, () => g.sentence(t, 10))}`
    return { toolName: 'Bash', input: { command: `git status --short && git diff --stat HEAD~${n}`, description: 'Working tree' }, response: bash(out) }
  }
  const out = lines(20 + g.int(15), () => `${g.pick(t.files)}  ${g.int(300)}:${g.int(80)}  warning  ${g.sentence(t, 8)}`) +
    (k === 2 && turn === 1 && i === 5 ? `\nerror  ${SHELL_ONLY_TERM}: the gauge read a negative byte count` : '')
  return { toolName: 'Bash', input: { command: `npm run lint -- --max-warnings ${n} ${file}`, description: 'Lint' }, response: bash(out) }
}

export function bash(stdout: string): Record<string, unknown> {
  return { stdout, stderr: '', interrupted: false, isImage: false }
}

