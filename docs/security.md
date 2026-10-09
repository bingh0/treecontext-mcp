# Security Guide

treecontext is a **single-user, local-first** chat-session journal for AI
coding agents: a TypeScript MCP server plus capture hooks, backed by
SQLite FTS5 (BM25). The default configuration (stdio transport) has no
network exposure. This document describes the threat model, what is
stored where, and the controls available, grounded in the shipping code
(paths cited per section).

---

## 1. What runs, and where data lives

Everything is local. There are **no network calls anywhere in the
codebase** — no outbound calls (no model downloads, no update checks,
no analytics endpoints) and, since 0.1, no inbound listener either: the
HTTP transport was removed (see §4.2), so the server speaks stdio to a
child-process pipe and nothing else. There is no embedding model and no
LLM call: retrieval is lexical (SQLite FTS5 BM25), computed entirely
in-process.

Data on disk, per store (`src/server/cli.ts`, `src/session-beacon.ts`,
`src/server/query-telemetry.ts`):

| Path | Contents |
| --- | --- |
| `~/.treecontext/stores/<name>/treecontext.db` | the journal (plus SQLite `-wal` / `-shm` siblings) |
| `~/.treecontext/stores/<name>/sessions/pid-*.json` | session-identity beacons (session id, cwd, timestamps) |
| `~/.treecontext/stores/<name>/archive/` | JSON session archives written by the retention valve before any deletion |
| `~/.treecontext/stores/<name>/query-telemetry.jsonl` | **only if** you opt in — see §6 |
| `~/.treecontext/bindings.json` | project-directory → store-name bindings |
| `~/.treecontext/config.toml` | configuration written by `treecontext install` |
| `~/.treecontext/shield/` | shielded oversize tool responses — **only if** shielding is enabled, see §3 |
| `~/.treecontext/logs/` | debug logs (paths and event names, never message bodies), `0o700` |

One store per project identity, selected by fingerprint
(`src/server/bindings.ts`), not by a file inside the repository — a
malicious checkout cannot redirect your store. The identity is the git
remote URL when one exists — every clone and worktree of the same
remote shares one store — and the realpath of the project root
otherwise.

That property was forgeable through git itself, and three routes are
closed as of 0.1.0-rc.1 (the identity now derives from the repository
alone, never from repo-controlled files or the ambient environment):

- a hand-written `.git` **file** pointing at another project's
  directory — a worktree redirect is honored only when git's own
  registration back-pointer (`<gitdir>/gitdir`) names the resolving
  checkout itself, which a hostile file cannot forge;
- a repo-local **`core.worktree`** claiming another project's
  directory as its working tree — a `git rev-parse --show-toplevel`
  that does not contain the directory being resolved is distrusted,
  and identity falls back to that directory;
- **git configuration injected through the environment**
  (`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`,
  `GIT_DIR`, and the rest of the `GIT_*` family) — every `GIT_*`
  variable is scrubbed from the environment of the git commands that
  read identity. Global and system config are deliberately left
  readable, so `safe.directory` still works for root-owned and
  bind-mounted checkouts. Legacy `.treecontext-store` sticky files are read only if
they are not symlinks and match `SAFE_STORE_RE`, then migrated into
`bindings.json` (`resolveStoreName` in `src/server/bindings.ts`,
`resolveAutoStore` in `src/server/cli.ts`). `bindings.json` itself gets
the same care: a symlinked path is refused for reading and writing, an
unreadable or unrecognized file is side-filed to
`bindings.json.corrupt` instead of being overwritten, and stored values
are re-validated against `SAFE_STORE_RE` on every load.

## 2. What the hooks capture

The capture charter (`src/hooks/README.md`, enforced by
`tests/journal/`): **no tool invocation is ever filtered out**,
including read-only tools; dropped or failed events leave explicit
`[capture gap]` markers in the journal rather than silent holes
(`src/server/ingestion.ts`).

The Claude Code hooks (`src/hooks/`) write to a `staging` table in the
same SQLite file; the MCP server's ingestion loop drains it into the
journal:

- `user-prompt-submit.ts` — every user prompt, in full (bounded only by
  a 256 KB per-row safety cap).
- `post-tool-use.ts` — every tool call: tool name, input, output.
  Repo-reading tools (Read, Glob, Grep, LS, View, ListDir) keep a
  bounded preview of their output (it is re-derivable from the working
  tree); execution and external outputs (Bash, web, MCP tools) keep the
  full text up to the 256 KB safety cap.
- `stop.ts` — the assistant's end-of-turn response, read from the
  session transcript.

**Treat the journal as being as sensitive as the terminal it watched.**
If a command printed a secret, a token, or customer data, that text is
now in `treecontext.db` with your user's file permissions. The caps
above (`src/persistence/capture-constants.ts`) bound row size and what
gets *indexed*, not what is sensitive.

