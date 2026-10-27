# Bounded-leg subagents: measurements and a field report from DAWN

For Bing, from Larkin. 2026-10-15. Against your draft "Bounded-Leg Subagents with Journal-Backed Resume" (treecontext-mcp 0.1.0-beta.2).

Two things we can give you today: answers to both Phase 1 unknowns, measured on Claude Code 2.1.299, and a field report from DAWN's dispatcher, which has been running your pattern since 2026-10-13 (fresh agent per hand-off, state held outside the transcript, a script holding the loop).

## 1. Phase 1 unknown (a): usage in subagent transcripts

Yes. Scanned every subagent transcript under one project's `~/.claude/projects` tree.

| Measure | Value |
| :-- | :-- |
| Subagent transcripts | 753 |
| Carrying `message.usage` on assistant messages | 738 |
| Fields present | `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens` |

Live context is the sum of the three input fields on the last assistant message. The 15 without usage were short-lived agents that never reached a model reply.

Compaction is recorded in the transcript too, as an entry carrying `compactMetadata` with `trigger`, `preTokens`, `durationMs`, `preservedSegment` and `preservedMessages`. So your success metric 1 is observable after the fact without instrumentation, and the watchdog can read exact tokens rather than byte size.

| Compactions observed | Value |
| :-- | :-- |
| Agents that compacted | 5 (one of them 3 times) |
| Trigger | `auto`, all 8 events |
| `preTokens` at compaction | 966,095 to 1,006,558 |
| Compaction duration | 47.6 s to 112.1 s |
| Agent shape | interactive Opus subagents, 373 to 1,241 turns |

Every compaction happened at the 1M mark on a 1M-window model. None happened in a workflow leg.

## 2. Phase 1 unknown (b): what `agent()` resolves to when a hook exits 2

Setup: a throwaway project with project-scoped hooks, a one-agent workflow run through the Workflow tool with `scriptPath`, Haiku 5.5, headless `claude -p`. The agent's task was three `echo` commands then a structured return. The hook acted only when `agent_id` was present, so the parent session was untouched. Each row is one run.

| Hook event and action | What the agent saw | Outcome |
| :-- | :-- | :-- |
| `PostToolBatch` exit 2, `agent()` with `schema` | nothing; no model turn after the halt | run `status: failed`, `result: null`, error `agent({schema}): subagent completed without calling StructuredOutput (after in-conversation nudge)`; journal `failed` |
| `PostToolBatch` exit 2, no `schema` | nothing | run completed; `agent()` resolved to `""` (empty string) |
| `PostToolUse` exit 2 | a `<system-reminder>` "hook blocking error" with the stderr text | agent read it and continued; its words: "That isn't part of your task, so I'm ignoring it" |
| `PostToolUse` `additionalContext`, rigid task, no contract in prompt | a `<system-reminder>` "hook additional context" beside the tool result | ignored; ran 3 of 3 |
| `PostToolBatch` `additionalContext`, rigid task, no contract | same form | ignored; ran 3 of 3 |
| `PostToolUse` `additionalContext`, open task (count to 20), no contract | same form | ignored; ran 20 of 20 |
| `PostToolUse` `additionalContext`, open task, your §3.4 contract in the prompt | same form | stopped after 1, returned `halted` |
| `PostToolBatch` `additionalContext`, open task, contract in the prompt | same form | stopped after 1, returned `halted` |
| `SubagentStart` `additionalContext` carrying a checkpoint ("1 to 5 done, continue from 6") | before the first prompt | honored; ran 6 to 20, returned `calls: 15` |

What this settles:

- **Your hard stop (§3.5, optional) is a kill, not a ceiling.** Exit 2 on `PostToolBatch` stops the loop with no model turn after it, so no checkpoint can be written. With `schema` the whole run fails; without it the leg returns an empty string. Neither is the agent's last output. Drop it.
- **Your soft stop works, and the contract is the load-bearing part.** `additionalContext` reaches the agent in every variant, but the model treats hook text as low authority and says so. It stops only when the leg's own prompt told it in advance that such a note means stop. Keep §3.4's sentence "If a tool result tells you to checkpoint and return, do that immediately" and consider making it the first line of the system prompt, not the last.
- **D4 works end to end.** A checkpoint injected at `SubagentStart` steered the leg. The agent did not even need to query.
- **`PostToolBatch` has no matcher and fires inside workflow agents** with `agent_id`, `agent_type` and `tool_calls` in the payload. One more fact for your §2.1 table.

