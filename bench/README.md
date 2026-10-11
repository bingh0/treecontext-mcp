# bench — retrieval regression reporting

**This reports. It does not gate.** No run fails a build, no threshold
blocks a merge. It exists so that a change which quietly wrecks retrieval
quality shows up as a line in a report instead of as a user complaint six
weeks later.

```bash
npm run bench                          # every arm, full corpora, recorded
npm run bench -- --arm lme-s-questions
npm run bench -- --max 25 --no-record  # quick smoke, nothing written
```

Five companion instruments answer questions the regression series cannot;
none of them writes to `history.jsonl`:

```bash
npm run bench:compare  -- --arm code-fixture --b onnx --fused   # retriever A/B, paired
npm run bench:capsweep -- --arm lme-s-questions --split both    # what an index cap costs in recall
npm run bench:capcost  -- --source v2 --caps 1500,8000,full     # what removing one costs in bytes/ms
npm run bench:weights  -- --arm mature-journal                   # what a role weight costs, per slice
npm run bench:recency                                            # what the recency weight costs, per slice
```

## Why not a gate

A gate that fires on a legitimate ranking change gets edited under
deadline pressure, and the second time it happens it gets deleted. A
report that nobody has to argue with survives. If gating is ever wanted,
it should be a deliberate decision with a rebaseline protocol attached —
not a default that decays.

## What the numbers mean

Retrieval here is deterministic: the same corpus and the same code produce
the same figure, byte for byte. So run-to-run variation is not noise, and
the error bar is not a noise threshold in the usual sense. It is a
**scale reference** — a statement of how large a difference is, relative
to the precision of the measurement, and therefore whether it deserves
anyone's attention.

Two errors are reported, and they answer different questions:

- **SE (query bootstrap)** — resamples individual queries. This sets the
  advisory band, three standard errors below the run.
- **Cluster SE** — resamples whole ability categories. Much wider, because
  the categories genuinely differ from each other (100% on
  single-session questions, 84% on multi-session). Use it when
  generalizing the headline number to a different mix of questions; do
  **not** use it to read run-to-run movement, or a genuinely alarming drop
  will sit inside the band.

The **per-slice table is always reported and never gated.** An aggregate
that holds steady while one category collapses is a real failure mode this
project has already had once — a recorded agent-source bias of 0.61 vs
0.11 recall — and it is invisible in a mean.

## Falsification — does this thing actually work?

A regression report that has never caught anything is a decoration.

```bash
npm run bench:falsify              # all mutations, full corpus (~4 min)
npm run bench:falsify -- --max 150 # faster, still meaningful
```

It runs the arm clean, then re-runs it once per deliberate defect and asks
the same detector the report uses whether it notices. Unlike `bench`, this
command **exits non-zero when the detector gets an answer wrong** — a
failing bench run would mean the product regressed; a failing falsify run
means the bench cannot be trusted to tell us when it does.

Both directions are checked. A defect must be seen; a harmless change must
not be. Latest full run, all eight correct:

| mutation | expect | seen | aggregate Δ |
| --- | --- | --- | ---: |
| `identity` | no-flag | nothing | +0.00pp |
| `whitespace-normalize` | no-flag | nothing | +0.00pp |
| `index-preview-only` | flag-aggregate | aggregate, 10.6 SE | −22.16pp |
| `rank-collapse` | flag-aggregate | aggregate, 5.8 SE | −10.01pp |
| `topk-clip` | below-sensitivity | nothing | −4.53pp |
| `query-drop-short-terms` | no-flag | nothing | −0.80pp |
| `query-drop-rare-terms` | flag-aggregate | aggregate, 8.3 SE | −17.21pp |
| `subgroup-collapse` | flag-slice | slice only, 4.7 SE | −4.46pp |

Two of those expectations were **corrected by measurement**, which is the
point of running it rather than reasoning about it:

- `query-drop-short-terms` was expected to be a defect. It costs 0.80pp.
  BM25 already discounts short low-IDF words, so losing them barely
  matters — a property of the ranker worth knowing, now recorded rather
  than assumed. `query-drop-rare-terms` is its complement and costs 17pp.
- `subgroup-collapse` was expected to move the headline number. It doesn't
  — 2.9 SE, under the line — while the affected slice moves 4.7 SE. The
  per-slice table is a detector, not a decoration.

## Sensitivity, stated rather than implied

At n=470 with SE ≈ 1.0%, a 3-SE rule resolves a drop of about **4.2pp**.
Anything smaller passes unnoticed, and `topk-clip` is kept in the suite
precisely to measure that floor: it is a genuine defect at −4.53pp that
the aggregate cannot distinguish from noise.

The two ~4.5pp mutations are worth comparing. `subgroup-collapse` is
caught and `topk-clip` is not, at the same aggregate magnitude, because
the first concentrates its damage in one category and the second spreads
it evenly. **Concentrated failures are detectable below the aggregate's
resolution; diffuse ones are not.** Raising sensitivity means more
queries, not a smaller sigma.

`tests/bench/detector.test.ts` guards the arithmetic underneath all of
this and runs in `npm test`, with no corpus download.

## Provenance, and why every field is there

Each record in `history.jsonl` carries the corpus checksum, the slice
rule, the mapping version, the code revision, and the SQLite version. That
is not bureaucracy:

- **corpus sha256** — a number computed over different bytes is a
  different number. The checksum is pinned in the arm; a mismatch is
  called out loudly in the report rather than silently absorbed.
- **slice rule** — "470 of 500, non-abstention" is a decision, not a fact.
  Written down, it stays comparable to itself.
- **mapping version** — how a corpus becomes journal entries is authored,
  and every choice moves the score. Bump it on any change; records with
  different mapping versions are not comparable.
- **SQLite version** — FTS5 ranking lives in SQLite, which
  `better-sqlite3` bundles. A dependency bump can legitimately move every
  figure, and a reader should be able to see that rather than infer it.

## Corpora are never committed

They are fetched on demand into `bench/.cache/` (gitignored) and
identified by checksum. LongMemEval-S is 265 MB and the run takes 27
seconds — there is nothing to gain by carrying it. Both corpora permit
redistribution; declining it is a size decision, not a legal one.

Set `TREECONTEXT_BENCH_CACHE` to share one cache across checkouts.

## Repinning a checksum

If the upstream corpus changes, the report flags a mismatch. Investigate
first — then update `sha256` in the arm, and note in the commit message
why the corpus moved. Every prior record stays in `history.jsonl`, so the
discontinuity remains visible instead of being smoothed away.

