Feature: Journal search modes — a BM25 core, recency-fused at the surface, every knob a read-time choice

  Search is BM25 over the bounded preview index — no model download, no
  network, no GPU. Role weights encode a structural fact of single-author
  sessions: the user's words are scarce and authoritative, the assistant's
  prose is abundant and mostly paraphrase, tool text is the trail. At the
  MCP surface, recency fusion is the SERVED DEFAULT (weight 0.5, owner
  ruling 2026-08-01: broad orientation queries should favor the latest
  thread); the library default stays 0, and the served default never
  applies to adaptive queries or non-relevance orderings. Dense
  embeddings earned no default seat in testing; the flat journal ships
  with no dense path at all today — if dense ever lands (charter: only
  on unequivocal testing), it enters as an explicit opt-in fused by RRF,
  never a dependency. Every mode and weight is a read-time choice — the
  stored journal is one record serving them all.

  Charter details: (a) search with BM25, (c) optional dense plus RRF off
  by default, (e) role as a first-class ranking signal.
  Boundary with journal-recall: that file pins that search finds things
  (including with no model installed at all); THIS file pins how ranking
  is shaped and that every shaping knob is per-query.

  @D6
  Scenario: the user's words outrank the assistant's paraphrase of them
    Given a user directive and an assistant reply restating the same words
    When those words are queried under default weights
    Then the user entry ranks above the assistant entry
    # Default weights encode the volume/authority asymmetry of a
    # single-author session; exact values are bench-tunable, the ordering
    # user above assistant is the spec.

  @D6
  Scenario: a zero role weight down-ranks — it never hides
    Given an entry whose only query match sits in a role weighted zero
    When the query runs with a result budget large enough to reach it
    Then the entry appears, ranked below every weighted match
    # FTS MATCH is column-agnostic: weights shape bm25() scoring only.
    # Weight zero is NOT a filter — the only way this entry misses the
    # results is the budget cutting off above it, never removal. A binding
    # that proves this on a tiny corpus proves nothing; the Given's budget
    # clause exists so the binding must show rank-below, not just presence.

  @D6
  Scenario: role weights are per-query, the store is untouched
    Given a query that passes custom role weights
    When a second query runs with no weights specified
    Then the second query's ranking follows the default weights
    And re-running the first query with the same custom weights reproduces its ranking
    # The reproduction clause is the falsifiable form of "the store was not
    # altered": sticky weight state would leak into one of the two re-runs.
    # It is also why reference-frequency (ruled 2026-07-23) feeds eviction
    # ordering in journal-storage and NEVER default ranking: hit-boosted
    # ranking would make every query mutate future rankings — rich-get-
    # richer, and this scenario's reproduction clause would break.

  @D54
  Scenario: near-universal query tokens are pruned for speed, never at the cost of a discriminative hit
    Given a corpus large enough for pruning where one entry holds a rare token amid common bulk
    When a query mixes near-universal tokens with the rare token
    Then the rare entry is found exactly as if nothing were pruned
    # Specced 2026-07-31 (adversarial review F4 — this knob was invisible).
    # High-DF pruning drops query tokens whose document frequency exceeds
    # half the corpus (corpora ≥256 entries only): their IDF contribution
    # is ~0, but each one forces every containing row into the bm25
    # candidate set — the canonical session-start query is mostly such
    # tokens. Tokens are OR-joined, so pruning CAN drop rows that matched
    # solely through a pruned near-universal token; those carried ~zero
    # relevance signal by construction. The safety property pinned here:
    # an entry matching any SURVIVING token is never lost.

  @D54
  Scenario: a query of only near-universal tokens still matches
    Given a corpus large enough for pruning where every token of a query is near-universal
    When that query runs
    Then entries still match, exactly as if nothing were pruned
    # The fallback half: when pruning would empty the query — everything
    # high-DF, or every survivor absent from the corpus entirely — the
    # full token list is used. Slower, never silently empty.

  @D54
  Scenario: small corpora are never pruned
    Given a corpus below the pruning floor where every entry shares the query's common tokens
    When a query of those common tokens runs
    Then entries match with no pruning in play
    # Frequency statistics on a small corpus are noise, and small stores
    # are fast regardless — the floor keeps pruning a large-corpus
    # optimization only.

  @D44
  Scenario: result count can follow the score distribution instead of a fixed k
    Given entries where a clear score break separates three strong matches from the rest
    When the query runs with adaptive result count and an anchor of five
    Then exactly the three strong matches return
    And the response discloses the adaptive count and a confidence signal
    # Measured before specced, on a probe over 11.6k live entries.
    # The anchor is a BUDGET, not a floor — a deliberate departure from the
    # deleted CAR implementation, which iterated from the anchor and could
    # never cut below it: on real BM25 lists the clearest breaks sit in the
    # top 1-3 positions (measured), exactly where a floor blinds the cut.
    # Off by default, opt-in per query; value is decided by the probe-based
    # bench gate, run against the post-recency-fusion ranking (a cutoff
    # inherits the quality of the ordering it cuts — measured: score
    # breaks and relevance boundaries diverge where tool echoes crowd the
    # top). Break method and thresholds are bench-tunable shapes.

  @D44
  Scenario: adaptive expansion respects its cap and honesty on flat distributions
    Given a query whose score distribution shows no clear break
    When it runs with adaptive result count and an explicit maximum
    Then no more than the maximum returns
    And the disclosed confidence says the distribution gave no clear cutoff
    # Measured: common single terms produce honestly flat BM25 lists
    # (fifteen near-identical scores), and the deleted implementation's
    # confidence gate mis-tuned for cosine tripped on 10 of 12 real
    # queries. A flat BM25 list often means nothing matches strongly —
    # expanding on flatness (the deleted behavior) is backwards for the
    # context economy this feature exists to serve. Low-confidence
    # disclosure, never a fabricated break.

  @D44
  Scenario: without adaptive, top_k means exactly k — today's contract unchanged
    Given a store and a query matching more entries than the budget
    When the query runs without adaptive result count
    Then exactly the requested number of results return in relevance order

  @D56
  Scenario: recency joins ranking as a fused rank list, never a score formula
    Given two entries matching a query with equal lexical strength, one recent and one months old
    When the query runs with recency fusion enabled
    Then the recent entry ranks above the old one
    And an entry with decisively stronger lexical match still outranks a merely recent one
    # Measured before specced (same feasibility note). The pathology is
    # real and specific to the cold-start query: pure BM25 on "what was I
    # working on" returned a top-8 with median age 22 DAYS and zero
    # entries under two days — it finds prior sessions' orientation
    # queries, perfect lexical matches all. Rank fusion at moderate
    # weight fixed it (median 1.6d, strongest lexical hit surviving on
    # the first page) and measured as self-limiting: on queries whose
    # results are already fresh, fusion moved the top hit 0-3 positions.
    # The score-formula alternative (bm25 × decay) measured WORSE: same
    # freshness, strongest hit banished to #44 — its tradeoff slope rides
    # on score ratios, which vary per query with BM25's corpus-dependent
    # scales, while rank fusion pays one uniform price everywhere. The
    # recency channel weight is the knob (bench-tunable; 0.5 graduated
    # from measured working hypothesis to the SERVED DEFAULT at the MCP
    # surface by owner ruling 2026-08-01 — the library default stays 0,
    # and adaptive queries and non-relevance orderings never receive the
    # default; 1.0 measurably over-rotates into fresh tool noise).
    # Reproduction-clause note: time-decay is deterministic given the
    # store and the clock — reruns at one moment reproduce exactly. What
    # stays forbidden is hit-boosting; recency fusion reads capture time,
    # never query history.

  @D44
  Scenario: adaptive count over a fused ranking discloses no cutoff rather than inventing one
    Given entries matching a query at varied lexical strength and age
    When the query runs with adaptive result count and recency fusion together
    Then no more than the anchor budget returns
    And the disclosure says the fused ordering gave no clear cutoff
    # Added at critic pass 4 (2026-07-26): the composition was built and
    # disclosed in the tool schema but never pinned. A fused ordering is
    # rank-shaped — reciprocal-rank sums fall smoothly, leaving no score
    # break to cut at — so composing the knobs returns the budgeted count
    # with the flat disclosure. Whether a rank-space cutoff is worth
    # building is the probe's open bench question; until it answers,
    # honesty over invention.

  @D56
  Scenario: an adaptive query never receives the served recency default
    Given a corpus the served recency default demonstrably reorders
    When an adaptive query runs with no recency weight given
    Then its ordering is the pure lexical one, not the fused one
    # The carve-out the preamble promises, pinned: fusion suppresses the
    # score-distribution break the adaptive count cuts at, so a served
    # default that leaked in would silently degrade the bound adaptive
    # promise. Passing both knobs EXPLICITLY still composes as documented
    # (the scenario above) — but the default never volunteers fusion
    # into an adaptive query.

  @D56
  Scenario: a chronological listing never receives the served default
    Given a corpus the served recency default demonstrably reorders
    When the query runs sorted chronologically with no recency weight given
    Then the listing holds the strongest lexical matches, oldest first
    And it is identical to the same listing with fusion explicitly declined
    # The schema promises the weight applies to relevance ordering only.
    # The surface time-sorts the relevance page it retrieved, so a
    # leaked default would change which entries the listing even
    # CONTAINS — round-3 S4 found fusion doing exactly that. On this
    # corpus the fused page loses the strongest match entirely; the pin
    # is that the chronological listing keeps it, first.

  @D5
  Scenario: a present embedding model changes nothing until asked
    Given a store where an ONNX model is installed and reachable
    When a default-configured search runs
    Then results are identical to the same search with no model present
    # journal-recall pins the no-model half (lexical works bare); this pins
    # the converse — availability is not consent. Nothing loads or scores
    # with a model until dense retrieval is explicitly configured.
    # Registered wip 2026-07-31: the Given is unestablishable in this build
    # — no code reads any model path (src/embeddings/ was deleted with the
    # tree era), so a binding could only fake "installed and reachable" and
    # would stay green if dense auto-activation were ever reintroduced. It
    # binds together with the dense-fusion scenario below, whose activation
    # path is the one this Given must name.

  @D5
  Scenario: dense fusion is an explicit opt-in that fuses, never replaces
    Given a store explicitly configured for dense retrieval
    When a query runs
    Then lexical and dense rankings are fused by reciprocal rank fusion
    And removing the configuration restores pure lexical results
    # Spec ahead of code: the flat journal has no dense path today, and per
    # charter it stays absent until dense testing is unequivocal — possibly
    # forever. Binding note (updated 2026-07-23): gnt's wip register is
    # scenario-scoped, so when the rest of this file binds, this scenario
    # alone stays open as { feature, scenarios } — no file-level hostage.
    # Ratified tier ladder (2026-07-23): BM25 | BM25+static | BM25+int8
    # ONNX — every tier BM25-anchored; pure dense has no seat at any tier.
    #
    # RESERVED SHAPES — scenarios to add when dense lands, not before:
    # 1. A configured dense store whose embedder is unreachable degrades
    #    LOUDLY — it never silently serves lexical results as hybrid.
    #    (Covers in-process model load failure and a dead remote embedder
    #    alike; mechanism-neutral, no transport named in steps.)
    # 2. Remote and local embedders rank identically — the embedder-
    #    locality analog of journal-library's same-truth scenario.
    # 3. Embeddings carry model provenance (model id + dimensions), and a
    #    query under a different model fails loudly or re-embeds — vectors
    #    from different spaces are never silently compared. (Added by the
    #    first completeness-critic pass 2026-07-24: called load-bearing in
    #    the tier-ladder review, then dropped from the batch.)
