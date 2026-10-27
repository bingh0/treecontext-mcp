# Proposal for beta review: bounded legs in dynamic workflows, and what the journal owes them

**Status: draft for owner review, 2026-10-15, extended 2026-10-27 (§9);
not yet posted to beta testers.** Nothing in this document is decided. It replaces the first
draft of the same day ("Bounded-Leg Subagents with Journal-Backed
Resume"), which some testers have already seen; §8 says what changed and
why. It precedes the scope session that rules on the beta.3 line, and
exists so that objections arrive before the rulings become feature files.
The DAWN dispatcher (§3.13) is the reference consumer: a working
prototype whose author is open to changing it, which this proposal
treats as a reason to change it as little as possible.

The findings in §1 are verified against the beta.2 code and a live probe
of Claude Code 2.1.300 run on 2026-10-15 (Appendix A has the recipe and
the raw timeline). The need in §2 is the owner's. The design in §3 is one
candidate set of means and the part most open to change. §5 is the list
of questions we want answers to. §7 sizes the work against beta.3 and
beta.4. §9, added 2026-10-27, takes up the headless workers (`codex exec`,
`agy -p`) the testers turned out to rely on, and the door into the store
they lack.

How to respond: reply in the thread this is posted to, quoting the
question number (Q1–Q17) or the section you object to. Every objection is
recorded as a ruling with your reason attached, so a one-line "Q4: never
block my legs" is a complete and useful answer.

---

## 0. The problem in one paragraph

A dynamic workflow (the `Workflow` tool) runs many `agent()` calls from a
script. A leg that runs long fills its own context window and the only
built-in relief is auto-compaction: a lossy summary that also invalidates
the prompt cache. Nothing in the workflow runtime or the hook surface
lets a leg clear its context, and a resumed subagent keeps its whole
history. The answer the first draft reached is right in shape: do not
run long legs. Run short ones, each starting fresh, with the working
state carried between them. Where the first draft went wrong is *where*
that state is carried. It routed every handoff through the journal, with
a new lookup mode, a new server registration, a new lane model and a
transcript-reading watchdog to make that work. The workflow script is
already the replay-safe carrier of a leg's return value; the journal's
job is to be the durable copy, the recovery path when a leg is cut, and
the trail. Read that way, most of the first draft's eight changes shrink
to four small ones, and two of the things it did not notice (a cut leg
leaves a phantom registration; every leg pays the orchestrator's
orientation protocol) turn out to be the ones that matter. The owner's direction is that the recipe
this leaves behind ships as a treecontext skill, descended from the
DAWN dispatcher, so that any user can run bounded legs without writing
a script (§3.14).

---

## 1. What beta.2 does today

Every statement here was checked on 2026-10-15 by reading the code and
by running a six-leg workflow headlessly with a raw-payload logger on
every hook event (Appendix A). Where the finding is a gap it is labeled
as one.

### 1.1 The hooks fire inside workflow legs

treecontext's subagent capture had only ever been probed with the
`Agent` tool. The workflow runtime behaves the same way:

- `SubagentStart`, `PostToolUse`, `PostToolBatch` and `SubagentStop` all
  fire for a workflow leg, each carrying `agent_id`, `agent_type` and the
  **parent's** `session_id`.
- A default leg's `agent_type` is `workflow-subagent`. A leg spawned with
  `agentType: 'leg-worker'` carries `leg-worker`.
- `SubagentStart` carries `agent_id`, `agent_type`, `cwd`,
  `hook_event_name`, `prompt_id`, `session_id`, `transcript_path`. It
  does **not** carry the leg's prompt.
- `SubagentStop` carries `agent_transcript_path` (the leg's own
  transcript), `stop_hook_active`, and `last_assistant_message` when the
  leg ended in text. `transcript_path` on every subagent event is the
  parent's transcript, not the leg's.
- The main session's `Stop` fires when the orchestrator's turn ends,
  which is while the workflow is still running; the workflow's completion
  arrives later as a `UserPromptSubmit` (the task notification).

So a leg's tool calls are already captured, stamped `_writer` = its
agent type and `_writer_agent_id` = its id, under the orchestrator's
session. The writer lane is the role (D167); the instance id is on every
row; `treecontext_export` with `writer: <agent id>` returns one leg's
trail on its own.

### 1.2 What the journal captures of a leg's return

- A leg that ends in text: `SubagentStop` carries the text, and the hook
  stages it as the leg's summary (kind `subagent-summary`). Verified.
- A leg with a `schema`: its last act is a `StructuredOutput` tool call,
  not text. `SubagentStop` fires **without** `last_assistant_message`
  (the key is absent), and the leg's transcript holds no assistant text
  block either, so the hook's transcript fallback finds nothing and
  **no summary row is staged**. The structured return itself *is*
  captured, by `PostToolUse`, as the input of a tool event: kept whole
  behind the preview, indexed up to the tool cap, ranked as tool trail
  (weight 0.1). Gap: a schema leg's return is in the store but not marked
  as its summary, and it ranks below any note that mentions the same
  words.

### 1.3 What a cut leg leaves behind

Three ways a leg ends without finishing, all exercised:

| How the leg ended | What `agent()` returned | `SubagentStop` fired | Registry row |
| :-- | :-- | :-- | :-- |
| `maxTurns` reached, no schema | `""` (empty string, not `null`) | **No** | stays live |
| `maxTurns` reached, with schema | the call **threw**: `agent({schema}): subagent completed without calling StructuredOutput (after in-conversation nudge)` | **No** | stays live |
| `PostToolBatch` hook exit 2 | `""` | **No** | stays live |
| `SubagentStop` hook `decision: "block"` | the leg kept working; the second stop (with `stop_hook_active: true`) returned its final text | twice | retired |

Gap: a leg cut by a turn cap or a batch hook never fires `SubagentStop`,
so treecontext never retires its registration. The row stays live until
the session's next start, resume or clear retires every subagent (F3).
Until then the writer stamp at insert reads that phantom as a live
subagent: with the orchestrator waiting on a workflow, a later
tool-written row is stamped `provisional` as the phantom's, and only the
echo heal corrects it. With sixteen legs in flight the stamp is
`ambiguous` anyway (several live, no evidence), and the heal does all the
work, which it does correctly; the phantom only matters once the fleet
has drained.

Gap: `maxTurns` and `schema` do not compose. The hard ceiling the first
draft leaned on throws the structured return away, and a bare `await`
takes the whole workflow down with it.

### 1.4 What the leg sees at start

Every default workflow leg receives the project's `CLAUDE.md` and
`AGENTS.md` (the marker line in the probe's `CLAUDE.md` is in all four
default-leg transcripts). A leg spawned from an agent definition
with `omitClaudeMd: true` does not (absent from both `leg-worker`
transcripts).

On a project where `treecontext init` has written its managed block,
that block tells every agent, before any other work, to call
`treecontext_status`, export every resume pointer it lists, and run the
orientation query. The block is about 2 300 characters. On the owner's
own store the status reply lists twenty pointers in about 12 000
characters, and each export is a chapter summary of its own. A leg that
obeys spends, by estimate on this store, several thousand to a few tens
of thousands of tokens of the *orchestrator's* orientation before its
first tool call, and learns nothing it needs. The MCP handshake text
says the same thing, in the server's instructions, to every client that
loads the tools. Gap, and likely a measurable share of the context
pressure testers report: the orientation protocol has no notion of a
subagent.

(One counter-observation: a tool-restricted `claude-code-guide` subagent
spawned from this repository, whose `AGENTS.md` has no managed block,
made no treecontext call at all. The tax is the block's, not the
handshake's alone.)

### 1.5 What a leg can look up

- `treecontext_query` requires query text (`min(1)`), builds an FTS
  `MATCH` from it, and since D268 pushes a `metadata_filter`'s flat
  scalar keys into the SQL `WHERE`. With `sort_by:
  "reverse_chronological"` and `top_k: 1` that is a deterministic
  newest-row lookup on any metadata key, **provided the query text
  matches the row** through FTS. Gap: there is no metadata-only lookup.
  A leg looking for "the newest row under key K" must also guess words
  that appear in it.
- A subagent's default search scope (its role's trail plus the plan it
  was spawned under) applies only while it is the *only* live subagent
  and the orchestrator is silent. Under a fleet, every search covers the
  whole store, which is the right default for a key lookup.
- `treecontext_insert` takes arbitrary metadata and `decay_exempt`. A
  caller's `_writer*` and `_handoff_*` keys are dropped; `kind`, `key`,
  `seq`, `run` and the like are kept and filterable.
- Nothing reads an archive through MCP. Verified by absence.

### 1.6 Retention under one giant session

A workflow's legs share the orchestrator's session id, so a thousand-leg
run is **one session** to the retention valve. The first draft's fear
(churning the 100-session cap) cannot happen. What can:

- The entry safety net (200 per allowed session, 20 000 at the default)
  evicts whole sessions, oldest and least relied-on first, and **never
  the newest**. A run that captures 40 000 events in the live session
  cannot be evicted; it evicts *older* sessions down to the cap and
  reports the remainder as over budget.
- The byte valve (128 MiB) demotes the oldest auto-captured rows to their
  index text, after archiving the full text. Curated rows (a leg's
  checkpoint written with `treecontext_insert`) are never demoted, and
  `decay_exempt: true` protects a row from both mechanisms.

So the exposure is the opposite of the first draft's: a large run
pushes *earlier* sessions out, not itself. That is the configured
behavior, adjustable per project in `treecontext.toml`.

### 1.7 Policies and the fence

One `full` server is registered per user; a subagent that reaches the
tools reaches that server. The fence declines per-subagent MCP servers
and agent definitions that declare their own treecontext server (D124,
2026-09-23), and the workflow runtime confirms the shape: workflow legs
reach "all session-connected MCP tools via ToolSearch". A second,
`contributor`-policy registration (the first draft's D1) reopens D124,
which is an owner ruling, not an issue. The same protection is available
today without it: an agent definition's `tools:` line can allowlist just
the four tools a leg needs.

### 1.8 What the stop hook already does

The main session's `Stop` hook already blocks a stop, once per interval,
to ask for a bookmark (D156, D157, D163, D198), and records the ask so it
never asks twice within one interval. `SubagentStop` has no such duty and
always exits 0. The probe shows a `decision: "block"` on `SubagentStop`
works inside a workflow leg exactly as documented.

### 1.9 What Claude Code gives and withholds

| Capability | Status | Evidence |
| :-- | :-- | :-- |
| Hooks fire for workflow legs with `agent_id`/`agent_type` | Yes | probe 2026-10-15 |
| Live token count in any hook input | No; only `context_tokens` on `SessionStart` resume/fork | docs, 2026-10-15 |
| Per-message `usage` in a leg's own transcript | Yes: `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` on every assistant entry; their sum is the context size at that call | probe |
| `agent()` options in this runtime | `label`, `phase`, `schema`, `model`, `effort`, `isolation`, `agentType` (docs also show `stallMs`) | workflow-authoring reference; docs |
| Frontmatter `maxTurns`, `omitClaudeMd` honored through `agentType` | Yes | probe |
| `maxTurns` with `schema` | Throws | probe |
| `SubagentStart` input carries the delegation prompt | No | docs; probe |
| `SubagentStart` `additionalContext` reaches the leg | Yes (probe 2026-09-25, Agent tool) | journal |
| `PostToolUse` `additionalContext`, 10 000-char cap, overflow to a file | Yes | docs |
| `SubagentStop` block sends the leg back | Yes, inside a workflow | probe |
| `PostToolBatch` exit 2 | Ends the leg; `agent()` resolves `""`; no `SubagentStop` | probe |
| Transcript may lag the live conversation | Stated | docs |
| Workflow relaunch replays cached `agent()` results | Yes; keyed by prompt and options | docs; journal.jsonl |
| Script sees time or randomness | No | docs |
| A way to clear a running subagent's context | None documented | docs |

---

## 2. What the owner has asked for

In the owner's words, as near as a paraphrase allows: beta testers are
doing more agent orchestration with Claude Code dynamic workflows and are
running into challenges managing context. The owner wants a thorough,
feasible proposal built on verified behavior, to be put to the testers
for feedback and then used as the seed of a scope session for
treecontext, bundled into beta.3 or beta.4 depending on ambition and on
what else is filed against beta.2.

Stated as needs, for the scope session to accept or reword:

- **N-a.** A long task run as a workflow finishes without any leg
  compacting, and without the orchestrator's own context growing with
  the legs' working state.
- **N-b.** A leg that is cut (turn cap, hook, stall, crash) loses no more
  than its last partial step; the next leg resumes from the last
  checkpoint.
- **N-c.** A relaunched workflow is a replay: completed legs are not
  re-run and a re-run leg does not read state from an aborted attempt.
- **N-d.** The journal holds every leg's trail and checkpoint such that a
  later session, or a human, can reconstruct the run.
- **N-e.** A leg pays nothing for context it does not need: no
  orchestrator orientation, no whole-store panel.
- **N-f.** Nothing here widens a subagent's write authority or reopens a
  fence line by implication.

---

## 3. Candidate design

### 3.0 The leg contract, in one figure

```
workflow script (holds the loop and the last checkpoint)
   │
   ├─ leg k: agent(prompt + checkpoint_{k-1}, {agentType, schema})
   │     ├─ SubagentStart          → registers the leg (exists today)
   │     ├─ … work …               → every tool call captured (exists today)
   │     ├─ treecontext_insert     → durable copy: kind=checkpoint, key, seq, run
   │     ├─ StructuredOutput       → {done, next, checkpoint}   ← the primary carrier
   │     └─ SubagentStop           → summary row from the structured return (§3.4)
   │
   ├─ leg k+1: agent(prompt + checkpoint_k, …)          ← fresh context
   │
   └─ a cut leg ("" or throw): the script spawns a RECOVERY leg whose
      prompt says "recover from the journal under key K" (§3.3)
```

The script carries the checkpoint forward because that is the only
replay-safe channel: a cached `agent()` result carries its checkpoint
text, so a relaunch replays exactly; a journal read after a relaunch
could find the aborted attempt's row (N-c). The journal holds the same
checkpoint because a cut leg's return value is lost (§1.3) and the
journal copy is what the recovery leg reads (N-b), and because a later
session needs it (N-d). Script variables live in the workflow runtime,
not in the orchestrator's context: the orchestrator sees only the final
return (N-a).

### 3.1 The workflow recipe (no treecontext change)

```javascript
export const meta = { name: 'bounded-legs', description: 'Run a long task as short legs with journaled checkpoints' }
const MAX_LEGS = 12
const LEG = { type: 'object', required: ['done', 'next', 'checkpoint'],
  properties: { done: { type: 'boolean' }, next: { type: 'string' }, checkpoint: { type: 'string' } } }

const results = await pipeline(args.targets, async (target) => {
  const key = `${args.run}:${target}`                 // args.run is supplied at launch: the script has no clock
  let checkpoint = null
  for (let leg = 0; leg < MAX_LEGS; leg++) {
    let r = null
    try {
      r = await agent(
        `Handoff key ${key}, leg ${leg}.\n` +
        (checkpoint
          ? `Your predecessor's checkpoint:\n<checkpoint>\n${checkpoint}\n</checkpoint>\n`
          : leg === 0 ? 'This is the first leg.\n'
          : `Your predecessor was cut off before it returned. Recover its checkpoint from the journal: ` +
            `treecontext_query with metadata_filter {kind: "checkpoint", key: "${key}"}, sort_by reverse_chronological, top_k 1.\n`) +
        `Task: ${args.task} on ${target}. Work until a hook asks you to checkpoint, or the task is done. ` +
        `Then treecontext_insert the checkpoint (metadata kind "checkpoint", key "${key}", seq ${leg}, run "${args.run}", decay_exempt true) ` +
        `and return it as the structured result.`,
        { label: `${target} leg ${leg}`, agentType: 'leg-worker', schema: LEG })
    } catch (e) { log(`${target} leg ${leg} cut: ${e.message}`) }
    if (r === null || r === '') { checkpoint = null; continue }       // cut leg → next leg recovers from the journal
    checkpoint = r.checkpoint
    if (r.done) return { target, legs: leg + 1 }
  }
  return { target, legs: MAX_LEGS, incomplete: true }
})
return results.filter(Boolean)
```

Notes, each tied to a verified fact:

- The `try/catch` exists because a schema leg that is cut throws (§1.3).
- A cut leg sets `checkpoint = null` so the next prompt is the recovery
  prompt, which reads the journal; a completed leg's checkpoint goes
  forward in the prompt, never through the journal (N-c).
- `maxTurns` in the agent definition is a backstop, not the mechanism;
  with `schema` it costs the leg's return, so the soft stop (§3.5) and
  the leg's own habit of checkpointing before the cap are what keep legs
  bounded.
- No `stallMs` here: it is in the docs but not in this runtime's option
  list; verify before relying on it.

### 3.2 The leg-worker definition (no treecontext change)

```yaml
---
name: leg-worker
description: One bounded leg of a long task; reads and writes treecontext checkpoints
omitClaudeMd: true
maxTurns: 40
tools: Read, Grep, Glob, Edit, Write, Bash, mcp__treecontext__treecontext_query, mcp__treecontext__treecontext_insert, mcp__treecontext__treecontext_export, mcp__treecontext__treecontext_status
---
You work in bounded legs. Your prompt carries your predecessor's checkpoint,
or tells you to recover it from the journal. Never run the session-start
orientation protocol: you are a leg, not a session. The last thing you do is
write a checkpoint (what is done, what is next, decisions and rejected
options, files touched, commands to rerun) with treecontext_insert under the
handoff key, then return it as the structured result. If a tool result
tells you to checkpoint and return, do that immediately.
```

`omitClaudeMd` removes the managed block (§1.4) and the `tools:` line
bounds the leg to the four tools, which is the first draft's D1 without
a second server (§1.7).

### 3.3 The checkpoint entry (convention, no schema change)

A checkpoint is an ordinary curated entry with metadata:

| key | value | why |
| :-- | :-- | :-- |
| `kind` | `"checkpoint"` | distinguishable from bookmarks and chapters everywhere; never a resume pointer |
| `key` | the handoff key | the recovery lookup (§3.4) |
| `seq` | the leg index | ordering within a key |
| `run` | the run id from `args` | groups a run's checkpoints and trails; the script has no clock, so the launcher supplies it |
| `decay_exempt` | `true` | survives the byte valve (§1.6); the valve never touches curated rows anyway |

Nothing new in the store: D268 already filters on each of these in SQL.
The reference skill and the managed block gain a paragraph naming the
convention (the first draft's D8).

### 3.4 Change A: a metadata-only lookup

`treecontext_query` accepts an empty `query` when `metadata_filter` has
at least one flat key. With no phrase there is no `MATCH`; the SQL
predicates narrow the pool and `sort_by` orders it. One schema-line
change on the tool and one guard in `FlatStore.query`; the library path
already handles an empty phrase (orders by `created_at DESC`).

This is the first draft's D2 reduced to what is missing. It is the
recovery leg's lookup (§3.1) and nothing else in the design depends on
it.

### 3.5 Change B: the structured return is the leg's summary

The `subagent-stop` hook, finding no `last_assistant_message` and no
assistant text in the leg's transcript, reads the leg's transcript for
the last `StructuredOutput` tool call and stages **its input** as the
summary row (kind `subagent-summary`, writer the leg's role). The
orchestrator then finds a schema leg's return by search the way it finds
a text leg's today (D147), ranked as a note, not as trail.

Hook-only, no store change. The `PostToolUse` capture of the same call
stays as the trail entry; the summary row is the second copy the charter
already makes for text legs.

### 3.6 Change C: the checkpoint ask on `SubagentStop`, opt-in

The bookmark ask the main `Stop` hook makes (§1.8), applied to a leg:
when a `SubagentStop` fires for a registered subagent whose lane holds
no entry of kind `checkpoint` (or `bookmark`) newer than its
`SubagentStart`, and the project has opted in, the hook prints
`decision: "block"` with a reason naming the missing checkpoint. The
second stop (`stop_hook_active: true`) is never asked (D163's
never-block-twice, the same guard the main hook uses). Off by default;
on through `treecontext.toml`:

```toml
[subagents]
checkpoint_ask = true        # ask a finishing subagent for a checkpoint once
```

Verified feasible in a workflow leg (§1.3, row 4). What it cannot do:
fire for a leg cut by `maxTurns` or a batch hook (§1.3, rows 1–3), which
is why the script's recovery path exists.

### 3.7 Change D: phantom registrations retired on evidence

A cut leg's registration stays live (§1.3). Two retirements, both
hook-side:

- A live registration older than a configured age with no captured event
  since (the registry already reads staging for `newestMainEvent`; the
  same read per agent id is cheap) is retired by the next hook that
  looks. Default: 30 minutes; the scope session rules the figure.
- Not by the workflow's completion: the `Workflow` tool's `PostToolUse`
  fires at launch (the run is a background task), and completion arrives
  as a task notification inside a `UserPromptSubmit`, which the hook
  would have to parse by its text. Too fragile to build on.

The harm a phantom does is bounded. Once the orchestrator acts again,
`newestMainEvent` is newer than the phantom's start and the stamp reads
`concurrent`, as the registry already provides. What a phantom still
breaks is the next real subagent's default search scope, which needs
exactly one live registration.

Either way a retired row is not deleted: `stopped_at` is set, and the
echo heal is unchanged.

### 3.8 Change E: the orientation protocol learns what a subagent is

Three channels say "orient first": the managed block, the handshake text
and the session-reminder hook. None distinguishes a subagent. The change:

- The managed block and the handshake gain one line: *a subagent or a
  workflow leg skips the session-start protocol; its brief is in its
  prompt or in the entry whose `brief_for` names its role.*
- `treecontext_status`, called while the caller can be told apart as a
  subagent (one live, orchestrator silent) or while several subagents
  are live, answers with the subagent's own lines (its role's newest
  checkpoint, the brief addressed to it) and omits the pointer list.
  Under ambiguity it says so and still omits the list; `scope: "all"`
  restores the panel.

The drift test that holds the three channels to one protocol gains the
subagent sentence. This is the one change aimed squarely at N-e, and the
one most likely to pay off for testers whose pain is not the workflow at
all but the orchestration they already do.

### 3.9 Deferred: the watchdog

The soft stop the first draft centered on is feasible: a leg's own
transcript carries `usage` on every assistant entry, and `input_tokens +
cache_read_input_tokens + cache_creation_input_tokens` is the context
size at that call (§1.9). The `post-tool-use` hook could read the last
assistant entry of `agent_transcript_path`, compare to a threshold, and
return `additionalContext` telling the leg to checkpoint and return.

It is deferred, not declined, because:

- the cost lands on every tool call of every leg (a JSONL tail-read per
  event, sixteen legs wide), on a hook whose whole budget is 10 seconds
  and which already opens the store;
- the transcript lags the live conversation by an unmeasured amount;
- the journal already holds a cheaper proxy: the count and byte size of a
  leg's captured events since its `SubagentStart`, readable from staging
  on the connection the hook already has. Whether that proxy tracks
  context size closely enough is a measurement, not a design question;
- the recipe works without it: a leg told its turn budget in the prompt,
  with the checkpoint ask as the backstop, bounds itself.

Reopens when a tester's run shows legs compacting despite the recipe, with
the `compact_boundary` count from their subagent transcripts as the
evidence. The measurement script is in Appendix A.

### 3.10 Retention: guidance, not mechanism

A workflow-heavy project raises `max_sessions` and `max_store_bytes` in
its `treecontext.toml`; the `run` metadata key (§3.3) lets a human find
and export a run; nothing evicts the live session. The first draft's D7
(a per-run budget and a "newest checkpoint" guard) is withdrawn: its
premise was wrong (§1.6) and `decay_exempt` already covers the guard.

### 3.11 What stays on the fence

- No second MCP server registration (D124). The `tools:` allowlist is
  the means (§3.2).
- No lane per agent id (D167). The id is on every row and the trail is
  exportable by id (§1.1).
- No server-side summarization of anything (D14, D215): the leg writes
  its own checkpoint.

### 3.12 What this costs

| Change | Surface | Store migration | Charter diff |
| :-- | :-- | :-- | :-- |
| A metadata-only lookup | tool schema, one guard in `query` | none | one scenario in `journal-search-modes.feature` |
| B structured return as summary | `subagent-stop.ts`, `stop.ts` extractor | none | one scenario in `journal-orchestration.feature` (D147 extended) |
| C checkpoint ask on SubagentStop | `subagent-stop.ts`, config loader | none | new scenarios beside the bookmark interval (D156 family), opt-in stated |
| D phantom retirement | `post-tool-use.ts` (Workflow completion), `session-registry.ts` | none | one scenario in `journal-orchestration.feature` (D190 extended) |
| E subagent orientation | `instructions.ts`, installer block, `server.ts` status, drift test | none | `journal-agent-surface.feature`, `journal-reorientation.feature` |
| the dispatch skill, script and agent definition (§3.14) | `instructions.ts`, installer (`--experimental-dispatch`), package files | none | a new feature file binding on the installer's writes and on probe-shaped fixtures; advertised only after dogfood |
| checkpoint convention | reference skill, managed block | none | none; documentation |

No migration anywhere. Everything is additive and reversible.

### 3.13 Fit with the DAWN dispatcher, the reference consumer

The dawn developer's `dispatch` skill and `workflows/dispatch.js`
(DD-62, read 2026-10-15 at `~/gitrepos/dawn`) are a working prototype of
bounded legs, built before this proposal and without treecontext in the
loop. What it does:

- One `Workflow` run per hand-off. The script spawns a fresh Change
  Manager (`agentType: "change-manager"`, a `schema` of `{handoff,
  report}`), parses the hand-off line it returns, spawns each role the
  line names (`agentType: role`, text return), then a fresh Change
  Manager that reads every report verbatim, until an ask, a gate, a
  `human`, an unparsed line or the spawn cap (8). The run returns
  `{handoff, report, ended}`.
- The checkpoint is in the repository: the hand-off line in
  `rulings.md` and the draft sections under `changes/drafts/<stem>/`. The
  script carries the reports between spawns in a variable. The main
  session relays `handoff` and `report` to the human verbatim and "holds
  no draft and no report in context between runs".
- Every role's `tools:` line allowlists `mcp__dawn__*` and the file
  tools. No role can reach a treecontext tool. The repository's
  `CLAUDE.md` carries no treecontext block.

So the dispatcher already honors the principle of §3.0, with the
repository rather than the journal as the durable copy, and the script
as the carrier. Nothing in this proposal asks it to change that. What
treecontext owes it is capture, summaries and recall, and today it falls
short in exactly the places §1 found:

| Today | Effect on the dispatcher | Fix |
| :-- | :-- | :-- |
| A schema leg's return is captured as tool trail, with no summary row (§1.2) | The Change Manager, the one leg whose return *is* the hand-off, has no summary in the journal; the role legs, which return text, do | Change B |
| A phantom registration breaks the next subagent's default scope (§1.3) | The dispatcher spawns legs strictly one at a time with the orchestrator waiting, which is the exact condition under which a fresh role's search is scoped to its role's prior trail and the plan it was spawned under (D150). One phantom turns every later leg's search into a whole-store search | Change D |
| The orientation protocol has no notion of a subagent (§1.4) | No effect today: dawn's roles cannot see the tools and its `CLAUDE.md` has no block. It applies the day a role is given `treecontext_query` | Change E |
| No metadata-only lookup (§1.5) | No effect: the dispatcher's recovery path is the repository | Change A is not for dawn |
| No checkpoint ask on `SubagentStop` (§1.8) | No effect: the Change Manager's hand-off line is lint-checked before it is read (its template orders `dawn lint --draft`), which is a stronger guard than a hook | Change C is not for dawn |

What the skill could adopt, each optional, each a line or two, none
required by the above:

1. **Give the roles the query tool.** Adding
   `mcp__treecontext__treecontext_query` (and `treecontext_export`) to a
   role's `tools:` line lets a fresh Change Manager read its
   predecessors' trails and reports from the journal rather than only
   from the reports the script pastes into its prompt. Under the
   dispatcher's one-at-a-time spawning the default scope is the role's
   own trail plus the plan, which is what the 2026-09-25 feedback asked
   for ("mine" means the rows the role wrote). The owner's earlier
   assessment recorded that dawn's roles could not query treecontext
   because of their `tools:` lines; that is still the only reason.
2. **Name the run.** The script already receives `stem` and `date` in
   `args`. If a role writes anything to the journal (it cannot today),
   `run: "<stem>"` in its metadata groups the record's legs. Until then,
   the journal groups them by session and agent type, which is enough
   to export one role's trail.
3. **Split a long pass, only if one fills.** If a single role's pass (an
   Architect reading "everything") compacts, the §3.1 recipe applies
   inside that role: the dispatcher spawns the role's legs with the
   checkpoint carried forward, and the role's checkpoint lives where
   dawn's state lives, in a scratch file or a draft section, not in the
   journal. This is the one change that touches the dispatcher's shape,
   and it waits on Q11.

Where context actually fills in a DAWN revisit is not known from the
code. Three candidates, in the order of the proposal's guess: the main
session across runs (each run relays two verbatim strings into the
human's conversation; a long revisit is many runs, and this is the
checkpoint-then-clear case treecontext already serves), a fresh Change
Manager's reading of every report verbatim, and a single role's pass.
Q11 asks.

### 3.14 A shipped dispatch skill (owner's direction, 2026-10-15)

The owner's preferred outcome: a future version of the dispatch skill
lives in this repository and is installed by `treecontext install`, so
that any treecontext user can run a long task as bounded legs without
writing a workflow script. The dawn developer is collaborating and is
content for treecontext to take the skill. DAWN's own `dispatch` keeps
its grammar and its governance (DD-60 to DD-67); treecontext ships the
generic ancestor-descendant, and findings flow both ways.

This turns §3.1, §3.2 and §3.3 from documentation into a package
surface. What ships:

- **`~/.claude/skills/treecontext-dispatch/SKILL.md`**, beside the
  existing reference skill, which the installer already writes from
  `instructions.ts`. The skill says: use only on the human's word to use
  a workflow (the `Workflow` tool's own opt-in rule); start one run with
  `scriptPath` naming the shipped script and `args` `{run, task,
  targets, cap, date}` (`date` because the script has no clock); relay
  what the run returns; hold nothing between runs; when a run ends on an
  ask, put the question to the human and start the next run with the
  answer as input.
- **The workflow script**, shipped in the package and written by the
  installer next to the skill. The generic form of `dispatch.js`: a
  coordinator leg (`agentType: "treecontext-leg"`, a schema of `{done,
  next, input, ask, checkpoint}`) names the roles to spawn and the brief
  to give them; each named role runs fresh by `agentType` with the brief
  verbatim; a fresh coordinator reads their reports; the loop ends on
  `done`, an `ask`, the spawn cap, or a cut coordinator, whose successor
  is told to recover its checkpoint from the journal (§3.1). The
  structured return replaces DAWN's hand-off line; DAWN's `parseHandoff`
  grammar stays DAWN's.
- **`~/.claude/agents/treecontext-leg.md`**, the coordinator's agent
  definition (§3.2): `omitClaudeMd`, a `tools:` line with the four
  treecontext tools, and the contract text. A user's own roles need no
  treecontext tool; the coordinator writes the journal copy.
- **The checkpoint convention** (§3.3) in the reference skill and the
  managed block.

Where the journal fits: the coordinator's checkpoint goes forward in
the script and into the journal under `kind: "checkpoint"`, `key`, `seq`,
`run`; every leg's trail is captured by the hooks under its role and
agent id; a coordinator's structured return becomes its summary (Change
B); a fresh coordinator's default search is its role's prior trail and
the plan, which Change D protects.

**What this does to the charter.** A shipped skill is agent-facing
prose, and the house rule for that surface is that it gets measured,
not assumed (the t10 lesson behind the brief handshake). It also
depends on the `Workflow` tool, which exists on Claude Code alone, so it
is advertised for the reference platform only (D30). Two consequences:

1. The scenarios bind on what the installer writes and on what the hooks
   and the store do with payloads of the shapes the probe recorded
   (fixtures from Appendix A), never on a live run; the live run is the
   owner's dogfood, as D188 settled for the reply after a clear.
2. It ships **experimental first**, behind a flag, the way unverified
   capture does (`--experimental-capture`, D208): `treecontext install
   --experimental-dispatch` writes the three files and says so; nothing
   is advertised until the owner has run a long task through it and a
   tester has too. The fence's rule that unverified means unadvertised
   (D30) covers it until then.

**Two-way with DAWN.** DAWN's dispatch is in heavy development and
treecontext mirrors none of it. What flows from DAWN: the leg shapes it
finds in use (Q11), defects in capture it meets first (§3.13's table),
and the grammar lessons that survive generalization. What flows to
DAWN: the shipped script, if DAWN's grammar can be expressed on top of
it, and the capture fixes it gets for free. Neither waits on the other.

---

## 4. What this program does not do

- It does not give a running subagent a way to clear its context. Claude
  Code has none; a leg ends and a fresh one starts.
- It does not make the journal the primary carrier of leg state. The
  script is; the journal is the durable copy and the recovery path.
- It does not measure a leg's context from inside treecontext (§3.9),
  until a tester's evidence says the recipe alone is not enough.
- It does not change who may write what: a leg writes in its own lane,
  references others', and retires nothing of the orchestrator's (D169).
- It does not promise anything on clients other than Claude Code (D30,
  D153). §9.7 (R6) asks whether that moves for a tools-only worker.
- It does not mirror DAWN. DAWN's dispatch keeps its grammar and its
  governance; treecontext ships the generic skill and takes DAWN's
  findings as one consumer's among several.

---

## 5. Questions for beta testers

- **Q1.** Do your long legs actually compact? Run the script in Appendix
  A.3 over your subagent transcripts and report the `compact_boundary`
  count per run. If it is zero, §3.9 stays deferred.
- **Q2.** Does the script-carried checkpoint (§3.0) fit your workflows,
  or do you have legs whose state cannot be returned as a structured
  value (too large, binary, not yours to summarize)?
- **Q3.** Is "recover from the journal" an acceptable second path, or
  must a cut leg's next leg find its state without calling a tool?
- **Q4.** The checkpoint ask on `SubagentStop` (§3.6) blocks a finishing
  leg once. Acceptable as opt-in? Never acceptable? Should it apply only
  to legs of a named agent type?
- **Q5.** How should a phantom registration be retired (§3.7): on the
  workflow's completion, by age, both, or never (leave the heal to it)?
- **Q6.** The orientation change (§3.8) makes `treecontext_status` answer
  a subagent differently from the orchestrator. Does any of your
  orchestration rely on a subagent seeing the whole pointer list?
- **Q7.** Is `omitClaudeMd` acceptable for your legs, or do your legs
  need the project's `CLAUDE.md` rules? If they do, §3.8's one-line
  exemption has to carry the whole weight.
- **Q8.** Do you want `agent_type` and `run` in the handoff file's
  summaries export, so a run's legs can be handed to a teammate as a
  unit?
- **Q9.** Name your concurrency: how many legs in flight, how many per
  run, how long a leg. The figures size the phantom-age default and the
  retention guidance.
- **Q10.** Anything in §1 that does not match what you see on your
  machine, with the Claude Code version.
- **Q11 (for the dawn developer).** Where does context fill in a
  revisit: the main session across dispatcher runs, the Change Manager
  reading the reports, or one role's pass? The query in Appendix A.4
  gives per-leg sizes from your own store; the script in A.3 gives
  compaction counts from your transcripts. And: would you give the roles
  `treecontext_query` (§3.13, item 1)?
- **Q12.** A shipped `treecontext-dispatch` skill (§3.14): would you use
  it as is, with your own roles by `agentType`? What does its `args`
  need beyond `{run, task, targets, cap, date}`? Is a structured
  `{done, next, input, ask, checkpoint}` return enough, or does your
  coordinator need a free-text line as DAWN's does?

---

## 6. Named assumptions about Claude Code

Each was verified on 2.1.300, Linux, headless `claude -p`, on 2026-10-15
unless stated. A later Claude Code may change any of them; the probe in
Appendix A re-checks them in under a minute.

1. Workflow legs fire the subagent hooks with `agent_id`, `agent_type`
   and the parent's `session_id` (§1.1).
2. A schema leg's `SubagentStop` carries no `last_assistant_message`
   (§1.2).
3. `maxTurns` and a `PostToolBatch` exit 2 end a leg without
   `SubagentStop`, and `agent()` resolves `""`; with a schema, `maxTurns`
   throws (§1.3).
4. `decision: "block"` on `SubagentStop` sends a leg back once, and the
   second stop carries `stop_hook_active: true` (§1.3).
5. `omitClaudeMd` and `maxTurns` from an agent definition apply through
   `agentType` (§1.4).
6. `usage` with cache fields is on every assistant entry of a leg's
   transcript (§1.9).
7. `SubagentStart` input carries no prompt (docs and probe).
8. `SubagentStart` `additionalContext` reaches the subagent (probe of
   2026-09-25 with the `Agent` tool; not re-run under a workflow).
9. Interactive sessions behave as headless ones for all of the above.
   Unverified; the owner's dogfood sessions are the evidence to come.

---

## 7. Sizing against beta.3 and beta.4

beta.3 already opens with the switch to `node:sqlite` (ruling of
2026-10-11), and the scope session before it rules on N19 and N22 (D267).
This proposal seeds the same session.

The owner's sequencing (2026-10-15): the `node:sqlite` switch lands
first. It rewrites the hook database layer every change below touches,
so none of this is built before it.

**Fits beta.3** (small, hook- and surface-level, no migration, each a
day or less with its scenarios): Change A (metadata-only lookup), Change
B (structured return as summary), Change D (phantom retirement), the
recipe, the definition, the convention and the reference-skill text.
These fix things that are wrong today for anyone orchestrating with
workflows, whether or not they adopt bounded legs.

**beta.3 if the testers say yes to Q4 and Q6, else beta.4:** Change C
(the checkpoint ask) and Change E (subagent orientation). Both change
what an agent experiences, so they need tester consent and the drift
test's extension.

**beta.3 as experimental, beta.4 as a promise:** the shipped dispatch
skill (§3.14). Writing the three files and the installer flag is a day
or two; what takes longer is the dogfood that earns advertising, and the
scenarios that bind on the installer and the fixtures. It goes in behind
`--experimental-dispatch` as soon as the sqlite switch and Changes A, B
and D are in, and loses the flag when the owner and one tester have run
a long task through it.

**beta.4 or never:** the watchdog (§3.9), gated on Q1.

If beta.2 draws many bug reports, the beta.3 cut is A, B, D and the
documentation; the rest waits.

§9.9 sizes the addendum: the Codex installer fixes fit beta.3 beside A, B
and D; the ticket door only with R1 to R3 ruled.

---

## 8. What changed from the first draft, and why

| First draft | Disposition | Why |
| :-- | :-- | :-- |
| D1 second `contributor` server `treecontext-leg` | Withdrawn | On the fence (D124). The `tools:` allowlist gives the same bound (§3.2). |
| D2 `checkpoint` kind, `key`/`seq`, exact-lookup mode | Reduced to Change A | D268 already filters in SQL; only the empty-query case is missing. The convention needs no new kind in the store (§3.3). |
| D3 lane per `agent_id` | Withdrawn | Contradicts D167; the id is on every row and the trail is exportable by id (§1.1). |
| D4 `SubagentStart` injects the checkpoint | Withdrawn | The script carries the checkpoint in the prompt (§3.0); the hook has no prompt to find a key in (§1.1). `brief_for` remains for role briefs. |
| D5 watchdog in `post-tool-use` | Deferred (§3.9) | Feasible (usage is in the transcript) but costly per event and unneeded until Q1 says otherwise. |
| D6 `SubagentStop` guard | Kept as Change C, opt-in | Verified in a workflow; reframed as the existing bookmark ask applied to legs. Cannot catch a `maxTurns` cut (§1.3). |
| D7 per-run retention budget, newest-checkpoint guard | Withdrawn | Premise inverted: legs share the session (§1.6); `decay_exempt` exists. |
| D8 skill and block text | Kept, extended (§3.3, §3.8) | And the block learns what a subagent is. |
| (not in the first draft) | Change B, Change D, Change E | Found by the probe and the code read: the schema leg's lost summary, the phantom registration, the orientation tax. |
| (not in the first draft) | §9, 2026-10-27 | Tester reports after the draft: headless workers are the common mechanism and have no identity door; the Codex installer findings. |
| Script shape with `stallMs`, journal-only state | Replaced by §3.1 | `stallMs` is not in this runtime's option list; `agentType` is and was missing; `try/catch` is required by §1.3. |

---

## 9. Addendum of 2026-10-27: headless workers, and the doors into the store

Added after two tester reports that arrived between the draft and
2026-10-27, and an owner discussion on 2026-10-27. Nothing here is
decided either. §9.7 lists the rulings this addendum asks of the scope
session and §9.8 the questions it adds for testers. The `node:sqlite`
switch (D278) has landed on `beta.3/node-sqlite` since §7 was written,
so the sequencing §7 names is met.

### 9.1 What the testers report

Two things, from different testers.

- A build pipeline runs Codex headless (`codex exec`) beside Claude Code
  sessions, sharing one store, tools only. The report is in §9.2,
  verified against the tree on 2026-10-26.
- Headless CLI calls (`claude -p`, `codex exec`, `agy -p`) are the
  common subagent mechanism, more common than the Agent tool or the
  Workflow tool. Orchestration harnesses (t3code, a TypeScript monorepo,
  among others) treat the headless CLI as the universal backend: every
  CLI agent has one, it is the same call on every OS, and a harness
  needs nothing else from the client.

The owner's framing (2026-10-26): the "main" CLI, the one orchestrating,
can itself be any of Claude Code, Codex or Antigravity, and each can
call any of the others. A design that assumes Claude Code is the parent
does not serve these testers.

§1 to §8 cover the Agent tool and the Workflow tool, both on Claude
Code, both reaching the store through the hooks. §9 is about the third
population.

### 9.2 The Codex headless report, verified

Codex CLI 0.164.0, ChatGPT login, macOS 26, treecontext beta.2. The
tester dry-ran `install --agent codex`, saw it would not serve the
setup, registered the server by hand, and uses four tools. Six findings,
each checked against the code; the fix in each is a recommendation.

1. **Blocker: headless Codex refuses every tool call** with "MCP tool
   call requires approval, but approval policy is never". The installer
   writes only `command` and `args` for the Codex table. Confirmed. The
   charter already promises tools-only use on Codex (D152, D161), so
   this is a failed promise, not new scope. Fix: write
   `default_tools_approval_mode = "approve"` in the Codex table. Leave
   `enabled_tools` to the user, since `serve --policy` is the
   client-agnostic lever, but document it in the clients row. Check the
   value set against the installed Codex: the published docs say
   `auto|prompt|approve`, the tester reports `prompt|writes|approve` on
   0.164.
2. **Codex lands in a different store from Claude Code.** Working as
   designed, not a Codex defect. A store is bound by the fingerprint of
   the working directory or git remote; the tester's Claude sessions
   start in `~`, so a path-bound home store holds every project's
   journal, while the repository binds by remote. Two Claude Code
   sessions would split the same way. Doctor's split-candidates check
   only pairs the path and git bindings of one project, so this split
   is invisible to it. Fix: `install --store` and `--project-dir`
   pass-through for the entry (the tester pinned `--store` by hand),
   README guidance, and a doctor row that says "this directory's store
   is bound to your home directory".
3. **The global `~/.codex/AGENTS.md` runs the orientation routine on
   every Codex run**, short blind sub-runs included: status, an export
   per pointer, a query, about 14k input tokens per model call on a
   metered plan, and other projects' pointers pulled into runs meant to
   be blind. Confirmed: `install` always upserts the instructions block
   there. `serve --instructions none` exists; `install` has no way to
   ask for it; `treecontext init` already writes a per-project file.
   This is the orientation tax of §3.8 seen on a second client. Fix:
   `install --no-instructions`, or Codex defaults to the per-project
   `init`; doctor treats "tools only, no orientation" as a chosen state
   rather than a missing channel.
4. **Re-running `install` clobbers a customised entry.** Confirmed, and
   the JSON upsert has the same shape as the TOML one: an entry lacking
   `--capture`, or with a stale command, is replaced wholesale, which
   drops the approval mode, `enabled_tools`, a pinned `--store` and
   `--instructions none`. The charter says existing configuration is
   merged, never clobbered, and reinstalling converges. Fix: converge
   only the keys the installer owns (command, owned args), keep the
   rest, report "present, customised".
5. **`--capture` is written for every agent, Codex included**, while
   capture is verified on Claude Code only. Confirmed. With no Codex
   hooks the flag only makes that server run the ingestion loop and
   compete per tick for the store's drain lease; when it wins it drains
   the rows Claude's hooks staged. Safe by design (claims, lease, one
   drain, attribution from the staged payload) but pointless, with a
   5 s poll and sidecar pane writes. Fix: write `--capture` (and
   `--debug`) only for capture platforms, or behind
   `--experimental-capture`; scope doctor's mode check the same way.
6. **No CLI way to print one entry.** `export` requires a handoff path,
   and raw SQLite shows the zstd codec rather than the text. Fix:
   `treecontext export --node <id>` to stdout; the README names the
   codec and the library door.

Five of the six are installer fixes, a day together with their
scenarios; the sixth is a CLI flag. None needs a ruling. They are sized
in §9.9.

### 9.3 The finding that matters: a headless worker has no identity door

A headless foreign-client worker (`codex exec`, `agy -p`) writing into
the shared store has no way to say who it is. Its server has no hooks,
so no `SubagentStart` registers it, no echo heal corrects it, and the
MCP request carries no identity. What happens instead, verified in the
code:

- When one Claude Code session is live in the same directory within the
  beacon's window, the beacon's third rung stamps the worker's inserts
  with that session's id, the writer resolver reads that as "self", and
  the rows land in the orchestrator's main lane as the orchestrator's
  own words. Nothing ever corrects it.
- With no live beacon the rows land unregistered, which is also the
  main lane.

Lanes (D147, D148, D150) are therefore invisible to exactly the workers
the testers are building. A `claude -p` child is the same case in
reverse: it has hooks and a beacon of its own, so it becomes a session
of its own rather than a worker under the parent that spawned it.

Rule 4 of the working guidance (a writer is never trusted from a caller)
is about the insert payload. A declaration set by whoever configures the
run, read by the server at startup, is the same trust level as the hook
payload. That is the distinction §9.7 asks the scope session to rule on.

### 9.4 One lane model, three doors

Terms first, because the testers' word for this was "lane" and the
store already uses it. A **lane** is a thing in the store: a session id
plus a writer, the namespace that supersession and "shown as written
by" respect. A **door** is the path a row takes into the store. There
is one lane model and three doors, and a row written by a Codex worker
through the launcher should land in the same shape of lane, under the
same parent, with the same stamp keys, as a row written by a Claude
subagent through the hooks.

- **The hooks door.** Learns the store from the payload's `cwd` through
  the bindings fingerprint, and the writer from the payload's session id
  and agent id. Claude Code only. Verified. Workflow legs come through
  it today (§1.1); their gaps are Changes B and D.
- **The MCP door.** Learns the store from the serve arguments or the
  auto-store resolved at serve time, and the writer from the session
  registry and the beacon rungs. Exists. Weak for a headless foreign
  client, because that client wrote no beacon, so the server falls to
  the ambiguous rung and guesses (§9.3).
- **The ticket door.** New; §9.5. Learns both from the thing that
  spawned the worker.

The machinery is shared. Each door differs only in how it learns two
facts: which store, and who is writing. The reading side has no door of
its own: everything reads through the query tool or the library, and the
parent sees a worker's return as a subagent summary row in the worker's
lane, the same row a hooks-registered subagent leaves today.

The analogy carries one step further. The **signage** is what the door
reads; the **stamp** is what the store writes on the row. Keeping those
apart is what lets rule 4 survive.

| Signage, read by the door | Stamp, written by the store |
| :-- | :-- |
| Which building: the store path | `_writer`, `_writer_src` and the rest of the stamp keys |
| Which room: the parent's session id and writer | the session id the row lives under |
| Who is knocking: role, agent id; and as corroboration pid, cwd, worktree, branch | the source the stamp came from (hook, self, echo, ticket) |
| The errand: the brief, which `brief_for` already hands a role | |

A caller's copy of any stamp key is still dropped. The ticket door does
not change that rule; it gives the server a second place to read the
signage.

One caveat on the pid. It is a strong fact on one host and no fact at
all across hosts or after a restart, which is why the beacon already
treats it as the top rung only while it matches a live process. The
signage therefore carries the writer id as the durable name, with the
pid as corroboration, not as the key. The headless worker is exactly the
case where the pid is missing or belongs to a different client.

### 9.5 The worker ticket: declared, not discovered

The pid trouble came from discovery: a hook or a server working out,
after the fact, which process it belongs to. Discovery is OS-specific by
nature (process trees, parent pids, liveness checks), and it fails
quietly when the client is not the one that wrote the beacon. The
headless call is OS-independent, but discovering its metadata would not
be.

The way around it is to declare. The thing that spawns the worker
already knows everything the signage needs before the worker exists:
the parent's store and writer, the role, the brief, and the child's pid
the moment spawn returns. So the primitive is a **ticket**, not a
command line: a registration under a parent, with a role and a brief,
that yields the small set of facts the child needs (store path, writer
id, parent). The ticket travels as an **environment block**, because
environment inheritance is the one carrier every spawner and every CLI
honours on every OS. Anything that can set an environment is then a
launcher.

Three producers of the same ticket; a harness picks the one that fits.

- **Library.** A harness in TypeScript (t3code is one) calls something
  like `registerWorker({ role, brief })` on an open store and gets back
  the environment block and a `retire` function. It spawns the child
  itself, with its own process handling, and calls `retire` with the
  exit code and the captured stdout. No shell, no arguments. This is
  what design decision 5 asks for: the server is one consumer, not a
  gatekeeper.
- **CLI.** `treecontext run --role <r> -- <cli> ...` is a thin wrapper
  over the library call, for shell scripts and for harnesses not in
  Node. The fallback, not the design.
- **Claim.** For a harness that spawns workers where treecontext cannot
  wrap the spawn at all, the parent mints the ticket and the child
  claims it: its server is started with a claim token, or it runs
  `treecontext claim` first. Spawn and registration are decoupled. This
  is the door for a worker started by something treecontext has never
  heard of.

One convenience worth keeping on the table: **the working directory as
the signage.** Harnesses usually give each worker its own worktree, and
the hooks already read the worktree and branch for a session's
registration. A parent could drop the ticket in a file under the
worker's directory and the child's server would read it at startup. No
arguments, no environment, fully portable. The cost is that two workers
in one directory collide, so it serves the worktree-per-worker pattern
only. It ships as a convenience over the ticket, not instead of it.

The consumers are two: the server and the hooks learn to read a ticket
from their environment at startup, with the claim token as the second
spelling. Everything else is a producer and can be added without
another ruling.

Lifecycle comes for free on this door. The producer holds the child's
process handle, so it does not ask the OS whether the worker is alive.
It retires the registration when the child exits, with the exit code,
and stages stdout as the worker's return: the subagent summary row. That
is the gap the Workflow legs have today (§1.3, Change D), solved here
without a watchdog.

What does not work: identity in the prompt text, because the model may
drop it and the store cannot trust caller metadata; and a per-client
`env` in the MCP config, because that is static per client, not per
worker.

### 9.6 What stays platform-flavoured

Narrow, and in one place rather than in every hook:

- **A bare headless call** that goes through no ticket. A `codex exec`
  typed into a shell has no signage, so it still lands on the ambiguous
  rung. That is the testers' current reality and stays best-effort.
- **The top-level parent's own identity** when the main CLI is not
  Claude Code. A Codex main has no hooks and writes no beacon, so the
  ticket producer must learn the parent from the serve-time facts or
  from an explicit argument. This is the parent-agnostic ruling, R3.
- **Signals and the exit path**, which differ a little by platform; the
  producer owns them.

### 9.7 Rulings asked of the scope session

- **R1. A ticket in the environment is a trust source.** The server and
  the hooks accept a worker ticket from their environment at startup, on
  a par with the hook payload and distinct from caller metadata. Rule 4
  stands: the insert tool still drops a caller's stamp keys.
- **R2. The ticket's shape and spellings.** Library first; the
  environment block as the carrier; the CLI launcher and the claim token
  as spellings of the same thing; the directory file as a later
  convenience (§9.5).
- **R3. The parent-agnostic parent.** How a main session that is not
  Claude Code is identified, so a Codex or Antigravity orchestrator can
  mint tickets: a serve-time declaration, an explicit argument, or both.
- **R4. What a `claude -p` child is.** Today a session of its own, with
  its own beacon. Under a ticket it is a worker under the parent that
  spawned it. The ruling says which wins when both apply.
- **R5. Antigravity.** An archived-build platform in the agent table.
  Does `agy -p` as a ticketed worker reopen it as a tools-only client?
- **R6. The clients fence.** §4 says this program promises nothing on
  clients other than Claude Code (D30, D153). The charter already
  promises tools-only use on Codex (D152, D161); R1 extends that to
  identity. Does the fence move, and for which clients?

### 9.8 Questions for beta testers, continued

- **Q13 (Codex tester).** With the approval mode and `--store` written
  by `install`, does anything remain that you set by hand? Which
  `enabled_tools` do your blind runs use?
- **Q14.** What spawns your workers: your own code (which language), a
  harness (which), or a shell script? The answer picks the ticket
  producer you would use (§9.5).
- **Q15.** Does each worker get its own directory or worktree, or does
  it share the parent's? This decides whether the directory file is
  worth shipping.
- **Q16.** What should the parent get back from a worker: stdout as is,
  a structured return, or both? And in whose lane should it sit, the
  worker's or the parent's?
- **Q17.** Is the orientation tax on a headless worker acceptable at
  all, or must a ticketed worker get the subagent lines of §3.8 by
  default, on every client?

### 9.9 Sizing, continued

- **Fits beta.3, no ruling needed:** the installer fixes 1, 3, 4 and 5
  of §9.2 and `export --node`. A day or two with scenarios, and they
  mend promises the charter already makes.
- **beta.3 only if R1 to R3 are ruled at the scope session**, and after
  Changes A, B and D: the ticket door's two consumers (server and hooks
  read the environment) and the library producer. Behind an experimental
  flag first, as the dispatch skill is (§3.14); the CLI launcher comes
  with it since it is a wrapper.
- **beta.4:** the claim token, the directory file, and whatever R4 to
  R6 open up.

---

## Appendix A. The probe

### A.1 Recipe

A throwaway project directory with: a raw-logger hook on every event
(`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PostToolBatch`,
`SubagentStart`, `SubagentStop`, `PreCompact`, `Stop`) that appends
`<ns-timestamp>\t<event>\t<payload>` to a file; a `PostToolBatch` hook
that exits 2 once for `agent_type` `leg-hard`; a `SubagentStop` hook that
prints `{"decision":"block","reason":…}` once for `agent_type` `leg-ask`;
a `CLAUDE.md` with a marker line; three agent definitions under
`.claude/agents/`: `leg-worker` (`maxTurns: 2`, `omitClaudeMd: true`),
`leg-hard`, `leg-ask`. Then:

```bash
claude -p "<prompt asking for one Workflow call with the script below>" \
  --output-format json --setting-sources project --strict-mcp-config \
  --allowedTools "Workflow,Bash(echo:*),StructuredOutput,ToolSearch,Read" --max-turns 12