## Arms

| arm | what it measures | role |
| --- | --- | --- |
| `lme-s-questions` | LongMemEval-S: does the answer-bearing session rank top-5 for a user's question? Published gold labels, no judge. | regression detection |
| `lme-v2-goals` | LongMemEval-V2 web-agent trajectories: goal-as-query, trajectory as its own gold label. Agentic shape — actions and observations, one entry per state, ~75k entries. | regression detection |
| `code-fixture` | Curated coding sessions: identifiers, paths, error codes, commands, paraphrases — reported by query kind. | **diagnostic only** |
| `mature-journal` | A synthesized mature journal made through the capture pipeline (hook → staging → drain, the agent's notes and its own treecontext echoes through the real MCP server), queried at the served defaults: orientation, note, checkpoint, bookmark, shell and developer-turn lookups, and shell ordering. MRR@5. | **the capture-path arm**; diagnostic, and the first arm that can see a capture-side regression |

### Why `code-fixture` is diagnostic, not a detector

Its falsification run is unambiguous: at n=120 the resolution is **~16pp**
(it was ~30pp at n=36), so it still cannot see any regression worth the
name. It was built to answer a
different question — *where* lexical retrieval succeeds and fails — and
its slice table does that well. Read the contrast, never the aggregate,
and do not treat its headline number as a regression signal.

Two properties surfaced by falsifying it, both worth knowing:

- `index-preview-only` is a **no-op** there: truncating to 300 characters
  does nothing to entries that are mostly shorter than that.
- `rank-collapse` moves the aggregate by −9.58pp at 1.7 SE (re-measured
  2026-10-10, MRR@5, n=120), under the 3-SE line, while the path slice
  flags at −33.3pp, 3.4 SE. Its expectation is now `flag-slice`. That is an
  expectation corrected by measurement, not an effect of D271: the slice's
  SE was finite.

Expectations are therefore per-arm (`ARM_EXPECTATIONS` in
`bench/mutations.ts`); a single global expectation would be a lie. The
`subgroup-collapse` target is likewise chosen per arm — the largest slice
in the reference run — after hardcoding a category name left the mutation
silently inert on every arm but the first.

Adding an arm means adding a file under `bench/arms/` and listing it in
`arms/index.ts`. Aggregation, error bars, provenance and reporting are the
runner's job and come for free.

### What no public corpus covers

Both LongMemEval variants are somebody else's data, which is exactly why
they are credible — and also why they are incomplete. Neither contains
tool calls, file paths, identifiers, or stack traces, so neither can
exercise role weighting, the preview/index split, or FTS5 tokenization of
`flat-store.ts` and `TS2345`. Those are the parts most likely to regress
silently, and they need `code-fixture`. Do not read a healthy
`lme-s-questions` as covering them.

One measured caution for `lme-v2-goals` when it is built: index the
trajectory **states only** and exclude the agent's `thought`. On a
200-trajectory sample, leaving `thought` in raises recall@1 from 0.465 to
0.670, because the agent restates the goal in its own prose — that
measures paraphrase matching, not retrieval, and it would produce
misleading evidence about role weighting.

## The index-cap sweep, and the product change it caused (2026-07-28)

`cap-sweep.ts` reruns an arm once per candidate cap (the `onInsert`
mutation seam, `text.slice(0, cap)` — the same operation production's
index caps perform) and pairs per-query scores against the full-index
baseline; `cap-cost.ts` measures the other side of the ledger (FTS size,
insert throughput, query latency) with stored content held identical via
the production `_index_len` mechanism. Findings, all paired:

- **Prefix caps are the largest measured effect in this bench.** On lme-s
  (per-session entries, median 10.5k chars) a 2000-char index costs
  −14.03pp at 9.2 SE; even 8000 costs −2.39pp (p=0.0002). On lme-v2
  (per-state tool-event analogues, median 14k chars) a 1500-char view —
  the old tool-preview budget — costs ~17–20pp, while **8000 is
  statistically indistinguishable from full** (+0.16pp, 0.2 SE) at about
  a third of full's query latency on DOM-like text. For comparison, the
  best dense-embedder fusion result ever measured here was +6.11pp.
- **The flat 8000 aggregate on lme-v2 hides a slice trade**: workarena is
  still −5.7pp while webarena is +6.1pp — capping *helps* noisy DOM text
  and hurts corpora whose signal sits deep. Read the slices, as always.
- **Head/tail splitting only pays in the starved regime** (+6.68pp at 7.1
  SE at budget 2000 on lme-v2; +2.59pp at 1000 on lme-s), is a wash at
  8000 on both arms, and is actively harmful at mid budgets on prose
  (−5.73pp at 4.8 SE at 4000 on lme-s — session signal concentrates
  early). It was measured and declined, not assumed away.

Production capture followed the numbers (2026-07-29): tool events index up
to 8000 chars, user/assistant prose in full, with `TREECONTEXT_INDEX_CAP`
as the field lever and the old 2000/4000 constants frozen as recompute
fallbacks for pre-change rows.

**The arms of that day could not see that change, by construction.** They
insert directly into FlatStore without auto-capture metadata, so
production's capture-time caps were never exercised and no recorded series
moved. That coverage gap, nothing in `bench/` running the
hook → staging → ingestion pipeline, is now covered by `mature-journal`
(2026-10-10): its corpus is made by the real hooks and the real drain, so a
capture-side regression moves its numbers. It is small (n=85, resolution
~18pp), so it localizes such a regression by slice rather than detecting
it in the aggregate; see below.

## The mature-journal arm, and the tool weight it was built to measure (2026-10-10)

`mature-journal` is the capture-path arm D266 asked for. Its corpus is
`bench/fixtures/mature-journal/`, the same seeded generator the charter
suite's journal-recall scenarios seed from: six sessions over nine days,
each opening with the handshake (`treecontext_status`, then the orientation
query) through the real MCP server, then five turns of a developer prompt,
eight shell events (Bash, Read, Grep) and the turn's final assistant text,
every one a real Claude Code payload fed to the real hook subprocess and
drained by the production `IngestionLoop`, with a curated note per turn
through `treecontext_insert` and its echo. 360 rows: 276 captured tool rows
(echoes among them) against 24 curated, 30 developer turns, 30 assistant
turns. Gold is a logical key the generator reports (`s5:checkpoint`,
`s2:shell:1:5`), so a mutated build, whose node ids differ, is scored by the
same 97 queries.

Queries run through `store.query` at the served defaults (recency fusion at
0.25 since D273, 0.5 before it; the default role weights, tool 0.1 since
D272); the scored list is the first five, read
from a `top_k` 5 call. The metric is MRR@5, for the reason `code-fixture`
gives: on a small corpus recall@5 measures retrieval, not ranking. The
runner records one metric per arm; recall@5 comes from the weight sweep. A
full run takes about 6 s, nearly all of it the build (about 340 hook
subprocesses, 12 at a time).

A staging row the generator cannot match to its planned event throws; a
build that cannot account for its own rows never moves a number. The
build's hook env scrubs `TREECONTEXT_INDEX_CAP` and `TREECONTEXT_TEST_NOW`.

Mapping version 4 (2026-10-10): the corpus is captured under D270 (a tool
payload stored as its text) and the query set carries the shell-ordering
slice built from each row's indexed text, so version-2 and version-3
records are not compared (the one version-3 record was removed: its
shell-ordering golds were partly unreachable). First run at version 4
(n=97, MRR@5 49.95%, SE 4.18%):

| slice | n | MRR@5 | recall@5 |
| --- | ---: | ---: | ---: |
| orientation | 6 | 50.00% | 25.00% |
| note-lookup | 24 | 37.85% | 79.17% |
| checkpoint-lookup | 6 | 100.00% | 100.00% |
| bookmark-lookup | 6 | 50.00% | 50.00% |
| shell-lookup | 13 | 100.00% | 100.00% |
| shell-ordering | 12 | 53.06% | 91.67% |
| developer-turn | 30 | 26.67% | 66.67% |

Re-run 2026-10-10 at the beta.2 served defaults (tool weight 0.1, D272;
recency 0.25, D273; the bookmark's score factor retired and the chapter
placed above the bookmark after fusion, live chapters only, D275),
recorded as one history run (n=97, MRR@5 65.26%, SE 3.37%; +15.31pp
against the first run, 2.9 SE, within noise; developer-turn +28.11pp at
3.8 SE). recall@5 read from the recency sweep's 0.25 row:

| slice | n | MRR@5 | recall@5 |
| --- | ---: | ---: | ---: |
| orientation | 6 | 50.00% | 33.33% |
| note-lookup | 24 | 58.82% | 95.83% |
| checkpoint-lookup | 6 | 91.67% | 100.00% |
| bookmark-lookup | 6 | 55.56% | 100.00% |
| shell-lookup | 13 | 100.00% | 100.00% |
| shell-ordering | 12 | 65.97% | 100.00% |
| developer-turn | 30 | 54.78% | 96.67% |

With `--recency 0` the same build scores 91.75% (bookmark-lookup 58.33%,
recall 100%; note-lookup and developer-turn 100%; checkpoint-lookup 100%;
orientation 16.67%). checkpoint-lookup at the served defaults is 91.67%,
one of six lookups no longer first: the retired factor had held the
bookmarks, which share their session's words, below the chapters.

The orientation query's first five at the served defaults: the fresh
plan (s5 checkpoint, gold) first, then the s5, s4 and s3 bookmarks and a
developer turn of s5; no shell row. With the tool weight at 1.0 the first
shell row is sixth.

Three readings matter more than the headline:

- **shell-lookup measures presence again, and shell-ordering measures
  order.** shell-lookup's queries are SHELL_ONLY_TERM and, per session, two
  commit hashes that occur in exactly one generated output, at a seeded
  line. Under the capture defect (below) 3 of 13 were found; since D270 all
  13 are, at every tool weight, so the slice now guards D260's promise that
  no weight hides a row and no longer scores the capture. shell-ordering
  is twelve words taken from the shell outputs that no other text
  carries, each matched in the INDEXED text (read from the built
  database, so a Read counts only its preview) of five or more shell
  rows; gold is the row with strictly the most occurrences, kept only
  when it is also the densest match, Bash and Grep golds preferred (all
  twelve are Bash). The build checks that pure lexical ranking at the
  default weights puts the gold first: 11 of 12. The slice reads how
  matching shell rows order among themselves, which is what a tool
  weight of 0 costs, since weight 0 keeps the rows but flattens the
  column's term frequency.
- **Recency fusion, not the tool weight, sets most of the lookup numbers.**
  The same queries with `--recency 0` (pure lexical) score 89.78%:
  note-lookup and developer-turn go to 100%, shell-ordering to 95.83%,
  orientation falls to 16.67%. At weight 0.5 and K=60 the recency term
  spans more score than the first seventeen or so lexical ranks, so an
  exact lookup of an older row loses to newer rows that share its words.
  The recency sweep below prices it.
- **bookmark-lookup was low by construction**, the D166/D262 gap: the
  bookmark factor multiplied the score inside the SQL ordering, before the
  cut. Pure lexical it was 26.39% at the first run. D275 retired the
  factor and places each matching live chapter above the matching
  bookmarks after fusion (a superseded chapter ranks as fusion left it).
  Measured at the same weights (tool 0.1, the build of this chunk) with
  the old mechanism switched back in for the "before": served (recency
  0.25) MRR@5 54.17% → 55.56%, recall@5 66.67% → 100%; pure lexical
  (recency 0) MRR@5 27.78% → 58.33%, recall@5 66.67% → 100%. Every
  bookmark is now in its own query's first five. One confound
  in the slice: its gold bookmarks are of every age, and a newer bookmark
  gains from recency, so the served number moves with the bookmark's age
  as much as with the mechanism.

### The tool-weight sweep (D260, re-run under D270)

`npm run bench:weights -- --arm mature-journal`: tool weight swept, other
weights at default, served recency, paired per query against 0.25 (Δ MRR,
paired bootstrap SE, hurt/helped, McNemar exact p on that split). The
chunk-2 sweep ran on a journal captured under the defect D270 fixed; this
one runs on captures made under D270, with the shell-ordering slice.

| slice | n | tool | MRR@5 | recall@5 | Δ MRR vs 0.25 | paired SE | SE units | hurt/helped | McNemar p |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| all | 97 | 1 | 45.55% | 75.77% | -4.40pp | 1.84% | 2.4 | 15/6 | 0.0784 |
| all | 97 | 0.5 | 46.92% | 72.68% | -3.02pp | 1.36% | 2.2 | 9/3 | 0.1460 |
| all | 97 | 0.25 | 49.95% | 75.77% | — | — | — | — | — |
| all | 97 | 0.1 | 48.87% | 73.71% | -1.08pp | 1.41% | 0.8 | 9/11 | 0.8238 |
| all | 97 | 0 | 47.54% | 67.53% | -2.41pp | 3.11% | 0.8 | 17/22 | 0.5224 |
| orientation | 6 | 1 | 50.00% | 25.00% | +0.00pp | 0.00% | 0.0 | 0/0 | 1.0000 |
| orientation | 6 | 0.5 | 50.00% | 25.00% | +0.00pp | 0.00% | 0.0 | 0/0 | 1.0000 |
| orientation | 6 | 0.25 | 50.00% | 25.00% | — | — | — | — | — |
| orientation | 6 | 0.1 | 50.00% | 25.00% | +0.00pp | 0.00% | 0.0 | 0/0 | 1.0000 |
| orientation | 6 | 0 | 50.00% | 25.00% | +0.00pp | 0.00% | 0.0 | 0/0 | 1.0000 |
| note-lookup | 24 | 1 | 35.07% | 83.33% | -2.78pp | 3.37% | 0.8 | 4/2 | 0.6875 |
| note-lookup | 24 | 0.5 | 35.14% | 75.00% | -2.71pp | 2.37% | 1.1 | 3/2 | 1.0000 |
| note-lookup | 24 | 0.25 | 37.85% | 79.17% | — | — | — | — | — |
| note-lookup | 24 | 0.1 | 34.93% | 75.00% | -2.92pp | 3.54% | 0.8 | 4/4 | 1.0000 |
| note-lookup | 24 | 0 | 42.15% | 70.83% | +4.31pp | 7.94% | 0.5 | 6/10 | 0.4545 |
| checkpoint-lookup | 6 | 1 | 83.33% | 100.00% | -16.67pp | 9.55% | 1.7 | 2/0 | 0.5000 |
| checkpoint-lookup | 6 | 0.5 | 83.33% | 100.00% | -16.67pp | 9.55% | 1.7 | 2/0 | 0.5000 |
| checkpoint-lookup | 6 | 0.25 | 100.00% | 100.00% | — | — | — | — | — |
| checkpoint-lookup | 6 | 0.1 | 91.67% | 100.00% | -8.33pp | 7.58% | 1.1 | 1/0 | 1.0000 |
| checkpoint-lookup | 6 | 0 | 100.00% | 100.00% | +0.00pp | 0.00% | 0.0 | 0/0 | 1.0000 |
| bookmark-lookup | 6 | 1 | 17.22% | 50.00% | -32.78pp | 17.29% | 1.9 | 3/1 | 0.6250 |
| bookmark-lookup | 6 | 0.5 | 33.33% | 33.33% | -16.67pp | 15.25% | 1.1 | 1/0 | 1.0000 |
| bookmark-lookup | 6 | 0.25 | 50.00% | 50.00% | — | — | — | — | — |
| bookmark-lookup | 6 | 0.1 | 41.67% | 50.00% | -8.33pp | 7.63% | 1.1 | 1/0 | 1.0000 |
| bookmark-lookup | 6 | 0 | 38.89% | 50.00% | -11.11pp | 10.17% | 1.1 | 1/0 | 1.0000 |
| shell-lookup | 13 | 1 | 100.00% | 100.00% | +0.00pp | 0.00% | 0.0 | 0/0 | 1.0000 |
| shell-lookup | 13 | 0.5 | 100.00% | 100.00% | +0.00pp | 0.00% | 0.0 | 0/0 | 1.0000 |
| shell-lookup | 13 | 0.25 | 100.00% | 100.00% | — | — | — | — | — |
| shell-lookup | 13 | 0.1 | 100.00% | 100.00% | +0.00pp | 0.00% | 0.0 | 0/0 | 1.0000 |
| shell-lookup | 13 | 0 | 100.00% | 100.00% | +0.00pp | 0.00% | 0.0 | 0/0 | 1.0000 |
| shell-ordering | 12 | 1 | 53.06% | 91.67% | +0.00pp | 0.00% | 0.0 | 0/0 | 1.0000 |
| shell-ordering | 12 | 0.5 | 53.06% | 91.67% | +0.00pp | 0.00% | 0.0 | 0/0 | 1.0000 |
| shell-ordering | 12 | 0.25 | 53.06% | 91.67% | — | — | — | — | — |
| shell-ordering | 12 | 0.1 | 53.06% | 91.67% | +0.00pp | 0.00% | 0.0 | 0/0 | 1.0000 |
| shell-ordering | 12 | 0 | 8.33% | 8.33% | -44.72pp | 10.28% | 4.4 | 10/0 | 0.0020 |
| developer-turn | 30 | 1 | 24.56% | 63.33% | -2.11pp | 2.56% | 0.8 | 6/3 | 0.5078 |
| developer-turn | 30 | 0.5 | 25.72% | 63.33% | -0.94pp | 0.75% | 1.3 | 3/1 | 0.6250 |
| developer-turn | 30 | 0.25 | 26.67% | 66.67% | — | — | — | — | — |
| developer-turn | 30 | 0.1 | 28.83% | 63.33% | +2.17pp | 2.46% | 0.9 | 3/7 | 0.3437 |
| developer-turn | 30 | 0 | 35.56% | 80.00% | +8.89pp | 2.65% | 3.4 | 0/12 | 0.0005 |

Orientation, read beyond MRR: the first result's kind and the shell rows in
the first five, per orientation query (30 slots in all):

| query | tool 1 | tool 0.5 | tool 0.25 | tool 0.1 | tool 0 |
| --- | --- | --- | --- | --- | --- |
| what was I working on, what was the next step | curated (gold), 3 shell | curated (gold), 0 shell | curated (gold), 0 shell | curated (gold), 0 shell | curated (gold), 0 shell |
| what was I doing | developer, 0 shell | developer, 0 shell | developer, 0 shell | developer, 0 shell | developer, 0 shell |
| where did I leave off | developer, 0 shell | developer, 0 shell | developer, 0 shell | developer, 0 shell | developer, 0 shell |
| what's next | curated (gold), 2 shell | curated (gold), 2 shell | curated (gold), 1 shell | curated (gold), 0 shell | curated (gold), 0 shell |
| what is the next step | curated (gold), 1 shell | curated (gold), 1 shell | curated (gold), 0 shell | curated (gold), 0 shell | curated (gold), 0 shell |
| where was I, what was I working on | developer, 0 shell | developer, 0 shell | developer, 0 shell | developer, 0 shell | developer, 0 shell |
| **shell rows in the first five, all 6 queries** | **6** of 30 | **3** of 30 | **1** of 30 | **0** of 30 | **0** of 30 |

With `--recency 0` the shell rows in the first five are 4, 2, 0, 0, 0 from
1.0 down to 0, and shell-ordering is 95.83% from 1.0 to 0.1 and 2.78% at 0
(12 hurt, 0 helped).

What moved. shell-ordering is 53.06% MRR (recall 91.67%) at every weight
from 1.0 to 0.1, the same value at each (every row that matches its words
is a shell row, so a nonzero tool weight scales them alike), and 8.33%
(recall 8.33%) at 0: −44.72pp at 4.4 SE, 10 hurt and 0 helped, p≈0.002.
developer-turn at 0 is +8.89pp at 3.4 SE, 0 hurt and 12 helped, p≈0.0005;
note-lookup at 0 is +4.31pp (6 hurt, 10 helped, p≈0.45). In aggregate, 0
against 0.25 is −2.41pp (0.8 SE, 17 hurt, 22 helped, p≈0.52); 1.0, 0.5 and
0.1 are −4.40pp, −3.02pp and −1.08pp. checkpoint-lookup is 100% at 0.25
and 0, 91.67% at 0.1, 83.33% at 1.0 and 0.5; bookmark-lookup is highest at
0.25 (50.00%). The orientation gold's rank does not move at any weight; the
shell rows under it are 6, 3, 1, 0, 0 from 1.0 to 0. shell-lookup is 100%
at every weight. No ruling here: the owner rules whether D260's 0.25 moves.

*2026-10-10: the owner ruled 0.1 (D272), with the shell-ordering slice
and the orientation table above on the table.*

#### At the served recency of D273 (2026-10-10)

The sweep above ran at recency 0.5; D273 serves 0.25, and D272's why says
that pair is measured at the build. `npm run bench:weights -- --arm
mature-journal --recency 0.25`, run before any constant changed (tool
0.25, recency passed explicitly), paired per query against tool 0.25:

| slice | n | tool | MRR@5 | recall@5 | Δ MRR vs 0.25 | paired SE | SE units | hurt/helped | McNemar p |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| all | 97 | 1 | 59.62% | 90.21% | -3.40pp | 2.22% | 1.5 | 14/10 | 0.5413 |
| all | 97 | 0.5 | 61.82% | 90.21% | -1.20pp | 1.13% | 1.1 | 8/5 | 0.5811 |
| all | 97 | 0.25 | 63.02% | 90.21% | — | — | — | — | — |
| all | 97 | 0.1 | 65.40% | 91.24% | +2.37pp | 0.87% | 2.7 | 0/9 | 0.0039 |
| all | 97 | 0 | 61.94% | 81.96% | -1.08pp | 2.97% | 0.4 | 13/24 | 0.0989 |
| orientation | 6 | 1 | 41.67% | 25.00% | -8.33pp | 7.58% | 1.1 | 1/0 | 1.0000 |
| orientation | 6 | 0.5 | 41.67% | 25.00% | -8.33pp | 7.58% | 1.1 | 1/0 | 1.0000 |
| orientation | 6 | 0.25 | 50.00% | 25.00% | — | — | — | — | — |
| orientation | 6 | 0.1 | 50.00% | 25.00% | +0.00pp | 0.00% | 0.0 | 0/0 | 1.0000 |
| orientation | 6 | 0 | 50.00% | 25.00% | +0.00pp | 0.00% | 0.0 | 0/0 | 1.0000 |
| note-lookup | 24 | 1 | 58.82% | 100.00% | -0.69pp | 3.91% | 0.2 | 4/4 | 1.0000 |
| note-lookup | 24 | 0.5 | 58.13% | 100.00% | -1.39pp | 2.40% | 0.6 | 3/3 | 1.0000 |
| note-lookup | 24 | 0.25 | 59.51% | 95.83% | — | — | — | — | — |
| note-lookup | 24 | 0.1 | 61.25% | 95.83% | +1.74pp | 1.20% | 1.4 | 0/2 | 0.5000 |
| note-lookup | 24 | 0 | 73.61% | 100.00% | +14.10pp | 4.24% | 3.3 | 0/11 | 0.0010 |
| checkpoint-lookup | 6 | 1 | 86.67% | 100.00% | -13.33pp | 12.04% | 1.1 | 1/0 | 1.0000 |
| checkpoint-lookup | 6 | 0.5 | 100.00% | 100.00% | +0.00pp | 0.00% | 0.0 | 0/0 | 1.0000 |
| checkpoint-lookup | 6 | 0.25 | 100.00% | 100.00% | — | — | — | — | — |
| checkpoint-lookup | 6 | 0.1 | 100.00% | 100.00% | +0.00pp | 0.00% | 0.0 | 0/0 | 1.0000 |
| checkpoint-lookup | 6 | 0 | 100.00% | 100.00% | +0.00pp | 0.00% | 0.0 | 0/0 | 1.0000 |
| bookmark-lookup | 6 | 1 | 11.67% | 50.00% | -34.17pp | 14.22% | 2.4 | 3/0 | 0.2500 |
| bookmark-lookup | 6 | 0.5 | 37.50% | 50.00% | -8.33pp | 7.63% | 1.1 | 1/0 | 1.0000 |
| bookmark-lookup | 6 | 0.25 | 45.83% | 66.67% | — | — | — | — | — |
| bookmark-lookup | 6 | 0.1 | 54.17% | 66.67% | +8.33pp | 7.63% | 1.1 | 0/1 | 1.0000 |
| bookmark-lookup | 6 | 0 | 34.72% | 66.67% | -11.11pp | 7.48% | 1.5 | 2/0 | 0.5000 |
| shell-lookup | 13 | 1 | 100.00% | 100.00% | +0.00pp | 0.00% | 0.0 | 0/0 | 1.0000 |
| shell-lookup | 13 | 0.5 | 100.00% | 100.00% | +0.00pp | 0.00% | 0.0 | 0/0 | 1.0000 |
| shell-lookup | 13 | 0.25 | 100.00% | 100.00% | — | — | — | — | — |
| shell-lookup | 13 | 0.1 | 100.00% | 100.00% | +0.00pp | 0.00% | 0.0 | 0/0 | 1.0000 |
| shell-lookup | 13 | 0 | 100.00% | 100.00% | +0.00pp | 0.00% | 0.0 | 0/0 | 1.0000 |
| shell-ordering | 12 | 1 | 65.97% | 100.00% | +0.00pp | 0.00% | 0.0 | 0/0 | 1.0000 |
| shell-ordering | 12 | 0.5 | 65.97% | 100.00% | +0.00pp | 0.00% | 0.0 | 0/0 | 1.0000 |
| shell-ordering | 12 | 0.25 | 65.97% | 100.00% | — | — | — | — | — |
| shell-ordering | 12 | 0.1 | 65.97% | 100.00% | +0.00pp | 0.00% | 0.0 | 0/0 | 1.0000 |
| shell-ordering | 12 | 0 | 8.33% | 8.33% | -57.64pp | 9.50% | 6.1 | 11/0 | 0.0010 |
| developer-turn | 30 | 1 | 48.00% | 93.33% | +0.72pp | 3.82% | 0.2 | 5/6 | 1.0000 |
| developer-turn | 30 | 0.5 | 47.83% | 93.33% | +0.56pp | 2.01% | 0.3 | 3/2 | 1.0000 |
| developer-turn | 30 | 0.25 | 47.28% | 93.33% | — | — | — | — | — |
| developer-turn | 30 | 0.1 | 51.89% | 96.67% | +4.61pp | 2.04% | 2.3 | 0/6 | 0.0313 |
| developer-turn | 30 | 0 | 57.78% | 100.00% | +10.50pp | 2.82% | 3.7 | 0/13 | 0.0002 |

Orientation at recency 0.25, per query:

| query | tool 1 | tool 0.5 | tool 0.25 | tool 0.1 | tool 0 |
| --- | --- | --- | --- | --- | --- |
| what was I working on, what was the next step | curated (gold), 2 shell | curated (gold), 0 shell | curated (gold), 0 shell | curated (gold), 0 shell | curated (gold), 0 shell |
| what was I doing | developer, 0 shell | developer, 0 shell | developer, 0 shell | developer, 0 shell | developer, 0 shell |
| where did I leave off | developer, 0 shell | developer, 0 shell | developer, 0 shell | developer, 0 shell | developer, 0 shell |
| what's next | shell, 2 shell | developer, 1 shell | curated (gold), 0 shell | curated (gold), 0 shell | curated (gold), 0 shell |
| what is the next step | curated (gold), 1 shell | curated (gold), 1 shell | curated (gold), 0 shell | curated (gold), 0 shell | curated (gold), 0 shell |
| where was I, what was I working on | developer, 0 shell | developer, 0 shell | developer, 0 shell | developer, 0 shell | developer, 0 shell |
| **shell rows in the first five, all 6 queries** | **5** of 30 | **2** of 30 | **0** of 30 | **0** of 30 | **0** of 30 |

What moved at the served recency. Against 0.25, tool 0.1 is +2.37pp in
aggregate (0.87% SE, 2.7 SE units, 0 hurt and 9 helped, McNemar p≈0.0039):
developer-turn +4.61pp (0 hurt, 6 helped, p≈0.031), note-lookup +1.74pp
(0/2), bookmark-lookup +8.33pp (0/1); orientation, checkpoint-lookup,
shell-lookup and shell-ordering do not move. shell-ordering is 65.97% from
1.0 to 0.1 and 8.33% at 0 (−57.64pp, 6.1 SE, 11 hurt, 0 helped). The shell
rows in the orientation queries' first five are 5, 2, 0, 0, 0 from 1.0 to
0, and at 1.0 "what's next" returns a shell row first. 0 against 0.25 is
−1.08pp in aggregate (13 hurt, 24 helped, p≈0.099), the shell-ordering
collapse against lookup gains (note-lookup +14.10pp, developer-turn
+10.50pp). Reported for the owner; D272's value is not changed by it.

### Recency sweep (2026-10-10, for the owner)

`npm run bench:recency`: the recency fusion weight swept, role weights at
default, paired per query against the served 0.5 (D56). For orientation it
also gives the fresh plan's rank (the newest live checkpoint, the
orientation gold): its place in the served first five, else, marked
"deep", its place in a second `top_k` 50 call (fusion's candidate pool is
max(4 × top_k, 50), so the deep list is a neighbour of the scored one, not
its extension).

