# Hook Architecture

> **Which clients have hooks, and how:** the dated [compatibility matrix](../../README.md#compatibility-matrix) in the README, one row per client: its hook events, the documentation checked, its mode, and whether capture there is verified live or documented only.

treecontext uses a three-layer architecture. Each layer works independently —
higher layers build on the base but never break it.

```
┌─────────────────────────────────────────────────────┐
│  Layer 3 — Compaction lifecycle (optional)           │
│  PreCompact → snapshot, compact → rehydrate          │
│  Verified platform: Claude Code                      │
├─────────────────────────────────────────────────────┤
│  Layer 2 — Journaling hooks (near-universal)         │
│  UserPromptSubmit, PostToolUse, Stop,                │
│  SubagentStart/Stop → staging + session registry     │
│  Feeds the journal via the ingestion drain           │
├─────────────────────────────────────────────────────┤
│  Layer 1 — Universal MCP (always works)              │
│  treecontext_insert, _query, _status, etc.           │
│  The journal + AGENTS.md-driven discipline           │
└─────────────────────────────────────────────────────┘
```

## Why layers

The journal is the primitive: one flat SQLite store, no LLM dependency
(the LLM is the caller, not a requirement). Every feature is a thin
function that translates an external event into "write to the journal"
or "read from the journal."

Multi-agent collaboration, conversation capture, and explicit agent
memory look like very different tasks — but they're all namespaces on
the same store:

- **Agent entries** — explicit `treecontext_insert` calls (the *why*)
- **Auto-captured entries** — hook-fed via staging (the *what*), governed
  by the retention valve
- **Sub-agent namespaces** — merged in on purpose via `treecontext_merge_from_agent`
- **Subagent lanes** — a Claude Code subagent shares its orchestrator's
  session and namespace; the store tells them apart by the `_writer` it
  stamps (from the hook payload, or from the session registry and the
  call's echo for a tool-written row), not by a separate namespace
- **Handoff lanes** — entries imported from a teammate's handoff file,
  each in a `handoff:<claimed session>` lane of its own

This means new features add access patterns, not complexity to the store.

## Layer 1 — Universal MCP

Works on any platform that speaks MCP. No hooks needed.

**What you get:**
- `treecontext_insert` — record decisions, rationale, plans, debug trails
- `treecontext_query` — BM25 search with role weights, time ranges, windows
- `treecontext_status` — resume pointers, active work detection
- `treecontext_export` / `treecontext_import` — full-fidelity portability

The agent uses these tools directly, guided by AGENTS.md instructions. This
is the core product — everything else builds on it.

## Layer 2 — Journaling hooks

Passive activity capture via platform hook events. See
[journaling.md](journaling.md) for registration and portability.

**What you get on top of Layer 1:**
- Automatic capture of every user prompt, tool call, and assistant turn-end
- On Claude Code: subagent registration (`SubagentStart`/`SubagentStop`),
  each subagent's report captured as its summary, and every row stamped
  with its writer
- Honest event timestamps, session-scoped dedup, conversation windows
- Gap markers when capture drops something — the journal records its holes

**What you lose without it:**
- Agent must self-report activity via explicit `treecontext_insert` calls

**Platform requirements:** Any event that fires on user input or tool
completion. Every major agent platform has these under different names.

## Layer 3 — Compaction lifecycle

Optional progressive enhancement for managing context window transitions.
See [claude-code.md](claude-code.md) for the reference implementation.

**What you get on top of Layers 1+2:**
- Silent pre-compaction snapshot (cross-session breadcrumb)
- Source-branched rehydration (startup/clear/compact/resume get different payloads)
- After a `/clear`, the re-orientation packet: the chapter summary, the
  bookmark, the newest developer turns and any handoff, within 3000
  characters, following the session's chain of ids across clears
- Checkpoints: the Stop hook asks once for a bookmark when the store's
  interval has passed
- Automatic recovery after compaction via `SessionStart:compact`

**What you lose without it:**
- Agent relies on native compaction (lossy) with no rehydration
- No automatic continuation context after compaction or `/clear`

**Platform requirements:** A pre-compaction event (to save state) and a
session-start event with source discrimination (to rehydrate). Claude Code
is the only verified platform; the opencode plugin implements the full
lifecycle but is unverified scaffolding (see [opencode.md](opencode.md)).

**When new platforms ship compaction events**, adding Layer 3 support is
a small adapter addition. See [adding-a-platform.md](adding-a-platform.md)
and `src/hooks/README.md` for the verification bar.

## Design constraints

1. **Higher layers never break lower layers.** Layer 3 code cannot change
   Layer 1 or Layer 2 behavior. The store, ingestion loop, and MCP tools
   are not touched by compaction lifecycle work.

2. **Shims stay thin.** Hook entry points translate one platform event
   into one journal operation — complexity belongs in `shared.ts`
   primitives or in the store itself, and platform adapters delegate to
   the reference hooks rather than copying them.

3. **Graceful degradation is mandatory.** Every hook exits 0 on error. DB
   unreachable → stderr warning, stdout `{}`. Malformed input → same. Hooks
   must never crash the agent loop.

4. **No blocking compaction.** Never set `decision: "block"` on
   PreCompact — it causes hard failures in the reactive case
   (post-context-error). Let compaction proceed; `SessionStart:compact`
   handles recovery. (The Stop hook's bookmark ask is the one
   `decision: "block"` the hooks emit: on `Stop`, after the response is
   captured, never twice in a row, and never when `stop_hook_active` is
   set.)
