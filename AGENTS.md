# Working on treecontext

Guidance for coding agents (and humans) making changes to this repository.
If you are a *user* of treecontext, you want [README.md](README.md) instead.

## What this is

A searchable chat-session journal for AI coding agents: a TypeScript
library plus an MCP server that captures a session's events (user
messages, tool calls, assistant turns) and the agent's curated notes into
a flat SQLite store, so a future session can recall prior context at cold
start — replacing context compaction as the recall mechanism and
preserving prompt-cache economics.

Retrieval is lexical (FTS5 BM25, role-weighted). There is no embedder, no
model download, no tree. Node.js ≥ 22.

The design is the **minimum necessary** to honor that charter, and the
minimalism is earned rather than aesthetic: hierarchical summary trees, a
dual-tree promotion pipeline, query fusion, and a tree-sitter code index
were each built, benchmarked against this workload, and deleted.

## The spec is the tests

The living specification is the charter suite in `features/` —
owner-language feature files run by
[gherkin-node-test](https://github.com/bingh0/gherkin-node-test) through
its vitest adapter. Declined scope lives on the fence in
`features/OUT-OF-SCOPE.md`.

**When code and charter disagree, the charter wins.** Feature-file diffs
are owner-review territory — change behavior there first, deliberately,
not as a side effect of an implementation change.

**The verification rule:** a capture or storage claim only counts when it
has been exercised end-to-end — real payloads in, direct SQLite
inspection out. Reading the source is not verification.

## Architecture

- `src/flat-store.ts` — the journal. Insert/query/export, BM25 + trigram
  search, conversation windows and anchors, session-scoped dedup,
  retention valve (archive → tombstone → delete, never destroy)
- `src/persistence/` — SQLite/WAL layer: schema plus additive migrations,
  role-weighted FTS5 columns, zstd content codec, preview/index split,
  staging table, store lock, backup
- `src/server/server.ts` — the MCP server (official SDK v2,
  `@modelcontextprotocol/server`), 8 tools
- `src/server/cli.ts` — CLI: serve, install/uninstall, doctor, init, hook,
  backup, stores, ccr, export/import (the handoff file's shell door),
  config checkpoint-interval
- `src/server/ingestion.ts` — drains staged events into the journal
  (honest timestamps, dedup, byte valve, poison dead-letter); stamps a
  captured row's `_writer` from the hook payload's agent fields and runs
  the echo heals (session identity, writer) on `treecontext_insert` echoes
- `src/server/instructions.ts` — agent-facing handshake text; this is a
  charter surface, see `journal-agent-surface.feature`
- `src/server/installer.ts` — agent detection, config writing, AGENTS.md
  block, doctor (one row per documented client: mode, state, remedy); the
  Claude Code hooks block, and its verbatim (Codex) and translated
  (Gemini) copies behind `--experimental-capture`
- `src/handoff.ts` — the handoff door: the import rule (importer's marks,
  `_handoff_claims`, `handoff:` lanes), the export forms (`summaries`,
  `whole`), the file's self-describing head, the project-directory path
  rule, the atomic file write
- `src/references.ts` — `metadata.refs` references and lanes: the lane key
  supersession respects, the writer an entry is shown with, and
  "referenced by" one hop deep
- `src/checkpoints.ts` — chapter summaries and bookmarks, the bookmark
  interval, the /clear session chain, the re-orientation packet, a
  worktree's self lines
- `src/persistence/session-registry.ts` — the session registry (self and
  live subagents) and the writer stamp a tool-written row gets at insert
- `src/persistence/writer-heal.ts` — the echo heal that sets a
  tool-written row's writer exactly at the drain, and undoes what a wrong
  first stamp did across lanes
- `src/persistence/reference-index.ts` — the `node_refs` reverse index and
  the triggers that keep it
- `src/persistence/curated-index.ts` — the partial curated unique index,
  spelled once
- `src/hooks/` — journaling hooks. Claude Code is the verified reference
  platform; the other adapters are unverified scaffolding. `subagent-start`
  and `subagent-stop` register and retire subagents; `git-self.ts` reads
  where a session runs (worktree, branch) for its registration
- `src/session-beacon.ts` — pid-keyed session identity; on a /clear the
  session-start hook reads the predecessor session from it before
  rewriting it

## Design decisions worth not re-litigating

1. **Flat store, lexical retrieval.** FTS5 BM25 with per-role column
   weights (user/tool/note 1.0, assistant prose 0.25). Dense retrieval has
   no seat at any tier; if it ever earns one it enters as a fused, opt-in
   second ranked list — see the fence.
2. **Capture is judged by one question:** if a future agent needed this
   moment, is it in the store? No invocation is ever filtered out.
   Repo-reading tool output is trail (bounded preview, re-derivable);
   execution and external output is treasure (kept in full behind the
   preview/index split). Dropped events leave visible `[capture gap]`
   markers.
3. **SQLite/WAL persistence.** Crash-safe writes, concurrent readers.
   Additive migrations auto-run; destructive ones need explicit opt-in.
4. **Retention never destroys.** The byte valve archives whole sessions
   (fsynced before any row moves), tombstones them, then deletes. No
   archive destination → demote but refuse to evict. Only the human
   deletes.
5. **Library first.** Any Node program that opens the SQLite file gets the
   same journal; the MCP server is one consumer, not a gatekeeper.

## Build and test

```bash
npm install
npm run build
npm test          # the full test suite + the charter suite
npm run lint
npm run typecheck
```

Run the server directly during development:

```bash
npm run serve                       # stdio transport, from source
node dist/server/cli.js doctor      # after a build
```

## Code style

- TypeScript strict mode, ES2022, ESM
- Named exports only, no default exports
- Type annotations on all public functions and interfaces
- Logging to **stderr** — stdout is reserved for the MCP stdio transport
- Vitest for testing

## Things to watch for

- Content in `nodes.content` may be zstd-encoded — decode with
  `persistence/content-codec.ts`, never assume plain text
- `metadata.created_at` is the event's moment; `ingested_at` is the
  drain's. Honest timestamps are what make temporal recall trustworthy
- Tree-era stores (embedding blobs, `backend_mode='tree'`) still open, but
  refusal is loud and read-only — never "migrate" one silently
- Persistence still round-trips tree-era embedding blobs so old stores stay
  readable; that code is deliberate, not dead
- `_writer` and `_writer_src` (and the rest of `WRITER_STAMP_KEYS`) are
  stamped by the store, never trusted from a caller: the insert tool drops
  a caller's copy, as it drops caller `_handoff_*` keys
- Imported rows live in `handoff:` lanes (`session_id` =
  `handoff:<claimed session>`); the file's identity claims sit under
  `_handoff_claims`, never at the top level
- The curated unique index is partial: `dedup_class = 'curated'` outside
  handoff lanes (`CURATED_INDEX_WHERE`). Inside a handoff lane identity
  decides, not content; any rebuild must reuse the shared DDL
