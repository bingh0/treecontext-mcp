docket: 1

# treecontext — the docket. Reconstructed 2026-09-28 as a characterization
# backport: every entry below transcribes a ruling already on the record —
# the charter (tests/journal/README.md), the fence, the ledger, the feature
# headers, docs/release-charter-0.1.md, and the owner-ruling notes in the
# project journal (node ids in comments). Nothing here is a new decision.
# Provenance tags are honest to the record: [V] where the owner's words are
# recorded, [I>V] where the agent drafted and the owner ratified at a
# cold-read or audit, [I] where the record shows no ratification. The
# visionary ratifies the whole transcription by chain (the closing entry);
# a disputed line becomes a dated correction, never an edit in place.
# Dates never decrease in file order, so the attribution program's needs
# and rulings (formerly N1-N5, D1-D8 of the first draft) are renumbered
# after everything they postdate.

D1 2026-07-12 [I>V]
  resp:  the on-disk model format of the runtime is declined on measurement; the `int8` quantization variant is the win, and the question reopens only on a model of materially different scale [I>V]
  ->     fence-declined ort-on-disk-format
  touches: none

D2 2026-07-16 [I>V]
  resp:  a TypeScript library plus an MCP server providing a searchable chat-session journal, so an agent recalls prior-session context at cold start or after a clear, replacing context compaction as the recall mechanism and preserving prompt-cache economics [I>V]
  ->     structural
  serves: N1
  touches: none
# the charter, owner, 2026-07-16 (tests/journal/README.md); the pitch

D3 2026-07-16 [I>V]
  resp:  capture is automatic: every user message, tool invocation, and assistant turn enters the journal, none filtered out; output of repo-reading tools is trail, kept as a bounded preview and re-derivable, and output of execution and external tools is treasure, kept in full [I>V]
  ->     structural
  serves: N3
  touches: D2
# charter detail (a) capture; grep classed as trail, owner-confirmed 2026-07-16

D4 2026-07-16 [I>V]
  resp:  one SQLite file holds the full journal, zstd-compressed, with `BM25` lexical search over a bounded index view; the index is a view, the journal is the record [I>V]
  ->     structural
  serves: N1
  touches: D2
# charter detail (b)

D5 2026-07-16 [I>V]
  resp:  dense retrieval is optional and off by default; if it ever enters it does so as a fused second ranked list, never as a replacement for the lexical ranking [I>V]
  ->     structural
  serves: N4
  touches: D4
# charter detail (c)

D6 2026-07-16 [I>V]
  resp:  the single-author session structure is a ranking signal: time, turn sequence, and role rank, they do not merely filter [I>V]
  ->     structural
  serves: N4
  touches: D4
# charter detail (e)

D7 2026-07-16 [I>V]
  resp:  the library is usable without the MCP server; any Node program that opens the store gets the same journal, and the server is one consumer, not a gatekeeper [I>V]
  ->     structural
  serves: N10
  touches: D2
# charter detail (f)

D8 2026-07-16 [I>V]
  resp:  the surfaces the agent reads are first-class product: tool descriptions, hooks, the session-start reminder, and the `AGENTS.md` block teach the protocol, and the platform payload shapes are pinned [I>V]
  ->     structural
  serves: N14
  touches: D2
# charter detail (g)

D9 2026-07-16 [I>V]
  resp:  many agents share one store: concurrent sessions, subagents, and worktree clones journal into namespaces of the same store, isolated by default and mergeable on purpose, with provenance kept [I>V]
  ->     structural
  serves: N5
  touches: D2
# charter detail (h)

D10 2026-07-16 [I>V]
  resp:  an attachment is journaled as a stored description plus a URI reference to the pdf, image, video, or audio; the bytes stay out of the store [I>V]
  ->     structural
  serves: N11
  touches: D2
# charter detail (i)

D11 2026-07-16 [I>V]
  resp:  hierarchical summary trees in the journal are declined: built, benchmarked, removed; no benefit for single-author chat-session recall over a flat store [I>V]
  ->     fence-declined trees-in-the-journal
  touches: D4

D12 2026-07-16 [I>V]
  resp:  the dual-tree promotion pipeline is declined: complexity without measured recall benefit [I>V]
  ->     fence-declined dual-tree-promotion
  touches: D11

D13 2026-07-16 [I>V]
  resp:  complex query fusion across journal and code results is declined; they stay simple, separately presented surfaces [I>V]
  ->     fence-declined cross-surface-fusion
  touches: D5

D14 2026-07-16 [I>V]
  resp:  server-side summarization or any model in the loop is declined; summarizing is the calling agent's job, and the lexical backend registers no checkpoint or summarize machinery and its instructions must not mention any [I>V]
  ->     fence-declined server-side-llm
  serves: N14
  touches: D8

D15 2026-07-16 [V]
  resp:  the charter suite is the living spec: the feature files under the corpus root are the product spec, written in owner language, audited by the owner, and when code and charter disagree the charter wins [V]
  ->     structural
  serves: N13
  touches: D2
# owner legacy-file ruling, 2026-07-16 (tests/journal/README.md)

D16 2026-07-17 [I>V]
  resp:  the platform-independent capture surface lives in the library: events from any platform journal identically through the staging surface, while the capture feature pins the reference platform's payloads [I>V]
  ->     structural
  serves: N3
  touches: D3 D7
# owner comment 1, 2026-07-17 (journal-library.feature)

D17 2026-07-17 [I>V]
  resp:  gherkin-node-test is the corpus's linter, ratified linter-only first, executor from the dialect switch, and sole executor once the second parser retired [I>V]
  ->     structural
  serves: N13
  touches: D15
# runner ratified 2026-07-17; executor switch 2026-07-23; sole executor 2026-08-26

D18 2026-07-23 [I>V]
  resp:  the retrieval ladder is `BM25`, then `BM25` plus static embeddings, then `BM25` plus `int8` ONNX, every tier anchored on `BM25`; pure dense retrieval has no seat at any tier [I>V]
  ->     fence-declined pure-dense-retrieval
  serves: N4
  touches: D5

D19 2026-07-23 [I>V]
  trig:  code-static embeddings are proposed for the journal [I>V]
  resp:  deferred behind a bench gate: extend the recall bench with a code-static variant and measure whether code-dense adds recall the lexical plus English-static hybrid misses; if it earns a seat it enters as n-way rank fusion, never concatenation and never content-type routing [I>V]
  ->     fence-deferred code-static-embeddings
  touches: D18

D20 2026-07-23 [I>V]
  trig:  an embedder is proposed as a service, sidecar or container [I>V]
  resp:  postponed past the MVP: it is a transport for the embedder tier, not a retrieval tier, and its reserved shapes land only when dense does [I>V]
  ->     fence-deferred embedder-as-a-service
  touches: D18

D21 2026-07-23 [I>V]
  resp:  reference frequency never feeds default ranking; it feeds whole-session eviction ordering only, because hit-boosted ranking is the rich-get-richer loop that breaks reproducible search [I>V]
  ->     fence-declined reference-frequency-ranking
  serves: N4
  touches: D6

D22 2026-07-23 [I>V]
  resp:  reliance is measured by exports, not hits (option c); it only reorders whole-session eviction, and the newest session stays protected; copy-forward promotion of hot entries is the designated post-MVP shape if reordering proves too weak [I>V]
  ->     structural
  serves: N7
  touches: D21
# journal-storage.feature, ruled 2026-07-23, option (c)

D23 2026-07-23 [I>V]
  resp:  eviction is whole-session only; per-entry or fragment eviction is declined, because rounds are the conversation-window fabric [I>V]
  ->     fence-declined per-entry-eviction
  serves: N7
  touches: D22

D24 2026-07-23 [I>V]
  resp:  power-loss tail durability is declined: consistency across power loss is promised, the store opens clean, and the last committed moments may be honestly lost; never traded for write latency the charter does not need [I>V]
  ->     fence-declined power-loss-tail-durability
  touches: D4

D25 2026-07-23 [I>V]
  trig:  the process dies mid-write [I>V]
  resp:  the store opens clean and nothing already committed is corrupted [I>V]
  sib:   none -- the failure case is the declined tail durability above
  serves: N7
  touches: D24

D26 2026-07-23 [I>V]
  resp:  a media entry is an event, not an asset: exactly one reference per entry, several attachments are several entries, the same file attached twice is two entries, a repeat sighting is a new event, and drift detection is a hash-in-metadata convention, not a store mechanism [I>V]
  ->     structural
  serves: N11
  touches: D10

D27 2026-07-23 [I>V]
  resp:  multi-reference entries, media dedup, and media versioning machinery are declined; each attachment is a fact about the conversation and no bytes are stored, so duplicates cost nothing and a new version seen is a new event [I>V]
  ->     fence-declined media-machinery
  touches: D26

D28 2026-07-23 [I>V]
  resp:  thumbnailing, transcoding, and byte storage of media are never in scope: the journal is a text store and the description is the searchable surface [I>V]
  ->     fence-declined media-bytes
  serves: N8
  touches: D26

D29 2026-07-23 [I>V]
  resp:  the MCP tool surface is universal and library capture is platform-independent; Claude Code is the only live-verified capture platform, and nothing the agent reads may claim an unverified adapter works [I>V]
  ->     structural
  serves: N3
  touches: D16 D8
# platform scope, ruled 2026-07-23 (journal-agent-surface.feature)

D30 2026-07-23 [I>V]
  resp:  advertising an unverified platform adapter is refused; the codex, cursor, gemini, opencode, and vscode adapters stay labeled unverified and unadvertised until each earns a live-payload verification pass, and bringing an adapter onto the charter's capture semantics is part of that pass [I>V]
  ->     fence-declined advertising-unverified-adapters
  serves: N3
  touches: D29

D31 2026-07-23 [I>V]
  resp:  the suite is structurally unable to lie about what it checked: a dialect gate, an orphan ratchet, a wip register with written whole-feature rulings, a tag allowlist, and a step-source lint guard the whole corpus [I>V]
  ->     structural
  serves: N13
  touches: D15 D17
# tag-allowlist guard implemented 2026-07-23; guard inventory in tests/journal/README.md

D32 2026-07-24 [V]
  resp:  the tree-sitter code index is deprecated in full: too low level for the lane this process operates at, and with million-token contexts an AST tool saves a few tokens, not enough to matter; recovery, if ever wanted, is git [V]
  ->     fence-declined code-index
  touches: D13
# owner's why recorded on the fence; resights when context windows fall materially below the premise

D33 2026-07-24 [I>V]
  resp:  treecontext is not designed around unbuilt addons: it stands on its own behind a published consumer contract of stable node ids, portable exports, open metadata, and disclosed eviction, and an addon's requirements enter through that addon's own scoping as new rulings, never inferred ahead of it [I>V]
  ->     fence-declined designing-around-addons
  touches: D32

D34 2026-07-24 [I>V]
  resp:  charter detail (d) is closed as a lettering skip: the file map cites every other letter and no one can reconstruct a dropped one; if a real detail ever resurfaces it enters through a new ruling [I>V]
  ->     boundary
  serves: N13
  touches: D2

D35 2026-07-24 [I>V]
  resp:  the compaction lifecycle is out of the MVP charter: ccr owns the compaction interaction, and treecontext's pre-compact snapshot and session-start rehydration hooks stay as working mechanics, unspecced by this suite [I>V]
  ->     fence-declined compaction-lifecycle
  touches: D8
# resights when Claude Code ships a clear-session hook

D36 2026-07-24 [I>V]
  trig:  the disk fills during a write [I>V]
  resp:  the write fails loudly and nothing already stored is corrupted [I>V]
  sib:   none -- this entry is itself the failure case of the storage promise
  serves: N7
  touches: D25
# critic pass 1 finding, bound via the page ceiling

D37 2026-07-25 [I>V]
  resp:  the feedback tool is dropped from the tool surface: on the lexical backend it was a no-op that still promised an effect, wiring it into ranking is the rich-get-richer loop, and every registered tool is context tax [I>V]
  ->     fence-declined feedback-tool
  touches: D21

D38 2026-07-25 [I>V]
  resp:  shared-process serving, the daemon, is declined: it went with the tree era as a coupled dependency; `serve` runs standalone per session, and the multi-agent story is namespaces of one store with a single capture-drain owner [I>V]
  ->     fence-declined daemon
  touches: D9

D39 2026-07-25 [I>V]
  resp:  tool schemas describe only what the backend does; a schema that still described subtree drilling, multimodal retrieval, or dense fusion after the tree era is a defect [I>V]
  ->     structural
  serves: N14
  touches: D8 D14
# critic pass 3

D40 2026-07-25 [I>V]
  trig:  a store built by a deleted backend, the tree era, is opened [I>V]
  resp:  the store refuses loudly and read-only, and nothing is migrated silently or lost [I>V]
  sib:   none -- refusal is the promise; there is no silent path to fail into
  serves: N7
  touches: D4

D41 2026-07-26 [I>V]
  resp:  score fusion for the recency channel, decay multipliers or normalized score fusion, is declined on measurement: a decay slope rides on corpus-dependent lexical score ratios where rank fusion pays one uniform price and needs no normalization [I>V]
  ->     fence-declined recency-score-fusion
  serves: N4
  touches: D6

D42 2026-07-26 [V]
  resp:  the product keeps its name: the tree is the working tree, git's own term, one journal per working tree; renaming reopens only on an npm or trademark collision [V]
  ->     fence-declined renaming-the-product
  touches: none
# owner, at the beta planning discussion

D43 2026-07-26 [I>V]
  resp:  the tool surface is exactly the ruled set: query, status, insert, delete, clear, export, import, and merge from agent under the full policy; tool membership is itself spec [I>V]
  ->     structural
  serves: N14
  touches: D39 D37

D44 2026-07-26 [I>V]
  resp:  an adaptive result count over a fused ranking returns the budgeted count and discloses that no cutoff was found, rather than inventing one [I>V]
  ->     structural
  serves: N4
  touches: D6

D45 2026-07-27 [I>V]
  trig:  a performance number is proposed as a release gate [I>V]
  resp:  deferred: scenarios pin shapes, numbers live in the bench and stay bench-tunable until a number becomes spec, and then it gets boundary pairs [I>V]
  ->     fence-deferred performance-gate-numbers
  touches: none

D46 2026-07-27 [I>V]
  trig:  npm packaging and a schema semver policy are proposed [I>V]
  resp:  deferred until after the deletion phase [I>V]
  ->     fence-deferred release-engineering
  touches: none

D47 2026-07-28 [I>V]
  resp:  authored text, user and assistant, is indexed in full: the old character-prefix caps cost measurable recall, and only tool output keeps a bounded index reach [I>V]
  ->     structural
  serves: N4
  touches: D4
# ruled by measurement, cap sweep

D48 2026-07-29 [I>V]
  resp:  retention, stated plainly: the searchable store is bounded by recency through a session cap, the byte budget is a demotion backstop, and archives accumulate indefinitely on disk [I>V]
  ->     structural
  serves: N7
  touches: D22 D23

D49 2026-07-29 [I>V]
  trig:  the store cannot get under budget without destroying protected rows [I>V]
  resp:  it says so: status carries a retention gauge and a storage warning, and protected rows are never destroyed to meet the budget [I>V]
  sib:   none -- refusal with a visible warning is the failure handling itself
  serves: N7
  touches: D48

D50 2026-07-29 [I>V]
  resp:  trust tiers at the tool surface: a read-only server exposes only the reading tools, a contributor adds but never removes, and merging and reliance bookkeeping are full-trust writes [I>V]
  ->     structural
  serves: N15
  touches: D43
# post-charter surface, 2026-07-29

D51 2026-07-30 [I>V]
  resp:  install detects what exists, shows a dry-run plan, merges rather than clobbers, registers where the agent itself reads, and doctor diagnoses honestly with fix commands; uninstall reverses the wiring and never the record [I>V]
  ->     structural
  serves: N9
  touches: D8
# post-charter surface, 2026-07-30; the fix-command clause binds by enumerating the doctor registry, never by sampling it

D52 2026-07-31 [V]
  resp:  a contested conversation-window neighbor goes to whichever hit comes first in the returned ordering, not to the higher-ranked hit regardless of sort; rank-order claiming is declined and reversible [V]
  ->     fence-declined rank-order-window-claiming
  touches: D6
# owner ruling R7, 2026-07-31; fenced 2026-08-01
# pass 3 of the review (2026-09-28): stays as ruled for now; the owner wants recency's importance in a lexical query investigated before this or D56 moves

D53 2026-07-31 [I>V]
  trig:  an agent config the installer must write is unwritable [I>V]
  resp:  the install fails loudly for that agent, changes nothing for it, isolates the failure per agent, and exits non-zero [I>V]
  sib:   none -- this entry is the failure case of the install promise
  serves: N9
  touches: D51
# adversarial review F8

D54 2026-07-31 [I>V]
  resp:  near-universal query tokens are pruned for speed and never at the cost of a discriminative hit: pruning applies only above a corpus-size floor, a query of only pruned tokens still matches, and small corpora are never pruned [I>V]
  ->     structural
  serves: N4
  touches: D4
# adversarial review F4: this knob was invisible

D55 2026-07-31 [I>V]
  trig:  a demotion has no archive destination or the archive write fails [I>V]
  resp:  demotion refuses to shrink rather than trade the record for the bound; a demotion that proceeds is always on the record, length and archive path kept and a marker on hits [I>V]
  sib:   none -- refusal is the failure handling; nothing shrinks silently
  serves: N7
  touches: D48 D49

D56 2026-08-01 [V]
  resp:  recency fusion is the served default at the MCP surface at weight `0.5`, fused as a rank list, never a score formula; the library default stays zero, an explicit zero opts out, and the default is never applied to adaptive queries or non-relevance orderings [V]
  ->     structural
  serves: N4
  touches: D6 D41 D44
# owner ruling 2026-08-01

D57 2026-08-01 [V]
  trig:  the experimental capture flag is given without a named agent [V]
  resp:  the install is refused: the name is the consent [V]
  sib:   none -- this entry is the failure case of the opt-in
  serves: N9
  touches: D30 D51

D58 2026-08-05 [I>V]
  resp:  the first hook on a fresh install captures without waiting for a server: a hook may mint the store it binds, applying one definition of fresh and the full migration ladder; a store holding rows is never migrated by a hook; a second starter waits and finishes the ladder [I>V]
  ->     structural
  serves: N3
  touches: D3 D16
# issue 2, 2026-08-05

D59 2026-08-05 [I>V]
  resp:  schema changes never eat a store: every migration on the ladder runs behind a backup taken while store and backup are twins, and only an unwritable store refuses; this replaces the earlier additive-automatic, destructive-opt-in split [I>V]
  ->     structural
  serves: N12
  touches: D4

D60 2026-08-06 [I>V]
  resp:  a destructive migration backs up while store and backup are twins and records a completion verdict at migration time; the count-at-sweep-time content check is superseded, because eviction makes it refuse forever for a healthy store and later captures mask migration loss [I>V]
  ->     structural
  serves: N12
  touches: D59
# journal nodes 073296097c (rulings) and 5952d43a (cold-read ratification, 2026-08-07)

D61 2026-08-06 [I>V]
  resp:  the backup sweep is manual and opt-in: it deletes only backups with a verified verdict, refuses failed or missing verdicts and labels each refusal, verifies every generation independently, and one confirmation covers the whole run because safety lives in per-item verification [I>V]
  ->     structural
  serves: N12
  touches: D60

