# The scope fence

Declined scope is as load-bearing as accepted scope: every entry here was
raised, considered, and ruled out, with the why in the owner's terms and
the ruling it came from. An agent that finds itself building a fence
entry is off the charter; re-opening one is an owner decision, made as a
new dated docket entry, never an implementation decision made in code.
Open questions are not fence material; they live in the journal until
ruled.

Each entry ends with one trailing parenthetical: the docket id or ids it
came from (`features/DOCKET.md`) and the ISO date of the ruling. A
Deferred or Named-assumption entry carries its reopening condition. The
fence was rewritten into this grammar at the docket backport of
2026-09-28 from the two fences it consolidates, the charter fence (rulings
of 2026-07-16 to 2026-08-01) and the migration-backup fence (the interview
of 2026-08-06 and its amendments through 2026-08-15); nothing was
re-decided, and the previous text is in git history.

## Declined

- **ORT on-disk model format** — no benefit at this model scale; the int8
  quantization variant is the win. Resights when the embedder tier's bench
  gate reopens on a model of materially different scale. (D1, 2026-07-12)
- **Trees in the journal** (RAPTOR, MemTree, BIRCH-PCA) — built,
  benchmarked, removed: no benefit for single-author chat-session recall
  over a flat store. Reopens when a new approach shows measured recall
  benefit on this workload. (D11 amended by D136, 2026-09-28)
- **Dual-tree + promotion pipeline** — same fate; complexity without
  measured recall benefit. Reopens when a new approach shows measured
  recall benefit on this workload. (D12 amended by D137, 2026-09-28)
- **Complex query fusion** across journal and code results — they stay
  simple, separately presented surfaces. Reopens when a new approach
  shows measured recall benefit on this workload. (D13 amended by D138,
  2026-09-28)
- **Server-side LLM / summarization** — the calling agent's job; the
  lexical backend registers no checkpoint or summarize machinery and its
  instructions must not mention any. Revised 2026-10-08: D215 amends
  D14 — the backend registers no tree-era checkpoint or summarize
  machinery and its instructions name none of it; the checkpoint of
  D158, a bookmark or a chapter summary, is an entry the agent itself
  writes, not machinery, and the instructions teach it, as the
  sanctioned change below records. (D14, 2026-07-16)
- **A dual database driver** — better-sqlite3 kept beside `node:sqlite`
  as a fallback for Nodes below the floor. One driver, zero native
  dependencies: a fallback keeps the ABI-mismatch failure class, the
  per-major prebuild chase and a second test surface for the one thing
  the switch removes. Reopens only if a supported platform ships a Node
  without `node:sqlite`. (D278, 2026-10-11)
- **A Node 22 floor for `node:sqlite`** — the 22 line's module warns on
  every load, a stderr line per hook process and per server start that
  the reference client's debug log records as an error; its API floor is
  22.16; and a text read truncated at an embedded NUL there, fixed in
  24.16 and never on 22. Suppressing the warning in the launcher would
  hide the line and keep the defect. The floor is `>=24.16` and moves
  only forward. (D278, 2026-10-11)
- **Pure-dense retrieval** — no seat at any tier; the ladder is BM25,
  BM25 plus static, BM25 plus int8 ONNX, every tier BM25-anchored, and
  dense enters (if ever) as a fused, opt-in second ranked list.  (D18, 2026-07-23)
- **Reference-frequency in default ranking** — never; it feeds session
  eviction ordering only, because hit-boosted ranking is the
  rich-get-richer loop that breaks reproducible search. (D21, 2026-07-23)
- **Per-entry / fragment eviction** — eviction is whole-session only;
  rounds are the conversation-window fabric. Copy-forward promotion of
  hot entries is the designated post-MVP shape if eviction reordering
  proves too weak. (D23, 2026-07-23)
- **Power-loss tail durability** (`synchronous=FULL`) — consistency across
  power loss is promised (the store opens clean); the last committed
  moments may be honestly lost. Never traded for write latency the
  charter does not need. (D24, 2026-07-23)
- **Multi-reference entries, media dedup, media versioning machinery** —
  exactly one reference per entry and several attachments are several
  entries; each attachment is a fact about the conversation and no bytes
  are stored, so duplicates cost nothing; a new version seen is a new
  event and drift detection is the hash-in-metadata convention, not a
  store mechanism. (D27, 2026-07-23)
- **Thumbnailing, transcoding, byte storage of media** — never: the
  journal is a text store and the description is the searchable surface.
  (D28, 2026-07-23)
- **Advertising unverified platform adapters** — Claude Code is the
  verified reference platform; the codex, cursor, gemini, opencode, and
  vscode adapters stay labeled unverified and unadvertised until each
  earns a live-payload verification pass, and bringing an adapter onto
  the charter's capture semantics is part of that pass; reaffirmed at the
  re-scope (D109).  (D30, 2026-07-23)
- **The tree-sitter code index** (`treecontext_code`, the grammars, the
  code backend and hints) — deprecated in full; owner's why: too low level
  for the lane this process operates at, and with million-token contexts
  an AST tool saves a few tokens, not enough to matter. Recovery, if ever
  wanted, is git. Resights when prevailing agent context windows fall
  materially below that premise. (D32, 2026-07-24)