```

The workflow script (six legs, sequential so the log reads cleanly):

```javascript
export const meta = { name: 'tc-probe', description: 'treecontext feasibility probe' }
const LEG = { type: 'object', required: ['done','next','checkpoint'],
  properties: { done: {type:'boolean'}, next: {type:'string'}, checkpoint: {type:'string'} } }
const out = {}
out.w1 = await agent('Run `echo leg-1` once. Then return done=false, next="continue", checkpoint="CKPT-ONE".', { label: 'w1-schema', schema: LEG })
out.w2 = await agent('Run `echo turn-A`. In a later turn run `echo turn-B`. In a third turn run `echo turn-C`. Then answer DONE-W2.', { label: 'w2-maxturns', agentType: 'leg-worker' })
out.w3 = await agent('Run `echo leg-3` once, then answer W3-REPORT.', { label: 'w3-default' })
out.w4 = await agent('Run `echo leg-4` once, then answer W4-REPORT.', { label: 'w4-hard', agentType: 'leg-hard' })
out.w5 = await agent('Run `echo leg-5` once, then answer W5-REPORT.', { label: 'w5-ask', agentType: 'leg-ask' })
out.w6 = await agent('Run `echo six-A`. In a later turn run `echo six-B`. In a third turn run `echo six-C`. Then return done=true, next="none", checkpoint="CKPT-SIX".', { label: 'w6-maxturns-schema', agentType: 'leg-worker', schema: LEG })
return out
```

A first run with a malformed `settings.json` (a quoting slip) ran the
workflow with no hooks at all and still answered the transcript
questions; Claude Code logged `Invalid setting skipped without dialog
(automated session)` and carried on. Worth knowing: a broken project
settings file silently disables every hook in headless mode.

### A.2 Timeline (second run, 37 events, times from `SessionStart`)

```
     0 ms SessionStart     source=startup
   295 ms UserPromptSubmit
  7109 ms PostToolUse      Workflow (the orchestrator's call)
  7137 ms SubagentStart    a24972ae workflow-subagent         (w1)
  8294 ms Stop             main; the workflow keeps running
  9236 ms PostToolUse      a24972ae Bash `echo leg-1`
 10851 ms PostToolUse      a24972ae StructuredOutput
 10867 ms SubagentStop     a24972ae  last_assistant_message ABSENT
 10896 ms SubagentStart    a8b00686 leg-worker                (w2)
 12371 ms PostToolUse      a8b00686 Bash `echo turn-A`
 13979 ms PostToolUse      a8b00686 Bash `echo turn-B`
                           (no SubagentStop: maxTurns 2 reached; agent() → "")
 13997 ms SubagentStart    aaa1eb5f workflow-subagent         (w3)
 15854 ms PostToolUse      aaa1eb5f Bash `echo leg-3`
 16867 ms SubagentStop     aaa1eb5f  last_assistant_message "W3-REPORT"
 16879 ms SubagentStart    a5eb6484 leg-hard                  (w4)
 18448 ms PostToolUse      a5eb6484 Bash `echo leg-4`
 18455 ms PostToolBatch    a5eb6484  hook exit 2
                           (no SubagentStop; agent() → "")
 18473 ms SubagentStart    a5385d05 leg-ask                   (w5)
 20035 ms PostToolUse      a5385d05 Bash `echo leg-5`
 21033 ms SubagentStop     a5385d05 "W5-REPORT"  hook → decision block
 24474 ms PostToolUse      a5385d05 Bash `echo CHECKPOINT-WRITTEN`
 24998 ms SubagentStop     a5385d05 "ASK-DONE"  stop_hook_active=true
 25022 ms SubagentStart    af8afdfa leg-worker                (w6)
 29922 ms PostToolUse      af8afdfa Bash `echo six-A`
 31538 ms PostToolUse      af8afdfa Bash `echo six-B`
                           (no SubagentStop; the workflow threw at agent())
 31673 ms UserPromptSubmit the task notification
 34608 ms Stop
```

Every `PostToolUse` and `PostToolBatch` above carried `agent_id`,
`agent_type` and the parent's `session_id`. `PostToolBatch` also carried
`tool_calls`, `effort` and `permission_mode`; `SubagentStop` also
`agent_transcript_path`, `background_tasks`, `session_crons`. The
workflow's own `journal.jsonl` recorded `""` for w2 and w4, `"ASK-DONE"`
for w5, and `failed` for w6, with the error quoted in §1.3.

### A.3 Measuring compaction in your own runs

```bash
# count compaction events per subagent transcript under a project
for f in ~/.claude/projects/<escaped-project-dir>/*/subagents/**/agent-*.jsonl; do
  n=$(grep -c '"compact_boundary"' "$f"); [ "$n" -gt 0 ] && echo "$n $f"
done
# context size at a leg's last call: sum of the three usage fields on its last assistant entry
```

### A.4 Per-leg sizes from a store

Read-only, against a copy or with the store idle. Each row is one
subagent instance: its role, how many events the hooks captured for it,
and how long it ran.

```sql
SELECT json_extract(metadata_json, '$._writer')          AS role,
       json_extract(metadata_json, '$._writer_agent_id') AS agent_id,
       COUNT(*)                                          AS events,
       ROUND((MAX(created_at) - MIN(created_at)) / 60, 1) AS minutes,
       SUM(LENGTH(content))                               AS stored_bytes
FROM nodes
WHERE source_label = 'auto-capture'
  AND json_extract(metadata_json, '$._writer_agent_id') IS NOT NULL
GROUP BY agent_id
ORDER BY events DESC
LIMIT 40;
```

`stored_bytes` counts stored content, which may be zstd-encoded for
larger rows, so it is a floor on the captured size, not the leg's
context. The transcript `usage` fields (A.3) give the context.

---

## Appendix B. Glossary

- **Leg** — one `agent()` call in a workflow script; a fresh context.
- **Checkpoint** — a curated entry a leg writes with `kind: "checkpoint"`
  and a handoff `key`; also the structured value the leg returns.
- **Handoff key** — `<run>:<target>`, deterministic, chosen by the
  script; ties a target's legs together.
- **Cut leg** — a leg that ended without returning: turn cap, batch
  hook, stall restart, crash.
- **Recovery leg** — the leg after a cut one; its prompt tells it to read
  the newest checkpoint under the key from the journal.
- **Phantom registration** — a `session_registry` row for a subagent
  whose `SubagentStop` never fired.
- **Orientation tax** — the tokens a subagent spends obeying the
  session-start protocol written for the orchestrator.
- **Headless worker** — a subagent run as a one-shot CLI call
  (`claude -p`, `codex exec`, `agy -p`) by a harness or a script; any
  CLI may be the parent.
- **Door** — the path a row takes into the store: the hooks, the MCP
  tools, or a ticket. One lane model behind all three (§9.4).
- **Signage** — what a door reads to learn which store and who is
  writing; distinct from the stamp the store writes on the row.
- **Ticket** — a worker's registration under a parent, handed to the
  child as an environment block by whatever spawned it (§9.5); the CLI
  launcher and the claim token are spellings of it.