| slice | n | recency | MRR@5 | recall@5 | Δ MRR vs 0.5 | paired SE | SE units | hurt/helped | McNemar p |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| all | 97 | 0.5 | 49.95% | 75.77% | — | — | — | — | — |
| all | 97 | 0.35 | 55.88% | 84.02% | +5.93pp | 1.25% | 4.7 | 0/28 | 0.0000 |
| all | 97 | 0.25 | 63.02% | 90.21% | +13.08pp | 2.22% | 5.9 | 1/39 | 0.0000 |
| all | 97 | 0.1 | 80.33% | 93.30% | +30.38pp | 3.84% | 7.9 | 3/53 | 0.0000 |
| all | 97 | 0 | 89.78% | 92.78% | +39.83pp | 4.70% | 8.5 | 6/56 | 0.0000 |
| orientation | 6 | 0.5 | 50.00% | 25.00% | — | — | — | — | — |
| orientation | 6 | 0.35 | 50.00% | 25.00% | +0.00pp | 0.00% | 0.0 | 0/0 | 1.0000 |
| orientation | 6 | 0.25 | 50.00% | 25.00% | +0.00pp | 0.00% | 0.0 | 0/0 | 1.0000 |
| orientation | 6 | 0.1 | 38.89% | 25.00% | -11.11pp | 10.11% | 1.1 | 1/0 | 1.0000 |
| orientation | 6 | 0 | 16.67% | 16.67% | -33.33pp | 14.99% | 2.2 | 3/0 | 0.2500 |
| note-lookup | 24 | 0.5 | 37.85% | 79.17% | — | — | — | — | — |
| note-lookup | 24 | 0.35 | 44.38% | 87.50% | +6.53pp | 2.56% | 2.6 | 0/8 | 0.0078 |
| note-lookup | 24 | 0.25 | 59.51% | 95.83% | +21.67pp | 4.93% | 4.4 | 0/14 | 0.0001 |
| note-lookup | 24 | 0.1 | 79.86% | 100.00% | +42.01pp | 5.66% | 7.4 | 0/19 | 0.0000 |
| note-lookup | 24 | 0 | 100.00% | 100.00% | +62.15pp | 6.61% | 9.4 | 0/20 | 0.0000 |
| checkpoint-lookup | 6 | 0.5 | 100.00% | 100.00% | — | — | — | — | — |
| checkpoint-lookup | 6 | 0.35 | 100.00% | 100.00% | +0.00pp | 0.00% | 0.0 | 0/0 | 1.0000 |
| checkpoint-lookup | 6 | 0.25 | 100.00% | 100.00% | +0.00pp | 0.00% | 0.0 | 0/0 | 1.0000 |
| checkpoint-lookup | 6 | 0.1 | 100.00% | 100.00% | +0.00pp | 0.00% | 0.0 | 0/0 | 1.0000 |
| checkpoint-lookup | 6 | 0 | 100.00% | 100.00% | +0.00pp | 0.00% | 0.0 | 0/0 | 1.0000 |
| bookmark-lookup | 6 | 0.5 | 50.00% | 50.00% | — | — | — | — | — |
| bookmark-lookup | 6 | 0.35 | 50.00% | 50.00% | +0.00pp | 0.00% | 0.0 | 0/0 | 1.0000 |
| bookmark-lookup | 6 | 0.25 | 45.83% | 66.67% | -4.17pp | 9.15% | 0.5 | 1/1 | 1.0000 |
| bookmark-lookup | 6 | 0.1 | 36.11% | 66.67% | -13.89pp | 13.84% | 1.0 | 2/1 | 1.0000 |
| bookmark-lookup | 6 | 0 | 26.39% | 66.67% | -23.61pp | 15.16% | 1.6 | 3/1 | 0.6250 |
| shell-lookup | 13 | 0.5 | 100.00% | 100.00% | — | — | — | — | — |
| shell-lookup | 13 | 0.35 | 100.00% | 100.00% | +0.00pp | 0.00% | 0.0 | 0/0 | 1.0000 |
| shell-lookup | 13 | 0.25 | 100.00% | 100.00% | +0.00pp | 0.00% | 0.0 | 0/0 | 1.0000 |
| shell-lookup | 13 | 0.1 | 100.00% | 100.00% | +0.00pp | 0.00% | 0.0 | 0/0 | 1.0000 |
| shell-lookup | 13 | 0 | 100.00% | 100.00% | +0.00pp | 0.00% | 0.0 | 0/0 | 1.0000 |
| shell-ordering | 12 | 0.5 | 53.06% | 91.67% | — | — | — | — | — |
| shell-ordering | 12 | 0.35 | 63.47% | 100.00% | +10.42pp | 4.07% | 2.6 | 0/6 | 0.0313 |
| shell-ordering | 12 | 0.25 | 65.97% | 100.00% | +12.92pp | 4.69% | 2.8 | 0/6 | 0.0313 |
| shell-ordering | 12 | 0.1 | 91.67% | 100.00% | +38.61pp | 8.92% | 4.3 | 0/8 | 0.0078 |
| shell-ordering | 12 | 0 | 95.83% | 100.00% | +42.78pp | 9.27% | 4.6 | 0/8 | 0.0078 |
| developer-turn | 30 | 0.5 | 26.67% | 66.67% | — | — | — | — | — |
| developer-turn | 30 | 0.35 | 36.44% | 83.33% | +9.78pp | 2.73% | 3.6 | 0/14 | 0.0001 |
| developer-turn | 30 | 0.25 | 47.28% | 93.33% | +20.61pp | 4.22% | 4.9 | 0/18 | 0.0000 |
| developer-turn | 30 | 0.1 | 80.83% | 100.00% | +54.17pp | 6.47% | 8.4 | 0/25 | 0.0000 |
| developer-turn | 30 | 0 | 100.00% | 100.00% | +73.33pp | 5.30% | 13.8 | 0/27 | 0.0000 |