- **Designing treecontext around unbuilt addons** — it stands on its own
  behind a published consumer contract (stable node ids, portable
  exports, open metadata, disclosed eviction); an addon's requirements
  enter through that addon's own scoping as new rulings, never inferred
  ahead of it. That contract is also the whole provision for a future
  code-tree consumer. (D33, D111 reaffirms, 2026-08-28)
- **Compaction lifecycle (Layer 3)** — out of the MVP charter: ccr owns
  the compaction interaction; the pre-compact snapshot and session-start
  rehydration hooks stay as working mechanics, unspecced by this suite.
  Resights when Claude Code ships a clear-session hook. Revised
  2026-10-08: the condition was already met when this resight clause
  was recorded — Claude Code's SessionStart fires with source `clear`,
  and the session-start hook has handled that source since 2026-07-27,
  commit 67b5793 — so the clause was stale at birth; the /clear path is
  now built and specced: the re-orientation packet on the clear chain,
  D216, and the `exec` hook command that lets the hook find its
  predecessor, D251. (D35, 2026-07-24)
  Amended 2026-10-30 (D286): "working mechanics, unspecced" covered a
  path that wrote a row into the store on every compaction, and that row
  compounded until a query reply ended the connection. What the drain
  WRITES from a snapshot (the recovery snapshot row: what it quotes, how
  much, and its boundaries) is in the charter now, journal-capture and
  journal-recall. Only the compaction interaction itself, when and why a
  compaction happens, stays with ccr. A fence may decline a promise,
  never a writer: anything that writes to the store is in the charter or
  out of the build. Amended 2026-10-31 (D290, D304): install writes
  Claude Code's idle-compaction key off when absent and the client is
  known to honor it, says so, never touches a user-set key; doctor
  reports it; the compaction interaction itself stays with ccr, the one
  declined promise this entry still fences.
- **`treecontext_feedback`** — dropped from the tool surface: on the
  lexical backend it was an honest no-op that still promised an effect,
  wiring it into ranking is the loop the reference-frequency entry
  forbids, and every registered tool is context tax.  (D37, 2026-07-25)
- **Shared-process serving (the daemon)** — went with the tree era as a
  coupled dependency; `serve` runs standalone per session, and the
  multi-agent story is namespaces of one store with a single
  capture-drain owner. If a shared process is ever needed again, it
  returns through a new ruling. (D38, 2026-07-25)
