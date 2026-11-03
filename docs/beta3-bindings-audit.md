# beta.3 bindings audit

Unit 9 of the beta.3 build, 2026-11-01, over units 1 to 8 (HEAD 572cf9c
plus this unit's changes). Point-in-time: counts, states and pointers,
no verdicts. The scope is every scenario tagged with a ruling D279–D361
in `features/*.feature`: 123 scenarios (outlines counted once).

How each row was read: the step bodies a scenario's lines match, and the
helpers they call, in `tests/journal/steps/` and the harness modules
beside them. Not read: the build's journal (unavailable to this unit); the
review notes are taken from the commit messages
(`git log 3220211..HEAD`), the CHANGELOG bullets, the register comments in
`tests/journal/features.test.ts` and `tests/journal/wip-register.ts`, and
the probe-named unit tests (`tests/ticket-door.test.ts`,
`tests/checkpoint-cap.test.ts`).

## Vocabulary

**Door** is the door the scenario's act (its When) goes through; a Given
through another door is named after a semicolon.

- `hook` — a real hook subprocess (`src/hooks/*.ts`) with the platform's
  payload: SubagentStart, SubagentStop, SessionStart, PostToolUse, Stop,
  UserPromptSubmit.
- `ticket door` — the real ticket door: the library's `spawnWorker`, or
  the `treecontext run` wrapper as a subprocess, launching a stand-in
  process (`tests/helpers/standin-worker.ts`, or
  `tests/helpers/standin-claude-p.ts`, which fires the real hooks).
- `tool+echo` — a real MCP tool call with its PostToolUse echo hook;
  `tool` — a real MCP tool call with no echo. (The MCP server runs
  in-process over an in-memory transport, on the scenario's store.)
- `cli` — the real `treecontext` CLI as a subprocess under a redirected home.
- `library` — a `FlatStore` or library call in the test process.

**Then's evidence:** `file` (the SQLite file through a separate read-only
handle), `hook-out` (a hook's stdout), `cli-out` (a CLI's stdout, stderr
or exit code, or the ticket door's one line), `tool-reply`, `return` (a
library return value from the scenario's own store handle), `fs` (another
file on disk: settings, archive, export file, beacon), `stand-in-log`
(what a stand-in process recorded it was given).

**Rung** (gherkin-node-test's failure ladder): `absent` (no binding),
`narrowed` (a Then asserts less than the words), `stand-in-for-door` (the
binding performs itself an act the words give a door), `half-lit` (a
promise across producers or doors bound through one). `—` is none found.

## Totals

| feature | scenarios | open | act door | Then's evidence (scenarios reading it) | rungs |
| ------- | --------- | ---- | -------- | --------------------------------------- | ----- |
| journal-legs | 46 | 0 | hook 27; hook with tool+echo 5; tool+echo 7; tool 2; library 4; library with hook 1 | file 43; hook-out 28; return 18; tool-reply 8 | narrowed 1 |
| journal-workers | 39 | 1 outline row | ticket door 24; ticket door with hooks 3; hooks alone (`claude -p`, no wrapper) 1; ticket claimed with no door 1; library 8; per-row mixed 2 | file 39; stand-in-log 25; return 16; cli-out 12; fs 3; tool-reply 2 | stand-in-for-door 3 (lines 44, 184, 192); half-lit 2 (lines 64, 76) |
| journal-runs | 24 | 0 | library 15; tool 7; tool+echo 1; cli 1 | file 23; return 12; tool-reply 8; fs (export file) 3; cli-out 1 | — |
| journal-install | 7 | 1 | cli 5; README read 1; none 1 | fs 5; cli-out 5 | absent 1 |
| journal-capture | 1 | 0 | library 1 | file 1 | — |
| journal-recall | 3 | 0 | library 2; tool 1 | return 3; file 2; tool-reply 1 | — |
| journal-reorientation | 1 | 0 | hook 1 | hook-out 1; file 1 | — |
| journal-storage | 2 | 0 | library (the sweep) 2, Givens through the ticket door | file and fs at the archive's fsync 2; file after 2; return 2 | — |
| **all** | **123** | **2** | | file 111 of 123 | absent 1; narrowed 1; stand-in-for-door 3; half-lit 2 |

Unit 9's own changes to the bindings are marked "(unit 9)" in the rows.

## Per feature

### journal-legs.feature (48 scenarios after unit 11, two outlines of 4 rows; 0 open)

Every leg here is registered by the real SubagentStart hook (`hooksLeg`/`hooksSubagent`), writes through the real insert tool with its PostToolUse echo (`insertEchoed`), and stops through the real SubagentStop hook; earlier checkpoints and briefs are library writes by a declared role.

| line | scenario | door (act; Given if different) | Then's evidence | rung | note |
| ---- | -------- | ------------------------------ | --------------- | ---- | ---- |
| 22 | a leg's first moment is its brief and the checkpoint in effect, with no query made | hook SubagentStart; Given library | hook-out + file | — | "no query made" is read as no `treecontext_query` row staged; no model is in the loop to make one |
| 29 | a fresh leg on a key with no checkpoint is told so, and its first checkpoint is number 1 | hook SubagentStart, then tool+echo + SubagentStop | hook-out + return + file | — | |
| 37 | the checkpoint a leg writes at its end takes the next number and supersedes the one it started from | tool+echo + hook SubagentStop | hook-out + return + file | — | |
| 46 | a leg that finishes with no checkpoint is sent back once with the missing checkpoint named | hook PostToolUse ×40 + SubagentStop | hook-out + file | — | the key is made the leg's own by a tool write first (D326) |
| 53 | a leg sent back once that then writes its checkpoint stops unblocked | tool+echo + hook SubagentStop | hook-out + return + file | — | |
| 60 | a leg sent back once is never sent back a second time | hook SubagentStop (unmarked), then SubagentStart | hook-out + return + file | — | the platform-marked second stop is line 339's |
| 68 | no send-back when the store cannot be written | hook SubagentStop on a read-only file | hook-out + file | — | |
| 76 | a cut leg leaves its trail and the next leg of its role starts as a recovery leg | hook SubagentStart; Given SessionStart (resume) notices the cut | hook-out | — | the cut is the platform's (a session restart), no process is killed; the line is built with `recoveryLine` |
| 82 | a recovery leg writes the checkpoint its predecessor did not | tool+echo + hook SubagentStop | return + file | — | |
| 88 | a cut leg leaves no checkpoint the store wrote | library drain + `lookupKey`; Given hooks | return + file | — | |
| 95 | a checkpoint the main agent writes under a leg's key comes back flagged, never withheld | tool+echo (no agent fields) | return + file | — | "the same reply" is `keyLookupReply` over the library lookup |
| 102 | a reviewer's original-plus-review supersedes the original and the lookup returns it | library `writeCheckpoint` (declared reviewer) | return + file + tool-reply | — | no reviewer leg is registered |
| 109 | two checkpoints in effect under one key come back as two, never a silent pick | library `lookupKey`; Given library | return + file | — | |
| 116 | every checkpoint names what it supersedes and what it rests on, so a reader can walk back to the trail | tool `treecontext_export`; Given library (trail rows inserted as auto-capture) | tool-reply | — | no file read; the trail rows are library inserts, not hook captures |
| 122 | the brief names who checkpointed the work resumed and who will checkpoint at the end | hook SubagentStart | hook-out + file | — | |
| 128 | a leg whose brief names another role as checkpointer is never sent back | hook SubagentStop | hook-out + return + file | — | |
| 135 | the pointer to a leg's summary row carries the leg's role, run and key | hook SubagentStop + PostToolUse (Agent) | hook-out + file | — | |
| 141 | the pointer comes back every time and the next leg starts from the store whether or not it was followed | hook SubagentStart | hook-out + file | — | |
| 148 | a checkpoint of `<chars>` characters is `<verdict>` on its first write and `<verdict2>` on the second (4 rows) | tool+echo ×2 | tool-reply + file | — | all four rows; a caller's own `_over_cap` is not in the words (M6) |
| 162 | a second over-cap write by another leg or under another key is refused again | tool+echo ×3 | tool-reply + file | — | |
| 169 | a leg refused once that stops without writing a shorter checkpoint is sent back for it | hook SubagentStop | hook-out + file | — | |
| 175 | an over-cap checkpoint accepted on its second write is the one in effect, and the next leg's first-moment row shows what it cost | library `lookupKey` + hook SubagentStart | return + file + hook-out | — | |
| 182 | a subagent with no brief or no key is registered and summarised exactly as today | hook SubagentStop + PostToolUse (Agent) | file + tool-reply + hook-out | — | the Agent return fires and its stdout is asserted empty: no pointer for a plain subagent (unit 4's D305 note, verified) |
| 190 | a subagent whose brief names a run and a key gets the leg contract | hook SubagentStart | file + return | — | |
| 197 | the hooks door takes a leg's key from its role's newest brief and marks it inferred | hook SubagentStart | file | — | |
| 203 | an inferred key gives way to the key the leg first writes under | tool+echo + drain | file | — | |
| 209 | two briefs in effect for one role make the key ambiguous and name the candidates | hook SubagentStart | file + hook-out | — | |
| 215 | the leg's first write under a key settles an ambiguous registration | tool+echo + drain | file | — | |
| 221 | a leg that writes under no key stays keyless, stops unblocked, and the run's facts count it as such | hook SubagentStop + drain; Given adds a keyed control worker through the library (`workerLeg`, `writeCheckpoint`, retired by `retiredWithoutReturn`) | hook-out + return + file | — | the control leg is the binding's, not the scenario's: it proves "keyless" is told from a keyed ended leg |
| 228 | a leg through the hooks door starts cold when the store is unreachable, and the gap is marked | hook SubagentStart against a store a locker process holds | hook-out + file | — | |
| 236 | a first moment of `<chars>` characters through the hooks door is `<injected>` (4 rows) | hook SubagentStart | hook-out + file | narrowed | the whole rows' "with no query made" is read only as the cut marker's absence (line 22 reads it from the staging table); sizes are made with the source's own composer |
| 251 | a leg fetches the rest of a cut checkpoint by export and gets it whole | tool `treecontext_export` | tool-reply + file | — | |
| 257 | an inferred key never makes the stop ask for a checkpoint | hook SubagentStop | hook-out + return + file | — | |
| 265 | a key the leg wrote under, marked as its own, makes the stop ask for the missing checkpoint | hook SubagentStop | hook-out + file | — | |
| 272 | a newer brief for the same role and key supersedes the older one | hook SubagentStart | file + hook-out + tool-reply | — | |
| 279 | a run's close ends its briefs | hook SubagentStart; Given library `closeRun` | file | — | |
| 286 | a leg left live is retired as cut when its session next starts, and the next leg of its role recovers | hook SessionStart (resume) | file + hook-out | — | |
| 293 | until its session restarts, a silent leg reads as live with its ages shown | library `lookupKey`; Given hook SubagentStart (clocked) + library inserts as the leg | return + file | — | the leg's rows are library inserts with its ref |
| 299 | two legs that started from one checkpoint write 4 and 5, never two 4s, and both stay in effect | tool+echo ×2 + hook SubagentStop ×2 | file + return | — | |
| 306 | a leg starting while two checkpoints are in effect is handed both, flagged | hook SubagentStart | hook-out + file | — | |
| 313 | the pointer rides on the Agent tool's result and the subagent's final message is untouched | hook PostToolUse (Agent) | hook-out + file | — | also pins the background launch carrying none |
| 320 | a checkpoint that names nothing as superseded is stamped from the leg's start, marked as the store's | tool+echo + drain | tool-reply + return + file | — | |
| 327 | a checkpoint that names another checkpoint is taken at its word | tool+echo + drain | return + file | — | |
| 333 | every first moment says in treecontext's own words that a checkpoint is state, not history | hook SubagentStart | hook-out | — | (unit 9) the three things the line says are asserted in the emitted context, not only as the source constant; journal-workers line 300 is the ticket door's half |
| 339 | a leg that ended without a checkpoint after its one send-back is followed by a recovery leg | hook SubagentStart; Given SubagentStop ×2 (the second marked as the platform marks it) | hook-out + file | — | |
| 345 | a leg whose start was dropped stops unasked and its summary still lands | hook SubagentStop; Given SubagentStart against a locked store | hook-out + file | — | |

### journal-workers.feature (42 scenarios after unit 11; 1 outline row open, the Antigravity parent)

A worker here is a stand-in process launched through the real door (the feature's own words): the library's `spawnWorker` or the `treecontext run` wrapper launching `standin-worker` (the hook-less CLI's model) or `standin-claude-p` (Claude Code's headless client firing the real hooks). The CLI a row names (`codex exec`, `agy -p`, `claude -p`) selects the stand-in only where a step names a hook or a `claude -p` child.

| line | scenario | door (act; Given if different) | Then's evidence | rung | note |
| ---- | -------- | ------------------------------ | --------------- | ---- | ---- |
| 23 | a `<worker>` worker under a `<parent>` parent writes into its own lane with its role as writer (3 rows) | ticket door (`spawnWorker`, standin-worker writing through a real `treecontext serve`); Given parent by a real SessionStart hook (Claude Code) or the installed Codex hooks.json command | file | — | rows Claude Code and Codex bind; the Antigravity row is open (no Antigravity hook adapter exists); every row's worker is standin-worker |
| 37 | a worker is retired at exit and its last output is the summary row the pointer names | ticket door (`treecontext run`, standin-worker) | cli-out + file | — | |
| 44 | a worker's registration carries every field its ticket declared and the facts the door read | library `registerWorker` with a declared host, pid and start | file | stand-in-for-door | the ticket door is not run; the facts "the door read" are handed in (now `registerThroughLibrary`) |
| 50 | the ticket door composes a worker's first message from the brief, the checkpoint in effect and the spawner's prompt | ticket door (`spawnWorker`, standin-worker) | stand-in-log + file + return | — | "no query" is a counter on the in-process store's `query` |
| 57 | a first moment with no checkpoint in effect is the brief and the prompt | ticket door (`spawnWorker`) | stand-in-log + file | — | |
| 64 | the first-moment row is the first row of the worker's lane through the `<door>` (2 rows) | ticket door (`treecontext run`) with standin-worker, and with standin-claude-p firing the real hooks | file + stand-in-log | half-lit | the `claude -p` row names the child's session-start hook as the door, but that hook writes no first-moment row: the wrapper writes it before the child starts, and the hook links the lane. The named door's promise is unbound (and the scenario's wording is an owner item) |
| 76 | a hook-less worker and a `claude -p` child leave the same first-moment row, readable with plain SQL alone | ticket door ×2 (`treecontext run`: standin-worker, then standin-claude-p) | file (read-only handle) + stand-in-log + return (recomposition) | half-lit | as 64: both rows are the wrapper's; the `claude -p` child's session-start hook, the door the scenario's other half names, writes none (an owner item on the wording) |
| 83 | an empty spawner prompt still leaves the first-moment row | ticket door (`treecontext run`) | file + stand-in-log | — | |
| 89 | a first-moment row keeps a pasted prompt whole behind a bounded preview | ticket door (`treecontext run`, 300,000 characters) | file + stand-in-log + tool-reply | — | |
| 97 | a stranger's checkpoint reaches the worker's first moment flagged in words | ticket door (`spawnWorker`) | stand-in-log + file + return | — | |
| 106 | a hook-less worker that finishes without a checkpoint is run once more by the `<spawner>` that started it (2 rows) | ticket door (`treecontext run`; `spawnWorker`) | stand-in-log + file + spawner line | — | both rows |
| 118 | the wrapper never runs a worker a third time | ticket door (`treecontext run`) | stand-in-log + file + return | — | |
| 125 | a worker that claimed a ticket with no wrapper gets no send-back and ends visibly without a checkpoint | standin-worker run with its ticket and no wrapper (`claimTicket`) | return + stand-in-log + file | — | the leg ends `phantom`, noticed by the lookup: "ends visibly" |
| 132 | a worker whose ticket names another role as checkpointer is never sent back | ticket door (`treecontext run`) | stand-in-log + file | — | |
| 139 | a worker whose ticket declares no door gets no send-back | ticket door (`treecontext run --no-door`) | cli-out + file + stand-in-log + return | — | |
| 147 | an exit by signal is a cut, never sent back, and the next leg of the role is a recovery leg | ticket door (`treecontext run --timeout`) | file + cli-out + return + stand-in-log | — | the signal is the wrapper's own timeout |
| 156 | a worker that exits on its own error is finished and gets the one send-back | ticket door (`treecontext run`, exit 1) | stand-in-log + file + cli-out | — | |
| 162 | a `claude -p` child with a ticket is registered as a worker by the hook, never as a self | hook (standin-claude-p with its ticket, no wrapper, firing SessionStart, UserPromptSubmit, PostToolUse, Stop) | file + stand-in-log + fs (beacon) | — | |
| 170 | the stop hook's send-back is the leg's one, and the wrapper starts no run after it | ticket door (`treecontext run`) + hook Stop (standin-claude-p) | stand-in-log + file + cli-out | — | |
| 177 | when the stop hook could not ask, the wrapper's send-back is the leg's one | ticket door + hook Stop on a read-only file | stand-in-log + file + cli-out | — | |
| 184 | a parent no hook registered is carried on each worker's registration as declared, never as a row of its own | library `registerWorker` ×2 + `insert` as the leg | file + return | stand-in-for-door | the workers' start is a library registration (now `registerThroughLibrary`) |
| 192 | a parent a hook did register is linked by id, never copied | library `registerWorker`; Given parent by a real SessionStart hook | file | stand-in-for-door | as 184 |
| 199 | an unregistered writer's row through the `<door>` is accepted and traced, never refused (2 rows) | library `insert` (declared writer); standin-worker with a self-minted ticket (`claimTicket`) | file | — | both rows |
| 210 | a gone worker nobody retired is retired as a phantom by the next `<reader>` on its host (3 rows) | library `lookupKey`; tool `treecontext_status`; hook SessionStart (resume); Given library `registerWorker` with a real killed process | file + tool-reply | — | the gone worker is registered through the library (`registerThroughLibrary`) with a real pid and start |
| 223 | a worker on another host is left live and the reply says it cannot be checked from here | library `lookupKey`; Given library `registerWorker` (host build-02) | file + return | — | |
| 230 | a reused process number is told from the worker by the process's start moment | library `lookupKey`; Given library `registerWorker` with a live process's pid and another start | file | — | |
| 237 | a live worker with its own start moment stays live | library `lookupKey`; Given as 230 | file + return | — | |
| 244 | a host whose process start moment cannot be read leaves the number alone, and the reply says so | library `lookupKey`; Given registration with no start moment | file + return | — | the host probe itself is not made blind; the registration carries none |
| 252 | a worker whose ticket is `<damage>` is registered with what was read, told its instructions were invalid, and ends visibly through the `<door>` (4 rows) | ticket door (`treecontext run`, standin-worker); hook (standin-claude-p, no wrapper) | file + stand-in-log + spawner line | — | all four rows; for the hook rows the "line" is the Stop hook's systemMessage |
| 269 | the ticket door that sees the fault before spawning writes the row itself and spawns nothing | ticket door (`spawnWorker` with `checkTicket`) | file + return + fs | — | `treecontext run --check-ticket` is bound in tests/ticket-door.test.ts, not here |
| 276 | a worker is not started while the store cannot be read, and the spawner is told | ticket door (`treecontext run`) under a locker process | cli-out + fs + file | — | |
| 284 | a checkpoint the store cannot take at exit is lost from the store, not from the spawner | ticket door (`treecontext run`) under a write-locker | cli-out + stand-in-log + file + return | — | |
| 293 | a worker's first message carries both checkpoints when two are in effect | ticket door (`spawnWorker`) | stand-in-log + file | — | |
| 300 | the ticket door's first message says in treecontext's own words that a checkpoint is state, not history | ticket door (`spawnWorker`) | stand-in-log + file | — | |
| 306 | a worker's re-run for its missing checkpoint is the same leg in the same lane | ticket door (`treecontext run`) | file + stand-in-log + return | — | |
| 314 | a ticket that says nothing about the door is read as declaring one | ticket door (`treecontext run`) | stand-in-log + file + cli-out | — | |
| 320 | a ticket that says in words the worker has no key starts a one-off worker | ticket door (`treecontext run --no-key`) | file + stand-in-log + return | — | |
| 328 | a ticket whose key is merely blank is damage | ticket door (`treecontext run`) | stand-in-log + file | — | |
| 335 | a worker whose ticket still named its run is listed under that run; one that named neither is reachable only by its exit line and parent | library `lookupKey`; Given ticket door (`spawnWorker` ×2) | return + file + spawner line | — | |

### journal-runs.feature (30 scenarios after unit 11; 0 open)

| line | scenario | door (act; Given if different) | Then's evidence | rung | note |
| ---- | -------- | ------------------------------ | --------------- | ---- | ---- |
| 21 | the harness asks by run and key with no model and receives the one checkpoint in effect | library `lookupKey`; Given library (`workerLeg`, `writeCheckpoint`, `retireLeg` in `finishedWorker`) | return (in-process store) + file | — | the legs' exit is a library `retireLeg` (now `retiredWithoutReturn`, standins.ts) |
| 30 | a key that holds no checkpoint yet comes back as an honest nothing | library `lookupKey`; Given library | return | — | |
| 38 | a run's rows read back by plain SQL in the order of their own moments, each naming its writer and moment, each leg naming its run and key | library: `RUN_ROWS_SQL` on a read-only handle; Given hook (SubagentStart, PostToolUse) + library worker | file | — | two doors in one run (hooks-door builder, library-door reviewer); the late drain is made by editing the staged row's timestamp |
| 47 | a stranger's checkpoint comes back as the one in effect, flagged against the named checkpointer | library `lookupKey`; Given library (declared writer) | return + file | — | |
| 55 | a checkpoint by the named checkpointer comes back with no flag | library `lookupKey` | return + file | — | |
| 63 | every key lookup carries the run's facts beside the checkpoint | library `lookupKey`; Given library (7 `workerLeg`, `retireLeg`) | return + file | — | retirements through `retiredWithoutReturn` |
| 69 | the run's facts show each live leg's start and last write | library `lookupKey`; Given library | return + file | — | |
| 76 | a run opens on its first leg's registration | library `registerWorker` (`workerLeg`) | file | — | the library door is the act; the scenario names no door |
| 82 | a harness may open a run explicitly before any leg | library `openRun` | file | — | |
| 88 | the harness closes a run with a reason and plain SQL shows who ended it and why | library `harnessRetiresLeg` + `closeRun` (the harness's own door, as the words say) | file | — | |
| 95 | an agent finds a run by time with no id in hand | tool `treecontext_query` (no echo); Given ticket door (`spawnWorker`, standin-worker ×5) | tool-reply + file | — | |
| 102 | an agent finds a run by its name | tool `treecontext_query`; Given library | tool-reply + file | — | |
| 108 | a run's open and close are journal rows the query reaches | tool `treecontext_query`; Given library `openRun`/`closeRun` | tool-reply + file | — | |
| 115 | a leg that ran on another machine comes back into the run by the handoff, and its claim is believed, flagged | tool export + import across two stores; Given ticket door (`spawnWorker`) on both machines | return + tool-reply + file | — | ticket-door legs only on both sides (unit 2's carried note; see the mutation list) |
| 124 | a leg opens a run of its own and both runs reach each other | library walk on a read-only handle; Given library (`workerLeg` ×3, `openRun` with the leg) | file + return | — | no process stands as the reviewer: the inner run's open and its workers are library acts |
| 133 | nesting is not limited to one level | library walk; Given library | file | — | as 124 |
| 140 | a run's default export is its skeleton, with no captured tool output | tool `treecontext_export`; Given hook (SubagentStart, PostToolUse, SubagentStop) + tool+echo checkpoints, and (unit 9) a `claude -p` worker through the wrapper sent back once by its Stop hook | tool-reply + export file compared with file | — | (unit 9) the reviewer is a ticket-door worker sent back once, so the store holds a send-back row of the run; the exact kind set sits under the Then that enumerates what the file holds, citing D360, which lists the skeleton's rows (the scenario is tagged @D300 only: adding @D360 is an owner item). The door-lines note is not asserted: no ruling names it |
| 148 | the whole form adds every row of every leg behind the secrets acknowledgement | cli `export --run --whole` twice (without, then with `--yes`); Given as 140 | cli-out + export file + file | — | the gate is exercised at the CLI door only ("a harness" exports; the tool's gate is the agent's door, M3); (unit 9) the calls are held per lane, the worker's in its own lane, and the send-back row is carried |
| 155 | the skeleton carries first moments whole and its reply says they are the spawners' prompts as written | tool `treecontext_export`; Given ticket door (`treecontext run`, standin-worker, 300,000-character prompt) | tool-reply + export file + file | — | ticket door only; the reply's exact key set is pinned |
| 163 | the lookup reply carries the pointer to the return of the leg that wrote the checkpoint | library `lookupKey`; Given hook (SubagentStart, SubagentStop) + tool+echo | return + file | — | |
| 169 | a leg that left no return is said so, never guessed | library `lookupKey`; Given library worker, its cut a library `retireLeg(…, 'cut')` (now `cutByTimeout`) | return + file | — | library-seeded history (the cut is `cutByTimeout`), as lines 21, 63, 181 and 187 seed theirs; journal-workers line 147 binds the real signal |
| 175 | an agent gets the same lookup reply as the harness through the tools | tool `treecontext_query` (key_lookup); Given library worker retired with its summary by `retireWorker` | tool-reply compared with return + file | — | library-seeded history (the return is `exitedWithSummary`), as lines 21, 63, 181 and 187 seed theirs |
| 181 | an agent closes a run through the tools and the record is the same as the harness's | tool+echo `treecontext_insert` run-close; Given library (legs retired by `retiredWithoutReturn`) | tool-reply + file | — | "the same as the harness's" is pinned field by field on the close row, not by a second close |
| 187 | a key with `<count>` checkpoints returns the sizes of the last `<shown>` (4 rows) | library `lookupKey`; Given library | return + file | — | all four rows |

### journal-install.feature (9 beta.3 scenarios after the final gate's split and unit 11; 0 open)

| line | scenario | door | Then's evidence | rung | note |
| ---- | -------- | ---- | --------------- | ---- | ---- |
| 336 | install turns Claude Code's idle compaction off when the setting is absent, and says so | cli `install --yes` in a redirected home with a fake `claude` | fs (settings.json) + cli-out | — | |
| 343 | install never writes the idle-compaction key the user set to `<value>` (2 rows) | cli `install --yes` | fs + cli-out | — | both rows |
| 355 | doctor warns while idle compaction is on, naming the /config row first | cli `doctor` | cli-out | — | |
| 361 | the README's install section says idle compaction is turned off and why | none (README read) | fs (README.md) | — | |
| 366 | a Claude Code whose version `<version>` gets the idle-compaction key `<written>` and doctor says `<row>` (4 rows) | cli `install --yes`, then `doctor` | fs + cli-out | — | all four rows |
| 381 | a client that honors the key but has no /config row is told the settings line alone (the owner's split, D367) | cli `install --yes` with a fake `claude` at 2.1.295 | fs (settings.json) + cli-out | — | was open: its install clause asked for a line D361 forbids; split at the final gate 2026-11-01 |
| 388 | doctor warns with the settings line alone where the client has no /config row (the owner's split, D367) | cli `doctor` | cli-out | — | the other half |
| 388 | install writes the key on a later run once the client is upgraded | cli `install --yes` twice, the fake client upgraded between | fs + cli-out | — | |

No beta.3 install scenario touches an unreadable settings file. The older corrupt-config scenario (line 68, D51) bound `~/.claude.json` only through unit 8; (unit 9) its Given now makes both of the reference agent's config files unparseable, `~/.claude.json` and `~/.claude/settings.json`, and both Thens are held for each. A cleaner binding would corrupt each file in its own run, keeping the Given singular; not required, carried forward.

### journal-capture.feature (1 beta.3 scenario)

| line | scenario | door | Then's evidence | rung | note |
| ---- | -------- | ---- | --------------- | ---- | ---- |
| 193 | a recovery snapshot quotes the journal at its preview and never quotes a snapshot | library `insertStaging` (role snapshot) + the production drain in-process | file | — | the staged snapshot is the binding's; the session-start hook that stages it in production does not run. Bound before unit 1 (D286) |

### journal-recall.feature (3 beta.3 scenarios)

| line | scenario | door | Then's evidence | rung | note |
| ---- | -------- | ---- | --------------- | ---- | ---- |
| 160 | a hit on a recovery snapshot is a bounded preview, like a tool event's | library `query`; Given library staging + drain | return + file | — | bound before unit 1 (D286) |
| 174 | recovery snapshots a store already holds are bounded when this treecontext opens it | library reopen (migration 030); Given an unbounded row and a rewound `user_version` | file + return | — | bound before unit 1 (D286) |
| 184 | a query reply never approaches the transport's message limit | tool `treecontext_query`, `treecontext_export` | tool-reply + return | — | bound before unit 1 (D287) |

### journal-reorientation.feature (1 beta.3 scenario)

| line | scenario | door | Then's evidence | rung | note |
| ---- | -------- | ---- | --------------- | ---- | ---- |
| 243 | a `claude -p` child with a ticket opens on its brief and checkpoint, never on a self's packet | hook SessionStart (`clear`) with a ticket in its environment; Given hooks, tool and library | hook-out + file | — | the hook is fired directly as the platform fires it; no stand-in process |

### journal-storage.feature (3 beta.3 scenarios after unit 11)

| line | scenario | door | Then's evidence | rung | note |
| ---- | -------- | ---- | --------------- | ---- | ---- |
| 364 | a worker's first-moment row evicts with its session under the session cap, and its checkpoints and summary row stay | library `retentionSweep`; Given ticket door (`treecontext run`, standin-claude-p firing the real hooks) | file and fs at the archive's fsync (read-only handle) + file after + return | — | |
| 371 | over the byte budget a worker's first-moment row is demoted like captured tool output, archived first | library `retentionSweep`; Given ticket door (`treecontext run`, standin-worker) + a real UserPromptSubmit capture | file and fs at the archive's fsync + file after + return | — | |

## The review mutations the charter did not catch, and where each stands

Each unit's reviewer probed its bindings by mutation and carried forward,
as notes, the mutations no scenario's words covered. Below, each is listed
with its disposition at this tree:

- **lit now**: a binding was strengthened inside its scenario's words and
  the mutation, run in a copy of the tree, turns that scenario red. It was
  green against the same scenario at 572cf9c.
- **needs a scenario**: no scenario's words reach the mutation (every such row was
  bound in unit 11 at the final gate and now reads `lit (unit 11, the final gate)`). The
  one-line scenario the owner would need is given.
- **lit at the charter**: a scenario as it already stands turns red on
  the mutation at this tree (the review's note predates that binding).
- **cannot be lit within the words**: the mutation changes nothing a
  charter reader could observe, or only internals an owner-language
  scenario would not name.

"Held outside the charter" names the unit test that catches it today, when
one exists.

| unit | mutation (as the review named it) | disposition | evidence or the scenario needed |
| ---- | --------------------------------- | ----------- | -------------------------------- |
| 2 | the whole form bound through hooks-door legs only | **lit now** | journal-runs "the whole form adds every row of every leg behind the secrets acknowledgement": its Given's reviewer is a `claude -p` worker through the wrapper. Mutant: the run's rows (`RUN_ROWS_SQL`) reach no worker lane (`AND COALESCE(r.kind, '') != 'worker'` on the registry join). Red at the Then "the file holds the 120 tool calls under each leg's lane" (100 of 120); green at 572cf9c |
| 2 | the cross-store leg through a ticket-door worker only | **lit (unit 11, the final gate)** | The scenario has one leg crossing back, so either door bound there leaves the other unbound; a door swap moves the half-lighting, it does not remove it. Scenario: *"a hooks-door leg that ran on another machine comes back into the run by the handoff, its return found in the handoff lane by its agent"* (or an outline over the third leg's door). No mutant distinguishing the two doors was built: with one subagent in the sender's lane, the agent-id paths of the import rule pick the same rows either way |
| 3 | `startWorker` atomicity (M16: a first-moment row the store refuses leaves a registration or an open row) | **lit (unit 11, the final gate)** | *"a worker whose first-moment row the store cannot write is not registered and opens no run"*. Held outside the charter: tests/ticket-door.test.ts "a first-moment row the store refuses leaves no registration and no open row (M16)" |
| 3 | the door's phantom pass (M8: the ticket door retires a gone predecessor before composing) | **lit (unit 11, the final gate)** | the phantom outline (journal-workers line 210) names three readers; the ticket door would be a fourth Examples row, *"ticket door"*, with the recovery line in the next worker's first message. Held outside: tests/ticket-door.test.ts (M8) |
| 3 | any writer's checkpoint counting (M14: only the worker's own checkpoint counts against the send-back) | **lit (unit 11, the final gate)** | *"a worker whose key another writer checkpointed while it ran is not sent back"*. Held outside: tests/ticket-door.test.ts (M14, D291) |
| 4 | P09: the hooks door's first-moment row atomic with the registration | **lit (unit 11, the final gate)** | *"a subagent whose first-moment row the store cannot write is not registered as a leg and its start is marked as a gap"*. No unit test names it |
| 4 | P16: an identity line that repeats the first moment | **lit (unit 11, the final gate)** | the review's probe is not described in the tree beyond its name; the session-start identity line of a `claude -p` child is bound only by "contains `worker of the lane`" (journal-workers line 76) |
| 4 | the D305 scenario's silence on a pointer for a plain subagent | **lit (unit 4); verified** | journal-legs line 182 fires the Agent tool's return through the real PostToolUse hook and asserts its stdout empty |
| 5 | M6: a caller's own `_over_cap` kept on its checkpoint | **lit (unit 11, the final gate)** | the cap outline's writes carry no caller metadata; a forged mark is not in its words. *"a leg that marks its own checkpoint over the cap is not believed: the mark is the store's"*. Held outside: tests/checkpoint-cap.test.ts (the forged `_over_cap` through the library and the tool). Mutant (drop `_over_cap` from `WRITER_STAMP_KEYS`) confirmed green on journal-legs at this tree |
| 5 | M11: a refusal counted by the retention sweep's insert counter | **cannot be lit within the words** | the counter is the valve's internal schedule; no owner-language scenario names it. Held outside: tests/checkpoint-cap.test.ts "a refusal is not an insert (M11)" |
| 6 | M1: the skeleton carrying a send-back row | **lit now** | journal-runs "a run's default export is its skeleton, with no captured tool output": its Given's reviewer is sent back once by its Stop hook, so the store holds a send-back row of the run. Mutant: `'send-back'` added to `SKELETON_KINDS`. Red at the Then that enumerates what the file holds, whose exact kind set is the rows D360 lists; green at 572cf9c |
| 6 | M3: the tool's whole form ungated | **lit (unit 11, the final gate)** | the whole-form scenario's exporter is "a harness" (a program: the CLI door); the tool is the agent's door. *"an agent exporting a run whole through the tools gets the warning first and the file only after acknowledging"*. Held outside: tests/run-export.test.ts (the tool's acknowledged call). Mutant (`acknowledged: true` at the tool) confirmed green on journal-runs at this tree |
| 6 | M6: the own-registration skip on import | **lit (unit 11, the final gate)** | the cross-store Then counts the laptop's legs through the lookup, which already leaves out a leg registered here. *"a run exported, carried back and imported again lands none of this store's own legs twice"* |
| 6 | M9: the door-line note naming the wrong legs | **lit (unit 11, the final gate)** | no ruling names a door-line note (D318 rules one reply line, `first_moments`; D300 none), so no binding asserts it: unit 6's `toContain` pair and unit 9's exact assertion are both withdrawn. Mutant (the note names every first moment's leg) confirmed green on journal-runs at this tree. *"a run whose legs came through both doors: the export's reply names the hooks-door legs whose first moment is the door's line, and no other"* |
| 6 | M15: the reader's SQL dropping imported captured rows | **lit (unit 11, the final gate)** | imported captured rows arrive only by a whole-form handoff; the cross-store scenario's export names no form (the skeleton). *"a leg's whole export carried back and imported reads back with the run by plain SQL, its captured rows through its imported registration"*. Mutant (drop the handoff-lane branch of `RUN_ROWS_SQL`) confirmed green on journal-runs at this tree |
| 6 | M18: the file's head dropping `first_moments` | **lit (unit 11, the final gate)** | D318's words are about the reply; the head is the file's. *"the run's export file says in its head what its first moments are"*. Mutant confirmed green on journal-runs at this tree |
| 7 | M15: fragment eviction | **lit (unit 11, the final gate)** | the two worker-row scenarios use the session cap and the byte budget; the entry-count safety net, which also evicts whole sessions, is not in their words. *"a worker's lane past the entry cap is evicted whole, never in part"* |
| 7 | the D55 ordering binding blind to write-after-delete (pre-existing; journal-storage line 79) | **lit now** | "the ordering is archive written, then tombstone, then deletion": the second sweep is now watched at the archive's fsync, the archive file read and the store read through a separate handle at that moment. Mutant: inside the eviction transaction the rows are deleted, then the archive is written (from the same connection, so it holds nothing), then the tombstone. Red (`archived: []`); green at 572cf9c, whose fault injection rolls the whole transaction back |
| 8 | M2: the /config row's start moved from 2.1.302 to 2.1.301 | **lit (unit 11, the final gate)** | the version outline (journal-install line 366) has no 2.1.301 row; a row *"2.1.301: written off, the settings line alone, no /config row"* would light it. Mutant confirmed green on journal-install at this tree. Held outside: tests/server/idle-compaction.test.ts (2.1.301 settings-line, 2.1.302 config-row) |
| 8 | M11: the turned-off line naming /config at 2.1.295 | **lit now** (the owner's split at the final gate, D367) | the scenario that would reach 2.1.295 with the key absent is the open one (line 381), whose install clause D361 rules out; its split (the key absent at 2.1.295 is written off naming the settings line and no /config row) lights it. Mutant confirmed green on journal-install at this tree. Held outside: tests/server/idle-compaction.test.ts ("the /config row appears from 2.1.302 and never before") |
| 8 | M13: doctor saying "off" for an absent key on a reading client | **lit at the charter** | journal-install line 216 (D276, "doctor says in one line that nothing is set up yet", re-pinned by unit 8): its Then "every warning row below it names that same command as its fix" requires the Idle compaction warning among the rows at 2.1.302 with no key. Mutant (an absent key reads as off) red there at this tree. Also held by tests/server/idle-compaction-cli.test.ts |
| 8 | M16: the absent-key doctor fix not being `treecontext install` | **lit at the charter** | the same D276 Then: every warning row's fix is `treecontext install`, the Idle compaction row's among them. Mutant (the fix is the settings line) red there at this tree. Also held by tests/server/idle-compaction-cli.test.ts |
| 8 | the corrupt-config binding covering `~/.claude.json` only (journal-install line 68, D51) | **lit now** | "a corrupt config file is backed up, not destroyed": the reference agent's two config files install writes are both made unparseable and both held to both Thens. Mutant: the settings writer rebuilds an unreadable `settings.json` with no backup. Red; green at 572cf9c |
| 8 | the halves of scenario 6 (journal-install line 381) in tests/server/idle-compaction.test.ts | **lit now** (the owner's split at the final gate, D367) | the scenario asks install for a line with the key already on, which D361 rules out; the halves are library tests (`installLine` at 2.1.295 with the key absent; `idleCompactionRow` at 2.1.295 with the key on). The split the register comment proposes binds both through the CLI |

One further strengthening, not a review note: journal-legs line 333 ("every
first moment says in treecontext's own words…") compared the hook's
context with the source's own constant, so it followed an edit of the
constant. It now asserts the three things the words say. Mutant: the
constant loses "and it never pastes the history in". Red at line 333;
at 572cf9c line 333 was green and only the ticket door's line 300 went red.

### Owner items from the table (fifteen)

Thirteen scenarios the words did not reach, one probe to describe before
its scenario could be written, and one amendment. All fifteen were done at
the final gate (2026-11-01): the amendment as D367, the rest as unit 11,
whose scenarios the owner approved as drafted and which bind through the
real doors (each red under a mutation; the audit table's dispositions say
`lit (unit 11, the final gate)`). Unit 11 found one product defect: the key
lookup never found an imported hooks-door leg's return, because it read the
sender's agent stamp at the top level where D360 keeps it under the file's
claims (src/key-lookup.ts, importedReturnOf). Original list:

1. ~~a hooks-door leg that ran on another machine comes back into the run by the handoff, its return found in the handoff lane by its agent~~ — bound in unit 11, 2026-11-01 (the final gate)
2. ~~a worker whose first-moment row the store cannot write is not registered and opens no run~~ — bound in unit 11, 2026-11-01 (the final gate)
3. ~~the phantom outline gains a "ticket door" reader row~~ — bound in unit 11, 2026-11-01 (the final gate)
4. ~~a worker whose key another writer checkpointed while it ran is not sent back~~ — bound in unit 11, 2026-11-01 (the final gate)
5. ~~a subagent whose first-moment row the store cannot write is not registered as a leg and its start is marked as a gap~~ — bound in unit 11, 2026-11-01 (the final gate)
6. ~~a leg that marks its own checkpoint over the cap is not believed: the mark is the store's~~ — bound in unit 11, 2026-11-01 (the final gate)
7. ~~an agent exporting a run whole through the tools gets the warning first and the file only after acknowledging~~ — bound in unit 11, 2026-11-01 (the final gate)
8. ~~a run exported, carried back and imported again lands none of this store's own legs twice~~ — bound in unit 11, 2026-11-01 (the final gate)
9. ~~a run whose legs came through both doors: the export's reply names the hooks-door legs whose first moment is the door's line, and no other (M9)~~ — bound in unit 11, 2026-11-01 (the final gate)
10. ~~a leg's whole export carried back and imported reads back with the run by plain SQL, its captured rows through its imported registration~~ — bound in unit 11, 2026-11-01 (the final gate)
11. ~~the run's export file says in its head what its first moments are~~ — bound in unit 11, 2026-11-01 (the final gate)
12. ~~a worker's lane past the entry cap is evicted whole, never in part~~ — bound in unit 11, 2026-11-01 (the final gate)
13. ~~the version outline (journal-install line 366) gains a 2.1.301 row (unit 8's M2)~~ — bound in unit 11, 2026-11-01 (the final gate)
14. ~~(P16) the `claude -p` child's identity line, once its probe is described~~ — bound in unit 11, 2026-11-01 (the final gate)
15. ~~journal-install line 381 split as its register comment proposes (D361), which also lights unit 8's M11~~ — done at the final gate, 2026-11-01 (D367)

### Other open items found by the audit

- journal-workers line 23: the Antigravity row is open (no Antigravity hook adapter); every row's worker is the hook-less stand-in.
- journal-workers lines 64 and 76 (half-lit): in the `claude -p` rows the wrapper writes the first-moment row before the child starts; the child's session-start hook links the lane and writes none. The scenario names the hook as the door: its wording is an owner item.
- journal-runs line 140 (the skeleton) is tagged @D300 only; D360 is the ruling that lists the skeleton's rows its kind set reads: adding @D360 is an owner item.
- journal-workers lines 44, 184, 192 stand in for the ticket door's registration through the library (now `registerThroughLibrary` in `tests/journal/standins.ts`). journal-runs lines 21, 63, 169, 175, 181 and 187 seed their history through the library (the named helpers there), which their words allow.
- journal-storage line 79 (D55): its ordering Then builds a store and a sweep of its own rather than reading the scenario's (pre-existing; the unit 9 fsync check rides on it).
- journal-install line 68 (D51): its Given now corrupts both config files at once; corrupting each in its own run would keep the Given singular (a cleaner binding, not required).
- journal-legs line 236: the whole rows' "with no query made" is not read from the staging table as line 22 reads it.
- journal-capture line 193 and journal-recall line 160 stage the recovery snapshot themselves; the session-start hook that stages it in production does not run in them.

## Unit 11's own review (the final gate, 2026-11-01)

The unit's bindings went through the same ladder. Findings and what was done:

1. **Blocker, hollow:** the "no /config row" clause of the three settings-line Thens (journal-install, the two split 2.1.295 scenarios and the way-back outline's 2.1.301 row) held only a tail match, which a /config clause prepended to the remedy passed. Each now asserts the absence with a `step-lint: allow unearned-absence` marker naming its prover (the same outline's 2.1.302 row, or the /config-first doctor scenario), red under that mutation.
2. **Blocker, product:** the ticket door reported a refused write with the busy-wait line (false cause). `refusedStartLine` in `src/ticket-door.ts`; the D307 lock scenario and the refused-first-moment scenario both stay green.
3. **Note, binding strength:** the cross-store hooks-door return scenario had one summary in the sender's lane, so dropping the agent filter stayed green. It now runs an explorer subagent under the same parent with a newer summary, and the Given carries that summary across by a summaries handoff beside the run's skeleton (a step the scenario's words do not name; owner to see). Red under the reviewer's mutation; a unit test covers the claims path.
4. **Note, vacuous:** the ticket-door phantom row compared `noticed_at` to the next worker's `started_at`, moments one transaction stamps alike; dropped, `noticed_by` names the reader.
5. **Note, over-assertion:** the door-line sentence shape, the full import-flag sentence, the D291 scenario's exact lane kinds, the empty hook stdout for "carries no brief", the 2.1.302 remedy wording. Left as they are: each pins a product sentence beyond the words; none lets a clause go.
6. **Note, same-class defect:** `firstMomentLegName` read top-level stamps an imported row lacks; fixed with a unit test. The gate also found the file's head joining the door-line note into `first_moments`; it is `door_lines` now, as in the reply.

## The main-lane build (D372–D378), 2026-11-03

Collated by the final fix unit from the instrumentation lines of the
build's five reviews (`docs/main-lane-self-2026-11-02/u1-review.md`,
`u2-review.md`, `u3-review.md`, `u4-review.md`, `final-review.md`) and
the fix unit's own probes. Same vocabulary as above, plus the review
rungs `vacuous` (a Then that holds whatever the code does in its world)
and `unlit` (a promise no test reaches). Every world is a real git
repository with real worktrees, its sessions registered by the real
SessionStart hook (`openGitWorld`), its store the one the production
resolver derives; `tool` is the real MCP tool over a connection under the
caller's Claude Code session id; `hook-out` here is the packet the
SessionStart hook emitted.

### journal-orchestration.feature and journal-workers.feature (20 scenarios, one outline of 4 rows; 0 open)

| line | scenario | door (act; Given if different) | Then's evidence | rung | note |
| ---- | -------- | ------------------------------ | --------------- | ---- | ---- |
| o88 | a worktree's status lists its own lane's pointers and says what else exists | tool `treecontext_status`; Given tool inserts by the main and worktree sessions | tool-reply + file | — | counts one pointer of one lane: `other_lanes` and `other_lane_count` coincide here (the outline tells them apart) |
| o97 | the main checkout's status is scoped to the main lane the same way | tool `treecontext_status`; Given tool, the older chapter by library with no stamp | tool-reply + file | — | as o88 for the two counts |
| o107 | asking for every lane lists them flat, each pointer naming its lane | tool `treecontext_status` `scope: "all"` | tool-reply | — | absence of every block key asserted on the reply text |
| o114 | the other lanes are counted and at most three named with `<lanes>` other lanes (4 rows) | tool `treecontext_status`, then hook SessionStart | tool-reply + hook-out + file | — | (final unit) the first worktree holds two live chapters, so `other_lanes` (pointers left out, D242) is lanes + 1 and `other_lane_count` is lanes: P15 (`other_lanes` := lane count) is red in rows 1, 3 and 5 at scenario level, where it was silent (final review F3) |
| o128 | a restarted main checkout opens on its own thread and is told what else exists | hook SessionStart (startup, resume); Given hooks + tool | hook-out + tool-reply + file | — | the owner's incident walked end to end; packet, status and search agree. U2 left the walk's Thens unlit; bound in U3 |
| o143 | a main checkout with only a bookmark is handed the bookmark, never a worktree's chapter | hook SessionStart; Given tool | hook-out + file | — | |
| o151 | a main checkout alone in its store opens on its own thread and names no other lane | hook SessionStart; Given tool | hook-out + file | — | |
| o158 | the orientation search is scoped to the session's own lane | tool `treecontext_query` per session; Given hooks capture + tool | tool-reply + file | — | |
| o168 | a lane's search finds its helpers' reports and its imports, never a helper's trail | tool `treecontext_query`; Given hook SubagentStart/Stop + tool+echo trail, ticket door (`spawnWorker`) ×2, tool import | tool-reply + file | — | the orphan worker carries a run and key on its ticket for the key-lookup check (review-v4 fix 4) |
| o181 | a worktree's conversation from an earlier release is the worktree's own | tool `treecontext_query`, `treecontext_export` `writer`; Given real hooks capture with no writer | tool-reply + file (byte for byte) | — | |
| o189 | two hundred helpers do not displace the main checkout's own thread | hook SessionStart, tool status and query; Given 200 SubagentStart/Stop pairs through the real hooks | hook-out + tool-reply + file | — | the seat (D374) asserted at k ≥ 2 by unit tests; Q1, Q2 red |
| o201 | a fresh start adopts a recovery snapshot only from its own lane | hook SessionStart + the production drain; Given hook PreCompact in each lane, real order | hook-out + file | — | U4's backdate replaced by the real order (U34-fix); Q9 (lane filter dropped) red at scenario level. The worker and subagent exclusion is unit-tier (Q8 red) |
| o210 | a chapter whose writer could not be identified is set apart as writer unknown in every lane | tool status, hook SessionStart, per lane | tool-reply + hook-out + file | — | |
| o220 | an unplaced writer's chapters still supersede one another | tool `treecontext_status` `scope: "all"`; Given tool inserts by an unregistered session | tool-reply + file | — | (final unit) the Given now writes both chapters before any session has run in the main checkout, so the pre-stamp door is open while the client supersedes its own; the main session starts after. P13 (the door's stamp test reads `_writer` only) is red at scenario level, where it was green (final review F2, vacuous) |
| o228 | rows from before the store recorded writers stay the main lane's | tool status and query; then hook SessionStart in a worktree | tool-reply + hook-out + file | — | |
| o235 | a client without hooks retires its chapter from before the upgrade, and the retirement says who, what, when and how | tool `treecontext_insert` by an unregistered session; Given library pre-stamp chapter, no main registration | tool-reply + file | — | the export Then asserts the record, not `referencedBy` (final review F5, optional); the handoff export's whole form is held generically by `run-import-rule.test.ts` over `WRITER_STAMP_KEYS` |
| o246 | the boundary opens to no pointer that names a writer, whose session the registry holds, or that was imported | tool `treecontext_insert`; Given tool, library, import | tool-reply + file (as was, byte for byte) | — | P2–P5 red; P4b (liveness alone) green as disclosed, the handoff test still guarding |
| o257 | the boundary opens for the writer-unknown lane alone | tool `treecontext_insert` by a worktree session, then by main | tool-reply + file | — | P7 red |
| o265 | once a session has run in the main checkout, a client without hooks cannot retire the main checkout's chapter from before the upgrade | tool `treecontext_insert`; then hook SessionStart in main | tool-reply + hook-out + file | — | P1 (the incident guard) red |
| w364 | a worker of the ticket door searches the whole store and sees every lane | ticket door (`spawnWorker`, standin-worker through its tools) | tool-reply (the worker's) + file | — | |

(`o` is journal-orchestration.feature, `w` journal-workers.feature.)

### Below the charter, and what the probes left

- **The door and read_only (final unit, review F1, medium).** `retireAcross` retired a read-only pre-stamp chapter, which ordinary supersession refuses. `splitSupersedes` now routes a read-only target of the door to the ordinary retirement, whose reply is `supersede_misses` `{reason: "read_only"}` with nothing recorded across. `tests/lane-door.test.ts` drives it through the real insert tool; dropping the check is red.
- **The recovery identity's staging fallback (final unit, review F8, unlit).** A snapshot claim staged before the claim carried `snapshot_id` is identified by its staged row. `tests/persistence/recovery-identity.test.ts` drains such a row twice (one row, `staging_id` set) and a second such claim (two rows); Q7 (drop `staging_id` from the identity) is red.
- **Unit-tier only, by design:** the lane panel's kind and age on any order (I-kind, I-age, U2-F4), the packet's bookmark from the own lane (I-bookmark-any), the door's undo by the echo heal (P10, P11), the bookmark exclusion (P12), a fresh start whose registration did not land (P14), `writerOf` for an unplaced row (P16), the concurrent and ambiguous callers' whole-store search (Q3), an unplaced caller's search (Q4).
- **Carried, charter text:** the packet of a start whose registration did not land says nothing about the checkout; D373's comment does not yet disclose it (final review F4). The skill text's "each reply … counts the other lanes" holds for status and the packet, not the search reply (final review F14); D374 promises the lane and how to widen only.

| unit | bound | hollow | vacuous | narrowed | half-lit | unlit | probes run | silent |
| ---- | ----- | ------ | ------- | -------- | -------- | ----- | ---------- | ------ |
| U1 | 9 | 0 | 0 | 1 (references.test.ts) | — | 11 (under wip then) | 19 | 4 (R-6, R-7, R-8, U1-4 at scenario level) |
| U2 | 17 | 0 | 0 | 0 | — | 8 | 33 | 4 |
| U3 | 13 | 0 | 0 | 0 | 1 (D309 by name) | 2 | 32 | 1 full suite (U3-2), 1 targeted (U3-9b) |
| U4 | 1 scenario + 4 units | 0 | 0 | 1 (secret-word startup) | — | 1 | 14 | 2 (P10, P1 without the backdate) |
| U3b | 9 | 0 | 1 (the @D376 added Then) | 0 | 0 | 0 | 20 + 1 scratch | 1 at scenario level (P15), P4b as disclosed |
| U34-fix | 9 | 0 | 0 | 0 | — | 1 (staging fallback) | 9 | 1 (Q7) |
| final fixes | 2 scenario rebinds + 2 units | 0 | 0 (the @D376 Then cured) | 0 | 0 | 0 (staging fallback lit) | 4 | 0 (F1 probe, P13, P15, Q7 all red) |

Each later unit cured what the one before left where it says so: U3 the
U2 walk, U34-fix U3-2, U3-9b and U4's P1 and P10, U3b U2's I-kind, I-age
and I-bookmark-any, the final unit U3b's P13 and P15 and U34-fix's Q7.
