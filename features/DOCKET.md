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
# the build, 2026-11-08, the final cross-unit review (MED-1), Claude Code's presence: install wrote its MCP launcher to `~/.claude/hooks/tc-mcp-serve` and detected Claude Code by the `~/.claude` directory alone, so on a machine without Claude Code (Codex CLI or agy only) the second install wired Claude Code (`~/.claude.json`, the hooks, the four allow rules, the skill) and doctor read it ok, and on a Cursor-only machine Cursor's entry turned to capture; a gap in this entry's "install wires only the agents that are present", closed as D383 closed it for Gemini CLI. Claude Code is present when `claude` is on PATH or one of its own artifacts is there: `~/.claude.json` holding a key other than treecontext's `mcpServers` entry (another server there counting as the developer's), or, in `~/.claude` or `CLAUDE_CONFIG_DIR`, `projects/` or `.credentials.json` (seen on a live Claude Code 2.1, read by name only), `statsig/` or `todos/` (made by earlier versions), or a `settings.json` holding a key treecontext did not write (its hooks block, its four allow rules, `idleCompaction`); a file that does not parse counts, treecontext writing only JSON. `~/.claude` itself, `hooks/` (tc-*) and `skills/` never count. A Claude Code entry or hooks block with neither is a phantom: doctor warns that an earlier install wired Claude Code, which is not present, naming the files and `treecontext uninstall --agent claude`; install leaves it. Cursor and VS Code read the Claude Code hooks block only where it is installed, so their capture rule follows: an uninstall that takes the block away converges their entries to no capture, as install would write them. The test worlds that mean Claude Code to be there lay out `projects/` (markClaudeCodeInstalled), and the machine's own `claude` is hidden from every sandboxed child, as `agy` and `gemini` are

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
# sketched from D146 and the visionary's "imagine 3/4 are new users"; weight confirmed at Phase 1½ (2026-10-29)

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
# the build, 2026-11-08, unit 5 (F2), a self's stop: a /clear stops the self of the session it continues (the predecessor the pid beacon names, D216) at the clear's moment, as it retires that session's subagents; a later resume registers it open again. A session that ends with no clear keeps no stop: that needs Claude Code's SessionEnd hook, which install does not wire, and is left for a ruling. No reader of the registry reads a self's stop today; no scenario's words reach it, so it is unit-tested in tests/hooks/session-start-chain.test.ts
# the build's 2026-11-08 F2 partial is withdrawn by the owner's ruling of 2026-11-09 (D396, "Adopt all (Recommended)", the consensus reading "defer SessionEnd to beta.5, and remove the /clear stopSelf writer now (no reader, no scenario)"): a /clear no longer stops the self of the session it continues, and a self registration's stop moment and the SessionEnd hook are on the fence until `0.1.0-beta.5` (D395, D396); the line above stays as the record of what was built, no longer the build's

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
# 2026-11-10, ruled by the owner ("add all three"): the clause "a supersession recorded as a reference stays one" is amended by D420. A supersession made under a stamp that was not exact is held, not recorded as a reference, and applied in the writer's lane when the call's echo names the writer; only a target that is truly another writer's stays a reference. The text above is left as ruled; D420 carries the rule in force

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
D260 2026-10-10 [I>V]
  resp:  captured tool output ranks like assistant prose: the default role weights of search are user `1.0`, curated note `1.0`, assistant `0.25` and tool `0.25`, so the developer's directives and the agent's curated notes outrank the tools' chatter as N4 promises; a weight below one never hides a row, a tool row matching only through its own words stays in the results, ranked below an equal match in a full-weight column, and `role_weights` still tunes every weight per query [I>V]
  why:   `0.25` is the assistant weight, the one value the two-corpus ledger ever measured; the mature-store bench arm of this cut may move it, and a moved value is a dated clarification here [I>V]
  ->     structural
  serves: N4 N1
  touches: D6 D183
# the owner, 2026-10-10, choosing the ruling over a bench-first order because no existing arm can measure a tool weight: LongMemEval-S has no tool rows, the web-agent arm stores its observations as assistant rows and disclaims role weighting in its own header, the code fixture is diagnostic. The code said it in its own words: "tool/note are untested and left at 1.0 as Phase-2 tunables". Three observations on two stores found the same defect: the owner's recency probe of 2026-09-28 (an insert's echo outranked the note it created; the orientation query returned echoes of its own earlier runs), the live smoke test of 2026-10-09, and a beta tester's agent the same day ("auto-captured tool output dominates the ranking, so an orientation query returns my own bash transcripts above the snapshot"). One day of the owner's store since beta.1 held 203 tool rows of 314 KB against 21 curated notes of 18 KB, at the same weight. A later re-ranker, the owner's decision-model experiment after the beta series, sits on top of these defaults as a fused second list under D18; nothing here is built in its way

D261 2026-10-10 [I>V]
  resp:  the store's own capture of a treecontext tool call, the echo D86 attributes by, is stored in full and keeps serving attribution and the writer heal, but enters the search index by its arguments alone: a query echo indexes its query text and parameters, an insert echo its tool name only, because the note is its own row, an export or status echo its tool name, every other treecontext tool's echo its arguments, except an import echo, whose argument is the handoff itself and which indexes its tool name and label; results and inserted content are never indexed twice; an additive migration re-indexes the echo rows a store already holds [I>V]
  ->     structural
  serves: N4 N1 N17
  touches: D86 D3
# the owner, 2026-10-10: nothing is indexed twice. On the owner's store since beta.1 every query, export and status echo indexed the 8000-character cap, a bag of every hit's preview that matched almost any later query, and each of 17 insert echoes carried its note's text again at tool weight. Capture is untouched: the echo is still the evidence D86 and the writer heal read, and a whole export still carries it. The index boundary is stamped on the row at capture, as the cap already is, so every binary that rebuilds an echo's index text computes the same text (the invariant of design/role-weighted-fts.feature) and the migration stamps the rows a store already holds; the demotion path must not shrink a stored echo below its full content. Simulated on a copy of the owner's store, 2026-10-10, for the handshake's orientation query: today the first curated row ranks 45th behind 18 treecontext echoes in the top 20; D260 alone lifts it to 12th, this ruling alone to 43rd, the two together to 3rd with no echo in the top 8, which is why the two ship in one chunk. Clarified 2026-10-10 at the cold feature review: an echo is demotable like any captured tool row, to its display preview and never below it, and a demotion never moves its index boundary; the drain stamps the boundary on any echo that arrives without one, and the import door does the same for an echo a handoff carries, so a hook copy that never learned the rule still obeys it; the hook writes an import's label on its own line ahead of the handoff so the boundary can reach it, and an import echo stored before the rule matches its tool name only. The query echo's reach is amended by D269

D262 2026-10-10 [I>V] amends D183
  trig:  a search matches both a chapter summary and a bookmark [I>V]
  resp:  the chapter summary outranks the bookmark, the way curated notes already outrank assistant prose, because a bookmark is low signal by construction; and the bookmark's rank factor is applied after the candidate pool is cut, a re-rank over the candidates search already chose, never inside the ordering that chooses them, so a bookmark is findable by its own words in a mature store, as D166 promises, while a chapter summary still outranks it among the candidates; the re-rank adjusts the candidates' lexical scores before recency fusion and the adaptive cut read them, joining the post-cut stage where fusion already reorders a fixed list, the seat a later re-ranker takes as a fused second list under D18 [I>V]
  sib:   none -- a bookmark crowding out a chapter is the ranking this prevents, not a behaviour
  serves: N4 N1 N23
  touches: D183 D158 D6 D18 D166 D241 D56 D44 D41
# the live smoke test of 2026-10-09 on the owner's store: 632 rows contain the word "bookmark" (status echoes, handshake text), the factor of 0.25 was multiplied into the score inside the SQL ordering before the cut, and the live bookmark was absent from the top 200 for its own first sentence. D166 and D183 both pass on the small fixtures their scenarios use; on the real store D183's mechanism defeated D166. The owner ruled this and D268 together as the two halves of one item. The owner, 2026-10-10: a decision-model re-ranker experiment follows the beta series and the orchestration platform's requirements, adoption unclear; the post-cut stage is where it would plug in, so Theme A builds nothing it would replace

D263 2026-10-10 [I>V] amends D238
  resp:  a subagent's summary is its SubagentStop payload's `last_assistant_message`, else the last assistant text of its own transcript, staged as an assistant row with kind `subagent-summary` and its writer, drained like any capture, session-scoped in its dedup; the registration is retired on the same connection after the capture; a row stamped as a subagent's, `_writer_src` `registry` or `hook`, is never the orchestrator's chapter, bookmark or newest checkpoint in the packet after a /clear or in the stop hook's interval, though it shares the session id; and a SubagentStop whose agent id no SubagentStart registered and whose payload carries no agent type is the client's own internal agent, the compaction summarizer or a side call, captured in full and searchable by its words but staged with kind `internal-summary` and writer `claude-code`, never `subagent-summary`, so it is no subagent summary for the summaries handoff form, the packet or the status panel's resume pointers, and nothing is filtered out; an additive migration re-marks the subagent summaries a store already holds that carry no agent type, the only mark left once a registration is retired [I>V]
  ->     structural
  serves: N21 N23 N5 N17 N1 N2
  touches: D238 D147 D169 D159 D156 D190 D230 D3 D170 D177
# the owner, 2026-10-10: a marking question, not a dropping one. The live probe of 2026-10-08 verified that a real subagent always gets its SubagentStart first; Claude Code also fires SubagentStop for agents nobody spawned, with an agent id but no agent type. On the owner's store since beta.1: 23 such rows, 19 of them under 100 characters (prompt-suggestion side calls), the largest an 11 KB compaction summary, against 2 registered subagents in the same day; the default handoff file was led by them. The compaction summary is genuine recall and stays findable. Measured again at the build, 2026-10-11, on a copy of the owner's store at v27: 23 subagent summaries in all, 21 untyped and 2 typed, 18 of the untyped under 100 characters and the largest 26,598 characters decoded (11 KB stored); the summaries form held 42 entries before and 21 after, the 19 chapters and the 2 typed; every content byte unchanged. Corrected at the chunk-4 review, 2026-10-11: a retired registration is not gone, retiring only stamps its stop time, so the migration spares any report whose agent id the registry holds, live or retired, and re-marks only the hook's own captures outside handoff lanes; a stop whose registry the hook cannot read is filed as a subagent's, never as internal, since a failed read is no evidence of an unregistered start

D264 2026-10-10 [I>V]
  resp:  the handshake keeps its second session-start step, the free-text orientation query, described as recovering the thread around the resume pointers the status panel found, within the card bound of D210, and the skill reference's search paragraph states the ranking order as it is: the developer's directives and curated notes first, assistant prose and captured tool output below them, treecontext's own echoes by their arguments alone; no new query parameter is added [I>V]
  ->     structural
  serves: N14 N25 N1
  touches: D174 D210 D260 D261
# the beta tester's agent, 2026-10-09, got its cold start from step one alone ("the prior session's snapshot gave me everything in one read") and its noise from step two; with D260 to D263 in force the second step answers from curated rows, and the text should say what ranks where rather than teach a workaround. The instructions text is a charter surface (journal-agent-surface.feature); the wording is the owner's review. The alternatives declined: an orientation parameter on the query tool, new surface overlapping what the defaults now deliver; dropping the step, which loses the sibling context a query finds around pointers nobody tagged

D265 2026-10-10 [I>V]
  resp:  a server whose build is older than the store's schema steps aside instead of spinning: each drain tick re-reads the store's schema version after taking the drain lease, and a store newer than the build's ceiling makes the server release its lease and its staging claims, write one warning and stop ticking, so the newer server takes the drain within one lease term by the self-heal path a crashed drainer already leaves; every tool call the stale server answers replies with one line, that the store was migrated by a newer treecontext and this session should be restarted, never a raw constraint error, because the server reads the store's schema version at each tool call, cached for a few seconds, so the reply never waits on a drain lease a newer server already holds; hooks keep staging and nothing is lost; doctor names a staging row whose attempts exceed the retry ceiling by far and the claimant that spun on it; and the README's upgrading section says to quit every running session before upgrading [I>V]
  ->     structural
  serves: N12 N2 N26
  tension: N26 -- the stale session is restarted by hand once, after the server has said so
  touches: D3 D256 D59
# the owner, 2026-10-08: "we should probably have a more graceful behavior for that finding in beta.2", ruled 2026-10-10. The finding: after migration 025 made the curated unique index partial, the still-running rc.7 server's insert failed on its conflict target, and because the dead-letter tombstone shares the failing path the @D3 rule kept the rows queued, correctly; the server retried 5 staging rows every 5 s for 2 h 20 min, about 1620 attempts each, until the beta.1 server drained them all on its first start. The gap was in noticing, not in the valve. Charter home: the mirror of the design scenario "a new hook binary degrades cleanly against a not-yet-migrated database", plus one doctor scenario; the @D3 scenarios stay as they are. Declined: the newer server refusing to migrate while a foreign drain holder is live, as a merge is refused on a held lease, because it blocks the upgrade on a session the developer may not be able to find, and the fence declines a no-upgrade-mid-sprint rule as an ops burden, so the remedy had to be mechanical. Read at the chunk-5 feature review, 2026-10-11: the drain releases its row claims at every tick's end, so the claimant doctor names is the drain lease's holder, the one persisted evidence of who spun; the ceiling's "by far" is ten times the retry ceiling; the fix line names the process to quit, as D51 requires a command; a tool error re-reads the version uncached so the cache window never lets a raw constraint error through. Measured at the chunk-5 code review, 2026-10-11, against the beta.1 build itself: a beta.1 server beside a beta.2-migrated store does not spin, since migrations 028 and 029 change data only; it keeps draining, and the echoes it drains land without the D261 boundary, so the beta.2 drain's sweep and the server's start heal any echo found without its boundary, by the same routine migration 028 runs; the README's quit-first line states that reason

D266 2026-10-10 [I>V]
  resp:  the fast follow `0.1.0-beta.2` is the recall cut, D260 to D265 and D268; D260 to D262 and D268 are verified on a mature-store bench arm built from a synthesized journal of captures and curated rows with gold labels, the first chunk, since no existing arm measures a tool weight, and on that fixture D166 and D183 each gain a scenario and the broad orientation query of the recall feature stays green with tool text at `0.25`; two small items ride along, the package's `bin` path without its leading `./` and the import tool's text saying a handoff is read-only by default; its release gates are an interactive Stop capture check on Linux for D249, the macOS live hooks of D251 only if a Mac is at hand and no gate otherwise, and a deliberate re-measure of the beacon rung with two sessions in one directory; the Codex and Gemini copies stay unverified scaffolding, said so; the hygiene backlog of the `2026-10-08` audit, its flagged bindings and self-sanction resights, the conformance entry, the design files no need cites and the per-store configuration door, waits for `0.1.0-beta.3`, and the audit re-runs against `0.1.0-beta.2` once it ships, its report replacing the `2026-10-08` report as that backlog [I>V]
  ->     boundary
  serves: N26 N25 N1
  touches: D259 D249 D251 D254 D197 D205 D253
# the owner, 2026-10-10, walking the candidate list item by item after the beta tester's first feedback. The estimate on the table: about six build chunks for the cut, two to three days at the week's cadence; the deferred backlog about the same again plus an audit pass, and its re-scope item of unknown size (D267). Measured since beta.1 on the owner's store: 17 of 20 curated rows carry a pid-sourced session stamp, so the exec-form hooks of D251 made the pid rung work on Linux where the probe of 2026-10-08 saw none; the two-session probe re-measures the ambiguity the probe of 2026-10-08 found

D267 2026-10-10 [I>V]
  resp:  the shape of N19, every touch of an entry recorded, and of N22, a group of subagents found as a group, is {TBD} until a scope session before `0.1.0-beta.3` rules each onto the fence or the schedule, ruling explicitly on the access log of D125 and D128 for N19 and on the group orientation of D168 for N22, which stays in effect and unbuilt under D209 until then, within the timing D191 gives the remainder of the attribution program; N18 is read as served by the writer stamps D190 and D169 rule and D197 shipped; nothing is built toward N19 or N22 until then [I>V]
  ->     fence-deferred
  spread: the shape a scope session gives a deferred need
  serves: N18 N19 N22
  touches: D254 D197 D125 D128 D168 D209 D191 D190 D169
# the audit of 2026-10-08 left N18, N19 and N22 uncovered and 8 design files cited by no need. N19 is the access-log design shelved as the drain product; N22 is a new feature; each kept would be two to four chunks, each declined is a fence line. Their size is unknown until ruled, which is why they follow beta.2 rather than ride in it

D268 2026-10-10 [I>V]
  resp:  a metadata filter's flat scalar keys, `kind`, `status`, `thread` and their like, narrow the candidates in the query itself before the cut, instead of sifting a bounded pool afterwards, so a filter on flat keys answers from the whole journal; a filter the query cannot carry, exclusion and media among them, sifts the pool as before [I>V]
  ->     structural
  serves: N4 N1
  touches: D2 D183 D262
# the live smoke test of 2026-10-09 on the owner's store: the metadata filter was a post-filter over a pool of at most max(5 × top_k, 200) rows, so a filter on kind bookmark returned nothing for any query. The @D2 recall scenario owns the filter today. The owner ruled it with the bookmark re-rank of D262 as the two halves of one item; it is its own entry because the bookmark ruling answers D183's trigger and this does not. A builder decides which keys count as flat and how a boolean or an absent key compares in the query against the strict equality the pool filter used

D269 2026-10-10 [I>V] amends D261
  resp:  the store's own capture of a treecontext tool call, the echo D86 attributes by, is stored in full and keeps serving attribution and the writer heal, but enters the search index by its arguments at most: a query, insert, export or status echo indexes its tool name alone, the query because its own text matches a repeat of the same query better than any note can and the insert because the note is its own row; a delete, merge or clear echo indexes what it was given; an import echo indexes its tool name and label, never the handoff it carried; results and inserted content are never indexed twice; an additive migration re-indexes the echo rows a store already holds [I>V]
  ->     structural
  serves: N4 N1 N17
  touches: D261 D86 D3 D260
# the owner, 2026-10-10, at the chunk-1 build, on the builder's measurement over the mature journal fixture (six sessions, nine days, 360 rows, 276 captured tool rows against 24 curated): with the query text indexed as D261 said, the orientation query's first five were the fresh plan and three echoes of earlier orientation queries, because the echo's index text was the query itself, seventeen tokens holding every term, and a column weight scales term frequency, not the final score, so at a quarter weight so short a document still outscored every note; with the tool name alone the first five are the fresh plan and four developer turns and no echo, under recency fusion and in pure BM25 alike. The coordinator's simulation on the owner's own store had placed those echoes ninth to twentieth, below richer notes; a rule that holds only where the notes are rich is the wrong rule. Lost: finding an earlier search by its own words; the echo is still stored, exported and shown whole. Dated correction, never an edit in place: D261's resp stands as committed

D270 2026-10-10 [I>V]
  resp:  a captured tool event's input and output are stored as text, a line a line and a tab a tab, when the client hands them over as an object or as content blocks: the hook writes every field of the object out, a text field as its lines after its name, a nested object as its fields under their path, any other field as its name and value, and a content block as its text verbatim, one block after another, rather than the JSON encoding that turned every line break into the two characters backslash and n, so the word that begins each line of a shell output, a file read or a grep result is findable by itself and nothing the client sent is dropped; a shielded pointer the server returned is recognized whatever shape the client wrapped it in; an event captured before this rule keeps its stored text, and its line-start words are found with the glued letter [I>V]
  ->     structural
  serves: N4 N1
  touches: D3 D4 D261
# found by the mature-journal arm, 2026-10-10, confirmed on the owner's store: the post-tool-use hook stringifies a non-string tool_response or tool_input, and unicode61 reads the backslash as a separator, so `\nabc` indexes as the token nabc and `\tmodified` as tmodified. Of 886 commit hashes in the fixture's git logs only the 60 on a first line were findable; the owner's store holds 246 rows with the token ntreecontext, 41 with ndescription. The owner chose to fix new captures and leave stored rows as they are: rewriting stored capture text is rewriting evidence, and a stamp cannot re-index a row with text that is not a prefix of its content. The echo heal and the session-namespace annotation read an echo's Output by key, which a content block's text written verbatim still carries; they are pinned end to end by journal-session-echo and journal-session-namespace, whose bindings stage a real echo through this hook. The composer named is the shared one the installed tc-* scripts run on every platform; the legacy Codex and Gemini wrappers keep their own stringify and stay the unverified scaffolding D266 says they are. The chunk-2 sweep that offered the owner a lower tool weight was measured on a journal captured under this defect; the owner held that ruling until the sweep is re-run on captures made under this one, with a slice that scores how matching shell rows order among themselves

D271 2026-10-10 [I>V]
  resp:  the bench's two detectors, the run-to-run comparison and the paired comparison, flag a nonzero change over a zero standard error instead of calling it noise, a zero change over a zero error stays within noise, and a slice that flags is reported as that slice's flag, never lifted into the aggregate; so a slice sitting at one hundred percent can flag a loss, and the bench still reports and never gates [I>V]
  ->     structural
  serves: N4 N1
  touches: D266 D106
# the chunk-2 cold review, 2026-10-10: `rank-collapse` moved the mature-journal checkpoint slice by fifty points and the detector printed "0.0 SE, within noise", because both sides had no variance; a capture regression that dropped every shell row would read the same. The owner: ride along in beta.2. Falsification expectations are re-measured after the change

D272 2026-10-10 [I>V] amends D260
  resp:  captured tool output ranks below assistant prose: the default role weights of search are user `1.0`, curated note `1.0`, assistant `0.25` and tool `0.1`, so the developer's directives and the agent's curated notes outrank the tools' chatter as N4 promises; a weight below one never hides a row, a tool row matching only through its own words stays in the results, ranked below an equal match in a full-weight column, and `role_weights` still tunes every weight per query [I>V]
  why:   `0.1` is the lowest weight at which matching shell rows keep their order among themselves on the mature-journal arm, the shell-ordering slice holding `53.06` percent from `1.0` down to `0.1` and collapsing to `8.33` percent at `0`, and it keeps a margin below the weights at which shell rows reached the orientation query's first page at the sweep's recency of `0.5`, six slots of thirty at `1.0`, one at `0.25`, none at `0.1`; against `0.25` the aggregate moves within noise at the sweep's recency, and at the served recency of `0.25` that D273 rules it beats `0.25` by `2.37` points with nine queries helped and none hurt; a bench arm may move the value again, and a moved value is a dated amendment [I>V]
  ->     structural
  serves: N4 N1
  touches: D260 D6 D183 D266 D270
# the owner, 2026-10-10, on the sweep re-run after D270 put real line breaks into the captures (bench/README.md, "The tool-weight sweep (D260, re-run under D270)"): the first sweep, measured on glued captures, had leaned toward `0`, and a cold review's probe showed every matching shell row tying at zero there; the owner held the ruling until the arm could price that cost with a shell-ordering slice built from indexed text, then chose `0.1`. Declined: `0.25` kept (one shell row on the orientation page at the sweep's recency); `0` (lookups elsewhere gain, shell-only searches come back unordered). D260 stands as committed

D273 2026-10-10 [I>V] amends D56
  resp:  recency fusion is the served default at the MCP surface at weight `0.25`, fused as a rank list, never a score formula; the library default stays zero, an explicit zero opts out, and the default is never applied to adaptive queries or non-relevance orderings [I>V]
  why:   at `0.5` the recency term outweighs about the first seventeen lexical ranks, so an exact lookup of an older note or turn lost to newer rows sharing its words; on the mature-journal arm `0.25` keeps the orientation query where `0.5` left it, the fresh plan first on the same three of six queries and no shell row on the page, while lookups rise from `49.95` to `63.02` percent overall, notes from `37.85` to `59.51`, developer turns from `26.67` to `47.28`, thirty-nine helped to one hurt; `0.1` lifts lookups further and starts to cost orientation, a bench arm may move it again [I>V]
  ->     structural
  serves: N4
  touches: D56 D6 D41 D44 D272
# the owner, 2026-10-10, on the recency sweep the chunk-2 arm priced for the first time (bench/README.md, "Recency sweep"): the beta tester's "finding your earlier message needed the user-role weight turned up" reads as this, not the weights. The aggregate reflects the arm's slice mix, six of ninety-seven queries asking for the newest thread, which the README says. Declined: `0.5` kept; `0.35`, half the step. D56 stands as committed

D274 2026-10-10 [V] ratifies D273
  resp:  the amendment of D56 stands in the visionary's own decision: the served recency weight is `0.25`, chosen from the sweep's three offers [V]
  ->     boundary
  serves: N4
  touches: D273 D56
# the owner, 2026-10-10, choosing "0.25" over "keep 0.5" and "0.35" with the recency sweep's per-slice table on the table (orientation unchanged, lookups 49.95 to 63.02 percent)

D275 2026-10-10 [I>V] amends D262
  trig:  a search matches both a chapter summary and a bookmark [I>V]
  resp:  the chapter summary outranks the bookmark on the page as served, the way curated notes already outrank assistant prose, because a bookmark is low signal by construction: after the candidates are chosen and recency fusion has ordered them, each live chapter summary that matches is placed above every bookmark that matches, a superseded chapter ranking as fusion left it, and the bookmark's score factor is retired, so a bookmark is findable by its own words in a mature store, as D166 promises, limited by nothing but those words; the post-cut stage where fusion reorders a fixed list stays the seat a later re-ranker takes as a fused second list under D18 [I>V]
  sib:   none -- a bookmark crowding out a chapter is the ranking this prevents, not a behaviour
  serves: N4 N1 N23
  touches: D262 D183 D158 D6 D18 D166 D241 D56 D273 D44 D41
# the cold feature review of chunk 3b, 2026-10-10: with the factor applied to the lexical scores before fusion, as D262 said, a bookmark written after its chapter takes the recency rank in a crowded pool and overtakes the chapter on the served page unless it sits eight lexical ranks lower, so D183's promise held in the lexical order only; the owner chose the page as served. A quarter factor had been the mechanism since D183 and had cost findability before the cut (D262's finding); placing the chapter above the bookmarks it shares a match with is the trigger's own words. Live chapters only, found at the build: placing superseded chapters too made the orientation page five checkpoints, four of them old plans above the newest bookmarks, which is the recency promise of D56 undone; a superseded chapter is history and stays searchable (D166), not prominent. D262 stands as committed

D276 2026-10-10 [I>V]
  trig:  doctor runs on a machine where the package is installed and no agent is wired [I>V]
  resp:  its first line after the header says treecontext is not set up for any agent yet and names the one command to run, `treecontext install`, and every warning row below it names that same command as its fix; the README's install section shows the two commands as one step, the package then the wiring, and says that doctor warns until the second has run [I>V]
  sib:   none -- a developer reading four right warnings as a failed install is the gap this closes, not a behaviour
  serves: N9 N25 N26
  touches: D51 D120 D59
# a second beta tester, 2026-10-10, Linux: ran the npm install the README's section 2 shows, ran doctor as it said, and wrote "it didn't install"; the wiring command sat in section 3 behind the upgrade subsection and a collapsed block, and doctor's four warning rows each ended in the right fix with no headline above them. The owner: both ride along in beta.2. Left to the backlog: the debug line a CLI command prints before its output, and the "?" doctor shows for a store too old to read without migrating

D277 2026-10-10 [I>V] amends D266
  resp:  the fast follow `0.1.0-beta.2` is the recall cut, D260 to D265 and D268, with the amendments ruled during its build; D260 to D262 and D268 are verified on a mature-store bench arm built from a synthesized journal of captures and curated rows with gold labels, the first chunk, since no existing arm measures a tool weight, and on that fixture D166 and D183 each gain a scenario and the broad orientation query of the recall feature stays green with tool text at `0.25`; two small items ride along, the package's `bin` path without its leading `./` and the import tool's text saying a handoff is read-only by default; its release gates are an interactive Stop capture check on Linux for D249, the macOS live hooks of D251 only if a Mac is at hand and no gate otherwise, and a deliberate re-measure of the beacon rung with two sessions in one directory; the Codex and Gemini copies stay unverified scaffolding, said so; the hygiene backlog of the `2026-10-08` audit, its flagged bindings and self-sanction resights, the conformance entry, the design files no need cites and the per-store configuration door, waits for `0.1.0-beta.3`, and that backlog opens from the `2026-10-08` report, the cold reviews of this cut and the docket lint, with no audit re-run [I>V]
  ->     boundary
  serves: N26 N25 N1
  touches: D266 D259 D249 D251 D254 D272
# the owner, 2026-10-10, trimming the cut's token spend: every chunk of this cut had a cold feature review and a cold code review on the surfaces it touched, their findings journaled, so a whole-corpus audit after the release would refresh counts the `2026-10-08` report already holds; the docket lint and gherkin-trace give the mechanical refresh cheaply. The remaining rulings build as two chunks, D263 with D264 and D265 with the rides-along, the cold feature review kept for D265. D266 stands as committed; the tool weight D272 rules is the one the fixture now serves. Gate measured 2026-10-11 on the `0.1.0-beta.2` tarball, headless Claude Code 2.1.296 in a throwaway home on Linux: two sessions started one second apart in one directory each inserted a note; both landed stamped with their own session, source pid, writer main confirmed by the echo, where the probe of 2026-10-08 had left both unstamped, so the beacon ambiguity is closed on Linux by D251

D278 2026-10-11 [I>V] amends D51
  resp:  the journal's database driver is Node's built-in `node:sqlite`, one driver and no native dependency: the package declares a Node floor of `>=24.16` and doctor's Node row holds it to that floor, read from the manifest, never a list of majors; doctor's database row names the SQLite version the running Node carries and that FTS5 is compiled in, both read by opening a database, never by comparing versions; install chooses an interpreter that meets the floor and runs this package, where D51 said one that loads the native binding; the library door `treecontext-mcp/persistence/node` is one opener that takes a file path or an existing `DatabaseSync`, the better-sqlite3 wrapper dropped, a breaking change accepted in beta; a dual driver and a Node 22 floor are declined to the fence; it lands as the first chunk of `0.1.0-beta.3`, soaked on the owner's machine before the tag [I>V]
  ->     structural
  serves: N9 N10 N1
  touches: D51 D4 D7 D59 D120 D266
# the owner, 2026-10-11 (journal node 380aeaba), on the research of the same day (node df97a2e2), measured on the live store under Node 24.20: the same SQLite 3.53.4 in both, every construct the schema uses working under `node:sqlite` (contentless FTS5 with the delete command and weighted bm25, trigram, json in triggers, the partial-index upsert of migration 025, RETURNING, VACUUM INTO, WAL), reads within ten percent either way, writes equal once synchronous is set (the driver's default FULL is twenty-five times slower per transaction; the adapter already sets NORMAL and the hooks FULL on purpose, so every raw opener must set it), a hook process cold-starting in 1.7 ms against 6.8 ms, and a production tree of three packages where better-sqlite3 13 shipped eight prebuilds, 17 MB of a 27 MB tarball, with the ABI-mismatch failure class doctor had rows for and a per-major prebuild chase in the installer; `@types/better-sqlite3` was a production dependency dragging `@types/node` into user installs and leaves with it. The owner had researched the switch before and chosen to wait for Node 22's deprecation; the floor is `24.16` because the 22 line's `node:sqlite` warns on every load, a stderr line per hook process and per server start that the reference client's debug log records as an error (D258), its API floor is 22.16, and a text read truncated at an embedded NUL on that line, fixed in 24.16 and never on 22; the owner declined `>=24` and `>=22.16` with the warning suppressed. Semantic deltas the adapter carries, found at the survey of 2026-10-15 (node 8090e9ad): rows have a null prototype, a BLOB reads as a `Uint8Array` the codec already accepts, an integer past 2^53 throws instead of rounding, errors are `ERR_SQLITE_ERROR` with an extended errcode whose low byte is the primary code, busy is primary code 5 or 6 (517 for a snapshot conflict), no `fileMustExist`, no transaction or pragma helpers, backup is the module's own async call, defensive mode is on and blocks nothing treecontext does, and URI filenames are honoured, so a read-only ATTACH is now possible: the identity A5 follow-up, not this chunk. A distro Node built against a system SQLite puts the version and the FTS5 flag out of our hands, which is why doctor's row reads them from the process and never from a table. Roads not taken: better-sqlite3 as an optional fallback for older Nodes (keeps the failure class and doubles the test surface for the one thing the switch removes); a version compare in place of the open probe (the compare is what D51's binding scenario was written against). Charter first, this entry and the scenarios it tags, then the adapter, then the tools, hooks, doctor, tests, bench and the two CI lanes


N27 2026-10-29 [I>V] orchestrating-developer 5
  need:  I need treecontext to serve agent orchestration as it is actually done, whether a Claude Code session runs a long task as bounded workflow legs or a main CLI that may be Claude Code, Codex or Antigravity spawns headless workers of any of the three, `claude -p`, `codex exec` or `agy -p`, each able to call any of the others, with or without an orchestration harness, a programming loop or an agent, that holds the run's loop and interacts with the treecontext library; every subagent, fresh or picking up a predecessor's work, starts from the same deterministic brief and checkpoint with no difference between the two cases, checkpoints on exit without ceremony, lands its trail and checkpoint in the shared store under the right parent and writer, loses no more than its last step when cut, and its work reaches whoever reviews it next, the main agent, the next subagent in a pipeline of roles, or the user through the main agent's summary, plainly marked as which subagent it came from; no leg pays for context it does not need; and the interfaces that make this work are generic enough that an orchestration method nobody has built yet can be adapted to them without reopening the design [I+V]
  means: the doors are whatever a client offers today, hooks where it has them, tools only where it does not, a ticket where it has neither; hooks and tool availability stay out of the vision because the vision survives their replacement [I>V]
# the root of the 2026-10-29 scoping interview (beta.3, subagent support); drafted from the proposal, its addendum and the owner's note of 2026-10-26, corrected by the visionary four times (the Workflow tool restored as a first population, the subagent-side clauses added, Codex and Antigravity restored by name, the escape hatch added, pipelines of subagent roles reviewing one another and the orchestration harness as a fifth actor added in Phase 1); actors ruled in Phase 1: the user in any of the three CLIs, the main agent, subagents with roles, an orchestration harness (loop or agent) on the library, other treecontext readers and writers, typically agents; the means line chosen from three offers

N28 2026-10-29 [I>V] harness 4
  need:  with no model in the loop, I need the harness to find by key alone the newest checkpoint of any leg of its run and that leg's return, to tell a live leg from a retired one, and to get an honest nothing rather than a guess when a leg wrote none [I>V]
# the harness actor's outcome, Phase 1; the visionary's words "it would have to be some flag/metadata tag, the deterministic start/stops should be identifiable without a big llm looking for them"; weight confirmed at Phase 1½ (2026-10-29); the orchestration platform's convergence measure kept apart for coverage (seed C)

N29 2026-10-29 [V] subagent 5
  need:  at my first moment, fresh or picking up a predecessor's work, I see my brief and the last checkpoint, no query needed [V]
# the subagent actor's start outcome, Phase 1, the visionary's own words; weight confirmed at Phase 1½ (2026-10-29); the orchestration platform's field report measured the mechanism on Claude Code (a checkpoint injected at SubagentStart steered the leg without a query); how a headless worker with no hooks gets the same first moment is a coverage question

D279 2026-10-29 [I>V]
  trig:  a subagent's leg ends, by finishing, by forgetting its checkpoint, or by being cut [I>V]
  resp:  the leg writes its own checkpoint; a leg that finishes without one is sent back once with the missing checkpoint named as the reason, on by default and never a second time, and never at all when the store cannot be written; a leg that is cut, so no finish was there to catch, leaves its trail, and the next leg of that role starts as a recovery leg that reads its predecessor's trail, writes the checkpoint its predecessor did not, and continues; the main agent never writes a leg's checkpoint and the store never synthesizes one; a leg that ended without a checkpoint is visibly so to whoever acts next [I>V]
  sib:   none -- a leg blocked a second time, or the store writing on a leg's behalf, is what this prevents, not a behaviour
  serves: N27 N28
  touches: D14 D215 D147 D157 D163 D175 D169
# the visionary, 2026-10-29, choosing option 1 of three with the send-back on by default where the proposal's Change C had it opt-in. Roads not taken: the main agent writes the checkpoint from the trail (costs the orchestrator the context the legs exist to keep out of it, and it saw no more of the work than a fresh leg); nobody writes it and the trail is the checkpoint (every resumed leg pays the orientation cost on every resume, not only after a cut). D175's "nothing blocks a turn" is the unavailability rule and holds here: the ask is skipped when the store cannot be written, as the main stop hook's ask is under D163

D280 2026-10-29 [I>V] amends D279
  trig:  a subagent's leg ends, by finishing, by forgetting its checkpoint, or by being cut; or a leg, the harness, or the main agent asks for the checkpoint to start from [I>V]
  resp:  a checkpoint is about a unit of work, named by its key, and the writer stamp says who wrote it: the two may differ, so a technical-writer, project-manager or reviewer role may checkpoint another role's work; the leg or its designated checkpointer writes the checkpoint; a leg that finishes with no checkpoint under its key newer than its start is sent back once with the missing checkpoint named, on by default, never a second time, and never when the store cannot be written; a cut leg leaves its trail and the next leg of that role starts as a recovery leg that reads the trail, writes the checkpoint, and continues; the main agent never writes a leg's checkpoint and the store never synthesizes one; the checkpoint to start from is the newest in effect under the key, where a later checkpoint, a reviewer's original-plus-review for one, names the one it supersedes, the lookup returns the one nothing has superseded, and two in effect under one key come back as two, never a silent pick; every checkpoint names what it supersedes and the entries it rests on, so the main agent, the subagent, or another subagent can walk from the checkpoint it started with back to the original and the trail when what it has is not clear, while the default answers without a walk in the ordinary case [I>V]
  sib:   none -- a silent pick between two checkpoints, or a leg blocked twice, is what this prevents, not a behaviour
  serves: N27 N28 N29
  touches: D279 D14 D215 D147 D157 D163 D175 D169 D227
# the visionary, 2026-10-29: the original subagent may not be the checkpointer (a technical writer or project manager role), a reviewer may take a checkpoint and write original-plus-review, so more than one may sit under a key; option 1 of three chosen with two additions in the visionary's words, traceability "where the main agent, the subagent, or a different subagent can figure out what's going on if the checkpoint they start with is not clear" and "a deterministic easy-button default that works 99.9% of the time, the gist of it". Roads not taken: newest by time wins silently (a late original or an early review hands the next leg the wrong one with no sign); only the work's own role may checkpoint, a reviewer writes a review that references it (rules out the roles just named). The supersession trace and the one-hop reverse references of D227 are the walk's existing footing

D281 2026-10-29 [I>V]
  trig:  a leg is briefed whose checkpoint is written by a role other than itself, or a leg starts from a checkpoint another role wrote [I>V]
  resp:  the brief carries the key and names the checkpointer: who checkpointed the work it resumes, and who will checkpoint it at the end; a leg whose brief names another role as the one who will checkpoint its key is never sent back for a checkpoint, and the harness that mints a ticket puts the same two facts in it; no setting lists checkpointers [I>V]
  sib:   none -- a worker sent back for a checkpoint its project manager owns is what this prevents, not a behaviour
  serves: N27 N29
  touches: D280 D236 D150 D167
# the visionary, 2026-10-29, choosing option 1 of three and adding the two tenses: "who checkpointed (if resuming) or will checkpoint (at the end)". Roads not taken: a per-role setting in the project's configuration (goes stale when a pipeline changes shape between runs); the ask always fires and the worker answers with a one-line pointer (a turn on every such leg, the ceremony D279 ruled out)

N30 2026-10-29 [I>V] main-agent 4
  need:  a leg's result reaches me from the store, marked as which subagent wrote it, and I never carry the leg's working state in my own context [I>V]
  means: I am handed a pointer to the summary row and go to the store for it [V]
# the main agent actor's outcome, Phase 1, the visionary's words "it goes to the store, handed a pointer to the summary row", laddered at Phase 1½ (the pointer is the means; the need survives its swap); weight confirmed at Phase 1½; the proposal had the structured return as the primary carrier with the journal as the durable copy, which still holds for the harness's replay (N28), while the main agent's channel is the pointer

N31 2026-10-29 [I+V] user 2
  need:  during a run I hear from the main agent as usual and errors reach the main agent or the harness as facts they act on; after a run, anyone with access to the store file, a human, a program or an agent, can reconstruct the sequence of a run's events with plain SQL, since it is a simple SQL database, though I would typically ask the agent to do it [I+V]
# the user actor's outcome, Phase 1; the interviewer's draft had a human reconstructing a run as a product door, the visionary narrowed it: "only in the sense that if a human or program or agent wanted to write sql queries they could reconstruct the sequence of events"; weight confirmed at Phase 1½ (2026-10-29); rests on the library-first stance (any program that opens the file gets the same journal)

N32 2026-10-29 [V] orchestrating-developer 4
  need:  another reader or writer's rows never appear as a leg's checkpoint and lanes stay separate; since there is no way to enforce that, sufficient metadata is recorded on every row that a writer who accidentally or deliberately poisoned a checkpoint can be determined [V]
# the other-readers-and-writers actor's outcome, Phase 1, the visionary's words; weight confirmed at Phase 1½ (2026-10-29); rests on D169 (any writer may append into any lane so long as the row names its writer) and N17 (attribution earned, never guessed): the store-written writer stamp is the evidence; which metadata a checkpoint row must carry is Phase 2/3 material

D282 2026-10-29 [I>V]
  resp:  the `beta.3` subagent work lands in three new feature files, legs (the leg contract: brief and checkpoint at start, checkpoint on exit and the send-back-once, the designated checkpointer, the recovery leg, which checkpoint wins, the harness's key lookup), workers (the ticket door: a headless worker on any CLI registered under a parent of any CLI, its rows in its own lane with the right writer, retired on exit with its return as the summary, what a `claude -p` child is) and runs (a run as a unit: its legs in order, reconstructable by SQL, exportable, a poisoned checkpoint's writer determinable, phantoms retired); the rest lands as scenarios in the files that already own the surface, the subagent's orientation lines in the agent-surface and reorientation files, the dispatch skill and the Codex installer fixes in the install and clients files, the journal defects in storage and reorientation; names provisional until drafting [I>V]
  ->     boundary
  serves: N27
  touches: D147 D150 D169
# the visionary, 2026-10-29, choosing option 1 of three: "this also gets around file size limits that are in place". Checked: the suite holds no feature-file size rule (grep of tests, scripts and the corpus, 2026-10-29; the largest file today is journal-storage at 20 KB), so the limit meant is the reading agent's, a file past its read window costs chunked reads; recorded as the reason, not as a suite rule. Roads not taken: one new journal-subagents file holding everything (largest in the corpus, three actors' outcomes mixed, the review order by weight lost inside it); extending journal-orchestration with no new file (triples in size, its title no longer names its content)

D283 2026-10-29 [I]
  pre:   treecontext always remains as close as possible a faithful journal of the session, with sufficient metadata to understand who contributed to the journal and to recreate the timeline [V]
  trig:  a ruling of this program would have the store synthesize, rewrite or drop a row's writer or moment, would let a checkpoint lookup return something the journal does not hold, or would let a leg's rows enter the store without the writer and moment the rest of the journal carries [I]
  resp:  the assumption stands as the ground every ruling of this interview rests on and is reopened by its trigger; it restates the charter's own stance, capture judged by whether a future agent would find the moment, honest timestamps, attribution earned, not a new promise [I>V]
  ->     fence-assumption
  serves: N27 N32
  touches: D8 D169 D175 D215
# the Phase 1 boundary question, 2026-10-29, the visionary's one answer: "my most major assumption is that treecontext will always remain as close as possible a faithful journal of the session, with sufficient metadata to understand who contributed to the journal and to recreate the timeline"; the reopening condition is the interviewer's draft, unratified until the visionary says so

D284 2026-10-29 [I>V]
  trig:  a leg of a role starts with a brief that names its key and the checkpointer, and a checkpoint of that key is in effect [I>V]
  resp:  at its first moment the leg sees the brief and the checkpoint in effect and has made no query; the checkpoints under a key carry a number that increases, the checkpoint the leg writes at the end is the next number and supersedes the one it started from; the leg's stop is not blocked and the main agent is handed a pointer to the leg's summary row, whose writer is the leg's role and which carries the run and the key [I>V]
  sib:   none -- a leg that opens with a query for its own brief, or a checkpoint that does not say which one it replaces, is what this prevents, not a behaviour
  serves: N29 N30
  touches: D280 D281 D279 D227
# Phase 2, 2026-10-29, the legs file's primary path walked aloud with concrete values (run `migrate-7`, key `chapter-3`, role `writer`, checkpoint 3 then 4); the visionary: "yes, that reads right". Three values were the interviewer's and were ratified by that yes: the increasing number under a key (a reading aid over D280's supersession, the number walks the same chain), the brief as the carrier of key and checkpointer (D281 restated), the run and key on the summary row (what lets N31's plain SQL reconstruct a run)

D285 2026-10-29 [I>V]
  trig:  a leg finishes under a main agent that does not want its summary [I>V]
  resp:  the pointer to the summary row comes back every time, one line; a main agent that does not want it spawns the next leg with the key and never follows the pointer; there is nothing to opt out of and no leg-start setting that withholds the return [I>V]
  sib:   none -- a main agent reading a summary it did not want is a cost of one line, not a behaviour
  serves: N30 N27
  touches: D284 D279
# the visionary, 2026-10-29, raising it: "what if the main agent does not want a summary - i suppose they would just spin off a new subagent without the baggage?"; option 1 of four chosen. Roads not taken: the brief names who consumes the summary and the pointer goes there (a second routing fact in every brief for a line the main agent can ignore); a harness owns the run and the main agent hears only its end (that is a harness's shape, not a ruling the main agent needs); a leg started with no return at all (the main agent learns the leg ended only by asking the store, D279's visibly-ended lost)
D286 2026-10-30 [I>V] amends D35
  trig:  a session starts after a compaction and the drain runs the recovery queries the pre-compact snapshot recorded; or a store an earlier release left with recovery snapshot rows is opened [I>V]
  resp:  the recovery snapshot row is machine output quoting the journal, bounded like a tool event: it quotes each hit at the hit's display view and no further than the quote cap, names the entry it quotes, never quotes another recovery snapshot, keeps the recovery queries in its metadata and out of its indexed words, and carries its own display and index boundaries, so a hit on it is a bounded preview with the availability marker and its reach into the index is the tool default; on first open this build stamps the same boundaries on every recovery snapshot row a store already holds, content untouched; the pre-compact snapshot and the session-start claim stay with ccr's compaction interaction, but what the drain writes to the store is in the charter from here [I>V]
  sib:   none -- a row the store writes about itself growing without a boundary is what this prevents, not a behaviour
  serves: N1 N4 N23
  touches: D35 D4 D47 D261 D272 D3
# the owner, 2026-10-30: "we need a hotfix", for 0.1.0-beta.2.1. The specimen: from beta.1 (703db72) through beta.2 (915cb01) the row quoted every hit whole under no boundary, in the note column, holding the literal query text, so at the next compaction it was the best match for its own queries and quoted itself; rows compounded geometrically per compaction (93,751 / 370,389 / 1,426,928 / 5,495,219 / 21,146,347 chars on one store, 2026-10-27 to 10-29; 3,593,992 on the owner's own, six generations) until one treecontext_query reply crossed Claude Code's 16 MB stdio message guard and the client dropped the server, twice on 2026-10-29. D35 had fenced the compaction lifecycle as "working mechanics, unspecced by this suite" while the mechanics wrote rows on every compaction: a fence may decline a promise, never a writer. D47's whole-text promise reaches the developer's words and the agent's notes, not a row the store synthesizes about itself. Roads not taken: dropping recovery snapshot rows from search altogether (they are the only record of what a compaction found, and D3 keeps every capture); storing the recovery row as an auto-capture tool event (changes its dedup class and session lane, more than a hotfix carries); shrinking the existing rows' content (retention never destroys, and export still returns their words). Findings 5a88c480 and 7764251a of 2026-10-27 named the mechanism and were parked as "no ruling needed"; the triage rule the owner drew: a finding about anything that grows without bound is a blocker on the day it is found

D287 2026-10-30 [I>V]
  trig:  a treecontext_query reply, serialized, would exceed the reply ceiling; or a treecontext_export of one entry would [I>V]
  resp:  the reply ceiling is a quarter of the client's `16 MB` stdio message guard; a query reply over it has its entries' contents cut, hits and window entries alike, at a cap that shrinks until the reply fits, each cut entry ending in a marker that says so and names the export door, the reply disclosing the ceiling, the cut and how many entries it touched; an export of one entry over the ceiling is refused with the entry's id and both sizes, never cut, because export promises the whole entry; the bounded preview stays the first defence and this is the last, for any producer the preview rule has not reached [I>V]
  sib:   none -- a reply that ends the connection is what this prevents, not a behaviour
  serves: N1 N4
  touches: D4 D286 D47
# the owner, 2026-10-30, with D286: the preview rule failed for one producer and the connection died; a ceiling under the guard means the next unreached producer costs a cut, not the session. A quarter of the guard sits far above any reply the preview bound produces (twenty hits with ten-entry windows at the 8000-char tool view is under 4 MB) and far below the point where the connection dies. Roads not taken: shielding (off by default, and a 30 MB file pointer is still a 30 MB read); failing the query outright (the agent loses the page for one oversized entry); cutting exports (an export that lies about being whole is worse than one refused)

D288 2026-10-30 [I>V]
  trig:  a headless worker on one CLI starts under a parent session on another, with a ticket in its environment that names its run, key, role and checkpointer, and exits [I>V]
  resp:  the worker is registered under the parent the ticket names, whatever CLI the parent runs; every row it writes sits in the worker's own lane, each stamped with the worker's role as writer and with the parent session, none of them in the parent's lane; the worker is retired at exit and its last output is the summary row the pointer names [I>V]
  sib:   none -- a worker's rows landing in the parent's lane under the parent's writer is what this prevents, not a behaviour
  serves: N27 N32 N30
  touches: D281 D169 D190 D284 D167
# Phase 2, 2026-10-30, the workers file's primary path walked aloud with concrete values (Codex parent `S1`, ticket for role `reviewer` on run `migrate-7` key `chapter-3` naming `writer` as the one who checkpointed and `reviewer` as the one who will, `claude -p` writes three notes and checkpoint 5, exits); first put 2026-10-29 (journal 96c45de4), unanswered when the beta.2.1 hotfix interrupted the session, re-put verbatim and ratified: "yes". Three values were the interviewer's and were ratified by that yes: the ticket travels in the process's environment (the proposal's R1, declared not discovered), the worker's lane is its own with the parent recorded on each row rather than the rows entering the parent's lane (D169's lane model applied to a process no hook registered), the worker's last output is what becomes the summary row (the lifecycle the ticket door gets free, proposal §9.5)
# the owner, 2026-11-09, choosing "Adopt all (Recommended)" ("Q7 move the agy case to the D294 outline"); the consensus adopted (journal d3cd859e, f2fcb0e4): "remove the Antigravity row from the D288 outline, citing the D383 fence; turn the D294 declared-parent scenario into an outline with Codex and Antigravity mains spawning through treecontext run." The outline "a <worker> worker under a <parent> parent writes into its own lane with its role as writer" loses its Antigravity row, unbound since the beta.3 build and held open in the wip register by the outline's title: an Antigravity CLI main registers no self and spawns no registered worker but through `treecontext run` (the fence's Antigravity CLI entry, D370 amended by D383), so no parent of it is ever registered; its case is D294's declared parent

D289 2026-10-30 [I>V]
  trig:  a run's legs have exited and the harness asks, with no model in the loop, for the newest checkpoint of a key on that run; or anyone with the store file reads the run back [I>V]
  resp:  the harness asks by run and key together and receives the one checkpoint in effect under that key, with its writer, and each leg of the run reads as retired or live; the run's rows read back in the order of each row's own moment of capture, never the drain's order, every row naming its writer and its moment, every leg naming its run, its key and its parent session, so each captured row reaches the run and key through its leg's lane rather than carrying them itself, and no row of another run reads back among them [I>V]
  serves: N28 N31 N32
  touches: D280 D284 D288 D8 D169 D190
# Phase 2, 2026-10-30, the runs file's primary path walked aloud with concrete values (run `migrate-7`, key `chapter-3`, the `writer` leg from checkpoint 3 to 4, the headless `reviewer` leg under Codex `S1` writing 5 over 4; the harness gets 5 alone, the person's SQL gets writer trail, 4, reviewer trail, 5); the visionary: "yes". Three values were the interviewer's and were ratified by that yes: run and key together as the harness's lookup (a key alone may recur across runs); the row's own moment as the order (D8's honest timestamp applied to a run); run and key on the leg's registration with every captured row reaching them through its lane (writing them on every captured row would stamp hook captures with facts the hook does not hold)

D290 2026-10-30 [I>V] amends D35
  trig:  treecontext install wires Claude Code on a machine whose client settings carry no idle-compaction key; or doctor runs where the key is set to on [I>V]
  resp:  install turns Claude Code's idle compaction off by writing the key when it is absent, says so in its output with the reason in one line and where to turn it back on (the client's /config row), and never writes the key when the user has set it, on or off; doctor reports the setting on its own row, a warning while it is on that says treecontext recommends off and gives the /config row first and the settings line second; the README's install section says the same; the compaction interaction itself, when and why the client compacts, stays with ccr [I>V]
  sib:   none -- install flipping a setting the user chose, or fighting it on every reinstall, is what this prevents, not a behaviour
  serves: N1 N23
  touches: D35 D286 D51 D276 D208 D161
# the visionary, 2026-10-30, reframing the interviewer's four-door question ("which door reports it") into "how far install goes", with the reasons: (a) the client's summary replaces the checkpoint-then-/clear boundary and the journal as the session's recall source; (b) asked for a case where a treecontext user wants it on, the interviewer could name only a developer who leaves a 300K session idle without checkpointing and prefers a summary to one uncached re-read, a cost preference held by someone not following the protocol, and the setting only fires on subscription sessions so API-key users never see it; (c) /config's Idle compaction row is the fix most users prefer over editing JSON, so it is named first; (d) option 1 of three chosen. Roads not taken: install recommends and asks once interactively (every forced reinstall asks again unless the answer is remembered, and a no leaves a warning row forever); doctor row and README only, install writes nothing (a user who skips the note and never runs doctor meets it as a compaction packet they did not ask for). Verified before recording: install writes hooks and the MCP registration into the client's settings and no preference key today (src/server/installer.ts, no idleCompaction); the fence's compaction entry keeps the interaction with ccr (features/OUT-OF-SCOPE.md L98-115), amended here for the one key install now writes; idleCompaction honored by Claude Code from 2.1.290 and the /config row from 2.1.302 (journal fbc71fa1, from the settings reference). Open for coverage: an older client given the key, and the seed's "idle compaction fires PreCompact/PostCompact with trigger auto" for a session whose user turned it back on

D291 2026-10-30 [I>V]
  trig:  a ticketed headless worker on a CLI where no hook fires at exit finishes with no checkpoint under its key newer than its start, and the ticket names the worker as its checkpointer [I>V]
  resp:  whatever spawned the worker through the ticket door, the library call or the `treecontext run` wrapper, sees the missing checkpoint at exit and runs the worker once more with the missing checkpoint named as the reason, under the rules of D279, once, on by default, never a second time, never when the store cannot be written; the second run is a fresh process that reads its own trail from the store to write the checkpoint; a worker that claimed a ticket with no wrapper gets no send-back, is retired as having ended without a checkpoint, visibly so to the harness's lookup, and the next leg of its role starts as a recovery leg [I>V]
  sib:   none -- a hook-less worker sent back twice, or a wrapper writing the checkpoint for it, is what this prevents, not a behaviour
  serves: N27 N28
  touches: D279 D280 D281 D288
# Phase 3, 2026-10-30, the first coverage question, from the workers path and D279; provenance named: the platform field report verified on 2.1.300 that Claude Code's hooks fire inside a headless `claude -p` (docs/orchestration-platform-field-report-2026-10-15.md L33), so D279's send-back reaches that worker, while `codex exec` and `agy -p` have no hook at exit. Option 1 of three chosen. Roads not taken: no send-back off the hooks door, the worker visibly ended and the next leg a recovery leg (a pipeline with no second leg of that role never gets its checkpoint; the gap is visible and nothing closes it); the ticket names the harness as checkpointer and the harness passes the checkpoint text at retire under its own writer stamp (a harness has no model, so its checkpoint is the worker's stdout relabelled). The stressing case shown and accepted: the re-run is D279's recovery leg in all but name

D292 2026-10-30 [I>V]
  trig:  a ticketed headless worker ends by a signal or a kill, the harness's timeout among them, before any checkpoint under its key [I>V]
  resp:  an exit by signal is a cut: the worker is retired as cut with every row it wrote in its lane, no summary row and no send-back, the harness's lookup returns the checkpoint still in effect with the leg shown as cut, and the next leg of that role starts as a recovery leg; only a worker that exited on its own, whatever its exit code, gets the one send-back of D291 [I>V]
  sib:   none -- a harness's timeout paid twice for a worker that was never going to finish is what this prevents, not a behaviour
  serves: N27 N28
  touches: D279 D291 D288
# Phase 3, 2026-10-30, from the workers path and D279's "cut"; option 1 of three chosen. Roads not taken: every exit without a checkpoint is sent back once, signal or not (the timeout is paid twice); the spawner says cut or finished at retire and the wrapper falls back to the signal rule (a harness that never says `cut` lands on the double timeout). The stressing case shown and accepted: a worker that exits 1 on its own error counts as finished and is sent back once, a worker the harness killed is not
# the build, 2026-11-08, unit 5, the cut's last signal: after the leader of a cut worker is reaped, the door sends SIGKILL to its group by number only when no process holds that number (`reapedGroupIsOurs`, ticket-door.ts). The OS gives out no number still used as a live group's id, so while a survivor lives the number is the group's; a process holding the number once the leader is reaped is a stranger that reused it after the whole group was gone, and nothing is signalled. Not a promise of D292's words, which bind the cut at journal-workers; unit-tested in tests/ticket-door.test.ts with a survivor that ignores SIGTERM, killed when the number is free and left alone when the probe says a process holds it
# the build, 2026-11-08, unit 5 fixes, a run the door signalled is a cut: the door records that it signalled a run (its timeout or the spawner's abort), and `sendBackDecision` reads that as a cut whatever the exit code, so a worker that traps the SIGTERM and exits with a code of its own (143, say) is retired cut with no summary row, no send-back and a recovery leg next, as an exit by signal is. Not reached by a @D292 scenario's words (its worker is killed by the signal); bound in tests/ticket-door.test.ts with a real worker that traps the signal, the decision table beside it, and the same exit code on its own, never signalled, still finished and sent back

D293 2026-10-30 [I>V]
  resp:  when an agent, harness or process the store has never registered writes into it, through any door, a ticket it minted for itself included, the store refuses nothing and checks no identity, since it has no access control and gains none here; the control is the trace: every row such a writer leaves says when it was written, where (directory, worktree, branch as the door could read them), how (which door wrote it and whether the identity it carries was registered by a hook or declared by the writer), who (the writer stamp the store wrote and the parent as declared) and what; anyone reading the store can then judge the rows' validity or filter them out, and treecontext never judges for them [V]
  ->     structural
  serves: N32 N17 N31
  touches: D169 D283 D190 D167 D288
# the visionary, 2026-10-30, reframing the interviewer's unknown-parent question ("what does the store hold for a Codex parent it never registered": a registry row minted with the ticket, a name on the worker, or a refusal until the parent registers itself) into the principle under it: "we have no security for sqlite store in tc and it's too much. i think traceability so that if an unregistered agent/harness writes something - anyone else access the treecontext store can see when/where/how/who/what was written. they can then decide the validity of the information or to filter it out." D169's "any writer may append so long as the row names its writer" and N32's "the poisoner determinable by metadata" restated as the door rule for identities no hook vouched for; the abandoned axis and its option of refusing a ticket for an unregistered parent go to Roads not taken (a one-line harness grows a registration step, a script that forgets it spawns nothing, and the store would be pretending to a security it does not have)

D294 2026-10-31 [I>V]
  trig:  a ticket names a parent session no hook registered, a Codex or Antigravity main for one, and a worker is registered under it [I>V]
  resp:  the store writes no row for a session that never spoke to it; each worker's registration carries what its own ticket declared about the parent, its id, CLI, directory, worktree and branch, marked declared, with the moment the ticket was minted; a parent a hook did register is linked by its id, never copied; a reader may group workers by the parent they declared, a view computed when read and never a stored row, and two tickets that describe one parent differently stay two descriptions, which the store never reconciles [I>V]
  sib:   none -- a parent row minted from a claim, with first-wins reconciliation of what later tickets say, is what this prevents, not a behaviour
  serves: N32 N31 N28
  touches: D293 D283 D288 D190 D169
# Phase 3, 2026-10-31, the question derived from D293's reframe (where the trace for a declared, never-registered parent lives); the visionary asked for the interviewer's view ("i don't know, what do you think the best behavior"), option 1 of three recommended with reasons and ratified: "yes, that reads right". Roads not taken: a declared-parent registry row written by the ticket door, reused by later tickets (the store would write a session it never saw, and two unrelated mains declaring one id share a row whose directory is the first one's); both the row and the per-worker copy (the disagreement is visible but the invented row remains). The stressing case shown and accepted: a parent that ran four workers has its directory written four times and the reader reconciles them, four witnesses rather than one record
# the owner, 2026-11-09, choosing "Adopt all (Recommended)" ("Q7 move the agy case to the D294 outline"): the scenario "a parent no hook registered is carried on each worker's registration as declared, never as a row of its own" becomes the outline "a parent no hook registered, a <main> main, is carried on each worker's registration as declared, never as a row of its own", with Codex CLI and Antigravity CLI mains each starting two workers through the `treecontext run` wrapper with `--parent` and `--parent-cli`, the path the wrapper already takes (`run-command.ts`); the old scenario registered its workers through the library with a Codex-shaped ticket, so no main declared through the wrapper, and no Antigravity CLI main at all, was bound
# the build, 2026-11-09, unit 7b: both rows bind through the real `treecontext run` wrapper with `--parent c7 --parent-cli codex|agy`, run from a real repository's main checkout on "main" and its linked worktree on "login", both resolved to the one store; each registration's declared parent is read with SQL against the ticket the worker carried in its environment and against the checkout it ran from (directory, worktree `null` and `login-wt`, branch), its mint moment the ticket's

D295 2026-10-31 [I>V]
  trig:  a `claude -p` worker starts with a ticket in its environment and the client's own session-start hook fires for it [I>V]
  resp:  the ticket wins: the hook reads it and registers the child as a worker, its role, parent, run and key from the ticket, marked as the ticket door read by the hook; the child is not a main self, writes no beacon, opens on the brief and the checkpoint in effect rather than a self's packet, and its rows carry the role as writer and the parent as declared; the send-back for a missing checkpoint runs once per leg across both doors, whichever sees the exit first, never twice [I>V]
  sib:   none -- a worker re-run by the hook and again by the wrapper for the one missing checkpoint is what this prevents, not a behaviour
  serves: N29 N27 N32
  touches: D288 D291 D294 D190 D167 D216
# Phase 3, 2026-10-31, the proposal's R4; verified before asking: the session-start hook reads no identity from its environment today (src/hooks/shared.ts reads TREECONTEXT_DEBUG only) and registers every session as a self from its session id and git facts (src/persistence/session-registry.ts registerSelf). Option 1 of three chosen. Roads not taken: both identities with the ticket's on top, a session that is also a worker (the child's packet opens with the checkout's thread before the brief, N29's first moment spent twice); the hook wins and the ticket serves hook-less CLIs only (a Codex main spawning `claude -p` workers gets unparented Claude sessions in the main lane, and N32's poisoner reads as "main"). The stressing case shown and accepted: the once-per-leg send-back must hold across the hook and the wrapper

D296 2026-10-31 [I>V]
  trig:  the harness or a leg asks for the checkpoint in effect under a key, and the newest in effect was written by a writer other than the checkpointer the leg's brief or ticket named [I>V]
  resp:  the lookup returns that checkpoint as the one in effect, its writer visible as on every row, and says in the same reply that its writer is not the checkpointer the brief or ticket named; nothing is withheld, re-ranked or judged, the harness or the next leg decides [I>V]
  sib:   none -- a lookup that silently hands the next leg a stranger's checkpoint, or one that quietly drops a legitimate unnamed checkpointer's work, is what this prevents, not a behaviour
  serves: N32 N28
  touches: D280 D281 D293 D289
# Phase 3, 2026-10-31, from the runs path and N32; option 1 of three chosen. Roads not taken: only a named checkpointer's rows count toward "in effect", the stranger's listed apart (amends D280, and a legitimate technical-writer leg that checkpointed without being named in the brief waits in the apart list too); pure D293 with no flag, the writer on the row and nothing more (N28's harness has no model and no brief in hand, so it resumes from the poison with nothing in the reply that said so). The stressing case shown and accepted: a harness script that reads "in effect" alone and never the flag resumes from the poison

D297 2026-10-31 [I>V]
  trig:  a worker's process is gone and nothing retired it, its spawner having crashed or never called retire [I>V]
  resp:  every worker registration records its process id and host; whoever next reads the registry on that host, a lookup, a status call or a hook, checks the process and retires a gone one then, as a phantom, with the moment it was noticed and by whom, never with a guessed exit time, no checkpoint and no summary row; a worker registered on another host is left live and the reply says it cannot be checked from here [I>V]
  sib:   none -- a phantom retired with an invented exit time, or a live worker on another host retired by this one, is what this prevents, not a behaviour
  serves: N28 N27 N32
  touches: D288 D292 D289 D190 D8
# Phase 3, 2026-10-31, from D282's "phantoms retired" and N28's live-or-retired; verified before asking: the registry has no process-liveness check today and the one retirement rule is F3, a session's own start or /clear retiring every subagent left live under its id (src/hooks/session-start.ts L121-131), a moment a hook-less parent never has. Option 1 of three chosen. Roads not taken: F3 extended to workers, retired at the parent's next start or next ticket (a parent that never returns leaves the phantom live forever; two unrelated mains declaring one id retire each other's workers); never retired on its own, the registration age and the last row's age shown and a command to retire by hand (every model-less harness picks its own silence threshold). The stressing cases shown and accepted: a reused pid keeps the phantom live until that process also exits; a worker on another host is never retired from this one

D298 2026-10-31 [I>V]
  trig:  a ticketed worker starts, on a CLI with no hook to inject anything or as a `claude -p` child [I>V]
  resp:  the ticket door composes the worker's first message as the brief, then the checkpoint in effect under its key with its number, writer and moment, then the spawner's own prompt, so the worker's first moment is its prompt and no query is made; the door writes that first moment as the first row of the worker's lane, the spawner's prompt text with references to the brief row and the checkpoint row it was composed from, never copies of them, so what the worker saw is reconstructable from the store alone with plain SQL and no file in the path; the hook-less door and the `claude -p` door leave the same row [I>V]
  sib:   none -- a worker that starts cold with nothing in the store saying so, or a first moment that lives in a file the next commit can lose, is what this prevents, not a behaviour
  serves: N29 N31 N27
  touches: D288 D295 D284 D281 D283 D227
# Phase 3, 2026-10-31, from N29's own comment ("how a headless worker with no hooks gets the same first moment is a coverage question"); provenance: the field report's SubagentStart injection and the proposal's withdrawal of it for the prompt (docs/proposal-workflow-legs-2026-10-15.md L806), the global instructions-file routine at L878. The visionary reframed the three options ("what is more reliable - prompt injection or file instructions ... it's mostly about re-creating the session; most reliable forensic reconstruction. i feel anything in the tc store is going to be more reliable than an file that can get deleted before commit"); the interviewer recommended the prompt with the first-moment row added, ratified: "yes, that reads right". Roads not taken: a file named in the ticket's environment, read first by the CLI's managed instructions file (a user who did not let install manage that file gets a worker that starts cold, N29 unmet silently); ids in the ticket and one fetch, N29 softened for hook-less CLIs (depends on the MCP server being wired in that CLI and the model obeying; no record that the worker read them). Open for coverage: whether the door cuts a very large checkpoint from the prompt (N27's "no leg pays for context it does not need")

D299 2026-10-31 [I>V] amends D280
  trig:  a leg or its designated checkpointer writes a checkpoint under a key; or the ticket door composes a worker's first message around a checkpoint of any size [I>V]
  resp:  a checkpoint is the state of the work as it now stands and names what it supersedes and what it rests on, never the history pasted in, and the brief says so in words; a checkpoint written past {16000} characters is refused once with the reason and the shape asked for, a shorter checkpoint that references what it left out, and a second over-cap write under the same key by the same leg is accepted and marked as over the cap; the door composes the first message with the checkpoint in effect whole and never cuts it; the first-moment row carries the checkpoint's size so a reader sees what the leg paid [I>V]
  spread: a checkpoint of <chars> characters is <verdict> on its first write and <verdict2> on the second
  sib:   none -- a chain of original-plus-review checkpoints growing without bound, or a cut at read that drops the verdict at the end, is what this prevents, not a behaviour
  serves: N27 N29 N28
  touches: D280 D279 D298 D286 D4
# Phase 3, 2026-10-31, the question D298 left open; the visionary asked for the interviewer's view ("what do you think will control unbounded checkpoints? use references to priors? or doesn't matter? or hard cap?") and ratified the recommendation: "yes, that reads right". Reasoning given: "doesn't matter" is out by the owner's own triage rule of 2026-10-30 (anything that grows without bound is a blocker the day it is found, the recovery snapshot's shape with a model in the loop); references are D280's designed shape and the brief's sentence is the only thing enforcing it against a model that pastes; the cap is the deterministic backstop placed where the information is, at write, in D279's once-only shape; a cut at read drops the end of original-plus-review, which is the verdict. The quantity: {16000} characters is the interviewer's number, about four thousand tokens, a size a leg orients on in one read and twice the 8000-character index boundary of captured tool output (D4/D261); the visionary: "16,000 stands since i have no concept of any other size", so the why is the interviewer's and the value is open to measurement at build without a reopening. Roads not taken: never cut and no cap, the checkpointer owns the size (the chain grows every leg and every leg pays for the whole chain); cut at a cap named in the ticket (keeps the original, drops the review the leg was spawned to act on)

D300 2026-10-31 [I>V]
  trig:  a run is exported as a unit, by an agent, a harness or a human, with or without a form named [I>V]
  resp:  the default run export is the run's skeleton, every checkpoint under every key in order, each leg's summary row, each leg's first-moment row and the legs' registrations, enough to resume or review the run elsewhere and holding no captured tool output; the `whole` form adds every row of every leg behind the same secrets acknowledgement as today's whole journal; the caller picks the form, so a harness that wants the trails says so and takes the warning; a run export is the first that crosses writers, every leg's lane under the run [I>V]
  sib:   none -- a run file that carries a teammate the secrets risk for a run they wanted to review, not replay, is what this prevents, not a behaviour
  serves: N31 N28 N27
  touches: D170 D199 D172 D289 D282
# Phase 3, 2026-10-31, from D282's "exportable"; verified before answering: export today has two forms, `summaries` (default) and `whole` behind the secrets acknowledgement (src/handoff.ts L141, L190), plus one writer's trail; none crosses writers. The visionary asked how export works and put three shapes (a default and what it is; no default, the exporter chooses; the harness or main agent instructs): "I don't have an opinion ... I figure a 'safe' default is fine". The interviewer's view, ratified ("yes, that reads right, safe default with whole as the override"): (a) with (c) as its override, since instructing the exporter is the same door as choosing, a form argument. Roads not taken: every row of every leg always (a 30-leg run with shell trails is tens of megabytes and every importer takes the secrets risk); no run form, a run filter on the existing forms (the summaries form carries no checkpoints or first moments, so the default could not resume a run). The stressing case shown and accepted: a reviewer importing the skeleton asks why a checkpoint was written and the trail that explains it is on the other machine. PROTOCOL CRITIQUE for the run record, the visionary, same turn: "in these question offer the last choice to be a discussion like we have had for the last couple of questions. i often need more context and back and forth" — adopted from here: every option set carries a "discuss first" option

D301 2026-10-31 [I>V]
  trig:  the harness, or any caller, asks for the checkpoint in effect under a key on a run [I>V]
  resp:  the reply carries the run's facts beside the checkpoint: how many legs have run on the run, how many checkpoints sit under this key, how long ago the run started, and the sizes of the last few checkpoints under the key; treecontext judges none of it, the harness reads the numbers and decides whether to spawn again, and a human gate is the harness's to build [I>V]
  sib:   none -- a run that loops until someone looks, with the facts that would have shown it sitting unread in the store, is what this prevents, not a behaviour
  serves: N28 N27 N31
  touches: D289 D296 D293 D280
# Phase 3, 2026-10-31, from seed C with provenance named as the platform developer's field report, not the visionary's words (docs/orchestration-platform-field-report-2026-10-15.md L77-80: one record, 11 runs, 18.6M tokens, one question to the human, never converged; a leg's own "not done" is not a brake; they are adding a script-read convergence measure and a human gate at a bounded interval). Option 1 of four chosen (the fourth, "discuss first", is the protocol addition of D300's turn). Roads not taken: bounds on the run's registration (leg cap, age) reported when crossed and never refused (a run opened with no bounds, the one-line harness's case, gets the facts and nothing more, so the facts are the floor either way); nothing, convergence as the harness's business alone (the field report's case). The stressing case shown and accepted: a harness that reads "in effect" alone, as in D296, sees none of it

D302 2026-10-31 [I>V]
  trig:  a harness expects a checkpoint to carry a shape it can parse and a leg's checkpoint does not; or a harness ends a run for any reason of its own [I>V]
  resp:  the grammar is the harness's and lives in the brief; the store never parses or checks a checkpoint's shape; when the harness ends the run on a parse failure or any other reason it says so through the door as it retires the leg and closes the run, and the store records on the run that it ended there, by whom and why, so plain SQL shows the stop; a run has an opening, its first leg's registration or an explicit open, and a close the harness or main agent may declare with a reason [I>V]
  sib:   none -- the store refusing a free-prose checkpoint, or a run that simply stops with nothing saying why, is what this prevents, not a behaviour
  serves: N31 N28 N27
  touches: D280 D299 D301 D289 D293
# Phase 3, 2026-10-31, the rest of seed C, provenance the platform developer's field report (L82: hand-off line parsed against a fixed grammar, an unparsable line ends the run, "add the rule that a leg whose checkpoint does not parse ends the run"); option 1 of four chosen. Roads not taken: a declared checkpoint shape the store checks, refused once like D299's cap (every brief author writes a schema and D280's prose becomes the exception); no grammar anywhere, the harness reads the summary row and D301's facts and never parses the checkpoint (the field report's slipped line was the structured return, and the checkpoint is where the honest "not done" lived). The stressing case shown and accepted: a harness that does not say why it stopped leaves a run the store cannot tell from a crashed harness; the run's open and close enter the record here as the unit D282 named

D303 2026-10-31 [I>V]
  trig:  a worker starts with a ticket in its environment that the door, the hook on `claude -p` or the server on a hook-less CLI, cannot read whole: hand-edited, truncated, or minted in another shape by an older treecontext [I>V]
  resp:  the worker is registered in its own lane with every field the door could read, each unreadable field marked absent and the raw ticket text kept on the registration, never as a self; its first moment is the statement that its instructions were invalid and the ask to write one row saying so and stop; the worker does no work; the leg ends visibly as having had no valid instructions, the harness's lookup says so, and the harness decides whether to mint again; a spawner that sees the fault before spawning writes that row itself and spawns nothing [V]
  sib:   none -- a worker guessing at instructions it could not read, or its one row landing in the main lane as the main agent's, is what this prevents, not a behaviour
  serves: N32 N27 N28
  touches: D279 D293 D294 D298 D288
# Phase 3, 2026-10-31; the interviewer recommended registering with what was read and never falling back to a self (so the rows never land in the main lane as `main`, N32's case), and the visionary reframed the worker's part: "rather than burn tokens on what could be wrong assumptions, the worker simply writes a checkpoint that it didn't get valid instructions?"; the two combined and ratified: "yes, that reads right". Roads not taken: run as if no ticket were present and record the damage on the self's registration (the rows land in the main lane, the misattribution the ticket door exists to prevent); register with what was read and let the worker work (the interviewer's draft, work done on a guessed brief); the spawner refuses to spawn on a ticket it cannot read (damage happens between mint and read, so the spawner sees only the version-skew case, and refuses a ticket the harness minted a minute ago). The stressing case accepted: a damaged ticket that still reads as a role, the wrong one, registers under it with only the raw text on the registration to compare against the mint

D304 2026-10-31 [I>V] amends D290
  trig:  install or doctor runs where the Claude Code found is older than {2.1.290}, the first release that reads the idle-compaction key, or where its version cannot be read [I>V]
  resp:  install writes the key only when the client is known to honor it; below the floor or unknown it writes nothing and says the setting is not applicable to this client; doctor's row says the setting is not read by this client and names its version; an install run later on an upgraded client writes it then [I>V]
  spread: a client at <version> gets <written> and doctor says <row>
  sib:   none -- a key written into a client that does not read it, reported as a setting that took effect, is what this prevents, not a behaviour
  serves: N1 N23
  touches: D290 D276 D208
# Phase 3, 2026-10-31, from D290's open item; option 2 of three chosen (the third "discuss first"). The quantity {2.1.290} is the client's, from Anthropic's settings reference (journal fbc71fa1); the /config row exists from 2.1.302. Roads not taken: write it anyway and say the client is older (harmless to a client that ignores it, in place when it upgrades; but install cannot always read the client's version and would then write and say nothing). The stressing case shown and accepted: a user who upgrades the client and never re-runs install has idle compaction turn on under them, with doctor the only thing that notices

D305 2026-10-31 [I>V]
  trig:  a subagent is spawned through the hooks door, with a brief that names a run and a key, or with no brief or no key [I>V]
  resp:  the leg contract, the first-moment row, the checkpoint and its once-only send-back, and a place in the run's facts, applies to a subagent whose brief names a run and a key; a subagent spawned with no brief or no key is registered at its start and summarised at its stop exactly as today, with no ask at its stop, and nothing about today's subagent behaviour changes for it [I>V]
  sib:   none -- a twenty-second lookup subagent paying a second turn for a checkpoint nobody reads is what this prevents, not a behaviour
  serves: N27 N21 N29
  touches: D279 D280 D284 D281 D301 D190
# Phase 3, 2026-10-31, the survival question (what already-working behaviour must survive the legs contract: SubagentStart registration, the hand-back summary); "discuss first" taken, the interviewer's recommendation ratified ("ok"): the key is the switch because D280 made a checkpoint about a unit of work named by its key, and a successor can only pick up what a key names, so a keyless subagent is a fresh one-shot by construction. Roads not taken: every subagent a leg with a key minted from its role when absent (D279's "without ceremony" spent on every grep, the token burn the visionary named at D303); every subagent a leg with the send-back only under a key (the main session becomes a run whose leg count mixes lookups and work, and D301's facts mislead). The stressing case accepted: a main agent that forgets the key on a long leg gets no checkpoint and finds out at the next cold start; the summary row still lands, and the dispatch skill (seed B) is the surface that makes keying a leg the default

D306 2026-10-31 [V]
  resp:  the checklist sweep's Performance row is declined for the subagent work: no ruling of this program names a slowest acceptable lookup, first moment or export at the largest realistic run; Security is confirmed as already answered by D293, not re-probed [V]
  ->     fence-declined
  serves: N27
  touches: D293
# the Phase 3¼ triage, 2026-10-31, the protocol's one batched question over the ten checklist rows (provenance named: a standard checklist, not the visionary's words); selected for a question each: Reliability, Diagnosability, Lifecycle/Evolvability, Usability, Availability, Ops burden, Compliance; not selected: Performance, recorded here as declined with provenance; Security pre-answered by D293 and confirmed

D307 2026-10-31 [I>V]
  trig:  a worker's first moment or its exit arrives while the store is locked, busy or unreachable [I>V]
  resp:  at the first moment the door waits the busy wait the raw opener already has, and, if the store still cannot be read, starts no worker and tells the spawner in words that the store was unreachable and nothing was written, so the spawner retries or gives up; at exit a checkpoint the store cannot take is lost from the store, never from the spawner, since the ticket door passes the worker's last output through, and the leg stays registered with no checkpoint under its key until it is retired as a phantom; readers of the key see the earlier checkpoint in effect [I>V]
  sib:   none -- a worker that starts cold with no first-moment row and leaves a run that cannot be reconstructed in exactly the session where the store was flaky is what this prevents, not a behaviour
  serves: N27 N28 N32
  touches: D279 D291 D293 D297 D298 D303 D175
# Phase 3¼, 2026-10-31, the Availability row (provenance named: a checklist category, not the visionary's words); the visionary's reading "the leg has a slight wait, and if nothing, returns no instructions?" sharpened by the interviewer into not-started, ratified: "yes, that reads right". Roads not taken: the cold start, the door composes the first moment from the spawner's prompt alone and tells the worker the checkpoint could not be read (the first-moment row cannot be written either, so the worker has rows with a writer and a parent but no first moment); a queued checkpoint held by the door until the store returns (a second writer path with its own failure modes, and the spawner already holds the text). The stressing case shown and accepted: the cost is one spawn retry by the harness, and a store that stays unreachable leaves the run with a live registration D297 retires only when the pid is next checked on that host

D308 2026-10-31 [I>V]
  resp:  the subagent work adds no operation a person runs by hand or on a schedule: a run nobody closed stays open and readable, a registration a dead host left live is retired when next noticed, and a store that grows by a first-moment row and a checkpoint per leg is the retention valve's to carry; after installation the only hands a person puts on treecontext are an upgrade and a doctor run for what doctor reports, and that holds for the installed life, not only the sprint's day D178 named [I>V]
  ->     structural
  serves: N26 N27 N28
  touches: D178 D297 D302 D301 D290 D304
# Phase 3¼, 2026-10-31, the Ops burden row (provenance named: a checklist category, not the visionary's words); the visionary's words: "nothing to run; from user perspective after installation, essentially zero maintenance other than to upgrade and fix issues that rise with doctor". N26 is confirmed and its horizon widened from the sprint's day to the installed life; the needs sketch carries the widening at drafting. The candidates put and absorbed: unclosed runs, live registrations on a host that never came back, per-leg store growth. Not a new need: N26 already owns the weight

D309 2026-10-31 [I>V]
  trig:  an agent is asked what ran, or what happened in a run, with no run id in hand [I>V]
  resp:  a run is findable through the query the agent already has, by time and by the run's name, because every row a run is made of is a journal row carrying the run and the key: the first-moment row, each checkpoint, each worker's summary row, and the run's open and its close; a registration alone stays in the registry's own table, and nothing about a run lives only there; an agent asked what ran on a day finds that day's first-moment rows and walks the run from them [I>V]
  sib:   none -- a run whose existence is recorded only in a table the query never reaches, so that the agent cannot answer "what ran last Tuesday" without the id, is what this prevents, not a behaviour
  serves: N27 N28
  touches: D289 D298 D299 D288 D302 D294 D8
# Phase 3¼, 2026-10-31, the domain question (provenance named: the interviewer's priors), item 1; the visionary: "most human users would just ask agent to query the store. so if the agent can figure it out, that's all that's necessary"; ratified "yes, that reads right". Verified under rule 6 before recording: the registry is its own table (`src/persistence/session-registry.ts:34`, migration 027) and the query tool searches the journal's rows only; the status tool reads the registry for writer notes and never lists it (`src/server/server.ts:338`). Roads not taken: a run listing in the status tool; a run-lookup tool of its own (a ninth tool for what the query reaches once the rows carry the run)

D310 2026-10-31 [I>V]
  trig:  a run's legs write into more than one store: a leg ran in another repository or on another machine, or a design chosen later gives a worker a store of its own [I>V]
  resp:  a run is reconstructable whole no matter how many stores its legs wrote into; a leg in a worktree of the same repository writes into the run's store as today; a leg that ran elsewhere writes into that place's store and comes back by the handoff that exists, a run export from there imported into the run's store under a handoff lane, after which the run's facts and a key lookup count its checkpoints as the run's; whether a worker ever gets a store of its own is an implementation decision deferred to the design pass, bound by this: any topology chosen leaves the run reconstructable from one store after the handoff [I>V]
  sib:   none -- a run split across two files with no practice that reunites them, so that "what happened" has no single answer, is what this prevents, not a behaviour
  serves: N27 N28 N22
  touches: D300 D301 D289 D294 D196 D309
# Phase 3¼, 2026-10-31, the domain question (provenance named: the interviewer's priors), item 2; the visionary: "no matter what design is chosen (single store, separate stores), there's a way to figure out what happened and there's handoff practices for subagents going out and coming back in"; laddered under rule 5: the need is reconstruction, single-or-separate is a means, queued for Phase 5½ under rule 3; ratified "yes, that reads right". Verified under rule 6: a linked worktree resolves to its primary checkout's store (`src/server/bindings.ts:578`, primaryRepoRoot), so worktrees already share one file; the handoff lane rule is the existing import (`src/handoff.ts`). Roads not taken: one store, always, by rule (forecloses a per-worker store the design pass may want); a store per worker with the run's store the index (two writer paths and a reunite step on every leg)

D311 2026-10-31 [I>V]
  trig:  a leg of a run spawns workers of its own that need a run and keys to checkpoint under [I>V]
  resp:  a leg may open a run of its own; the inner run's open names the outer run and the leg that opened it, as declared facts the way a worker declares its parent; from the outer run that leg's facts say it opened a run and name it, so walking the outer run reaches the inner run's legs, and from the inner run the open names the way back; the outer run's facts count the opening leg as one leg and nothing more, its checkpoint under the outer key is what the outer harness reads, and the inner run's checkpoints stay the inner run's; depth is not limited, and the same link applies at each level [I>V]
  sib:   none -- two runs in one store with no row that ties them, so that a subagent's subagents reconstruct as strangers, is what this prevents, not a behaviour
  serves: N27 N28
  touches: D294 D302 D301 D289 D309 D310
# Phase 3¼, 2026-10-31, the domain question (provenance named: the interviewer's priors), item 3; the visionary: "we should be able to reconstruct a run within run since i imagine in the future, subagents may spawn more subagents in some situations"; ratified "yes, that reads right". Roads not taken: the inner workers join the outer run as its legs under keys of their own (the outer run's leg count and facts then mix two harnesses' work, and D301's brake reads the wrong number); nesting refused, one run per store at a time (forecloses the case the visionary named). The stressing case accepted: the link is declared by the opening leg's harness, so a harness that opens an inner run and declares no parent leaves two runs the reader ties by the declared parents of the workers alone

D312 2026-10-31 [I>V] amends D301
  trig:  a leg is alive and writing nothing, hung on a call or waiting, and a harness or an agent asks why the run is slow [I>V]
  resp:  the run facts a key lookup returns also say, for each live leg, the moment it started and the moment it last wrote a row, so a leg two hours old with no row for ninety minutes is visible to the harness and to an agent asked; the store judges nothing and shows the moments; the timeout that cuts the leg stays the harness's, and the cut is recorded as D292 says [I>V]
  sib:   none -- a hung leg that looks like a busy one until the harness's timeout fires, with the run's slowness unexplainable from the store, is what this prevents, not a behaviour
  serves: N28 N27 N31
  touches: D301 D297 D292 D289
# Phase 3¼, 2026-10-31, the domain question (provenance named: the interviewer's priors), item 4, re-put in plain words after the visionary's "i don't know what you are asking"; option 1 of three chosen (the third "discuss first"). Roads not taken: nothing beyond, the harness's timeout is enough and the start moment is in the registry's table for SQL (the agent's lookup then cannot answer "why is the run slow" without the id and the table). The stressing case accepted: a leg that is busy on one long call shows the same moments as a hung one, and only the harness's timeout tells them apart

D313 2026-10-31 [I>V] amends D298
  trig:  the ticket door writes a worker's first-moment row from a spawner's prompt of any size, a pasted file among it [I>V]
  resp:  the first-moment row keeps the whole prompt, with a bounded preview that search sees and the full text behind it fetched by export, exactly as captured tool output is kept today; nothing is cut and nothing is refused; the store grows as it already does for tool output and the retention valve carries it [I>V]
  sib:   none -- a six-million-character run of first moments that no search can read, or a cut tail that the forensic reconstruction of D298 then lacks, is what this prevents, not a behaviour
  serves: N29 N27 N23
  touches: D298 D299 D4 D3 D141
# Phase 3½, 2026-10-31, objection 1 (the first-moment row has no size rule while the checkpoint has {16000} and the insert tool `50000`, `src/server/server.ts:361`, and the door writes through the library, which has none); option 1 of four chosen (the fourth "discuss first"). Verified under rule 6: the preview boundary is a column any row carries (`preview_len`, `src/flat-store.ts:191`), not a capture-only path. Roads not taken: cut at the insert tool's cap and say how much was cut (the reconstruction loses the pasted tail); uncapped plain row as D298 read (an unbounded first moment beside a capped checkpoint, and no preview for search to see). The stressing case shown and accepted: twenty workers each handed a {300000}-character prompt write six million characters the valve must eventually archive

D314 2026-10-31 [I>V] amends D307
  trig:  a leg through the hooks door starts while the store is locked, busy or unreachable [I>V]
  resp:  the leg starts, as the platform decides, since the subagent-start hook is context-only and cannot decline a spawn; its start is dropped like any hook event at an unreachable store and marked as a capture gap when the store is next written, so a reader sees the leg began with no brief and no first-moment row; the not-started rule of D307 stands for the ticket door, where the door is the spawner and can decline; the two doors differ because the platform makes them differ, and the record says so [I>V]
  sib:   none -- a record that promises not-started at both doors while one door cannot deliver it, so that the hooks-door leg starts cold with nothing saying so, is what this prevents, not a behaviour
  serves: N27 N28 N32
  touches: D307 D298 D279 D305 D175 D2
# Phase 3½, 2026-10-31, objection 2 (D307 names a door it cannot cover); option 1 of four chosen (the fourth "discuss first"). Verified under rule 6: Claude Code's hooks reference lists SubagentStart under "Context only ... No blocking or decision control" and its exit-code row as "No" for blocking, while SubagentStop blocks and delivers its reason as the subagent's next instruction (code.claude.com/docs/en/hooks, decision-control and exit-code tables, read 2026-10-31); the capture-gap marker for dropped events is charter (AGENTS.md, "Dropped events leave visible [capture gap] markers"). Roads not taken: a hook on the Agent tool call that denies the spawn while the store is unreachable (documented for tool calls generally, not for the Agent tool, so an inference until tried, and a hook run on every spawn inside the budget); start cold and spend the stop hook's one send-back on delivering the brief (the work done twice, and D279's send-back no longer about the checkpoint). The stressing case accepted: a hooks-door leg at a flaky store does its whole leg without its brief, and the gap marker is the only thing that says so

D315 2026-10-31 [I>V] amends D298
  trig:  the ticket door composes a worker's first moment and the checkpoint in effect under its key was written by a writer other than the checkpointer the brief names [I>V]
  resp:  the first moment carries, in words beside the checkpoint, the sentence the lookup gives, that this checkpoint's writer is not the checkpointer the brief names, and the first-moment row carries the same flag, so the reconstruction shows the worker was told; the worker decides whether to start from it and the harness sees the flag in the facts; nothing is withheld [I>V]
  sib:   none -- a poisoned key handed to the next worker as its starting state with only a writer name to notice, is what this prevents, not a behaviour
  serves: N32 N29 N28
  touches: D296 D298 D293 D301 D313
# Phase 3½, 2026-10-31, objection 3 (D296's flag lives in the lookup's reply while D298's door composes with nobody in the loop to read it); option 1 of four chosen (the fourth "discuss first"). Roads not taken: the door starts no worker and returns the flag to the spawner (a harness gate on every poisoned key, one more spawn round); as ruled, the writer name in the first moment and the checkpointer in the brief are enough for a worker to compare (the worker is trusted to notice what the store already knows). The stressing case accepted: a worker told its starting state is a stranger's still starts from it, since the store judges nothing; the flag makes the choice visible, not safe

D316 2026-10-31 [I>V] amends D291
  trig:  a ticketed worker exits with no checkpoint under its key and the worker has no door of its own to write one: no treecontext tools registered in its CLI and no library call [I>V]
  resp:  the ticket declares whether the worker has a way to write, as it declares everything else; a worker declared door-less gets no send-back, its last output lands as its summary row as D288 says, and the leg is retired as ended without a checkpoint, visibly, so the next leg of its role starts as a recovery leg under D279; nothing is run twice for a checkpoint that was never possible; a worker declared to have a door keeps the one send-back of D291 [I>V]
  sib:   none -- the one send-back spent doing the same work twice for a worker that could never checkpoint, is what this prevents, not a behaviour
  serves: N27 N28 N31
  touches: D291 D288 D279 D295 D303 D302
# Phase 3½, 2026-10-31, objection 4 (D291's re-run assumes a door the worker may not have); option 1 of three chosen (the third "discuss first"). Roads not taken: as ruled, sent back once regardless (one wasted run per door-less leg); the spawner writes the checkpoint from the worker's output (closed by D279: the main agent never writes a leg's checkpoint and the store never synthesizes one). The stressing case accepted: a ticket that declares a door the worker does not in fact have is sent back once for nothing, since the ticket is declared, not discovered, and the store checks nothing

D317 2026-10-31 [I>V] amends D297
  trig:  a worker's process number has been handed by the operating system to a new, unrelated process after the worker ended, and a reader checks the worker's liveness [I>V]
  resp:  every worker registration records the process's start moment, as the operating system reports it, beside its id and host; a process found with that id and a different start is a different process, so the worker is gone and is retired as a phantom under D297, with the moment it was noticed and by whom; a process with that id and that start is the worker, alive [I>V]
  sib:   none -- a phantom kept live by a stranger that inherited its number, until the host reboots, is what this prevents, not a behaviour
  serves: N28 N27 N32
  touches: D297 D288 D294 D312
# Phase 3½, 2026-10-31, objection 5 (D297's liveness check is by number alone, and numbers are reused within hours on a busy host); option 1 of three chosen (the third "discuss first"). Roads not taken: as ruled, the number alone with the reuse recorded as a known limit. The stressing case accepted: a host whose process-start reading is unavailable to the door leaves the registration with the number alone, and the reader says the worker cannot be told from a successor, as D297 says of another host

D318 2026-10-31 [I>V] amends D300
  trig:  a run is exported in its default skeleton form and the first-moment rows it carries hold the spawners' prompts as written, pasted files among them [I>V]
  resp:  the skeleton carries every first moment whole, because a review needs what each worker was told, and the export's reply says in one line that first moments carry the spawners' prompts as written and may hold what was pasted into them; no acknowledgement is asked for the skeleton; the `whole` form stays behind the acknowledgement of D300 [I>V]
  sib:   none -- a token pasted into a worker's prompt travelling in the one export form that says nothing about secrets, is what this prevents, not a behaviour
  serves: N31 N28 N29
  touches: D300 D298 D313 D315
# Phase 3½, 2026-10-31, objection 6 (D300's safe default holds no captured tool output but, after D298 and D313, holds every spawner's prompt whole); option 1 of four chosen (the fourth "discuss first"). Roads not taken: the skeleton carries each first moment's bounded preview with the whole prompt only under `whole` (a reviewer loses the pasted tail that may be the point); as ruled, whole with no warning (the exporter is not always the spawner and does not know what was pasted). The stressing case accepted: the warning names the risk and stops nothing; a token pasted into a prompt still travels in the skeleton

D319 2026-10-31 [I>V] amends D313
  trig:  the store is over its byte budget and the retention valve looks for whole sessions to archive, and a worker's lane holds its first-moment row [I>V]
  resp:  the door writes the first-moment row as the worker's capture, so the valve archives it with the rest of that lane when the store is over budget, whole and fsynced before anything moves, as any session; a checkpoint, a summary row and the run's open and close are agent-authored and stay protected; a reconstruction of an archived leg is read from the archive, as any archived session is [I>V]
  sib:   none -- a first-moment row kept forever because the door's writes count as notes, so that the growth D308 handed to the valve never reaches it, is what this prevents, not a behaviour
  serves: N23 N27 N29
  touches: D313 D308 D298 D141 D4 D3 D22
# Phase 3½, 2026-10-31, objection 7, the interviewer against the record under rule 6: D308 and D313 each said the valve carries the first-moment rows' growth, and a read of the valve refuted it, since it evicts only rows labelled `auto-capture` and protects every agent-authored row (`src/flat-store.ts:217`), while nothing the door writes is capture today; returned to the visionary as a fresh decision point, option 1 of three chosen (the third "discuss first"). Road not taken: everything the door writes protected (the growth per worker then bounded by nothing). The stressing case accepted: an archived leg's first moment is in the archive file, not the live store, so a reconstruction of an old run reads two places

D320 2026-10-31 [I>V] amends D289
  trig:  the hooks door registers a subagent and is handed its id and its role but not the prompt that names its run and key; or more than one brief for that role is in effect at once [I>V]
  resp:  the registration takes the run and key from the newest brief in effect for its role, marked as inferred; when more than one brief for that role is in effect the registration says the key is ambiguous and names the candidates; the leg's first write under a key settles its registration, marked as the leg's own; a leg that writes under no key stays keyless under D305 and the run's facts count it as such [I>V]
  sib:   none -- two live legs of one role both registered under the newer brief's key, so that one leg's checkpoint lands under the other's work, is what this prevents, not a behaviour
  serves: N29 N32 N28
  touches: D289 D284 D305 D280 D294 D293 D301
# Phase 3½, 2026-10-31, objection 8 (the hooks door cannot read the brief at the start); option 1 of four chosen (the fourth "discuss first"). Verified under rule 6: Claude Code's hooks reference gives SubagentStart's payload as the common fields plus `agent_id` and `agent_type`, with no prompt or task field, and the prompt as the Agent tool call's input seen by a hook on that call (code.claude.com/docs/en/hooks, SubagentStart section, read 2026-10-31). Roads not taken: bound only by the leg's own first write (a leg that forgot everything leaves no record of having had a key); the harness's to keep unambiguous, one live leg per role (the store then records the wrong key on both when the practice slips). The stressing case accepted: a leg of an ambiguous registration that writes nothing under a key is retired ambiguous, and the reader sees two candidates and no settlement

D321 2026-10-31 [V] ratifies D299
  resp:  the checkpoint cap of D299 stays a refusal once and an accepted, marked second write; the store nudges and records, and a leg that pays the mark gets its state in whole, with the first-moment row showing the next leg what it cost [V]
  ->     structural
  serves: N27 N29
  touches: D299 D279 D313
# objection 9 of the adversarial pass, 2026-10-31 (the second write makes the cap a one-time nudge a harness learns to pay); the visionary reaffirmed D299 as ruled, option 1 of three (the third "discuss first"). Road not taken: a binding cap, every over-cap write refused with the shape asked, so a leg that cannot write under it ends without a checkpoint, is sent back once and then leaves a recovery leg the trail (the chain cannot grow, and a legitimate long state has no way in); lands in the fence's Roads not taken at Phase 4

D322 2026-10-31 [V]
  resp:  every development and release dependency of the package stays at its latest stable version at each release: the build that ships `beta.3` updates what is behind, and a release with a dependency behind its latest stable is not ready [V]
  ->     means N26
  serves: N26 N1
  touches: D178 D208 D276
# Phase 5½, 2026-10-31, the first elective, the visionary's words: "just make sure all dev and release dependencies are up to date to latest stable"; a preference, laddered under rule 5 to the installed-life maintenance of N26 and D308 (a dependency left behind is a chore deferred to the user's upgrade) and to install working on current clients (N1); the bound stops at "latest stable": no pinning rule, no update cadence between releases, no tool named. Verified under rule 6 at ruling: `npm outdated` lists {2} of {22} declared packages behind, both one patch level (`@opencode-ai/plugin` 1.19.4 -> 1.19.5, `@types/node` 26.6.5 -> 26.6.6), the Node floor `>=24.16.0` unchanged; lands in DESIGN.md as a ruled constraint

D323 2026-10-31 [I>V]
  resp:  a worker spawned for a project writes into that project's store, as a worktree session does today; a worker in another repository or on another machine writes into that place's store and comes back by the handoff of D310; no store per worker and nothing new built for topology [I>V]
  ->     means N31
  serves: N31 N27 N28
  touches: D310 D309 D288 D294
# Phase 5½, 2026-10-31, the first queued elective (D310 deferred the topology to this pass); option 1 of three chosen (the third "discuss first"). The means serves reconstruction with plain SQL, N31: one file holds a run's legs on one machine. Verified under rule 6 at D310: a linked worktree resolves to its primary checkout's store (`src/server/bindings.ts:578`). Road not taken: leave the topology to the build bound by D310 alone (the builder chooses and the gate checks the bound); a store per worker was declined at D310. Lands in DESIGN.md as a ruled constraint

D324 2026-10-31 [V]
  resp:  the post-draft gate for the `beta.3` corpus is interactive: the audit runs before the visionary's read, drafting defects are fixed before it, and contract-level findings are put as questions during the read, their positions recorded as ratification order and excluded from the attention data [V]
  ->     boundary
  serves: N27
  touches: D202 D282
# the gate-mode decision, 2026-10-31, put before any audit of the drafted corpus ran (the protocol's rule: an audit already run forces the interactive label); option 1 of three chosen (the third "discuss first"). The audit is staffed as the visionary ruled at the readback: reviewers running the failure ladder, the interviewer as the gate on their findings

D325 2026-10-31 [I>V] amends D299
  trig:  a leg's first moment through the hooks door, the brief and the checkpoint in effect together, is longer than the client's cap on what a hook may inject [I>V]
  resp:  a checkpoint is the state of the work as it now stands and names what it supersedes and what it rests on, never the history pasted in, and the brief says so in words; a checkpoint written past {16000} characters is refused once with the reason and the shape asked for, and a second over-cap write under the same key by the same leg is accepted and marked as over the cap; the ticket door composes the first message with the checkpoint in effect whole and never cuts it; the hooks door injects the brief and as much of the checkpoint as fits under the client's cap, ends with the checkpoint row's id and a line saying how many characters were left out, so the leg fetches the whole by export, and the first-moment row records the cut and the checkpoint's size; a first moment that fits is injected whole, with no query made [I>V]
  spread: a first moment of <chars> characters through the hooks door is <injected>
  sib:   none -- a packet the client replaces with a path to a file in its session directory, which the store never records and the leg is never asked to read, is what this prevents, not a behaviour
  serves: N29 N27 N31
  touches: D299 D284 D321 D298 D313 D314 D320
# the post-draft pass, 2026-10-31, question 1 of the interactive gate (D324); option 1 of four chosen (the fourth "discuss first"). Verified under rule 6: Claude Code's hooks reference caps a hook's additionalContext, systemMessage, initialUserMessage and plain stdout at `10,000` characters each, writes a longer string to a file in the session directory and passes the path with a preview of up to `2,000` characters, and does not ask the agent to read the file (code.claude.com/docs/en/hooks, JSON output, read 2026-10-31); the client's cap is the client's quantity, backticked. Roads not taken: let the platform spill to its file (a path to a file the store never records); lower the checkpoint cap to fit under the client's cap at both doors (D299's {16000} reopened for a limit one door has). The stressing case accepted: a leg whose checkpoint is marked over the cap pays one fetch at every first moment, and N29's no-query first moment holds only for checkpoints that fit

D326 2026-10-31 [I>V] amends D320
  trig:  the hooks door registers a subagent and is handed its id and its role but not the prompt that names its run and key; or more than one brief for that role is in effect at once; or a leg registered under an inferred key stops having written nothing under any key [I>V]
  resp:  the registration takes the run and key from the newest brief in effect for its role, marked as inferred, and the inferred key gives the leg its brief and the checkpoint in effect at its start and a place in the run's facts; when more than one brief for that role is in effect the registration says the key is ambiguous and names the candidates; the leg's first write under a key settles its registration, marked as the leg's own; only a key marked as the leg's own makes the stop ask for a checkpoint, so a leg whose key is inferred or ambiguous and that writes under no key stops as today, unasked, and the run's facts count it as keyless [I>V]
  sib:   none -- a quick keyless lookup by a role with a brief in effect sent back for a checkpoint nobody wanted is what this prevents, not a behaviour
  serves: N29 N32 N28 N21
  touches: D320 D305 D279 D280 D284 D301
# the post-draft pass, 2026-10-31, question 2 of the interactive gate (D324), the collision the legs reviewer found between D305 and D320; option 1 of three chosen (the third "discuss first"). Road not taken: an inferred key is a key and the send-back applies, with distinct role names for lookups as the dispatch practice (the practice slips and the lookup pays a turn). The stressing case accepted: a long leg that forgets to write anything under its key stops unasked too, visible only as a keyless leg in the run's facts

D327 2026-10-31 [I>V]
  trig:  the hooks door or a lookup asks which briefs are in effect for a role, and a brief for that role was written earlier on the same run, under the same or another key, or on a run since closed [I>V]
  resp:  a brief is in effect until a newer brief for the same role under the same key names it as superseded, or the run it names is closed; two briefs for one role under different keys on an open run are both in effect, the ambiguous case of D320; nothing is deleted and the supersession trace is the same as a checkpoint's [I>V]
  sib:   none -- every brief ever written for a role staying in effect for the store's life, so that the ambiguity rule fires forever, is what this prevents, not a behaviour
  serves: N29 N27 N28
  touches: D320 D326 D284 D281 D302 D227
# the post-draft pass, 2026-10-31, question 3 of the interactive gate (D324), a gap the legs reviewer found under D320; option 1 of four chosen (the fourth "discuss first"). Roads not taken: a brief consumed by the first leg that starts under it (a recovery leg needs the brief written again, and parallel legs of one role can never share one); only a run's close ends its briefs (a role briefed twice on one run stays ambiguous until the close). The stressing case accepted: a brief for a role under a key on a run that is never closed stays in effect until a newer brief supersedes it

D328 2026-10-31 [I>V]
  trig:  a leg through the hooks door is killed or interrupted so that its stop hook never fires, and its session later starts, resumes or clears [I>V]
  resp:  a leg still registered live when its session next starts, resumes or clears is retired as cut then, with the moment it was noticed and the session start as what noticed it, as the session-start hook already retires every subagent left live; the next leg of its role under its key starts as a recovery leg; until that moment the leg reads as live, with its start and last write in the run's facts for the harness to judge; the store never guesses an exit time [I>V]
  sib:   none -- a cut leg that reads as live forever, so that no recovery leg ever starts, or a cut guessed from silence, is what this prevents, not a behaviour
  serves: N27 N28 N32
  touches: D279 D292 D297 D312 D320 D190
# the post-draft pass, 2026-10-31, question 4 of the interactive gate (D324), the gap the legs reviewer called the most consequential; option 1 of three chosen (the third "discuss first"). Verified under rule 6: the session-start hook retires every subagent still registered live at a start, resume or clear and none mid-session (`src/hooks/session-start.ts:121`, F3). Road not taken: also retire a live leg of a role when a newer leg of that role starts on the same key (two deliberate parallel legs of one role on one key become impossible, against D320). The stressing case accepted: a leg cut early in a long session reads as live until the session restarts, and only D312's ages hint at it

D329 2026-10-31 [I>V] amends D284
  trig:  a leg of a role starts with a brief that names its key and the checkpointer, and one checkpoint, two checkpoints or none is in effect under that key; or two legs under one key write their checkpoints having started from the same one [I>V]
  resp:  at its first moment the leg sees the brief and what is in effect under its key and has made no query: one checkpoint whole, or both with a line saying two are in effect for the brief's checkpointer to decide, or a line saying none is; the first-moment row references every checkpoint the first moment carried; the store numbers a checkpoint when it lands, so two legs that started from one checkpoint write the next two numbers, never the same number twice, and each names the one it started from as what it supersedes, so both stay in effect and the lookup returns two, never a silent pick; the leg's stop is not blocked and the main agent is handed a pointer to the leg's summary row, whose writer is the leg's role and which carries the run and the key; the same first moment holds at the ticket door [I>V]
  sib:   none -- two checkpoints numbered 4 under one key, or a first moment that picked one of two in effect without saying so, is what this prevents, not a behaviour
  serves: N29 N30 N28 N32
  touches: D284 D280 D298 D320 D296 D315 D325
# the post-draft pass, 2026-10-31, question 5 of the interactive gate (D324), the numbering race and the two-in-effect first moment both reviewers found; option 1 of three chosen (the third "discuss first"). Road not taken: one live leg per key at a time, a second start on a live key refused and the spawner told (parallel work on one key impossible, and the store refuses something, against D293). The stressing case accepted: two parallel legs on one key leave two checkpoints in effect that only the brief's checkpointer reconciles, and a harness that reads "in effect" alone sees two until then

D330 2026-10-31 [I>V]
  trig:  a leg through the hooks door finishes and the platform returns the subagent's own final message to the main agent [I>V]
  resp:  treecontext adds its one line to what the main agent receives when the Agent tool returns, naming the leg's summary row, its writer, run and key; the subagent's own final message stays the platform's and treecontext withholds none of it, so the main agent's context is kept small by the dispatch practice of a short final message, not by the store; the ticket door hands the same line to the spawner at the worker's exit [I>V]
  sib:   none -- a pointer emitted where only the subagent can read it, so that the main agent never receives it, is what this prevents, not a behaviour
  serves: N30 N27
  touches: D284 D285 D288 D329
# the post-draft pass, 2026-10-31, question 6 of the interactive gate (D324), the pointer channel both reviewers found unbound; option 1 of three chosen (the third "discuss first"). Verified under rule 6: Claude Code delivers a stop hook's context to the subagent and says that to inject context into the parent after a subagent returns a hook on the Agent tool's result is the way (code.claude.com/docs/en/hooks, SubagentStop section, read 2026-10-31). Road not taken: the stop hook's output as the pointer (lands with the subagent, not the parent). The stressing case accepted: N30's "never carry the leg's working state" is met by practice, a short final message, since the platform returns the subagent's final message whole whatever treecontext does

D331 2026-10-31 [I>V]
  trig:  a leg writes a checkpoint under its key that names nothing as superseded, or names a checkpoint other than the one it started from [I>V]
  resp:  a checkpoint that names nothing as superseded is stamped by the store as superseding the checkpoint the leg started from, read from the leg's own registration, and marked as stamped by the store rather than written by the leg; a checkpoint that names another, a reviewer naming the original, is taken at its word; the store synthesizes no fact, it carries one the leg's registration already holds [I>V]
  sib:   none -- a forgetful leg leaving a pile of checkpoints in effect under one key, or a supersession the store invented with no registration behind it, is what this prevents, not a behaviour
  serves: N28 N29 N32
  touches: D280 D284 D299 D329 D283
# the post-draft pass, 2026-10-31, question 7 of the interactive gate (D324), the legs reviewer's "who names the superseded checkpoint"; option 1 of three chosen (the third "discuss first"). Road not taken: the leg names it or nothing is superseded (a forgetful leg leaves two in effect every time, and the next leg sees two). The stressing case accepted: a leg that started from one checkpoint and meant its write as a sibling, not a successor, is stamped as superseding unless it names what it meant

D332 2026-10-31 [I>V] amends D325
  trig:  a leg's first moment is composed, through the hooks door or the ticket door, whatever the brief says about checkpoints; or a checkpoint is written past the cap; or a hooks-door first moment is longer than the client's cap [I>V]
  resp:  a checkpoint is the state of the work as it now stands and names what it supersedes and what it rests on, never the history pasted in, and treecontext's own line saying so is in every first moment, in the subagent-start hook's context and in the ticket door's first message, whether or not the brief repeats it; a checkpoint written past {16000} characters is refused once with the reason and the shape asked for, and a second over-cap write under the same key by the same leg is accepted and marked as over the cap; the ticket door composes the first message with the checkpoint in effect whole and never cuts it; the hooks door injects the brief and as much of the checkpoint as fits under the client's cap, ends with the checkpoint row's id and a line saying how many characters were left out, so the leg fetches the whole by export, and the first-moment row records the cut and the checkpoint's size; a first moment that fits is injected whole, with no query made [I>V]
  spread: a checkpoint of <chars> characters is <verdict> on its first write and <verdict2> on the second
  sib:   none -- a promise that lives in a brief treecontext never writes, so that a harness's own briefs omit it, is what this prevents, not a behaviour
  serves: N29 N27 N31
  touches: D325 D299 D284 D298 D329
# the post-draft pass, 2026-10-31, question 8 of the interactive gate (D324), the legs reviewer's carrier question; option 1 of three chosen (the third "discuss first"). Road not taken: the brief carries it and the dispatch skill writes briefs that say it (a harness writing its own briefs may omit it). The stressing case accepted: one more line in every first moment, counted against the client's cap at the hooks door

D333 2026-10-31 [V]
  resp:  the remaining questions of the interactive gate go through an adversarial review before any reaches the visionary: a question the record can settle, from rulings in effect, the charter or a verified platform fact, is settled there with its derivation written down and ratified at the read; only a question the record cannot settle returns to the visionary, in plain language with the context it needs [V]
  ->     boundary
  serves: N27
  touches: D324 D202
# the gate, 2026-10-31, after eight questions ruled (D325 to D332); the visionary: "these are a little bit too technical for me without more context. can i suggest an adversarial review of these, if they are clean, any of these that cannot be resolved, bring back to me?"; a protocol critique, counted in the run record

D334 2026-10-31 [I]
  trig:  a leg through the hooks door, sent back once, stops again with no checkpoint; or a leg whose start was dropped at an unreachable store stops with the store writable again [I]
  resp:  a leg that ended without a checkpoint after its one send-back is followed by a recovery leg of its role, as a cut leg is: the next leg's first moment says its predecessor ended without a checkpoint, names its lane and starts from the checkpoint still in effect; a leg the store never saw start has no registration and no key marked as its own, so its stop is asked nothing, its summary row lands as today, and no registration is invented for it [I]
  sib:   none -- a twice-failed leg whose successor starts fresh with nothing telling it to read the trail, or a registration invented at a stop, is what this prevents, not a behaviour
  serves: N27 N28 N29
  touches: D279 D291 D316 D314 D326 D305
# the gate's adversarial review under D333, 2026-10-31, question 9, resolved from the record and awaiting ratification: D316 and D291 each read "ended without a checkpoint" as leading to a recovery successor ("so the next leg of its role starts as a recovery leg under D279"), and no ruling makes a successor non-recovery; D326 asks at a stop only for a key marked as the leg's own, which an unregistered leg cannot have, and D314's accepted case says the gap marker is the only thing that says so. Verified: an unregistered stop with an agent type is captured as a subagent summary today and its retire is a no-op (`src/hooks/subagent-stop.ts:65`). Residual, not ruled: whether a write under a key by an unregistered leg should create a registration

D335 2026-10-31 [I]
  trig:  the ticket door's spawner runs a worker once more for its missing checkpoint, as a fresh process [I]
  resp:  the re-run is the same leg in the same lane under the same registration, which records the second process's id and start moment beside the first's, never overwriting them, so a liveness check while the second process runs reads the leg as live; the lane holds one first-moment row, then the first run's rows, then a row with the second run's first message naming the missing checkpoint, then the second run's rows, so what the re-run saw is reconstructable from the store [I]
  sib:   none -- a re-run registered as a new leg and so entitled to a send-back of its own, or a registration that forgets the first process, is what this prevents, not a behaviour
  serves: N27 N31 N32
  touches: D291 D295 D317 D298 D300 D283
# the gate's adversarial review under D333, 2026-10-31, question 13, resolved from the record and awaiting ratification: D295 says the send-back "runs once per leg across both doors, never twice", so a re-run that were a new leg would earn a second send-back; D291 says the re-run "reads its own trail"; D317's liveness check by id and start moment would retire a registration that held only the first process while the re-run is alive; D283 and N31 keep the first process's facts; D298 makes the first-moment row the first row of the lane and D300's skeleton carries one per leg, so the re-run's opening message is a row in the lane, not a second first moment

D336 2026-10-31 [I] amends D289
  trig:  a run's legs have exited and the harness asks, with no model in the loop, for the newest checkpoint of a key on that run; or anyone with the store file reads the run back [I]
  resp:  the harness asks by run and key together and receives the one checkpoint in effect under that key, with its writer, a pointer to the summary row of the leg that wrote it or a line saying that leg left none, and each leg of the run reads as retired or live; the run's rows read back in the order of each row's own moment of capture, never the drain's order, every row naming its writer and its moment, every leg naming its run, its key and its parent session, so each captured row reaches the run and key through its leg's lane rather than carrying them itself, and no row of another run reads back among them [I]
  sib:   none -- a ratified need for the leg's return with no reply that carries it is what this prevents, not a behaviour
  serves: N28 N31 N32 N30
  touches: D289 D284 D285 D301 D330
# the gate's adversarial review under D333, 2026-10-31, question 15, resolved from the record and awaiting ratification: N28 asks for "the newest checkpoint of any leg of its run and that leg's return", and the record fixes a leg's return as the pointer to its summary row (N30's ruled means, D284, D285 "comes back every time, one line"), which D284 makes identifiable by run and key; D289's reply carried the checkpoint, writer and leg states and not the return

D337 2026-10-31 [I]
  trig:  an agent, not a harness through the library, asks for the checkpoint in effect under a key on a run, or declares a run open or closed [I]
  resp:  an agent receives through treecontext's tools the same reply the harness receives, the checkpoint in effect with its writer and flag, the run's facts and the pointer to the leg's return, and declares a run's open and close through the tools with the same record the harness's door leaves; no ninth tool is added, and which of the eight carries each is the design pass's to choose [I]
  sib:   none -- an agent working out "in effect" by judgment from search hits, which N28 exists to keep away from a model, is what this prevents, not a behaviour
  serves: N28 N31 N27
  touches: D301 D302 D309 D296 D336 D312
# the gate's adversarial review under D333, 2026-10-31, question 16, resolved from the record and awaiting ratification: D301 promises the facts to "the harness, or any caller", D302 lets "the harness or main agent" declare a close, and D309 declined a ninth tool; the behaviour is ruled and the carrier is a means below it. Verified: today `treecontext_query` needs a non-empty query and takes a key-value `metadata_filter` (`src/server/server.ts:548`), `treecontext_insert` takes arbitrary metadata minus the stamped keys, and nothing in the server knows a run. The reviewer's recommendation, a run-and-key lookup mode on the query tool and recognised open and close kinds on insert, goes to DESIGN.md as a chosen constraint

D338 2026-10-31 [I] amends D304
  trig:  install or doctor runs where the Claude Code found is older than {2.1.290}, the first release that reads the idle-compaction key, where its version cannot be read, or where it honors the key but has no /config row for it [I]
  resp:  install writes the key only when the client is known to honor it; below the floor or unknown it writes nothing and says the setting is not applicable to this client; doctor's row says the setting is not read by this client and names its version; where the client honors the key but has no /config row, install and doctor name the settings line alone, never a row the client lacks; an install run later on an upgraded client writes it then [I]
  spread: a client at <version> gets <written> and doctor says <row>
  sib:   none -- a remedy naming a /config row the client does not have is what this prevents, not a behaviour
  serves: N1 N23
  touches: D304 D290 D276 D208
# the gate's adversarial review under D333, 2026-10-31, question 18, resolved from the record and awaiting ratification: D290 orders the two remedies and its own note records the /config row from `2.1.302`, while D304's principle is that nothing is reported that does not hold for this client, so the settings line alone is the only honest remedy between `2.1.290` and `2.1.301`

D339 2026-10-31 [I] amends D319
  trig:  the retention valve runs and a ticketed worker's session holds its first-moment row [I]
  resp:  the door writes the first-moment row as the worker's capture, so the valve treats it as it treats captured tool output: when the session cap evicts the worker's session, the row is archived whole with the rest of that session, fsynced before any row moves; when the store is over its byte budget, the row may be demoted to its bounded preview, archived first, with its full length and archive path on the row; a checkpoint, a summary row and the run's open and close are agent-authored and stay protected; an archived or demoted first moment is read from the archive, as any archived capture is [I]
  sib:   none -- a first-moment row kept forever because the door's writes count as notes, or a ruling that has the byte budget evict whole sessions against the storage charter, is what this prevents, not a behaviour
  serves: N23 N27 N29
  touches: D319 D313 D48 D55 D141 D169
# the gate's adversarial review under D333, 2026-10-31, question 19, resolved from the record and awaiting ratification: D319 as ruled had the byte budget archive whole sessions, while D48 in effect makes the session cap the eviction and the byte budget a demotion backstop (journal-storage's retention paragraph; `src/flat-store.ts` evicts by `maxSessions` and over budget runs demotion only, both skipping protected rows at L211); a ticketed worker has a session of its own, so its lane is a session for the valve. Left to the design pass: which demotion class a first-moment row falls in

D340 2026-10-31 [I>V] amends D316
  trig:  a ticketed worker exits with no checkpoint under its key, and its ticket declares that it has no door, declares that it has one, or says nothing about it [I>V]
  resp:  the ticket declares whether the worker has a way to write, as it declares everything else; a worker declared door-less gets no send-back, its last output lands as its summary row, and the leg is retired as ended without a checkpoint, visibly, so the next leg of its role starts as a recovery leg; a worker declared to have a door keeps the one send-back of D291; a ticket that says nothing about the door is read as declaring one, so the send-back is on by default as D279 and D291 have it, and the cost when the guess is wrong is one run, the cost D316 already accepted for a ticket that mis-declares [I>V]
  sib:   none -- a capable worker that forgot its checkpoint and never gets the reminder because its ticket left a field out is what this prevents, not a behaviour
  serves: N27 N28 N31
  touches: D316 D291 D279 D303
# the gate, 2026-10-31, question 12 of the pass, returned to the visionary in plain language under D333 (the record could not decide a default); option 1 of four chosen (the fourth "discuss first"). Roads not taken: assume door-less (a capable worker never gets the reminder); a silent ticket is broken under D303 (the whole spawn lost whenever a harness leaves the field out)

D341 2026-11-01 [I>V]
  trig:  a ticket that reads whole names its run and role and either says in words that the worker has no key, or leaves the key blank [I>V]
  resp:  a ticket that says in words the worker has no key starts a one-off worker: registered in its own lane under its declared parent with its role as writer, summarised and retired at exit, never sent back, counted in the run's facts as a keyless leg, as a keyless subagent is through the hooks door; a ticket whose key is merely blank is damage, read as D303 reads an unreadable ticket, so the worker writes one row saying its instructions were invalid and stops; a one-off is declared, never inferred from an empty field [I>V]
  sib:   none -- a harness that forgot the key by mistake getting a worker that runs as if nothing were owed, is what this prevents, not a behaviour
  serves: N32 N27 N28
  touches: D303 D305 D288 D326 D340
# the gate, 2026-11-01, question 11 of the pass, returned to the visionary in plain language under D333; option 3 of four chosen (the fourth "discuss first"), against the interviewer's recommendation of reading a blank key as a one-off. Roads not taken: a blank key as a one-off helper (a harness that forgot the field gets a worker that owes nothing); a blank key as damage with no explicit one-off at all (a harness that wants a quick headless lookup cannot use the ticket door). The stressing case accepted: one more field every harness must get right, and a ticket minted by an older treecontext that never knew the field reads as damaged

D342 2026-11-01 [I>V] amends D303
  trig:  a worker starts with a ticket in its environment that the door, the hook on `claude -p` or the server on a hook-less CLI, cannot read whole: hand-edited, truncated, or minted in another shape by an older treecontext; and the harness later asks how that worker ended [I>V]
  resp:  the worker is registered in its own lane with every field the door could read, each unreadable field marked absent and the raw ticket text kept on the registration, never as a self; its first moment is the statement that its instructions were invalid and the ask to write one row saying so and stop; the worker does no work; the leg ends visibly as having had no valid instructions: the spawner is told so in the line it receives at the worker's exit, and the lookup lists the worker under the run, or the run and key, its ticket still named, while a worker whose ticket named neither is reachable only through that exit line and the parent it declared; the store matches nothing against the raw text; the harness decides whether to mint again; a spawner that sees the fault before spawning writes that row itself and spawns nothing [I>V]
  sib:   none -- a worker guessing at instructions it could not read, or a lookup that searches garbled text for the run the harness asked about, is what this prevents, not a behaviour
  serves: N32 N27 N28
  touches: D303 D289 D330 D294 D293 D336
# the gate, 2026-11-01, question 10 of the pass, returned to the visionary in plain language under D333 (D303 promised "the harness's lookup says so" while D289's lookup is by run and key, the fields that were garbled); option 1 of four chosen (the fourth "discuss first"). Roads not taken: search the kept raw ticket text for the asked run and key (fuzzy matching in a store that never judges, D293); a lookup by parent or by process (a new door, wider than D289's). The stressing case accepted: a worker whose ticket lost both run and key is invisible to every lookup and known only from its exit line and its declared parent

D343 2026-11-01 [I>V] amends D310
  trig:  a run's legs write into more than one store, and a checkpoint imported from another store under a handoff lane names a local checkpoint of the same run and key as the one it supersedes [I>V]
  resp:  a run is reconstructable whole no matter how many stores its legs wrote into; a leg in a worktree of the same repository writes into the run's store as today; a leg that ran elsewhere writes into that place's store and comes back by the handoff, a run export from there imported into the run's store under a handoff lane, after which the run's facts and a key lookup count its checkpoints as the run's; an imported checkpoint's claim that it supersedes a local checkpoint is believed by the key lookup: the imported one comes back as the one in effect, flagged as arrived by import, as D296 flags a stranger, and the local checkpoint is untouched, no longer the newest, still readable, its lane's pointers unchanged by any other lane's writer; the claim stays recorded as the file's claim, not promoted to identity; whether a worker ever gets a store of its own stays with the design pass under D323 [I>V]
  sib:   none -- every run with a remote leg ending in a tie the harness must break by itself, on the one path the record promised would work across machines, is what this prevents, not a behaviour
  serves: N27 N28 N22 N32
  touches: D310 D323 D165 D169 D280 D296 D300 D336
# the gate, 2026-11-01, question 14 of the pass, returned to the visionary in plain language under D333 (D165 keeps a handoff file's claims as data while D310 counts imported checkpoints as the run's, and D280 returns two in effect); option 1 of four chosen (the fourth "discuss first"). Verified: import keeps the file's node id (`src/flat-store.ts`, importJson, `fileId ?? randomUUID()`), so a claim naming a local checkpoint resolves to it; the import turns a claimed `supersedes` into `refs` and keeps the claim under `_handoff_claims` (`src/handoff.ts:95`), which this ruling leaves as is and reads at lookup. Roads not taken: never believe it, both stay in effect (every cross-machine run stalls on a tie); believe it only when it names the local checkpoint and carries the next number (stricter, more machinery). The stressing case accepted: a tampered handoff file can name a local checkpoint as superseded, and the flag is what makes that visible, not what prevents it

D344 2026-11-01 [I>V] amends D301
  trig:  the harness, or any caller, asks for the checkpoint in effect under a key on a run [I>V]
  resp:  the reply carries the run's facts beside the checkpoint: how many legs have run on the run, how many checkpoints sit under this key, how long ago the run started, and the sizes of the last {3} checkpoints under the key; treecontext judges none of it, the harness reads the numbers and decides whether to spawn again, and a human gate is the harness's to build [I>V]
  why:   {3} was the interviewer's draft number in the runs file, put to the visionary at the gate and chosen over {5} and a deferred value: enough to see a trend, small enough to read in one line [I>V]
  spread: a key with <count> checkpoints returns the sizes of the last <shown>
  sib:   none -- a run that loops until someone looks, with the facts that would have shown it sitting unread in the store, is what this prevents, not a behaviour
  serves: N28 N27 N31
  touches: D301 D312 D336 D337
# the gate, 2026-11-01, question 17 of the pass, the one quantity the interviewer had written without putting it; option 1 of four chosen (the fourth "discuss first"). Roads not taken: {5} (a longer trend, a longer line); marked TBR until the build shows what a harness needs

D345 2026-11-01 [V] ratifies D283
  resp:  the reopening condition of the faithful-journal assumption stands as the visionary's: a ruling that would have the store synthesize, rewrite or drop a row's writer or moment, let a lookup return what the journal does not hold, or let a leg's rows enter without the writer and moment the rest of the journal carries, reopens it [V]
  ->     structural
  serves: N27 N32
  touches: D283
# the read's ratification, 2026-11-01, "Ratify all eight", item 8; the Named-assumption fence entry drops its "unratified" note

D346 2026-11-01 [V] ratifies D334
  resp:  after any end without a checkpoint the next leg of the role starts as a recovery leg, and a leg the store never saw start is asked nothing at its stop, as D334 reads [V]
  ->     structural
  serves: N27 N28 N29
  touches: D334
# the read's ratification, 2026-11-01, item 1

D347 2026-11-01 [V] ratifies D335
  resp:  a worker's re-run for its missing checkpoint is the same leg in the same lane under one registration that records both processes, as D335 reads [V]
  ->     structural
  serves: N27 N31 N32
  touches: D335
# the read's ratification, 2026-11-01, item 2

D348 2026-11-01 [V] ratifies D336
  resp:  the key lookup's reply carries the pointer to the return of the leg that wrote the checkpoint, or a line saying it left none, as D336 reads for the whole chain of D289 [V]
  ->     structural
  serves: N28 N30 N31 N32
  touches: D336 D289
# the read's ratification, 2026-11-01, item 3

D349 2026-11-01 [V] ratifies D337
  resp:  an agent receives through the eight tools the same lookup reply the harness receives and declares a run's open and close through them, the carrier the design pass's, as D337 reads [V]
  ->     structural
  serves: N28 N31 N27
  touches: D337
# the read's ratification, 2026-11-01, item 4

D350 2026-11-01 [V] ratifies D338
  resp:  a client that honors the idle-compaction key but has no /config row is pointed at the settings line alone, as D338 reads for the whole chain of D290 [V]
  ->     structural
  serves: N1 N23
  touches: D338 D304 D290
# the read's ratification, 2026-11-01, item 5

D351 2026-11-01 [V] ratifies D339
  resp:  a worker's first-moment row is the worker's capture to the retention valve, evicted with its session under the session cap and demoted under the byte budget, while checkpoints, summary rows and the run's open and close stay protected, as D339 reads for the whole chain of D319 [V]
  ->     structural
  serves: N23 N27 N29
  touches: D339 D319 D313
# the read's ratification, 2026-11-01, item 6

D352 2026-11-01 [V] ratifies D332
  resp:  the checkpoint chain stands as D332 reads: state not history said in every first moment by treecontext's own line, the cap refused once and accepted marked on the second write, the ticket door composing whole, the hooks door cutting at the client's cap with the row id to fetch the rest [V]
  ->     structural
  serves: N29 N27 N31
  touches: D332 D325 D321 D299
# the read's ratification, 2026-11-01, of the chain the gate amended under the visionary's own ratification of D299 (D321); items 1 to 8 ratified in one answer, "Ratify all eight", the ledger ladderings of N28 and N31 (item 7) among them, which carry no entry of their own

D353 2026-11-01 [I] amends D331
  trig:  a leg writes a checkpoint under its key that names nothing as superseded, having already written one or more checkpoints under that key on that run since it started [I]
  resp:  the store stamps the checkpoint as superseding the leg's own newest checkpoint under that run and key, and only when the leg has written none there, the checkpoint(s) it started from as read from its registration; the stamp is marked as the store's as D331 has it, and a checkpoint that names another is taken at its word as before; the start checkpoints are used only when the checkpoint's run and key are the leg's registered ones, so a leg writing under another key gets no supersession stamped from a different key's chain [I]
  sib:   none -- D331's own sib, a forgetful leg leaving a pile of checkpoints in effect under one key, which the literal "started from" reading would produce on the leg's second write
  serves: N28 N29 N32
  touches: D331 D329 D280 D283
# the build, 2026-11-01, unit 1's failure-ladder review (finding 4): one leg writing 4 then 5, both naming nothing, left 4 and 5 in effect under the literal reading, the pile D331's sib clause names as what it prevents; resolved from the record under D333 and awaiting ratification. The fact stamped is in the journal (the leg's newest checkpoint under the key, by its writer stamp), nothing synthesized (D283). Verified at the gate against the SQLite file: n=4 ["3"] store, n=5 ["4"] store, in effect [5]; two legs from one checkpoint still write 4 and 5 both superseding 3, both in effect (D329). Code: src/runs.ts storeSupersedesFor

D354 2026-11-01 [I]
  resp:  the open row the store writes at a leg's registration carries the store itself as its writer, `treecontext`, with writer source `store`, the registering leg named as the run's first leg, and `opened_via` as `registration`; an explicit open carries the harness or agent that declared it; the store's own name is escaped like the client's so no subagent type can join its lane [I]
  ->     structural
  serves: N28 N32
  touches: D302 D309 D283 D293 D263
# the build, 2026-11-01, unit 1's decision at build endorsed by its review: D283 forbids crediting a writer that did not write the row, and D294 allows a declared parent that leaves no row of its own; the client's own reports already carry the client as writer (D263), so the store's own row carries the store. Written within the registration's immediate transaction so two first legs at once open the run once. Awaiting ratification

D355 2026-11-01 [V] ratifies D353
  resp:  the build's reading stands as written: a checkpoint naming nothing supersedes its leg's own newest checkpoint under the key, else the one(s) it started from, stamped as the store's [V]
  ->     structural
  serves: N28 N29 N32
  touches: D353 D331 D283
# the visionary, 2026-11-01, at unit 1's gate, "Ratify both" to the two put in plain words (the pile a forgetful leg would leave; a row nobody but the store wrote), under D333's rule that gate questions are resolved from the record first and brought back only with their derivation

D356 2026-11-01 [V] ratifies D354
  resp:  the open row the store writes at a leg's registration carries the store itself as its writer, as D354 has it [V]
  ->     structural
  serves: N28 N32
  touches: D354 D302 D283
# the visionary, 2026-11-01, at unit 1's gate, the same "Ratify both" as D355

D357 2026-11-01 [I] amends D264
  resp:  the query tool keeps its promise of no new parameter for orientation, and carries the one parameter the agent's door to a run needs, `key_lookup`, a run and a key together, which returns the harness's lookup reply in place of hits and is no orientation parameter; with it the free-text query may be omitted, without it an empty or missing query is refused as before, and a call that gives both is refused naming both; the handshake's second session-start step, the ranking order the skill reference states, and the orientation query's own reply are unchanged [I]
  ->     structural
  serves: N31 N28 N14
  touches: D264 D337 D349 D309 D261 D272 D287
# the build, 2026-11-01, unit 2's failure-ladder review (finding 4): D264's declined alternative was "an orientation parameter on the query tool, new surface overlapping what the defaults now deliver", and its scenario pins "no parameter for orientation"; D337 (ratified D349) hands the agent's door to the design pass, which chose "a run-and-key lookup mode on the query tool" (DESIGN.md, [chosen]), and D309 declines a ninth tool; a mode needs a selector, and the selectors already in the record (a hidden mode in the query text, or metadata_filter) would be a worse surface than one honest parameter. The pin in the agent-surface steps admits exactly this one parameter by its constant. Resolved from the record under D333 and awaiting ratification

D358 2026-11-01 [I]
  resp:  the hooks door writes its own rows through the library directly, from the hook's own process: the leg's registration, the run's open at that registration, the first-moment row, the send-back row and the leg's summary row at its stop, each inside the transaction the rule that creates it requires; the platform's events a hook captures, the user's turns, the tool calls, the assistant's turns and a plain subagent's summary, still stage and the drain still writes them with its honest timestamps, dedup, byte valve and dead letter; a hook whose store cannot be written as the journal, by refusal, lock or schema skew, writes a gap line beside the store that the drain turns into a visible capture-gap row, never a silent cold start [I]
  ->     structural
  serves: N27 N29 N30 N32
  touches: D298 D302 D329 D330 D354 D190 D265 D314 D4 D8
# the build, 2026-11-01, unit 4's gate on its failure-ladder review: the pointer to a leg's return must name the summary row's id when the Agent tool returns, milliseconds after the stop and inside the drain's tick (D330), and the one send-back must be counted atomically with its row across both doors (D295), so these rows cannot wait for the drain; hooks already write the registry directly (D190) and the ticket door writes the same rows from its own process (unit 3); the library is first and the server one consumer (AGENTS.md decision 5). Measured at the review: no exclusive store lock exists, only role leases the hook does not take; the hook's store never sweeps, never migrates, leaves the hook's pragmas; SubagentStart 71 → 81 ms with no brief, 96 ms with one. Conditions attached at the gate: the change stated plainly in the CHANGELOG, AGENTS.md and ARCHITECTURE.md; a schema-skewed store marked as a gap; the stop-side lock budget no worse than before; brief inference scoped to the resolved namespace. Awaiting ratification

D359 2026-11-01 [I] amends D299
  trig:  a leg, a worker, a session's self or a writer the store cannot name writes a checkpoint past the cap under a run's key; or such a write lands while the writer stamp is not exact [I]
  resp:  the cap refuses a writer the store identifies exactly as a leg, a worker or the session's self, the leg or designated checkpointer that D299 names; a writer with no registration is never refused, its over-cap checkpoint is accepted and marked as over the cap, and the store keeps no ledger of refusals outside the registry; a refusal made while the writer stamp was not exact (provisional, concurrent, ambiguous) is recorded as pending with its candidates and names nothing, the insert reads the session's own staged insert echoes first to tell the writer exactly where it can, the echo heal at the drain moves a pending refusal to the writer the echo names and settles that leg's key as its own through the same settle the heal can undo, and a second over-cap write whose writer still cannot be told is refused again with the candidates named, never accepted blind, the write after the heal being accepted as the second; the insert tool's content bound of `50000` characters does not apply to a checkpoint under a run's key, which the cap governs and the reply ceiling bounds [I]
  sib:   none -- a refusal credited to a leg that wrote nothing, an over-cap row accepted on a guess, or a cap that binds at the tool's door, is what this prevents, not a behaviour
  serves: N27 N29 N31 N32
  touches: D299 D321 D326 D283 D293 D287 D353 D357
# the build, 2026-11-01, unit 5's gate on its failure-ladder review (findings 1, 3, 4, 5): the cap's memory had followed the insert-time stamp, so with two legs live the other leg's first over-cap write was accepted and the refused leg was never sent back, the defect class units 1 and 2 were overturned for; a store_config ledger keyed by writer text had been added for registration-less writers, a writer no scenario or ruling names; and the <chars> outline's 300000 row could not pass the tool's 50000 bound, a binding cap D321's road not taken rejects. Resolved from the record under D333: D299's trigger names a leg or its designated checkpointer, so an identity the store cannot name is outside the cap and D293 judges nothing about it; the pending-with-candidates rule the run rows already follow (unit 2) and the stop hook's reading of staged echoes (unit 4) carry the refusal to its writer; a refusal leaves no row and can be repeated, while an accepted row cannot be unmade, so uncertainty refuses; no scenario pins the 50000 bound, which stays for every other row. Awaiting ratification

D360 2026-11-01 [I] amends D343
  trig:  a run's rows arrive by import: its briefs, its open and its close, its checkpoints with the numbers another store gave them, and its legs' registrations as the file carried them [I]
  resp:  a run's skeleton carries the rows D309 makes the run of, its open and close, every brief, every checkpoint, every first-moment row and every summary row, and each leg's registration as data whose writer is the store's own name; on import every one of them is a review of what happened elsewhere and never a replay here: an imported brief is in effect for no role and an imported close ends no brief in the receiving store, both read back as imported with the run's rows and in the key lookup's facts; an imported checkpoint keeps the number its own store gave it as the file's claim, said as such by the lookup, takes no number in the receiving store's sequence and collides with none, while its supersedes claim is believed and flagged as D343 has it; the sender's writer stamps and trace keys sit under the file's claims with the rest, never at the top level, the receiving store stamping only that the row arrived by import and from where; a registration the receiving store already holds is already present only when its facts agree, and one that differs lands as an imported registration row saying so; a run's inner runs are not carried by its skeleton and the file's head names them so the importer knows what it does not hold [I]
  sib:   none -- a brief that arrived in a file spawning legs here, a close in a file ending work here, two checkpoints numbered alike under one key, or a sender's door and identity read as the receiver's own, is what this prevents, not a behaviour
  serves: N22 N27 N28 N32
  touches: D343 D300 D309 D310 D311 D327 D329 D293 D283 D354 D165
# the build, 2026-11-01, unit 6's gate on its failure-ladder review (findings 1, 2, 3, 5, 6, 7): the import rule had let `_writer_src`, `_door`, `_identity`, `_cwd`, `_parent` and `_supersedes_src` land at the receiving store's top level as if it had stamped them; an imported brief made the next local subagent of its role a leg of the file's run and an imported close ended local briefs; an imported number 2 beside a local number 2 gave the lookup two number 2s; the skeleton carried briefs and open and close beyond D300's list with no ruling. Resolved from the record under D333: D300's sib is "a run they wanted to review, not replay"; D327's brief is in effect "on an open run", a run of the store it is in; D343 keeps every claim the file's claim and never promotes it to identity, which decides the number and the stamps; D293 makes the trace the control, so a sender's trace is evidence about the sender; D354 gives a row the store composes the store's own name; D311's inner runs reach each other by name, which the head carries. Awaiting ratification

D361 2026-11-01 [I] amends D290
  trig:  install runs where the user's settings already carry the idle-compaction key, set to anything; or uninstall runs where install once wrote that key [I]
  resp:  install says nothing about a key the user has set, on, off or anything else, on this run or any later one, and writes nothing; its one line belongs to the run that wrote the key; doctor is where a key set to on is seen, with the remedy D290 and D338 give; install records in treecontext's own install state that it wrote the key and into which file, and uninstall removes the key only when that record exists and the file still carries the value install wrote, so a value the user set, or set since, is never touched and a client is never left with a setting install chose after treecontext is gone; the README's install section, the section that gives the install command and that D276 reads, says in one sentence that install turns idle compaction off, why, and where to turn it back on [I]
  sib:   none -- install recommending off on every reinstall against a setting the user chose, or uninstall leaving the client with a setting it never asked for, is what this prevents, not a behaviour
  serves: N1 N23
  touches: D290 D304 D338 D51 D276
# the build, 2026-11-01, unit 8's gate on its failure-ladder review (findings 1, 4, 6): the build had install print a "left alone, recommends off" line on every run for a user-set key, reading the scenario "a client that honors the key but has no /config row is pointed at the settings line alone" whose install clause asks for "where to turn it back on" with the key already on, a contradiction in the scenario's own words; uninstall left `idleCompaction: false` behind; the README paragraph sat in section 3 where D276's tester reads section 2. Resolved from the record under D333: D290 says install "never writes the key when the user has set it, on or off" and its sib declines "fighting it on every reinstall"; D51's uninstall removes what install wrote and leaves foreign keys; D290 forbids touching a value the user set, so only install's own record can tell its key from the user's; D276 names section 2 as the install section. The scenario's install clause is a charter defect for the owner to amend (split: the key absent at 2.1.295 is written off and the line names `"idleCompaction": true` with no /config row; the key on at 2.1.295 is doctor's settings-line-only row); until then that scenario stays open. Awaiting ratification

D362 2026-11-01 [V] ratifies D357
  resp:  the query tool carries `key_lookup`, a run and a key together, returning the harness's lookup reply in place of hits, and no parameter for orientation, as D357 reads D264 [V]
  ->     structural
  serves: N31 N28 N14
  touches: D357 D264 D337 D349
# the visionary, 2026-11-01, at the final gate over the ten units, "Ratify all five" to the five put in plain words (a lookup on the query tool; the hooks writing a leg's own rows; the cap refusing only a writer the store can name; an imported run a review, never a replay; install silent about a key the user set), under D333's rule that gate questions are resolved from the record first and brought back only with their derivation

D363 2026-11-01 [V] ratifies D358
  resp:  the hooks door writes a leg's own rows directly through the library, each in the transaction of the registration fact it belongs to, every platform event still staged and a refused write a visible gap, as D358 has it [V]
  ->     structural
  serves: N27 N29 N30 N32
  touches: D358 D298 D302 D330 D314
# the visionary, 2026-11-01, at the final gate, the same "Ratify all five" as D362

D364 2026-11-01 [V] ratifies D359
  resp:  the cap refuses only a writer the store identifies exactly, a refusal made under a non-exact stamp is pending with its candidates until the call's echo moves it to its writer, a second write still unattributable is refused again and never accepted blind, and the tool's content bound does not apply to a checkpoint under a run's key, as D359 reads D299 [V]
  ->     structural
  serves: N27 N29 N31 N32
  touches: D359 D299 D321 D326
# the visionary, 2026-11-01, at the final gate, the same "Ratify all five" as D362

D365 2026-11-01 [V] ratifies D360
  resp:  a run that arrives by import is a review of what happened elsewhere and never a replay: an imported brief is in effect for no role, an imported close ends no brief, an imported checkpoint keeps its sender's number as a claim and takes none here, the sender's stamps and trace sit under the file's claims, and a registration that differs lands as an imported row saying so, as D360 reads D343 [V]
  ->     structural
  serves: N22 N27 N28 N32
  touches: D360 D343 D300 D310 D311
# the visionary, 2026-11-01, at the final gate, the same "Ratify all five" as D362

D366 2026-11-01 [V] ratifies D361
  resp:  install says nothing about an idle-compaction key the user set and writes nothing, records the key it wrote and into which file, and uninstall removes that key only when the record exists and the file still holds install's value, the README's install section saying why in one sentence, as D361 reads D290 [V]
  ->     structural
  serves: N1 N23
  touches: D361 D290 D304 D338 D51 D276
# the visionary, 2026-11-01, at the final gate, the same "Ratify all five" as D362

D367 2026-11-01 [V] amends D338
  resp:  the scenario "a client that honors the key but has no /config row is pointed at the settings line alone" is split in two, since its install clause asked for a line of a run where the key was already on, which D361 rules out: with the key absent, install writes it off and its one line names the settings line, `"idleCompaction": true`, as where to turn it back on and no /config row; with the key on, doctor's row warns with the settings line only; both halves bind and the file has no open scenario [V]
  ->     structural
  serves: N1 N23
  touches: D338 D361 D366 D290 D304
# the visionary, 2026-11-01, at the final gate over the ten units, "Split as proposed" to the two halves shown in full (the register comment under D361 had proposed exactly this split); the charter edit is the owner's, made in the gate session with its bindings

D368 2026-11-01 [V] amends D318
  resp:  after the first-moments line the export's reply carries one line naming each leg whose first-moment row is the hooks door's own line and not a prompt, quoting that its prompt rode on the Agent tool and was not seen by the door, and naming no other leg; the file's head carries the same line; a run with no such leg has no such line [V]
  ->     structural
  serves: N31 N28
  touches: D318 D300 D330 D360
# the visionary, 2026-11-01, at the final gate over the ten units, "Approve as written" to the unit 11 charter draft (the bindings audit's owner items: thirteen scenarios the words did not reach, the `claude -p` child's identity line once its probe was described as one line naming who it is and its first-moment row and never the first moment again, the phantom outline's ticket-door row, the @D360 tag on the skeleton scenario, and the two `claude -p` rows' wording). Unit 6 had added the reply's second line (`door_lines`) with no ruling naming it, which the audit found (M9); this ruling names it

D369 2026-11-01 [V] amends D285
  resp:  the pointer to a leg's summary row comes back every time the Agent tool returns the leg; a leg launched in the background, whose PostToolUse fires at the launch and whose return is the platform's task notification that no hook touches, gets no pointer line, its summary row landing and the key lookup finding it as for any leg; declined to the fence, reopening if the client grows a hook on the notification or the owner asks for late delivery at the parent's next hook [V]
  ->     fence-declined background-leg-pointer
  serves: N30 N27
  touches: D285 D330 D284
# the visionary, 2026-11-01, at the final gate over the ten units, "Fence it: no pointer for a background leg" to decision 4 of the gate's queue (the three roads shown: fence it; deliver it late at the parent's next UserPromptSubmit or PostToolUse, new design and a build before release; leave the CHANGELOG disclosure alone). Unit 4 had disclosed it in the CHANGELOG with no ruling; verified there: Claude Code's Agent tool returns `status: "async_launched"` at the launch and the subagent's final report arrives as a task notification

D370 2026-11-01 [V] amends D153
  resp:  the documentation carries a second compatibility matrix, the orchestration matrix, its own table apart from the hook-support matrix: one row per client (Claude Code, Codex CLI, Antigravity CLI, the last reinstated as a row of the matrix only, no agent entry), one column per orchestration role (a headless worker through the ticket door; the worker's pen, how treecontext's tools reach it; the worker's own tool calls captured; a main that registers itself and spawns workers; subagent legs through the hooks door; the pointer on the Agent tool's return), every cell one of `verified live`, `verified through a stand-in`, `documented only` or `not possible`, each with the date or release it was checked against, a `not possible` cell naming the vendor's gap; for `0.1.0-beta.3` Claude Code is the primary client and Codex CLI and Antigravity CLI are secondary, headless workers through the ticket door with the pen as the matrix says it reaches them; `0.1.0-beta.3.1` targets every cell the client makes possible, verified live, parity being the matrix filled rather than a word; capture stays promised only where verified live (D153) and the archived-build platforms stay out of the agent table (D109) [V]
  ->     structural
  serves: N23 N31 N27 N32
  touches: D153 D152 D109 D30 D288 D294 D295
# the visionary, 2026-11-01, at the final gate's discussion of the secondary-client story: "for beta.3 i think it is reasonable to document claude code primary and codex and agy are secondary to start as a mvp/poc, with the roadmap to be eventual parity"; then "client differences between claude code, codex, and agy most likely will need a compatibility matrix table of some sort. but beta.3.1 will target the maximum currently supported functionality within that matrix?"; then "yes, record it as one ruling and run the live worker runs. i think the table should be new - too much data in one table sounds confusing." Verified at the gate: Antigravity CLI 1.4.12's hooks (antigravity.google/docs/hooks, read 2026-11-01) live in `~/.gemini/config/hooks.json`, carry camelCase payloads (`conversationId`, `workspacePaths`), inject context through `injectSteps`, and have no SubagentStart, SubagentStop or PreCompact event, so its subagent-legs cell is `not possible`; its MCP servers are added with `agy mcp add`; install writes nothing for it. Codex CLI's hook set (README matrix, checked 2026-10-05) includes SubagentStart and SubagentStop. Roads not taken: parity written as a README sentence alone (moves the clients fence in spirit with no ruling); the orchestration roles as columns of the hook-support matrix (one table with two kinds of fact, the visionary's "too much data in one table")

D371 2026-11-02 [V] amends D8
  resp:  a client's way of handing a subagent's report to its hooks is a pinned payload shape below the feature layer: the words of the summary and pointer scenarios (D147, D284, D336) do not change for it; their bindings deliver the report the way the reference platform now does and the architecture document records the shape; the hook reads the report from where the client put it, the `message` of the newest `SubagentHandback` call in the subagent's own transcript when it made one, else the payload's `last_assistant_message`, else the transcript's last assistant text, a hand-back's closing text never standing as the summary [V]
  ->     structural
  serves: N14 N27 N30
  touches: D8 D190 D147 D284 D336 D369
# the visionary, 2026-11-02, at the beta.3 smoketest on the desktop: "i would fix it - people will be upgrading to this version of claude code soon enough - although can we ascertain if the behavior is bugged or intended?", then "make sure to update any scenarios if needed, although this sounds like an architecture.md thing and below the feature file layer". Ascertained intended and documented: Claude Code's hooks reference (read 2026-11-02) says that on 2.1.271 or later a subagent running with the SubagentHandback tool, provided in auto mode, "delivers its report through that tool rather than returning it as text", that `last_assistant_message` then holds its closing text, if any, and that the report is the call's `message`; the tools reference gates the tool to auto mode and local non-fork subagents. Seen live on 2.1.316: the smoketest's hooks-door leg (agent a268240633a3587fa) ended with three tool_use-only turns, its stop hook logged "leg retired with its return {summary: null}", and the report survived only as the captured SubagentHandback tool row; two headless `claude -p` probes in default mode had no hand-back tool and carried the report in `last_assistant_message`. The two shapes are both live, so the D147 and D284 bindings deliver through the hand-back (the first with a closing text that must not become the summary) and the rest of the stop scenarios through the text. Roads not taken: two new scenarios naming the hand-back tool in owner language (drafted and withdrawn: a platform's plumbing, not a promise); staging the summary from the PostToolUse hook matched on SubagentHandback (the docs' suggestion; it would split the leg's summary row from the retirement the hooks door writes in one transaction, D334); treating a missing report as a gap row (nothing was lost: the report is in the transcript the payload names)

D372 2026-11-02 [I] amends D242
  trig:  a session calls status, registered in the main checkout, in a linked worktree, a worker of the ticket door, or one the server cannot place [I]
  resp:  a session registered in a linked worktree calls status and sees the live pointers of that worktree's own lane, with a `scope` block naming the lane, the count of other lanes' live pointers left out and how to widen; a session registered in the main checkout sees the same, scoped to the main lane, under the same block; in either case the block also says how many other lanes hold live pointers and names at most {3} of them, the most recently active first, each with the kind and age of its newest live pointer and the count of its live pointers, never its text or id, the lane of pointers whose writer could not be identified named "writer unknown" among them and never any lane's own; the own list keeps the cap D166 sets, with the total stated; `scope: "all"` lists every lane's pointers flat as before, each pointer naming its lane, with no block; a worker of the ticket door sees every lane flat, the block naming it a worker; a session the server cannot place sees every lane flat, the block saying it could not be placed; a session whose caller cannot be told apart from a live subagent is scoped to its self as before, since status has no caller but the session [I]
  sib:   none -- a main checkout orienting on a worktree's chapter because it was newest in a flat list is the confusion D167 removes, not a behaviour
  spread: the other lanes are counted and at most three named with <lanes> other lanes
  serves: N23 N24 N20 N5
  touches: D242 D167 D190 D243 D169 D166 D158 D240 D288
# the owner's incident, 2026-11-02, on another machine's store: two Claude Code sessions on one store and one repo, A in the main checkout (documentation), B in a linked worktree (a new subproject); A quit and restarted while B wrote a chapter summary; the restarted A oriented on B's chapter as its own thread and recovered only by replaying its own transcript. D242 scoped the worktree's status and left main's flat, every lane newest first, the writer inside raw metadata only: the road the fence declines, "re-orienting from the project's newest chapter regardless of who wrote it" (D167), live in the build for the main checkout since D242. A first draft kept main unscoped and labelled; the owner reversed it: "fundamentally, i do not see a difference between "main" and a worktree - they are all reflections and separate spaces within the store. So labeling each writer, including main, would make searching/filtering very easy, yes? A) be aware of other lanes or namespaces or checkouts … when main starts, but no need to auto fill - would get messy if there are a 1000 worktrees." The lane names stay the filesystem's: "my idea of labeling by branch won't work then. i think the worktree: nomenclature will ahve to do since it's the file system truth." On the worktree half carrying full scenarios: "D) I believe that git worktrees are fairly fundamental unit for subagents and should be fully described in feature file scenarios." Residual, disclosed: two sessions in one main checkout share one self by D167 [V], so a peer main session's chapter is this session's own thread by ruling, not a defect. Roads not taken: main unscoped with its own pointers labelled and the other lanes' chapters listed apart (the first draft; the orchestrator's convenience bought with the peer's confusion, and content auto-filled against the owner's A); a flat list labelled by writer in each preview (order still says "newest is yours"); naming other lanes without a cap (a thousand worktrees); asking the main session at start whether it orchestrates (an interactive gate, and the answer changes mid-session)

D373 2026-11-02 [I] amends D236
  trig:  a session starts in a linked worktree or in the main checkout other than by a /clear, at a startup, a resume or after a compaction alike [I]
  resp:  a session starting in a linked worktree opens its packet with that worktree's own thread: the newest live chapter summary whose `_writer` is `worktree:<name>`, from any session that ran there, labeled as the worktree's own with its age and referrers; and the brief addressed to it, the newest entry whose metadata `brief_for` names the worktree, with its writer and age; a session starting in the main checkout opens its packet the same way: a line saying it runs in the main checkout and re-orients on the main lane's own thread, the main lane's newest live chapter summary labeled as its own with its age, id and referrers, and the brief addressed to `main` when one exists; either lane with no chapter summary of its own but a live bookmark is handed that bookmark named as a bookmark with its age and id, and says no chapter summary exists; a lane with neither says it starts fresh; the brief is the means of "the orchestrator injected the brief at its start": an entry the orchestrator writes through the insert tool before the worktree's first session; the packet then says how many other lanes hold live pointers and names at most {3}, the most recently active first, each with the kind and age of its newest live pointer, and where to look, status with `scope: "all"` and export by writer, never another lane's text or id, and nothing when no other lane holds one; the self lines stay outside the start's budget, each bounded: the chapter by its first line, the other lanes by the count and the names; the /clear packet is unchanged [I]
  sib:   none -- a packet that hands a session another lane's chapter, labelled or not, is the anchoring this prevents, not a behaviour
  spread: the other lanes are counted and at most three named with <lanes> other lanes
  serves: N23 N24 N20 N5
  touches: D236 D167 D372 D160 D162 D190
# the incident of D372. D236 had left the main checkout's fresh start unchanged "because no scenario binds it and the status panel already serves it"; the panel did not, and the D167 Then "the packet handed to a session starting in the main checkout at the same time does not carry it" was bound against a packet that carried no self line by construction, vacuously green; the Then keeps its words and binds against a packet that opens with main's own line, and the restarted-main scenario walks the incident end to end, status, packet and search agreeing. The owner on content: "be aware of other lanes … but no need to auto fill - would get messy if there are a 1000 worktrees." Main's own line at every start, not only beside another lane, follows the owner's symmetry ("i do not see a difference") and "main should get main"; D236's premise, the panel serving it, is the one that failed; the cost is what a worktree already pays, and bounded. The bookmark line is D160's bookmark-only path carried to the fresh start, since a documentation session nobody checkpointed leaves a bookmark and nothing else. The self lines stay outside the budget because a resume's budget is {500} characters and the worktree's own anchor would be cut by its own line. Roads not taken: the other lanes' newest chapters in the packet, labelled as theirs (the first draft; anchoring on text in front of the model is the hazard, label or none); main's self line only beside another lane (D162's economy, declined for symmetry); one line per other lane with no cap; the self lines inside the budget Residual, disclosed: a start whose registration did not land claims no checkout in the packet, which omits the self lines and the other-lanes line, status saying the session could not be placed.

D374 2026-11-02 [I] amends D237
  trig:  a session searches without asking for the whole store: the session's own agent in the main checkout or a linked worktree, a subagent, a worker of the ticket door, or a caller the server cannot place [I]
  resp:  a search by a caller the registry resolves to the session's one live subagent defaults to that subagent's scope: rows the store stamped with its role as writer, the live resume pointers of the lane that spawned it, the session's self, the entries whose `brief_for` names its role, and the entries those pointers and briefs reference, one hop; a search by the session's own agent, in the main checkout or in a linked worktree, defaults to its own lane, read from the registry at the moment of the search as D376 rules: the rows of every session the registry places in that checkout, the session's own agent's rows, the client's own internal summaries and each helper's report alike, a subagent's summary row or a worker's, the worker's by the parent link of its registration, never a helper's trail, its tool calls and turns staying in its own lane; the entries imported by a session of that lane, or by none the registry places, which land in the main lane; for the main lane also the rows of sessions the registry never held; never a row of an undetermined writer; and the entries its live pointers and briefs reference, one hop; a worker whose parent the registry places in no checkout reports into no lane's default search, its return reached by the key lookup or by asking for the whole store; a caller that cannot be told apart from a live subagent, `concurrent` or `ambiguous`, searches the whole store as D240 rules, the reply saying why; a worker of the ticket door searches the whole store as before, its harness feeding it by brief and key lookup, the reply saying so; a caller the server cannot place searches the whole store, the reply saying so; every other caller searches as before; the scope is applied in the store before the result count and to every hit's conversation window; the reply names the lane searched and how to widen, and `scope: "all"` searches the whole store with no scope block; no new parameter is added; after a restart the lane's own chapter is among the orientation search's results and no result presents another lane's thread as the session's own, the first place not promised, the status panel and the packet carrying the lead; a writer's whole trail is read by `treecontext_export` with `writer`, a role or one subagent's agent id, `main` or `worktree:<name>`, oldest first, by the same lane reading; a lane-scoped relevance page of two or more places that holds none of the lane's own live chapter summaries the search matched gives its last place to the best ranked of them, never the first, never on a temporal listing and never past the filters; no score or count changes; a run's rows in a worker's own lane, its first moment and its checkpoints, are found by asking for the whole store, the scoped reply saying how, its summary row being the spawning lane's by the parent link and its open and close the lane of the session that wrote them, the main lane's for a write naming no session [I]
  sib:   none -- an orientation query answered by another lane's newest chapter is the confusion D167 removes at the handshake's second step, not a behaviour
  serves: N20 N21 N23 N24
  touches: D237 D167 D264 D150 D240 D147 D263 D151 D186 D336 D288 D309 D313
# the handshake's second step, "what was I working on, what was the next step", runs store-wide with recency fusion at {0.25} (D264, D273), so in the incident of D372 the worktree's newer chapter is the likeliest top hit after the panel is fixed; the review of the first draft found the step unlit. The owner: "what i was working on depends on what lane/namespace we are in. main should get main, worktree gets it's own worktree, subagent gets whatever the supervising agent or harness feeds it." A second draft scoped by writer stamp and would have hidden what D147 [V] promises the orchestrator (its subagents' reports), D263's internal summaries and D151's imports; the second review found it, and the owner, asked whether main's default search should still find what its helpers produced: "q1 - what about scenarios like flooding - there are dozens or hundreds of subagents or work trees - how do we manage that?", answered by the lane read from the registry (D376) and the flood scenario: one row per helper, ranked and previewed, never a resume pointer. On whether the lane's own chapter must rank first after a restart, the owner took the recommendation "found, never contradicted": "ok on #1 rec."; a rank-first promise would need a chapter-lifting rule and can fail when common words are discounted past {256} rows, which the status panel and the packet do not depend on. D240's whole-store rule for a caller that cannot be told apart stands, since a guess must not act as a lane's own (D235's comment); status still scopes such a session to its self, disclosed in D372. A worker of the ticket door is fed by its brief and the key lookup (D336), not by a scope, so it searches as before. D264's "no new query parameter" holds: `scope: "all"` existed. Roads not taken: the search left store-wide with a label on each other-lane hit (a label in front of the model is what failed in the incident, and the owner ruled scope); a parameter for orientation (D264 declined it); scoping the search and not the window (the window would leak the other lane around every hit); the scope by writer stamp (hides the helpers' reports); a worker scoped to its parent's lane (its harness feeds it); a rank-first promise for the orientation search Found by the U3 build: at the served `top_k 3` with fusion, 200 newer reports pushed the chapter off the page, so 'among the results' needed a seat though not a lift; measured on the owner's store, the seat takes the third place of 6 in 80 sampled developer prompts; it reaches no chapter outside the candidate pool or when every query word is discounted. The U3 review read D309's and D313's searches as asking for the whole store when a worker's first moment or checkpoints are sought, by R8: a worker's report is its spawner's lane, its trail its own.

D375 2026-11-02 [I] amends D286
  trig:  a session starts after a compaction and the drain runs the recovery queries the pre-compact snapshot recorded; a fresh session starts while an unclaimed recovery snapshot exists; or a store an earlier release left with recovery snapshot rows is opened [I]
  resp:  the recovery snapshot row is machine output quoting the journal, bounded like a tool event: it quotes each hit at the hit's display view and no further than the quote cap, names the entry it quotes, never quotes another recovery snapshot, keeps the recovery queries in its metadata and out of its indexed words, and carries its own display and index boundaries, so a hit on it is a bounded preview with the availability marker and its reach into the index is the tool default; on first open this build stamps the same boundaries on every recovery snapshot row a store already holds, content untouched; a fresh session claims a recovery snapshot only when the session that left it had the same self, the main checkout's for a main session and the same worktree's for a worktree session, newest first; a snapshot left by another lane is left for that lane; a snapshot whose session the registry does not hold is claimed by no one and stays in its table; the recovery queries the drain runs for a claimed snapshot are scoped to that lane as a search by the claiming session would be, and the recovery row is written in the claiming session and so in its lane, never in no session; the pre-compact snapshot itself and the compaction interaction stay with ccr, but what the drain writes to the store is in the charter from here [I]
  sib:   none -- a row the store writes about itself growing without a boundary, or a session answering another lane's recovery queries into its own, is what this prevents, not a behaviour
  serves: N1 N4 N23 N5
  touches: D286 D35 D167 D372 D374
# found by the review of the first draft, 2026-11-02: on a startup the session-start hook claims the newest unclaimed snapshot of any other session, with no lane, worktree or directory test, writes its queries into the packet and stages a row the drain answers store-wide; only a startup claims, so a worktree's compaction leaves a snapshot the main checkout's next start takes. Whether it fired in the owner's incident cannot be known (another machine's store); it would produce exactly that incident. The owner, asked whether a main session should ever adopt a worktree's recovery note: "C) I don't think so." The second review found the drain's own write: the recovery row carried no session and no writer, so even a worktree's own recovery row read as the main lane's, the D286 specimen again. D286 kept "the session-start claim" with ccr; the claim writes to the packet and makes the drain write, and a fence may decline a promise, never a writer, so the claim's lane test and the row's session are in the charter from here. A snapshot left before the store recorded sessions is not claimed; it stays in its table, disclosed rather than claimed for main. Roads not taken: retiring the claim (it is the only automatic recovery after a compaction that was not a /clear); the claim unfiltered and disclosed in the packet (the disclosure arrives after the queries are already staged)

D376 2026-11-02 [I] amends D243
  trig:  the store reads a row's lane: to list or retire a pointer, to scope a lane's default search, to read a writer's trail, or to label a row [I]
  resp:  a detached HEAD registers no branch; a linked worktree whose directory name another registered top level already holds registers as `<name>@<six hex of its top level's path>`, a top level keeping the name it first registered under; a subagent type spelled `main`, or starting `worktree:` or `agent:`, is stamped under the prefix `agent:`; a pointer's lane is its writer stamp: `main` and a row carrying no stamp at all, written before the store recorded writers or by a program writing through the library without one, are one main lane, a role is its subagent's, and a row stamped `unregistered`, written while the store recorded writers by a caller it could not place, is the lane of undetermined writers, shown as "writer unknown", never folded into main and never any lane's own, its other metadata left for the reader; rows of undetermined writers are one lane for supersession: an unplaced writer's chapter or bookmark retires the earlier ones of that lane as before, never a placed lane's, and a placed lane's writer never retires one of them, recording it as a reference; a lane's default search scope is read from the registry at the moment of the read and never written onto a row: the sessions the registry places in that checkout, the main checkout's or the worktree's, with each helper's report by the parent link of its registration, as D374 lists them; a writer's trail by `main` or `worktree:<name>` is that lane's own rows as the lane is read from the registry, the session's own agent's rows of every session placed in that checkout, and for `main` the older rows naming no writer whose session the registry never held; by a role, its stamped rows and the older rows claiming it as `agent_type` with no stamp; a trail longer than the export's cap returns the newest within it, oldest first, stating `omitted`; a row stamped `ambiguous` is never a worktree's own chapter; the writer trail bypasses the summaries default of the handoff export; nothing is stamped at the drain beyond what is stamped today, and no row already stored is rewritten for its lane [I]
  sib:   none -- a worktree's own conversation read as the main lane's, or a stranger's chapter vouched for as main's own, is the mislabelling this prevents, not a behaviour
  serves: N5 N20 N21 N23
  touches: D243 D235 D228 D240 D190 D167 D169 D166 D372 D374
# the review of the first draft, 2026-11-02: a row stamped `unregistered` names no writer, so the lane key read it as main's and the first draft would have labelled a stranger's chapter "the main checkout's own". The owner: "E) honesty first - if writer is uknown, indicate as such. agent can explore other metadata to figure out what it is. could be a human injected instruction which is fine", and to the nuance that rows from before the store recorded writers were the main session's (no worktrees then) and stay main's as D243 reads them: "a) agree with your more nuanced explanation about unknown writers." The second review found that "no lane's own" read as the ambiguous lane, which retires nothing, would stop supersession for every client without hooks and grow its panel without bound against D166; the undetermined writers are therefore one lane for supersession, labelled and apart. The lane read at query time is the second review's design, adopted by the owner: the drain stamps no writer on a session's own captured rows today, so a worktree's turns and tool output read as the main lane by the lane key; a stamp at the drain would have broken the concurrent-caller evidence that reads those rows unstamped (D240), and a stamp on open would have rewritten rows in place from the registry's last registration, a later reading spelled like a live stamp; the registry already maps each session to its checkout and each helper to its parent, a fact of record read where it is used, covering old and new rows alike. The third review found the export trail still reading the stamp, so a worktree's trail missed its own conversation; the trail now reads the lane the same way. Residuals, disclosed: a session id started again in another checkout re-registers there, and its earlier rows follow it; a worktree moved on disk has a new top level and registers under a new name, so its lane splits, the restarted session starting fresh and the old lane counted among the others; a removed worktree's lane keeps its live pointers and stays counted until someone retires them; two unplaced writers are one lane for supersession and can retire each other's pointers, kept on purpose so an unplaced client's panel stays bounded (D166), though D169 reads "a lane's own writer"; an ambiguous beacon makes the caller unplaced, consistent with the whole-store search. Roads not taken: stamping the self on captured rows at the drain (D240's evidence, and a new writer source to name); a stamp on first open (an edit in place that changes which lane owns rows, on a later reading); folding unplaced rows into main with a note (the incident, vouched for); refusing an unplaced write (capture is never filtered, D3)

D377 2026-11-02 [I]
  resp:  the lane-scoped search of D374 ships in `0.1.0-beta.3`, the release waiting for it, dogfooded on the owner's machines first; the build follows the aBDD pathway though this slice was not formally scoped: failure-ladder reviews, model triage for builders by difficulty, per-unit binding counts recorded, and a Fable gate that runs after the build and the dogfood, when Fable tokens are available, else on `2026-11-06` [I]
  ->     boundary
  serves: N23 N24 N31
  touches: D374 D372 D373 D375 D376 D370
# the owner, 2026-11-02, after the second review: "q2 - i would prefer to hold up beta.3 to include the full filtering. we can dogfood it here." and "go ahead with v3, make sure we follow the aBDD pathway even though this wasn't formally scoped - failure ladder reviews, efficient subagent model triage, etc."; after the third review, on the search promise and the gate: "ok on #1 rec. let's do everything other than fable gate including dogfooding and we can see what the fable situation looks like when you are done - if there's available tokens we can do it, otherwise it waits until thursday." The resp is the drafter's reading of those words, so the tag is [I] until the owner reads it; the ratifying entry for D372 to D376 can ratify this one with them. Road not taken: the status panel, packet, snapshot rule and unknown writer in beta.3 with the search scope in beta.3.1 (the second review's option; leaves the handshake's second step able to surface a worktree's newer plan)

D378 2026-11-02 [I] amends D376
  trig:  the store reads a row's lane: to list or retire a pointer, to scope a lane's default search, to read a writer's trail, or to label a row; or a writer the store could not place names in `supersedes` a chapter summary of the main lane that names no writer [I]
  resp:  a detached HEAD registers no branch; a linked worktree whose directory name another registered top level already holds registers as `<name>@<six hex of its top level's path>`, a top level keeping the name it first registered under; a subagent type spelled `main`, or starting `worktree:` or `agent:`, is stamped under the prefix `agent:`; a pointer's lane is its writer stamp: `main` and a row carrying no stamp at all, written before the store recorded writers or by a program writing through the library without one, are one main lane, a role is its subagent's, and a row stamped `unregistered`, written while the store recorded writers by a caller it could not place, is the lane of undetermined writers, shown as "writer unknown", never folded into main and never any lane's own, its other metadata left for the reader; rows of undetermined writers are one lane for supersession: an unplaced writer's chapter or bookmark retires the earlier ones of that lane as before, and a placed lane's writer never retires one of them, recording it as a reference; an unplaced writer never retires a placed lane's pointer, with one door so that no chapter is orphaned: while the registry holds no session placed in the main checkout, an unplaced writer that names in `supersedes` a pre-stamp chapter, a live chapter summary of the main lane that names no writer, carrying neither `_writer`, `_writer_src` nor `agent_type`, whose session the registry never held, retires it, and never otherwise: never a bookmark, never by the bookmark chain, never a pointer naming a writer or carrying a stamp of any source, never one whose session the registry holds, never an imported entry, and never once a session has registered in the main checkout, each of those staying a reference as before; every such retirement is recorded on the retired entry beside the ordinary trace under one key `_retired_across`: who, the writer as the store stamped it at the retirement, "writer unknown" with the stamp source `unregistered` and the retiring row's session when it carries one, never a role the row claims; what, the retiring entry's id; when, the moment of the retirement; and how, `pre-stamp`; the retiring entry lists what it retired that way under `_supersedes_across`, beside `_supersedes_referenced`; both keys are the store's, the insert tool dropping a caller's copy and an import keeping a file's copy among its claims; the reply lists those chapters under `retired_across`, apart from the lane's own supersessions, with a note saying who, what and how; the record is read wherever the entry's metadata is read, export by id, the writer trail by `main` and the handoff export's whole form; when an echo moves the retiring row into a lane that does not own the target, the echo heal's undo restores the target and removes its `_retired_across` and the retiring row's `_supersedes_across`, the heal's own record saying so; a lane's default search scope is read from the registry at the moment of the read and never written onto a row: the sessions the registry places in that checkout, the main checkout's or the worktree's, with each helper's report by the parent link of its registration, as D374 lists them; a writer's trail by `main` or `worktree:<name>` is that lane's own rows as the lane is read from the registry, the session's own agent's rows of every session placed in that checkout, and for `main` the older rows naming no writer whose session the registry never held; by a role, its stamped rows and the older rows claiming it as `agent_type` with no stamp; a trail longer than the export's cap returns the newest within it, oldest first, stating `omitted`; a row stamped `ambiguous` is never a worktree's own chapter; the writer trail bypasses the summaries default of the handoff export; nothing is stamped at the drain beyond what is stamped today, and no row already stored is rewritten for its lane [I]
  sib:   none -- a live chapter that no writer in the store can ever retire, growing a client's panel forever, is the orphan this prevents, not a behaviour
  serves: N5 N20 N21 N23
  touches: D376 D169 D235 D240 D241 D243 D166 D223 D293 D372 D373 D374
# the U1 failure-ladder review, 2026-11-02 (finding F3): a client without hooks, Codex or Cursor, upgrades to beta.3 holding chapters it wrote before the store recorded writers, which are main's by D376, and writes its next chapter stamped `unregistered`; its `supersedes` of the old one comes back as referenced, "Written by another writer", and both stay live pointers forever, since no placed writer is present to retire main's; probe P-UPG confirmed it. Put to the owner as three options (an unplaced writer may retire a pre-stamp chapter, traced; doctor lists them for a human; disclose only): "i agree there has to be mechanism to retire so nothing is orphaned, as long as who/what/when/how is recorded". The door is the unknown lane's alone, and only where the registry holds no session placed in the main checkout. R14 reaches "a chapter that no lane can otherwise retire"; where main has registered, its writer can retire every pre-stamp chapter, and by R7a "do not let main's old chapters drop out of main's own thread": a hookless client retiring main's chapter there would leave main's next start without its thread (D373), the incident's shape (D372). A worktree retiring main's is the incident; an `ambiguous` writer retires nothing (D235). Bookmarks stay out: D166 keeps one live per ended session by design, so a pre-stamp bookmark is no orphan; they are written at the stop hook's request, so the pre-stamp ones are hooked main sessions' own, and D373 makes one main's anchor. The test is the row's own facts and the registry's, read at the write, never a release or a date: a chapter naming no writer, not even a claimed `agent_type`, which would be a role's (D243), in a session the registry never held, the same reading by which D374 and D376 give such rows to main; an imported entry is never live (D223). The record lives on the retired entry because that is the row that changed and the row main's trail reads; the retiring entry carries the list so a reader of the unknown lane finds it too; both keys are the store's, like the stamp, and travel as claims in a handoff file (D223); D293's who, when, how and what are the owner's own words for a writer no hook vouched for. The echo heal's undo of D240 removes the record with the retirement, so a live chapter never carries one. The second departure from D169's "only a lane's own writer retires that lane's pointers", beside D376's two-unplaced-writers residual, both kept so a hookless client's panel stays bounded (D166). Residuals, disclosed: main registered once and never returns, leaving its pre-stamp chapter live in its own lane for its next session; a hooked session whose registration failed is unplaced, whichever checkout it ran in, and reaches the door only where main never registered; in a store where main has registered, a hookless client's own pre-upgrade chapters stay main's (D376) and its new ones reference them; the record keeps the writer as stamped at the retirement, a later heal saying what it became in its own keys. Roads not taken: doctor listing the orphans for a human to retire by hand (a new surface, and the human is not always there); disclosure only (the panel grows without bound, D166); any writer retiring a pre-stamp chapter (a worktree's writer would retire main's, the incident); the door open in a store where main has registered until main supersedes the chapter itself (the first draft; R7a, and that window closes only by chance); bookmarks through the door (no orphan, and main's anchor); a packet line telling main its chapter was retired across the boundary (a new packet surface, needless once main's chapters are shut to the door); amending D169 [I>V] in place (D376 set the precedent of a disclosed departure). Its resp is restated in full by D379, which amends D376 and changes the lane clause: one lane for every reader, read from the registry

D379 2026-11-03 [I] amends D376
  trig:  the store reads a row's lane: to list or retire a pointer, to scope a lane's default search, to read a writer's trail, or to label a row; or a writer the store could not place names in `supersedes` a chapter summary of the main lane that names no writer [I]
  resp:  a detached HEAD registers no branch; a linked worktree whose directory name another registered top level already holds registers as `<name>@<six hex of its top level's path>`, a top level keeping the name it first registered under; a subagent type spelled `main`, or starting `worktree:` or `agent:`, is stamped under the prefix `agent:`; a pointer's lane is read from the registry at the moment of the read, as the lane's own rows are read, and never written onto a row: a row of a session's own agent, carrying no helper's agent id, imported from no file, stamped neither `unregistered` nor `ambiguous` and claiming no role, whose session the registry places in a checkout, is that checkout's lane, `main` or `worktree:<name>`, whatever its stamp or the lack of one, a chapter a program wrote through the library in a worktree's session being the worktree's; every other row's lane is its writer stamp: `main` and a row carrying no stamp at all whose session the registry never held, written before the store recorded writers or by a program writing through the library without one, are one main lane, a role is its subagent's, a helper's row is its role's and never its checkout's, and a row stamped `unregistered`, written while the store recorded writers by a caller it could not place, is the lane of undetermined writers, shown as "writer unknown", never folded into main and never any lane's own, its other metadata left for the reader, as is a row carrying no stamp at all whose session the registry holds but places in no checkout, a ticket-door worker's or a session whose own registration never landed; status, the fresh start's self lines and its line about the other lanes, the own and foreign test of supersession and of the echo heal, the referrer shown from another lane and the seat a lane's search keeps for the lane's own chapter read the one lane, so that no reader gives a lane as its own a pointer another reader gives to another lane; a lane's default search may find a row that is not the lane's own, a helper's report, an import, a row stamped `ambiguous` or claiming a role, and never presents it as the lane's own chapter; rows of undetermined writers are one lane for supersession: an unplaced writer's chapter or bookmark retires the earlier ones of that lane as before, and a placed lane's writer never retires one of them, recording it as a reference; an unplaced writer never retires a placed lane's pointer, with one door so that no chapter is orphaned: while the registry holds no session placed in the main checkout, an unplaced writer, its row stamped `unregistered`, that names in `supersedes` a pre-stamp chapter, a live chapter summary of the main lane that names no writer, carrying neither `_writer`, `_writer_src` nor `agent_type`, whose session the registry never held, retires it, and never otherwise: never by a row carrying no stamp, never a bookmark, never by the bookmark chain, never a pointer naming a writer or carrying a stamp of any source, never one whose session the registry holds, never an imported entry, and never once a session has registered in the main checkout, each of those staying a reference as before; every such retirement is recorded on the retired entry beside the ordinary trace under one key `_retired_across`: who, the writer as the store stamped it at the retirement, "writer unknown" with the stamp source `unregistered` and the retiring row's session when it carries one, never a role the row claims; what, the retiring entry's id; when, the moment of the retirement; and how, `pre-stamp`; the retiring entry lists what it retired that way under `_supersedes_across`, beside `_supersedes_referenced`; both keys are the store's, the insert tool dropping a caller's copy and an import keeping a file's copy among its claims; the reply lists those chapters under `retired_across`, apart from the lane's own supersessions, with a note saying who, what and how; the record is read wherever the entry's metadata is read, export by id, the writer trail by `main` and the handoff export's whole form; when an echo moves the retiring row into a lane that does not own the target, the echo heal's undo restores the target and removes its `_retired_across` and the retiring row's `_supersedes_across`, the heal's own record saying so; a lane's default search scope is read from the registry at the moment of the read and never written onto a row: the sessions the registry places in that checkout, the main checkout's or the worktree's, with each helper's report by the parent link of its registration, as D374 lists them; a writer's trail by `main` or `worktree:<name>` is that lane's own rows as the lane is read from the registry, the session's own agent's rows of every session placed in that checkout, and for `main` the older rows naming no writer whose session the registry never held; by a role, its stamped rows and the older rows claiming it as `agent_type` with no stamp; a trail longer than the export's cap returns the newest within it, oldest first, stating `omitted`; a row stamped `ambiguous` is never a worktree's own chapter; the writer trail bypasses the summaries default of the handoff export; nothing is stamped at the drain beyond what is stamped today, and no row already stored is rewritten for its lane [I]
  sib:   none -- a chapter one reader gives to a worktree while another opens the main checkout's start on it is the split this prevents, not a behaviour
  serves: N5 N20 N21 N23
  touches: D376 D378 D243 D372 D373 D374 D375 D240 D235 D169 D223
# the Fable gate, 2026-11-03, its first finding, verified with a scratch test: D376's stamp rule gave a pointer its writer stamp's lane, and its text gave main a row with no stamp written by a program through the library, while D374's search read the lane from the registry. In a store where main and the worktree "subproject" had both registered, a chapter the library wrote under the worktree session's id with no stamp was listed by main's status as main's own and opened main's packet, while main's search could not find it; the worktree's status listed nothing and its packet started fresh, yet its search found the chapter as its own: the incident of D372 through the library door. The owner ruled the fix before the release, by the rulings: R10 derives a session's lane at query time from the registry; R7 never folds into main a row written after stamps existed whose writer was not identified; R7a keeps unstamped rows main's only for the era before writers were recorded. One rule therefore serves every reader, with the cuts the search and the writer trail use: the registry places the session first, and the stamp decides only where it does not, exactly as before, the rows from before writers were recorded, whose sessions the registry never held, staying main's (D243) and `unregistered` staying writer unknown. A helper's row (R8: its agent id, its role) stays its role's, as the lane's search subtracts a helper's trail; a role claimed with no stamp stays the role's (D243); an `ambiguous` row owns no lane (D235); an import stays its handoff lane (D223). The echo heal reads the same lane, so a row its echo moves into a worktree retires the worktree's library chapter it asked to supersede, and a row moved out of it gives one back, as the insert would have; the referrer shown from another lane reads it too. The D378 door is unchanged: it opens only for a chapter whose session the registry never held, which no placement reaches. Nothing is stamped and no row is rewritten (R10); the placement is read once per read, for the sessions of the rows it reads. Residual, disclosed (the gate's third finding): a session that runs outside any git checkout registers as the main lane, the packet's self line saying so, so its rows are main's own; its registration also shuts the D378 door, and it may claim main's recovery snapshots (D375). Roads not taken: the library stamping a row's lane at insert (a new writer source, and rows already stored keep the split); the search read by the stamp (D374's helpers' reports and an earlier release's worktree turns would leave the lane, the third review's finding on D376); amending D376's words in place (a ruling is amended by a dated entry, never edited). Corrected before the release by the gate fix's failure-ladder review, 2026-11-03, its findings F1 and F6, verified with scratch tests: the first text gave main a row with no stamp whose session the registry placed in no checkout, while the search, the writer trail and D378 cut main at a session the registry never held, so a chapter a program wrote through the library in a ticket-door worker's session was listed by main's status as main's own and opened main's packet while main's search and trail left it out, gate finding #1's shape; such a row is now writer unknown, R7's reading of a row written while writers were recorded whose writer was not identified, R7a's era cut the only road to main, and the D378 door stays the stamped unplaced writer's, so that row's `supersedes` of a pre-stamp chapter is a reference. The first text also said the search read the one lane, yet the lane's search seated as its own chapter a chapter stamped `ambiguous` or claiming a role, which status gave to another lane; the seat now reads the one lane (R12: no result presents another lane's thread as the session's own), while the search's scope stays as D374 drew it, being found not being presented as one's own. Roads not taken: narrowing the search's scope to the lane's own pointers (a lane's search finds its helpers' reports and imports by D374, and a row its own agent could not be told apart from a helper is better found than lost)

D380 2026-11-03 [I]
  trig:  a hook waits on a store another process holds: a write, a guard read, a fresh start's read, the hooks door's rows, on any operating system, however long the system's sleeps really last [I]
  resp:  every wait a hook makes on the store ends by the hook's own deadline counted by the clock: the write's `HOOK_DB_TIMEOUT_MS` (`7000`) from the hook's start, the Stop-shaped guard's `STOP_GUARD_TIMEOUT_MS` (`1000`), the bootstrap's share and a fresh start's read budgets as they stand, a second wait taking what is left of the first's, never a fresh budget; the budgets do not change, what they mean does: wall time on every OS, so a hook against a locked store finishes inside the hook kill treecontext installs (VS Code's `timeoutSec: 15`) on a slow or loaded machine as on a fast one; a wait the deadline ends is the same failure the budget's end was before, its event a capture gap where it was one; the hook kill is the installed one less a second, and the real hooks against a locked store are held to it on every OS [I]
  sib:   none -- a hook killed mid-wait by the platform, losing its event, its gap marker and its close, because the store's wait counted the sleeps it asked for and the system slept longer, is what this prevents, not a behaviour
  serves: N3 N26 N2
  touches: D263 D314 D175
# the release run, 2026-11-03, the macOS lanes of the CI matrix (runs 41646667559, 41654065600, 41668464047, 41670918705), traced on the diagnostic branch diag/macos-sigterm: SQLite's default busy handler counts its timeout by summing the sleeps it asked for, never by reading the clock, so on a loaded macOS runner a hook's busy wait ran 1.6 to 2 times its budget against a store another process held (session-start's 7 s took 13.6 s, pre-compact's 11.1 s, SubagentStop's 1 s guard 2.2 s, the 1.5 s fresh-start read a 4.07 s hook), putting a locked-store session-start at the VS Code kill; on Linux the sleeps are honest and nothing showed. The owner ruled the fix before the release ("Fix waits in beta.3"), with the kill raised from 10 s to 15 s and one wall-time rule for every OS the same day ("relax the timings to be uniform across all OSes but give enough time"). Roads not taken: listing macOS's overrun as a known issue and fixing it in 3.1 (the macOS lanes would gate the release red); raising the kill further instead (the budgets would still not be the clock's, and no kill is safe against an unbounded ratio); shortening the budgets on macOS alone (a rule per OS, against the owner's uniform one). Disclosed: the overrun was measured on a CI runner only; neither the owner's machines nor the dogfood runs are a Mac

D381 2026-11-07 [I]
  trig:  install wires Codex CLI, whose headless `codex exec` refuses every MCP tool call that needs an approval, since its approval policy is never [I]
  resp:  install's treecontext entry in Codex's configuration approves four tools one by one, status, query, export and insert, and writes no approval for clear, delete, import and merge, which go on asking, so a headless worker reads and writes the journal and never removes or brings rows in, Codex refusing its request for those; an approval the developer set for any treecontext tool, or a default the developer set for the server, is never written over, as D290 never writes a key the user set; a Codex older than the first version verified to read per-tool approvals gets none written, and install and doctor say in one line that its headless workers need a newer Codex, naming the version [I]
  sib:   none -- a `codex exec` worker that can call no treecontext tool while doctor reads [ok], or one that can clear the store unasked, is what this prevents, not a behaviour
  serves: N27 N15 N9 N26
  touches: D51 D288 D290 D370
# the owner, 2026-11-07, ruling R1, "Per tool": "Approve status, query, export and insert; leave clear, delete, import and merge prompting. A headless worker can read and write, never destroy (its prompt for those is refused)." Evidence, Codex 0.167 on the dogfood machine (Ubuntu 24.04), 2026-11-07: `codex exec` refuses an MCP tool call that needs approval ("approval policy is never") unless the server's table sets one; Codex accepts `mcp_servers.<name>.default_tools_approval_mode` and, per tool, `mcp_servers.<name>.tools.<tool>.approval_mode`, valued auto, prompt, writes or approve, and refuses its whole configuration on any other value ("unknown variant"). The version floor is the drafter's: an install that writes a key an older Codex cannot read could make Codex refuse its configuration, the failure D290's floors exist to prevent. The floor is the oldest version the dogfood shows reading the keys (0.167 until an older one is shown); if 0.166 reads them, the floor scenario is dropped. D390 amends this entry, carrying the same rule to the three clients. Roads not taken: a default approval for the whole server (it approves destruction); approvals written as prompt for the four (they would override a wider setting the developer chose, against D51); `enabled_tools` to hide the four from every Codex session (interactive sessions would lose them, and a worker would not be refused visibly but blind)
# the owner, 2026-11-07, approving the charter draft as revised: "Approve, start unit 1"
# the build, 2026-11-08, the floor settled: Codex auto-updated to 0.167.0 on the dogfood machine and kept its 0.166.0 binary, which parses `mcp_servers.<name>.tools.<tool>.approval_mode` (a bogus value answered "unknown variant `bogus`, expected one of `auto`, `prompt`, `writes`, `approve`"; `approve` accepted), so the floor is 0.166.0, the oldest version verified. The note above said the floor scenario is dropped if 0.166 reads the keys; it is kept and bound instead (a stand-in Codex answering 0.165.0), because the resp's rule, none written below the first version verified, still governs every older Codex, which no run has read, and dropping the scenario would leave that writer's guard with no scenario (AGENTS.md: a fence may decline a promise, never a writer)

D382 2026-11-07 [I]
  trig:  a headless worker the ticket door started opens a session whose instructions tell every session to run the orientation routine first [I]
  resp:  a treecontext server serving a worker whose lane it trusts, the registration the ticket in the same environment describes and never the lane variable alone, sends a handshake telling the worker that its first message already holds its brief and the checkpoint or checkpoints in effect and to begin there, and names no session-start routine; the rest of the card is unchanged and stays within the bound of D210; the instruction block install and init write (Codex CLI's `~/.codex/AGENTS.md`, the `~/.gemini/GEMINI.md` that Gemini CLI and Antigravity CLI share, a project's `AGENTS.md`) and the handshake every other session receives each carry one line: a session whose first message opens with treecontext's line naming it a worker of a run, or saying its instructions were invalid, skips the session-start routine; no flag is added [I]
  sib:   none -- a worker that pays the main session's orientation, about `14,000` input tokens on each model call of a metered plan, and pulls other lanes' resume pointers into a worker that cannot judge them, is what this prevents, not a behaviour
  serves: N29 N27 N14
  touches: D8 D371 D210 D264 D295 D298 D341 D342 D374
# the owner, 2026-11-07, ruling R2, "Server + instructions": "The server already knows it's serving a ticket-door worker (trustedWorkerLane), so its handshake tells the worker to skip orientation. The AGENTS.md/GEMINI.md block gains one line: a worker whose first message starts 'treecontext: you are a … worker' skips it. Works for every client, no flags." Evidence, 2026-11-07: the global `~/.codex/AGENTS.md` block and the handshake both tell every session to run status, an export of each resume pointer, and a query; on a `codex exec` worker that came to about 14,000 input tokens per model call, paid again on every round trip, and it brought other lanes' pointers into a worker that could not judge them. Today the ticket door's first message opens with "treecontext: you are the <role> worker of the run …", "treecontext: you are a one-off <role> worker …" or "treecontext: your instructions were invalid …"; the block's line names those openings, and a scenario holds the composer to them so the two cannot drift. A `claude -p` child already gets one identity line from its session-start hook and no packet (D295); this entry changes only its handshake. Roads not taken: a `--worker` flag on serve (the owner's "no flags"); the routine skipped for hooks-door legs too (their first moment opens "you are the <role> leg"; the owner's ruling names workers, and a leg shares its parent's server, so the handshake cannot tell it apart; reopens if the dogfood shows a leg orienting). Drafted as amending D8; entered without the relation, since D371 already amends D8 and a second amends would replace that shape: the link is in touches
# the owner, 2026-11-07, approving the charter draft as revised: "Approve, start unit 1"
# the build, 2026-11-08, unit 4's review, how three findings were settled: a worker's send-back re-run opens on the worker's own first message (the line the block names), then the reason, then the trail line, because no ruling fixes the order (D291's scenario says the first message "names that reason", D335 rules the lane's rows) and the block's three openings did not cover a message that led with the reason; the hooks door's send-back takes the same order, its first line being its leg's, as its first moment's is; a live hooks-door leg in the store is a third producer the ordinary-card scenario now binds (a plain serve still gets the ordinary card); the worker card says the first message may also say the instructions were invalid, as a damaged ticket's worker's does
# the owner, 2026-11-09, choosing "Adopt all (Recommended)" ("Q2 row"); the consensus adopted (journal d3cd859e, f2fcb0e4): "a 4th D382 outline row for the send-back re-run, tagged @D291, bound through the real door on the re-run's stdin." The outline "the first message the ticket door composes for <case> opens with the line the block names" gains the row "a worker run once more for a missing checkpoint" and the tag @D291; its binding reads the second run's first message where the re-run receives it through the real door, since `tests/send-back-opening.test.ts` calls the composer alone; the order the build settled on 2026-11-08 (the worker's own line, then the reason, then the trail line) is what the row holds. The outline's three bound rows wait with it in the wip register, held by its title, until unit 7b binds the row
# the build, 2026-11-09, unit 7b: the fourth row binds through the wrapper with a worker that owes the checkpoint, exits without it and is run once more by the door; the Then reads the second process's own stdin from the stand-in's log (its record marked as the re-run, a process of its own, a message other than the first run's that holds D291's reason after the worker's line and before the trail line) against the block's openings

D383 2026-11-07 [I] amends D370
  trig:  a developer with Antigravity CLI installed runs install, doctor or uninstall [I]
  resp:  Antigravity CLI enters the agent table as a tools-only client under the slug `agy`: install writes its MCP entry where agy reads it, `mcpServers` in `~/.gemini/config/mcp_config.json`, with no line for the ticket's variables since agy passes its whole environment to the server; it adds four allow rules to agy's permission settings in `~/.gemini/antigravity-cli/settings.json`, `mcp(treecontext/<tool>)` for status, query, export and insert, and records the rules it added so that uninstall removes those and no others; it writes no rule for clear, delete, import and merge, which agy's default preset leaves to review and a headless `agy -p` refuses; a rule the developer wrote, allow, ask or deny, is never written over or removed; agy's instruction block is the one in `~/.gemini/GEMINI.md` that it shares with Gemini CLI, written once; install writes no agy hooks; doctor gives it a row; a machine with Antigravity CLI and no Gemini CLI gets no Gemini CLI configuration, although the two share `~/.gemini`; the archived Antigravity IDE stays out of the agent table (D109), and uninstall still sweeps its old configuration; the orchestration matrix of D370 stands, its cells as D388 reads them [I]
  sib:   none -- an agy worker whose every treecontext call its default preset refuses, or a developer who types the server line by hand without the installer's arguments, is what this prevents, not a behaviour
  serves: N27 N9 N23 N26 N31 N32
  touches: D370 D109 D153 D161 D51 D29 D290 D381
# the owner, 2026-11-07, "reopen agy fence", and ruling R3, "Probe, then decide": "Install writes agy's MCP config and doctor gets an agy row. One small paid probe checks whether agy supports a per-tool grant … If it does, install writes grants for the safe tools; if not, docs and doctor say agy workers are journaled through their report only." The fence's own reopening condition is met: "or when the owner asks install to write its MCP configuration" (D370). The probe passed, 2026-11-07, agy 1.5.1: a headless agy run in `--mode plan` with only `{"permissions":{"allow":["mcp(treecontext/treecontext_insert)"]}}`, given session-only through `--settings`, wrote its insert, and the row landed in the worker's own lane, stamped by the tools door. No negative control was run, and settings persisted in settings.json were not tested; the dogfood runs both. Facts read the same day: agy's permissions are `allow`, `ask` and `deny` arrays of `action(target)` rules, with Deny over Ask over Allow, so a rule install adds can never loosen a rule the developer wrote; the default preset `request-review` asks before an MCP tool unless a rule allows it; `-p` refuses any action no rule allows and reports it in `denied_actions`; agy reads `~/.gemini/GEMINI.md` and `~/.gemini/AGENTS.md`. Found live on the dogfood machine: with agy installed and no `gemini` on PATH, an earlier install had written a Gemini CLI entry into `~/.gemini/settings.json`, because Gemini CLI is detected by the `~/.gemini` directory, which agy also creates. That is a gap in D51's "install wires only the agents that are present", closed here. The slug `agy` is the command's name, as `claude` and `codex` are, and leaves the archived IDE's `antigravity` slug to the uninstall sweep. D390 carries the approval rule to the three clients and reads this entry's allow rules as part of it. Roads not taken: install running `agy mcp add` (it runs the client to write a file install can write and back up itself, and it writes no permissions); `mcp(treecontext/*)` (it allows destruction); the block in `~/.gemini/AGENTS.md` as well (agy would read it twice); agy hooks (fenced)
# the owner, 2026-11-07, approving the charter draft as revised: "Approve, start unit 1"
# the build, 2026-11-08, unit 3's review, how the shared directory was settled: Gemini CLI is present when `gemini` is on PATH or one of its own artifacts is in `~/.gemini` (`installation_id`, `oauth_creds.json`, `google_accounts.json`, `trusted_hooks.json`, `tmp/`, or a key in `settings.json` other than treecontext's `mcpServers` entry, another server there counting as the developer's); `~/.gemini` itself and agy's `antigravity-cli/` and `config/` never count, so the bare directory no longer reads as Gemini CLI on a machine without agy either. A `settings.json` that does not parse counts as Gemini CLI's, since treecontext writes only JSON. A Gemini CLI entry with neither is an orphan: doctor warns that an earlier install wired Gemini CLI, which is not present, naming `treecontext uninstall --agent gemini`; install leaves it; it is not "still wired" when an uninstall decides whether to keep the shared GEMINI.md block. agy's rules are read as deciding a tool only in the shapes agy documents, `mcp(treecontext/<tool>)`, `mcp(treecontext/*)` and `mcp(*)`, exactly as written; any other shape that could touch a treecontext tool (a `regex:`, a case or whitespace variant, a glob inside a part, `mcp(treecontext)` with no slash) may decide it: install writes its allow beside it, every echo names it, and doctor warns that agy's handling of that shape is unverified. agy's two files are created 0600, as agy creates them, and a file install created and left empty is deleted at uninstall, never one the developer had
# the build, 2026-11-08, the final cross-unit review, amending the line above: install no longer writes its allow beside an agy rule that may decide a tool. Found live: a developer's deny `mcp(treecontext/treecontext_*)` still got all four allow rules. D390's wording as the owner approved it on unit 2's review, a grant install "never writes over or beside" a rule of the developer's, is later than the line above and wins over it: a rule that may decide is a deciding developer rule whose handling by agy is unverified, and either way no grant goes beside it. So install writes no allow for a tool such a rule touches, takes back one an earlier install wrote there (by its record), and says in its approvals line which tools it left alone and beside which rule; doctor keeps warning, naming the rule and its file, saying agy's handling of that shape is unverified and that install left the tool alone, and its remedy is the rule, the developer's to check, never an install

D384 2026-11-07 [I] amends D288
  trig:  a ticketed worker exits on its own with a non-zero code, or having printed nothing to its output [I]
  resp:  its summary row holds its last output, if it printed any, then treecontext's own line naming the exit code and the last `2000` characters of what it wrote to its error stream, saying when the earlier part was left out or when the stream was empty, so the journal says why it failed; the door still passes the error stream to the spawner as written and the output byte for byte (D307); a worker that exits with code `0` after printing something keeps the summary row of D288, its output alone, with nothing from its error stream; a cut stays as D292 has it, with no summary row; the send-back of D291 and D292 is unchanged, and the summary row records the last run; the rest of D288 stands: the worker is registered under the parent its ticket names, every row it writes sits in its own lane stamped with its role as writer and with the parent session, and it is retired at exit [I]
  sib:   none -- a failed worker retired with an empty summary row, a protected run row that is never evicted and says nothing, is what this prevents, not a behaviour
  serves: N27 N32 N30 N31 N28
  touches: D288 D291 D292 D307 D316 D351
# the owner, 2026-11-07, ruling R4, "Fix now": "When a worker exits non-zero or prints nothing, its summary row records the exit code and the tail of its stderr, so the journal says why. This amends D288's 'last output' rule, so it needs the ruling." Evidence, 2026-11-07: a worker that wrote only to stderr and exited 1 was retired "retired" with an empty subagent-summary row; the error was not in the journal. Today the door gives the worker's stderr straight to the spawner and never reads it, so this build copies the stream as it passes, keeping its end. The length is the owner's, 2026-11-07, answering the draft's first question with option (a): "The last 2,000 characters, carried wherever the summary goes", marked when cut. Disclosed: the end of the error stream goes everywhere the summary row goes, the run's skeleton export included, as stdout already does. Roads not taken: the first run's error carried into the send-back's message (a new line in the worker's first message, not ruled); the whole error stream as a row (what a run printed is not a row, D307)
# the owner, 2026-11-07, approving the charter draft as revised: "Approve, start unit 1"
# the build, 2026-11-08, unit 5: the door reads the worker's error stream through a pipe and hands each chunk on as it arrives, to the library caller's `onStderr` or this process's stderr, and the wrapper's stderr; a worker's stderr is therefore no longer a terminal, so a CLI that colours or animates only on a terminal writes plain text there. The wrapper puts its own line on a line of its own: after a stream whose last line had no line break it writes one before `treecontext:`, the worker's bytes unchanged before it. Bound through both spawners, the summary row read with SQL and the wrapper's own stdout and stderr bytes
# the build, 2026-11-08, unit 5 fixes, what the stderr pipe costs, disclosed and kept: (a) every run waits up to the 2 s drain (`STDOUT_DRAIN_MS`) after the worker exits when something still holds its stderr, a background process it started that did not redirect it; (b) once the run has settled the door closes its end of the pipe, so a background process the worker started that goes on writing to stderr gets SIGPIPE (EPIPE) on its next write, and should redirect its stderr. Pinned in tests/ticket-door.test.ts by a worker that leaves a background holder (the run takes the drain) and by one whose background writer is ended with status 141 after the run settled, so a change to the drain shows. The marker's total counts characters, not bytes: the long-stream scenario reads "the last 2000 of the N characters" against the multi-byte stream's character count, and a unit test reads 1500 two-byte characters as "all 1500 characters"
# the owner, 2026-11-09, amending the build's line of 2026-11-08 above on what the stderr pipe costs, its cost (b), as a dated amendment and not an edit in place: by D397 the door no longer closes its end of the error stream once the run has settled; it goes on handing the stream on, unref'd, so a background process the worker started is not sent SIGPIPE (EPIPE) while the spawner's process lives, and the `treecontext run` wrapper, which exits when its run settles, is that limit; cost (a), the wait of up to 2 s, stays, and so does the plain text where a CLI would colour a terminal; the pin in `tests/ticket-door.test.ts` of a background writer ended with status 141 is the build's to change with it. D397 amends this entry, restating it

D385 2026-11-07 [I]
  trig:  install runs again, with or without force, over a treecontext entry that an earlier build wrote or that the developer has since edited [I]
  resp:  install converges only what it owns in the entry: the command, its own arguments (`serve`, the transport, the capture and debug flags where its capture hooks are installed, the backend flag), Codex CLI's worker variables, and the four approvals of D381 where they are absent; every other key and argument the developer put in the entry stays as the developer left it, with or without force: a pinned store, `--instructions none`, a policy flag, a default approval, a list of enabled tools, an environment block; force is consent to rewrite what install owns even when it is valid, never consent to remove the developer's additions; the rest of D51 stands: install detects what exists, shows a dry-run plan, merges rather than clobbers, registers where the agent itself reads, doctor diagnoses honestly with fix commands, and uninstall reverses the wiring and never the record [I]
  sib:   none -- a reinstall, or the `install --force` that doctor itself prints as a fix, wiping a developer's pinned store or approvals while it repairs a stale command, is what this prevents, not a behaviour
  serves: N9 N26
  touches: D51 D278 D53 D120 D290 D381
# review finding, 2026-11-07, not a new ruling. A new entry or a binding gap? Both. The promise is D51's: "merges rather than clobbers", and "reinstalling converges". The scenarios bound it only for foreign servers and hooks, so keys inside treecontext's own entry are a surface with no scenario at all. That half is a binding gap under D51. But the forced-reinstall scenario said "restored to the canonical registration", and read literally that allows the wipe; and D381 adds keys that both install and the developer may write. So the boundary of what install owns needs a ruling, and this entry gives one. Evidence: `upsertTomlMcp` and `upsertJsonMcp` replace the whole entry whenever a check fails (no `--capture`, missing `env_vars`, a stale or bare command, a `--lexical` mismatch), dropping `default_tools_approval_mode`, `enabled_tools`, a pinned `--store` and `--instructions none`. Roads not taken: force rewriting the whole entry (doctor's printed fix would then destroy the developer's settings). Drafted as amending D51; entered without the relation, since D278 already amends D51 and a second amends would replace the driver ruling's shape: the link is in touches
# the owner, 2026-11-07, approving the charter draft as revised: "Approve, start unit 1"

D386 2026-11-07 [I] amends D208
  trig:  install writes, or doctor reads, an agent's treecontext entry [I]
  resp:  the entry starts the server in capture mode only for an agent whose capture hooks install wrote: Claude Code, and a copying client opted in by name under the experimental flag; every other agent's entry starts it without capture, and doctor reads that as correct, not as a warning, warning only when the mode disagrees with the hooks it finds; debug logs stay on by the server's own default, so removing the debug flag from an entry removes nothing doctor's log row reads; the rest of D208 stands: for every documented client doctor states which mode it has, its current installation state and whether that state is correct, and the remediation; the installer writes nothing for an as-is client, and copies the hooks into a copying client only behind the experimental flag [I]
  sib:   none -- doctor reading "server mode: capture" for a client that nothing captures, and calling the honest entry a problem, is what this prevents, not a behaviour
  serves: N23 N9 N3 N2
  touches: D29 D109 D208 D51 D385
# review finding, 2026-11-07, in the owner's direction for a clean install: today `mcpCommand` writes `--capture --debug` for every agent, Codex included, although only Claude Code has hooks unless `--experimental-capture` is given, and doctor's `hasModeProblem` treats a missing `--capture` as a problem, so a hand-made honest entry was "repaired" back. Disclosed residual, for the dogfood to check: a server without capture never holds the drain; a `claude -p` child's captures drain through the server of its own Claude Code entry, which keeps capture; whether anything a child captured under a Codex main is left in staging after the child exits is a fact the dogfood checks (count staging rows after the run). If rows are left, they wait for the next capture server and keep their own timestamps; that is a delay, and nothing is lost. Roads not taken: keeping capture on every entry (a capture-mode line on a client nothing captures is the promise D29 forbids)
# the owner, 2026-11-07, approving the charter draft as revised: "Approve, start unit 1"

D387 2026-11-07 [I]
  trig:  a developer runs doctor on a machine with Codex CLI or Antigravity CLI installed [I]
  resp:  the client's row says whether a headless worker of it can use the tools, from what its configuration holds; for Codex CLI: the worker variables forwarded and each of the four tools approved, naming any variable missing and any tool a `codex exec` worker would be refused, with `treecontext install --agent codex` as the remedy where install would write the fix, and the configuration line where the developer's own setting is in the way; a default of the developer's that approves every tool is stated in words, not warned; for Antigravity CLI: its MCP entry, the four allow rules, and any ask or deny rule of the developer's over one of them, named with its file; on Linux doctor runs Codex's own sandbox check, which calls no model, and when the check fails because the system refuses bubblewrap a user namespace, a row warns that a sandboxed Codex worker can read no file and names the steps for the developer to run (the `bubblewrap` package; an AppArmor profile that lets `/usr/bin/bwrap` create user namespaces, loaded with `apparmor_parser -r`), saying that treecontext changes no system file; another failure is quoted in the check's own words; on another OS, or with no Codex, there is no sandbox row; the rest of D161 stands: for every documented client doctor states its mode, its current installation state and whether it is correct, and the remediation [I]
  sib:   none -- doctor reading [ok] for a Codex whose headless worker can call no tool, or whose sandbox lets it read nothing, is what this prevents, not a behaviour
  serves: N9 N26 N27
  touches: D161 D208 D386 D51 D120 D290 D381 D383
# the owner, 2026-11-07: "good diagnostics (tc doctor)". Evidence, 2026-11-07: doctor's Codex row read [ok] while headless `codex exec` could call no tool; there was no agy row (fenced, D370). Codex on Linux sandboxes with bubblewrap. On Ubuntu 24.04 (`kernel.apparmor_restrict_unprivileged_userns=1`), both Codex's vendored bwrap and `/usr/bin/bwrap` failed ("bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted") until the package was installed and a profile `profile bwrap /usr/bin/bwrap flags=(unconfined) { userns, }` (the flatpak pattern) was loaded. Until then a read-only Codex worker could not read a file. `codex sandbox -- true` tests the sandbox with no model call. Running the check is D51's "proves health rather than inferring it", as D290 runs `claude --version`. Roads not taken: install writing the AppArmor profile (a system file, needing root; treecontext writes none); a version table of distributions (the check asks the system). Drafted as amending D161; entered without the relation, since D208 and D386 already carry D161's chain and a second amends of D161 would replace that shape: the link is in touches
# the owner, 2026-11-07, approving the charter draft as revised: "Approve, start unit 1"
# the build, 2026-11-08, unit 3's review, the project layer of agy's row: a project file under `~/.gemini/config/projects/` is read in agy's undocumented format, and doctor says so; it applies to the directory it names or the nearest one above (the longest match, compared by realpath), a bare `/` only where nothing longer matches and said to be a weak match; its rules take precedence over the global file's, as agy states, and deny beats ask beats allow within one file. The outline's states are in the global file only; the project layer is unit-tested, not bound. Where agy's settings file does not parse, the remedy is to fix its JSON by hand, quoting the parse error, never an install, which skips a file it cannot read

D388 2026-11-07 [I]
  trig:  a developer reads the README to run a headless worker on Claude Code, Codex CLI or Antigravity CLI, or reads the orchestration matrix [I]
  resp:  the README has a section on headless workers, giving for each client the `treecontext run` line that starts one (`agy -p` with `--message-arg`, since agy takes the prompt as its own value; `claude -p` with no `--allowedTools` for the four tools, install's approvals covering them, and a warning that `--allowedTools` takes several values and swallows a prompt that follows it), what install sets up for it, what the developer must still do (Codex's sandbox steps on Linux), that a worker reads and writes but never removes or brings in rows and that such a request is refused, that it skips orientation, how a failed run reads in its summary row, and the doctor rows that say it is ready; in the orchestration matrix every "verified live" cell names the permission mode its run used, the live runs the matrix recorded before this build are named as made with the clients' bypass flags (`--dangerously-bypass-approvals-and-sandbox`, `--dangerously-skip-permissions`), and the worker and pen cells of Codex CLI and Antigravity CLI are verified live again with neither flag after this build, Antigravity CLI's pen cell saying that install writes its entry and allow rules; no cell rests on a run made with a bypass flag unless it says so; the hook-support matrix gains a row for Antigravity CLI, documented only, with the date of the hooks documentation read; the README carries a short copy-paste example of a dispatcher for Claude Code users, and treecontext ships no skill for it; the rest of D370 stands: the orchestration matrix is its own table, one row per client and one column per orchestration role, every cell one of the four statuses with its date, a `not possible` cell naming the vendor's gap, and capture promised only where verified live [I]
  sib:   none -- a "verified live" cell resting on a run that bypassed the very approvals a default worker meets, as the earlier cells did without saying so, is what this prevents, not a behaviour
  serves: N23 N25 N27
  touches: D370 D383 D153 D152 D381 D382 D384 D387
# the owner, 2026-11-07: "good documentation on how to use headless cli", and "steps to take to get it done". Evidence: the cells of 2026-11-01 for Codex CLI and Antigravity CLI were run with `--dangerously-bypass-approvals-and-sandbox` and `--dangerously-skip-permissions`, and the cells did not say so; the agy cell gives `agy mcp add treecontext -- treecontext serve` without the installer's arguments. A docs fact, not a promise: on Codex 0.167 the read-only sandbox is described to the model as a read entry `:root`, and a model at low effort misread that as "cannot read" until the prompt said otherwise; the README carries that hint. The dispatcher line is the owner's, 2026-11-07, after D390: "so these changes largely obviate the need for dedicated skills". Roads not taken: the old cells kept and a footnote added (a cell must carry its own condition, D153's date rule applied to permissions); an installed dispatcher skill (install's approvals and the ticket door make most of its work unnecessary, and a skill is one more file to install, version and uninstall). Drafted as amending D370; entered without the relation, since D383 amends D370 the same day and a second amends would replace that shape: the link is in touches
# the owner, 2026-11-07, approving the charter draft as revised: "Approve, start unit 1"

D389 2026-11-07 [I]
  trig:  a spawner starts a worker through the ticket door, by `treecontext run` or the library call, from an environment a client session gave it, Claude Code's Bash among them [I]
  resp:  the door hands the worker none of its spawner's own client-session variables: the variables by which a client session names itself or opens a channel back into itself are left out of the worker's environment, by a named list per client kept in one place, each name with the evidence it was seen; for Claude Code `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_PID`, `CLAUDE_CODE_MESSAGING_TOKEN` and `CLAUDE_CODE_MESSAGING_SOCKET`; the door's own two, `TREECONTEXT_TICKET` and `TREECONTEXT_WORKER_SESSION`, are set as before; every other variable reaches the worker unchanged, a client's configuration (`CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_USE_BEDROCK`) and credentials among them; the rule holds for every spawner, including a library caller that passes its own environment [I]
  sib:   none -- a worker of another vendor's model holding a token and a socket into the session that spawned it, which agy then passes to its MCP servers and shells, is what this prevents, not a behaviour
  serves: N32 N27 N8
  touches: D288 D294 D295 D298 D307 D335
# the owner, 2026-11-07, choosing "Add D389", whose option read: "General door rule for every spawner, with a scenario and a live check that a `claude -p` worker still works after the scrub." Evidence, 2026-11-07: a worker started through `treecontext run` from inside Claude Code's Bash inherited `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_PID`, `CLAUDECODE=1`, `CLAUDE_CODE_CHILD_SESSION=1` and `CLAUDE_CODE_SESSION_ID`; an adversarial review confirmed it with an `env` worker. agy passes its whole environment to its MCP servers and shells, so a foreign model held a channel back into the spawning session. Today the door builds the worker's environment as the spawner's whole environment plus its two variables (`ticket-door.ts`). Why a named list and not a prefix rule: treecontext itself reads no `CLAUDE_CODE_*`, `CLAUDECODE` or `CLAUDE_PID` anywhere in `src/` (it reads `CLAUDE_CONFIG_DIR`, a location, not a session); a `claude -p` child's session-start hook takes its session id from the hook payload and its ticket from `TREECONTEXT_TICKET` (`hooks/session-start.ts`, `ticket.ts`), and the session beacon is keyed by the parent process id, not the environment; but a prefix rule on `CLAUDE_CODE_` would also strip the client's own configuration, `CLAUDE_CODE_USE_BEDROCK` and its kind, and break a `claude -p` worker on a Bedrock or Vertex account. The named list leaves those alone. Its cost, disclosed: a session variable the client adds later passes until it is named; the dogfood's `env` worker, run from inside each client's shell at each release, is how a new one is found, and naming it is the means of this entry, not a new ruling. Codex CLI's and Antigravity CLI's lists start empty and are filled from the same `env` run. Roads not taken: a prefix rule (above); an allow-list environment for workers (it would drop the credentials and settings every worker needs, client by client); scrubbing in the hooks instead (the hooks door never spawns, the ticket door does)
# the owner, 2026-11-07, approving the charter draft as revised: "Approve, start unit 1"

D390 2026-11-07 [I] amends D381
  trig:  install wires Claude Code, Codex CLI or Antigravity CLI, or the developer changes tool approvals afterwards [I]
  resp:  one approval rule for the three clients: install pre-approves the four tools that read and write, status, query, export and insert, in each, Claude Code included, through `mcp__treecontext__treecontext_status`, `mcp__treecontext__treecontext_query`, `mcp__treecontext__treecontext_export` and `mcp__treecontext__treecontext_insert` added to `permissions.allow` in Claude Code's `settings.json`, beside Codex's per-tool approvals in its treecontext entry and the agy allow rules of D383; clear, delete, import and merge keep asking in all three, so a headless worker reads and writes the journal and never removes or brings rows in, its request for those refused; each grant is merged into the client's file, recorded for uninstall, and never written over or removed where the developer wrote a rule or approval of their own, allow, ask or deny, or a default for the server, which always wins; a Codex older than the first version verified to read per-tool approvals gets none written, and install and doctor say in one line that its headless workers need a newer Codex, naming the version; install prints one message naming what it approved and where, what still asks, and the way back (`treecontext config tool-approvals off`, or `install --no-tool-approvals`); `treecontext config tool-approvals on|off`, with `--agent <name>` for one client, echoes the behaviour it leaves in force, as `config checkpoint-interval` does, and removes or re-adds only what install wrote; `install --no-tool-approvals` writes none; an off chosen either way is recorded and every later install honours it until `config tool-approvals on`; doctor's row for each client shows the state, and an off is a chosen state, not a failure, saying that headless workers will be refused the tools and naming `treecontext config tool-approvals on` as the remedy; install asks no question [I]
  sib:   none -- a developer surprised by approvals they never saw granted, or one who cannot find the way back, or a `claude -p` worker refused every tool unless its spawner remembers `--allowedTools`, is what this prevents, not a behaviour
  serves: N27 N9 N15 N25 N26
  touches: D381 D383 D387 D388 D51 D290 D385 D156
# the owner, 2026-11-07, answering the draft's second question: "so these changes largely obviate the need for dedicated skills. i would say based on anthropic's blog, auto approve is becoming nearly universal. so maybe ask at install, or change on install, with clear message on how to change it back (or flag to change it back)?", then choosing "Change + announce": "Install pre-approves status/query/export/insert in all three, prints what it did and the undo (`treecontext config tool-approvals off` or `install --no-tool-approvals`); doctor shows the state. Destructive tools keep asking. Resolves Q2 as yes." This entry amends D381, restating it for the three clients, and amends the allow-rule clause of D383 the same way; the header carries one relation, as the grammar has it. That an off is recorded and honoured by later installs is the drafter's reading of "the undo": without it, the next plain install would quietly undo the developer's off, the D290 rule for a key the user set. Claude Code, like agy, ranks deny over ask over allow, so an allow install adds cannot loosen a rule the developer wrote. Roads not taken: asking y/N at install (install often runs with `-y`, from scripts or by agents, where nobody can answer); `--allowedTools` on every `claude -p` line (the spawner must remember it, and the flag takes several values and swallows a prompt that follows it); a dispatcher skill (D388)
# the owner, 2026-11-07, approving the charter draft as revised, including the drafter's reading that a chosen off persists across later installs: "Approve, start unit 1"
# the owner, 2026-11-08, on unit 2's review: "yes, make the rewording": the off-and-on outline's last Then, "shows the four approved again", now reads "shows install's grants back for each of the four that no rule of the developer's decides", since the literal words could not hold beside a developer's rule over one of the four, which install never writes over or beside (this entry's "the developer's own rules always win")
# the build, 2026-11-08, the final cross-unit review (MED-2), uninstall without install's record: with `install-state.json` unparsable, `uninstall -y` had said "Uninstall complete" and left install's approvals (Claude Code's and agy's `permissions.allow`), `idleCompaction` and the files install created. Only the record tells install's writes from the developer's (D361, this entry), so uninstall still removes none of them: it warns, moves the record aside as install does (`install-state.json.corrupt-<UTC moment>`), and lists for each client in its scope the settings file and the shapes install writes there (the four `mcp__treecontext__<tool>` rules and `"idleCompaction": false`; the four `mcp(treecontext/<tool>)` rules; agy's two files, if install created them) for the developer to remove by hand, and ends "Uninstall incomplete". It exits 0, as install does over the same record: nothing failed, the developer has the list, and a non-zero exit would fail scripts over a state only a person can settle

D391 2026-11-09 [I]
  trig:  a curated insert, through the tools or the library, carries the text of a curated row the store already holds, so curated dedup finds a surviving row and no new row lands [I]
  resp:  a curated dedup hit never modifies another lane's row: the resume-pointer tags the insert carries, `next_session` or an active status, are armed on the surviving row only when it sits in the caller's own lane, read as every pointer reader reads a lane (D379), and are left off it otherwise, as the insert's references already are; the drain's echo heal of a hit's insert changes the surviving row only when the insert came from the survivor's own lane, as when two sessions of one lane insert it within one correlation window (D86); the insert's reply on a hit names the surviving row's writer and lane, and says that nothing landed in the caller's lane; a ticket-door worker's curated dedup is scoped to its own lane, which is its whole session, so two workers, or a worker and the main session, writing the same text leave two rows, one in each lane; a hooks-door subagent leg keeps today's dedup until `0.1.0-beta.5`, disclosed, because it shares its parent's session, so its lane is no session the dedup can be scoped by (D392); the rest of the dedup matrix stands: auto-capture dedups only within its session and the dedup window, curated dedup outside a worker's lane stays idempotent across sessions, and the two classes never dedup against each other [I]
  sib:   none -- a worker's note swallowed by a row in another lane so that its own lane holds no record of it, or a hit re-arming a resume pointer that the other lane's own writer retired, is what this prevents, not a behaviour
  serves: N5 N23 N27 N32 N17
  touches: D2 D169 D86 D9 D240 D288 D379
# the owner, 2026-11-09, choosing "Adopt all (Recommended)", whose option read: "Q1 bug fix + honest reply now; Q2 row; Q3 narrower POSIX-group promise + kill on any signal exit + docs; Q4 defer SessionEnd and remove the /clear stop; Q5 keep forwarding stderr; Q6 no redaction, D318 export warning; Q7 move the agy case to the D294 outline.", and for Q1's scope "Workers now, legs in beta.5 (Recommended)": "Ticket-door workers dedup only within their own lane in beta.4 (additive index); Claude Code subagent legs follow in beta.5 with workflows." The consensus the owner adopted (journal d3cd859e, recorded as ruled in f2fcb0e4): "fix mergePointerFlags (a dedup hit never modifies another lane's row), and the reply names the survivor's writer and lane and says nothing landed. Curated dedup never crosses writers' lanes for ticket-door workers in beta.4 (a session-scoped unique index for worker lanes, an additive migration); hooks-door legs in beta.5." Evidence, 2026-11-08, from the adversarial pass at 2103fb3: the curated dedup key is the tree and the fingerprint, outside handoff lanes (`curated-index.ts`), with no session, lane or writer in it, so a worker's note that another lane already holds lands no row of its own, against D288's "every row it writes sits in the worker's own lane", and D9's reason applies: two agents observing the same thing are two observations; on a hit `mergePointerFlags` (`flat-store.ts`) arms `next_session` or an active status on the survivor whoever's lane it sits in, while `unrecordedRefs` beside it refuses the same for references, citing D169; the reply named the caller's writer stamp, not the survivor's. Drafted as amending D2, the owner's question naming "D2's 'global idempotent dedup across sessions'": that D2 is the number `flat-store-dedup.feature` gives the dedup matrix from the decision record before the docket backport, which the backport never transcribed as an entry; the docket's D2 is the pitch, and an amends of it would put this entry in the pitch's place; entered without the relation, the link in touches, and the design feature's header now names this entry. The drafter's readings: the caller's lane and the survivor's are read as the pointer readers read them (D379), and where either cannot be told the tags are not armed; the ambiguity flag of D86 is the echo heal of a hit, so it stays within one lane. Roads not taken: "Keep global dedup" ("Only the bug fix and the honest reply; identical text stays one row store-wide": a worker's write would still leave no row in its own lane); "All lanes in beta.4" ("Scope dedup per lane for every writer now, including subagent legs": a hooks-door leg shares its parent's session, so a session-scoped index cannot reach its lane before the workflows of beta.5)
# the owner, 2026-11-09, "Adopt all (Recommended)"
# the build, 2026-11-09, unit 7a's review: a ticket-door worker's lane is its whole session (D288), so for a worker serve trusts (the lane `trustedWorkerLane` hands it, stamped by the registry `declared` with agent id `worker`) the row's session is that lane: a `session_id` in the caller's metadata, which ranks first in the session a row is keyed by and had keyed a worker's `worker_curated` row to the main session, is left off the row and said back as `session_id_ignored` with `session_id_note`. Other callers' `session_id` is unchanged, the owner to rule on it separately, and so is the library's leg door, which keys a leg's row by a `session_id` its caller's metadata names in the same way. Pinned through the real insert tool in tests/worker-lane-dedup.test.ts, the worker scenario's words not reaching a caller's metadata. Also: a hit's echo from another lane (`other-lane`) still publishes the session's namespace (CORRELATED_ECHO_OUTCOMES): it changes nothing of the row, and a hit is found within one tree, so the survivor's namespace is the caller's; the flags note of a caller the store could not tell apart (D240) says so, never that the entry is another lane's; the reference body says that on a hit `writer` and `lane` are the surviving row's and `landed` is false; migration 033 is beta.4's schema bump (v32 to v33), and the README's upgrade note says beta.3.1 then refuses the store and going back restores the pre-migration copy. Two scenarios bind the store's writers this entry reaches that no scenario held, in journal-orchestration: the drain's echo heal of a hit from another lane, the survivor's attribution read from the session beacon (an exact one no in-window echo changes, D86), and the references such a hit carries, refused and said back; both through the tools, the real post-tool-use hook and the drain, the survivor read with SQL

D392 2026-11-09 [I]
  trig:  a hooks-door subagent leg inserts the text of a curated row that another lane holds [I]
  resp:  curated dedup scoped to a hooks-door leg's own lane waits for `0.1.0-beta.5` and its workflows: until then such a leg's identical insert finds the surviving row as today, its reply naming the survivor's writer and lane and saying that nothing landed in the leg's lane, and the hit modifies nothing of the survivor's lane (D391); the leg shares its parent's session, so its lane is no session a unique index can be scoped by [I]
  ->     fence-deferred leg-lane-dedup
  touches: D391 D279 D169
# the owner, 2026-11-09, for Q1's scope, "Workers now, legs in beta.5 (Recommended)": "Claude Code subagent legs follow in beta.5 with workflows." The residual is disclosed in D391's resp and on the fence
# the owner, 2026-11-09, "Adopt all (Recommended)"

D393 2026-11-09 [I] amends D292
  trig:  a ticketed headless worker ends by a signal or a kill before any checkpoint under its key, whoever sent it: the door at the harness's timeout or the spawner's abort, the harness itself, or the system [I]
  resp:  an exit by signal is a cut, whoever sent the signal, and so is a run the door signalled, whatever exit code the worker then gives: the worker is retired as cut with every row it wrote in its lane, no summary row and no send-back, the harness's lookup returns the checkpoint still in effect with the leg shown as cut, and the next leg of that role starts as a recovery leg; on Linux and macOS a cut by the door, and any exit of the worker by signal, ends the worker's process group, every process the worker started that is still in that group; the README states the limits: on Windows only the direct child is ended, and a process that left the group, by `setsid` or a detached spawn, is not reached; that nothing the worker started outlives a cut is not promised (D394); only a worker that exited on its own, whatever its exit code, gets the one send-back of D291 [I]
  sib:   none -- a harness's timeout paid twice for a worker that was never going to finish, or a worker's command left running in its group after the worker was killed by a signal the door did not send, is what this prevents, not a behaviour
  serves: N27 N28
  touches: D292 D279 D291 D288 D384
# the owner, 2026-11-09, choosing "Adopt all (Recommended)" ("Q3 narrower POSIX-group promise + kill on any signal exit + docs"); the consensus adopted (journal d3cd859e, f2fcb0e4): "amend D292 to a narrower promise: a door cut, or any exit by signal, ends the worker's POSIX process group. The group kill runs on every exit by signal; the README states the limits (Windows descendants, processes outside the group). The wider promise waits for a per-CLI live probe." Evidence, 2026-11-08, the adversarial pass at 2103fb3: the door's last SIGKILL to the group runs only when the door itself signalled (`signalled`, `ticket-door.ts`), so a harness that kills the leader directly, or the system's out-of-memory killer, leaves the group alive; on Windows the door makes no group and `child.kill` ends the direct child alone; a CLI may run its tool commands in a group or session of their own, unverified for Claude Code, Codex CLI and Antigravity CLI. This entry restates D292 whole and lifts into its resp the build's line of 2026-11-08 under D292, "a run the door signalled is a cut" whatever the exit code, since the owner's "a door cut" names it. Not verified and not promised: that macOS gives out no number still used as a live group's id, which the build's reuse check under D292 rests on. Roads not taken: the wider promise as first put, "nothing a worker started outlives a cut" (false today for a kill the door did not make, on Windows, and for a command that left the group; fenced, D394); a tree kill on Windows (`taskkill /T /F`) at the cut (raised by the review, not in the consensus adopted; the README states the limit instead)
# the owner, 2026-11-09, "Adopt all (Recommended)"
# the build, 2026-11-09, unit 7b: at any exit of the worker by a signal, and at a run the door signalled, the door ends what is left of the group (`endGroup`, ticket-door.ts): SIGTERM to the group, then SIGKILL once `GROUP_GRACE_MS` (1 s) is out if a member is still there, each signal sent by the group's number only while `reapedGroupIsOurs` holds; the run settles only after it, so the wrapper never exits with the group's end undone. Bound at journal-workers through the wrapper with a real `sleep 600` the stand-in starts in its own group, found by the group's id before the signal and read from the host's process table after (the wrapper's `--timeout`, and a SIGKILL the test sends to the worker's process), host-skipped on win32 by title; the grace is unit-tested in tests/ticket-door.test.ts by a survivor that writes down the SIGTERM it got, and one that ignores it and is killed after the grace

D394 2026-11-09 [I]
  trig:  a developer or a harness expects that nothing a worker started outlives its cut [I]
  resp:  the wider promise, that nothing a ticketed worker started outlives a cut, is declined for now: a CLI may run its tool commands outside the worker's process group, and on Windows the door ends only the direct child; the promise of D393, the worker's process group on Linux and macOS, is what holds; the question reopens when a live probe per CLI, Claude Code, Codex CLI and Antigravity CLI, on Linux and on macOS, has a worker start a long-running command through its own tool, cuts the worker, and reads whether the command is gone [I]
  ->     fence-deferred cut-reaches-every-descendant
  touches: D393 D292
# the owner, 2026-11-09, adopting the consensus: "The wider promise waits for a per-CLI live probe." The probe the review named: "the worker starts `sleep 600` through its tool; cut it; then `pgrep sleep`"
# the owner, 2026-11-09, "Adopt all (Recommended)"

D395 2026-11-09 [I]
  trig:  a Claude Code session ends with no /clear, by a plain exit, and its self registration is left as it was [I]
  resp:  a SessionEnd hook is declined for now: install wires none, and nothing in the store marks a session ended at a plain exit; session liveness, a session's end as well as its start, is ruled once, in `0.1.0-beta.5` with workflows [I]
  ->     fence-deferred session-end-hook
  touches: D190 D216 D297
# the owner, 2026-11-09, choosing "Adopt all (Recommended)" ("Q4 defer SessionEnd and remove the /clear stop"); the consensus adopted (journal d3cd859e, f2fcb0e4): "defer SessionEnd to beta.5, and remove the /clear stopSelf writer now (no reader, no scenario)." Noted for that ruling, from the adversarial pass: a SessionEnd hook would not fire on a crash or a kill, so liveness would still need a check like the phantom pass of D297; whether the README's hook-support row for Claude Code should list SessionEnd is a documentation question the pass left open
# the owner, 2026-11-09, "Adopt all (Recommended)"

D396 2026-11-09 [I]
  trig:  a /clear continues a session whose self is registered, or a session with a self registration ends in any other way [I]
  resp:  a self registration's stop moment is declined until `0.1.0-beta.5`: the store records no stop for a self, at a /clear or at any other end, and no reader reads one; the /clear's stop of its predecessor's self that the build added is withdrawn, since what the fence declines no writer of the build may write; a /clear still retires the predecessor session's live subagents, as D240 has it [I]
  ->     fence-deferred self-stop-moment
  touches: D190 D216 D240 D395
# the owner, 2026-11-09, adopting the consensus: "remove the /clear stopSelf writer now (no reader, no scenario)." Evidence, 2026-11-08, the adversarial pass at 2103fb3: the only writer of a self's stop is the session registry's (`session-registry.ts`), called by the session-start hook on a /clear, and nothing reads it; since only a /clear stops a self, a later reader taking an open self as live would be wrong for every plain exit. A writer with no scenario is the rung AGENTS.md names: "a fence may decline a promise, never a writer: anything that writes to the store is in the charter or out of the build". The unit test that pins the stop today (`tests/hooks/session-start-chain.test.ts`) goes with the writer, the build's to change
# the owner, 2026-11-09, "Adopt all (Recommended)"
# the build, 2026-11-09, unit 7b: `stopSelf` and its call in the session-start hook are removed, and the two writers that stop a subagent or a leg by its agent id (`retireSubagent`, `retireLeg`) now refuse the self's agent id `''`. Pinned in tests/hooks/session-start-chain.test.ts through the real hooks (a /clear retires the predecessor's live subagent and leaves its self's `stopped_at` NULL; a resume leaves it NULL) and over the source (every statement in src that writes `stopped_at` writes NULL, or a moment only where its WHERE excludes agent id `''`; the guard is shown the withdrawn writer and reads it as reaching a self). `registerSelf`'s `ON CONFLICT … stopped_at = NULL` stays: it records no stop, and on a resume it clears one a build with unit 5's writer left
# the build, 2026-11-09, unit 7b fixes: unit 5's `stopSelf` ran only in test and temp homes, never in a shipped build and never in the owner's real store (which ran beta.3.1's hooks), so no store carries its stops and no migration is needed. Also: the grace between the group's SIGTERM and SIGKILL (about a second) is the README's current behaviour, not a promise: D393 promises that the group ends, not when.

D397 2026-11-09 [I] amends D384
  trig:  a ticketed worker exits on its own with a non-zero code or having printed nothing, or leaves a background process holding its error stream when the run settles [I]
  resp:  the worker's summary row holds its last output, if it printed any, then treecontext's own line naming the exit code and the last `2000` characters of what it wrote to its error stream, saying when the earlier part was left out or when the stream was empty, so the journal says why it failed; the door passes the error stream to the spawner as written and the output byte for byte (D307), and once the run has settled it goes on handing the error stream on as it arrives instead of closing its end, so a background process the worker started that still writes there is not sent SIGPIPE, for as long as the spawner's process lives; the door still waits up to `2` s after the worker exits for the end of the stream before the run settles; the worker's error stream is a pipe, not a terminal, so a CLI that colours or animates only on a terminal writes plain text there, disclosed; a worker that exits with code `0` after printing something keeps the summary row of D288, its output alone, with nothing from its error stream; a cut stays as D393 has it, with no summary row; the send-back of D291 and D393 is unchanged, and the summary row records the last run; the rest of D288 stands: the worker is registered under the parent its ticket names, every row it writes sits in its own lane stamped with its role as writer and with the parent session, and it is retired at exit [I]
  sib:   none -- a failed worker retired with an empty summary row, or a background process the worker left behind ended by SIGPIPE at its next write once the run settled, is what this prevents, not a behaviour
  serves: N27 N32 N30 N31 N28
  touches: D384 D288 D291 D292 D307 D316 D351 D393
# the owner, 2026-11-09, choosing "Adopt all (Recommended)" ("Q5 keep forwarding stderr"); the consensus adopted (journal d3cd859e, f2fcb0e4): "accept D384's pipe; keep forwarding stderr after settle (unref'd) instead of destroying it." Evidence, 2026-11-08, the adversarial pass at 2103fb3: stdout was already a pipe with the same `2` s drain, destroyed at settle, so a background process holding both streams already paid; what D384's pipe added is the process that redirects its output and not its error stream, `nohup cmd > log &` being the common idiom, since nohup leaves a non-terminal error stream alone; for the three CLIs the likely holder is an MCP server the CLI started with its error stream inherited, `treecontext serve` among them. The drafter's limit, disclosed in the resp as "for as long as the spawner's process lives": the forwarding is unref'd, so it keeps no process alive; a library caller that goes on running keeps the stream open, while the `treecontext run` wrapper exits when its run settles, and a background process that writes to the stream after the wrapper is gone meets a closed pipe. This entry restates D384 whole, the dated amendment the build line below D384 points to. Roads not taken: the worker's error stream as an unlinked temporary file, tailed while it runs and read at exit (no SIGPIPE and no wait; raised by the review as later work, not adopted now); an opt-out that leaves the error stream inherited (raised by the review, not in the consensus adopted)
# the owner, 2026-11-09, "Adopt all (Recommended)"
# the build, 2026-11-09, unit 7b: at the settle the door destroys the worker's stdout as before and only unrefs its stderr, whose chunks go on to the spawner's `onStderr`, this process's stderr, or nowhere under `stderr: 'ignore'` (still read, so the pipe never fills). Bound at journal-workers through the library spawner with a real node process the stand-in starts holding its error stream alone, whose numbered lines after the settle are read in order from the chunks handed on; unit 5's pin of status 141 in tests/ticket-door.test.ts is replaced by the same shell writer exiting 0, the stream handed on and ignored

D398 2026-11-09 [I]
  trig:  a run is exported in its default skeleton form and a leg's summary row holds the end of its worker's error stream, the worker having failed or printed nothing (D397) [I]
  resp:  the export's reply carries one line, after the line about first moments and the line of D368, naming each leg whose summary row holds the end of its worker's error stream and saying that a CLI may write command output there, so for those legs the skeleton carries captured output after all; nothing is redacted and nothing is left out; a run with no such leg has no such line; the README says the same where it describes the skeleton; the rest of D318 and D368 stands: the skeleton carries every first moment whole, the reply says in one line that first moments carry the spawners' prompts as written, a second line names each leg whose first moment is the hooks door's own line, the file's head carries those two lines, and no acknowledgement is asked for the skeleton [I]
  sib:   none -- a reviewer who shares a skeleton as the form that holds no tool output while a failed `codex exec` worker's command output rides in its summary row unnamed, is what this prevents, not a behaviour
  serves: N31 N28
  touches: D318 D368 D300 D384 D397
# the owner, 2026-11-09, choosing "Adopt all (Recommended)" ("Q6 no redaction, D318 export warning"); the consensus adopted (journal d3cd859e, f2fcb0e4): "no redaction. Amend D318 so the skeleton export's reply warning names failed runs' error tails; the README too." Evidence, 2026-11-08, the adversarial pass at 2103fb3: D300 made the skeleton the form holding no captured tool output, but `codex exec` writes its command output to its error stream, so a failed codex worker's summary row carries command output, for that worker the journal's only copy of it, while the skeleton's reply warned only about first moments (`run-export.ts`). Drafted as amending D318; entered without the relation, since D368 already amends D318 and a second amends would replace that shape, D368 included: the link is in touches. The drafter's readings: the line names each such leg, as D368's line names its legs, and comes after D368's; the owner ruled the reply and the README, so the file's head is not ruled to carry this line, and the export tool's own description of the skeleton ("no captured tool output") is left for the build to bring in line with the reply, a charter surface under D8. Roads not taken: redaction of the error tail, for two reasons: false confidence (a scrub's patterns miss the key shapes of these very CLIs, the repository's own release scan matching `sk-` followed by eight lower-case letters or digits and so missing `sk-ant-` and `sk-proj-` keys, and a reader told the tail was scrubbed trusts what slipped through), and design decision 2 (capture is never filtered: the tool-output rows of the same run already carry the same secrets unredacted, and the control is at the sharing boundary, the `whole` form's acknowledgement and this line); the tail moved to an evictable door-capture row (against the owner's "The last 2,000 characters, carried wherever the summary goes", D384)
# the owner, 2026-11-09, "Adopt all (Recommended)"
# the build, 2026-11-09, unit 7a and its review: the file's head carries the error-tail line too, under `error_tails` after `first_moments`, and its `holds` sentence names it, though the ruling names the reply and the README: the head is the only place an export written inline, whose reply is the file itself, carries the line, so it is kept. Bound at journal-runs under this entry's scenario, whose step on the file it exports reads the head beside the summary rows (the line the reply carries, after the first-moments line); the inline form is unit-tested in tests/run-export.test.ts

D399 2026-11-09 [I] amends D383
  trig:  a developer runs install, doctor or uninstall on a machine where Gemini CLI is installed, or where an earlier install wired it [I]
  resp:  Gemini CLI is retired as an archived platform, as the Antigravity IDE was (D109): it leaves the agent table, install never detects or wires it, writing no MCP entry and no copy of the hooks in `~/.gemini/settings.json` whether Gemini CLI's own command or files are there or not, and an install naming it, with or without the experimental flag, is refused in one line that says it is retired and names Antigravity CLI and the command that removes an old entry; a full uninstall, and `treecontext uninstall --agent gemini`, sweep what an earlier install wrote for it, the treecontext entry and the hooks it copied into that settings file and the `tc-gemini-*` wrappers, and nothing else of the file, every other key and hook of the developer's staying, and a full uninstall also takes the block an earlier install wrote into `~/.gemini/GEMINI.md` where Antigravity CLI is not wired; doctor gives Gemini CLI no client row, and where any of that is left it warns in one row that Gemini CLI is retired, naming what is left and `treecontext uninstall --agent gemini`, which sweeps the archived platforms and touches no wired agent; the instruction block in `~/.gemini/GEMINI.md` is Antigravity CLI's alone, written by its install and removed by its uninstall, the rest of the file kept; agy's `~/.gemini/config/` and `~/.gemini/antigravity-cli/` are handled as D383 has them; the copying clients of D154, D161 and D208 are Codex CLI alone; the compatibility and orchestration matrices carry no Gemini CLI row [I]
  sib:   none -- a developer who follows Google's move to Antigravity CLI and is left with an install that still wires, grades and advertises a client nobody ships, or with an old entry nothing names, is what this prevents, not a behaviour
  serves: N9 N23
  touches: D383 D161 D154 D208 D109 D152 D153 D29 D51 D386
# the owner, 2026-11-09, on Gemini CLI: "gemini has been deprecated by google - only agy", then "go ahead and remove gemini stuff too". This entry amends D383, whose shared `~/.gemini` and shared GEMINI.md block it ends: the block is agy's, so uninstalling agy removes it, and the rule that kept it while Gemini CLI was still wired goes, with Gemini CLI's presence test (its artifacts in `~/.gemini`, D383's build line of 2026-11-08) and the orphan row, whose remedy is now the archived sweep's. It amends D161's and D208's copying clause the same way, Gemini CLI's translated copy leaving with its row: the header carries one relation, as the grammar has it, and the link is in touches. D152's and D153's teammate on another agent, "GPT or Gemini among them", reads through the tools from any agent still; the charter's teammate on another agent is now on Antigravity CLI, and D29's promise that nothing claims an unverified adapter works now has one adapter fewer to keep, the Gemini hook adapter being removed from source. D386's capture rule is unchanged: Gemini CLI was a copying client opted in by name and is no client now. The remedy is `treecontext uninstall --agent gemini` rather than a new flag: with no agent of the table named, that run is the archived sweep alone, which every uninstall that is not hooks-only already ran for the archived five, so the command doctor named for the orphan keeps working and removes what it names and nothing else. Roads not taken: Gemini CLI kept as a documented-only row with no wiring (a row for a client its maker deprecated reads as support); detection kept and wiring dropped (install would read a client it then refuses to touch, and doctor would grade it)
# the owner, 2026-11-09, "go ahead and remove gemini stuff too"
# the build, 2026-11-09, unit 7c review fixes: (1) doctor's wrapper clause is driven, the doctor scenario's world laying the four `tc-gemini-*` wrappers, the row naming them and the sweep taking them; (2) the block in `~/.gemini/GEMINI.md` is named in the leftover row and removed by `treecontext uninstall --agent gemini` (the marked block only) where Antigravity CLI is not wired, and where it is wired it stays and the row says so, and only then; (3) an instruction file that holds nothing once the block is gone is deleted only when install's created-file record says install made it (install records GEMINI.md and the other instruction files it creates), a developer's blank file staying; (4) the sweep takes an `mcpServers` key it emptied, and a settings file install's record says it created once it is `{}`; (5) a full uninstall takes the Claude Code hook scripts and the launcher an install for another agent alone left, sparing the launcher while another agent's entry names it; (6) agent names on install and uninstall match in any case, and an unknown one named alone exits non-zero. Bound in tests/server/gemini-retired-sweep.test.ts and the doctor scenario's steps

D400 2026-11-09 [I]
  trig:  on Claude Code a tool call fails after it started: a shell command exits non-zero or times out, a tool reports an error, the developer interrupts it, or an MCP tool answers with an error [I]
  resp:  the failed call is journaled as a successful one is, with its tool name, its input, and the client's error text as its Output section, under the same trail and treasure rule and the same preview and index boundaries, at the moment the failure arrived; its entry is marked `outcome` `failed`, or `interrupted` when the client says the developer interrupted it, and carries the client's own id for the call as `tool_use_id`, as every tool call captured from this build on does; install wires the client's `PostToolUseFailure` event beside `PostToolUse`, uninstall takes it out, and the install summary and doctor name it; Codex CLI's copy of the block stays the block, verbatim, where the event is one Codex CLI does not have and ignores, disclosed in the README; a failed call of one of treecontext's own tools is journaled the same way and heals nothing, since it wrote nothing [I]
  sib:   none -- a journal that holds every command that passed and none that failed, the failing test run and the refused write the ones a later session asks about, while the scenario promising every invocation stays green, is what this prevents, not a behaviour
  serves: N3 N2
  touches: D3 D270 D161 D154 D208 D250 D190
# the owner, 2026-11-09, on the first beta.4 load's finding (journal 1cd1c837): "i agree failed tool calls needs to be fixed in beta.4". Evidence, 2026-11-09: across four sessions' transcripts set against the store, 460 of 460 successful main-agent shell calls were stored and at most 3 of 9 failed ones (those 3 unverified); install wired SessionStart, PreCompact, PostToolUse, UserPromptSubmit, Stop, SubagentStart, SubagentStop, and `PostToolUseFailure` appeared nowhere in the source, the charter or the docs. Live pass, 2026-11-09, Claude Code 2.1.319, a real `claude -p` with a dump hook on every event (recorded under tests/fixtures): a failed call fires PreToolUse then `PostToolUseFailure`, never PostToolUse; the payload carries `tool_name`, `tool_input`, `tool_use_id`, `error` (a string: for a shell command `Exit code N` and then its output), `is_interrupt`, `duration_ms`, and a subagent's carries `agent_id` and `agent_type`; it has no `tool_response`. An MCP tool's `isError` reply and a protocol error both arrive this way, so treecontext's own error replies were never echoed either. Codex CLI 0.167.0, asked through its app server's `hooks/list` with no model call: a hooks file holding `PostToolUseFailure` and `PostToolBatch` beside `PostToolUse` lists the one hook it knows, with no warning and no error. The client's changelog names `PostToolUseFailure` by 2.1.119, below the floors install already asks for (D290, D304)
# drafted by the gate, 2026-11-09, for the owner's read: the marks' names (`outcome`, `tool_use_id`) and the Output section holding the error text are the drafter's; a successful call's entry carries no `outcome`, as before
# the gate, 2026-11-09, a fourth recording (tests/fixtures, `repo-reading-and-long-output`), for the owner's read, since it bounds D3's "kept in full": a shell command that failed after 168,894 bytes of output reached the hook as an `error` of 10,040 characters, the client keeping the head and the tail of the first 30,000 and cutting the middle with its own marker, and nothing in the payload names the rest; the same output from a command that succeeded reached PostToolUse as the first 30,000 characters of `stdout` beside `persistedOutputPath` and `persistedOutputSize`, the client's own file holding all of it under its project directory. So the journal keeps a failed command's output as the client hands it over, at most about 10,000 characters, and a successful one's first 30,000 with the path of the client's file written in the entry; the charter's two scenarios that promise the full output of a failing test run and of an oversized event are bound to payloads written by hand and larger than this client ever sends. Not changed in this unit: whether the hook should read the client's file for a successful call while it exists is the owner's to rule; the README says the limit

D401 2026-11-09 [I]
  trig:  on Claude Code a tool call is resolved without any event of its own saying how it ended: the client rejects its input, permission for it is denied or nobody answers the prompt, or a PreToolUse hook blocks it [I]
  resp:  the call is journaled from the client's account of the batch it was in, the `PostToolBatch` event, with its tool name, its input and what the client told the model about it as its Output section, marked `captured_from` `batch`, with the client's id for the call, at the batch's moment and as its writer's (a subagent's batch is the subagent's); a call is journaled once: the batch's account adds only the calls no event of their own captured, told by the client's id for the call, so a call that succeeded or failed keeps the entry its own event produced; the entry says what the client said and does not classify why the call did not run; install wires `PostToolBatch` as it wires `PostToolUseFailure` (D400); on a store whose schema predates the call id the batch's account adds nothing, since what was captured cannot be told there, until the server next opens the store [I]
  sib:   none -- a write the developer refused, or an edit the client rejected, leaving no trace in a journal whose charter says no invocation is ever filtered out, is what this prevents, not a behaviour
  serves: N3 N2
  touches: D3 D400 D80 D190 D314
# drafted by the gate, 2026-11-09, from the record, for the owner's read: D3 rules "every ... tool invocation ... none filtered out" and the owner's word of 2026-11-09 is "failed tool calls"; the live pass found these three kinds beside the failure D400 covers, and the owner has not ruled on them by name. Evidence, 2026-11-09, Claude Code 2.1.319, recorded under tests/fixtures: a call rejected for its input (an Edit whose string is not in the file) fires no PreToolUse, no PostToolUse and no PostToolUseFailure; a call denied permission in a headless run fires PreToolUse and PermissionRequest (which carries no call id) and nothing after; a call a PreToolUse hook blocks fires PreToolUse and nothing after; `PermissionDenied` fires only for an auto-mode classifier's denial (the client's changelog, 2.1.89). `PostToolBatch` fires once per batch after every call's own hooks have finished (a PostToolUse hook made to sleep 3 s held it back 3 s) and before the next model call, and lists every call of the batch with `tool_name`, `tool_input`, `tool_use_id` and `tool_response` as the model receives it; a subagent's batch carries `agent_id` and `agent_type`. Cut line if the owner declines: this entry and its two scenarios leave together, D400 standing by itself, and the fence then says the promise declined
# the batch's account cannot tell a call that never ran from one whose own event the hook failed to stage; the second leaves its capture-gap row (D314) beside this entry, which is why the mark names where the entry came from and not how the call ended

D402 2026-11-09 [I]
  trig:  a build wires Claude Code's hooks, or the client gains a hook event [I]
  resp:  the repository keeps the client's hook events as a list, with the client version and date it was read at, each event either wired by install or named with what the journal does not capture because of it; a guard fails when an event on the list has neither, or when install wires an event that is not on it; a charter step that says an event is as Claude Code sent it replays events recorded from a real client, kept with that client's version, through the hooks install wires, an event install does not wire reaching no hook, and a payload written by hand is never called the client's; the dogfood routine runs a real headless session against the installed build and counts the transcript's tool calls against the store by the client's call id, naming every call that is in neither the store nor a deduplicated entry, and every event the client fired that the list does not hold; doctor reports an installation wired before a capture event was added, with the command that wires it [I]
  sib:   none -- a client event the journal never hears, found by a developer months later instead of by the list set beside the block, is what this prevents, not a behaviour
  serves: N3 N2
  touches: D3 D400 D401 D250 D51
# drafted by the gate, 2026-11-09, as the audit-direction correction the finding asks for, for the owner's read. The rung is `cino:assertion` on the far side of the hooks door: the capture scenarios' ground truth was payloads the build wrote, fed to a script the binding chose, so the client's events and install's subscription were both outside the world; the earlier specimen of the same class is the `tool_response` bug in journal-capture's header. The catch the ladder prescribes, "name the foreign system on the far side of the boundary; assert what it observes", is made mechanical here in three places: the recorded events, the list, the count against the transcript

D403 2026-11-09 [I] amends D297
  trig:  a worker's process and the reader checking it are numbered apart on one host: a ticket door run inside a sandbox that numbers its own processes, as Codex CLI's does on Linux, or a reader run inside one; or a door reports the real end of a worker a reader has already retired as a phantom [I]
  resp:  every worker registration records, beside its process id, start moment and host, which numbering of processes the id belongs to; a reader on that host in another numbering never judges the worker by its own process table: where it can see the worker's numbering from outside, as a reader outside the sandbox can, it judges the worker there by D297 and D317, and a worker whose sandbox has ended with every process in it is gone and is retired as a phantom; where it cannot, as a reader inside a sandbox cannot see the machine's processes, it leaves the worker live and the reply says the worker runs where this reader cannot see its process, as D297 says of another host; a registration written by a build before this one records no numbering: a reader in the machine's own numbering judges it as before, and a reader in another numbering leaves it live, the reply saying it cannot be checked from here; a leg retired as a phantom whose door later reports how it really ended is set right to that ending, retired, cut or invalid, at the door's moment, with the summary row the door writes for that ending, and keeps the moment it was taken for a phantom and what took it for one; a registration that reads phantom never stands beside the summary row of a door of this build; a door that cannot read its worker's start moment in its own numbering, as inside a sandbox that numbers its own processes and still shows the machine's list of them, records no start moment, and the worker is judged in its numbering without one [I]
  sib:   none -- a running worker retired as a phantom because a reader looked up its number in another numbering of processes, and the phantom with a summary row its door then left beside it, is what this prevents, not a behaviour
  serves: N28 N27 N32
  touches: D297 D317 D307 D288 D384 D393 D342
# drafted for the owner's read, 2026-11-09. Evidence, 2026-11-09, verified live on the desktop (Linux): `codex sandbox -c sandbox_mode="workspace-write" -c 'sandbox_workspace_write.writable_roots=["~/.treecontext"]' -- treecontext run --store X --run r --role sleeper --no-key --parent p -- sleep 25`, then `treecontext run --store X … -- true` from a plain shell: the sandbox (bwrap, a pid namespace of its own) registered the worker with process id 13, its number inside the namespace, and the machine's real host name; the second door's phantom pass (`retirePhantoms`, src/persistence/leg-registry.ts) probed the machine's process 13, an unrelated process with another start moment, and retired the live worker `phantom`, noticed by "ticket door"; at the worker's real exit the door wrote the summary row (`retireWorker`, src/flat-store.ts, inserts it before it retires) and `retireLeg` changed nothing, its update reading `ended IS NULL`, so the registration stayed `phantom` with `stopped_at` null and a summary row beside it. Read from the code and not yet run: the other direction is worse, since inside the namespace the machine's processes do not exist (`process.kill(pid, 0)` answers ESRCH), so a door run inside a sandbox would retire every running worker registered outside it. This entry amends D317 the same way it amends D297: D317's "a process found with that id and a different start is a different process" holds only within one numbering; the header carries one relation, as the grammar has it, and the link is in touches
# the mechanism, the drafter's, for the rationale and not the scenarios' words: record the pid namespace's identity (the inode of `/proc/self/ns/pid`) with the process id and start moment, on each process of the registration's `processes` as on its first; a reader whose namespace differs looks for the worker from outside, where it is an ancestor of that namespace (a process on the host whose `/proc/<pid>/ns/pid` is the recorded namespace and whose `NSpid` line in `/proc/<pid>/status` ends with the recorded id, its start compared as D317 has it), and finds the namespace gone when no process it can see is in it; a reader that cannot see the namespace, or cannot read another process's namespace, leaves the worker unjudged. A namespace's inode can be given again to a later namespace, and a reader may not see every process; both err toward leaving a gone worker live, never toward retiring a live one. On macOS and Windows there is no such numbering and the rule reads nothing; a container with its own host name is already another host under D297. The binding needs a real pid namespace (`unshare --user --pid --fork --mount-proc`, or bwrap); on a host that cannot make one (Ubuntu 24.04's CI runners restrict unprivileged user namespaces) the scenarios show as skipped or wip, never green. The correction outline's world is reached through a real registration, not a raw registry write: a worker registered from inside a sandbox by a build that recorded no numbering, which a reader in the machine's own numbering still judges as before and so retires as a phantom
# resolved from the record, not asked (the adversarial review of 2026-11-09, item a): a reader outside a sandbox judges a worker inside it. D297 retires a worker as a phantom only because nothing saw it end, and a reader outside the sandbox can see; D307 relies on the phantom pass to close a leg whose door died with it, and a sandbox killed with its door would otherwise leave the leg live for good
# resolved from the record, not asked: (1) the honest state of a leg no reader can ever judge again (its sandbox gone and every later reader inside another one) is live and unchecked, the reply saying so, as D297 accepted for a worker on another host ("a worker on another host is never retired from this one") and declined both a retirement by age and a retirement by hand ("every model-less harness picks its own silence threshold"); (2) the corrected leg keeps its phantom notice, since a lookup in between told a harness the leg was a phantom and the record does not unsay what a reader was told; (3) the door's word beats the pass's, since D297 retires a phantom only because nothing saw it end and forbids a guessed exit moment, and the door saw it; (4) a registration an earlier build wrote is judged as before only where the reader shares the machine's numbering, since a reader inside a sandbox cannot tell whether the unrecorded id was the machine's. Roads not taken: the sandbox's own host name recorded instead (the reader outside could no longer judge what it can see); a door that skips the phantom pass whenever it runs in a sandbox (the reader outside makes the same mistake); the door's late report dropped as a leg already ended (the phantom with a summary row this entry ends)
# build-time recordings this entry rests on (the review's list of 2026-11-09, item 13, not release-blocking): a real pid namespace made on the CI hosts, or the scenarios shown skipped there
# ruled by the owner, 2026-11-10, on the unit 9 review's findings 1, 2 and 6. (1) "This build's doors only": the correction is the promise of a door of this build. Run for real on 2026-11-09 against the doors unpacked from the beta.3.1 and beta.4 tarballs: an earlier door's retirement reads `ended IS NULL` and corrects nothing, so a worker it started inside a sandbox, taken for gone by a reader of this build, stays `phantom` beside its summary row; it needs a sandboxed worker running across the upgrade, and an earlier build cannot open a store this build has migrated. Declined: a reader setting such a phantom to retired at its summary row's moment, an ending inferred from a row, which D297 forbids. This corrects the mechanism comment above: the correction outline's world is not "a build that recorded no numbering" but a worker of this build's door that a reader wrongly took for gone. (2) "Scenario for A": the door inside a sandbox that keeps the machine's `/proc` (`bwrap --unshare-pid` without `--proc`, `unshare --pid --fork` without `--mount-proc`) recorded the start moment of the machine's process under the worker's sandbox number, and a reader outside retired the running worker; the fourth outline row and the resp's last clause. (3) "B as limits", no scenario without a recording: a host whose own numbering is not the kernel's first (unverified: WSL2, toolbox) may never close a leg whose sandbox died with its door, and a rootless podman worker under a subordinate user id is unverified; what the build cannot prove is a README limit and a beta.5 item. (4) ruled the same day, "add the two recommended scenarios": a phantom that its door sends back reads live through its re-run, its notice kept, and a damaged ticket's phantom is set to invalid when its one row lands; both were promises of this entry's words that no scenario reached. Left as tests, not scenarios: a door that could read no list of processes at all, and the numbering recorded by the session-start hook and by a worker claiming its own ticket

D404 2026-11-09 [I]
  trig:  a captured tool call's entry is classed as a success, a soft fail or an error, and the client's own event said how the call ended, or said nothing about it [I]
  resp:  where the client's event states how a call ended, the entry's class is the client's word and its text decides nothing: on Claude Code a call that arrives by `PostToolUse` succeeded, since a call that failed, a shell command's non-zero exit and timeout among them, arrives by `PostToolUseFailure` (D400), so it is a success, and one that arrives by `PostToolUseFailure` is an error; soft fail, a reading of the text, is never given to such a call; a client states how a call ended only on the events install wired for that client by name, the hook taking its client from the command install wrote and never from the payload, and only where the events recorded from that client (D402) show a failed call arriving by an event of its own; where the client's event does not state how the call ended, as from a client whose events carry no outcome or whose shell event reports a non-zero exit as an ordinary result, or on a store whose schema keeps no such mark, the class is read from the text as before; each classified entry says which decided its class, the client or its text, and the trail pane's exit rows say which of their counts are which (D102); an entry the batch's account produced stays unclassified (D401), as does a Codex call Codex reported no result for (D408); an error is opened and resolved by the class so decided; entries drained before this build keep the class they were given [I]
  sib:   none -- a successful status call, export or doctor run filed among a session's errors or soft fails because its text said "error" or "failed", while the client had said it succeeded, is what this prevents, not a behaviour
  serves: N3 N2
  touches: D400 D401 D402 D102 D3
# drafted for the owner's read, 2026-11-09. Evidence, 2026-11-09, on the installed build: successful `treecontext_status` and `treecontext_export` calls were stored with `exit_type` `error`, a doctor run `soft_fail`, and a `treecontext_insert` whose note said "failed call seen" `error`, although each arrived by `PostToolUse`. From the code: the drain classes a call `error` when its staged `outcome` is `failed` or `interrupted` and otherwise by `classifyExit(row.content)` (src/server/ingestion.ts, `classifyExit` in src/server/event-processing.ts, a substring search for "error:", "failed", "exception", "enoent", "exit code N" and the like, and "warn", "deprecated", "skipped", "timed out" for a soft fail); a success carries no mark (D400's "a successful call's entry carries no `outcome`"), so a stated success and a silent client's event reach the drain alike and the text decides both. Claude Code's evidence is the recordings of 2.1.319 (D400): a failed call fires `PostToolUseFailure` and never `PostToolUse`, an MCP tool's error reply included; the client's changelog names that event by 2.1.119, below the floors install asks for (D290, D304). Codex CLI's evidence: its `PostToolUse` for a shell command that exits non-zero carries a plain string and no exit code (D408), so Codex states no outcome for shell commands, and its entries keep the text's class; a Codex call Codex reported no result for, an MCP error reply or a failed patch among them (recorded live 2026-11-09), is unclassified, as an entry the batch's account produced is (D408, D401); Antigravity CLI's: a shell command that exits non-zero arrives with an empty `error` (D415)
# for the build, the drafter's, not the scenarios' words: the stated success needs a mark of its own, carried through staging like the D400 marks (a staging column, the tier walk for an older store); it must not be an `outcome` value, since the drain's own-echo gate, the stop hook's settle and the staged cap-refusal read take `outcome IS NULL` to mean a call's own successful event (src/server/ingestion.ts, src/hooks/subagent-stop.ts, src/persistence/cap-refusals.ts), and D400 keeps `outcome` off a successful entry. The entry's mark naming what decided the class (say `exit_by` `client` or `text`) is the drafter's name. The client is the one the hook's command names (the block install writes for Codex names Codex, D406; Antigravity CLI's named hook names Antigravity, D413), never a guess from the payload, Codex's payloads being Claude-shaped. Residual, disclosed: VS Code and Cursor run the block install wrote for Claude Code from the Claude settings file, so their events reach the hook as Claude Code's; their rows stay documented only (D153), and whether either sends a failed call by an event of its own is unchecked (D400's build line), said in the README
# build-time recordings this entry rests on (the review's list of 2026-11-09): item 7, a real Claude Code session whose successful calls print "error", "failed" or "deprecated", an MCP reply saying "failed call seen" and a read of a traceback, before the first scenario binds; item 10's MCP error reply on Codex, recorded live 2026-11-09: it arrives by no event of its own, only a `PreToolUse` with no `PostToolUse`, so Codex states no outcome for it and its entry is unclassified (D408). Item 8 (how the hook tells its client) is settled here and in D406: by the command install wrote

# D405 is not used: the number was set aside for a second ruling on exit classes, and one ruling, D404, covered them

D406 2026-11-09 [I] amends D386
  trig:  install runs on a machine with Codex CLI installed, or uninstall takes treecontext out of it [I]
  resp:  at Codex CLI `0.167.0` or later, the oldest version a live run verified, install writes Codex its own hooks block by default, with no flag, into `~/.codex/hooks.json`, hooks the developer keeps in the `hooks` table of `config.toml` being left as they are: the events Codex's list marks wired (D409) and no other, so neither `PostToolUseFailure` nor `PostToolBatch`, which Codex does not have, each hook's command running the hook scripts Claude Code's block runs and naming Codex, the hook taking its client from that command and never from the payload; the hook scripts are written wherever a block or hook install writes runs them, Claude Code wired or not, and kept while any client's hooks name them; Codex's entry starts the server in capture mode; install writes its hooks in groups of its own after the developer's and never puts a hook into a group of the developer's, so install's own writing never writes over, removes or moves a hook of the developer's; where a change install or uninstall makes would still shift a hook of the developer's, as taking out a group of treecontext's shifts a group the developer added after it, install and uninstall name that hook and say Codex will ask to trust it again; a reinstall where nothing changed leaves every hook's command byte for byte as it was, and a command whose text changes, as one naming the Node interpreter does when an upgrade moves it, is a change install names, saying Codex will ask to trust that hook again; install says in one line that Codex runs no hook until the developer trusts it, naming `/hooks` in Codex as the step left, every time it writes or changes a hook, since Codex treats a changed hook as untrusted; install never writes Codex's record of trusted hooks and never runs Codex with the flag that bypasses hook trust; below `0.167.0`, or where Codex's version cannot be read, install writes no hook and takes back what install wrote for Codex, the hooks its record names (D361) or, where no record names them, the verbatim copy of the Claude Code block an earlier build wrote under the experimental flag, identified by its commands, never a hook of the developer's, starts Codex's entry without capture, and says in one line that Codex stays tools-only, naming its version and that capture needs Codex CLI `0.167.0` or later, or saying its version could not be read; where Codex's hooks file does not parse, install writes nothing into it, leaves it byte for byte, keeps Codex tools-only and says so in one line quoting the parse error; the experimental flag is gone: an install given it is refused before anything is written, in one line saying the flag is gone and that each captured client is wired by default from its version floor, Codex CLI `0.167.0` and Antigravity CLI `1.5.3`, Claude Code always, so the refusal of the bare flag (D57) becomes the refusal of the flag in any form; the platform adapters no install wires, the codex, cursor, opencode and vscode adapters among the hook sources, leave the build with it, an adapter nothing wires being out of the build, and uninstall still knows by their commands the entries an earlier build wrote naming them; a reinstall at `0.167.0` or later converges the verbatim copy an earlier build wrote, and an earlier build's Codex block, into this build's block, taking out the events Codex does not have, and names each hook Codex must be asked to trust again; uninstall takes back the hooks install recorded writing and, where no record names them, the copy identified by its commands, and nothing else; the rest of D386 stands: the entry starts the server in capture mode only for an agent whose capture hooks install wrote; install asks Codex about the user's hooks file from a directory with no project settings, so no one project's settings decide for every project; treecontext's hooks are in Codex's hooks file if and only if Codex's entry starts the server in capture mode, except a file that does not parse, which stays tools-only; where Codex loads the file and lists none or only some of treecontext's hooks, install says Codex runs none, or only that many, of them now and what turns them on, and never says capture is running [I]
  sib:   none -- a Codex session journaled by nothing although install said it was wired, because the hooks sat untrusted or were a copy of a block written for another client, is what this prevents, not a behaviour
  serves: N3 N23 N9 N26
  touches: D386 D208 D161 D154 D30 D109 D29 D57 D51 D385 D361 D381 D402
# the owner, 2026-11-09, ruling Codex capture and a Codex main's identity into beta.4: "I would rather slow the release and get it right"; "set a minimum codex version in the docs". Far-side pass, 2026-11-09, Codex CLI 0.167.0, a dump hook on every event and two real `codex exec` runs (journal 089e9958): hooks are a stable feature, on by default; Codex reads `~/.codex/hooks.json` or `[hooks]` in `config.toml` (and a repository's `.codex/`), in Claude Code's JSON shape, and ignores an event name it does not know without a word; an untrusted hook fires nothing and says nothing; trust is given per hook with `/hooks` in Codex's interface and recorded in `config.toml` under `[hooks.state."<file>:<event>:<group>:<index>"]` as a `trusted_hash`, so a hook is known by its position as well as its text, and a hook moved or changed reads untrusted. Hence groups of install's own after the developer's: a hook install appends inside a developer's group, or takes out of one, shifts every hook of the developer's after it (today's `ensureHookEntries`, src/server/installer.ts, reuses a group with the same matcher and re-appends treecontext's hooks there); and hence the byte-identical reinstall, since the owner's Node upgrade routine moves the interpreter a command names and would untrust every hook. The floor is the drafter's, the D381 pattern: the oldest version a live run showed, 0.167.0, until an older one is shown; D381's approvals floor (0.166.0) stands beside it for the tools. Drafted as amending D386, whose capture clause ("a copying client opted in by name under the experimental flag") this replaces for Codex, and D57's refusal with it; the header carries one relation, as the grammar has it, and D57 and D29 are in touches
# the hook's client named in its command (the adversarial review of 2026-11-09, B3): Codex's payloads are Claude-shaped, so a hook reading the payload cannot tell Codex from Claude Code, and a misread would class a failing Codex command a stated success (D404), infer a leg from a Codex subagent (D411) or send a Codex worker back from the stop hook (D410)
# resolved from the record, not asked (the review's items b and the D406 alternative): capture on Codex is the default, not behind the flag, the owner's words being "just work" after "a clean, simple install process, or install says the steps left", the `/hooks` line being the step left, and D29 being met by the live verification; below the floor install takes the old copy back, since the copy rests on no verification at that version (D30), and the same rule holds for Antigravity CLI below its floor (D413)
# the owner, 2026-11-09, on question H (the flag kept and answered, or removed): "why not remove it if it's unnecessary?" The flag opted an unverified client into capture; no client is left for it to opt in, Codex and agy being wired by default from their floors, so it is removed, and a script that passes it learns so in one line rather than through a flag that silently does nothing. With it go the adapters it was the only door to: AGENTS.md's rule is that a fence may decline a promise, never a writer, and an adapter no install wires is a writer nothing reaches, kept only as code the fence must keep describing; the fence's D30 entry is amended to the rule without them, and D30's live-payload pass is now earned by hooks install writes, as Codex's and agy's were (D408, D415). Seen in source on 2026-11-09: `src/hooks/codex`, `src/hooks/cursor`, `src/hooks/opencode` and `src/hooks/vscode`, none named by install (src/server/installer.ts keeps the vscode and cursor adapters "in source, unwired"); an earlier build's entry naming a codex adapter entry point is still known to uninstall by its command (src/server/hook-command-owner.ts). Gemini CLI named stays refused by D399. AGENTS.md's architecture line "the other adapters are unverified scaffolding" is the build's to amend with the code
# build-time recordings this entry rests on (the review's list of 2026-11-09): item 1, release-blocking, settled 2026-11-09 for the reading (see D407); item 9, a hook moved reading untrusted, a malformed `hooks.json`, and `hooks.json` with `[hooks]` in `config.toml` together (whether Codex merges both); the trust mode of the recordings of 2026-11-09 is settled in D409's comment
# corrected by the owner's ruling, 2026-11-10 ("correct all three"), from the build: a Codex hook's command names the hook script and the client, never the Node interpreter, which the script itself names, so a Node upgrade changes no command and costs no trust; the reinstall outline's second row says so, and a third row keeps the promise for a command that does change (the hook scripts' directory moved)
# ruled by the owner, 2026-11-10 ("add the scenario and both lines"), from the third review of the build: the resp's last clauses. Run from a project whose own Codex settings turn hooks off, install wrote its hooks to the user's file and the user's entry with capture off, so in every other project the hooks staged events no server drained. Hooks that are written can run, so the entry must drain what they stage; what Codex runs now is said in words, never by the mode. Also from the reviews, no ruling needed (D51, D53, D419's rule): install changes Codex's hooks file by text edits that leave every byte of the developer's parts alone, asks Codex's own reading of the file before and after it writes and puts the file back when Codex rejects the result, writes through a symlink, refuses a read-only file, and follows `CODEX_HOME`. The owner kept the reinstall outline's third row (the hook scripts' directory moved)

D407 2026-11-09 [I]
  trig:  a developer runs doctor on a machine with Codex CLI installed [I]
  resp:  doctor's row for Codex CLI says, from Codex's own account of each hook's trust, whether treecontext's hooks are written, written and trusted, trusted in part, written and untrusted, or modified since they were trusted, naming each hook Codex does not run, a trust record Codex holds at the place of a treecontext hook for a different hook being read as Codex reads it, that hook modified since it was trusted; where Codex's own account cannot be read, the row says the hooks are written, that doctor cannot tell whether Codex trusts them, and names `/hooks` in Codex as where to look, and never reads ok; the row says whether the hooks match the block this build writes for Codex, naming an earlier build's verbatim copy of the Claude Code block, or an earlier build's Codex block, as not this build's; the remedy is trusting them with `/hooks` in Codex for a hook untrusted or modified since, and `treecontext install --agent codex` for a block missing or not this build's; below `0.167.0`, or where Codex's version cannot be read, the row says Codex gets the tools only, naming the version or that it could not be read, with upgrading Codex as the remedy, and warns where treecontext's hooks are still written there, with `treecontext install --agent codex`, which takes them back; where Codex's hooks file does not parse, the row quotes the parse error and names fixing the file by hand, never an install; the row warns where the entry's capture mode disagrees with the hooks it finds (D386); doctor writes nothing into Codex's configuration, never marks a hook trusted and never computes Codex's hash itself; doctor asks Codex from the project it runs in, and names a project's own setting that turns Codex's hooks off there, saying whether it holds in this project or in every project; the rest of D387 stands [I]
  sib:   none -- doctor reading [ok] for a Codex whose hooks sit untrusted and fire nothing, the silent failure the far-side pass found, is what this prevents, not a behaviour
  serves: N9 N3 N23
  touches: D161 D208 D386 D387 D406 D51
# the brief of 2026-11-09: "Doctor may READ this; install must NEVER write it". "From Codex's own account", recorded live by the gate, 2026-11-09, Codex CLI 0.167.0: Codex's app server answers `hooks/list` (params `{cwds:[dir]}`) with, per directory, `hooks`, `warnings` and `errors`; each hook carries `key` ("<file>:<event_snake>:<group>:<index>"), `eventName`, `command`, `matcher`, `timeoutSec`, `sourcePath`, `source` ("user"), `enabled`, `isManaged`, `currentHash` ("sha256:…") and `trustStatus`; a hook whose place holds an earlier trust record for a different hook read `trustStatus` "modified", which is why that case reads as Codex reads it and not as a stale record of doctor's naming (the desktop holds fifteen such records, left at install's places by the far-side pass's dump hooks); `warnings` carried "clamping SessionEnd hook timeout to 3s…". So the rows are bound to Codex's own `trustStatus` per hook and doctor never computes a hash; the fallback row applies when `hooks/list` does not answer. This is D51's "proves health rather than inferring it", on the far side of the boundary the install feature's header names
# recorded live, 2026-11-09, Codex CLI 0.167.0: after the owner trusted the hooks with `/hooks`, `hooks/list` reported each `trustStatus` "trusted", where it had read "modified" against the stale records before
# build-time recordings this entry rests on (the review's list of 2026-11-09, item 1, release-blocking): settled for a trusted hook and a modified one, as above; still to record, `trustStatus` for a hook never trusted (not yet seen); should it be absent from the answer, the row for hooks never trusted goes back to the owner before the release and the fallback row stands for it meanwhile
# ruled by the owner, 2026-11-10 ("add the scenario and both lines"): the resp's clause on where doctor asks Codex from. Doctor reports on the project it runs in, so it asks there; install decides for every project, so it asks from a directory with no project settings (D406)

D408 2026-11-09 [I]
  trig:  a Codex CLI session whose hooks install wrote and the developer trusted submits prompts, calls tools and ends its turns [I]
  resp:  the session is journaled as a Claude Code session is: each prompt with role "user"; each tool call with its tool name, its input, what Codex returned as its Output section and Codex's own id for the call, under the same trail and treasure rule and the same preview and index boundaries, at the moment its event arrived, a call of treecontext's own tools included, whose echo heals what the call wrote; and each turn's last assistant message, read from the payload of Codex's `Stop` event and never from Codex's transcript file; a call is journaled once: a call whose `PreToolUse` and `PostToolUse` both arrived is journaled from its `PostToolUse`, and a call whose `PreToolUse` has no `PostToolUse` by its turn's end, Codex's `Stop` or its `Interrupt`, is journaled at that end with its tool name, its input and Codex's id for the call, marked as a call Codex reported no result for, the entry saying what Codex said and never classifying why the call returned nothing, a call still running at an interrupt looking the same as one that failed; a turn Codex interrupted, ended by `Interrupt` with no `Stop`, is journaled as interrupted with a capture-gap entry naming its reply as not captured, Codex putting the partial reply in no payload, and no assistant text is written for it; a shell command arrives as Codex returns it, one plain text with no exit code and no split between its output and its errors, a command that exits non-zero and a write the sandbox refused arriving as any other call: its entry holds that text, carries no `outcome` mark, since Codex states none, and takes the exit class its text decides, as D404 has it where the client states no outcome; a Codex shell command that reads a file is execution, its output kept in full, as a Claude Code shell command's is; what the journal does not know about a Codex call (its exit code, which text was the error stream) is said in the README, never filled in; a call Codex started whose result and whose turn's end both never reached the journal is kept as one entry before its account leaves staging, dated at the call's moment, saying only that; a result that lands after a call's no-result entry leaves that entry in place, marked as resolved by the result, and the two are one call to every count [I]
  sib:   none -- a Codex session whose failing command reads as one that passed because the journal invented the outcome the client never gave, or whose turns are read from a transcript format Codex calls unstable, is what this prevents, not a behaviour
  serves: N3 N2
  touches: D3 D400 D401 D404 D249 D270 D314 D406
# Far-side pass, 2026-11-09, Codex CLI 0.167.0 (journal 089e9958): payloads carry `session_id` (Codex's thread id), `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`, and `turn_id` on turn events; `UserPromptSubmit` carries `prompt`; `PostToolUse` carries `tool_name`, `tool_input`, `tool_use_id` and `tool_response`; tool names are Claude Code's ("Bash" with `{command}`; treecontext's tools as `mcp__treecontext__treecontext_<tool>` with `{content:[{type:"text",text}]}`, so the insert echo arrives); a Bash `tool_response` is a plain string (`ls` of a missing path answered "ls: cannot access …", a read-only sandbox's write "Read-only file system"); `Stop` carries `stop_hook_active` and `last_assistant_message`. Codex's own documentation calls the transcript not a stable interface; D249 already reads the turn's text from the payload first on Claude Code. Codex has no batch account (D401); its `PreToolUse` is the account of a call that ended with no `PostToolUse`, worded as D401 words the batch's: what the client said, never why the call did not run. The recordings of 2026-11-09 split the prompt, the shell command and the insert across two sessions, so the capture scenario's steps say "as recorded" and name no values the recordings do not hold
# recorded live 2026-11-09, Codex CLI 0.167.0 (fixtures under the session's recordings, read for this entry, nothing copied): a tool call that fails fires `PreToolUse` and no `PostToolUse` for a tool other than the shell: an MCP tool answering with an error (`treecontext_export` of a missing node) and an `apply_patch` whose context did not match; a shell command's non-zero exit and a sandbox-refused write fire `PostToolUse` with the error text; a successful `apply_patch` fires both. Absence is not Codex stating failure: a call still running at an interrupt would look the same, so the honest mark is "no result reported", unclassified (D404). An interrupt fires `Interrupt` and no `Stop` (D409)
# build-time recordings this entry rests on (the review's list of 2026-11-09, item 10): a file edit, an MCP error reply and an interrupted turn recorded as above; a call the developer denies at a prompt is still unrecorded (no call was denied in the interactive recording: Codex ran `pwd` unasked)
# ruled by the owner, 2026-11-10 ("add the scenario and both lines"), from three reviews of the build: the resp's last two clauses. A turn that ends with no Stop or Interrupt (a crash, a kill, a worker ended at its timeout) left its unfinished calls with no entry and no gap; and a result arriving after its call's no-result entry made two entries of one call. The earlier entry is never deleted (it was true when written). One scenario in journal-capture; the late result is covered by tests and has no scenario

D409 2026-11-09 [I]
  trig:  a build wires Codex CLI's hooks, or Codex gains a hook event [I]
  resp:  Codex CLI's hook events are kept as a list beside its block, in the form of the list of D402 for Claude Code, with the version and date they were read at, each event wired or named with what the journal does not capture because of it, the guard of D402 holding Codex's list against Codex's block; the list names the events Claude Code's block wires that Codex does not have, `PostToolUseFailure` and `PostToolBatch`, with what that costs on Codex; a charter step that says an event is as Codex sends it replays events recorded from a real Codex, kept with its version in Codex's own fixture directory, through the block install writes for Codex, and the guard of D402 holds every such step to that directory, a payload written by hand never called Codex's; a stand-in for the Codex a version check reads lives with the other stand-ins; the capture census counts a real Codex session's calls against the store, a call Codex makes directly by Codex's id for it and a call made through Codex's code mode by inference from the script that made it, the census saying of each which it was and how many were inferred, since Codex's id for a code-mode call matches nothing in its transcript; the census over a live Codex session is a release dogfood check, as the census of D402 is, and the charter's scenario for it reads a Codex transcript and the store its hooks wrote, both recorded; Codex's `PreToolUse` is wired, for the account of a call Codex reports no result for (D408), and so is its `Interrupt`, as the end of a turn Codex interrupted, which fires no `Stop`; Codex's `PreCompact` is wired and the recovery note is written and claimed as on Claude Code (D286, D375), its snapshot taken at `PreCompact` and claimed at the session's next start in its own lane, which on Codex is the `SessionStart` whose `source` is `compact`; `PostCompact` is named as not captured, carrying nothing the journal lacks; only a manual compaction is recorded, and an automatic one is named as unrecorded; Codex's `SessionEnd` is not wired, the deferral of D395 holding for it as for Claude Code's [I]
  sib:   none -- a Codex event the journal never hears, or a census that reports every Codex call matched when a third of them could only be guessed at, is what this prevents, not a behaviour
  serves: N3 N2
  touches: D402 D400 D401 D395 D406 D408 D286 D375
# Far-side pass, 2026-11-09, Codex CLI 0.167.0 (journal 089e9958): the binary knows SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, SubagentStart, SubagentStop, Stop, Interrupt, PreModelRequest and PostModelRequest. The dispositions, for the list: wired, SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, Interrupt, PreCompact, SubagentStart, SubagentStop; not captured, PermissionRequest (the prompt itself; whether a denied call fires PostToolUse is unrecorded), PreModelRequest and PostModelRequest (token counts, not conversation content), PostCompact (it carries no summary, nothing the journal lacks), SessionEnd (D395). Code mode: Codex records a custom tool call `exec` carrying JavaScript whose script calls `tools.exec_command` or `tools.mcp__…`; hooks fire per inner call with a `tool_use_id` "exec-<uuid>" found nowhere in the rollout transcript, and an `exec` with no inner tool call fires no hook; direct calls (`spawn_agent`, `wait_agent`) carry the transcript's `call_id`. Unit 8b's census already says what is inferred for Claude Code. The guard of D402 matches today only "Claude Code … sends" and reads only Claude Code's fixture directory (tests/feature-guards.test.ts, `recordedSession`); this entry widens it to Codex's steps and directory, D417 to Antigravity's
# the trust mode of the recordings (the review's N8), the owner's account, 2026-11-09: the Codex recordings of 2026-11-09 ran with the hooks trusted through `/hooks` by the owner; one earlier run used the flag that bypasses hook trust, run by the owner. The fixtures the build records are taken under `/hooks` trust, never the bypass flag, and the matrix cell that rests on them says which (D412, D386's permission-mode rule)
# resolved from the record, not asked (the review's item d): the census for code-mode calls is inferred and says so, since D402 and AGENTS.md's verification rule demand a count, and fencing it would leave D412's "verified live" with no census behind it
# the owner, 2026-11-09, on question E (Codex compaction), to the recommendation that the build record one manual `/compact` and wire `PreCompact` with the recovery note if the recording shows Claude Code's shape: "agree". Road not taken: shipping beta.4 with Codex compaction named as not captured, the fence's deferred entry standing until beta.5
# recorded live 2026-11-09, Codex CLI 0.167.0, the owner's session in Codex's interactive interface (`permission_mode` "default" there, "bypassPermissions" under `codex exec`): a manual `/compact` fired `PreCompact` `{trigger: "manual", turn_id}`, then `PostCompact` `{trigger: "manual"}`, then `SessionStart` `{source: "compact"}`, all under one `session_id`; Codex's `PostCompact` carries no `compact_summary` and its `PreCompact` no `custom_instructions`. That is Claude Code's shape where the recovery note needs it, so by the owner's "agree" `PreCompact` is wired and the fence's deferred entry for Codex compaction is retired. Pressing Esc mid-turn fired `Interrupt` `{session_id, turn_id, permission_mode}` and no `Stop` for that turn, the turn's partial reply in no payload. In the fixtures of the same day a tool call that failed fired `PreToolUse` and no `PostToolUse`: an MCP tool answering with an error (`treecontext_export` of a missing node) and an `apply_patch` whose context did not match; a hook that printed nothing at `PreToolUse` changed no decision of Codex's (D408)
# build-time recordings this entry rests on: item 11 settled as above (a manual compaction; an automatic one unrecorded); item 10's two concurrent sessions (a `SessionEnd` seen for another session) still to record
# corrected by the owner's ruling, 2026-11-10 ("correct all three"), from the recordings and the code: (a) the census: the transcript's record of a completed code-mode call carries the id Codex's hooks carry (5 of 6 calls in the headless recording); the two without are a call the sandbox refused and a patch that failed, and only those are matched by inference, the census saying how many of each; (b) the compaction: a recovery note is claimed by the next fresh start in its lane, as on Claude Code (D375, `claimSnapshot` claims another session's note at a `startup`), never by the compacted session's own start; no behaviour changes for Claude Code. Declined: the compacted session's own start claiming on both clients

D410 2026-11-09 [I]
  trig:  a Codex CLI session starts whose hooks install wrote and the developer trusted, as a main or as a worker the ticket door started, or a turn of it ends [I]
  resp:  a Codex main registers a self through its `SessionStart` hook, with the directory, worktree and branch git reports, as a Claude Code session does (D190), so the rows it writes through the tools are stamped with its lane as a hooked main's, never `unregistered`; at a fresh start its `SessionStart` hook hands it, as context Codex adds to the session, the packet a Claude Code session gets at a fresh start (D167, D236), read from its self registration and opening with its lane's own chapter; that context is the one thing treecontext's hooks print to Codex, and only to a main: a `codex exec` worker the ticket door started, its ticket and lane in its environment, is never registered as a self, its `SessionStart` hook links its Codex session to the worker's lane, as a `claude -p` child's links (D295), writes no second first-moment row and prints nothing, its first moment being the door's, and the rows it captures land in the worker's lane with the worker's role as writer; at a turn's end treecontext's hooks print Codex nothing, so a Codex session gets no bookmark ask from the stop hook and no send-back from it, the send-back for a missing checkpoint staying the door's alone on Codex, both deferred to `0.1.0-beta.5`; a `SubagentStart` hook prints Codex nothing (D411); a resumed Codex main, whose `SessionStart` carries `source` `resume` and the same session, finds its self registration again and is handed the packet a Claude Code session gets on a resume (D373), and the start after a compaction, `source` `compact`, claims the recovery note in its own lane as on Claude Code (D375, D409); what a Codex session is handed after whatever Codex has for a `/clear` is not promised, that start being unrecorded; below `0.167.0`, or with its hooks untrusted, a Codex main is a caller whose hooks do not run, the declared parent of D294 and the undistinguished caller of D240 standing [I]
  sib:   none -- a Codex main whose own chapter is stamped `unregistered` beside a working hook, or that starts blind beside a packet its hook could hand it, a Codex worker registered as a second main in the checkout it was spawned from, or a headless Codex run whose printed answer is replaced by a bookmark the stop hook asked for, is what this prevents, not a behaviour
  serves: N27 N29 N32 N2
  touches: D190 D167 D236 D373 D375 D294 D295 D298 D240 D379 D406
# the brief of 2026-11-09, item (d): "a Codex main registers a self through SessionStart … (this retires D295's premise for Codex at/above the minimum; amend the fence)". D295's ruling stands (the ticket wins in a child); the road it did not take is fenced with the reason "a Codex main's `claude -p` workers land unparented in the main lane as 'main'", which assumed a Codex main has no hooks, and the fence entry now says for which Codex that still holds. Far-side facts, 2026-11-09: hooks run outside Codex's sandbox (pid 1 systemd, parent codex, under a read-only sandbox); a hook's environment carries no Codex session id. Not recorded: whether a worker spawned through Codex's shell can read its main's session (the parent linked by id, D294) from inside the sandbox; until shown, a Codex main's workers declare their parent with `--parent` as today
# recorded live, 2026-11-09, Codex CLI 0.167.0, settling the review's items 2 and 3: a `SessionStart` hook's `hookSpecificOutput.additionalContext` reached the model, which repeated a marker word from it; a `Stop` hook's `{"decision":"block","reason":…}` was honoured, the model taking one more turn; and `codex exec` prints only the last reply, so the turn a Stop block caused replaced the run's real answer on stdout. Under `treecontext run … -- codex exec`, every hook's environment held `TREECONTEXT_TICKET` and `TREECONTEXT_WORKER_SESSION`, the hooks running outside the sandbox, so the worker clause and the orchestration matrix's cell for a worker's own tool calls rest on a recording (the fixture is still the build's to take). Only `source` "startup" was seen on SessionStart
# the owner, 2026-11-09, on question I, after the probe: "yes" to the gate's recommendation: a Codex main gets the fresh start's context through SessionStart, never a worker; no Stop-hook bookmark ask and no Stop-hook send-back on Codex in beta.4, since a Stop block replaces a headless run's printed reply and a hook cannot yet tell `codex exec` from Codex's interactive interface; nothing printed at SubagentStart, there being no legs on Codex (D411). The bookmark interval's scenarios stay Claude Code's; the fence defers the Codex stop hook to beta.5. Said in the README: a Codex main is re-oriented at a fresh start and gets no bookmark ask
# recorded live 2026-11-09, Codex CLI 0.167.0, the owner's session in Codex's interactive interface: `codex resume` fired `SessionStart` `{source: "resume"}` with the same `session_id`, a `SessionEnd` `{reason: "other"}` having closed the session at quit; a manual `/compact` ended with `SessionStart` `{source: "compact"}` under the same session (D409). So a resumed Codex main is the same session, and its start follows Claude Code's resume
# build-time recordings this entry rests on: the fixtures of the probes above (a SessionStart context reaching the model, a worker's hook environment under `treecontext run`, a resume, a compaction); still unrecorded, a Codex session continued after whatever Codex has for a /clear, and nothing is promised for it

D411 2026-11-09 [I]
  trig:  a Codex CLI main whose hooks run spawns a subagent [I]
  resp:  the subagent is registered at Codex's `SubagentStart` under Codex's id for it, with the agent type Codex names as its writer, retired at `SubagentStop`, and the reply Codex gives in that event's last assistant message kept as its summary, as a Claude Code subagent with no brief is (D305); it is never a leg: for an event whose hook command names Codex no key is inferred from a role's brief, no first moment is written and the `SubagentStart` hook prints Codex nothing, it is never sent back, the lookup of a key never counts it, the spawn's return carries no pointer, since the message that spawned it is not readable from a hook, and its summary is read from the payload, never from the subagent's transcript first as a Claude Code subagent's is (D371); the tool calls it makes are captured with it as their writer where Codex's event names it, and as the main's where it does not, said in the README; legs on Codex are deferred to `0.1.0-beta.5` [I]
  sib:   none -- a Codex subagent whose report is lost, or one handed a key and a first moment guessed from a brief nobody could read, is what this prevents, not a behaviour
  serves: N2 N27 N3
  touches: D305 D320 D392 D190 D371 D408 D409
# Far-side pass, 2026-11-09, Codex CLI 0.167.0 (journal 089e9958): `spawn_agent` fires `SubagentStart` with `agent_id` (a thread id), `agent_type` "default" (the only value seen), `session_id` the parent's and `transcript_path` the subagent's own; `SubagentStop` carries `agent_id`, `agent_type`, `agent_transcript_path` and `last_assistant_message`; the spawn message in `spawn_agent`'s input is an opaque encrypted blob, so the hooks door's inference from the role's brief (D320) has nothing to read. The scenario's brief names the role Codex names, "default", so that its negative could fail. The summary is read from the payload: Codex's transcript is not Claude Code's
# the owner, 2026-11-09, for Q1's scope (D392): "Claude Code subagent legs follow in beta.5 with workflows." Legs on Codex join them there
# resolved from the record, not asked (the review's item c): Codex subagents are registered and summarised in beta.4 rather than fenced whole to beta.5, since the owner deferred legs, not subagents (D392), and the SubagentStart and SubagentStop hooks write to the store, which a fence may not decline (AGENTS.md: a fence may decline a promise, never a writer)
# build-time recordings this entry rests on (the review's list of 2026-11-09, item 10): a Codex subagent's own tool call, whether it carries `agent_id`

D412 2026-11-09 [I] amends D153
  trig:  a developer reads the documentation or the handshake to learn which clients treecontext captures [I]
  resp:  capture is promised where it is verified live: Claude Code; Codex CLI from `0.167.0` with its hooks trusted; Antigravity CLI from `1.5.3` with its named hook written; the compatibility matrix has exactly three rows reading "verified live", those three, the Codex and Antigravity rows each naming the client version and date of the recording it rests on, its events from that client's list (D409, D417) and its mode, install writing the client's own hooks and, on Codex, the developer trusting them with `/hooks`; the README names `0.167.0` as the minimum Codex CLI and `1.5.3` as the minimum Antigravity CLI for capture, and says that below them each gets the tools only; the orchestration matrix's Codex cells for a main that registers itself say "verified live" with that version, its cell for a worker's own tool calls says "verified live" only with the date of the build's live run of one, and the cells for subagent legs and the pointer say "not possible", naming the spawn message a hook cannot read (D411); the README says what a Codex entry does not hold (an exit code, which text was the error stream), that a Codex subagent is kept as a summary and is no leg, that a Codex main is re-oriented at a fresh start and on a resume and gets no bookmark ask (D410), that a manual Codex compaction leaves a recovery note and an automatic one is unrecorded (D409), that a call Codex reported no result for and a turn the developer interrupted are kept and say so (D408), and that an Antigravity CLI agent receives no re-orientation packet and an agy subagent is kept as a helper of the session that started it and is no leg (D418); the handshake's capture line says that hooks capture a session on Claude Code, and on Codex CLI or Antigravity CLI where their hooks are installed and running, and that elsewhere only what the agent inserts is kept, and its re-orientation lines say that the packet reaches a Claude Code session, and a Codex main at a fresh start, never an Antigravity CLI agent; the rest of D153 stands: any teammate reads and writes through the tools, and every other row stays documented-only with the date of the documentation checked [I]
  sib:   none -- a developer on Codex 0.166 told capture runs, or one on 0.167 told it never will, or a matrix that counts its verified rows two ways, is what this prevents, not a behaviour
  serves: N23 N3 N2
  touches: D153 D29 D30 D370 D388 D406 D408 D411
# the owner, 2026-11-09: "set a minimum codex version in the docs"; minimum client versions stated in the docs, for agy as for Codex. D153's "Claude Code alone today" was a fact of its date. This entry also amends D29's clause "Claude Code is the only live-verified capture platform", now three; D29's rule "nothing the agent reads may claim an unverified adapter works" holds, Codex's block being verified by D406's and D408's recordings and agy's hook by D413's and D415's. The header carries one relation, as the grammar has it, and D29 is in touches
# the handshake cannot know whether a client's hooks are trusted or written, so its line is conditional ("where their hooks are installed and running"); since the owner's ruling on question I (D410) a Codex main receives the packet at a fresh start, and an agy agent receives none: agy's hooks guide says a SessionStart hook can add to the session, which is unrecorded and not promised in beta.4 (D416)
# the orchestration cells for a worker's own tool calls rest on the build's live run of a ticketed worker whose hooks capture its calls: dated from that run, and cut, the cell reading "not possible" with the reason, if the recording comes out negative (D410's item 3 for Codex; recorded for agy, D416)
# build-time recordings this entry rests on: those of D406 to D411 and D413 to D418, the matrix's cells being no more verified than they are
# ruled by the owner, 2026-11-10 ("README only"): which clients receive the re-orientation packet is said in the README alone. The handshake card stood at 2044 of its 2048 bytes (D210) with the capture line in; the packet sentence did not fit beside the clauses other scenarios pin word for word, and an agent acts on none of it. Declined: shortening another pinned clause; raising D210's cap without evidence per client that a longer card arrives whole. Also ruled the same day: the interactive Codex recording keeps the developer's typed prompts as typed, nothing in them identifying anyone

D413 2026-11-09 [I] amends D383
  trig:  a developer with Antigravity CLI installed runs install, a reinstall or uninstall [I]
  resp:  where agy's version reads `1.5.3` or later, install writes agy its own named hook, `treecontext`, into `~/.gemini/config/hooks.json`, in agy's own shape (a hook name holding its events), for SessionStart, PreInvocation, PostToolUse, PostInvocation and Stop, and never PreToolUse, whose hook must answer with a permission decision and so would change what agy permits; each of its commands names Antigravity CLI, the hook taking its client from that and never from the payload, and runs the hook scripts install keeps for every client's hooks (D406); the developer's own named hooks in that file are never written over, moved or removed, a hook of the developer's that already carries the name `treecontext` is left as it is, install writing none and saying so, and `enabled: false` set on treecontext's named hook is the developer's off, kept by a reinstall; a workspace's `.agents/hooks.json` is the developer's, never written or taken back by install; the hook it writes answers agy with a JSON object at once and decides no permission; agy's MCP entry then starts the server in capture mode, as Claude Code's does (D386); install records what it wrote (D361), says in its summary which agy events it wired and in which file, and a reinstall converges the named hook to this build's and keeps the developer's (D385); where agy's version reads below `1.5.3` or cannot be read, install writes no hook, takes back what install wrote for agy, the named hook its record names or, where no record names it, a named hook `treecontext` whose commands are an earlier build's of treecontext, never a hook of the developer's, keeps agy tools-only with its entry started without capture, and says so in one line naming the version or that it could not be read; where the hooks file does not parse, install writes nothing into it, leaves it byte for byte, keeps agy tools-only and says so in one line quoting the parse error and saying that agy runs none of the hooks in that file, the developer's own included, until it is fixed; uninstall removes the named hook install wrote and, where no record names it, the named hook identified by its commands, and nothing else, deleting the file only where install's record says install created it and nothing else is left in it; the rest of D383 stands: the MCP entry, the four allow rules of D390 and the instruction block in `~/.gemini/GEMINI.md` [I]
  sib:   none -- capture on agy wired into a file whose shape agy refuses, which silences every hook in it, the developer's among them, with a line only in agy's own log, or a hook that answers a permission question the developer never asked treecontext to answer, is what this prevents, not a behaviour
  serves: N3 N9 N23 N27
  touches: D383 D399 D386 D385 D361 D390 D51 D29 D402 D406
# the owner, 2026-11-09: agy hook support goes into beta.4, "do not forget, any changes to tc doctor and install for adequate codex and agy hook support"; "I would rather slow the release and get it right"; minimum client versions stated in the docs. Evidence, the far-side pass of 2026-11-09 (journal 5aa808d8), Antigravity CLI `1.5.3`, three real headless `agy -p` runs with a dump hook on every event: the hooks file is `~/.gemini/config/hooks.json`, read by the TUI and the headless backend alike (a workspace `.agents/hooks.json` and a plugin's also load); its top-level keys are hook names, each `{enabled?, <Event>: [...]}`, PreToolUse and PostToolUse grouped under a `matcher` and the other four flat lists of handlers; named hooks merge, so a hook of treecontext's sits beside the developer's without touching it; a file in Claude Code's shape fails to parse whole ("command hook must specify 'command'"), the line only in agy's log under `~/.gemini/antigravity-cli/log/`, nothing on stderr, and no hook in it fires; there is no trust step, a written hook fires at once; a hook must print a JSON object on stdout; hooks are synchronous, run through `sh -c` with the hooks file's directory as their working directory, outside any sandbox, with a timeout of thirty seconds by default, and block agy's loop while they run. PostInvocation is wired since the gate's recording of 2026-11-09: a call's result step is not yet in agy's transcript when its PostToolUse fires and is there at the PostInvocation that follows (D415). Drafted as amending D383, whose "install writes no agy hooks" this entry ends; D399 also amends D383, and two entries amending one ruling stand as D378 and D379 both amend D376
# resolved from the record, not asked (the review's items b and g): agy's hook is written by default, as Codex's is (D406), the owner's "just work" being the rule for both; the floor is `1.5.3`, the version recorded, the pattern of D381 and D406 and the owner's "set a minimum … version in the docs", no earlier agy having been run with hooks and the hooks documentation read on 2026-11-08 carrying no date; below the floor install takes back what it wrote, the one rule D406 has for Codex
# drafted for the owner's read, 2026-11-09, beta.4 unit 11 charter draft. The hook's name `treecontext` and the parse-failure line are the drafter's
# build-time recordings this entry rests on (the review's list of 2026-11-09, item 12): agy's own version line, read by install and doctor

D414 2026-11-09 [I] amends D387
  trig:  a developer runs doctor on a machine with Antigravity CLI installed [I]
  resp:  doctor's Antigravity CLI row reads agy's hooks from agy's own files and says one of: treecontext's named hook is present and is this build's; it is absent, with `treecontext install --agent agy` as the remedy; it is an earlier build's, naming the events it differs on, with the same remedy; it is switched off with `enabled: false`, so nothing of agy's sessions is captured, the developer's choice, with no remedy but turning it on; the name `treecontext` is taken by a hook install did not write, with renaming that hook, the developer's to do, as the remedy; agy's version reads below `1.5.3` or cannot be read, so agy is tools-only, naming the version or that it could not be read, with upgrading agy and then `treecontext install --agent agy` as the remedy; or the hooks file does not parse, quoting the parse error, saying that agy runs none of the hooks in that file, the developer's own included, and naming fixing the file by hand as the remedy, never an install; where agy's version is not `1.5.3`, the row names it beside `1.5.3`, the version whose transcript layout capture reads (D418); the row reads the server's mode against the hooks it finds (D386); its headless-workers clause reads agy's own permission preset, `toolPermission` in agy's settings, and names it, `always-proceed`, `request-review` or `strict`, or says the key is absent, and what it means for a headless worker: under `always-proceed` every tool runs unasked, so the four journal tools' allow rules are not what lets them through; under any other preset, or with the key absent, a tool no rule of agy's allows, a shell command among them, may be refused in a headless run, the turn then ending with no reply, no error from agy and no further hook, so a worker that needs such a tool returns nothing unless the developer allows it, or gives that one run the preset with agy's session-only `--settings`; a settings file that does not parse, or a preset value outside those three, which is a preset doctor does not know, is said so, never guessed, the principle of D419; the rest of D387 stands [I]
  sib:   none -- doctor reading capture as healthy while agy's hooks file silences every hook in it, or a headless agy worker returning nothing while doctor read it ready, is what this prevents, not a behaviour
  serves: N9 N23 N26 N27
  touches: D387 D161 D208 D386 D413 D388 D384 D51
# the far-side pass of 2026-11-09, Antigravity CLI `1.5.3`: a call headless agy cannot ask permission for is auto-denied; agy prints nothing on stdout, exits 0, writes one line on stderr ("no output produced — a tool required the "command" permission"), and no PostToolUse, PostInvocation or Stop fires. A worker started through `treecontext run` that met this already leaves a summary row with the end of its error stream (D384, "having printed nothing"); the clause makes doctor and the README say it before the developer meets it. The README's "Left to you: nothing" for `agy -p` is true for the four journal tools only; D388's row is reworded with this entry. As for Codex (D407): doctor reads each client's hooks from the client's own files
# recorded live 2026-11-09, agy 1.5.3: whether an unallowed tool is refused depends on agy's own `toolPermission` setting in `~/.gemini/antigravity-cli/settings.json`; agy 1.5.3's own settings name its presets `always-proceed`, `request-review` and `strict` (read by the owner, 2026-11-09); under `always-proceed`, which the owner had set himself for the headless runs, a headless agy ran every shell command with no allow rule, the only preset recorded running every tool unasked; the silent refusals of the far-side pass were under agy's default, the key then absent, which preset that default is not recorded; the owner has since set `request-review`. What `strict` refuses beyond `request-review` is unrecorded, so nothing is promised of it but that it is not `always-proceed`. The README's advice for a worker: allow the tools it needs, or give the preset for that one run with agy's `--settings` (session-only settings), the second to be verified by the build's live run, not yet recorded. The owner's words on validating what is expected before assuming it are in D419's comment
# build-time recordings this entry rests on (the review's list of 2026-11-09, item 12): agy's own version line; a headless refusal under a named preset (`request-review` or `strict`); `--settings` giving one run the preset

D415 2026-11-09 [I]
  trig:  an Antigravity CLI session runs with treecontext's named hook installed: the developer submits a prompt, a tool call ends, a model call ends, or the turn ends [I]
  resp:  the session is journaled as a Claude Code session is, from agy's events and agy's transcript of the conversation: the prompt from the `lastUserInput` the events carry, journaled at each turn's opening `PreInvocation`, the one whose invocation number is `0`, with role user, a turn's later events carrying the same prompt adding nothing, and the next turn's prompt journaled though its text is the same; each tool call with agy's tool name and its arguments, from its PostToolUse or the transcript, and its output read from agy's transcript by the end of the model call that made it, at the `PostInvocation` that follows, under the same trail and treasure rule and the same preview and index boundaries, agy's tool names placed by what they do; a call whose result step is still not in the transcript at the conversation's `Stop`, or whose transcript cannot be read, is still journaled with its name and arguments and says that its output was not captured, never dropped; the reply from the transcript's last response of the turn, at the last `PostInvocation` or at `Stop`, with role assistant, or a capture-gap entry naming the reply where it cannot be read; a call carries no outcome mark, agy stating none (where the client states nothing the text decides, D404), and no call id, agy giving none; a call of treecontext's own tools through agy's MCP tool is journaled as any call, and the reply read from the transcript is its echo; what a hook cannot write goes to the gap ledger (D314); the moment of each entry is when the event that carried it arrived, a call's its PostToolUse's [I]
  sib:   none -- an agy session that leaves a journal of tool names with no output, or no prompt at all because agy has no prompt event, while the matrix calls its capture verified, is what this prevents, not a behaviour
  serves: N3 N2
  touches: D3 D270 D400 D404 D412 D314 D190 D413 D402
# the far-side pass of 2026-11-09, Antigravity CLI `1.5.3`: agy has six events, SessionStart, PreToolUse, PostToolUse, PreInvocation, PostInvocation, Stop, and none for a prompt, a subagent, a compaction or a failed call; payloads are camelCase, every one carrying `conversationId`, `workspacePaths`, `transcriptPath`, `artifactDirectoryPath`, `modelName` and `lastUserInput`, the prompt, repeated on every event of the turn; PreInvocation and PostInvocation fire around every model call with `invocationNum` and `initialNumSteps`; PostToolUse adds `stepIdx`, `toolCall` `{name, args}` and `error`, and no event carries tool output, assistant text or a call id. The output is in `transcript_full.jsonl`, one JSON line per step: the step PostToolUse names is the tool's result (a shell command's exit code and output as text; an MCP reply's JSON, so the insert's echo is readable there), the step before it the response carrying the call, the last response of the turn the reply; a large output is written to a file beside the transcript. A shell command that exits non-zero arrives as a PostToolUse with `error` empty, so agy states no shell outcome. A subagent's conversation opens with `lastUserInput` empty, and adds no prompt entry. agy reads each MCP tool's schema with `read_file` before calling it, which is journaled as the read it is
# recorded live by the gate, 2026-11-09, agy `1.5.3`, settling the review's items 4 and 5: at PostToolUse the transcript ends at the PLANNER_RESPONSE that made the call (its line count equals `stepIdx`); the result step (type GENERIC, status DONE) is there at the PostInvocation that follows, in every run; with parallel calls a later PostToolUse may or may not see an earlier call's result; the final reply's PLANNER_RESPONSE is in the transcript at the last PostInvocation and at Stop. Hence the output is read at PostInvocation, the normal path and not a deferred update, and PostInvocation is wired (D413, D417). A second prompt in the same conversation (`agy -c -p`, the same text as the first) fires no SessionStart; its turn opens with a PreInvocation whose `invocationNum` is 0 again and whose `initialNumSteps` counts the transcript including the new USER_INPUT step, and every later event of the turn repeats `lastUserInput`; SessionStart fires once per conversation, on its first turn only (headless). Hence "once per turn" is the PreInvocation numbered 0
# drafted for the owner's read, 2026-11-09, beta.4 unit 11 charter draft: the "output not captured" wording is the drafter's. The shell-failure scenario says "as recorded": the recording's command exits with code 1, and the scenario names no value the recording does not hold
# build-time recordings this entry rests on (the review's list of 2026-11-09): items 4 and 5, release-blocking, settled 2026-11-09 as above; item 12, a non-zero shell exit and its transcript kept as a fixture

D416 2026-11-09 [I]
  trig:  an Antigravity CLI session starts with treecontext's named hook installed, as a main in a checkout or as a worker the ticket door started [I]
  resp:  a main registers itself at SessionStart as a self, keyed by its conversation id, placed in the checkout its workspace is in (D190), so its rows and the notes it writes through the tools are stamped as a hooked main's, its lane read as any self's (D374, D379); a subagent's session start never takes over the main's identity: a note the main writes after its subagent has started is stamped as the main's own; a worker the ticket door started is never a self: its SessionStart registers no self, and its captured rows land in its worker's lane, as a `claude -p` child's do (D295), its tool-written rows stamped as D288 has them; a worker's `treecontext run` may name an agy main as a registered parent, linked by id (D294), and an agy main below `1.5.3` or with no hook stays a parent no hook registered, declared on each worker's registration; treecontext's hooks print agy nothing at SessionStart in `0.1.0-beta.4`, so an agy self orients through the session-start routine of its instruction block, not through a re-orientation packet; a subagent agy starts is a helper of the session that started it, never a self (D418) [I]
  sib:   none -- an agy main's chapter summary read as writer unknown and set apart from its own checkout's thread, a ticketed agy worker's captured calls landing in the main lane as the checkout's self, or a main's notes stamped as its subagent's, is what this prevents, not a behaviour
  serves: N27 N32 N18 N31
  touches: D190 D295 D294 D288 D374 D379 D383 D413 D415
# the far-side pass of 2026-11-09, Antigravity CLI `1.5.3`: SessionStart carries `conversationId` and `workspacePaths`, and the hook's environment carries `ANTIGRAVITY_CONVERSATION_ID`. Recorded live by the gate, 2026-11-09: under `treecontext run … --message-arg -- agy -p`, every hook's environment held `TREECONTEXT_TICKET`, `TREECONTEXT_WORKER_SESSION` and `ANTIGRAVITY_CONVERSATION_ID`, so the worker clause stands on a recording. This retires, for agy at `1.5.3` and later with the named hook, the premise of the fence's Antigravity CLI entry that "a main agy session registers no self", and the D288 outline's note that no agy parent is registered; the D294 outline's agy row stands for a main whose hooks do not run. As for Codex (D410): a hooked main registers a self through SessionStart
# the identity hazard (the review's B7): in the recording agy ran its hooks through `sh` (`ppid_comm` "sh"), so the pid beacon needs the hook's command to `exec` its interpreter, as D251 did for Claude Code; one agy process hosts the subagent's conversation too, and a subagent's SessionStart (D418) would otherwise rewrite the beacon keyed to agy's pid, stamping the main's later notes as the child's, whether the child is linked yet or not. How the build keeps the main's identity (a beacon keyed by conversation, the main's kept while its process lives) is the build's; the promise is the scenario's
# build-time recordings this entry rests on (the review's list of 2026-11-09): item 3 for agy, settled as above; item 6, release-blocking, agy's MCP server process: its environment, whether one server serves several conversations (which would make it a caller that cannot be told apart, D240, until the call's echo, read from the transcript, heals the stamp), and the beacon under `exec` with a subagent running; whether SessionStart's answer adds to the model's context (agy's hooks guide says it can inject steps; unrecorded, so no packet is promised in beta.4)

D417 2026-11-09 [I]
  trig:  a build wires Antigravity CLI's hooks, or agy gains a hook event [I]
  resp:  the repository keeps agy's hook events as a list in the form D402 gives Claude Code's, with agy's version and the date it was read at: SessionStart, PreInvocation, PostToolUse, PostInvocation and Stop wired, PostInvocation for the call results and the reply agy's transcript holds by the end of each model call; PreToolUse named as not wired because its hook must decide the call's permission, so nothing of a call before it runs is captured; and agy's lack of a prompt, subagent, compaction or failure event named with what the journal does not capture because of it; the guard of D402 holds the list against the hook install writes for agy; a charter step that says an event is as Antigravity sends it replays events and the transcript recorded from a real agy, redacted and kept with agy's version in agy's own fixture directory under `tests/fixtures/`, through the hook install writes, and the guard of D402 holds every such step to that directory, a payload written by hand never called agy's; a stand-in for the agy a version check reads lives with the other stand-ins; the dogfood census counts an agy session's tool calls in its transcript against the store by conversation and step, there being no call id [I]
  sib:   none -- an agy event the journal never hears, or one whose hook would change what agy permits, wired without anyone setting agy's own list beside the hook, is what this prevents, not a behaviour
  serves: N3 N2
  touches: D402 D413 D415 D3 D250 D51
# drafted from D402's rule applied to a second client, 2026-11-09. As for Codex (D409): each client's list beside its wiring. PostInvocation, drafted as not wired "because it carries nothing the wired events do not", is wired since the gate's recording of 2026-11-09 (D415): a call's result is in the transcript at the PostInvocation that follows its PostToolUse, not at the PostToolUse. The recordings the build takes, each under agy `1.5.3`, scanned for private identifiers before commit (the repository is public; the transcript holds model-written text and paths): a headless session with a shell command, a non-zero shell exit, a file read and two treecontext calls, an insert among them, with its transcript; an interactive two-turn session whose second prompt equals the first; a session with an `invoke_subagent` call, the child's events and both transcripts; a headless call auto-denied, its events and transcript; a `treecontext run` worker's events, recording the hook's environment; agy's own version line
# build-time recordings this entry rests on (the review's list of 2026-11-09, item 12): the fixtures above, the version line among them

D418 2026-11-09 [I]
  trig:  an Antigravity CLI session starts a subagent, a call agy refuses ends a turn, or a reader relies on agy's transcript [I]
  resp:  a subagent agy starts with `invoke_subagent` is journaled in its parent as the tool call it is, with its prompt and role as input and, as its output, the transcript's result, read at the `PostInvocation` that follows (D415), which names the child's conversation; the child is registered as a helper of the session that started it, as a Codex subagent is (D411), linked through that call, with the role the call names as its writer, and never as a self of a checkout; its report is the message it sends its parent with `send_message`, read from the child's own PostToolUse, kept as its summary; it is retired at its conversation's `Stop`; its rows are a helper's trail, outside its parent lane's default search, its report inside it, as the lane read has it for helpers (D374, D376); it is never a leg: no key, no first moment, no send-back and no pointer on the call's return; the child is journaled from its first event as an unlinked session placed in no checkout's lane, its rows read as writer unknown and never as the main's, and is linked once the parent's call result is read, whichever comes first, the child's start or the parent's result, and stays unlinked where that result is never read; a child, linked or not, never takes over the identity of the session that started it (D416); subagent legs through the hooks door and the pointer on a subagent's return stay fenced on agy until a ruling of `beta.5`; a call agy refuses in a headless run, under any permission preset but `always-proceed` (D414), and the rest of that turn, leave no entry, no event firing for either, and a ticketed worker that met one leaves agy's own line in its summary row's error stream (D384); agy's transcript is agy's file, read in the layout recorded at `1.5.3`, and where its layout is not that one the call is kept and its output said not captured (D415), and doctor names agy's version beside the one recorded (D414) [I]
  sib:   none -- a subagent conversation passed off as a leg the store never saw open, or read as another main of the checkout whose chapter competes with the main's own, or a capture matrix that reads as if a refused call were journaled, is what this prevents, not a behaviour
  serves: N3 N27 N31
  touches: D370 D383 D294 D320 D374 D376 D384 D411 D415 D416 D401
# the far-side pass of 2026-11-09, Antigravity CLI `1.5.3`: `invoke_subagent` `{Prompt, Role, TypeName}` starts the subagent as its own conversation, with its own SessionStart (a new `conversationId`, `lastUserInput` empty), PreInvocation, PostToolUse and Stop; nothing in its payloads names the parent, the parent's transcript result for the call names the child, and the child answers with `send_message` `{Message, Recipient}`, the recipient the parent's conversation. The order of the child's SessionStart and the parent's PostInvocation is not fixed (recorded live 2026-11-09, agy 1.5.3): in the far-side pass the parent's `invoke_subagent` PostToolUse (step 12) and its PostInvocation came before the child's SessionStart; in the fixture of 2026-11-09 the child's SessionStart came before the parent's PostInvocation. So the child is journaled unlinked from its first event and linked when the parent's result is read, in either order, the unlinked state being the normal path and not an exception. Roads not taken for beta.4: a leg registered from the parent's `invoke_subagent` row and the child's `send_message` (the beta.5 legs work on agy); the child as another self of its checkout (the draft before the owner's ruling: its chapters would compete with the main's own); the ticket door reading a worker's transcript at exit (a second reader of the client's file, outside the hooks). Fences: the Antigravity CLI entry of Out of reach amended, a denied call's turn, the transcript's layout as a named assumption
# the owner, 2026-11-09, on question J: "yes" to the gate's recommendation: an agy subagent is a helper of the session that started it, linked through the parent's call, and never a leg, with the unlinked fallback promised
# resolved from the record, not asked (the review's item f, and the gate's F): a refused call in a headless run is out of reach by construction, nothing following the refusal; an interactive refusal is unrecorded, and stays fenced with the README saying so, until a recording shows what follows it
# recorded live 2026-11-09, agy 1.5.3, the owner's interactive session: an interactive conversation fires SessionStart at its first prompt, not when the app opens, the payload's `lastUserInput` already holding that prompt and the PreInvocation numbered `0` following it; the turn ran eighteen model calls and ended with one Stop (`terminationReason` `NO_TOOL_CALL`); quitting agy fired nothing, agy having no session-end event. Interactive and headless starts look alike, and nothing in this entry or D416 rests on an interactive SessionStart opening before a prompt
# build-time recordings this entry rests on (the review's list of 2026-11-09): item 6, release-blocking (D416); item 12, the two link orders and an interactive SessionStart settled as above, an interactive refusal still unrecorded

D419 2026-11-09 [I] amends D255
  trig:  a directory above a project, or between a project and its repository's root, holds a `.git` that is no repository: an empty directory, as Codex CLI's sandbox leaves in a writable root as a mount point for a name it protects, or any directory or file git itself does not accept as a repository [I]
  resp:  a `.git` that is no repository is not a project root: the project directory the store binding and the config file resolve to (D255) is the primary root of the nearest repository git accepts, else the directory itself, as for a project without git, a `.git` git does not accept being passed over wherever it lies; a project with no repository keeps its own store, keyed by its own directory, and reads its own `treecontext.toml`; where resolution passed over such a `.git`, doctor says it was ignored because it is no repository and names its path [I]
  sib:   none -- unrelated project folders below a stub `.git` sharing one journal, bound to the stub's directory, and each reading the installation's config instead of its own, with nothing saying why, is what this prevents, not a behaviour
  serves: N6 N9 N7
  touches: D255 D51
# the owner, 2026-11-09: "yes, i think .git validity check is very reasonable. i generally feel that anything that is expecting a specific directory or file structure, or a specific file, should be doing validation before assuming … just good hygiene." Evidence, 2026-11-09, on the desktop (Linux): Codex CLI's sandbox left empty directories named `.git`, `.codex`, `.agents` and `.aws` in a writable root, the system temp directory; test projects under it read the installation's config instead of their own `treecontext.toml` (13 failing tests until the stubs were removed), and a real project below such a stub would have bound to the stub's directory's store
# the check that accepted the stub, read from the code (src/server/bindings.ts): identity asks git first, one `git rev-parse --show-toplevel --git-dir --git-common-dir` (`gitRoots`, through `gitFacts`), and git itself refuses an empty `.git` ("not a git repository"), so it answers nothing; `identityFrom` then falls back to `findProjectRoot`, treecontext's own walk up from the directory, which returns the first ancestor where `existsSync(join(current, '.git'))` holds, and an empty directory, a file, anything named `.git`, passes. `projectRootFor` (the config file's directory, D255) and `projectIdentity` (the binding's `path:` key) both read that root. The cases are distinct in the code: an empty `.git` directory between a project and a real repository's root is passed over by git's own discovery (checked 2026-11-09 with git: `rev-parse` from below it prints the repository's root), so the walk is never reached; a `.git` FILE git does not accept between them makes git stop ("invalid gitfile format", exit 128), and the fallback walk then returns the stub's directory; a stub above a real repository's root is never reached, git finding the repository first. The build's means are its own (the walk asking git of each candidate, or checking the shape git accepts); the promise is that nothing named `.git` is taken on its name alone. The owner's wider principle, validation before assuming any expected file or directory, is recorded here as his words and not chartered elsewhere by this entry
# ruled by the owner, 2026-11-10 ("add all three"), from the review of the build: (1) doctor names the store an earlier treecontext bound to a passed-over `.git`'s directory, says it is left as it was and gives the merge command, moving nothing: the ruling's own effect is to move such a developer to a new store, and nothing else says where the old journal is; (2) a session's placement (D190) reads the same resolution as the store binding: a linked worktree's session below a `.git` file git cannot read was bound to the repository's store and placed as the main checkout's, able to retire main's chapters (D169). Two scenarios in journal-storage

D420 2026-11-09 [I] amends D240
  trig:  a row written through the tools asks to supersede an entry, or is a bookmark that retires its lane's earlier live bookmark of the session, while the store's stamp of its writer is not exact: one subagent live and the session's own agent silent since it started (`provisional`), or several live (`ambiguous`) [I]
  resp:  a supersession asked under a stamp that is not exact is neither applied to another writer's entry nor dropped: it is held on the new entry as pending, and the reply says so in words, naming each target and that it waits for the call's echo to name the writer, never that the targets were left live as another writer's; a bookmark's retirement of its lane's earlier live bookmark of the session (D241) is held the same way; when the echo heal sets the writer exactly, each held target that is that writer's own, in its lane as the registry places it for any pointer (D379), is retired as an immediate supersession would have retired it, its pointer flag cleared, its status demoted and the trace of what retired it kept, and a bookmark that lands in a lane retires that lane's earlier live bookmark of the session; a held target that is truly another writer's stays live and unchanged and is recorded as referenced, as D169 has it; where the first stamp retired a pointer the exact writer does not own, the heal restores it, as D240 has it; until the heal, and for good where no echo is ever captured, the new entry and status show the supersession as pending, naming its targets, never applied and never dropped silently [I]
  sib:   none -- an orchestrator's own stale bookmark left as a live resume pointer because it superseded it while a subagent happened to be running, or an agent told its supersession was refused when it was only waiting, is what this prevents, not a behaviour
  serves: N1 N5 N20 N2
  touches: D240 D169 D241 D379 D190
# the owner, 2026-11-09: "yes move supersede bug into beta.4". The finding, 2026-11-09 on the desktop, one session: the session's own agent inserted bookmarks (6be1aef7…, then 0c1c523c…) naming its own earlier bookmarks (08cc855c…, then 6be1aef7…) in `supersedes`, while exactly one subagent of the session was live and the own agent had been silent since it started; each insert was stamped `provisional` as the subagent's, and the reply listed the targets under `referenced` with the note "Written by another writer, so left live and unchanged; recorded in this entry's refs, where that writer sees it as referenced-by" (src/server/server.ts, `referenced_note`)
# what the code does, read 2026-11-09, and what the store shows: at insert `splitSupersedes` (src/flat-store.ts) sorts each target by lane against the insert-time writer, and a target outside the provisional subagent's lane goes to `foreign`, kept on the new row as refs and as `_supersedes_referenced`; the reply's `referenced_note` says nothing of the stamp being provisional. At the drain the echo heal (`healWriterFromEcho`, src/persistence/writer-heal.ts, its step 3) performs a `_supersedes_referenced` target once the echo moves the row into the target's lane. The store bears it out: 6be1aef7 and 0c1c523c carry `_writer_stamped` `{general-purpose, provisional}`, `_writer_src` `echo`, `_writer` `main` and `_writer_heal_retired` naming 08cc855c and 6be1aef7, retired about 3.5 s and 2 s after their inserts. So the supersession named in `supersedes` is not dropped in this build once its echo drains; what is wrong: (1) the reply tells the agent its own supersession was refused as another writer's, and until the drain status lists the old bookmark live; (2) `_supersedes_referenced` is one mark for a held supersession and a truly foreign one, so where no echo is ever captured the held one reads as foreign for good, nothing showing it pending; (3) the bookmark's own retirement of its lane's earlier one (D241, the prior bookmarks computed at insert from the insert-time writer's lane) is never re-run at the heal, so a provisional bookmark that names nothing to supersede leaves the orchestrator's earlier bookmark live beside it after the echo; (4) D240's resp says "a supersession recorded as a reference stays one" where the echo moves a row into a lane, which step 3 contradicts. This entry amends D240's clause to the held-then-applied rule, with the pending made visible, the pattern AGENTS.md records for a run's open or close row (`_by_src` `pending` until the echo heal). `concurrent` stamps the session's own agent and applies at once, as before; `ambiguous` owns no lane, so every target it names is held
# 2026-11-10, from the review of the build, no ruling needed (D241's own promise): a bookmark is retired in favour of another only when that other's writer stamp is exact, and each bookmark applies D241 for itself when its own echo settles its stamp, so a lane ends with exactly one live bookmark of the session whichever echo is drained first. D240's clause on a supersession recorded as a reference carries a dated pointer here

