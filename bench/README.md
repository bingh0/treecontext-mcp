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

Three companion instruments answer questions the regression series cannot;
none of them writes to `history.jsonl`:

```bash
npm run bench:compare  -- --arm code-fixture --b onnx --fused   # retriever A/B, paired
npm run bench:capsweep -- --arm lme-s-questions --split both    # what an index cap costs in recall
npm run bench:capcost  -- --source v2 --caps 1500,8000,full     # what removing one costs in bytes/ms
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
- `rank-collapse` moves the aggregate by 0.93pp, because most queries on a
  129-entry corpus return five or fewer candidates in total — reordering
  cannot push gold out of a top five it never left. **recall@5 measures
  retrieval, not ranking, once the candidate list is shorter than k.** On
  a small corpus, MRR or recall@1 would be the sensitive metric.

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

**This bench cannot see that change, by construction.** The arms insert
directly into FlatStore without auto-capture metadata, so production's
capture-time caps were never exercised here and no recorded series moves.
The corollary is a real coverage gap: nothing in `bench/` runs the
hook → staging → ingestion pipeline, so a capture-side regression is
invisible to this report (unit tests cover it instead). An arm that
exercises the capture path is the missing instrument, should capture
behavior ever need the same regression protection retrieval has.

## Non-goals

Not a comparison harness against other systems. Not answer-quality
evaluation. Not an optimization target — the moment these numbers are
tuned upward deliberately, they stop measuring anything.