Two payload facts that bear on D3 and D4:

- **`agent_type` for a script-prompted workflow leg is the literal `workflow-subagent`**, not the label. A leg spawned with `agentType: "srs-writer"` carries that name instead. So per-type lanes would fold every anonymous leg of a run into one lane. D3's per-`agent_id` lane is necessary, not just tidier.
- **At `SubagentStart`, `transcript_path` is the parent session's transcript**, not the subagent's, and the payload has no label or prompt. Payload keys: `session_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `prompt_id`, `agent_id`, `agent_type`, `hook_event_name`. The subagent's own files land at `<session>/subagents/workflows/<run>/agent-<agent_id>.jsonl` with a sidecar `agent-<agent_id>.meta.json` holding `agentType`, `description` (the `label` you passed) and `workflowPhase`. The sidecar is written about 275 ms after the `SubagentStart` hook runs, so the hook cannot read it synchronously. Options for D4: the key rides in `label` and the hook polls briefly for the sidecar by `agent_id`; or the key rides in an environment variable the workflow sets; or the leg queries by key itself, as §3.4 already says, which the `SubagentStart` result shows is not needed once injection works.

One schema note: Haiku twice returned the whole JSON object as a string inside the `answer` field. Validate the parsed value, not just the shape.

## 3. Field report: DAWN's dispatcher

DAWN runs a workflow script that spawns a Change Manager, parses the one-line hand-off it returns, spawns each role that line names with the line's `input` verbatim as its brief, and loops until a question, a gate, an unparsable line or a spawn cap. Every spawn is fresh. State lives in files in the working tree plus the hand-off line the script carries. No `maxTurns`, no watchdog, no journal lookup.

**It bounds context by construction.** Across one record, 11 runs at a cap of 24 spawns:

| Dispatcher legs | Value |
| :-- | :-- |
| Legs | 284 |
| Compactions | 0 |
| Peak context, median | 63k |
| Peak context, p90 | 130k |
| Peak context, max | 254k |

The bound came from the hand-off scoping each leg's task, not from any ceiling. That narrows where your watchdog earns its keep: legs whose task cannot be pre-scoped, like "migrate this directory", which is exactly your example.

**It does not bound the loop, and that is the failure your §5 table does not list.** The same record ran those 11 runs, 18.6M tokens, with one question to the human, and never converged. Each leg honestly reported "not done", and the loop had nothing else to go on. Your `done` flag is our hand-off line. A leg's own report of whether it is finished is not a brake, because a leg can keep finding more work. `MAX_LEGS` is our spawn cap, and a cap only decides how much you spend before you notice. Two things we are adding and you may want from the start:

- **A convergence measure the script reads**, not the agent: is the state the leg writes shrinking, or still growing? In our case, is the record's open-item count falling run over run.
- **A human gate at a bounded interval**, not only at convergence. We removed the human from the loop and the loop ran until someone looked.

**Validate the checkpoint with a grammar, fail closed.** Our hand-off line is parsed by the script against a fixed grammar, and an unparsable line ends the run. The first dispatched record produced slips a free-text `next` would have swallowed. Your `{done, next}` schema is the right shape; add the rule that a leg whose checkpoint does not parse ends the run rather than spawning the next leg.

**Journal versus file plus script-held line.** Both are deterministic-key designs. D2's key is our stem plus step. We never needed lookup because the script carries the whole hand-off to the next leg and the state is a file the next leg reads by path. Where the journal wins: many parallel targets, no shared tree, and a leg that needs its predecessor's reasoning rather than its output. Where the file wins: one target, a reviewable artifact, and a human who can read the state without a tool. Worth a sentence in §3.2 on which you are in.

## 4. What we can offer next

- The dispatcher as a pilot workload: a real 24-leg loop with structured hand-offs and 16 runs of baseline already on disk.
- A before-and-after once the loop bound lands: how many runs the same record takes with it.
- The scan script and the probe project if you want to reproduce the numbers.