- **Score fusion for the recency channel** (decay multipliers, normalized
  score fusion) — measured worse: a decay slope rides on corpus-dependent
  BM25 score ratios (the probe's strongest lexical hit fell to forty-fourth),
  where rank fusion pays one uniform price and needs no normalization.
  (D41, 2026-07-26)
- **Renaming the product** — the name stays: the tree is the working
  tree, git's own term, one journal per working tree. Resights when the
  npm name is no longer available or a trademark claim surfaces.
  Revised 2026-10-08: the npm package name became `treecontext-mcp`,
  D247 and D248; the product name, the `treecontext` command and the
  store directory stay, so this is a package-name change, not a rename
  of the product. (D42, 2026-07-26)
- **Rank-order claiming for contested window neighbors** — a contested
  neighbor goes to whichever hit comes first in the returned ordering,
  not to the higher-ranked hit regardless of sort. Reversible; the detail
  record lives in `flat-store-conversation-window.feature`. (D52,
  2026-07-31)
- **Automatic or age-based backup cleanup** — never; sweeping is manual
  and opt-in, and nothing deletes a backup without a user running the
  command. (D62, 2026-08-06)
- **Sweep alternatives, declined together** — verify-on-demand or
  grandfathering for unverdicted backups (no verdict means refused,
  labeled); extra ceremony for large sweeps (one `--yes` covers thirty-nine
  items as readily as two, because safety lives in per-item
  verification); all-or-nothing and prompt-per-refusal partial modes
  (chose delete-eligible, report-refused, with a partial-completion exit);
  always-keep-newest generation rules (each generation is verified
  independently); deleting corrupt backups as junk (unreadable means
  unverifiable); listing foreign `.bak` files as unrecognized (only the
  exact `treecontext.db.pre-migration-v<N>.bak` name is ours); `stores rm`
  taking no backups or all of them (verified go with the store, the rest
  are spared and named); interactive per-item confirmation (the house
  two-run dry-run then `--yes` idiom). (D63, 2026-08-06)
- **The HTTP transport** — tombstoned at the pre-release audit: both of
  its original consumers are gone and it is an unused network surface.
  (D77, 2026-08-12)
- **User backup verdicts** — user backups (`backup <dst>`) get no verdict,
  ever: verdicts belong to migration backups, whose twin state at the
  moment of recording is what makes them checkable; a user copy's
  validity is the SQLite online backup interface's guarantee, not a
  recorded claim. Resights when user backups stop resting on that
  guarantee. (D87, 2026-08-15)
- **Mobile operating systems in the support matrix** — mobile is a
  performance-envelope claim only; ARM is proven incidentally through the
  Apple-silicon lane. (D107, 2026-08-28)
- **Unicode / CJK tokenization category** — declined with provenance at
  the re-scope checklist sweep. (D117, 2026-08-28)
- **Per-subagent MCP servers** — too ambitious for the attribution
  program; a subagent talks only to the server its parent session talks
  to. (D124, 2026-09-23)
- **The compliance category** — no regulation, standard, hackathon rule
  or house rule binds treecontext in the hackathon scope. (D182,
  2026-10-07)

- **The performance category, for the subagent work** — declined with
  provenance at the beta.3 checklist sweep: no ruling of this program
  names a slowest acceptable lookup, first moment or export at the
  largest realistic run; security was confirmed as already answered by
  the traceability principle and not re-probed. (D306, 2026-10-31)

## Deferred

- **Code-static embeddings** — behind a bench gate: extend the recall
  bench with a code-static variant and measure whether code-dense adds
  recall the BM25 plus English-static hybrid misses; check
  tokenization-shaped failures first. If it earns a seat: n-way RRF,
  never concatenation, never content-type routing. Reopens when
  code-static embeddings are proposed for the journal with that
  measurement in hand. (D19, 2026-07-23)
- **Embedder as a service** (sidecar, container) — post-MVP; a transport
  for the embedder tier, not a retrieval tier, and its reserved shapes
  (loud degrade on an unreachable embedder, local and remote ranking
  parity) land only when dense does. Reopens when dense lands. (D20,
  2026-07-23)
- **Dense search in the first release** — both dense scenarios are
  excluded from the release and stay in the wip register; dense search is
  post-release work. Reopens when dense search is proposed for a release
  after the first. (D73, 2026-08-11)
- **A visualizer, GUI, or on-the-fly approximate-neighbor index** — a
  future consumer, zero work in the first release; the index sits inside
  the optional-dense provision. Reopens when such a consumer is proposed.
  (D112, 2026-08-28)
- **The remainder of the attribution program** — the registry table,
  the access log, groups configuration, forgery refusal, log retention,
  the schema document and the delete and clear tiers follow the public
  release on the orchestration platform developer's timeline; the proposal's remaining
  sections seed that interview. Reopens when the orchestration platform
  developer's interview resumes after `0.1.0-beta.1`. Revised
  2026-10-08: the registry table shipped in `0.1.0-beta.1` as
  `session_registry`, migration 027, D235; the rest of this remainder —
  the access log, groups configuration, forgery refusal, log retention,
  the schema document and the delete and clear tiers — stays deferred.
  (D203, D191, D122 amended by D191, 2026-10-07)
- **The two-axis coverage bar and the latency gate** — the merged
  three-lane coverage harness ships report-only and the bar of complete
  coverage plus every non-equivalent mutant killed moves to the `0.1.x`
  line; the latency harness reports and never gates. Reopens when the
  `0.1.x` line opens the exclusion rulings. (D204, D194, D106 amended by D194,
  2026-10-07)
- **Group orientation** — a member orienting on self and on its group
  waits for groups configuration, which lands with the remainder of the
  attribution program; D168 stays in effect and unbuilt. Reopens when
  groups configuration lands. (D209, D168, 2026-10-08)
- **The beta.2 set** — references and the reverse index, self
  registration and writer stamps, file-bound export and import with the
  summary-only default and the self-describing file, and doctor's rows
  per client stay in effect and unbuilt between `0.1.0-beta.1` and
  `0.1.0-beta.2`, disclosed as such. Reopens, that is, builds, by
  `2026-10-16`. Revised 2026-10-08: the set was built on 2026-10-08
  and ships in `0.1.0-beta.1`; nothing of it stands in effect and
  unbuilt, D253, awaiting the owner's ratification. (D205, D197,
  2026-10-07)
- **The shape of N19 (every touch of an entry recorded) and N22 (a group
  of subagents found as a group)** — unscoped by the audit of
  2026-10-08; N19 is the access-log design shelved as the drain product,
  N22 a new feature, each two to four chunks if kept and a fence line if
  declined. Nothing is built toward either. Reopens at a scope session
  before `0.1.0-beta.3`, which rules each onto this fence or the
  schedule, ruling explicitly on the access log (D125, D128) and on
  group orientation (D168), which stays under its own entry above until
  then; D209's condition governs D168 until that session. (D267,
  2026-10-10)

## Named assumptions

- **Hand deletion is the path for refused backups** — orphans with failed
  or missing verdicts, corrupt backup files, and pre-verdict backups stay
  on disk until the user removes them by hand; an accepted consequence,
  not a gap. Narrowed 2026-08-10: verified orphans have the explicit
  `stores rm` path (D70). Reopens if a backup the sweep refuses ever needs
  an automatic path. (D68, 2026-08-06)
- **Deletion-failure worlds are staged by a filesystem fault seam** — a
  path-scoped rmSync seam, not file modes, because mode-based staging
  would unbind the scenarios on Windows and the sidecar-only failure
  cannot be staged on a real filesystem at all. Reopens when a portable
  filesystem-fault-injection primitive exists across POSIX and Windows.
  (D85, 2026-08-14)
- **The shell/stray precedence branch is unreachable for shells** — a
  listing row can never be both (a shell has no database, a stray has an
  openable empty one), so the branch stays as written and each label is
  pinned separately. Reopens if a row could ever be both. (D89,
  2026-08-15)