| query | recency 0.5 | recency 0.35 | recency 0.25 | recency 0.1 | recency 0 |
| --- | --- | --- | --- | --- | --- |
| what was I working on, what was the next step | curated (gold), 0 shell, plan #1 | curated (gold), 0 shell, plan #1 | curated (gold), 0 shell, plan #1 | curated (gold), 0 shell, plan #1 | developer, 0 shell, plan #2 |
| what was I doing | developer, 0 shell, plan #>50 deep | developer, 0 shell, plan #>50 deep | developer, 0 shell, plan #>50 deep | developer, 0 shell, plan #>50 deep | developer, 0 shell, plan #>50 deep |
| where did I leave off | developer, 0 shell, plan #>50 deep | developer, 0 shell, plan #>50 deep | developer, 0 shell, plan #>50 deep | developer, 0 shell, plan #>50 deep | developer, 0 shell, plan #>50 deep |
| what's next | curated (gold), 1 shell, plan #1 | curated (gold), 1 shell, plan #1 | curated (gold), 0 shell, plan #1 | developer, 0 shell, plan #3 | developer, 0 shell, plan #6 deep |
| what is the next step | curated (gold), 0 shell, plan #1 | curated (gold), 0 shell, plan #1 | curated (gold), 0 shell, plan #1 | curated (gold), 0 shell, plan #1 | developer, 0 shell, plan #2 |
| where was I, what was I working on | developer, 0 shell, plan #7 deep | developer, 0 shell, plan #11 deep | developer, 0 shell, plan #17 deep | developer, 0 shell, plan #24 deep | developer, 0 shell, plan #27 deep |
| **shell rows in the first five, all 6 queries** | **1** of 30 | **1** of 30 | **0** of 30 | **0** of 30 | **0** of 30 |