D62 2026-08-06 [I>V]
  resp:  automatic or age-based cleanup of backups is never in scope; nothing deletes a backup without a user running the command [I>V]
  ->     fence-declined automatic-backup-cleanup
  serves: N12
  touches: D61

D63 2026-08-06 [I>V]
  resp:  declined together: verify-on-demand or grandfathering for unverdicted backups, extra ceremony for large sweeps, all-or-nothing and prompt-per-refusal sweep modes, always-keep-newest generation rules, deleting corrupt backups as junk, listing foreign backup files as unrecognized, a store removal that takes no backups or all of them, and interactive per-item confirmation [I>V]
  ->     fence-declined sweep-alternatives
  touches: D61

D64 2026-08-06 [I>V]
  resp:  when the completion comparison after a migration fails, the store still opens: refusing would undo nothing and brick a store whose backup sits beside it; instead it warns loudly at migration time naming the backup as the intact copy and records the failed verdict, so doctor is never the first place a user learns their migration lost data [I>V]
  ->     structural
  serves: N12
  touches: D60

D65 2026-08-06 [V]
  resp:  prune honors the same spare rule as removal: verified backups go with the stray, failed or missing-verdict backups are spared as shells, and doctor reports the orphan; nothing in this tool deletes the only intact copy of a store's data [V]
  ->     structural
  serves: N12
  touches: D61
# journal node 5952d43a: the visionary overruled the pass's accept-the-edge entry at the cold-read; owner-ruled permanent 2026-08-24 (node a562ed36)

D66 2026-08-06 [I>V]
  trig:  a backup-size column is proposed for the store listing [I>V]
  resp:  cut as over-reach; doctor is the single place backup disk is reported [I>V]
  ->     fence-deferred stores-list-backup-split
  touches: D61

D67 2026-08-06 [I>V]
  trig:  labeling or hiding a shell directory in the store listing is proposed [I>V]
  resp:  deferred; the listing shows a shell the way it shows any database-less directory, and doctor explains the orphan [I>V]
  ->     fence-deferred shell-labeling
  touches: D65

D68 2026-08-06 [I>V]
  trig:  a backup the sweep refuses stays on disk [I>V]
  resp:  accepted consequence, not a gap: orphans with failed or missing verdicts, corrupt backup files, and pre-verdict backups stay until the user removes them by hand [I>V]
  ->     fence-assumption hand-deletion
  touches: D61

D69 2026-08-06 [I>V]
  resp:  outside the reviewed contract: documenting the sweep is a release checklist item, where the verdict record lives and what it survives is design tier for the builder, and the sweep's subcommand name is an implementation decision [I>V]
  ->     boundary
  serves: N12
  touches: D61

D70 2026-08-10 [V]
  resp:  when a backup's verdict is success but its live store is gone, the sweep still refuses, with the distinct reason "orphaned verified backup" naming the removal command as the reclaim path; removal reclaims the shell explicitly and labels it an orphaned verified backup, never a spared live rollback; doctor names the exact reclaim command [V]
  ->     structural
  serves: N12
  touches: D61 D65
# build-review finding 7, journal node cef03f7d: refuse plus explicit rm; rejected: auto-reclaim, advice-only

D71 2026-08-11 [V]
  resp:  fix all eleven: the removal dry run on an orphan shell names the directory it would remove; a mixed shell is a bound scenario where removal takes the orphan, spares the rollback, and exits success while a rollback-only shell keeps its refusal exit; the sweep removes a verdict sidecar whose backup is gone; doctor's reclaim advice is honest about addressability [V]
  ->     structural
  serves: N12
  touches: D70

D72 2026-08-11 [V]
  resp:  a bare store name that would create a store and fails the addressability check is refused at creation only; opening an existing odd-named store keeps working, so no lockout on upgrade, and paths pass through untouched [V]
  ->     structural
  serves: N12
  touches: D71
# journal node 8a08c093; rejected: refuse-always (strands existing stores), keep-coping-downstream (leaves the class alive)

D73 2026-08-11 [V]
  trig:  dense search is proposed for the first release [V]
  resp:  both dense scenarios are excluded from the release and stay in the wip register; dense search is post-release work [V]
  ->     fence-deferred dense-search-post-release
  touches: D18 D5
# journal node 8a08c093; release charter section 2 item 12

D74 2026-08-12 [V]
  resp:  the release charter is ratified: the first release marks the end of the closed beta with all MVP features complete, good scenario coverage, unit tests, a passing linter, and modest private beta testing; from ratification, readiness is the checklist and amendments require the sanctioned-change protocol [V]
  ->     structural
  serves: N13
  touches: D15
# docs/release-charter-0.1.md, visionary cold-read 2026-08-12; journal node 9488bcbe

D75 2026-08-12 [V] reverses D66
  resp:  the store listing gains the backup-size split; doctor remains the authoritative disk-debt surface [V]
  touches: D66
# pulled into the release at the charter cold-read

D76 2026-08-12 [V] reverses D67
  resp:  the store listing gains an honest label for shells [V]
  touches: D67

D77 2026-08-12 [V]
  resp:  the HTTP transport is tombstoned: both of its original consumers are gone and it is an unused network surface [V]
  ->     fence-declined http-transport
  serves: N8
  touches: D43
# audit dispositions, journal node e23c5426

D78 2026-08-12 [V]
  resp:  capture rows are attributed to their namespace in staging before the release, so isolation holds on the capture side and not only at query time [V]
  ->     structural
  serves: N5
  touches: D9
# audit dispositions, journal node e23c5426; migration 020

D79 2026-08-12 [V]
  resp:  the pre-release audit runs at full scope and the release candidate waits for it [V]
  ->     boundary
  serves: N13
  touches: D74
# journal node e23c5426

D80 2026-08-12 [V]
  resp:  the store is the arbiter: dedup is enforced by database constraints, the capture drain claims its batches atomically, and the primary claim is a heartbeat lease inside the database, so every consumer inherits the invariants by opening the store; the shipped lockfile model was a technical oversight [V]
  ->     structural
  serves: N5
  touches: D9 D38
# journal node c48ada70; program G before E; final-shape column pass mandated

D81 2026-08-12 [V]
  resp:  the tool-writer claim is per store and namespace and the drain owner is one per store, arbitrated per tick, attributing every staged row to its stamped namespace [V]
  ->     structural
  serves: N5
  touches: D80
# C2 role split, multi-user design note; journal node 91e4028a ("full multi-user in C")

D82 2026-08-12 [V]
  resp:  three builder decisions ratified: fetching a current resume pointer is not reliance, reliance recording is a full-policy-only write, and the dense exclusion covers both dense scenarios [V]
  ->     structural
  serves: N15
  touches: D22 D50 D73
# journal node 9488bcbe

D83 2026-08-13 [V]
  resp:  every store-arbiter chunk follows the strict cycle: design review, implementation, adversarial review with every confirmed finding fixed; data-loss avoidance is the top priority [V]
  ->     boundary
  serves: N12
  touches: D80
# journal node 232b4219

D84 2026-08-14 [I>V]
  resp:  the operations exit contracts are bound: the removal exit asymmetry, the sweep's partial-completion exit per trigger with the self-healing stranded-sidecar non-trigger, prune's dry run, and doctor's backup advice carried in the fix channel [I>V]
  ->     structural
  serves: N12
  touches: D71 D51

D85 2026-08-14 [I>V]
  trig:  a deletion-failure world must be staged on every platform [I>V]
  resp:  staged by a path-scoped filesystem fault seam, not file modes, because mode-based staging would unbind the scenarios on Windows and the sidecar-only failure cannot be staged on a real filesystem [I>V]
  ->     fence-assumption fault-seam-staging
  touches: D84
# resights when a portable filesystem-fault-injection primitive exists across POSIX and Windows

D86 2026-08-14 [V]
  resp:  a curated row is attributed to the exact session that made it from the store's own capture echoing its tool calls; a guess never outranks evidence and a missing echo never invents an id [V]
  ->     structural
  serves: N17
  touches: D3 D9
# docs/session-identity.md section 7, ruled 2026-08-14 (journal node c09a35fe, "basically ground truth"), implemented 2026-08-15

D87 2026-08-15 [V]
  resp:  user backups get no verdict, ever: verdicts belong to migration backups, whose twin state at the moment of recording is what makes them checkable; a user copy's validity is the online backup interface's guarantee, not a recorded claim [V]
  ->     fence-declined user-backup-verdicts
  serves: N12
  touches: D60
# program F scout dispositions, rulings node of 2026-08-15; resights when user backups stop resting on that guarantee

D88 2026-08-15 [V]
  resp:  user backups are invisible to the store listing and doctor, which count only migration backups by exact filename, and the size column stays database-only because the write-ahead siblings are transient [V]
  ->     structural
  serves: N12
  touches: D75

D89 2026-08-15 [V]
  trig:  a listing row could be labeled both shell and stray [V]
  resp:  it cannot: a shell has no database and a stray has an openable empty one, so the precedence branch stays as written and each label is pinned separately [V]
  ->     fence-assumption shell-stray-precedence
  touches: D76

D90 2026-08-15 [V]
  resp:  Windows namespace attribution goes into the identity program before the release candidate: the drain publishes a session-keyed namespace annotation from exact echo evidence, and hooks resolve by the session id their payload carries [V]
  ->     structural
  serves: N17
  touches: D86 D78
# journal node d177e179; do it right over defer

D91 2026-08-15 [V]
  resp:  the public package is `treecontext-mcp` on a fresh public repository populated by an opt-in file copy with no history; the command, the tool prefix, and the store directory keep the product name [V]
  ->     boundary
  serves: N8
  touches: D42
# docs/public-release.md, ruled 2026-08-15; journal nodes 5a8941ef and 8c03411b

D92 2026-08-16 [V]
  resp:  silent identity succession is a defect: a project's binding key changing under it must never orphan the journal; succession is announced, ambiguity fails closed, past splits are detectable and repairable without data loss, and the full three-part program of succession, a doctor detector, and store merge goes in before the release candidate [V]
  ->     structural
  serves: N6
  touches: D9 D80
# journal nodes 7e74a334 (defect) and 60432cf2 (ruling)

D93 2026-08-16 [V]
  resp:  no schedule pressure: every phase of the release-candidate sequence runs and nothing is cut; the root cause was a charter gap, so the fix is the class, not the instances [V]
  ->     boundary
  serves: N6
  touches: D92
# journal node 1ddad164

D94 2026-08-16 [V]
  trig:  a pid-keyed namespace annotation outlives its server [V]
  resp:  an annotation is honored only while its server's namespace lease is heartbeating, never on pid existence, because a recycled pid answers for a stranger [V]
  sib:   none -- not honoring is the failure handling
  serves: N17
  touches: D90
# journal node 922d7e2a; authority order recorded the same day: owner ruling, design note, feature file, code

D95 2026-08-20 [V]
  resp:  the ratified session-first rung order is restored: the session rung is causal and a session id is never recycled while the pid file is structurally shared, so the session-keyed annotation outranks the pid rung; the mid-session relaunch counter-case is accepted as a disclosed, self-healing residual [V]
  ->     structural
  serves: N17
  touches: D90 D94
# journal node 6e0a9352; the C#2 inversion reverted

D96 2026-08-20 [V]
  resp:  same-namespace exclusivity is retired: a second server on an occupied namespace serves alongside the holder, as long as concurrent writers are safe and every row still says which session it belongs to; the primary claim remains one lease holder per namespace, for visibility and attribution [V]
  ->     structural
  serves: N5
  touches: D80 D86
# store-as-arbiter design note section 8, amendment 8; the owner's words in journal node c6f8ed2e: "as long as concurrent writers is safe, with clear attribution, i do not see why not"

D97 2026-08-21 [V]
  resp:  agent-orchestration observability for subagents is a future consumer of this store, not scoped now; the current multi-user work must stay compatible with it [V]
  ->     boundary
  serves: N5
  touches: D96
# journal node cacb879a, design input

D98 2026-08-22 [V]
  resp:  treecontext offers to write the pane wiring into the reader's own configuration itself, because a reader that survives a typo by drawing nothing makes every mistake invisible; pulled into the release line after no closed-beta tester got a pane by hand-naming paths [V]
  ->     structural
  serves: N16
  touches: D8
# journal node 0ef47277: tc writes the reader\'s config itself; rejected: the reader adding the pane, reader auto-discovery, diagnostics-only

D99 2026-08-24 [V] reaffirms D65
  resp:  the prune ruling is permanent, with no resight condition, because the principle does not track external state [V]
  touches: D65
# journal node a562ed36, which also adopted the resight conditions now written on D1, D32, D35, D42, D85, and D87

D100 2026-08-24 [I>V] reverses D46
  resp:  release engineering is discharged, overtaken by events: packaging shipped with the release-candidate tarballs and the schema policy lives in the additive migration ladder and the public-release plan [I>V]
  touches: D46

N1 2026-08-25 [I>V] agent 5
  need:  When I start a session — or survive a context clear — I can recover what I was working on and what comes next by asking, instead of re-deriving it; my prompt cache stays warm because orientation is one query. [I>V]
# Cold-start orientation

N2 2026-08-25 [I>V] agent 5
  need:  I trust what the journal does NOT show as much as what it shows: dropped or failed captures leave visible gap markers, nothing is filtered silently, and retention refuses rather than loses. [I>V]
# Honest silence

N3 2026-08-25 [I>V] agent 5
  need:  What happened in my session enters the journal without anyone curating it, on whatever platform I work in that day. [I>V]
# Automatic capture, every platform

N4 2026-08-25 [I>V] agent 5
  need:  Search ranks by the words actually written — role-weighted so my directives outrank my tools' chatter — and when nothing distinguishes the candidates, the newest thread wins; I can always turn recency off and get pure `BM25`. [I>V]
# Lexical honesty in ranking

N5 2026-08-25 [I>V] operator 5
  need:  My concurrent sessions, subagents, and worktree clones journal into namespaces of one store — isolated by default, mergeable on purpose, and the merge never destroys either side. [I>V]
# Many agents, one store, deliberate contact

N6 2026-08-25 [I>V] operator 5
  need:  Renaming, gaining a remote, changing URL form, or working in a worktree never silently orphans my journal; succession is announced, ambiguity fails closed, and past splits are detectable and repairable without data loss. [I>V]
# The journal survives the project's own history

N7 2026-08-25 [I>V] operator 4
  need:  Under storage pressure the journal archives whole sessions to disk before deleting anything, refuses to evict what it cannot archive, never touches the newest session, and evicts least-relied-on history first. [I>V]
# Retention shrinks, never destroys

N8 2026-08-25 [I>V] operator 5
  need:  Everything stays on this machine in modes the OS enforces; there is no network surface; telemetry is counts-only unless I explicitly opt in; logs never contain message bodies; sharing surfaces redact. [I>V]
# Local, private, and quiet about it

N9 2026-08-25 [I>V] operator 3
  need:  Install detects what exists, shows a dry-run plan, merges rather than clobbers my own prose, and doctor diagnoses honestly with fix commands; uninstall reverses the wiring and never the record. [I>V]
# Wiring that asks permission and undoes itself

N10 2026-08-25 [I>V] consumers 3
  need:  A program that wants a memory but not an agent gets the same journal through the library that the MCP server serves — same results for the same query and knobs. [I>V]
# One truth, two consumers

N11 2026-08-25 [I>V] agent 2
  need:  A pdf/image/video/audio attachment becomes a searchable entry carrying its URI and my description of it — the bytes stay out of the store. [I>V]
# Attachments by reference, findable by description

N12 2026-08-25 [I>V] operator 5
  need:  Destructive migrations back up while store and backup are twins and record a completion verdict; the sweep deletes only verified backups; nothing automatic ever deletes what might be the last copy. [I>V]
# Dangerous operations leave evidence

N13 2026-08-25 [I>V] visionary 5
  need:  The feature suite structurally cannot lie about what it checked — one parser where possible, ratcheted debt registers, guards over the whole corpus — so the spec remains the artifact the human audits instead of the code. [I>V]
# The corpus is load-bearing (the aBDD requirement)

N14 2026-08-25 [I>V] agent 3
  need:  The surfaces the agent reads — tool descriptions, session-start reminder, AGENTS.md block — describe only what the backend does and carry enough protocol that a cold agent uses the journal correctly unprompted. [I>V]
# The agent teaches itself the protocol

D101 2026-08-26 [I>V]
  resp:  gherkin-node-test is the sole linter and executor corpus-wide; the two-parser cross-check retires because no second parser is left to disagree [I>V]
  ->     structural
  serves: N13
  touches: D17 D31

D102 2026-08-27 [V]
  resp:  the sidecar is a post-charter surface, not charter detail (h): pane files on disk beside the store, pure data conformant to the reader's pane contract; the renderer never runs treecontext's code, stale health never reads as an all-clear, only the drain owner writes a pane and rewrites it on every drain, and a drain that fails confesses [V]
  ->     structural
  serves: N16
  touches: D98 D81
# ruled 2026-08-27; the feature header's former (h) citation was drift, corrected the same day

N15 2026-08-27 [I>V] operator 3
  need:  When I hand my store to a lesser-trusted agent, the tools its tier excludes are absent, not refused — a reader cannot be talked into writing on either face, a contributor adds but never removes, and reliance recording stays a full-tier privilege. [I>V]
# Tool surfaces sized to trust

N16 2026-08-27 [I>V] operator 3
  need:  I can see on screen, live, whether capture is landing or silently failing — through a pane that is pure data: the renderer never runs treecontext's code, stale health never reads as an all-clear, and treecontext offers to write the wiring itself because a reader that survives a typo by drawing nothing makes every mistake invisible. [I>V]
# The journal shows itself filling

N17 2026-08-27 [I>V] operator 4
  need:  Every journal row ends up attributed to the exact session that made it when evidence exists — the store's own capture echoing its tool calls — and degrades honestly when it doesn't: a guess never outranks evidence, never publishes a namespace, and a missing echo never invents an id. [I>V]
# Attribution earned, never guessed

D103 2026-08-28 [V] reaffirms D4
  resp:  the content codec stands as zstd or uncompressed; no gzip, no compression-floor raise [V]
  touches: D4
# re-scope interview 2026-08-28, R1; journal node b798396307; road not taken: gzip

D104 2026-08-28 [V]
  resp:  all six client integrations stand, Cursor included: Claude Code, Gemini CLI, VS Code, Codex, Cursor, OpenCode [V]
  ->     structural
  serves: N9
  touches: D51 D30
# R2; road not taken: retiring Cursor

D105 2026-08-28 [V] reaffirms D9
  resp:  flow-back between namespaces is a pull model: a subagent lane is merged by the main session, with provenance [V]
  touches: D9
# R3; road not taken: push or automatic flow-back

D106 2026-08-28 [V]
  resp:  the verification bar for the first release is two-axis meaningful coverage: complete line, branch, function, and statement coverage merged across the three-platform matrix with child-process collection, and a mutation kill rate of every non-equivalent mutant, both under the ruled-exclusion doctrine where every ignore or equivalence claim cites a ruling and an unruled one is a gate failure; this puts the harness program on the release's critical path and amends the release charter's standard of unit tests [V]
  ->     structural
  serves: N13
  touches: D74 D31