## 3. Data at rest

**File permissions** (`ensureDbFileMode`,
`src/persistence/better-sqlite.ts`): store directories are created mode
`0o700`; database files are chmod'd to `0o600` on create. Broader
existing permissions produce a stderr warning rather than an auto-fix
(you may have set group-share deliberately). Every other regular file
the tool writes under `~/.treecontext` — beacons, backups, debug logs,
query-telemetry lines, retention/demotion archives, migration verdict
sidecars, `config.toml`, `bindings.json` and its transient write lock —
is written `0o600` on create rather than left to the umask. The mode applies at creation: a file that predates this
rule keeps the mode it was minted with.

**WAL siblings:** WAL mode creates `-wal` and `-shm` files next to the
database. They contain recent writes and get the same treatment as the
database file.

**Secure delete** (`--secure-delete`): by default SQLite marks deleted
pages free without overwriting them. Passing `--secure-delete` to
`serve` enables `PRAGMA secure_delete = ON`
(`src/persistence/better-sqlite.ts`); after `clear()` and bulk deletes
the server additionally runs `VACUUM` plus
`wal_checkpoint(TRUNCATE)` to scrub the WAL. This covers only SQLite —
OS filesystem journals are out of scope; use full-disk encryption
(LUKS, FileVault, BitLocker) for defense in depth.

**Encryption at rest:** none is provided natively. The store is a plain
SQLite file. Use OS-level disk encryption if the journal is sensitive.

**Backup:** `treecontext backup <dst>` uses the SQLite Online Backup
API (`src/persistence/backup.ts`) for a consistent copy of a live store
and writes the result `0o600`. Do not copy `.db` files raw — the WAL
sidecars make raw copies inconsistent.

**Retention:** the eviction valve archives whole sessions to JSON and
writes tombstones *before* deleting rows, and refuses to evict at all
when it cannot archive (`src/flat-store.ts`). Nothing is deleted
silently.

**Output shielding** (`src/server/shielding.ts`, off by default): when
`--shield-threshold` is set above 0, an oversize `query` or `export`
response is written to a file and the agent receives a compact
reference naming the absolute path instead. Those files hold verbatim
journal content — as sensitive as the store itself — so they get the
store's treatment: `~/.treecontext/shield` by default (inside the
`0o700` umbrella, never the shared tmpdir), directory `0o700`, files
`0o600`. The sweep runs at stdio shutdown only and deletes only
filenames the module itself mints (`<tool>-<epoch-ms>-<uuid8>.json` —
an arbitrary `--shield-dir` must never make it a general file reaper).
While shielding is disabled it still cleans the default directory —
files minted before the flag was dropped keep their retention — but
never a custom `--shield-dir`. Leftovers from pre-lockdown releases in
`$TMPDIR/treecontext-shield` are swept at shutdown until gone. If the
shield file cannot be
written, the full response is returned inline rather than failing the
tool call — a disk problem must not destroy a successful result.
`treecontext_status` is never shielded, and the `alwaysShield` /
`neverShield` sets are library-level configuration with no CLI or TOML
surface.

## 4. Transports and network exposure

### 4.1 stdio (default)

The agent spawns treecontext as a child process. No ports, no
configuration, no network attack surface. Access control is the OS: the
server runs with your user's permissions and the agent has full
read-write access to the store through the MCP tools its policy allows.

### 4.2 HTTP transport — removed in 0.1

`serve --transport http` was removed at the 0.1 corpus audit
(2026-08-12). Its consumers — the tree-era embedding daemon and the
shared multi-client daemon — were themselves removed in the 2026-07-25
teardown, the library API runs in-process and needs no transport, and
the audit established the surface was unused. The flag now exits with a
removal message. Reinstatement would be a new feature with its own
security contract and scenario corpus, not a revert.

### 4.3 Writer coordination

Correctness is enforced inside the database (v0.1, "store as arbiter"):
dedup is a unique constraint, the capture drain claims its batches
atomically, so concurrent writers cannot corrupt each other. Role
holding — one primary claim per namespace, one drain per store — is
coordinated through a `leases` table inside `treecontext.db`
(`src/persistence/leases.ts`): heartbeat rows with TTL-expiry liveness,
no lockfiles, no PID probing. A second server on the same namespace
serves alongside the holder (the refusal retired 2026-08-20 — writer
safety is the constraints above, not the lease); the claim stays single
and names its live holder for doctor, hook-attribution corroboration,
and takeover. A holder that stops heartbeating (crash, SIGKILL) frees
its roles within one TTL (≤ 90 s). Leftover pre-0.1 `.treecontext*.lock` files are
removed at server start and carry no meaning.

## 5. Tool-access policies