The trade, as measured. Lowering the weight lifts every lookup slice that
asks for an older row by its own words: note-lookup from 37.85% to 44.38%,
59.51%, 79.86% and 100% at 0.35, 0.25, 0.1 and 0; developer-turn from
26.67% to 36.44%, 47.28%, 80.83% and 100%; shell-ordering from 53.06% to
63.47%, 65.97%, 91.67% and 95.83%; the aggregate from 49.95% to 55.88%,
63.02%, 80.33% and 89.78% (0 hurt and 28 helped at 0.35, p<0.0001).
Orientation holds at 50.00% down to 0.25 (the fresh plan first on the
handshake query, "what's next" and "what is the next step"), drops to
38.89% at 0.1 ("what's next" returns a developer turn first, the plan
third) and to 16.67% at 0, where a developer turn is first on every
orientation query: the plan is second on the handshake query and on "what
is the next step", and sixth (deep) on "what's next". bookmark-lookup falls
as recency falls (50.00% at 0.5 and 0.35, 26.39% at 0); checkpoint-lookup
and shell-lookup do not move. The shell rows in the first five of the
orientation queries are 1, 1, 0, 0, 0 from 0.5 to 0. D56 ruled 0.5 for
orientation; the owner rules after reading.

*2026-10-10: the owner ruled 0.25 (D273, ratified by D274), the served
default since; the library default stays 0.*