# R4', revised in objection 1; roads not taken: ratchet sequencing, coverage-only blocker. The release-blocking placement was put back to the visionary on 2026-09-12 and is pending

D107 2026-08-28 [V]
  resp:  mobile devices are a performance-envelope claim only; no mobile operating system enters the support matrix, and ARM is proven incidentally through the Apple-silicon lane [V]
  ->     fence-declined mobile-support
  touches: D45
# R6; roads not taken: a mobile smoke lane, a fenced mobile option

D108 2026-08-28 [V] reverses D45
  resp:  performance budgets are spec: at the `100k`-row reference corpus on a two-core class machine, `p95` query at or under `100ms` and insert at or under `10ms`; the gate is median-of-five at the beta pack step only, continuous integration reports and never gates, and a rebaseline requires a dated note; the latency harness is a new work item [V]
  touches: D45
# R7 as amended in objection 2; road not taken: a raw p95 gate

D109 2026-08-28 [V] reaffirms D30
  resp:  Claude-only live-verified capture stands for the first release; the other five clients are tool-only, and the capture need stays honestly partial [V]
  touches: D30
# R8; road not taken: unverified hook wiring shipped as capture

D110 2026-08-28 [V]
  resp:  "users" means agent lanes under one operator, not multiple humans [V]
  ->     boundary
  serves: N5
  touches: D9
# R9; road not taken: multi-human users

D111 2026-08-28 [V] reaffirms D33
  resp:  the provision for a future code-tree consumer is the published consumer contract itself: stable node ids, portable exports, open metadata, disclosed eviction; a code-tree tool would be a separate consumer [V]
  touches: D33
# R10; road not taken: reserving seams for a code tree

D112 2026-08-28 [V]
  trig:  a visualizer, GUI, or on-the-fly approximate-neighbor index is proposed [V]
  resp:  a future consumer; zero work in the first release, and an approximate-neighbor index sits inside the optional-dense provision [V]
  ->     fence-deferred visualizer
  touches: D18 D33
# R11; road not taken: a visualizer roadmap in the release line

D113 2026-08-28 [V]
  resp:  the forgotten-areas report is claimed in full at the ledger's weights: cold-start orientation, honest silence, the rich recall surface, bindings and succession, privacy, consentful wiring, the self-teaching agent surface, the pane, and attribution were absent from the seed and are needs nonetheless [V]
  ->     boundary
  serves: N1
  touches: D2
# R12

D114 2026-08-28 [V] amends D91
  resp:  the public package is `treecontext-mcp` on a fresh public repository populated by an opt-in file copy with no history; the command, the tool prefix, and the store directory keep the product name; publication runs from the public repository's continuous integration with npm provenance, never from a laptop [V]
  ->     boundary
  serves: N8
  touches: D91
# R13 reaffirmed, R15 added the provenance step

D115 2026-08-28 [V]
  resp:  the README arc is sufficient onboarding; the install-section rewrite already staged in the release plan is the remaining edit [V]
  ->     boundary
  serves: N9
  touches: D114
# R14

D116 2026-08-28 [V]
  resp:  version skew is stated policy: stores migrate forward, the oldest supported store version is named per release, a store with a newer schema is refused by name, and in mixed-version lanes the laggards refuse until upgraded [V]
  ->     structural
  serves: N6
  touches: D59 D40
# R16; the paragraph lands in the README and the architecture document

D117 2026-08-28 [V]
  resp:  a Unicode and CJK tokenization category is declined with provenance [V]
  ->     fence-declined unicode-cjk-tokenization
  touches: D4
# checklist sweep of the re-scope interview

D118 2026-08-30 [I>V]
  trig:  the client dies while the server still has output to write [I>V]
  resp:  a dead peer earns a swallowed write or a shutdown, never a storm; a client that dies before the server finishes starting leaves no orphan [I>V]
  sib:   none -- this entry is the failure case of the serve lifecycle
  serves: N2
  touches: D38
# observed live on the owner's machine 2026-08-30, an EPIPE storm

D119 2026-09-02 [I>V]
  trig:  the first hook of a fresh install fires before the store directory exists [I>V]
  resp:  the door makes the directory: fresh means below the ladder's head with an empty journal, a schema-less file left by an earlier hook is healed, and hooks racing to create one fresh store all land on the finished schema because a starter that loses the lock finishes the ladder [I>V]
  sib:   none -- this entry is the failure case of the first-hook promise
  serves: N3
  touches: D58
# release review 2026-09-02 and the race that building the fix surfaced

D120 2026-09-09 [I>V]
  trig:  the command on the PATH and the build the agent is wired to differ [I>V]
  resp:  doctor names both builds by version and location and never ranks them; a same-version copy is reported, not warned about; a pin that is gone still lands somewhere, and a shim it cannot follow is asked [I>V]
  sib:   none -- naming both is the failure handling; nothing is silently preferred
  serves: N9
  touches: D51 D104
# a Windows tester with a stale global install, 2026-09-09; shipped in rc.7

D121 2026-09-12 [V]
  resp:  a week of beta on `rc.7` with no negative feedback: wrap up the work for the initial release [V]
  ->     boundary
  serves: N13
  touches: D74 D106
# journal node dbaa238e; the fork between the two-axis bar (D106, D108) and the ratified charter (D74) was put to the visionary and is pending

D131 2026-09-12 [V]
  resp:  start the coverage plan and see how it goes; as an alternative or in addition, infer the human intent in the uncovered code and use it as the seed for a new scope interview [V]
  ->     boundary
  serves: N13
  touches: D121 D106
# the owner's answer to the fork, journal node 5de9d24a (a captured question event, not a curated note); whether the bar still gates the tag was not said

N18 2026-09-23 [I] operator 5
  need:  each row stands on its own for traceability: who wrote it, when it was written, how it was written, journal hook or manual insert, and under what situation, main project, subagent, worktree, or any other [V]
  means: provenance the store stamps itself, never caller-supplied metadata, joined to an agent registry [I]

N19 2026-09-23 [I] operator 3
  need:  every touch of an entry is recorded, searched, read, and by whom, because more data is better forensics later [V]
  means: a separate append-only access log that ranking and retention never read [I]

N20 2026-09-23 [V] agent 4
  need:  a subagent can search only its own space, its journal and its manual entries, while the whole store stays open to it [V]
  means: a scope option on the query tool, with the workflow documented in the project's own `AGENTS.md` [V]

N21 2026-09-23 [V] agent 3
  need:  when a worktree is folded back, the subagent's summary of its work exists and is findable by search [V]

N22 2026-09-23 [V] operator 3
  need:  a group of subagents doing related work, such as a cybersecurity set, can be found as a group without each being its own namespace [V]

D122 2026-09-23 [V]
  resp:  the attribution program joins the first release's critical path and is built before the tag; the wrap-up list of the twelfth stands with this program added ahead of it [V]
  ->     structural
  serves: N18
  touches: D121 D74
# journal node e4ed9ba1; roads not taken: after the tag, drafted into a staged directory the runner does not read; needs and fence only until the tag

D123 2026-09-23 [V]
  resp:  this program's rulings are recorded in a docket opened here; every new scenario carries a ruling-id tag; the pre-existing feature files keep their dated-prose record and are not backfilled [V]
  ->     structural
  serves: N18
  touches: D122
# premise refuted the same session: the lint reads every top-level feature file, and the ledger's need ids collide with the docket's; see the reversal below

D124 2026-09-23 [V]
  resp:  per-subagent MCP servers are declined as too ambitious for this program; a subagent talks only to the server its parent session talks to [V]
  ->     fence-declined per-subagent-servers
  serves: N20
  touches: D38 D96
# road not taken: an agent definition declaring its own treecontext server with its own namespace and policy
# pass 2 of the review (2026-09-28): export and import join the attribution interview's queue as the transport for true isolation (containers, VMs, a separate machine), with import identity (review item I9); no dedicated ruling exists yet, the behavior is bound under D7 and the portability promise under D33

D125 2026-09-23 [V]
  resp:  an append-only access log exists; more data is better forensics later, and a performance cost is optimized only when it appears [V]
  ->     means N19
  touches: D21 D22

D126 2026-09-23 [V]
  resp:  an agent registry exists, one record per agent lifetime, so a row needs only an agent identity and the rest is a join [V]
  ->     means N18
  touches: D125 D86

D127 2026-09-23 [V]
  resp:  a subagent restricts its search through an option on the query tool rather than through a namespace; treecontext offers the flexibility and a project's `AGENTS.md` documents the workflow [V]
  ->     means N20
  touches: D124
# road not taken: a namespace per subagent, which the Agent tool cannot produce and would mint one tree per spawn

D128 2026-09-23 [I]
  resp:  the access log and the agent registry are two tables, not one: the registry is one row per agent lifetime and joins onto rows, the log is one row per read event and will need its own retention [I]
  ->     structural
  serves: N19
  touches: D125 D126
# road not taken: one combined table

D129 2026-09-23 [I]
  resp:  namespaces stay as they are, the hard boundary between separate processes, and are not extended by this program; documented as an advanced, process-level lane [I]
  ->     structural
  serves: N20
  touches: D124 D127 D9
# roads not taken: remove namespaces; extend namespaces to carry subagent lanes. Pass 1 of the review (2026-09-28): the owner wants D9 expanded and generalized from the orchestration platform's feedback, so this entry is the first the attribution interview reopens, and its rulings land as amendments to D9

D130 2026-09-28 [I>V] reverses D123
  resp:  the docket covers the whole corpus: the pre-existing rulings are backported as a characterization pass, every scenario carries the ruling it proves, the fence is rewritten to the dated grammar, and the ledger cites its rulings; the attribution program's entries are renumbered after everything they postdate [I>V]
  touches: D123
# the backport plan of 2026-09-28, accepted by the visionary ("ok let's proceed"); ratified by chain at the closing entry once reviewed

D132 2026-09-28 [V]
  resp:  a ratified ruling, need, design constraint, fence entry, or road not taken is never a veto: when later work conflicts with one, the interviewer summarizes the original decision and the impact of changing it, and the visionary decides; a change is a new dated entry, never an edit in place, and never a refusal on the grounds that the earlier entry was ratified [V]
  ->     boundary
  serves: N13
  touches: D15 D130
# the owner's ground rule, given at the start of the interactive docket review; the summary is the interviewer's job and grows harder as the ledger and design expand

D133 2026-09-28 [I>V] amends D4
  resp:  one SQLite file holds the full journal and every table the journal needs, the rows, the lexical index, staging, leases, and any registry or log a later program adds; the content is zstd-compressed and searched by `BM25` over a bounded index view; the index is a view, the journal is the record [I>V]
  touches: D4 D128
# pass 1 of the interactive review: "tables, not files"; the attribution program's two tables live in the same file

D134 2026-09-28 [I>V] amends D7
  resp:  the library is usable without the server and without hooks: a program may use the store as a memory with no journaling at all, inserting and querying only, or may drive journaling itself through the staging surface; the recording mechanism is separate from the hooks, and the library serves either use [I>V]
  touches: D7 D16
# pass 1: the owner's two library cases, both already exercised by the library scenarios

D135 2026-09-28 [I>V] amends D17
  resp:  the full aBDD toolchain governs the corpus: gherkin-node-test is the linter and sole executor, docketry lints the ruling record, gherkin-trace watches for drift between the tiers, and the scope and audit skills conduct the interviews and judge the state; the corpus must still stand alone for a user who wants only the journal [I>V]
  touches: D17 D101 D31

D136 2026-09-28 [I>V] amends D11
  resp:  hierarchical summary trees in the journal are declined: built, benchmarked, removed, no benefit for single-author chat-session recall over a flat store; reopens when a new approach shows measured recall benefit on this workload [I>V]
  touches: D11

D137 2026-09-28 [I>V] amends D12
  resp:  the dual-tree promotion pipeline is declined: complexity without measured recall benefit; reopens when a new approach shows measured recall benefit on this workload [I>V]
  touches: D12

D138 2026-09-28 [I>V] amends D13
  resp:  complex query fusion across journal and code results is declined; they stay simple, separately presented surfaces; reopens when a new approach shows measured recall benefit on this workload [I>V]
  touches: D13

D139 2026-09-28 [I>V] amends D43
  resp:  every tool on the surface is ruled in and tool membership is spec, but the count is not fixed: it is whatever the rulings sum to, today query, status, insert, delete, clear, export, import, and merge from agent under the full policy; what is fixed is that tool schemas describe only what the backend actually does [I>V]
  touches: D43 D39
# pass 3 of the review: "the absolute number of tools is not the issue; the rule that the schemas describe what is actually there is"

D140 2026-09-28 [I>V] amends D48
  resp:  retention, stated plainly: the searchable store is bounded by a session cap, and eviction is age-ordered, oldest session first, with no wall-clock limit; the byte budget is a demotion backstop that strips the oldest non-protected rows back to their index text and never evicts; archives accumulate indefinitely on disk [I>V]
  touches: D48 D22 D23
# pass 3: the owner's reading that the session cap is effectively age-based, made explicit; the cap and the budget are library options today with no config key

D141 2026-09-28 [V]
  resp:  the store-byte budget default rises from `64 MiB` to `128 MiB`, and both the budget and the session cap become operator-settable per store through a key in the config file; subagents multiply a session's content without multiplying the session count, which is what the old sizing did not anticipate [V]
  ->     structural
  serves: N7
  touches: D140 D108 D49
# pass 3 of the review; the performance budgets of D108 were measured at a hundred-thousand-row corpus and keep their envelope at this size. Build item: the constant, the config key, the status message that today says "raise maxStoreBytes" with no knob to turn

D142 2026-09-30 [I>V] amends D80
  resp:  the store uses SQLite in WAL mode so many readers and writers share one file safely, and correctness lives in the database rather than in lockfiles or per-process discipline: dedup is a constraint, the drain claims its batches atomically, the primary claim is a heartbeat lease row, and every process that opens the store inherits the rules; the shipped lockfile model was a technical oversight [I>V]
  touches: D80 D81 D96
# pass 4 of the review: the owner's reading, "we could move to SQLite WAL to allow multiple writers and readers safely", with the one nuance that WAL serializes writers and the database constraints make the concurrency correct

D143 2026-09-30 [I>V] amends D82
  resp:  three builder decisions from the release-charter cold-read: the orientation fetch of a resume pointer never counts as reliance, so ritual cannot make a plan immortal; reliance is recorded only under the full policy, so a contributor's export never shapes eviction; and the dense exclusion covers both dense scenarios [I>V]
  touches: D82 D22 D50 D73
# pass 4: the original wording hid what each decision does

D144 2026-10-05 [I]
  resp:  a merge from a namespace is idempotent by identity: every copy carries a pointer to the source entry it came from, a repeated merge consults that pointer before the content predicate and adds nothing for an entry already carried across, and the merge counts disclose the already-merged class as its own number [I]
  ->     structural
  serves: N5
  touches: D9 D105
# the second beta tester's question, "can merges run every few seconds per worker"; verified 2026-10-05 (journal node 22bcc216): the auto-capture anchor flips between two same-session occurrences of one fingerprint further apart than the dedup window, so both re-import on every whole-lane run, two frozen copies per run. The owner's words: "fix the merge idempotence defect first, charter scenario then code". The means is proposal §3.8's back-pointer, taken ahead of the attribution program; the builder's shape, pending ratification

N23 2026-10-05 [V] hackathon-developer 5
  need:  I need treecontext, within one week, to be the memory of a junior four-person hackathon team on macOS working the full aBDD toolchain through Claude Code: installable publicly, learnable from clear instructions, and reliable through a multi-day scoping prep and a day-long sprint of /clear-driven work, with cheap re-orientation after every clear, one set of mechanisms, hook-driven and tool-driven alike, serving both handoff between teammates and orchestration of subagents, and no show-stopper bugs in capture, resume, or handoff, so that the aBDD stack gets its first small-team stress test [V]
# the root of the 2026-10-05 scoping interview (hackathon re-cut); actors ruled in Phase 1: the developer's own session, the orchestrating main session, a subagent it spawns, a teammate on another machine, a UI/UX teammate on another agent

D145 2026-10-05 [V]
  trig:  a developer continues working right after a /clear [V]
  resp:  the developer can see what the agent re-oriented from, a recent resume pointer or the recent journal entries of the session, instead of guessing [V]
  sib:   none -- the silent re-orientation it replaces is the failure, not a behaviour
  serves: N23 N1
  touches: D8 N1
# the visionary's own framing: "helpful for the user to get feedback — are they re-orienting on a very recent resume pointer, or from recent journal entries"; three of the four developers will not know the pointer workflow

D146 2026-10-05 [I>V]
  pre:   the developer never asked the agent to leave a resume pointer [V]
  trig:  the first turn after a /clear [I>V]
  resp:  the agent re-orients from the session's recent journal entries, and the developer is told once how to leave a pointer before the next clear [I>V]
  sib:   none -- the roads not taken below are alternatives, not failure cases
  serves: N23 N1
  touches: D145 D8
# roads not taken: the agent writes the checkpoint itself before work resumes; the newest entries silently are the checkpoint; re-orient from recent entries and say so, with no nudge

D147 2026-10-05 [V]
  trig:  a subagent the orchestrating session spawned finishes its work [V]
  resp:  the orchestrator can see and search a summary of the subagent's work, the subagent's counterpart of a resume pointer [V]
  sib:   none -- a subagent whose summary is absent is the gap D21's markers already name
  serves: N21 N23
  touches: N21 D127
# the visionary's (a); N21 already states the need, this rules the orchestrator-side behaviour

D148 2026-10-05 [V]
  trig:  the orchestrator wants more than the summary, to trace a bug or a specific decision [V]
  resp:  the orchestrator can read the subagent's whole trail on its own, separable from everything else in the store [V]
  sib:   none -- an unseparable trail is the absence D148 removes, not a behaviour
  serves: N20 N5 N23
  touches: D127 D129 D9
# the visionary's (b), said as "trace the subagent's namespace"; recorded in behaviour terms because D127 chose a query option over a namespace per subagent — whether the trail must be a true namespace is an open decision point, not silently resolved either way

D149 2026-10-05 [V]
  pre:   the subagent lives on a different machine, so a different store [V]
  trig:  the orchestrator needs the subagent's work [V]
  resp:  the export and import tools carry it cleanly, the summary alone or optionally the whole journal of that store [V]
  sib:   none -- the same-store import crash of 2026-10-05 is a defect, ruled separately when its scenario lands
  serves: N23 N5
  touches: D105 D7
# the visionary's (c); pull model, consistent with D105 (flow-back is a pull); the summary-only form is the handoff a teammate uses too

D150 2026-10-05 [I>V]
  trig:  a subagent starts on its task [I>V]
  resp:  before it acts it can find its own prior trail, what any earlier subagent in the same role did, and the plan it was spawned under, but not the whole project history by default [I>V]
  sib:   none -- the roads not taken below are alternatives, not failure cases
  serves: N20 N23
  touches: D127 N20 D148
# roads not taken: the whole project memory, same as the orchestrator; only what the orchestrator handed it; its own trail only, widening on request. The "same role" reading follows the 2026-09-25 assessment (journal 0c498aaf): a fresh subagent's own instance trail is empty, so "its prior trail" means the role's

