/**
 * Agent-facing instruction strings sent on MCP handshake.
 *
 * One instruction set is served: INSTRUCTIONS_BRIEF_LEXICAL (~25 lines),
 * brief by design. The brevity is measured, not aesthetic: the t10
 * activation eval (420 episodes) showed the brief variant winning
 * activation-all and status-first rates while the verbose variant
 * actively SUPPRESSED memory-necessary activation (55% vs 100%) and blew
 * Claude Code's 2KB instruction cap. The tree-era variants
 * (INSTRUCTIONS_BRIEF / INSTRUCTIONS_VERBOSE) were deleted with the tree
 * backend (deletion phase, 2026-07-25). Prose here has behavioral
 * consequences and gets measured, not assumed
 * (journal-agent-surface.feature).
 */

/**
 * TRIGGER_CORE — the canonical session-start orientation protocol.
 *
 * Single source of truth for the protocol that every instruction channel
 * (server instructions, SessionStart hook reminder, AGENTS.md managed
 * block, skills) must state: the tool order and the gate phrase. Channels
 * word the steps with channel-appropriate framing — full text-level
 * unification is deliberately rejected because the channels legitimately
 * differ in framing. What must not drift is the protocol itself. The drift test
 * (tests/server/instructions-drift.test.ts) asserts each channel mentions
 * these tools in this order before any other treecontext tool and
 * contains the gate phrase; reorder or extend the steps here and the
 * test forces every channel to follow.
 */
export const TRIGGER_CORE = {
  // 1. orientation panel → 2. fetch resume pointers → 3. broad recall
  steps: [
    'treecontext_status',
    'treecontext_export',
    'treecontext_query',
  ],
  gate: 'Only then',
} as const

/**
 * Body of the treecontext-reference skill (Claude Code personal skill,
 * installed at ~/.claude/skills/treecontext-reference/SKILL.md). Carries
 * the deferred reference bulk that was deliberately removed from the
 * always-on instruction channels. States the
 * TRIGGER_CORE protocol first, so it is enforced by the same drift test
 * as the other channels.
 */
export const SKILL_REFERENCE_NAME = 'treecontext-reference'

export const SKILL_REFERENCE_DESCRIPTION =
  'Reference for treecontext working-memory usage: search and role '
  + 'weights, temporal queries (time ranges, chronological ordering), '
  + 'conversation windows, attaching media files, resume-pointer '
  + 'supersession, and the checkpoint protocol (bookmarks, chapter '
  + 'summaries, the first reply after /clear, handoff, doctor). Use when '
  + 'deciding how to query project memory or recording decisions.'