One caveat on the aggregate: it follows the slice mix, not how agents
really query. 54 of the 97 queries are note and developer-turn lookups of
rows of any age, which recency can only push down; only the 6 orientation
queries ask for the newest thread by design (the checkpoint, bookmark and
shell slices ask for rows of every session).

### Falsification

Re-measured 2026-10-10 at the beta.2 served defaults (tool 0.1, recency
0.25, the live chapter placed above the bookmark, D272 to D275), mapping
version 4, reference 65.26% (n=97, SE 3.37%, resolution ~14.3pp): all
eight behave as expected, no expectation changed. `rank-collapse` now
also trips the aggregate (3.1 SE) beside its slice flag; checkpoint-lookup
sits at 91.67% at the reference, so its flag is a finite 5.4 SE.

| mutation | expect | seen | aggregate Δ | SE | worst slice |
| --- | --- | --- | ---: | ---: | --- |
| `identity` | no-flag | nothing | +0.00pp | 0.0 | — |
| `whitespace-normalize` | no-flag | nothing | +0.52pp | 0.1 | — |
| `index-preview-only` | flag-slice | slice only | −13.76pp | 2.8 | ⚠️ shell-lookup −61.5pp (4.5 SE) |
| `rank-collapse` | flag-slice | aggregate | −14.35pp | 3.1 | ⚠️ checkpoint-lookup −45.8pp (5.4 SE) |
| `topk-clip` | below-sensitivity | nothing | −1.86pp | 0.4 | note-lookup −4.0pp (0.4 SE) |
| `query-drop-short-terms` | no-flag | nothing | −2.03pp | 0.4 | bookmark-lookup −8.3pp (1.0 SE) |
| `query-drop-rare-terms` | below-sensitivity | nothing | +1.49pp | 0.3 | developer-turn −5.7pp (0.7 SE) |
| `subgroup-collapse` | below-sensitivity | nothing | −4.73pp | 1.0 | developer-turn −15.3pp (2.2 SE) |