D151 2026-10-05 [I>V]
  trig:  a handoff from a teammate arrives through the shared git repository [I>V]
  resp:  the receiver's memory holds whatever the sender chose to send, the summary alone or the whole journal, every entry marked as that teammate's, and the receiver sees a count of what landed [I>V]
  sib:   none -- a handoff that lands unmarked or uncounted is the gap the marking removes
  serves: N23 N5
  touches: D149 D105 D7
# roads not taken: summary only, nothing else of the sender's journal; summary and full trail always, both marked

D152 2026-10-05 [I>V] reaffirms D109
  trig:  a teammate works through an agent other than Claude Code, GPT or Gemini among them [I>V]
  resp:  they read and write the team's memory through the tool surface from any agent, and automatic capture of their sessions is not promised [I>V]
  sib:   none -- the roads not taken below are alternatives, not failure cases
  serves: N23 N3
  touches: D109 D30
# roads not taken: full capture on their agent too, which reopens D109 and adds unverified platforms to the week; nothing, the UI/UX pair outside treecontext entirely

N24 2026-10-05 [I] hackathon-developer 4
  need:  I need treecontext to carry a developer who never learned its workflow, no resume pointer, no supersedes, no namespace, through a /clear and a handoff without losing their place [I]
# sketched from D146 and the visionary's "imagine 3/4 are new users"; weight a guess until Phase 1½

D153 2026-10-05 [I>V] amends D152
  trig:  a teammate works through an agent other than Claude Code, GPT or Gemini among them [I>V]
  resp:  they read and write the team's memory through the tool surface from any agent; capture is promised only where verified live, Claude Code alone today; and the documentation carries a compatibility matrix of hook support per client, each row documented-only with the date or release of the documentation it was checked against, never a test result it does not have [V]
  sib:   none -- a matrix row claiming a verification it lacks is the lie the date column prevents
  serves: N23 N3
  touches: D152 D109 D30
# the visionary's own shape: "a table matrix of supported hooks with notes — documenting compatibility without testing it, only what is reported, with the dates/releases of the documentation". Evidence, survey of official docs 2026-10-05 (journal, subagent report): Codex CLI and VS Code use Claude Code's hook contract verbatim incl. SubagentStart/Stop; VS Code and Cursor read .claude/settings.json (VS Code behind chat.useClaudeHooks, off by default; Cursor by default); Gemini CLI same JSON shapes, renamed events (BeforeTool/AfterTool/PreCompress), no subagent events; OpenCode JS plugins only, no shell hooks. Roads not taken: claim capture on Codex and VS Code outright (breaks the verification rule); keep D152 with no matrix

D154 2026-10-05 [I>V]
  trig:  a developer runs the installer or doctor on a machine with a client other than Claude Code present [I>V]
  resp:  for a client that reads the Claude settings file itself, VS Code with its Claude-hooks setting on and Cursor by default, nothing is written; for a client that keeps its own hook configuration, Codex CLI and Gemini CLI, the hooks are copied into it, and doctor reports per detected client whether the hooks are present and consistent with the Claude Code block [I>V]
  sib:   none -- a doctor that stays silent on a missing copy is the absence this removes
  serves: N23 N9
  touches: D153 D115 D98
# the visionary's words: "for those agents that literally use the claude code settings/json we don't have to do anything, right? Then for those that copy them into their own configuration, ideally treecontext doctor can review to make sure consistent/presence". Caveats from the survey carried into the matrix: VS Code's chat.useClaudeHooks is off by default and VS Code ignores matcher values; Gemini's events are renamed, so its copy is a translated block, not a verbatim one. Roads not taken: the installer writes hooks for every documented client labeled documented-only; Claude Code only with hand-copy instructions

D155 2026-10-05 [V] ratifies N24
  resp:  the needs sketch of the hackathon re-cut stands as the baseline at the intent checkpoint: N23 and N24 at the weights the sketch records, and the existing N1, N5, N20, N21, N3 and N9 as the needs this scope serves [V]
  ->     boundary
  serves: N23 N24
  touches: N24 N23
# the visionary's "yes, the why is captured", 2026-10-05

D156 2026-10-05 [I>V]
  trig:  the agent is about to stop its turn [I>V]
  resp:  when the session's newest checkpoint is older than a configured interval, counted in rounds and or minutes, the agent is made to write a checkpoint before it stops; the interval is set from inside the Claude Code session through a treecontext command, and the developer's own deliberate checkpoint remains available and supersedes the automatic one [I+V]
  sib:   none -- the roads not taken below are alternatives, not failure cases
  serves: N24 N1 N23
  touches: D146 D145 D14 D8
# the visionary's correction to the hook-as-floor option: "is this configurable? a settings command within claude code to set interval (i recommend rounds and/or time based parameters), plus the usual manual checkpoint". Evidence for the mechanism (rule 6): the prompt hook never sees /clear — 476 captured user turns in the live store, zero are the /clear command, while the transcript recorded one; the Stop hook's block decision is the one documented way to make the agent act before stopping. Roads not taken: manual checkpoint only, taught by the nudge; neither, raw tail only after /clear; automatic checkpoint with a fixed, unconfigurable interval

D157 2026-10-05 [I>V]
  resp:  for a developer who never set a checkpoint interval, the automatic checkpoint interval defaults to {20 rounds} or {45 minutes}, whichever comes first, and the developer's manual checkpoint remains available at any time [I>V]
  spread: the default interval trips when the newest checkpoint is <age> old
  ->     structural
  serves: N24 N23
  touches: D156
# the visionary: "#1, with a manual checkpoint option", on the interviewer's arithmetic: the check is one lookup, the write about one short agent turn, roughly {1000 to 2000} tokens; a {24-hour} sprint of some {300} rounds trips about {15} times. Roads not taken: {10 rounds} or {30 minutes}; rounds only, {20}; off by default

D158 2026-10-05 [V]
  resp:  there are two kinds of checkpoint and they are distinguishable wherever they appear: the automatic one is a bookmark, where the work stood at that moment, written often and cheaply, low in signal like the journal itself; the manual one is a chapter summary, written deliberately, spanning as much of the session as the developer chose, high in signal like a deliberate commit; re-orientation and search can tell them apart [V]
  ->     structural
  serves: N1 N24 N23
  touches: D156 D157 D145 D8
# the visionary's own analogy: "auto-checkpoint as a bookmark or inode, and the manual resume/checkpoint as a chapter summary. just like we see journal as low signal to noise, and manual commit as high signal to noise"; the automatic one might miss what a manual pointer spanning a full context window carries

D159 2026-10-05 [I>V] amends D145
  trig:  a developer continues working right after a /clear [V]
  resp:  the agent's first reply shows what it re-oriented from, in this order and with every count disclosed: the session's newest chapter summary with its age, the newest bookmark with its age and the count of entries between chapter and bookmark, then the entries since the bookmark within a fixed budget of the newest {5} user turns with the count omitted stated, and the one-line reminder of how to leave a chapter summary; the agent decides what to search beyond that [I>V]
  sib:   none -- the silent re-orientation it replaces is the failure, not a behaviour
  serves: N23 N1 N24
  touches: D145 D158 D156 D146 D8
# the rendered shape the visionary chose, 2026-10-05, over: the newest checkpoint of either kind then the tail; the chapter plus the tail since the chapter with bookmarks only as search anchors. The visionary's ground: no heuristic can prove a pointer current unless it is the last entry, so the design discloses rather than decides, "the agent will have ground truth — the agent can always search around more"

D160 2026-10-05 [V] ratifies D159
  resp:  the three re-orientation paths stand as spoken: the chapter, bookmark and tail shape; the no-checkpoint path with its one nudge; and the bookmark-only path that says no chapter summary exists [V]
  ->     boundary
  serves: N1 N24 N23
  touches: D159 D146 D158
# the visionary's "yes, all three as spoken", 2026-10-05

D161 2026-10-06 [I>V] amends D154
  trig:  a developer runs the installer or doctor on a machine where a documented client other than Claude Code is present [I>V]
  resp:  for every documented client doctor states which mode it has, reads the Claude settings file as-is or copies the hooks into its own configuration; its current installation state and whether that state is correct; and the remediation, the installation steps that make it correct; the installer writes nothing for an as-is client and copies the hooks into a copying client's configuration [V]
  spread: doctor reports <client> as a client that <mode>
  sib:   none -- a doctor row that names a mode without its state, or a state without its remedy, is the half-answer this removes
  serves: N23 N9
  touches: D154 D153 D115 D98
# the visionary's generalisation of the walked Codex and VS Code paths: "for any documented client doctor should be able to distinguish if it uses claude code hook settings as is, or if it copies, and the current installation state (and if correct), and remediation ie installation steps"

D162 2026-10-06 [I>V]
  trig:  the agent re-orients after a /clear [I>V]
  resp:  what is injected automatically stays within a small budget of about {3000 characters}: the chapter, the bookmark, and the newest {5} user turns each cut to its first line with its full length stated; anything larger the agent fetches deliberately by id, with no cap on what it may fetch; at the extremes the shape holds, no turns since the bookmark is said in one line, one turn is shown, {10000} turns show the newest five and the omitted count, and a pasted {40000-character} turn shows as its first line and its length [I>V]
  spread: the tail keeps its shape with <turns> turns since the bookmark
  sib:   none -- the full echo it replaces is the cost, not a behaviour
  serves: N1 N24 N23
  touches: D159 D8 D14
# the visionary weighed a {500000-character} cap ("the agent was working on it") against the token bill, roughly {125000} tokens per clear at that extreme, and chose the small automatic budget with unlimited deliberate fetch; the journal already holds every turn in full, so nothing is lost by not echoing it. Roads not taken: the large automatic cap; a configurable budget with a small default and a large ceiling

D163 2026-10-06 [I>V]
  trig:  a developer sets the checkpoint interval to an extreme, or a tripped checkpoint cannot be written [I>V]
  resp:  no value is refused and the setting is echoed back as it will behave: zero rounds and off both mean off, one round means a checkpoint at every stop, a thousand rounds and a week is honored and is effectively off; when the checkpoint cannot be written, the store read-only in that session for instance, the failure is reported once and the agent stops, and the developer's work is never blocked by it [I>V]
  spread: an interval of <value> is echoed back as <behaviour>
  sib:   none -- the blocked developer and the silent failure are the two roads not taken, named below
  serves: N24 N23
  touches: D156 D157 D162
# roads not taken: zero refused as invalid and one allowed with a cost warning, with a failed write retried at the next stop; any value accepted silently with a silent failure

D164 2026-10-07 [V]
  trig:  a developer imports an export file, from another machine or from this same store [V]
  resp:  everything new lands; anything truly already present anywhere in the store, by identity first and by content only where the file carries no identity, is left alone because it is already there; the import never fails on a duplicate; and the counts of what landed and what was already present are reported for the developer who wants to know, though they hardly matter [V]
  sib:   none -- the crash of 2026-10-05 on a same-store import is the defect this rule removes
  serves: N23 N5 N24
  touches: D149 D151 D144 D7
# the visionary: "import anything new, anything that's a duplicate (and truly a duplicate — maybe dedupe algorithm update?) to not bother since it's already there. summary statistics hardly matter but should report duplicates for users that want to know". The algorithm update it implies: the identity check is store-wide, not per lane (the per-lane check is the crash); content matching is the second check only, since the merge defect of 2026-10-05 showed content alone cannot tell a repeat from a second observation. Roads not taken: refusing a same-store import with a message naming the merge tool; landing same-store copies with new ids and back-pointers; summaries-only

D165 2026-10-07 [I>V]
  pre:   a handoff file crosses a trust boundary, the shared repository anyone with push access can edit [I>V]
  trig:  a developer imports it [I>V]
  resp:  every entry lands marked as imported from that file by the importer, never as the sender's own writing; the file's own claims about authorship are kept as data, not trusted as identity; nothing is refused [I>V]
  sib:   none -- the roads not taken below are alternatives, not failure cases
  serves: N23 N5
  touches: D151 D164 D110
# roads not taken: the same plus a warning when the file's claims disagree with its contents; trusting the file as the sender's because the team is four people

D166 2026-10-07 [I>V]
  trig:  an automatic bookmark is written [I>V]
  resp:  it supersedes the session's previous bookmark, so at most one bookmark per session is live in the status panel while every superseded one stays searchable; chapter summaries keep today's rule and stay live until deliberately superseded [I>V]
  sib:   none -- the panel filling with bookmarks is the growth this prevents, not a behaviour
  serves: N1 N24 N23
  touches: D158 D156 D22 D82
# the host behaviour that must survive: status lists live pointers newest first capped at {20}; the live store holds {27} after two months, and a sprint adds about {15} bookmarks per developer. Roads not taken: all bookmarks stay live with status filtering to the newest per kind; bookmarks absent from status entirely

D167 2026-10-07 [V]
  trig:  a session starts in any way other than a /clear, a restart of a stopped process or a brand-new process [V]
  resp:  default re-orientation anchors on "self": a restarted session recovers the same self its predecessor had from durable identity rather than from the process, the worktree it runs in for a worktree session, the main checkout for the main session, the role for a subagent, so a worktree stopped and restarted resumes its own thread though its process id changed; a brand-new subagent process orients on the instruction or entry injected at its start together with its role's prior trail; a new worktree is treated as a new subagent process [V]
  sib:   none -- a restart that orients on a stranger's thread is the confusion this removes, not a behaviour
  serves: N23 N24 N20 N5 N6
  touches: D150 D159 D127 D129 D148 D122
# the visionary's own framing, 2026-10-07: "a session restart has a namespace/agent-id or some metadata of self and that's what it should orient on… a brand new subagent process will have an injected instruction or treecontext node to orient on. a new worktree should be the same as a new subagent process… how does the re-orientation identify what self was when the process id has changed — i believe we found a suitable set up for that in prior interviews". The prior setup: the attribution proposal §3.0 identity levels instance, role, group, session, and the registry row recording worktree, branch and cwd at session start (assessment 2026-09-25 item 9). This closes D148's open point: the subagent's separable trail is attribution metadata, not a namespace, consistent with D127 and D129. /clear itself keeps the session, so D159 needs no self lookup. Roads not taken: the project's newest chapter regardless of who wrote it; the newest from a session that ran in the same directory with no notion of self beyond the directory; nothing automatic on a fresh start

D168 2026-10-07 [V]
  pre:   several agents belong to one group, three different models doing security reviews for instance [V]
  trig:  one of them orients [V]
  resp:  it orients on self and also on its group, because group-wide instructions or notes may exist [V]
  sib:   none -- a group member blind to its group's notes is the gap N22 names, not a behaviour
  serves: N22 N23
  touches: D167 N22 D150
# the visionary: "their orientation should be self and likely also group because there may be group-wide instructions or notes"; the proposal's §3.6 keeps groups as configuration over roles, not namespaces

D169 2026-10-07 [I>V]
  resp:  the store is a flat, decentralised set of lanes like git, not a top-down hierarchy: the main lane and every derivative, a subagent, a subagent in a branch or worktree, a developer on another machine, each stays in its own lane; the write model is append, never overwrite; any writer may append into any lane, the main lane included, so long as the row names its writer and the entry it refers to; nothing outside the writer's own lane is modified; a cross-lane supersession is a pointer on the new entry that the owning lane sees at its next re-orientation, never a flag flip on the target; only a lane's own writer retires that lane's pointers [I>V]
  ->     structural
  serves: N5 N23 N21 N20
  touches: D9 D105 D82 D22 D166 D159 D147 D148
# the visionary's principle, 2026-10-07: "all derivatives should stay in their own lane and the main project repo should stay in their own lane as well. rather than modify an existing node outside their lane, a pointer to a newer node with additional information is always possible (because that's how they communicate). i generally favor an append strategy rather than overwrite… it's okay if a subagent commits a node into the main project namespace — as long as the writer and traceability to the original reference remains… a flat decentralized hierarchy like git". The interviewer's pushback, accepted: today's supersession flips flags on the target, which across lanes modifies another's node; writer traceability must be stamped by the store, not claimed by the writer. Implied limits on a subagent: it cannot retire the orchestrator's pointers, and its checkpoints are always marked as its own. Roads not taken: cross-lane supersession that retires the target for everyone; a top-down model where the main lane owns its derivatives

D170 2026-10-07 [I>V]
  trig:  a developer exports or imports a journal of any size for a handoff [I>V]
  resp:  content bound to or from a file never passes through the agent's conversation and carries no cap, so a whole journal of {12000} entries lands in one file and a file of any size imports; an export returned inline into the conversation keeps today's cap of {10000} entries with the omitted count stated and the way to reach the rest [I>V]
  spread: <entries> entries exported inline write <written> and state <omitted> omitted
  sib:   none -- the roads not taken below are alternatives, not failure cases
  serves: N23 N5 N1
  touches: D149 D151 D164 D14
# the visionary asked "a soft cap, or just don't even worry about it"; the interviewer's reading, accepted: the cap protects the agent's context, not the file, and today the only route to a handoff file transits the context, which is the token bill the sprint cannot afford. Roads not taken: a soft cap everywhere with a warning; no cap anywhere

N25 2026-10-07 [I>V] hackathon-developer 4
  need:  I need treecontext to be usable by a junior who never reads the README: the agent's own instructions carry them, they can see that capture is working, a /clear costs them one reply rather than a ritual, and a handoff file tells its receiver how to import it [I>V]
# the checklist sweep's usability row, 2026-10-07: all four probes selected by the visionary

D171 2026-10-07 [I>V]
  trig:  a developer's session begins journaling [I>V]
  resp:  the developer sees one early, visible sign that the session is being journaled and into which store, and a visible sign when it is not [I>V]
  sib:   none -- capture that fails without a sign is the silence N2 already forbids
  serves: N25 N2 N23
  touches: D8 D21 D145

D172 2026-10-07 [I>V]
  trig:  a teammate opens a handoff file committed to the shared repository [I>V]
  resp:  the file says, in itself, who exported it, when, from which project, what it holds, and the one step that imports it [I>V]
  sib:   none -- a file that needs the README to be used is the grind N25 names
  serves: N25 N23 N5
  touches: D149 D151 D165 D170

D173 2026-10-07 [I>V]
  trig:  a chapter summary is written [I>V]
  resp:  the agent's reply suggests that this is a good moment to /clear; treecontext never clears on the developer's behalf, because no hook or tool can issue a /clear [I>V]
  sib:   none -- the auto-clear the visionary floated is out of reach by construction, fenced as such
  serves: N25 N1 N23
  touches: D158 D156 D146
# the visionary: "a checkpoint feature also auto-clears or suggests it?"; evidence for the limit: the prompt hook never sees /clear (live store, 476 user turns, zero are the command), and no documented hook output issues a slash command

D174 2026-10-07 [I>V]
  resp:  the agent-facing handshake instructions carry the whole checkpoint and re-orientation protocol, the two kinds of checkpoint, the word that writes a chapter summary, what the first reply after /clear shows, and the handoff steps, so a developer who never reads the README is carried by what the agent already knows [I>V]
  ->     structural
  serves: N25 N24 N14
  touches: D8 D14 D159 D158 D149
# the instructions text is a charter surface (journal-agent-surface.feature); this ruling adds to what it must teach