- **Treecontext stays a faithful journal of the session** — with
  sufficient metadata to understand who contributed and to recreate the
  timeline; the ground every beta.3 ruling rests on, restating the
  charter's own stance: capture judged by whether a future agent would
  find the moment, honest timestamps, attribution earned. Reopens if a
  ruling of this program would have the store synthesize, rewrite or
  drop a row's writer or moment, would let a checkpoint lookup return
  something the journal does not hold, or would let a leg's rows enter
  the store without the writer and moment the rest of the journal
  carries.
  (D283, 2026-10-29)

## Out of reach by construction

- **A pid-keyed namespace rung on Windows** — the `.cmd` hook wrapper
  cannot exec into node, so the hook's parent pid is a per-process shell
  and the pid rung never fires there; Windows resolves by the
  session-keyed annotation the drain publishes from exact echo evidence.
  (D90, D95, 2026-08-20)
- **Charter detail (d)** — a lettering skip: the file map cites every
  other letter and no one can reconstruct a dropped one. If a real detail
  ever resurfaces it enters through a new ruling. (D34, 2026-07-24)
- **Clearing on the developer's behalf** — no hook or tool can issue a
  /clear; the prompt hook never sees the command (476 captured turns in
  the live store, none of them the command), so treecontext suggests a
  clear after a chapter summary and never performs one. (D173,
  2026-10-07)
- **The live model reply after a clear** — whether the agent shows the
  packet first is the model's act; the scenarios bind on the packet the
  hook emits and on the instructions that say to show it, and the
  dogfood sessions are the running evidence. (D188, 2026-10-07)
- **The other four stack tools** — gherkin-node-test, docketry,
  gherkin-trace and the scope and audit skills live in their own
  repositories; the hackathon vision names them as the environment this
  contract works inside, and nothing here binds them. (N23, D155,
  2026-10-05)

- **Not-started at the hooks door** — a Claude Code subagent cannot be
  declined at its start: the subagent-start hook is context-only by the
  platform's rules, so a hooks-door leg at an unreachable store starts
  cold and the dropped start is marked as a capture gap; not-started
  holds at the ticket door, where the door is the spawner. (D314,
  2026-10-31)
- **How the hooks door reads a brief it is not handed** — the
  subagent-start payload carries the subagent's id and role, not its
  prompt; the key is inferred from the role's newest brief, ambiguous
  when more than one is in effect, settled by the leg's first write. A
  hook on the Agent tool call that pairs the prompt with the spawn is
  left to the build, bound by that behavior. (D320, 2026-10-31)

## Roads not taken

- Declined alternative, Copy-forward references — a note that responds to an earlier entry
  carries no copy of it; it names the entry by id and says in its own
  words what it responds to, git-fashion, and the store resolves
  "referenced by" at read time. Copies are duplicates, and trails fork
  when a copy is itself referenced. (D186, 2026-10-07)
- Declined alternative, Cross-lane supersession that retires the target — a subagent's
  newer note on the orchestrator's chapter is a pointer the owning lane
  sees, never a flag flip on another lane's entry; only a lane's own
  writer retires that lane's pointers. (D169, 2026-10-07)
- Declined alternative, Capture promised on Codex CLI, Gemini CLI, Cursor or VS Code —
  the compatibility matrix documents each client's hook support with the
  date of the documentation checked; a row never claims a test it does
  not have, and capture is promised only where verified live, Claude
  Code alone today. (D153, 2026-10-05)
- Declined alternative, Re-orienting from the project's newest chapter regardless of who
  wrote it — a fresh start anchors on self, recovered from where the
  session runs; a stranger's thread is the confusion self removes.
  (D167, 2026-10-07)
- Declined alternative, Work pausing while the memory is down — nothing treecontext does
  blocks a turn; capture degrades with a gap marker, re-orientation
  falls back to what it can reach, and doctor names the cause. (D175,
  2026-10-07)
- gzip as a second codec, or a compression-floor raise (D103, 2026-08-28)
- retiring the Cursor integration (D104, 2026-08-28)
- push or automatic flow-back between namespaces (D105, 2026-08-28)
- coverage-ratchet sequencing, or a coverage-only release blocker without
  the mutation axis (D106, 2026-08-28)
- a mobile smoke lane, or a fenced mobile option (D107, 2026-08-28)
- a raw p95 latency gate in continuous integration (D108, 2026-08-28)
- unverified hook wiring shipped as capture (D109, 2026-08-28)
- multi-human users of one store (D110, 2026-08-28)
- reserving code-tree seams ahead of a consumer (D111, 2026-08-28)
- a visualizer roadmap inside the release line (D112, 2026-08-28)
- the additive-automatic, destructive-opt-in migration split (D59,
  2026-08-05)
- the count-at-sweep-time content check (D60, 2026-08-06)
- failing the open when the completion comparison fails (D64,
  2026-08-06)
- the pass's accept-the-edge entry letting prune bypass the verdict rule
  (D65, 2026-08-06; permanent per D99, 2026-08-24)