The earlier measurement, under D270 and D271 at the served defaults of
the time (tool 0.25, recency 0.5, the bookmark factor), at mapping
version 4:

| mutation | expect | seen | aggregate Δ | SE | worst slice |
| --- | --- | --- | ---: | ---: | --- |
| `identity` | no-flag | nothing | +0.00pp | 0.0 | — |
| `whitespace-normalize` | no-flag | nothing | +0.55pp | 0.1 | — |
| `index-preview-only` | flag-slice | slice only | −12.59pp | 2.2 | ⚠️ shell-lookup −61.5pp (4.5 SE) |
| `rank-collapse` | flag-slice | slice only | −7.47pp | 1.4 | ⚠️ checkpoint-lookup −50.0pp (exact, SE 0) |
| `topk-clip` | below-sensitivity | nothing | −4.59pp | 0.7 | developer-turn −8.3pp (1.1 SE) |
| `query-drop-short-terms` | no-flag | nothing | +0.33pp | 0.1 | bookmark-lookup −25.0pp (1.0 SE) |
| `query-drop-rare-terms` | below-sensitivity | nothing | +0.29pp | 0.0 | checkpoint-lookup −42.5pp (2.4 SE) |
| `subgroup-collapse` | below-sensitivity | nothing | +0.26pp | 0.0 | — |

