# Adversarial review of the treecontext feature files

**Date:** 2026-07-31 · **Repo:** working tree @ `e431a70` + uncommitted waves
**Scope:** all 22 `.feature` files, 193 scenarios (42 in the `wip` debt register)
**Method:** attack the specs, not the code — overpromises vs shipped behavior, underpromises,
unbindable `Then`s, scenarios that pass while the promise fails, charter-vs-binding drift,
uncovered surface. Claims were verified by reading `src/` and, where the answer was contested,
by running a probe against a real store.

**For the reviewing agent:** findings are ranked by severity. F1 is a design contradiction
requiring an owner ruling, not a bug with an obvious fix — please attack that framing first.
Everything below is reproducible; §"How to reproduce F1" gives a runnable probe.

---

## F1 — "full" means two different things in two layers of spec, and demotion lives in the gap

**Severity: high. Requires an owner ruling, not just a patch.**

Two layers of specification disagree about whether the store may silently destroy captured
content, and each layer's tests pass because each tests its own meaning of "full".

The **journal charter** (owner language, `tests/journal/`) promises content is never silently lost:

| File | Scenario | Promise | Bound? |
|---|---|---|---|
| `journal-storage` | only an explicit command destroys content | "every entry ever captured is either live, or archived with a tombstone" | **bound** |
| `journal-recall` | a hit on conversational text returns the whole message | "each full text is returned with no truncation" | **bound** |
| `journal-capture` | outputs of execution and external tools are kept in full | "the full output is retrievable from the journal" | **bound** |
| `journal-capture` | an oversized non-re-derivable event keeps its full content | "the full content is retrievable" | **bound** |

The **pin suites** (implementation language) specify the opposite, deliberately:

- `tests/flat-store-c4-read-view.feature:39` — *"a demoted full-fidelity row returns whole with
  no marker and stays findable"* → "the hit returns the demoted content **in full** with no marker".
  Here "in full" means *all of whatever stump survives*, not *the whole event*.
- `tests/persistence/retention-demotion.feature` header — *"a demoted row stays query-findable
  exactly as it was pre-demotion (the FTS index never covered the truncated tail in the first place)."*

That parenthetical was true before the index-cap expansion. It is false now, and
`demoteOverBudget`'s own docstring says so:

> "for post-018 rows, whose index view is wider than the demotion floor, findability narrows to
> that floor — the budget valve wins over the widened view."

**Mechanism.** `isProtected` (`src/flat-store.ts:155`) never consults **role** — only
`source_label !== 'auto-capture'`, `decay_exempt`/`read_only`, and `next_session`/`status`
metadata. So auto-captured user prose and tool output are both demotable. `demotionTextFor`
(`src/persistence/index-text.ts:66`) pushes `INDEX_CAP_USER` (2000) into its bounds for
`role: 'user'` and takes the **min** — so even a hook capture whose `_index_len` was stamped to
the full length (`user-prompt-submit.ts` stamps `min(activeIndexCap('user'), len)` = `len`)
shrinks to 2000 chars of *stored* content.

The missing marker is a second-order effect: after demotion `_index_len === content.length`, so
`boundaryOf`'s `len < contentLength` test fails, `displayLenOf` returns null, and
`presentContent` returns the stump **as if it were whole**.

### How to reproduce F1

Save as `demote-probe.mts` in the repo root, run `npx tsx demote-probe.mts`:

```ts
import BetterSqlite3 from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wrapBetterSqlite } from './src/persistence/better-sqlite.js'
import { FlatStore } from './src/flat-store.js'

const dir = mkdtempSync(join(tmpdir(), 'tc-demote-probe-'))
const dbPath = join(dir, 'j.db')
const noise = (n: number) => randomBytes(n).toString('base64').slice(0, n)
const DIRECTIVE = 'NEVERDELETEPRODWITHOUTBACKUPmarker9931'

const store = await FlatStore.open({
  database: wrapBetterSqlite(new BetterSqlite3(dbPath)),
  ownsDatabase: true, retentionInterval: 1_000_000, maxStoreBytes: 8_192,
})
// Shaped exactly as user-prompt-submit.ts stages a capture: full content,
// _index_len stamped to the FULL length.
const long = `deploy pipeline preamble ${noise(6000)} closing line ${DIRECTIVE}`
const { nodeId } = await store.insert(long, {
  metadata: { source: 'auto-capture', role: 'user', session_id: 's-probe', _index_len: long.length },
})
for (let i = 0; i < 10; i++) {
  await store.insert(`bulk ${noise(3000)}`, {
    metadata: { source: 'auto-capture', role: 'tool', session_id: `s-bulk${i}`, _index_len: 3000 },
    createdAt: 1_700_000_000 + i,
  })
}
console.log('findable BEFORE:', (await store.query(DIRECTIVE, {topK:5})).some(h=>h.nodeId===nodeId))
console.log('sweep:', JSON.stringify(store.retentionSweep()))
console.log('findable AFTER :', (await store.query(DIRECTIVE, {topK:5})).some(h=>h.nodeId===nodeId))
const hit = (await store.query('deploy pipeline preamble', {topK:5})).find(h=>h.nodeId===nodeId)!
console.log('hit length:', hit.content.length, '| marker:',
  /preview; full content \d+ chars via treecontext_export/.test(hit.content))
const full = (JSON.parse(store.exportJson({ nodeId })) as {nodes:{content:string}[]}).nodes[0]!.content
console.log('EXPORT length:', full.length, '(was', long.length + ')')
const raw = new BetterSqlite3(dbPath, { readonly: true })
console.log('tombstones recording the loss:', (raw.prepare(
  "SELECT COUNT(*) AS n FROM nodes WHERE content LIKE '%capture gap%' OR content LIKE '%archive%'"
).get() as {n:number}).n)
raw.close(); store.close(); rmSync(dir, { recursive: true, force: true })
```

Observed:

```
findable BEFORE: true
sweep: {"evicted":0,"demoted":11}
findable AFTER : false
hit length: 2000 | marker: false
EXPORT length: 2000 (was 6077)
tombstones recording the loss: 0
```

The closing directive is gone from the store. The hit looks complete. `treecontext_export` —
the charter's escape hatch — returns only the stump. Nothing records the loss.

This re-creates verbatim the history `journal-storage`'s own header cites as the reason the file
exists: *"for most of this project's life the 'full journal' was a myth (only previews were
stored) and nobody could tell, because the store looked full from the outside."*

### Owner ruling needed