export const SKILL_REFERENCE_BODY: string = [
  '# Treecontext reference',
  '',
  '## Session start protocol',
  '1. treecontext_status — check resume_pointers.',
  '   Fetch each resume pointer via treecontext_export(node_id).',
  '2. treecontext_query("what was I working on, what was the next step").',
  'Only then respond to the user.',
  '',
  '## Search (treecontext_query)',
  'Ranking is BM25 over role-weighted text (user/tool/note full weight,',
  'assistant prose down-weighted). role_weights tunes that per query;',
  'conversation_window returns the entries around each hit, with the',
  'nearest preceding user message as anchor. Recency fusion is on by',
  'default at this surface (recency_weight 0.5): broad orientation queries',
  'like "what was I working on" favor the latest thread over stale lexical',
  'twins. Pass recency_weight: 0 for pure lexical ranking (the library',
  'default). It leaves already-fresh results nearly unchanged. adaptive: true lets',
  'the score distribution set the result count (top_k becomes a budget).',
  'On a tight reading budget prefer conversation_window: 0 with a higher',
  'top_k — hits beat neighbors when every char displaces a hit.',
  'Old journaled calls may show tree-era params (retrieval_mode,',
  'expansion_budget, dense_weight …) — dropped 2026-07-27; do not copy',
  'them (harmless if passed: the server ignores unknown params).',
  '',
  '## Temporal queries',
  'treecontext_query supports time_range and sort_by for temporal access:',
  '- "what was I working on recently" → sort_by: "reverse_chronological"',
  '- "show the history of X" → query X + sort_by: "chronological"',
  '- "entries from last session" → time_range: { after: <session_start_ts> }',
  'Timestamps are Unix seconds. Combine time_range with sort_by for narratives.',
  '',
  '## Media attachments',
  'When the user attaches a file (image, audio, PDF, etc.), insert a node with',
  'media_ref so it is findable later. Use the file path as uri, set mime_type,',
  'and write a brief text description as the node content.',
  '',
  '## What to write manually (treecontext_insert)',
  'The hooks capture the *what*. You record the *why*:',
  '- Decisions and reasoning ("chose X over Y because Z")',
  '- Plans and next steps',
  '- Rejected alternatives and dead ends',
  '- Constraints the user stated',
  '- Synthesized findings from research/debugging',
  'Write at natural breaks: decision reached, subtask complete, direction',
  'changed. Burst-write before rate limits or context pressure.',
  '',
  '## Resume-pointer lifecycle',
  'Tag plans/next-steps with metadata.next_session = true so future sessions',
  'find them. When a new plan or close-out replaces an earlier one, pass',
  'supersedes: [old_node_ids] so the stale pointer flags are cleared.',
  '',
  '## Checkpoints (long form)',
  'Two kinds of checkpoint, distinguishable everywhere:',
  '- Bookmark — automatic, cheap, low in signal. At a turn end the stop hook',
  '  asks for one once the configured interval has passed (rounds or',
  '  minutes). Answer with treecontext_insert: a short "at: <where I am>;',
  '  next: <next step>" note with metadata.kind = "bookmark". If the write',
  '  fails, say so once and carry on: a bookmark never blocks the developer.',
  '- Chapter summary — deliberate, high in signal, written when the developer',
  '  says "checkpoint". Insert a curated summary (plan, decisions, state,',
  '  next step) with metadata.next_session = true and supersedes:',
  '  [the previous chapter\'s id], so only the newest chapter stays a resume',
  '  pointer. Then suggest that this is a good moment to /clear —',
  '  treecontext cannot clear for the developer; only they can type it.',
  '',
  '## After a /clear',
  'The session-start hook hands you a re-orientation packet: the newest',
  'chapter with its age and who refers to it, the newest bookmark with its',
  'age and the count of entries between the two, the newest developer',
  'turns since the bookmark (first lines, with the omitted count), and a',
  'one-line reminder of how to leave a chapter summary. Open your first',
  'reply by showing that packet to the developer as is, in order, before',
  'anything else; fetch any entry it names with treecontext_export(node_id).',
  '',
  '## Handoff to a teammate',
  '1. Export to a file in the repository: treecontext_export with path',
  '   (e.g. "handoffs/login-plan.json"). The server writes the file; only its',
  '   name and the counts come back. By default it carries the chapter',
  '   summaries and subagent summaries; form "whole" exports the whole',
  '   journal only when the developer chooses it — captured tool output can',
  '   hold secrets, tokens and keys, so the first call only warns, and',
  '   secrets_acknowledged: true writes. Paths outside the project are refused.',
  '2. Commit the file. Its head says who exported it, when, from which',
  '   project, what it holds, and the one step that imports it.',
  '3. The teammate pulls and imports it with treecontext_import and the same',
  '   path (or `treecontext import <path>` in a shell).',
  '',
  '## Subagents, worktrees and writers',
  'Every entry carries its writer, stamped by the store: "main" for the',
  'main checkout\'s own agent, "worktree:<name>" in a git worktree, the',
  'subagent\'s role (e.g. "tester") for a subagent. treecontext_insert says',
  'it back as writer and writer_src: "self", "provisional" (one subagent',
  'live and the main agent waiting on it), "concurrent" (a subagent live',
  'but the main agent active beside it — stamped as the main agent\'s),',
  '"ambiguous" (several live; writer_candidates lists them). writer_note',
  'explains. The call\'s own echo makes the writer exact when it is',
  'captured ("echo"); until then a wrong guess acts in its guessed lane',
  'and the drain undoes it. A subagent can answer another writer\'s pointer',
  'but never retire it: the supersession becomes a reference.',
  '- A subagent\'s search (treecontext_query) covers its role\'s earlier',
  '  trail and the plan it was spawned under only when the store can tell',
  '  it apart (one subagent live, the main agent waiting); otherwise the',
  '  whole store. scope: "all" widens it; the reply\'s scope says which',
  '  search ran, and why.',
  '- A subagent\'s whole trail: treecontext_export with writer: "tester"',
  '  (or its agent id, "main", "worktree:<name>"), oldest first; a capped',
  '  trail states omitted.',
  '- When a subagent finishes, its last message is kept as its summary',
  '  (kind "subagent-summary"), found by search.',
  '- Brief a worktree or a subagent role with an entry whose',
  '  metadata.brief_for names it: a session starting in that worktree is',
  '  handed it; that role\'s search finds it.',
  '- In a git worktree, treecontext_status lists that worktree\'s own',
  '  pointers (scope: "all" for every lane), and a fresh start is handed',
  '  the worktree\'s own newest chapter.',
  '',
  '## When something looks wrong',
  'If capture or recall looks wrong — entries missing, a search that should',
  'hit and does not, a packet that never arrives — run `treecontext doctor`',
  'before anything else. It names the broken link and the command that',
  'fixes it; `treecontext doctor --dump-logs` prints the recent debug logs.',
  '',
  '## Anti-patterns',
  '- Don\'t put project-scoped facts in global auto-memory. Each entry is',
  '  permanent context-window tax for every other project.',
  '- Don\'t rely on context compaction for recall. Compaction is lossy and',
  '  invalidates prompt caching. Treecontext is the alternative.',
].join('\n')