- the sweep auto-reclaiming verified orphans, or doctor-advice-only (D70,
  2026-08-10)
- refusing every unaddressable store name, or keeping to cope downstream
  (D72, 2026-08-11)
- the lockfile model of multi-writer safety (D80, 2026-08-12)
- the pid-first rung order (D95, 2026-08-20)
- the same-namespace second-server refusal (D96, 2026-08-20)
- the attribution program after the tag, drafted into a staged directory
  the runner does not read; or needs and fence only until the tag (D122,
  2026-09-23)
- the repo's prose style with no lint over the record; the docket plus a
  deferred backfill (D123, reversed by D130, 2026-09-28)
- an agent definition declaring its own treecontext server (D124,
  2026-09-23)
- a namespace per subagent (D127, 2026-09-23)
- one combined table for the registry and the access log (D128,
  2026-09-23)
- removing namespaces, or extending them to carry subagent lanes (D129,
  2026-09-23)
- Developer outcome after /clear: the full checkpoint returned unasked;
  a short pointer then a choice; silent re-orientation — the visionary
  reframed to feedback on what re-oriented. (D145, 2026-10-05)
- No-checkpoint path: the agent writes the checkpoint itself; the newest
  entries silently are the checkpoint; re-orient and say so with no
  nudge. (D146, 2026-10-05)
- Orchestrator outcome: a true namespace per subagent rather than a
  separable trail by writer. (D148, D196, 2026-10-07)
- Subagent start: the whole project memory; only the orchestrator's
  brief; its own trail only, widening on request. (D150, 2026-10-05)
- Teammate handoff: summary only, never the trail; summary and trail
  always. (D151, 2026-10-05)
- Other agents: full capture claimed on Codex and VS Code outright;
  tool-only with no matrix. (D153, 2026-10-05)
- Installer: writing hooks for every documented client labeled
  documented-only; Claude Code only with hand-copy instructions. (D154,
  D161, 2026-10-06)
- Auto-checkpoint: manual only, taught by the nudge; neither, raw tail
  only; a fixed unconfigurable interval. (D156, 2026-10-05)
- Default interval: {10} rounds or {30} minutes; rounds only; off by
  default. (D157, 2026-10-05)
- Re-orientation shape: the newest checkpoint of either kind then the
  tail; the chapter plus the tail since the chapter with bookmarks only
  as search anchors. (D159, D187, 2026-10-07)
- Injected budget: a large automatic cap of about {500000} characters; a
  configurable budget with a small default and a large ceiling. (D162,
  2026-10-06)
- Interval extremes: zero refused as invalid with retries on failure;
  any value and any failure silent. (D163, 2026-10-06)
- Same-store import: refused with a message naming the merge tool; copies
  with new ids and back-pointers; summaries only. (D164, 2026-10-07)
- Import provenance: a warning when the file's claims disagree with its
  contents; trusting the file as the sender's. (D165, 2026-10-07)
- Bookmarks in status: all live with status filtering; absent from
  status entirely. (D166, 2026-10-07)
- Fresh start: the newest from a session in the same directory with no
  notion of self; nothing automatic on a fresh start. (D167, 2026-10-07)
- Lane model: cross-lane supersession that retires the target; a
  top-down model where the main lane owns its derivatives. (D169,
  2026-10-07)
- Handoff cap: a soft cap everywhere with a warning; no cap anywhere.
  (D170, 2026-10-07)
- Security: no new behaviour beyond provenance; a store-file privacy
  rule; a subagent barred from whole-journal export. (D177, 2026-10-07)
- Ops burden as separate needs: a no-upgrade-mid-sprint rule; a
  retention-never-asks rule. (N26, D178, 2026-10-07)
- Diagnosability: per-turn capture inquiry; a re-orientation log; a
  per-file import listing. (D179, 2026-10-07)
- Evolvability: no promises at all, the store format included. (D180,
  2026-10-07)
- References: copy-forward; the whole chain returned on every hit.
  (D186, 2026-10-07)
- Binding the re-orientation Then: a recorded live transcript; the Then
  kept on the reply with the gap carried. (D188, 2026-10-07)
- Self for a worktree session: declared by the agent from an injected
  token; both with mismatch disclosure. (D190, 2026-10-07)
- The attribution program: kept whole with the date moving; retired
  with the slice as all that was needed. (D191, 2026-10-07)
- Version: `0.1.0-rc.8` under `next`; `0.1.0-alpha.1`; `0.1.0` final on
  the day. (D192, 2026-10-07)
- Coverage: a no-regression ratchet at the 2026-10-05 figures; D106 kept
  with the beta outside the gate. (D194, 2026-10-07)
- Release split: the visionary marking each item; no split with the date
  moving. (D197, 2026-10-07)
- The nudge cadence: once per session with restarts repeating; once per
  store ever; once per session until a chapter exists. (D198,
  2026-10-07)
- Handoff doors: the tool door only; commands only. (D199, 2026-10-07)
- The design document's home: the root as seed with a pointer beside the
  features; a full copy at both paths. (D200, 2026-10-07)