D175 2026-10-07 [I>V]
  trig:  the memory is unavailable at the moment of need, the server will not start, the store is locked, a hook fails [I>V]
  resp:  the developer's work never stops, nothing treecontext does blocks a turn; capture degrades with a visible gap marker; the first reply after /clear says what it could not read and re-orients from what it can reach; and doctor names the piece that is down and the one fix in a single command [I>V]
  sib:   none -- work pausing until the memory is back is the road not taken, not a failure case
  serves: N25 N2 N23 N9
  touches: D21 D163 D161 D159
# the checklist sweep's availability row, 2026-10-07. Road not taken: the agent refuses to proceed without memory and says why

D176 2026-10-07 [I>V] reaffirms D108
  resp:  the performance figures for the new moments are aspirational ranges to eyeball, not hard requirements: the stop-hook check imperceptible, the first reply after /clear adding under about a second, a whole-journal export allowed seconds while saying it is working; they exist so a change that moves performance massively is seen, and nothing gates on them [I>V]
  ->     boundary
  serves: N23
  touches: D108 D156 D159 D170
# the visionary: "these are aspirational rough metrics but not hard performance requirements… in case changes result in a massive change in performance — this way i can eyeball and see we are in range"

D177 2026-10-07 [I>V]
  trig:  a developer exports for a handoff [I>V]
  resp:  the default export carries summaries only, the chapter summaries and subagent summaries; exporting the whole journal is a deliberate choice, and the export warns that captured tool output can hold secrets, tokens and keys, before it writes [I>V]
  sib:   none -- the roads not taken below are alternatives, not failure cases
  serves: N23 N5 N25
  touches: D149 D151 D170 D172
# the checklist sweep's security row, 2026-10-07; the only probe selected. Roads not taken: no new security behaviour beyond D165; a store-file privacy rule beyond today's owner-only permissions; a subagent barred from whole-journal export

N26 2026-10-07 [I>V] hackathon-developer 4
  need:  I need treecontext to run the whole day-long sprint with zero maintenance, no backups to run, no store to prune, no server to restart by hand, and a single doctor run as the only operation I ever need [I>V]
# the checklist sweep's ops-burden row, 2026-10-07; roads not taken: a no-upgrade-mid-sprint rule, a retention-never-asks rule as its own need (retention already never asks, D140)

D178 2026-10-07 [I>V]
  resp:  during a sprint nothing treecontext does requires a human hand: backups, retention and the server's lifecycle run themselves or wait, and anything that needs the developer's hand within the sprint's day is a defect for this team; doctor is the one operation they run [I>V]
  ->     structural
  serves: N26 N23
  touches: D140 D141 D175 D161 D22

D179 2026-10-07 [I>V]
  resp:  diagnosability during the sprint rests on the four surfaces that exist, the rotated debug logs and their dump through doctor, doctor itself, the gap markers, and the disclosed re-orientation; nothing further is built, and the agent's instructions name doctor as the first move when something looks wrong [I>V]
  ->     structural
  serves: N26 N25 N2
  touches: D175 D161 D174 D21
# the visionary: "there are historical debugging logs and the doctor, do you think more than that is needed?"; verified: logs at `~/.treecontext/logs`, rotated, `treecontext doctor --dump-logs`. Roads not taken: per-turn capture inquiry; a re-orientation log; a per-file import listing. Form correction 2026-10-08: the resolution was drafted as boundary, but the entry rules a behaviour the instructions scenario proves, so it is structural

D180 2026-10-07 [I>V] reaffirms D59
  resp:  the alpha keeps one promise and names its freedoms: a store written on the release day opens after any later release, migrated or refused loudly and never silently lost; a handoff file says which version wrote it and a newer import reads older files, forward reading promised and backward not; the checkpoint kinds and the re-orientation shape may change freely before the next minor release, since agents re-learn them from the instructions text [I>V]
  ->     structural
  serves: N6 N23 N5
  touches: D59 N6 D172 D158 D159 D174
# the checklist sweep's evolvability row, 2026-10-07; three of four probes selected. Road not taken: no promises at all, alpha means alpha, the store format included

D181 2026-10-07 [I>V] reaffirms D59
  resp:  the lifecycle needs nothing beyond what install, upgrade and uninstall already do: an upgrade is a reinstall that keeps the store, bindings and settings with nothing re-configured by hand, and the standard installation rules apply, additive schema and store upgrades run automatically [I>V]
  ->     boundary
  serves: N9 N6 N26
  touches: D59 D115 D180
# the checklist sweep's lifecycle row, 2026-10-07; the visionary: "follow standard installation rules, which auto-upgrade schema and stores". Roads not taken as separate rulings: the one-command arrival (already the install feature's promise) and a retirement export (uninstall already never deletes the store)

D182 2026-10-07 [V]
  resp:  no regulation, standard, hackathon rule or house rule binds treecontext in this scope, so the compliance category is declined [V]
  ->     fence-declined compliance-category
  touches: none
# the checklist sweep's compliance row, 2026-10-07: "nothing applies". Reliability was left unselected at triage as already covered by N2 and the retention rule, and is confirmed rather than declined

D183 2026-10-07 [I>V]
  trig:  a search matches both a chapter summary and a bookmark [I>V]
  resp:  the chapter summary outranks the bookmark, the way curated notes already outrank assistant prose, because a bookmark is low signal by construction [I>V]
  sib:   none -- a bookmark crowding out a chapter is the ranking this prevents, not a behaviour
  serves: N4 N1 N23
  touches: D158 D6 D18
# the sweep's domain question, 2026-10-07, interviewer's prior accepted

D184 2026-10-07 [I>V]
  trig:  entries written on different machines meet, in a handoff or in re-orientation [I>V]
  resp:  every timestamp is recorded in universal time, so geography never shifts an age; a handoff's ages are shown from the sender's own timestamps, and where a sender's clock is visibly skewed the re-orientation says so rather than correcting it [I+V]
  sib:   none -- a silently corrected timestamp is the lie this prevents, not a behaviour
  serves: N5 N23 N1
  touches: D151 D159 D165
# the visionary's correction: "obviously convert to universal time to account for geography"

D185 2026-10-07 [I>V]
  trig:  a developer wants to take back a mistaken chapter summary [I>V]
  resp:  it is retracted by superseding it with a newer entry, never deleted; the retraction is itself an entry, and the next re-orientation shows it [I>V]
  sib:   none -- deletion is the road the lane principle already closed
  serves: N24 N1 N23
  touches: D169 D166 D158 D22

D186 2026-10-07 [I>V]
  trig:  an entry refers to an earlier entry, a subagent's note on the orchestrator's chapter for instance [I>V]
  resp:  it follows git conventions: the new entry names the earlier one by id and says in its own words what it is responding to, nothing is copied and nothing is modified; the store keeps the reverse index, and every read surface, search, export and re-orientation, shows an entry's "referenced by" one hop deep as id, writer, age and first line, with the count when there are more; walking the chain further is the agent's deliberate fetch by id, never the default, so the context window is not inflated by a trail the agent did not ask for [I>V]
  sib:   none -- the roads not taken below are alternatives, not failure cases
  serves: N5 N23 N1 N24
  touches: D169 D159 D162 D22
# the visionary: "following git conventions makes sense — it's a proven workflow and agents intuitively understand it"; on returning the whole walk: "concerns about inflating the context windows, versus not providing enough context" — resolved by the one-hop default with counts and deliberate expansion. Roads not taken: copy-forward, the referencing note carrying a copy of what it refers to; the whole chain returned in order on every hit

D187 2026-10-07 [I>V] amends D159
  trig:  a developer continues working right after a /clear [V]
  resp:  the agent's first reply shows what it re-oriented from, in this order and with every count disclosed: the session's newest chapter summary with its age and, one hop deep, the newer entries from other lanes that reference it with writer and age; the newest bookmark with its age, the count of entries between chapter and bookmark, and its own referrers the same way; then the entries since the bookmark within the budget of the newest {5} user turns with the omitted count stated; and the one-line reminder of how to leave a chapter summary; the agent decides what to search or fetch beyond that [I>V]
  spread: the tail keeps its shape with <turns> turns since the bookmark
  sib:   none -- the silent re-orientation it replaces is the failure, not a behaviour
  serves: N23 N1 N24 N5
  touches: D159 D186 D169 D162 D158
# objection 1 of the adversarial pass, 2026-10-07: D169 promised the owning lane sees a cross-lane pointer at re-orientation and D159's shape had no line for it; resolved by the reference model (D186), which adds the referenced-by line without modifying any entry

D188 2026-10-07 [I>V]
  resp:  the re-orientation scenarios bind on what treecontext produces, the packet the session-start hook emits on a /clear, asserted line by line and in order from the hook's own output, and the handshake instructions, asserted to tell the agent to open its first reply after a /clear with that packet shown as is; whether the model then obeys is out of reach by construction and is named so on the fence, with the dogfood sessions as the running evidence [I>V]
  ->     structural
  serves: N13 N23 N1
  touches: D187 D174 D8 D14 D15
# objection 2 of the adversarial pass, 2026-10-07: "the agent's first reply shows" is the model's act, not treecontext's; no test in this repository runs the model, and a transcript replay goes stale with every release. Roads not taken: binding on a recorded live transcript; keeping the Then on the reply and carrying the gap knowingly

D189 2026-10-07 [V] ratifies D187
  resp:  the re-orientation shape with the referenced-by lines stands, read through D188: the packet holds it and the instructions say to show it first [V]
  ->     boundary
  serves: N1 N23
  touches: D187 D188 D186
# the visionary's yes to option 1 of objection 2 after the explanation, 2026-10-07, covering the git-convention shape chosen under objection 1

D190 2026-10-07 [I>V]
  trig:  a session starts, in a worktree or the main checkout [I>V]
  resp:  the session-start hook registers the session's self, its worktree, branch and directory, under the session id it already carries; the server resolves self for every row written through the tools by looking up the session it already knows, so a chapter summary written from a worktree is stamped with that worktree without the server guessing from its process [I>V]
  sib:   none -- a self guessed from the server's process is the premise objection 3 refuted, not a behaviour
  serves: N23 N5 N6 N20
  touches: D167 D90 D95 D122
# objection 3 of the adversarial pass, 2026-10-07, premise verified in the survey of 2026-10-05: hook payloads carry cwd as the worktree path, the project directory variable names the main checkout, and the server's working directory is undocumented. Roads not taken: self declared by the agent on each call from an injected token; both with mismatch disclosure

D191 2026-10-07 [I>V] amends D122
  resp:  the attribution program's core ships before the public code release of `2026-10-12` as the self, lane and writer-stamp slice ruled here, D167, D169 and D190; the registry table, the access log, groups configuration, forgery refusal, log retention, the schema document and the delete and clear tiers follow after that release on the orchestration platform developer's timeline, and the proposal's remaining sections seed that interview; the wrap-up list of the twelfth stands with the slice added ahead of it [I>V]
  ->     structural
  serves: N18 N23 N5
  touches: D122 D121 D74 D167 D169 D190
# objection 4 of the adversarial pass, 2026-10-07: D122 ([V], 2026-09-23) put the whole program before the tag; the visionary: "amend D122 but then we do a public code release". Roads not taken: keeping D122 whole and moving the date; retiring the program with the slice as all that was needed

D192 2026-10-07 [I>V]
  resp:  the public code release of `2026-10-12` is `0.1.0-beta.1`, published under the npm `beta` dist-tag so a plain install receives nothing until `0.1.0` lands and the team installs with the tag named; `0.1.0` final follows after the competition on the ratified gate [I>V]
  ->     structural
  serves: N23 N13
  touches: D191 D74 D106 D131
# the visionary: "i'm open to what you want to call that version — rc? beta? alpha?"; recommended and accepted. Roads not taken: `0.1.0-rc.8` under `next`; `0.1.0-alpha.1` matching docketry and gherkin-trace; `0.1.0` final on 10/12

D193 2026-10-07 [V] ratifies D191
  resp:  the amendment of D122 stands in the visionary's own decision: the slice before the public release, the remainder after it [V]
  ->     boundary
  serves: N18 N23
  touches: D191 D122
# "amend D122 but then we do a public code release", 2026-10-07

D194 2026-10-07 [I>V] amends D106
  resp:  the verification bar for the first release returns to the ratified gate, the suite green, mutation on touched seams, adversarial review, the full matrix, the beta cycle and accurate docs, plus honest measurement: the merged three-lane coverage harness with child-process collection ships report-only, the two-axis bar of complete coverage and every non-equivalent mutant killed under the ruled-exclusion doctrine moves to the `0.1.x` line, and the latency harness of D108 likewise reports and never gates [I>V]
  ->     structural
  serves: N13 N23
  touches: D106 D108 D131 D74 D31
# objection 5 of the adversarial pass, 2026-10-07: D106 ([V], 2026-08-28) blocked `0.1.0` on the two-axis bar; the visionary this week: remove the 100% bar, "meaningful code coverage and not artificial". Measured 2026-10-05: the harness runs, 223 child processes merged, lines 84.8% on the Linux lane. Roads not taken: a no-regression ratchet at the 10/05 figures; keeping D106 with the beta explicitly outside the gate

D195 2026-10-07 [V] ratifies D194
  resp:  the amendment of D106 stands in the visionary's own decision: the harness reports, the bar moves to `0.1.x` [V]
  ->     boundary
  serves: N13
  touches: D194 D106

D196 2026-10-07 [V] ratifies D129
  resp:  namespaces stay the process-level boundary and are extended by nothing; the lanes of D167 and D169 are attribution metadata inside a namespace, and a subagent's separable trail is read by writer, not by namespace [V]
  ->     structural
  serves: N5 N20
  touches: D129 D127 D167 D169 D148
# objection 6 of the adversarial pass, 2026-10-07, a readback: the visionary reaffirmed D129 in these terms, which also ratifies its formerly inferred resp. Road not taken: amending D129 to make namespaces the home of lanes

D197 2026-10-07 [I>V]
  resp:  the public release is split in two under one tag: `0.1.0-beta.1` on `2026-10-12` must carry the /clear path, the stop-hook bookmark with its setting and default, the two checkpoint kinds and their ranking, the re-orientation packet, the nudge and the suggestion to clear, the import rule fix, the instructions rewrite, the README with its team section, and the compatibility matrix; `0.1.0-beta.2` by `2026-10-16`, before the competition, carries references and the reverse index, self registration and writer stamps, file-bound export and import with the summary-only default and the self-describing file, and doctor's rows per client; a ruling in the second set stays in effect and unbuilt in between, disclosed as such [I>V]
  ->     boundary
  serves: N23 N13
  touches: D192 D191 D194 D156 D157 D158 D183 D187 D146 D173 D164 D174 D153 D186 D190 D169 D170 D172 D177 D161
# objection 7 of the adversarial pass, 2026-10-07: roughly a dozen builds ruled for one week; the visionary accepted the recommended split so the team can install and practice on 10/12 with the checkpoint and re-orientation behaviours. Roads not taken: the visionary marking each item; no split, with the date moving

D198 2026-10-07 [V] amends D146
  pre:   the developer never asked the agent to leave a chapter summary [V]
  trig:  the first /clear of a calendar day, on the machine's local day, finds no chapter summary for the session [V]
  resp:  the agent re-orients from the session's recent journal entries and the developer is told, that once per calendar day, how to leave a chapter summary before the next clear; later clears that day repeat no nudge [V]
  sib:   none -- the roads not taken below are alternatives, not failure cases
  serves: N24 N1 N23
  touches: D146 D173 D184
# the visionary's own cadence: "on the first run per calendar day"; the calendar day is the developer's local day, a human notion, while every stored timestamp stays universal (D184). Roads not taken: once per session with restarts repeating; once per store ever; once per session until a chapter summary exists anywhere

D199 2026-10-07 [I>V]
  resp:  a file-bound handoff has two doors over one file format: the export and import tools take a path argument so the agent, on a developer's request, has the server read or write the file itself with only the file name and the counts entering the conversation; and terminal commands export and import the same files for scripts and shells; the tool door is built first [I>V]
  ->     means N23
  serves: N5 N25 N10
  touches: D170 D172 D177 D7 D197
# the visionary: "what do you think? almost seems like a design/architecture question" — the interviewer's recommendation accepted: for a junior the door that matters is the agent; the commands come almost free from the library. Roads not taken: tool door only this release; commands only

D200 2026-10-07 [I>V]
  resp:  the design document's canonical home is `features/DESIGN.md`, beside the fence, the ledger and the docket, where the docket lint reads it; the root `DESIGN.md` becomes a one-paragraph pointer to it [I>V]
  ->     structural
  serves: N13
  touches: D130 D135 D31
# the rule-6 collision the backport left open, put at drafting 2026-10-07: a root DESIGN.md with ruled tags existed while docketry reads only the corpus directory, so the design layer reported dark. Roads not taken: keep the root as the seed with a pointer beside the features; a full copy at both paths

D201 2026-10-07 [V]
  resp:  the build pattern for this scope: the interviewer, Fable, produces the feature files and the other scoping surfaces; at build, Opus subagents build the bound chunks; Opus performs the first review and Fable the final review; both reviews are ordered around the aBDD philosophy, walking the CINO layers, code, binding, assertion, spec and decision, plus the blind family [V]
  ->     boundary
  serves: N13 N23
  touches: D74 D101 D197 D194
# the visionary's words during drafting, 2026-10-07: "fable should produce the feature files, but when we get to the actual build, use opus subagents, opus first review, and a final fable review. reviews should be ordered around aBDD philosophy — CINO layers"; extends the Opus-build/Fable-gate pattern of 2026-08-20

D202 2026-10-07 [V] amends D201
  resp:  the build pattern for this scope: Fable produces the feature files and the other scoping surfaces; before any build starts, a cold Fable instance with none of the interview's context reviews the feature files by the CINO layers and the blind family; at build, Opus subagents build the bound chunks; Opus performs the first review and Fable the final review, both ordered around the aBDD philosophy, walking code, binding, assertion, spec and decision, plus the blind family [V]
  ->     boundary
  serves: N13 N23
  touches: D201 D74 D101 D197
# the visionary, 2026-10-07: "before the build kicks off, do a cold fable cino review of the feature files too"

D203 2026-10-07 [I>V]
  trig:  the orchestration platform developer's interview resumes after `0.1.0-beta.1` [I>V]
  resp:  the remainder of the attribution program, the registry table, the access log, groups configuration, forgery refusal, log retention, the schema document and the delete and clear tiers, waits for that interview, seeded by the proposal's remaining sections [I>V]
  ->     fence-deferred attribution-remainder
  serves: N18
  touches: D191 D122
# the fence-kind twin of D191, so the Deferred section cites a ruling of its kind; nothing new is decided

D204 2026-10-07 [I>V]
  trig:  the `0.1.x` line opens the exclusion rulings for coverage [I>V]
  resp:  the bar of complete two-axis coverage with every non-equivalent mutant killed, and the latency gate, wait for that line; until then the harnesses report and never gate [I>V]
  ->     fence-deferred two-axis-bar
  serves: N13
  touches: D194 D106 D108
# the fence-kind twin of D194

D205 2026-10-07 [I>V]
  trig:  the `0.1.0-beta.2` build begins, by `2026-10-16` [I>V]
  resp:  references and the reverse index, self registration and writer stamps, file-bound export and import with the summary-only default and the self-describing file, and doctor's rows per client wait for that build, in effect and unbuilt between the betas and disclosed as such [I>V]
  ->     fence-deferred beta-two-set
  serves: N23
  touches: D197 D186 D190 D199 D161