/** Lexical (FlatStore) handshake. The tree era's checkpoint/summarize
 *  MACHINERY does not exist on this backend — checkpoint_all is not even
 *  registered, and stale summaries are hardwired 0 — so nothing here names
 *  a tool the server lacks. The checkpoint PROTOCOL below is different in
 *  kind (D174): two kinds of note the agent writes with treecontext_insert,
 *  the bookmark the stop hook asks for and the chapter summary written on
 *  the developer's word, plus the /clear, handoff and doctor moves.
 *
 *  The card stays a card (D210): the whole text stays under 2500
 *  characters and under the reference platform's 2KB instruction cap,
 *  because the verbose variant measurably SUPPRESSED memory use (t10). The
 *  long form lives in SKILL_REFERENCE_BODY, which the text points to. */
export const INSTRUCTIONS_BRIEF_LEXICAL: string = [
  'SESSION START — do this BEFORE any other work:',
  '1. treecontext_status — check resume_pointers ("newest N of M" means',
  '   stale pointers need supersession cleanup).',
  '   Fetch each resume pointer via treecontext_export(node_id).',
  '2. treecontext_query("what was I working on, what was the next step").',
  'Only then respond to the user.',
  '',
  'On Claude Code, hooks auto-capture tool-use and user messages; elsewhere',
  'only what you insert is kept. Use treecontext_insert for the *why*:',
  'decisions, plans, rejected alternatives, constraints, findings.',
  'When the user attaches a file, insert a node with media_ref (uri, mime_type)',
  'and a text description so it is findable later.',
  '',
  'Hits return a bounded preview ending in an availability marker -',
  'treecontext_export(node_id) fetches the whole thing. "[capture gap]"',
  'entries mark journal holes - trust them over assuming completeness.',
  '',
  'CHECKPOINTS come in two kinds:',
  '- Bookmark: when the stop hook asks, insert a short "where I am, next"',
  '  note with metadata.kind="bookmark".',
  '- Chapter summary: when the developer says "checkpoint", insert a curated',
  '  summary with metadata.next_session=true and supersedes: [the previous',
  '  chapter\'s id]. Then suggest that this is a good moment to /clear.',
  'After a /clear, your first reply opens with the re-orientation packet you',
  'received at session start, shown to the developer as is, in order:',
  'chapter, bookmark, recent developer turns.',
  'Handoff: export the chapter summaries to a file in the repository and',
  'commit it; the teammate pulls and imports it with treecontext_import,',
  'with the file\'s name as the label.',
  'When capture or recall looks wrong, run `treecontext doctor` before',
  'anything else.',
  'Long form: load the treecontext-reference skill on demand.',
  '',
  'Tag other plans with metadata.next_session=true; pass supersedes:',
  '[old_node_ids] when one replaces another. treecontext_query takes',
  'time_range and sort_by. Don\'t put project facts in global auto-memory.',
].join('\n')

export function resolveInstructions(variant: 'brief' | 'none'): string {
  // One backend, one instruction set: 'verbose' was removed outright at
  // the 0.1 corpus audit (D4) — the parser now refuses it instead of
  // silently serving brief
  // lexical text when the tree variants left with the tree era
  // (deletion phase, 2026-07-25). 'none' stays for clients whose hook
  // channel already delivers the trigger.
  return variant === 'none' ? '' : INSTRUCTIONS_BRIEF_LEXICAL
}