At n=97 the resolution was ~17.7pp then and the aggregate never tripped
the 3-SE rule, so, like `code-fixture`, this arm was read as diagnostic:
its slices, never its aggregate, as a regression signal. Two slices
flagged then: `index-preview-only` lost the deep hashes D270 made
findable (shell-lookup −61.5pp), and `rank-collapse` dropped
checkpoint-lookup from 100% to 50%. Now (resolution ~14.3pp)
`rank-collapse` also trips the aggregate (−14.35pp, 3.1 SE) and moves
checkpoint-lookup −45.8pp from 91.67%; read the slices first all the
same. Under a mutation with `onInsert` the arm rebuilds the journal
with every prompt, tool output, assistant text and curated content passed
through it; the capture path has no single insert seam.

**The zero-SE blind spot is fixed (D271).** `rank-collapse` used to print
checkpoint-lookup −50pp at "0.0 SE, within noise": the slice sits at 100%,
so its bootstrap SE is zero on both sides, and both detectors read any
delta over a zero SE as noise. Since D271 `compareValues` (run to run, per
slice too) and `pairedCompare` flag a nonzero change over a zero SE by its
sign and render it "exact (SE 0)", never Infinity; a zero change over a
zero SE stays within noise, and a slice flag stays the slice's flag, never
lifted into the aggregate verdict. `code-fixture` re-measured under it
(n=120, resolution ~16.2pp): all eight correct. Its `rank-collapse` is
now expected and seen as a slice flag (path −33.3pp at 3.4 SE, aggregate
−9.58pp at 1.7 SE); that is an expectation corrected by measurement, not a
D271 effect, since that slice's SE was finite.

### A capture finding the arm surfaced, fixed (D270)

The post-tool-use hook stored any object `tool_response` or `tool_input`
JSON-encoded, so a newline in it became a literal `\n` and a tab a literal
`\t`, and the index saw the token that followed glued to an `n` or a `t`.
That reached Bash output, Read's file content, Grep's content, multi-line
commands and Edit strings alike. Measured on this fixture before the fix:
of 886 commit hashes in 60 `git log` outputs, the 60 on each output's first
line were found by their own text and none of the other 826 was (each was
in the index only as `n<hash>`); `git status`'s `\tmodified:` lines put
`modified` in no row's index and `tmodified` in 30. D270 writes an object
payload as its text (a field's name, then its lines; a content block's
text verbatim). Rebuilt under it: 886 of 886 hashes found by their own
text, no `n<hash>` token left, `modified` in 30 rows and `tmodified` in
none. Rows captured before D270 keep their stored text and are found by
the glued form.

## Non-goals

Not a comparison harness against other systems. Not answer-quality
evaluation. Not an optimization target — the moment these numbers are
tuned upward deliberately, they stop measuring anything.