# the fence-kind twin of D197

D206 2026-10-07 [I>V]
  trig:  a developer's packet after a /clear is assembled while entries imported from a teammate's handoff exist in the store [I>V]
  resp:  imported entries keep the sender's lane and never join the receiver's self; the packet carries one line per handoff naming the sender, the count of entries and the newest chapter summary with its universal time, and everything else about the handoff is search and deliberate fetch by id [I>V]
  sib:   none -- the roads not taken below are alternatives, not failure cases
  serves: N24 N5 N23 N1
  touches: D167 D187 D151 D165 D184
# review question 1 of the cold CINO pass, 2026-10-07: an imported entry's lane was unruled, so A's chapter could have displaced B's own at B's next clear. Roads not taken: imported entries join the receiver's self; imported entries never appear in the packet, search only

D207 2026-10-07 [I>V] amends D156
  trig:  the agent is about to stop its turn [I>V]
  resp:  when the session's newest checkpoint of either kind is at or beyond the configured interval, counted in rounds and or minutes, whichever is reached first, the agent is made to write a bookmark before it stops, so the twentieth stop under the default writes it; the interval is set from inside the Claude Code session through a treecontext command, and the developer's own deliberate checkpoint remains available and supersedes the automatic one [I>V]
  sib:   none -- the roads not taken below are alternatives, not failure cases
  serves: N24 N1 N23
  touches: D156 D157 D163 D146
# review question 2 of the cold CINO pass, 2026-10-07: "older than" left the boundary unruled. Road not taken: strictly past the interval, the twenty-first stop writing it

D208 2026-10-08 [I>V] amends D161
  trig:  a developer runs the installer or doctor on a machine where a documented client other than Claude Code is present [I>V]
  resp:  for every documented client doctor states which mode it has, reads the Claude settings file as-is or copies the hooks into its own configuration; its current installation state and whether that state is correct; and the remediation; the installer writes nothing for an as-is client, and for a copying client, Codex CLI and Gemini CLI, it copies the hooks only behind the existing experimental flag, writing tools alone without it, so the unverified-platform rule of D30 and D109 stands and doctor's remedy names the flagged command [I>V]
  sib:   none -- a doctor row that names a mode without its state, or a state without its remedy, is the half-answer this removes
  serves: N23 N9 N3
  touches: D161 D154 D30 D109 D115
# review question 3 of the cold CINO pass, 2026-10-08: the bound install scenario "an unverified platform gets tools, not capture hooks" refuses to write capture hooks without the experimental flag; D161 had the copy unconditional. Road not taken: D161 amending D30 so the copy is written by default, labeled documented-only

D209 2026-10-08 [I>V]
  trig:  groups configuration lands with the remainder of the attribution program [I>V]
  resp:  group orientation, a member orienting on self and on its group, waits for that configuration; D168 stays in effect and unbuilt, and no scenario carries it until then [I>V]
  ->     fence-deferred group-orientation
  serves: N22
  touches: D168 D191 D203
# review question 4 of the cold CINO pass, 2026-10-08: the group scenario needed membership that nothing in beta.2 declares. Roads not taken: membership declared in the brief the orchestrator injects at the subagent's start; membership as a role-name prefix convention

D210 2026-10-08 [I>V]
  trig:  the handshake instructions are assembled for an agent [I>V]
  resp:  the handshake carries the checkpoint protocol in under twenty-five hundred characters in all, and the protocol's long form lives in the skill reference text the agent can load on demand, so the card stays a card and the record that verbose instructions suppress memory use is honored [I>V]
  sib:   none -- the roads not taken below are alternatives, not failure cases
  serves: N14 N25 N1
  touches: D174 D8 D14 D139
# review question 5 of the cold CINO pass, 2026-10-08: the brief lexical instructions measure 1272 characters today and the four D174 scenarios add a protocol. Roads not taken: a looser bound of four thousand characters with everything in the handshake; no numeric bound beyond the platform size cap

D211 2026-10-08 [V] ratifies N25
  resp:  the usability need stands as written: a junior who never reads the README is carried by the agent's instructions, sees that capture works, pays one reply per /clear, and receives a handoff file that explains itself [V]
  ->     boundary
  serves: N25
  touches: N25 D171 D172 D173 D174
# the visionary's "yes, ratify N25 as written", 2026-10-08, at the review

D212 2026-10-08 [V] ratifies N26
  resp:  the ops-burden need stands as written: the sprint runs with zero maintenance and doctor is the one operation the developer runs [V]
  ->     boundary
  serves: N26
  touches: N26 D178 D179
# the visionary's "yes, ratify N26 as written", 2026-10-08, at the review

D213 2026-10-08 [V] ratifies D144
  resp:  the merge is idempotent by identity through the back-pointer every copy carries, as built and charter-pinned on `2026-10-05` [V]
  ->     boundary
  serves: N5
  touches: D144 D186
# the visionary's "yes, ratify D144", 2026-10-08, at the review; the back-pointer seeded the reference model of D186

D214 2026-10-08 [V] ratifies D145
  resp:  the hackathon re-cut's record stands as read: every entry from D145 through D213 and the needs N23 through N26, the interviewer's drafts among them accepted as written at the review of `2026-10-08`; a disputed line becomes a dated correction, never an edit in place [V]
  ->     boundary
  serves: N23 N13
  touches: D145 D132 D130
# the visionary's chain ratification after reading every scenario of the four new files and the ledger's new rows; read depth self-reported as superficial, recorded in docs/scope-runs.md

D215 2026-10-08 [I>V] amends D14
  resp:  server-side summarization or any model in the loop is declined; summarizing is the calling agent's job, and the lexical backend registers no tree-era checkpoint or summarize machinery and its instructions name none of it; the checkpoint of D158, a bookmark or a chapter summary, is an entry the agent itself writes, not machinery, and the instructions teach it as D174 requires [I>V]
  ->     fence-declined server-side-llm
  serves: N14
  touches: D14 D39 D158 D174 D210
# raised by the chunk-3 builder, 2026-10-08: the bound scenario "the lexical backend never advertises machinery it lacks" reads "no checkpoint or summarize instruction appears", and D174's protocol must say "checkpoint". Resolved from the record under the owner's standing instruction for the night: the later, more specific rulings D158 and D174 (ratified by chain D214) govern the word; D14's intent, no tree-era machinery, stands. Awaits the owner's ratification; the scenario's step is reworded under a sanctioned change citing this entry

D216 2026-10-08 [I>V]
  trig:  a /clear fires the session-start hook [I>V]
  resp:  a /clear mints a new session id, so the developer's session for re-orientation is the chain of ids linked through clears on one process: the hook reads the predecessor's id from the pid beacon before it rewrites it, builds the packet from the predecessor chain, and keys the once-a-day nudge and the bookmark supersession on that chain; the stop hook records each ask it makes under the payload's own session id and never asks twice within one interval, whether the bookmark's attribution failed or the agent ignored the request [I>V]
  sib:   none -- a packet read from the new, empty session is the failure this corrects, not a behaviour
  serves: N1 N24 N23
  touches: D167 D187 D198 D166 D156 D207 D190
# rule-6 correction, 2026-10-08, raised by the chunk-1 reviewer: the transcript read on 2026-10-05 as proof that /clear keeps the session id is the POST-clear session (it opens with the SessionStart:clear event and the /clear command as its first user entry; its predecessor file ends five seconds earlier under a different id). The comment under D167 and the journal notes of 2026-10-05 are wrong on that fact; D167's resp stands. The means is the builder's, pending ratification

D217 2026-10-08 [I>V]
  resp:  two builder's choices under D163 and D157 recorded so they are ruled rather than folklore: text that names no interval at all is a usage error, not a refused value, since D163 refuses no interval; and "effectively off" means any limit above about three hundred rounds or a day, from the sprint arithmetic of `D157` [I>V]
  ->     structural
  serves: N24
  touches: D163 D157

D218 2026-10-08 [I>V]
  resp:  until the file-bound door and the self-describing head of `beta.2` exist, a handoff imported through the import tool is marked with the import's label as the file it came from and the importing session as its importer, and the sender the packet names is the file's own `exported_by` claim, kept as a claim; a file that claims no sender is announced as from an unnamed sender [I>V]
  ->     structural
  serves: N23 N5
  touches: D151 D165 D172 D199 D206
# raised by the chunk-2 builder, 2026-10-08: D165 says "imported from that file by the importer" and D206 says the packet names the sender, but in beta.1 the import tool takes the file's content, not its path, and the beta.1 export writes no head. The label already promised to be "recorded on the imported entries" and never was; it now is, as the file's name. The head that writes `exported_by` is D172's, at beta.2. The means is the builder's, pending ratification

D219 2026-10-08 [I>V]
  resp:  an imported entry's claims of session, writer, author, agent, namespace, merge provenance, handoff marks and supersession leave its top level and are kept verbatim under one claims key; its lane is the sender's claimed session behind a `handoff:` prefix, or the file's name where it claims none, so no claim can place it in the receiver's self; a claimed supersession becomes a reference in its `refs` [I>V]
  ->     structural
  serves: N23 N5
  touches: D165 D169 D186 D206
# raised by the chunk-2 builder, 2026-10-08: the store's own readers take a top-level session id as the lane and `_writer` as the writer, so a claim left there would be trusted as identity, which D165 forbids; a hand-edited file claiming the receiver's session would otherwise join the receiver's self, the failure D206 names. The prefix keeps the sender's lane its own while every original value survives as data

D220 2026-10-08 [I>V]
  resp:  three builder's choices under D164 and D184 recorded so they are ruled rather than folklore: an id this store holds with different content is left alone, never overwritten, and counted apart as an id conflict rather than as present; a curated twin the store's own unique index refuses counts as present; the library import without the handoff marks stays the faithful round-trip the archive restore of D48 relies on and is the only path that restores a demoted stump; and a sender's time more than `5` minutes ahead of the receiver's clock is the future the packet discloses [I>V]
  ->     structural
  serves: N23 N5
  touches: D164 D184 D48 D144

D221 2026-10-08 [I>V] amends D220
  resp:  the builder's choices under D164, D165 and D184, restated as corrected: identity alone decides inside a handoff lane, so the curated unique index leaves out every row whose lane carries the `handoff:` prefix, recreated under that predicate by migration `025` and spelled once for every site that builds or reads it, and a teammate's entry whose content matches one of the receiver's own still lands; content is matched only for an entry the file carries no id for, and then in every lane, handoff lanes included; an id this store holds with different content is left alone, never overwritten, and counted apart as an id conflict rather than as present; an entry that is not an object at all is counted as malformed, never a failure; on the handoff door the importer, not the file, sets the row's read-only flag, decay exemption, utility and source; a handoff lane is never the newest session for retention and is ordered for eviction by when it was imported; and a sender's time more than `5` minutes ahead of the receiver's clock is the future the packet discloses [I>V]
  ->     structural
  serves: N23 N5
  touches: D164 D165 D184 D220 D48 D144
# a dated correction raised by the chunk-2 review, 2026-10-08, never an edit in place. Struck from D220: "a curated twin the store's own unique index refuses counts as present", which contradicted D164 [V] (identity first, content only where the file carries no identity), reproduced end to end by the coordinator; and "the library import without the handoff marks … is the only path that restores a demoted stump", replaced by the pointer to D222, the entry after this one. D220 also said "three builder's choices" and listed four, and carried no comment; both are corrected here. The newest-session rule follows the review's reproduction: a handoff lane's created_at is the sender's clock, and a lane imported three hours ahead evicted the receiver's present session

D222 2026-10-08 [I>V]
  resp:  every import through the import tool is a handoff, marked, laned and read-only, because the tool receives pasted content with no provenance and cannot know an archive from a handoff; restoring an archive or a demoted stump through the tool is not supported in `beta.1`; the designated shape of the restore door is a distinct operation that reads the archive from the path a tombstone records, never from pasted content, scoped later; the command-line import keeps its tombstone message [I>V]
  ->     structural
  serves: N23 N5 N6
  touches: D165 D48 D55 D164
# resolved from the record by the coordinator, 2026-10-08 (review finding F3): D165's precondition is content that crossed a trust boundary, and the tool's content has no provenance; D48's round-trip is bound through the library path and still holds. The tool's reply says when a file's entries claim sessions this store archived

D223 2026-10-08 [I>V] amends D219
  resp:  an imported entry's claims leave its top level and are kept verbatim under one claims key: its session, writer, author, agent, namespace, merge provenance, supersession and pointer state, by the keys `session_id`, `_session_id`, `_writer`, `agent_id`, `agent_type`, `author`, `_namespace`, `_merge_label`, `_merged_from_node_id`, `_merge_source_store`, `supersedes`, `superseded_by`, `superseded_at`, `next_session` and `status`, and every key under the prefixes `_cc_session`, `_relied` and `_handoff_`; so a teammate's chapters are never the receiver's resume pointers, and the packet's handoff line finds the newest chapter summary the file claims among the claims; its lane is the sender's claimed session behind a `handoff:` prefix, or the file's name where it claims none, so no claim can place it in the receiver's self; a claimed supersession becomes a reference in its `refs` [I>V]
  ->     structural
  serves: N23 N5
  touches: D165 D169 D186 D206 D219
# raised by the chunk-2 review, 2026-10-08 (findings F1 and F7): D206 says everything about a handoff beyond the packet line is search and deliberate fetch by id, and the reproduction showed twenty-five imported chapters filling the receiver's status panel and hiding the receiver's own; the denylist also let session attribution evidence, reliance bookkeeping and an earlier importer's marks stay trusted

D224 2026-10-08 [I>V]
  resp:  every export writes, in the file's head, an `exported_by` field naming the exporting machine as its user at its host, the first piece of the self-describing head of D172 to land at `beta.1`; on import it is the file's claim of its sender, never identity; the scenario of D172 stays unbound until the whole head lands at `beta.2` [I>V]
  ->     structural
  serves: N23 N25
  touches: D172 D165 D218 D151
# raised by the chunk-2 review, 2026-10-08 (finding F5): the sender clause of the packet scenario passed only because the steps wrote the head themselves; the real export now writes it, and the packet names it as a claim ("Handoff claimed from")
D225 2026-10-08 [I>V]
  resp:  a copying client's copy is the Claude Code block install writes today, running the same Claude Code hook scripts: verbatim under `hooks` in Codex CLI's hooks.json, and for Gemini CLI with each event renamed, UserPromptSubmit to BeforeAgent, PreToolUse to BeforeTool, PostToolUse to AfterTool and PreCompact to PreCompress, Stop and the subagent events dropped, matchers kept and Claude's Windows shell key dropped; a command is treecontext's only when it runs a known script in treecontext's own hooks directory or is an earlier build's spelling; a copy reads consistent when its treecontext entries equal that block's, foreign hooks and matcher order aside, it sits in one place only, and the scripts it runs exist; the flagged install command both copies and rewrites, clearing the hooks table of Codex's config.toml as well, and uninstall removes both; uninstalling Claude Code keeps the scripts while a copy runs them and names the uninstall to run first; a client counts as installed when the directory detection looks for exists; VS Code's Claude-hooks setting is read from its user settings.json, unset counting as off [I>V]
  ->     structural
  serves: N23 N9
  touches: D154 D161 D208 D153
# raised by the chunk-6 builder, 2026-10-08, renumbered from the branch's D221 at the gate, main holding D221 to D224: journal-clients and D154 call the Codex copy "identical to the Claude Code block" and Gemini's "the translated copy of the Claude Code block", but the experimental install wrote per-agent configs pointing at the unverified codex/ and gemini/ adapters, so the remedy doctor names could never produce a consistent copy. Built as the feature says; the adapters stay in source, unwired, and uninstall still removes what earlier builds wrote. The cold review's fixes are folded in: config.toml graded but never written, a bare `/hooks/tc-` marker that claimed and deleted a user's hook, the Claude uninstall stranding the copy's scripts. Stop is left out of Gemini's translation because AfterAgent carries prompt_response and stop_hook_active, another transcript, and treats `deny` as a forced retry, a hazard for the stop hook's bookmark ask; AfterAgent may be added only after a live probe. BeforeAgent follows src/hooks/gemini/normalize.ts. The means is the builder's, pending ratification

D226 2026-10-08 [I>V]
  resp:  for a client that reads the Claude settings file as-is, VS Code and Cursor, the installer writes nothing even behind the experimental flag, printing one line that says the client reads the Claude settings file; their adapters stay in source, unwired; uninstall still removes the hook files and wrappers earlier builds wrote for them; and doctor reads such a file beside the Claude route as a second route, its row a warning whose remedy is the client's hooks-only uninstall, never nothing to do [I>V]
  ->     structural
  serves: N23 N9
  touches: D208 D154 D29 D30
# raised by the cold review of chunk 6 and resolved from the record by the coordinator, 2026-10-08: D208 says the installer writes nothing for an as-is client, with no flag clause, and D30 keeps unverified adapters unadvertised; the flagged install had wired a second hook route in ~/.copilot/hooks/treecontext.json and ~/.cursor/hooks.json beside the Claude settings file while doctor read nothing to do. The bound journal-install scenario "experimental capture is an opt-in by name" (D29) pinned the VS Code write in its steps; the feature names no agent, so its steps were rebound to Codex CLI, whose flagged install writes a real copy that doctor reads present and consistent, both halves of the opt-in on the same agent; the feature file is untouched. The remedy carries --hooks-only so the client's MCP tools survive it

D227 2026-10-08 [I>V]
  resp:  the store's reverse index of references is a table `node_refs` of referenced id and referring id, created by migration `026` with a backfill of the `refs` every row already carries, and kept by triggers on the journal's rows so every writer maintains it; `refs` is one id or a list of ids in the referring entry's metadata; the "referenced by" block is the same on every read surface and reads only referrers in the entry's own namespace: the count of them all, and one referrer's id, writer, age and first line cut to `80` characters, the newest from another lane when there is one and else the newest, never its full content and never what refers to it; a search hit and a fetch by id carry it as `referencedBy` and omit it when nothing refers to the entry; the whole-journal export, a backup, carries none; the packet's line keeps its shape and names the count as "newest of N" when there are more; the writer shown is the importer's mark for an imported entry, then `_writer`, then `agent_type`, then the session [I>V]
  ->     structural
  serves: N5 N23 N1 N24
  touches: D186 D187 D162 D165 D169 D196
# raised by the chunk-5 builder, 2026-10-08: D186 rules the reverse index and the one-hop block but not their spelling; a table kept by triggers was chosen over an index over the JSON because SQLite cannot index the rows a JSON array expands to, and over upkeep in the insert path because rows also land through ingestion, import, merge and the archive restore; the packet's earlier filter to newer referrers is dropped, since a reference to a later entry exists only where an imported sender's clock ran ahead. Restated 2026-10-08 after the chunk-5a review: the first text read referrers store-wide and showed the newest of any lane; review finding F4 showed a referrer in another namespace leaking its first line into this one's hit, which D196 forbids, so referrers are read inside the entry's namespace; finding F3 showed three of the owner's own notes masking the subagent's note D187 exists to show, so the block prefers the newest other-lane referrer while the count stays all