1. **Is demotion allowed to destroy content at all?** If yes, the four charter promises above
   need explicit qualification (and `journal-storage`'s "only an explicit command destroys
   content" is simply false as written). If no, demotion must archive-before-shrinking the way
   eviction already does, or be restricted to rows whose tail was never indexed.
2. **Should `isProtected` consult role?** Conversational roles are described in `journal-recall`
   as "sacred: lowest volume, highest authority" — yet they are demotable and tool bulk is not
   preferred over them.
3. **Should a demoted row carry a marker?** Currently it cannot, by construction. Retaining the
   pre-demotion length in metadata would let `presentContent` keep advertising the loss.

---

## F2 — the three scenarios that should have caught F1 are each structurally unable to fail

This is the more alarming half: the defect is not merely uncovered, it is covered by three
scenarios that cannot reach it.

**(a) `journal-storage` "only an explicit command destroys content"** —
`tests/journal/features.test.ts:1275` sets up "a store that has run valves, vacuums, and
migrations for months" via `openValveStore(w, { maxSessions: 1 })` with **no `maxStoreBytes`**,
so it inherits the 64 MB default while the fixture writes ~14 KB. `demoteOverBudget` never fires;
only the eviction path runs, which archives and tombstones honestly.
*The assertion is sound* — `live.includes(c)` is exact-match, so a demoted prefix would fail it.
**The fixture is the hole. Passing a tight `maxStoreBytes` should turn this red immediately.**

**(b) `retention-demotion` "a demoted row is query-findable exactly as before demotion"** —
`tests/persistence/retention-demotion.test.ts:41` inserts with
`metadata: { source, role: 'user', session_id }` and **no `_index_len`** — a pre-expansion legacy
row shape the current capture path no longer produces. For that shape the index view was already
2000 chars, so demotion genuinely doesn't narrow it. Compounding it, the probe term
`withinCapTerm` is the **first token of the content**, guaranteed to survive any truncation; the
scenario never probes a beyond-cap term (unlike `fts-dual-cap.feature`, which correctly probes
both sides). Two independent reasons it cannot fail.

**(c) `flat-store-c4-read-view` "a demoted full-fidelity row … stays findable"** — asserts
"findability is unchanged from before demotion" on the same pre-expansion assumption.

---

## F3 — `journal-search-modes` "a present embedding model changes nothing until asked" is bound to an unestablishable Given

`tests/journal/features.test.ts:1600` simulates *"a store where an ONNX model is installed and
reachable"* by writing **64 random bytes** to `<tmp>/.treecontext/models/all-MiniLM-L6-v2/model.onnx`
— a tree-era path no code in this build reads (`src/embeddings/` was deleted). The assertion
"results are identical" is trivially true and would pass identically if the file were never
written. The `onnxruntime` require-cache check is also guaranteed, since onnxruntime is not a
`src/` dependency at all (bench-only).

If a dense path were reintroduced that auto-activated on a present model — precisely the
regression this scenario exists to prevent — **it would stay green**.

*Recommendation:* move it to `wip` beside the dense scenario, or rewrite the Given to name the
real activation path.

---

## F4 — high-DF query-token pruning is entirely unspecced

`FlatStore.pruneHighDfTokens` drops query tokens whose document frequency exceeds
`DF_PRUNE_FRACTION` of the corpus (above `DF_PRUNE_MIN_DOCS` = 256), via a lazily-created temp
`fts5vocab` table. It is a **non-optional read-time transformation of the user's query**, and it
already caused a measured recall regression during development ("I" alone surviving and matching
nothing — guarded by a fallback, per the cleanup close-out).

No scenario in any of the 22 files mentions pruning, stopwords, or document frequency.
`journal-search-modes`'s subtitle is *"every knob a read-time choice"* — this knob is invisible
and unchoosable.

*Recommendation:* add a scenario pinning the safety property — **pruning never removes a hit the
unpruned query would have returned** — plus the documented fallbacks (all-high-DF, all-df-0,
sub-256-doc corpora, read-only stores where vocab creation fails and pruning disables for the
store's lifetime).

---

## F5 — `mergeFromNamespace` strips protection, which feeds F1

`src/flat-store.ts:1016` hardcodes `decayExempt: false` and `utilityScore: 0.5` on every merged
node, and takes `readOnly` from the merge options rather than the source row. Merging a
decay-exempt (protected) entry into the trunk therefore **strips its protection** — and per F1,
unprotected auto-capture rows are demotable. A subagent's protected finding can be merged into
the trunk and then silently truncated by a later budget sweep.

Separately, and as `journal-namespaces` itself predicts in a comment, the merge copies
`metadata` verbatim and never stamps source-namespace provenance. The file registers this
honestly (whole-feature `wip`), so it is debt, not drift — but the charter does not note the
knock-on: `journal-namespaces`'s "merged provenance is filterable and weightable at query time"
depends on `_namespace`, which is stamped by the **server on insert**
(`src/server/server.ts:306`) with the *writing* server's tag. So the filter appears to work for
server-written entries by accident and fails for library-written ones.

---

## F6 — stale tree-era documentation on exported library surface

`src/server/server.ts:50-57`, the TSDoc on the **exported** `CreateServerOptions`:

```
 *   - 'full' (default): all 11 tools
 *   - 'read_only': query/status/checkpoint/export only
 *   - 'contributor': adds insert/update_summary/feedback but still
 *     forbids delete/clear/import
```

Reality: 8 tools; `read_only` = query/status/export; `contributor` = + insert. `checkpoint`,
`update_summary` and `feedback` no longer exist. This ships in the `.d.ts` to library consumers.

`journal-agent-surface`'s "tool schemas describe only what the backend does" guards MCP **tool
schemas**; nothing guards the library's own TSDoc, which is the channel a library consumer reads.

---

## F7 — cross-charter tension on tool-surface membership

`journal-agent-surface` "the tool surface is exactly the ruled set" asserts "the eight journal
tools and no others are present", unqualified. `journal-policy` says a tier's excluded tools are
**absent**, so the registered set is 3 under `read_only` and 4 under `contributor`. Both are
correct about their own case; neither cross-references the other, and the agent-surface wording
reads as a universal. Suggest qualifying it with "under the full policy".

---

## F8 — `journal-install` (owner has still not reviewed its wording)

Strong file overall. "The dry run is the whole plan" and "nothing the installer writes invokes a
bare interpreter" are both well-formed and strongly bindable. Two issues:

- **Gap:** no failure-mode scenario for an **unwritable / permission-denied** agent config. The
  file's whole thesis is "what it refuses to break", and `journal-storage` has the analogous
  "a full disk fails loudly and corrupts nothing".
- **Binding hazard:** "every failing check is accompanied by the command that fixes it" is
  universally quantified over the doctor check registry. Its binding must **enumerate** the
  registry, not sample it, or it will rot the moment a check is added. Worth stating in the
  scenario comment before it binds.

---

## F9 — pattern: 31 of 193 scenarios have a `Then` with no `When`

The action is buried in the `Given`. Concentrated in `journal-storage` (7),
`journal-agent-surface` (7), `journal-media` (4), `journal-capture` (4), `journal-policy` (3),
`journal-namespaces` (2). Often defensible — for "Given an event that fails ingestion after
retries", the failure *is* the action — but it hides the trigger and makes the moment of
observation ambiguous.

`tests/feature-guards.test.ts` lints dialect, binding, tags, and linter/executor title agreement;
it does not lint scenario structure. Owner call whether to add it.

---

## Checked and cleared (recorded so the next reviewer doesn't re-derive them)

- **`--policy read_only` vs `--read-only` both disable ingestion.** `captureEnabled(opts.capture,
  effectivePolicy)` gates on the derived policy (`server.ts:996`), and
  `effectivePolicy = policy ?? (readOnly ? 'read_only' : DEFAULT_POLICY)`. Not a gap.
- **A read-only server does not run retention sweeps.** The sweep is insert-triggered (every 50
  inserts, `retentionInterval`), not timer-driven, and a read-only server accepts no inserts. So
  "a reader must not quietly become one of its writers" holds.
- **`treecontext_checkpoint_all` / `action_required` in the SessionStart hook text** come from a
  **stale locally-installed build**, not from `src/`. Not a defect in this tree. (It does
  illustrate that installed hook text lags the binary until reinstall.)
- **`docs/runbook-dead-letter.md` and `docs/schema.md`** appearing as unresolvable doc paths are
  synthetic strings inside `bench/fixtures/code-sessions.ts` corpus data, not real citations.

---

## Coverage and what remains

**Reviewed in depth:** `journal-recall`, `journal-storage`, `journal-capture`,
`journal-search-modes`, `journal-install`, `journal-namespaces`, `journal-policy`,
`journal-agent-surface`, `retention-demotion`, `flat-store-c4-read-view`, `fts-dual-cap`,
`user-prompt-fidelity`, plus structural analysis across all 22 files and the `wip` register.

**Reviewed at header/scenario-title level only** — a second pass should read their bindings:
`journal-media`, `journal-library`, `flat-store-dedup`, `flat-store-role-weights`,
`flat-store-conversation-window`, `tool-event-fidelity`, `ingestion-fidelity`,
`role-weighted-fts`, `content-codec`, `stop.feature`.

**Deliberately not attempted:** verifying the 42 `wip` scenarios against shipped behavior
(they are registered debt, not claims); and any judgement about whether the `wip` register's
*reasons* are still accurate — several cite blockers ("needs an in-process MCP harness") that
later waves removed, and the register notes this inline in some places but may be stale in others.

## Suggested order of work

1. Owner ruling on F1 (design question — everything else in F1/F2 follows from it).
2. Fix F2(a) fixture first: it is one line and should turn red, proving F1 without ceremony.
3. F3 and F4 are independent and cheap.
4. F5, F6, F7 are small correctness/wording fixes.
5. F8, F9 are owner calls on charter wording and lint policy.