- Declined alternative, Dropping recovery snapshot rows from search —
  they are the only record of what a compaction found, and D3 keeps every
  capture; Storing the recovery row as an auto-capture tool event —
  changes its dedup class and session lane, more than a hotfix carries;
  and, Shrinking the existing rows' content — retention never destroys,
  and export still returns their words. (D286, 2026-10-30)
- Declined alternative, Shielding an oversized reply — off by default,
  and a 30 MB file pointer is still a 30 MB read; Failing the query
  outright — the agent loses the page for one oversized entry; and,
  Cutting exports — an export that lies about being whole is worse than
  one refused. (D287, 2026-10-30)
- Declined alternative, The main agent writes a cut leg's checkpoint from
  the trail — costs the orchestrator the context the legs exist to keep
  out of it; and, Nobody writes it, the trail is the checkpoint — every
  resumed leg pays the orientation cost on every resume. (D279,
  2026-10-29)
- Declined alternative, Newest checkpoint by time wins silently — a late
  original or an early review hands the next leg the wrong one with no
  sign; and, Only the work's own role may checkpoint — rules out the
  technical-writer, project-manager and reviewer roles the visionary
  named. (D280, 2026-10-29)
- Declined alternative, A per-role checkpointer setting in the project's
  configuration — goes stale when a pipeline changes shape between runs;
  and, The ask always fires and the worker answers with a pointer — a
  turn on every such leg, the ceremony ruled out. (D281, 2026-10-29)
- Declined alternative, One journal-subagents file holding everything —
  largest in the corpus, three actors' outcomes mixed; and, Extending
  journal-orchestration with no new file — triples in size. (D282,
  2026-10-29)
- Declined alternative, The brief names who consumes the summary; a
  harness-owned run the main agent hears only the end of; a leg started
  with no return at all — the one-line pointer comes back every time and
  costs one line. (D285, 2026-10-29)
- Declined alternative, Install recommends the idle-compaction setting
  and asks once interactively — every forced reinstall asks again; and,
  Doctor row and README only, install writes nothing — a user who skips
  the note meets compaction they did not ask for. (D290, 2026-10-30)
- Declined alternative, Write the idle-compaction key anyway and say the
  client is older — install cannot always read the client's version and
  would then write and say nothing. (D304, 2026-10-31)
- Declined alternative, No send-back off the hooks door, the worker
  visibly ended and the next leg a recovery leg — a pipeline with no
  second leg of that role never gets its checkpoint; and, The harness
  passes the checkpoint text at retire under its own stamp — a harness
  has no model, so its checkpoint is the work's own words relabelled.
  (D291, 2026-10-30)
- Declined alternative, Every exit without a checkpoint sent back once,
  signal or not — the timeout is paid twice; and, The spawner says cut or
  finished at retire — a harness that never says cut lands on the double
  timeout. (D292, 2026-10-30)
- Declined alternative, Refusing a ticket whose parent no hook registered
  — the abandoned axis of the unknown-parent question: a one-line harness
  grows a registration step, and the store would be checking an identity
  it has no way to vouch for. (D293, 2026-10-30)
- Declined alternative, A declared-parent registry row written by the
  ticket door and reused by later tickets — the store would write a
  session it never saw, and two mains declaring one id share a row; and,
  Both the row and the per-worker copy — the invented row remains.
  (D294, 2026-10-31)
- Declined alternative, A `claude -p` child carrying both identities with
  the ticket's on top — the first moment spent twice; and, The hook wins
  and the ticket serves hook-less CLIs only — a Codex main's `claude -p`
  workers land unparented in the main lane as "main". (D295, 2026-10-31)
- Declined alternative, Only a named checkpointer's rows count as in
  effect, the stranger's listed apart — a legitimate unnamed
  technical-writer leg waits in the apart list too; and, The writer on the
  row and nothing more — a model-less harness resumes from the poison with
  nothing in the reply saying so. (D296, 2026-10-31)
- Declined alternative, Phantom retirement at the parent's next start or
  next ticket — a parent that never returns leaves the phantom live
  forever; and, Never retired on its own, ages shown and a command to
  retire by hand — every model-less harness picks its own silence
  threshold. (D297, 2026-10-31)
- Declined alternative, A first-moment file named in the ticket's
  environment, read by the CLI's managed instructions file — a user who
  did not let install manage that file gets a worker that starts cold,
  N29 unmet silently; and, Ids in the ticket and one fetch — no record
  that the worker read them. (D298, 2026-10-31)
- Declined alternative, Never cut and no cap, the checkpointer owns the
  size — the chain grows every leg; and, Cut at a cap named in the ticket
  — drops the review the leg was spawned to act on. (D299, 2026-10-31)
- Declined alternative, A run export of every row of every leg always — a
  30-leg run with shell trails is tens of megabytes and every importer
  takes the secrets risk; and, No run form, a run filter on the existing
  forms — the summaries form could not resume a run. (D300, 2026-10-31)
- Declined alternative, Bounds on the run's registration reported when
  crossed — a run opened with no bounds gets the facts anyway, so the
  facts are the floor; and, Convergence as the harness's business alone
  with no facts — the field report's case. (D301, 2026-10-31)
- Declined alternative, A declared checkpoint shape the store checks —
  every brief author writes a schema; and, No grammar anywhere, the
  harness never parses the checkpoint — the checkpoint is where the
  honest "not done" lived. (D302, 2026-10-31)