D228 2026-10-08 [I>V]
  resp:  a supersession names a target in the writer's own lane or in another's; the lane is an imported entry's session key behind its `handoff:` prefix, else the writer the entry names, `_writer` and else `agent_type`, and an entry naming no writer is the main lane whichever session wrote it; a target in the writer's own lane is retired as before; a target in another writer's lane is left untouched, byte for byte, and its id is added to the new entry's `refs`, the reply listing it as `referenced`; when the insert is a duplicate that lands no row, such a target is listed among the misses with the reason `other_writer`, and every incoming reference the surviving row does not carry is listed as `refs_not_recorded`, the survivor never modified to hold it; the insert tool drops every `_handoff_*` key a caller sends, those marks being the importer's alone; until the server stamps `_writer` from the session registry the lane key is the writer's own claim, and no real subagent claims one, so the protection is inert for real subagents and the two scenarios of D169 stay unbound until D190 [I>V]
  ->     structural
  serves: N5 N23 N21 N20
  touches: D169 D166 D167 D190 D186 D165 D223
# raised by the chunk-5 builder, 2026-10-08: the coordinator's brief read the writer as `_writer`, else `agent_type`, else the session, the precedence the packet uses to NAME a writer; as the key for retiring pointers the session would make every new session's close-out unable to retire the last session's chapter, the lifecycle the retraction scenario of D185 binds, and D167 makes the main session's self the main checkout, not the process. The session stays in the displayed name and leaves the lane key. When D190's registry stamps `_writer` on every row, an older main-lane row naming no writer and a newer one stamped with the main checkout must still read as one lane; that reconciliation is the next chunk's. Restated 2026-10-08 after the chunk-5a review: findings F1 and F2 proved over the tools that a subagent writing no writer, which is every real subagent (none of 18,903 live rows carries one), still retires the chapter, and that a claimed writer can be emptied to rejoin the main lane; D169's comment requires the writer stamped by the store, so the two D169 scenarios returned to wip and the protection is recorded as claim-based. Finding F5: the first text scoped a bookmark's automatic supersession to the writer's own bookmarks, which contradicts D166 [I>V], at most one live bookmark per session; that clause is struck and the supersession is session-scoped as before. F6: a dedup hit dropped its references silently; now disclosed. F7: the imported lane follows D223's session key, not the file name. F8: an importer's mark could be forged through the insert tool; now dropped there

D229 2026-10-08 [I>V]
  resp:  the tool's export without a node id is the default handoff of D177, summaries only; the whole journal comes back only when it is chosen with the form `whole` and its secrets warning acknowledged; so journal-library "the whole journal exports through the tool surface" now reads "When export is called with no node id and the whole journal chosen, its secrets warning acknowledged", and design output-shielding "an oversize export is shielded the same way" now reads "When the whole journal is exported, its secrets warning acknowledged", a sanctioned rewording recorded on the fence, both titles unchanged [I>V]
  ->     structural
  serves: N23 N5 N25
  touches: D177 D149 D7 D215
# raised by the chunk-4 builder, 2026-10-08: the old steps "export is called with no node id" and "the journal is exported" and journal-handoff's "the default export carries summaries only" cannot all hold for a call with no other arguments. Resolved from the record in the AGENTS.md order: D177 [I>V], ratified by chain D214, is the later and more specific ruling; the rewording was taken at the chunk-4 review under the D215 precedent and the owner's instruction to proceed, and its ratification is owed

D230 2026-10-08 [I>V]
  resp:  three builder's choices under D170 and D177 recorded so they are ruled rather than folklore: the export tool's `form` is `summaries`, the default, or `whole`; a whole export without `secrets_acknowledged: true` writes nothing and returns the warning with the count it would write, so the warning precedes the write as two calls, and the acknowledging call's reply carries no second warning; a summary is a live `next_session` pointer whose `kind` is not `bookmark`, or a row whose `kind` is `subagent-summary`, the marker the orchestration chunk stamps from the SubagentStop capture, so a superseded chapter, whose pointer flag supersession clears, travels only in the whole form; the summaries form carries LIVE chapter summaries only, and the producer of the `subagent-summary` marker is the orchestration chunk's, so until it lands a default handoff carries chapter summaries alone; the inline cap's default and ceiling are both `10000`, the newest kept oldest first, and every inline reply states its omitted count and names the file door as the way to the rest, `0` included; a file carries no cap, and a file read by path imports past the pasted door's `5` MB and `10000`-entry caps; a file export or import is held whole as one string, bounded by the engine's string limit and costing about three times the file's size in memory (a `104` MB file peaked at `772` MB), and streaming is a later shape; a server under the `read_only` policy still writes handoff files, because the policy bounds the store, not the filesystem [I>V]
  ->     structural
  serves: N23 N5 N25 N1
  touches: D170 D177 D149 D199
# flagged for the owner at the chunk-4 review: that a superseded chapter travels only in the whole form, and that a `read_only` server writes files. Raised by the chunk-4 builder, 2026-10-08: the inline default was `5000` with a ceiling of `10000`; D170 calls `10000` today's cap and its scenario exports `10000` with no limit named, so the default rose to the ceiling. A single-call warning cannot be told from a write that precedes it, which is the mutant D177's "before it writes" must kill

D231 2026-10-08 [I>V] amends D224
  resp:  the self-describing head of D172 is complete: every handoff file opens with `exported_by` (the exporting machine's user at its host), `exported_at` (universal time to the second), `project` (the project directory's name), `treecontext_version`, `holds` (a sentence naming the count and the form), and `to_import` (the one step: the agent's import with the file's path, or the shell command), then `form`, `node_count`, `version` and `namespace`, then the entries; a file is pretty-printed, an inline reply compact; on import every head field stays the file's claim, and only `exported_by` is read, as the claimed sender [I>V]
  ->     structural
  serves: N25 N23 N5
  touches: D172 D224 D165 D218
# raised by the chunk-4 builder, 2026-10-08: D224 kept the D172 scenario unbound until the whole head landed at beta.2; it has, and binds

D232 2026-10-08 [I>V]
  resp:  the project directory a handoff path is held to is the one the server was started for, resolved as the store is, from `--project-dir`, then `TREECONTEXT_PROJECT_DIR`, then the working directory, and never from the agent; a requested path is resolved against it, every directory on the way that exists is resolved through its links, and the result must lie inside the project's real path; the file itself may not be a link, the project directory itself is no file, and the write is a fsynced sibling renamed over the target; the import tool's path door is held to the same rule, takes the file's path relative to the project as its label, and is exclusive with pasted `data` and `label` [I>V]
  ->     structural
  serves: N23 N5 N10
  touches: D199 D218 D165 D170
# raised by the chunk-4 builder, 2026-10-08: DESIGN.md's chosen means already said the path is accepted only inside the project directory; reading by path is held to it too, so an agent cannot be steered into importing a file such as a key from outside the project into the journal

D233 2026-10-08 [I>V] amends D222
  resp:  the terminal door of D199: `treecontext export <path>` writes the file the export tool writes for the same store and form, the summaries by default and the whole journal with `--whole`, which warns and writes nothing without `--yes`; `treecontext import <path>` imports a handoff file, marked as a handoff like every import, the importer named `shell:` and the shell's user at its host; a shell path is the shell's, relative to where the command runs and not held to the project; the clause of D222 that the command-line import keeps its tombstone message ends here, and only a tree-era `.msgpack` dump still meets it [I>V]
  ->     structural
  serves: N5 N25 N10
  touches: D199 D222 D165 D170
# raised by the chunk-4 builder, 2026-10-08: D222 [I] spoke for beta.1; D199 [I>V] governs beta.2. The export resolves its store read-only, like backup, and the import resolves it as serve and the hooks do, since it writes

D234 2026-10-08 [I>V]
  resp:  the path rule of D232 also guards what is already in the repository: an export never overwrites an existing file unless its head reads as a treecontext handoff, an object carrying `form` and `exported_by`, so an older handoff is replaced and anything else is refused; a path whose first segment is `.git` is refused outright; a file read by path that is not JSON is refused as "not a handoff file" with nothing of its content echoed; a dangling directory link or a path through an existing file meets the same structured refusal as a path outside the project; the shell's `treecontext export` takes any path but likewise refuses to overwrite a file that is not a handoff unless `--force` is given [I>V]
  ->     structural
  serves: N23 N5 N10
  touches: D199 D232 D165
# raised by the chunk-4 review, 2026-10-08: the export path rule let the reviewer overwrite package.json and .git/hooks/pre-commit inside the project, and a path import of an env file echoed a fragment of it in the parse error; docs/security.md records the rule beside the store's file-mode contract

D235 2026-10-08 [I>V]
  resp:  self and its writers live in a store table `session_registry`, created by migration `027`, one row per session and agent: the session's own row has an empty agent id and holds the worktree, a linked worktree's directory name or none for the main checkout, the branch, the directory, git's top level and common dir; a subagent's row holds its agent id and agent type, started and stopped; the session-start hook registers the self on every start, SubagentStart registers a subagent under the parent's session id and SubagentStop retires it; a row a subagent's hook captured is stamped from the payload's agent fields at the drain, `_writer` its agent type and `_writer_src` `hook`; a row written through the tools is stamped by the server from the session it already resolves: exactly one live subagent, that subagent with `_writer_src` `registry`; none, the self, `main` in the main checkout and `worktree:<name>` in a linked worktree, with `_worktree` and `_branch`; more than one, the self with `_writer_src` `ambiguous` and the live candidates, the reply saying so, and every target it supersedes recorded as a reference, never retired; an unknown session is stamped `unregistered` and names no writer; the reply says the writer stamped; the insert tool drops every caller copy of the stamp; the lane key reads `_writer`, an older row naming no writer and a row stamped `main` being one main lane [I>V]
  ->     structural
  serves: N5 N20 N21 N23
  touches: D190 D167 D169 D228 D148 D196
# raised by the chunk-5b builder, 2026-10-08: D190 rules the registration and the lookup but not their spelling. A table in the store was chosen over the session-annotation files DESIGN.md's chosen-means line names, because the server must look the registration up beside the row it writes and a subagent's registration has a start and a stop; that line is restated in DESIGN.md, not edited. The orchestrator is stamped `main`, the main agent of the main checkout, so its rows and every row written before the registry read as one lane, the reconciliation D228 left to this chunk. An ambiguous row owns no lane because stamping the self is the record's rule but letting that guess retire a pointer would modify another's lane on a guess; the disclosure is the reply's `writer_note` and the candidates on the row

D236 2026-10-08 [I>V]
  resp:  a session starting in a linked worktree, other than by a /clear, opens its packet with that worktree's own thread: the newest live chapter summary whose `_writer` is `worktree:<name>`, from any session that ran there, labeled as the worktree's own with its age and referrers; and the brief addressed to it, the newest entry whose metadata `brief_for` names the worktree, with its writer and age; a worktree with neither says it starts fresh; the brief is the means of "the orchestrator injected the brief at its start": an entry the orchestrator writes through the insert tool before the worktree's first session; the main checkout's fresh start keeps its packet unchanged [I>V]
  ->     structural
  serves: N23 N24 N20 N5
  touches: D167 D150 D190 D187
# raised by the chunk-5b builder, 2026-10-08: D167 names "the instruction or entry injected at its start" and D150 "the plan it was spawned under", without a means. An entry addressed by `brief_for` was chosen over a hook-side handoff file because it is written with the tools the orchestrator already has, it is searchable and referenceable like any entry, and the same key briefs a subagent role in its default search (D237). The main checkout's fresh start was left as it is, the orientation reminder and the status pointers, because no scenario binds it and the status panel already serves it; D167's main-checkout half is therefore carried by the stamp, not yet by a packet line

D237 2026-10-08 [I>V]
  resp:  a search by a caller the registry resolves to the session's one live subagent defaults to that subagent's scope: rows the store stamped with its role as writer, the live resume pointers of the lane that spawned it, the session's self, the entries whose `brief_for` names its role, and the entries those pointers and briefs reference, one hop; the scope is applied in the store before the result count and to every hit's conversation window, since the subagent shares its orchestrator's session; the reply names the scope and how to widen it, and `scope: "all"` searches the whole store; every other caller searches as before; a writer's whole trail is read by `treecontext_export` with `writer`, a role or one subagent's agent id, oldest first [I>V]
  ->     structural
  serves: N20 N21 N23
  touches: D150 D148 D127 D196 D186
# raised by the chunk-5b builder, 2026-10-08: D127 puts the subagent's restriction on the query tool, and D148 asks for the whole trail, which the query tool's result cap of twenty cannot return for a trail of forty-one, so the trail read is a writer option on the export tool's whole-journal branch. "The plan it was spawned under" is read as the spawning lane's live pointers at the moment of the search, there being no record of which pointer was live at the spawn

D238 2026-10-08 [I>V]
  resp:  a subagent's summary is its SubagentStop payload's `last_assistant_message`, else the last assistant text of its own transcript, staged as an assistant row with kind `subagent-summary` and its writer, drained like any capture, session-scoped in its dedup; the registration is retired on the same connection after the capture; a row stamped as a subagent's, `_writer_src` `registry` or `hook`, is never the orchestrator's chapter, bookmark or newest checkpoint in the packet after a /clear or in the stop hook's interval, though it shares the session id [I>V]
  ->     structural
  serves: N21 N23 N5
  touches: D147 D169 D159 D156 D190
# raised by the chunk-5b builder, 2026-10-08: D169's comment rules a subagent's checkpoints always marked as its own; without this exclusion a tester's pointer, sharing the session, became the orchestrator's chapter in its next packet and hid the orchestrator's own chapter and its referrer line

D239 2026-10-08 [I>V]
  resp:  the stamp's known limits are disclosed, not closed: a subagent running in the background while the orchestrator writes through the tools makes the single-live rule stamp the orchestrator's row as the subagent's, the reply naming that writer; a subagent whose SubagentStop never arrives stays live and holds the rule there until the session ends; an install that predates the two subagent hooks registers no subagent, so its subagents' notes are stamped as the self; the Gemini translation drops both events and the Codex copy carries them verbatim [I>V]
  ->     structural
  serves: N5 N20 N23
  touches: D190 D169 D225 D153
# raised by the chunk-5b builder, 2026-10-08: the shared-session hazard is remediable under the record for the foreground subagent, the Agent tool's default, during which the orchestrator waits; the background case would need per-call correlation, for instance a PreToolUse record of the calling agent matched by the server, which D190's roads not taken do not forbid but no ruling asks for. Left for the owner

D240 2026-10-08 [I>V] amends D235
  resp:  a row written through the tools is stamped at insert with the registry's reading and corrected at the drain by its own echo; at insert: no subagent of the session live, the self, `_writer_src` `self`; a subagent live and the session's own agent seen by a hook after the oldest live subagent started, a staged or drained event of the session carrying no agent fields, the self with the live candidates, `concurrent`; exactly one live and no such event, that subagent, `provisional`; several live and no such event, the self with the candidates, `ambiguous`, owning no lane; the reply says the writer, its source and, for each of these three, a `writer_note`; at the drain, the PostToolUse echo of the insert call, matched exactly by the node id the tool's own result names, same session, within `60` seconds of the row, and only for a call that created the row, sets the writer from the echo's agent fields, a subagent's type and id, or none for the session's own agent and then its self, with `_writer_src` `echo`, keeping the insert-time stamp as `_writer_stamped` when it differed; when the correction moves the row to another lane, every pointer the row retired at insert that the new lane does not own is restored to the flags it held, kept on the target as `_superseded_prior` when it was retired, and added to the row's `refs`, listed as `_writer_heal_reverted`, with a `_writer_heal_note`; a correction into a lane changes nothing else, a supersession recorded as a reference stays one and the note says so; a subagent's default search scope of D237 applies only to a `provisional` caller, and a `concurrent` or `ambiguous` caller searches the whole store with the reply's scope saying why; a row is a subagent's for the packet and the stop hook's interval when it names a subagent's agent id, so a row the echo moves to the session's own agent counts as the orchestrator's; what remains of D239: an echo that never drains, shielded or lost, leaves the insert-time stamp, disclosed by its source; a subagent whose stop never arrives stays live until the session starts, resumes or clears, every live subagent of the session being retired then; an install predating the two subagent hooks registers no subagent, though its echoes still correct its writers [I>V]
  ->     structural
  serves: N5 N20 N21 N23
  touches: D190 D169 D150 D235 D237 D238 D239 D228
# raised by the cold review of chunk 5b and resolved from the record by the coordinator, 2026-10-08 (finding F1, reproduced with real hooks): with one background subagent live, the single-live rule stamped the orchestrator's chapter as the subagent's, left its old chapter live, scoped its search to the subagent's lane and hid its bookmark after a /clear. D190 says the server resolves self by looking up the session it knows; the attribution proposal of 2026-09-24 §6 and the probe of 2026-09-25 record the echo as the per-call means, and staging now carries the caller's agent fields. The concurrency evidence is what Claude Code produces for a background spawn: the Agent tool's own PostToolUse returns at once, while the subagent runs, and a foreground spawn produces none until it stops. Without it, a row the echo moves into the self lane leaves a pointer the orchestrator meant to retire live, which the row's note discloses

D241 2026-10-08 [I>V] amends D166
  resp:  a new bookmark retires the previous live bookmark of its session in its own lane only: at most one live bookmark per session per lane; a subagent's bookmark never retires the orchestrator's nor the orchestrator's a subagent's; a writer the store cannot tell apart retires none [I>V]
  ->     structural
  serves: N23 N5
  touches: D166 D169 D158 D240
# raised by the cold review of chunk 5b and resolved from the record by the coordinator, 2026-10-08 (finding F2): a subagent shares its orchestrator's session, so the session-scoped supersession of D166 let a subagent's bookmark retire the orchestrator's, against D169's "only a lane's own writer retires that lane's pointers"; D166's one live bookmark per session was about the panel's growth, which one per lane still bounds. Owner ratification owed

D242 2026-10-08 [I>V]
  resp:  a session registered in a linked worktree calls status and sees the live pointers of that worktree's own lane, with a `scope` block naming the lane, the count of other lanes' live pointers left out and how to widen; `scope: "all"` lists every lane's; a session in the main checkout, or one the server cannot place, sees every lane as before, its self being the main lane with every row that names no writer [I>V]
  ->     structural
  serves: N23 N24 N20
  touches: D167 D190 D236 D240
# raised by the cold review of chunk 5b and resolved from the record by the coordinator, 2026-10-08 (finding F5): D167 makes default re-orientation anchor on self, and status is the handshake's mandatory first move, so a worktree session listing every lane's pointers oriented on strangers' threads before its own

D243 2026-10-08 [I>V]
  resp:  a detached HEAD registers no branch; a linked worktree whose directory name another registered top level already holds registers as `<name>@<six hex of its top level's path>`, a top level keeping the name it first registered under; a subagent type spelled `main`, or starting `worktree:` or `agent:`, is stamped under the prefix `agent:`; a writer's trail by `main` includes the older rows naming no writer, and by a role the older rows claiming it as `agent_type` with no stamp, as the lane key reads them; a trail longer than the export's cap returns the newest within it, oldest first, stating `omitted`; a row stamped `ambiguous` is never a worktree's own chapter; the writer trail bypasses the summaries default of the handoff export [I>V]
  ->     structural
  serves: N5 N20 N23
  touches: D190 D167 D148 D228 D235 D237