`serve --policy <name>` controls which MCP tools are even registered
(`src/server/policy.ts` — unregistered tools cannot be invoked):

| Policy | Tools |
| --- | --- |
| `full` (default) | all 8 tools |
| `read_only` | `query`, `status`, `export` — the journal is never written; `export` with a `path` still writes a handoff file into the project directory |
| `contributor` | `read_only` + `insert` — no `delete`, `clear`, `import`, `merge_from_agent` |

`--read-only` is shorthand for `--policy read_only`.
A policy bounds the **store**, not the filesystem (D50 as read by D257):
under `read_only` nothing writes the journal — no insert, no import, no
deletion, no capture ingestion — but `treecontext_export` with a `path`
writes a handoff file into the project directory at the agent's request,
under the handoff path rules below. A deployment that must not write any
file at all cannot get that from `read_only` today.
`treecontext_merge_from_agent` is `full`-only. A `read_only` server
also never ingests captured events, even if `--capture` was passed
(`captureEnabled`, `src/server/policy.ts`). The recommended multi-agent
pattern is one `full` writer and `read_only`/`contributor` sub-agents.

**Import bounds** (`src/flat-store.ts`): `treecontext_import` rejects
pasted `data` over 5 MB of JSON or 10,000 nodes. A file the server reads
itself by `path` carries no cap (D170, D230): it is held whole in memory,
about three times its size.

**Handoff file paths** (`src/handoff.ts`, `resolveProjectPath`;
D199, D232, D234): `treecontext_export` and `treecontext_import` read or
write a file by `path` only inside the project directory the server was
started for (`--project-dir`, `TREECONTEXT_PROJECT_DIR`, or the working
directory), never one the agent names. Every existing directory on the
way is resolved through its links and must stay inside the project's
real path; the file itself may not be a link; a dangling link or a path
through a file is refused; any path under `.git` is refused; and an
existing file is overwritten only when it is itself a treecontext
handoff (a JSON object with `form` and `exported_by`), so an agent
steered by injected text cannot replace `package.json` or plant a git
hook. Writes go to a fsynced sibling renamed over the target. A file
read by path that is not JSON is refused as "not a handoff file" without
echoing any of it. Note that the `read_only` policy bounds the store,
not the filesystem: a `read_only` server still writes handoff files
under these rules. The shell commands `treecontext export` and
`treecontext import` take any path the developer types, but `export`
also refuses to overwrite a file that is not a handoff unless `--force`
is given.

## 6. Telemetry: opt-in and local

There is no telemetry by default. One instrument exists, and it is
**opt-in and never leaves your machine**
(`src/server/query-telemetry.ts`): when the
`TREECONTEXT_QUERY_TELEMETRY` environment variable is set to `1`,
`true`, or `on`, the server appends one JSON line per search to
`query-telemetry.jsonl` next to the store file — query text, result
ages, and timing. It is a plain local file; sharing it with the
developers is a manual, deliberate act. Unset the variable and nothing
is written.

While opted in, the instrument has a **second sink**: a debug-log line
per query carrying the first 40 characters of the query text. It lives
inside the same consent gate, but the debug logs are files this
document tells you to share (§"dump-logs") — hence the hard bound, and
the reason the always-on session stats carry counts and latencies only,
never content (`src/server/session-stats.ts`; pinned in
`features/design/telemetry-privacy.feature`).

## 7. Prompt injection (CWE-74)

Journal contents are **untrusted input**. Anything captured from a
session — including tool output that originated in a hostile repository
or web page — is returned verbatim by `treecontext_query` and can read
as instructions to an LLM. treecontext deliberately does not sanitize
stored content (that would destroy legitimate entries); the trust
boundary is in how the consuming agent frames retrieved text.

Recommendations for consuming agents:

1. Wrap retrieved content in delimiters (e.g. `<memory>…</memory>`)
   before placing it in a prompt.
2. Instruct the model to treat the delimited block as data, not
   instructions.
3. Where the framework supports it, gate tool use during turns that
   process retrieved memory.

## 8. Uninstall and deletion

`treecontext uninstall` removes MCP registrations, hook scripts, and
the installed skill, but **never touches your journals**. Deletion is
always explicit and yours:

```bash
treecontext stores list            # what exists, and how big
treecontext stores rm <name> --yes # delete one store
rm -rf ~/.treecontext              # remove everything
```

`stores rm` resolves the real path and refuses targets outside the
stores directory (`src/tools/stores.ts`).

## Checklist

| Situation | Action |
| --- | --- |
| Default local use (stdio) | Nothing — no network surface exists |
| Sensitive sessions | `--secure-delete`, OS disk encryption, and remember the journal mirrors your terminal |
| Multi-agent | One `full` writer; sub-agents `--policy read_only` or `contributor` |
| Backups | `treecontext backup <dst>`, never raw file copies of a live store |