- Declined alternative, Running on an unreadable ticket as if none were
  present — the rows land in the main lane; Registering with what was
  read and letting the worker work — work done on a guessed brief; The
  spawner refusing to spawn on a ticket it cannot read — damage happens
  between mint and read. (D303, 2026-10-31)
- Declined alternative, Every subagent a leg with a key minted from its
  role — the ceremony spent on every grep; and, Every subagent a leg with
  the send-back only under a key — the main session's leg count mixes
  lookups and work. (D305, 2026-10-31)
- Declined alternative, The cold start for a worker at an unreachable
  store — rows with a writer and a parent but no first moment; and, A
  checkpoint queued by the door until the store returns — a second writer
  path with its own failure modes, and the spawner already holds the
  text. (D307, 2026-10-31)
- Declined alternative, A run listing in the status tool, or a run-lookup
  tool of its own — a ninth tool for what the query reaches once the rows
  carry the run. (D309, 2026-10-31)
- Declined alternative, One store always by rule, or a store per worker
  with the run's store the index — the topology was deferred to the
  design pass and then ruled: a worker writes into the project's store, as
  a worktree session does; a worker elsewhere comes back by the handoff;
  and, Leaving the topology to the build bound by D310 alone — the
  builder would choose and the gate would check the bound. (D310, D323,
  2026-10-31)
- Declined alternative, The inner run's workers joining the outer run as
  its legs — the outer run's facts mix two harnesses' work; and, Nesting
  refused — forecloses the case the visionary named. (D311, 2026-10-31)
- Declined alternative, Nothing beyond the harness's timeout for a stuck
  leg — the agent's lookup could not answer "why is the run slow" without
  the id and the registry table. (D312, 2026-10-31)
- Declined alternative, Cutting the first-moment row at the insert tool's
  cap — the reconstruction loses the pasted tail; and, An uncapped plain
  row — no preview for search to see. (D313, 2026-10-31)
- Declined alternative, A hook on the Agent tool call that denies the
  spawn while the store is unreachable — documented for tool calls
  generally, not for the Agent tool, an inference until tried; and,
  Spending the stop hook's one send-back on delivering the brief — the
  work done twice. (D314, 2026-10-31)
- Declined alternative, The door starting no worker on a stranger's
  checkpoint and returning the flag to the spawner — a harness gate on
  every poisoned key; and, The writer name alone in the first moment — the
  worker trusted to notice what the store already knows. (D315,
  2026-10-31)
- Declined alternative, Sending a door-less worker back once regardless —
  one wasted run per such leg; and, The spawner writing the checkpoint
  from the worker's output — closed by the rule that the main agent never
  writes a leg's checkpoint. (D316, 2026-10-31)
- Declined alternative, The process number alone for liveness, the reuse
  recorded as a known limit — a stranger that inherits the number keeps a
  phantom live until the host reboots. (D317, 2026-10-31)
- Declined alternative, The skeleton carrying each first moment's preview
  only — a reviewer loses the pasted tail; and, Whole with no warning —
  the exporter is not always the spawner. (D318, 2026-10-31)
- Declined alternative, Everything the door writes protected from the
  valve — the growth per worker then bounded by nothing. (D319,
  2026-10-31)
- Declined alternative, A hooks-door key bound only by the leg's own first
  write — a leg that forgot everything leaves no record of having had a
  key; and, The harness's to keep unambiguous — the store records the
  wrong key on both when the practice slips. (D320, 2026-10-31)
- Declined alternative, A binding checkpoint cap, every over-cap write
  refused with the shape asked — a leg that cannot write under it ends
  without a checkpoint, and a legitimate long state has no way in.
  (D321, 2026-10-31)
- Declined alternative, Access control on the store — the store has
  none and gains none here: an agent, harness or process it never
  registered writes through any door and is refused nothing; the control
  is the trace every such row carries (when, where, how, who, what), and
  readers judge validity or filter, never treecontext; "too much" in the
  visionary's words. (D293, 2026-10-30)