# raised by the cold review of chunk 5b, 2026-10-08 (findings F6, F7), and by the merge with the file-bound handoff: the means are the builder's, pending ratification

D244 2026-10-08 [I>V] amends D240
  resp:  the reversal clause and the heal's guards of D240, restated: the echo heal acts only on a row the call created, of the echo's own session or of none, within `60` seconds of the row; when it moves the row to another lane it puts right every act the first stamp did across lanes: a pointer the row retired that the new lane does not own is undone, back to the earlier retirement it carried when it had one, its history kept, else back to its flags, and named in the row's `refs`; a retirement the row suffered from a writer of another lane than its new one is undone the same way and recorded as a reference on the retiring row; a supersession the row asked for but could not perform under its first stamp, kept as `_supersedes_referenced`, is performed when its target is a live pointer of the new lane, listed as `_writer_heal_retired`; a bookmark being restored into a lane where its session already has a newer live bookmark stays retired, pointing at that one; every act is listed on the row with a `_writer_heal_note`; a second heal of the same echo changes nothing; the residuals D240 left are restated: an echo that never drains leaves the insert-time stamp, disclosed by its source; until the drain, about five seconds, a row stamped wrongly at insert acts in its first lane, and a packet or status read in that window shows it so; a subagent whose stop never arrives stays live until its session starts, resumes or clears; an install predating the two subagent hooks registers no subagent; the order in which Claude Code delivers the Agent tool's own PostToolUse and SubagentStart for a background spawn, which the concurrency evidence relies on, is a live-platform probe still owed; with the order reversed the orchestrator's next insert is `provisional` and set right at the drain [I>V]
  ->     structural
  serves: N5 N20 N21 N23
  touches: D240 D241 D169 D190 D153
# raised by the second cold review of chunk 5b, 2026-10-08 (findings F-A, F-C, F-D, F-F; probes P1 and P12 reproduced with real hooks): the first reversal undid only the retirements the healed row performed, so a retirement it suffered while wearing the wrong lane persisted across lanes and a restored bookmark could leave its lane two live; the session clause of D240 was not checked; a provisional row healed into the self lane left the pointer it was written to retire live. D153's rule, never claim what was not run, puts the event order on the residuals

D245 2026-10-08 [I>V] amends D241
  resp:  at most one live bookmark per session per lane holds at the echo heal as at the insert: a bookmark the heal would restore into a lane where its session has a newer live bookmark stays retired, pointing at the newer one; between an insert stamped wrongly and its heal, a bookmark may retire one of another lane, put right at the drain [I>V]
  ->     structural
  serves: N23 N5
  touches: D241 D244 D166 D169
# raised by the second cold review of chunk 5b, 2026-10-08 (finding F-A, probe P1). Owner ratification of D241 still owed

D246 2026-10-08 [I>V]
  resp:  for publication the record names no private project or person: the beta tester's platform is written as the orchestration platform, a role-based subagent orchestration platform for software development, and three private store names in the identity documents are written as research-project, second-project and third-project; every ruling's meaning is unchanged, and the chain head before this generalization, `1dd786d01695` over {271 entries}, is recorded here beside the head after it, `db07a2436082`, so the ratification by chain of D214 is traceable to the words it was given [I>V]
  ->     structural
  serves: N13 N23
  touches: D214 D203 D191 D9
# raised at release engineering, 2026-10-08: the owner's rule for the public repository is no personal names, emails, company names or private project names; a redaction is not a changed ruling, but it changes the text the chain covers, so the entry records both heads rather than editing silently. The words replaced appeared in D9's comment, D191, D203, the fence, the needs ledger, the attribution proposal and two identity documents

D247 2026-10-08 [I>V]
  trig:  the package is renamed `treecontext-mcp` and a version-manager upgrade deletes the pinned module, under either package directory name [I>V]
  resp:  the wrappers' fallback search, doctor's existence grade and the Wired build row look under `treecontext-mcp` and then `treecontext`, so a new wrapper recovers onto a surviving copy under either name; where both survive the current name wins over any legacy copy whatever the version order, because the legacy copy is an older release and running it against a store a newer build migrated is the worse failure; doctor probes exactly the names a wrapper's own search names, so a wrapper written before the rename, whose search names only `treecontext`, is graded dying beside a `treecontext-mcp` copy it cannot reach; a search that is read and finds no copy under either name is graded dying; a wrapper whose search cannot be read at all stays not judged, as before [I>V]
  sib:   none -- the grade of a search that lands nowhere is the failure handling, unchanged
  serves: N9
  touches: D120
# raised at the beta.1 release prep, 2026-10-08: `npm install -g treecontext-mcp` lands in `node_modules/treecontext-mcp`, and every managed-layout search spelled `node_modules/treecontext`, so the fallback that keeps hooks and the MCP launcher alive across an nvm or fnm upgrade would have found nothing. Builder's choices recorded here: the package name is the outer key of the search order (name before version), and the probe stays as narrow as the wrapper's own search rather than as wide as every layout

D248 2026-10-08 [I>V]
  resp:  the npx form of the MCP entry names the package, `npx -y treecontext-mcp`, never the command; `treecontext` is held by nobody on npm and anyone could register it; `--npx` itself stays refused during the beta, because npx resolves the `latest` tag, which is the name reservation [I>V]
  ->     structural
  serves: N9
  touches: D247
# raised at the beta.1 release prep, 2026-10-08, beside D247

D249 2026-10-08 [I>V]
  trig:  the platform signals the turn has ended [I>V]
  resp:  the stop hook captures the turn that just ended from the payload's own `last_assistant_message` when it is a non-blank string, and reads the last assistant text of the transcript only when the payload carries none; the stale-recapture guard compares whichever source supplied the text against the session's newest staged response, so a re-fired stop carrying the same text stages nothing new; the bookmark ask of D156 and D207 and the never-twice rule of D163 are unchanged [I>V]
  sib:   none -- a stop with neither a message nor a readable transcript captures nothing, as before
  serves: N3
  touches: D3 D156 D207 D163 D16
# raised by the live headless probe of the packed beta under Claude Code 2.1.293, 2026-10-08: at Stop time the transcript still ends at the previous turn, so all seven Stop rows of five runs held the prior turn's text and no session's final answer was captured; the Stop payload carries `last_assistant_message`, as the probe of 2026-09-25 had already seen. Observed headless only; the interactive client is unverified. Builder's choices: a blank message falls back to the transcript like an absent one; the guard keeps comparing against the newest staged response whatever the source, so two consecutive turns with identical text record one row, as they did before

D250 2026-10-08 [I>V]
  resp:  the install summary lists every event of the Claude Code hooks block install writes, read from that block, SubagentStart and SubagentStop included [I>V]
  ->     structural
  serves: N9
  touches: D190 D147
# raised by the live probe of 2026-10-08: the summary named five events while the block carried seven

D251 2026-10-08 [I>V]
  resp:  on macOS and Linux install writes every Claude Code hook command, and the Codex and Gemini copies that reuse it, as `exec` before the quoted wrapper path, so the `/bin/sh -c` the platform runs it in replaces itself with the wrapper, which execs node, and the hook's parent is the agent's own process; Windows forms are unchanged; doctor grades a hook command without `exec` on macOS or Linux as degraded session identity, fixed by `treecontext install --force --agent claude`; the pid-keyed session beacon, the /clear predecessor link of D216 and the hook's namespace annotation are unchanged in substance and now match where dash is `/bin/sh` [I>V]
  ->     structural
  serves: N23 N24 N9
  touches: D216 D90 D95 D122
# raised by the live probe of 2026-10-08: Claude Code runs every hook command through `/bin/sh -c`, and dash, `/bin/sh` on Debian and Ubuntu, forks a single quoted command where bash execs it, so every hook's parent was a short-lived shell: across five runs the server's annotation matched the claude pid every time and no hook beacon ever did, every curated row of the owner's last seven days was stamped by the echo, and the /clear predecessor read of D216 could never find its beacon. The suite never saw it because its harness spawns hooks straight from node. Roads not taken: a hook-side walk up the process tree past a shell parent, platform-specific; a newest-touched beacon rung between unanimity and ambiguity, a recency guess left to the owner as a proposal

D252 2026-10-08 [I>V]
  resp:  the re-orientation packet closes with the one-line reminder of how to leave a chapter summary only when the session has a chapter summary; with none, the once-a-day nudge of D198 carries that reminder on the first clear of the machine's local day, and later clears that day close with no reminder line [I>V]
  ->     structural
  serves: N23 N24 N1
  touches: D187 D198
# raised by the audit of 2026-10-08: D187 ends every packet with the one-line reminder, and D198 says later clears of the day repeat no nudge; on a session with no chapter summary the two meet, and the code settled it without an entry: `src/checkpoints.ts` writes CHAPTER_HOWTO when a chapter exists, else CHAPTER_NUDGE when no nudge mark for the chain's root and the local date is in store_config, else nothing. Recorded as the builder's choice the code made silently; the owner ratifies or reverses

D253 2026-10-08 [I>V]
  resp:  the second set of D197, references and the reverse index, self registration and writer stamps, file-bound export and import with the summary-only default and the self-describing file, and doctor's rows per client, was built on `2026-10-08` before `0.1.0-beta.1` was cut and ships inside `0.1.0-beta.1`; nothing of it is in effect and unbuilt between the betas, so the deferral of D205 is met by the build rather than by the `0.1.0-beta.2` release [I>V]
  ->     structural
  serves: N23 N13
  touches: D197 D205 D192
# raised by the audit of 2026-10-08: the chunk commits 6502f47, 9b7023a, 964dc82 and 95c2a55 called themselves the beta.2 build, while package.json names `0.1.0-beta.1` (b7c0d73) and no entry recorded that the set was folded into the first release. Recorded as the fold the build made; the owner ratifies or reverses

D254 2026-10-08 [V] ratifies D215
  resp:  the beta build's record stands as read: every entry from D215 through D253, the builders' means among them, the sanctioned rewordings of the D39 step and the journal-library and output-shielding steps, the rebinding of the D29 opt-in scenarios to Codex CLI, the generalization of D246 and the fold of D253, accepted as written on `2026-10-08`; a disputed line becomes a dated correction, never an edit in place [V]
  ->     boundary
  serves: N23 N13
  touches: D214 D215 D253
# the visionary's chain ratification, 2026-10-08: the thirty-nine entries carry the tag `I>V`, accepted as written, promoted from `I` at this ratification (the chain head moves with it, as D246 noted it would); after a grouped digest of the thirty-nine entries by surface, the amending entries marked; read depth self-reported as superficial ("at a superficial level looks ok"), as at D214: attention data weak, recorded so a later reading that reverses an entry is a correction, not a surprise
D255 2026-10-08 [I>V]
  resp:  the build item of D141 lands: the store-byte budget default is `128 MiB`; the config file's `retention` table sets the byte budget as `max_store_bytes`, a whole number of bytes, and the session cap as `max_sessions`, each a positive whole number, anything else dropped; the project's own `./treecontext.toml` sets them for that project's store ahead of `~/.treecontext/config.toml`, in the precedence the server already reads; serve passes both to every store handle it opens, the drain-side handles included; status reports the budget and the session cap; the over-budget warning names the table and the key, `max_store_bytes`, and no code constant; clarified `2026-10-08`: per store in D141 reads as per project through the config file for this release, the project's `./treecontext.toml` then `~/.treecontext/config.toml`, and the store-row door of D156 stays available later, unbuilt; the entry-count safety net scales with the session cap, two hundred auto-captured entries per configured session, so a cap of `100` keeps `20000` and a cap of `300` carries `60000`, with no third key, and a store opened with an explicit entry cap keeps it; clarified `2026-10-08`: the project file is discovered at the project directory the store binding resolves, the primary repository root, else the nearest ancestor holding `.git`, else the directory itself, starting from the project-directory option, then `TREECONTEXT_PROJECT_DIR`, then the working directory, so a server started from a subdirectory reads the root's figures; discovery reads the first file found whole, so the installation file's `retention` table governs only a project with no file of its own; a key that names no positive whole number is dropped with a line on stderr naming the file and the key; `stores merge` and `import` take neither figure, because neither ever sweeps [I>V]
  ->     structural
  serves: N7
  touches: D141 D108 D49 D156
# the owner, 2026-10-08: "we moved to 128MB file store. update documentation to reflect that." and "we are going to need larger stores with subagents — definitely build new feature files and code to reflect that decision". The code was the defect: the constant still read 64 MiB and no key existed. The @D141 scenarios of journal-storage.feature were written by the owner's instruction on 2026-10-08, revised after a cold review of their text the same day into four (the default, the operator's figures per project, a budget the file cannot mean, the knob the warning names), joined by a fifth for the scaled net (a cap of 150 holding 150 sessions of 150 entries, evicting only at the 151st), and all five bound in this chunk: the first four through a real serve spawned from the project directory, the fifth through the real loader, the library insert and the real sweep. The merge destination handle and the import open take no retention options because neither ever sweeps, each pinned at the command. The cold review of 2026-10-08 found the equality verdict failing under a concurrent writer and the project file read from the literal working directory while the store bound to the repository root; both corrected in this chunk. Marked [I>V] as this chunk's drafts carrying the owner's quoted words; chain ratification follows. The owner on the entry net, 2026-10-08: "i do agree with scaling with size of the file", read as the net scaling with the configured session cap, the file's figure, not with the store's bytes; the per-project reading of per store was the owner's ruling the same day. Builder's choices: bytes rather than a unit string, since the file has no unit convention; no command-line flag, the knob is the file

D256 2026-10-08 [I>V]
  resp:  every migration run takes the pre-migration backup before any pending migration, additive as well as destructive, through the one `VACUUM INTO` copy beside the store, and records the completion verdict for it while store and backup are twins, so the sweep, rm and prune treat it like any other backup; an in-memory database, with nothing to copy beside, is the one exemption; a hook still migrates only an empty store, and leaves a store holding rows to the server; clarified `2026-10-08`: the verdict judges by containment, success when every entry the backup holds is present in the migrated store and the migrated store holds no fewer, because an additive run takes no exclusive lock and a session writing between the copy and the comparison adds rows; a failed verdict's advice is to restore the missing entries from the backup, and to copy it over the live store only when nothing was written since the migration began [I>V]
  ->     structural
  serves: N12
  touches: D59 D60
# the owner, 2026-10-08: "the goal is to always have a backup before any migration or schema update. if it didn't happen, that's a mistake or oversight in the policy/plan." D59 already said every migration; the runner copied the store only ahead of a destructive step, so the additive 025 to 027 ran with no backup. Measured on a copy of the owner's store at 126 MB: the copy took about 140 ms and the whole 025 to 027 run with its verdict about 500 ms, warm cache; a hook never reaches it on a store with rows. The containment rule came from the cold review of 2026-10-08, which reproduced on a copy of the owner's store a failed verdict reading 30917 of the backup's 24186 entries with a writer active, and an advice to restore that would have lost the window's rows

D257 2026-10-08 [I>V] amends D50
  resp:  the read-only tier bounds the store, not the filesystem: a server under the `read_only` policy exposes only the reading tools and never writes the journal, and its export tool still writes a handoff file into the project directory when the agent asks, under the handoff path rules of D199; the tool description, the README and the security document say so [I>V]
  ->     structural
  serves: N15
  touches: D50 D199
# the owner, 2026-10-08: "if we are capable of and allow a writing, then the server documentation should reflect that. if we don't allow, then it's not allowed … whatever is the true state should be documented." The true state since D199 is that read_only export can write the file; documentation only, no change in behaviour

D258 2026-10-08 [I>V] amends D118
  resp:  a dead peer earns a swallowed write or a shutdown, never a storm, and a client that dies before the server finishes starting leaves no orphan, as D118 said; and the server, when it serves a client, writes its diagnostics to its log file only, under `~/.treecontext/logs/`, and keeps its stderr for warnings, errors and fatals, because the Claude Code client records every line a server writes to stderr as an error in its own log, so a healthy start under `--debug` read as a page of errors; `--debug` stays wired by install, the log file stays the surface `doctor --dump-logs` reads, and a hook, which serves no client, keeps writing its diagnostics to stderr as before [I>V]
  ->     structural
  serves: N2 N8
  touches: D118 D38
# the owner, 2026-10-08: "agree with debug log fix - it's cosmetic but reduces noise". The @D118 scenario leaned on the server's next diagnostic write meeting the dead stream; its step rewords under a sanctioned change on the fence to the server's next warning, which the binding provokes with a real malformed staged event; title and claim unchanged; built 2026-10-08: a file-only sink for a serving server (`enableDebug({ fileOnly })`, falling back to stderr once if the file cannot be made) and a `warn` door that writes stderr and copies the line to the log file, the serve path's stderr writes classified as 22 diagnostics to the file, 25 warnings and errors kept on stderr, and the migration 024 summary by whether it touched a row; both @D118 bindings rebound, the abandoned server's to a real malformed staged event and the startup one to the log file in the sandbox HOME; cold review 2026-10-08: rotation never unlinks a log whose writer is alive or which was written in the last five minutes, and `doctor --dump-logs` shows every live writer's log beside the three newest, so a turn's hooks no longer rotate the serving server's file away; `warn` copies at most 10 000 lines per process into the log and then one capped line, and the uncaught-exception and unhandled-rejection handlers warn once and stay silent while the shutdown runs; a logs directory that cannot be written is probed and falls back to stderr with the one notice; the abandoned-server binding stages two malformed events after the transport is up, since the first write after the peer leaves still lands and only the second meets EPIPE

D259 2026-10-09 [I>V] amends D175
  resp:  doctor's locked-store row claims no more about the holder than the platform can say: Linux names the write-lock holder through /proc/locks and the fix kills it alone, a bystander server left be; macOS (Darwin's lsof does not see fcntl locks) and Windows (no lock-holder API without native code) name every process holding that store's file open with its command, say the platform cannot tell which owns the lock, and the one fix command stops them all, a running server reopening the store on the next session; nobody is called "not the cause" where that cannot be known, and no Windows row names lsof [I>V]
  ->     structural
  serves: N25 N2 N9
  touches: D175 D179 D161
# the v0.1.0-beta.1 three-OS run, 2026-10-09: the last green matrix was rc.7, and the 31 commits since ran on Linux only. On macOS doctor listed the locker as "not the cause" and offered an lsof line as the fix; on Windows it offered that lsof line to a system without lsof. The scope is one store on every platform: the holder alone on Linux, the openers of that one file elsewhere, never every server on the machine. Road not taken: a native fcntl F_GETLK probe, which would name the holder on macOS too (Windows has no such API, so the Restart Manager list is its ceiling); it needs a compiled addon or prebuilt binaries, the install-failure class the no-compiler gate forbids, and the owner, 2026-10-09: "let's keep things simple unless someone files a bug report - there doesn't seem to be significant splash damage from this"; if it ever earns its place, an optional dependency that fails soft in any 0.1.x. Same run: six tests assumed Linux (a sh-dialect wrapper fixture, a CRLF-sensitive README slice, an unclosed handle Windows will not delete under, stop vs stop.cmd, the packet's clipped sender against a GUID hostname, a 30 s timeout the Windows runner's big-N scenarios exceed) and were rebound without a feature change