- Declined alternative, Treecontext owning the harness's parts — its
  timeout, its brake, its human gate, its convergence rule, its
  checkpoint grammar and its reason for closing a run are the harness's
  to build; treecontext shows the facts (leg count, checkpoints, run age,
  sizes, each live leg's start and last write) and judges none of them.
  (D292, D301, D302, D312, 2026-10-31)

## Sanctioned changes

- **The docket backport** — adds a ruling-id tag to every scenario in
  the thirteen charter feature files, rewrites this fence into the dated
  grammar, and cites rulings on every ledger row; it changes no scenario
  text and no verdict. Bound scenarios touched: none. (D130, 2026-09-28)
- **The handshake may say "checkpoint"** — journal-agent-surface "the
  lexical backend never advertises machinery it lacks": the step "no
  checkpoint or summarize instruction appears" rewords to "no tree-era
  checkpoint or summarize machinery is named" (direction: rewords), so
  the agent-written checkpoint of D158 may be taught (D174) while the
  tree-era machinery stays unnamed; the binding narrows to the tree-era
  tool names and checks every tool the handshake names is one the live
  server registers. Bound scenarios touched: that one. (D215 amends
  D14, 2026-10-08)
- **The hackathon re-cut** — adds four feature files
  (journal-reorientation, journal-orchestration, journal-handoff,
  journal-clients) and, in two bound files, new scenarios beside the
  existing ones. Bound scenarios touched: none reworded. Scenarios added
  to bound files: journal-agent-surface "the instructions teach the
  checkpoint protocol", "the instructions tell the agent to show the
  packet first after a clear", "the instructions tell the agent to
  suggest a clear after a chapter summary", "the instructions name
  doctor as the first move when something looks wrong", "the handshake
  stays a card and the long form lives in the skill reference"
  (direction: adds; D174, D188, D173, D179, D210); journal-capture "a stop that asks for a
  bookmark still captures the response" (direction: adds; D156). The new
  scenarios enter the suite through the wip register until bound.
  Revised 2026-10-08: the six named scenarios are bound; none remains
  in the wip register. (D174, D188, D173, D179, D210, D156, D197,
  2026-10-08)
- **A whole export is chosen, not defaulted** — journal-library "the
  whole journal exports through the tool surface": the step "export is
  called with no node id" rewords to "export is called with no node id
  and the whole journal chosen, its secrets warning acknowledged"; and
  design output-shielding "an oversize export is shielded the same way":
  the step "the journal is exported" rewords to "the whole journal is
  exported, its secrets warning acknowledged" (direction: rewords). The
  default export without a node id is the summaries-only handoff (D177,
  ratified by chain D214), so a whole export is a deliberate choice made
  behind the secrets warning; the bindings choose the whole form and
  acknowledge the warning, as the new words say. Bound scenarios touched:
  those two, titles unchanged. (D229, 2026-10-08)

- **Sanctioned change, 2026-10-11.** journal-install, three @D51
  scenarios reworded with the driver switch (direction: rewords, one
  retitles). "the interpreter install chooses can actually run this
  package": the premise "only one of which can load the native database
  binding" becomes "only one of which meets the Node floor and runs this
  package", and its two Then steps say "runs this package" and "cannot
  run it" for "loads the binding" and "cannot load it". "an interpreter
  that cannot load the binding is reported, not tolerated" retitles to
  "an interpreter that cannot run this package is reported, not
  tolerated", its premise reworded the same way. "doctor proves health
  rather than inferring it": the step "the native database binding is
  verified by opening a database, not by comparing versions" becomes
  "the database is verified by opening one and reading its SQLite
  version and FTS5 support, not by comparing versions". The claims —
  install picks an interpreter that can run the package, doctor reports
  one that cannot, doctor proves by doing — are unchanged; what an
  interpreter must be able to do changed from loading a binding to
  carrying a `node:sqlite` at the floor. Two @D278 doctor scenarios and
  one @D278 storage scenario are additions, not changes. (D278,
  2026-10-11)
- **Sanctioned change, 2026-10-08.** journal-capture "a server
  abandoned by its client shuts down instead of spinning": the step "the
  server's next diagnostic write lands on the dead stream" rewords to
  "the server's next warning lands on the dead stream" (direction:
  rewords). Under D258 a serving server writes its diagnostics to the
  log file only, so no diagnostic write can meet the dead stream; the
  write that can is a genuine warning, which the binding provokes with a
  real malformed staged event the drain dead-letters. The claim, a dead
  peer earns a swallowed write or a shutdown and never a storm, is
  unchanged. Bound scenarios touched: that one, title unchanged. (D258,
  2026-10-08)

- **The beta.3 subagent corpus** — adds three feature files
  (journal-legs, journal-workers, journal-runs) and scenarios to
  journal-install, journal-reorientation and journal-storage; changes no
  existing scenario text and no verdict. Bound scenarios touched: none.
  (D282, 2026-10-29)

---

## History of this file

The charter fence was consolidated with the migration-backup fence on
2026-08-25, both transplanted verbatim, when the corpus moved to
`features/`. The backup fence recorded an interview of 2026-08-06
(ratified at the visionary cold-read the same day with three
corrections, the third overruling the pass on prune), and amendments on
2026-08-10 (the success-verdict orphan), 2026-08-11 (the second-pass
review, "fix all eleven"), 2026-08-12 (two deferrals pulled into the
first release at the charter cold-read), 2026-08-14 (the exit-status and
advice contracts bound), and 2026-08-15 (user backups and the listing
cells). Every ruled behavior those amendments recorded is now a docket
entry (D60 to D89) with the scenarios that bind it in
`features/design/`; only the declined, deferred, and assumed items stay
on the fence. The release-engineering deferral of 2026-07-27 was
discharged on 2026-08-24, overtaken by events (D46, D100).
The beta.3 subagent interview (2026-10-29 to 2026-10-31, D279 to D323)
added one Declined entry, one Named assumption, two Out-of-reach
entries, thirty-nine Roads not taken (two of them the beta.2.1
hotfix's, D286 and D287; two moved from Out of reach at the post-draft
pass, D293 and the harness's parts), one Sanctioned change, and amended
the compaction entry in place for the idle-compaction key (D290, D304),
written 2026-10-31.
