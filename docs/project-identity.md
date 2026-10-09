# Project identity: the journal must survive its own project's history (design note, 2026-08-16)

> Status: **IMPLEMENTED 2026-08-21**, Phases 1–4, `6331ee5..e73552b`
> — succession + worktree identity, the split detector, the doctor
> self-audit surface, the fingerprint digest migration (024), and
> `stores merge`, each phase adversarially reviewed with its findings
> fixed before the next. What remains is Phase 5 (release packaging)
> and the five real-store repairs, which are owner-gated. This note is
> now the implemented design of record; §9.2 below is resolved by
> migration 024. Ruled in for 0.1 by the owner on 2026-08-16
> (treecontext node `60432cf2`) off the defect report in node
> `7e74a334`; part 3 (`stores merge`) carried the strict cycle of
> ruling `232b4219` (design review §6 → implementation → adversarial
> review).
>
> **AMENDED 2026-08-20** per the Fable adversarial review
> (`docs/review-2026-08-20-fable-adversarial.md`, findings F1–F3, F9)
> and the owner's acceptance of F1's shape. The v2 reviews have landed
> and both remotes are pushed (`20a3c13`); Phase 1 is unblocked on this
> amendment. Changes: §3/§3.1 rewritten — the whole-bindings-map
> ambiguity scan was **unimplementable** (bindings store only one-way
> fingerprints, no identities), replaced by unanimity over an
> *enumerable* candidate set with subdirectory predecessors demoted to
> disclose-only; §3.2 expanded to probe raw URL spellings; §3.4 added
> (worktree identity); §5 extended to multi-namespace stores.

## 1. The defect

A project's binding key is derived from facts that change during the
project's normal life, and nothing carries the journal across the
change. `projectIdentity` (`src/server/bindings.ts:235`):

```
identity = git:<remote.origin.url>            when a remote exists
         | path:<realpath(gitRepoRoot ?? findProjectRoot(cwd))>
fingerprint = sha256(identity)[0:16]
```

`resolveStoreName` misses on the new fingerprint, falls through to
`deriveName`, writes a new binding, and opens a **new, empty store**.
No succession lookup, no warning, no link. The old journal is not
deleted — it is unaddressable.

### 1.1 What actually triggers it

The field report named `git init`. Measured against `dist/` at
`8289beb`, that is not the trigger, and believing it would put the
warning in the wrong place:

| # | Trigger | Transition | Notes |
| --- | --- | --- | --- |
| 1 | `git remote add origin`, `gh repo create`, `push -u` | `path:<root>` → `git:<url>` | The observed second-project case |
| 2 | `git init` while the recorded cwd was a **subdirectory** | `path:<subdir>` → `path:<repoRoot>` | `findProjectRoot`'s walk-up now terminates at the new `.git` |
| 3 | Remote URL **form** change | `git:<url1>` → `git:<url2>` | https↔ssh, `.git` suffix, repo rename, org move |

`git init` alone at the project root does **not** rebind
(`root-before-init == root-after-init`, verified). Trigger 1 is
confirmed for the second project by the successor store's *name*:
`second-project` can only come from `slugFromGitUrl`, which requires a
remote URL to have existed.

Trigger 3 is absent from the field report and matters most for the
future: it has no path-bound precondition, so it puts the 20
already-git-bound projects in scope too. There is no URL
normalization anywhere in the resolver.

What holds as designed: a clone of the same remote at a second path
shares one store (verified).

### 1.2 Population (this machine, `~/.treecontext/bindings.json`)

65 bindings — **44 `path`**, 20 `git`, 1 `migrated-sticky`. Every
`path` entry is a live candidate for triggers 1 and 2; every entry is
a candidate for trigger 3. Five confirmed splits, always path-first
then git:

| project | path-bound | git-bound |
| --- | --- | --- |
| research-project | 08-01 01:53 | 08-02 03:51 |
| ccr | 06-20 02:57 | 06-24 04:28 |
| second-project | 08-14 12:52 | 08-15 13:04 |
| third-project | 06-30 00:58 | 06-30 01:36 |
| treecontext | 07-29 02:12 | 08-01 16:41 |

`third-project` split 38 minutes apart. treecontext's own store is a
casualty.

### 1.3 Why this workflow is the worst case

Scope-then-init-then-build. `/scope` runs *before* any code exists, so
it necessarily binds by path; the build session adds the remote and
rebinds. The ratified scope contract therefore lands, reliably and
silently, where the build session cannot see it — and that contract is
exactly the input the downstream reviewed tier reads. The field
report's corollary is correct and should be recorded: `gt`'s
"Reviewed set: 0" was never a `gt` weakness. `gt` read an empty store,
correctly.

### 1.4 Why nothing caught it

`features/design/store-bindings.feature` has seven scenarios and every
one is about **file integrity** — corrupt side-filing, symlink
refusal, unsafe-value dropping, no-mint-on-backup, sticky lookup.
Zero are about **identity continuity**. The invariant "a project keeps
its journal across a change in its own identity source" was never
written down, so nothing could fail. This is a charter gap, not a
coding slip, and the fix is not complete until the invariant is bound.

## 2. Requirements

- **R1** — a project that gains a remote, gains a repo root above its
  recorded cwd, or changes its remote URL form keeps resolving to the
  journal it already has.
- **R2** — succession is **announced**, never silent. The whole
  failure mode is silence.
- **R3** — succession never *widens* the store-selection trust
  boundary (finding S3): the probe may read the filesystem and
  `.git/config`, which identity already trusts, and nothing else.
- **R4** — ambiguity fails **closed**. When candidate predecessors
  disagree, derive fresh and disclose; never guess which journal a
  project owns.
- **R5** — the five existing splits are *detectable* without moving
  bytes, and *repairable* with a reviewed command.
- **R6** — repair never destroys either side. Both journals survive
  the operation or neither is touched.
- **R7** — no schema change. Parts 1 and 2 are resolver and
  diagnostic work; part 3 reuses the shipped write path.

## 3. Part 1 — forward succession (amended 2026-08-20, F1)

In `resolveStoreName`, on a fingerprint **miss** and *before*
`deriveName`, probe predecessor identities. Candidates split into two
classes with different powers:

```
ADOPTABLE candidates — identities of the SAME directory the successor
identity names (root-identical, so no sibling can be hiding):
  1. path:<realpath(successorRoot)>        — covers trigger 1
     (successorRoot = gitRepoRoot(cwd), per §3.4 resolved through a
     linked worktree to the primary repo root)
  2. git:<u> for each raw spelling u of remote.origin.url (§3.2)
                                           — covers trigger 3

DISCLOSE-ONLY candidates — strict subdirectories of successorRoot:
  3. path:<realpath(cwd)> and path:<realpath(a)> for each ancestor a
     strictly between cwd and successorRoot — detects trigger 2
```

Resolution rule:

- Collect the bound store of every **adoptable** candidate.
- **Zero** bound → derive fresh, exactly as today; but if a
  disclose-only candidate is bound, **announce it**: "a predecessor
  journal exists at `<dir>` (store `<name>`); not auto-adopted — run
  `treecontext doctor` / `stores merge` to reunite." Trigger 2 gets
  disclosure instead of silence; that alone kills the failure mode
  (R2), without the guessing §3.1 forbids.
- **All bound adoptable candidates name one store** → adopt it. Write
  the new binding as `source: 'carried-forward'`, **leave the
  predecessor binding in place pointing at the same store** so both
  keys resolve to one journal, and announce through `onNewBinding`
  (R2).
- **Bound adoptable candidates name two or more different stores**
  (e.g. two URL forms bound separately over the project's life) →
  derive fresh and disclose the conflict (R4). The unanimity check is
  confined to this *enumerable* set — see §3.1 for why it cannot be
  anything wider.

### 3.1 Why subdirectory predecessors are never adopted (F1)

The first draft adopted any unanimous predecessor found on `cwd`'s
own ancestry. Finding A3 (§10) caught the monorepo case: `packages/a`
and `packages/b` each path-bound, `git init` at the root — each
sibling's probe sees exactly one predecessor and adopts it
"unanimously," handing whichever hook fires first the other's
journal. The A3 fix proposed scanning the bindings file for every
path-binding under the successor root.

**That scan is unimplementable** (Fable review 2026-08-20, F1):
`bindings.json` stores `fingerprint → {store, updatedAt, source}`,
and the fingerprint is a one-way `sha256(identity)[0:16]`. No
identity or path exists in the file, and the 44 existing path
bindings — the exposed population — can never be backfilled from
their hashes. A filesystem enumeration of every directory under the
root is the only alternative and is unbounded (monorepos,
`node_modules`).

So the rule is structural instead: **adoption requires the
predecessor to be the same directory the successor identity names.**
A root-identical predecessor admits no hidden sibling — there is
exactly one root. A strict-subdirectory predecessor can always have
an unseen twin, so it is disclosed, never adopted. This forfeits
auto-succession for trigger 2 (rare: it requires binding from a
subdirectory before `git init`, and all five observed splits were
trigger 1) in exchange for making the A3 hazard structurally
impossible rather than checked-for.

Deferred, post-RC: recording the identity string in each new binding
(additive field) would let a future version widen adoption safely for
bindings that carry it. Not RC material — disclosure covers the gap.

Zero data movement. After chunk C the store is namespace-capable, so
one store addressed by two fingerprints is already a shape the system
understands.

### 3.2 URL normalization (trigger 3; amended 2026-08-20, F2)

Normalize for the *probe only*; the stored identity string stays
`git:<raw url>`. Changing the identity string itself would re-key
every existing git binding — a migration this program does not want.

**The probe must emit raw spellings, not canonical ones.** A
predecessor's fingerprint hashes the raw URL it was bound under, so a
probe of two canonical forms misses the most common clone URL of all
(`https://host/org/repo.git`). From the normalized `host/org/repo`
triple, emit the cross-product:

```
{ https://host/org/repo,  git@host:org/repo,  ssh://git@host/org/repo }
× { "", ".git" }         — six forms, plus the trailing-"/" variant
                            of each https form
```

minus whichever form equals the current raw URL (its fingerprint is
the miss that started the probe).

**Disclosed residual: renames are not covered.** §1.1 lists "repo
rename, org move" under trigger 3, but those change the
`host/org/repo` triple itself — no normalization can find the old
binding. Same class as A11 (rename-before-remote). The detector's
output (§4) must name both residuals rather than implying full
coverage.

### 3.3 Trust boundary

Succession reads the filesystem (realpath, ancestor walk) and
`remote.origin.url`. Both are already inputs to `projectIdentity`, so
R3 holds by construction. Specifically, the URL-normalization step
does not widen S3: a hostile checkout that sets
`remote.origin.url` to a victim's exact URL already attaches to the
victim's store *today* — normalization only additionally collides the
ssh and https spellings of one URL, which is the intent. The
path-succession step requires the attacker to control a filesystem
path the victim project previously occupied, at which point they are
already local.

### 3.4 Worktree identity (added 2026-08-20, F9)

A **linked git worktree** breaks path identity today: `git rev-parse
--show-toplevel` returns the *worktree* root, so a path-bound project
(no remote) gets a fresh identity — and a fresh empty store — **per
worktree**. Git-bound projects are unaffected (the shared remote URL
already unifies). This is the succession defect family triggered by a
workflow rather than by history, and it matters doubly because agent
orchestration spawns subagents in worktrees as a matter of course
(owner, 2026-08-20).

Fix: when resolving identity, detect a linked worktree via `git
rev-parse --git-dir --git-common-dir` and redirect to the common
dir's parent — the **primary** repository root — **only on the
genuine linked-worktree signature**: `gitDir` sits under
`<commonDir>/worktrees/` AND the common dir's basename is `.git`.
One store per project, whatever checkout the session runs in.

**The trust boundary needed the signature, not just the parent rule**
(Phase-1 review 2026-08-20, F1/F2/F4 — the first implementation
shipped without it and was caught by the phase gate): unlike
`--show-toplevel`, `--git-common-dir` can name a directory you are
NOT in, and a hand-written `.git` *file* (`gitdir: /victim/.git`—
one attacker-authored line in an unpacked tarball) makes git report
the victim's dir — reopening S3 in the module that exists to close
it. The signature closes it: a hostile gitfile and a
`--separate-git-dir` layout both report `gitDir === commonDir`, fail
the `worktrees/` test, and keep their own toplevel. Relative
`rev-parse` output must also resolve against the **physical**
(realpath'd) cwd — resolving a relative offset against a symlinked
cwd of different depth lands in an arbitrary ancestor and collapses
unrelated repos onto one identity (F1, reproduced).

Implementation facts, measured at Phase 1a (2026-08-20, git 2.55):

- **Cost is zero, not one invocation**: `--show-toplevel
  --git-common-dir` is one process, and folding identity's git facts
  into a single fetch removed a spawn `resolveStoreName` used to pay.
- **The `basename === '.git'` guard is load-bearing**: a submodule's
  common dir is `<super>/.git/modules/<name>` (a worktree cut *from*
  a submodule reports the same), so submodules keep their own
  toplevel — resolving them to the common dir's parent would name
  `.git/modules`, not a project.
- **`--git-common-dir` prints relative from a primary checkout** —
  `.git` at the toplevel, `../.git` one directory down — and absolute
  from a linked worktree; it is meaningful only after resolving
  against **cwd**, not the toplevel.
- **Windows separators**: git prints POSIX separators while
  `path.resolve` yields native ones; the parent-vs-toplevel
  comparison must normalize, or every Windows checkout reads as a
  linked worktree and re-keys its binding.

Disclosed residuals (Phase-1 review F5/F6, carried in the detector's
non-exhaustive clause): a worktree that was **already path-bound**
before this change is silently re-keyed to the primary root — its old
store survives, path-sourced on both sides, invisible to the §4
name-shape pairing; and worktrees of a **bare** repo
(`git init --bare` + `worktree add`, no remote) do not unify — the
common dir's basename is `proj.git`, not `.git`, and redirecting on
it would be guessing. A bare *clone* carries `remote.origin.url`, so
git identity unifies those.

Recorded owner context, non-binding, post-RC: the original vision for
subagent hand-back was file-based — an exported file in the worktree
imported back into the main repo. With namespaces, lanes in **one
store** are the cheaper, machine-efficient carrier: the subagent
writes its own namespace, and the hand-back protocol (historically
"intentional commits only" — curated notes — but now cheap enough to
include summaries, resume pointers, or the whole lane) becomes a
`merge_from_agent` call rather than a file transport. Worktree
identity unification is what makes that shape work at all: subagent
worktrees must land in the project's store for their lanes to be
mergeable. The protocol itself is ccr-side scoping and stays out of
this program.

### 3.5 Path-spelling variants (added 2026-08-24)

The Windows residual tracked since rc.2: a NON-git project's identity
is `path:<realpathOr(root)>`, and `realpathOr` is a fallback ladder —
`realpathSync.native`, then the JS `realpathSync`, then the raw path.
When different runs land on different rungs (native realpath failing
transiently on a network share; an 8.3 short-form cwd during an
outage; historically, the pre-rc.2 JS-only canonicalization), the
same directory hashes to two fingerprints and mints two stores. Git
projects are immune — their identity flows from the remote URL, not
the path spelling.

The fix is §3.2's probe pattern applied to paths: on a `path`-source
miss, the succession probe also computes the OTHER rungs of the
ladder for the current root — the native form, the JS form, and the
raw spelling as received — and probes `path:<variant>` for each,
minus the spelling that just missed. Every variant names the one
directory the resolver is standing in, so each is root-identical by
construction and adoptable under §3.1's rule; ambiguity still fails
closed through `decideSuccession`. The `git`-source branch probes the
same variants for its path-fallback predecessor, closing the
adjacent gap (bound under a degraded spelling, then gained a remote).
The stored identity stays the canonical `realpathOr` form —
normalizing stored identities would re-key every existing binding,
the same reasoning as §3.2.

### 3.6 The bindings write lock (added 2026-08-24)

`bindings.json` was rewritten whole by whichever process next
resolved a miss: read at call start, mutate in memory, atomic
tmp+rename at the end. Atomicity protected the BYTES; nothing
protected the interval — two hooks minting first bindings for two
different projects both read the same map, and the second rename
silently dropped the first's entry (the lost-update race, tracked
since rc.2).

Now every writer — `persistBindings` and `repointBindings` — holds
`bindings.json.lock` (O_CREAT|O_EXCL, 0600) across a re-read of the
file and writes only its own delta over what is on disk at that
moment. The lock is bounded, not load-bearing: a waiter gives up
after ~2s and skips the write — unpersisted degradation, the same
posture as the symlink and unreadable refusals, and the next
resolution retries. A lock file older than ~5s is broken as stale
(its holder held it for milliseconds or died). The under-lock re-read
also subsumes the corrupt-recheck rule (F review 2026-08-15): a
concurrent repair can no longer be renamed away, because the verdict
and the rename now happen under the same exclusion.

## 4. Part 2 — the detector

A `doctor` check that reads `bindings.json` and the stores directory
and reports split candidates. It **moves no bytes and writes no
binding** — `doctor` already learned that lesson once
(`lookupStoreName`, never `resolveStoreName`; `bindings.ts:295`).

Heuristic, deliberately conservative: for each `path`-sourced binding
whose store name matches `^(.*)-[0-9a-f]{6}$`, report a candidate when
a `git`-sourced binding holds exactly the captured slug. That is the
shape `deriveName` produces on both sides of the split, and it is what
found all five here. Report node counts for both stores so the reader
can see which side holds what, and name `stores merge` as the repair.

Under-reporting is the accepted failure mode: a split whose two stores
do not share the derived-name shape (an `explicit` or
`migrated-sticky` binding) will not be listed. Say so in the output
rather than implying the list is exhaustive.

## 5. Part 3 — `treecontext stores merge <src> <dst>`

The field report assumed this needs a hand-rolled SQLite merge that
rebuilds the FTS5 index and reconciles `dedup_anchors`. It does not.
**`FlatStore.mergeFromNamespace` (`src/flat-store.ts:1293`) already is
this operation**, minus the ability to read across stores. It:

- decodes stored content (`decodeContent`) — which is what makes the
  1-byte-version-prefix-plus-zstd encoding a non-issue rather than the
  cycle it cost the field reporter;
- skips duplicates via `isDuplicateInStore`;
- mints a fresh `node_id` and writes through
  `Persistence.insertNode`, so `nodes_fts` is indexed **under the new
  rowid automatically** — the FTS "rebuild" is a consequence of using
  the shipped write path, not work to be written;
- re-anchors auto rows through `upsertAnchor`, so `dedup_anchors` is
  reconciled by construction;
- preserves `created_at`, `read_only`, `decay_exempt`, `decay_rate`,
  `utility_score`, `source_label`, and stamps `_merge_label` /
  `_namespace` provenance;
- runs the whole loop in one immediate transaction.

So the change is: **generalize the row-reader to accept a source
outside the current namespace, and keep the copy body byte-identical.**
That is a small, reviewable diff against an already-reviewed path,
which is the entire reason to prefer it over a bespoke merge.

**Per NAMESPACE, not once (amended 2026-08-20, F3).**
`mergeFromNamespace` reads one namespace (`WHERE t.namespace = ? AND
ensemble_index = 0`), but a post-chunk-C store is namespace-capable
and a split predecessor may hold agent-lane trees beside `project`.
A store merge that copied one namespace would **silently drop the
other lanes** — the exact silent-loss class this program exists to
kill. `stores merge` therefore enumerates the source store's
namespaces and runs the copy loop once per namespace, into the
same-named namespace of `dst` (created via `ensureTree` when
missing). Disclosure (§5.3) reports per-namespace counts.

### 5.1 Mechanics

One connection, `ATTACH` the source database read-only, read the
source rows through the attached schema, write through the existing
loop. One connection means the existing transaction discipline
carries over unchanged.

Atomicity note: SQLite does **not** provide atomic commit across
attached databases in WAL mode. It does not need to here — the source
is read-only and only `dst` is written, so the single-database
atomicity that `mergeFromNamespace` already relies on is exactly the
guarantee required. State this in the code comment; a future reader
will otherwise "fix" it.

`nodes.parent_id`/`depth` are irrelevant: the store is flat (this
store reports `total_nodes == leaf_nodes == 10001`), and the existing
loop already writes `parentId: null, depth: 0`.

### 5.2 Preconditions, all fail-closed

1. Both stores at the ladder's `maxSupportedVersion`. Refuse on
   mismatch rather than migrating a store the user did not name.
2. `src !== dst`, both resolve inside the stores root (S9).
3. A backup of **both** stores exists, or `--backup` is passed to take
   them (R6). The Online Backup API path already exists
   (`persistence/backup.ts`).
4. No live lease on either store. A merge racing the drain owner is
   not a race worth designing around when refusing is free.

### 5.3 Disclosure

Report imported, **skipped-as-duplicate**, and source total.
`mergeFromNamespace` currently returns only `importedCount`, so a
run that silently drops half its input to the dedup predicate looks
identical to a clean one. Adding the skip count is part of this work.

## 6. Design review of §5 (ruling 232b4219, pre-implementation)

Findings against the design above, to be resolved before code:

- **D1 — node-id remapping breaks lineage.** The copy mints a fresh
  `node_id` per row. Journal metadata references node ids by value:
  `supersedes`, `superseded_by`, and every resume pointer the user has
  written. After a merge, those references dangle — they point at ids
  that exist only in the source store. **Unresolved.** Options: (a)
  build the old→new id map during the copy and rewrite known
  id-bearing metadata keys in a second pass; (b) preserve source
  node ids when they do not collide in `dst` (they are random 128-bit
  hex; collision is not a practical concern) and remap only on
  collision; (c) disclose and accept. (b) is the cheapest correct
  answer and also makes the merge idempotent-ish, but it diverges from
  `mergeFromNamespace`'s current behaviour, so it needs its own
  scenario. **This is the finding most likely to bite.**
- **D2 — dedup silently drops.** `isDuplicateInStore` is
  content-fingerprint based. Two genuinely distinct entries with
  identical text (common for short user messages) collapse. §5.3's
  skip count makes it visible; it does not make it correct. Accept
  with disclosure, but the scenario must pin the count.
- **D3 — `_namespace` provenance.** The existing loop stamps
  `_namespace = sourceNamespace` when absent. For a cross-*store*
  merge the meaningful provenance is the source **store**, not its
  namespace. Needs a distinct key (`_merge_source_store`) so a later
  reader can tell a namespace merge from a store merge.
- **D4 — the detector's blind spot** (§4) must be stated in its own
  output, not only here.
- **D5 — order of operations for repair.** Merging src→dst then
  repointing the src binding at dst leaves the src *store* on disk,
  now orphaned but intact. That is the right default (R6): `stores rm`
  already exists for the user who wants it gone. Do not delete.

## 7. What this program does not do

Part 1 does not repair the five existing splits. Their successor
fingerprint **already has a binding**, so `resolveStoreName` returns
at the `existing` check (`bindings.ts:320`) before succession is ever
consulted. That is by design — a project with a live binding must not
have it silently moved — and it is why parts 2 and 3 exist.

The second project's own journal is out of scope for this repo and stays with
the session that found it. Note the coupling, though: once part 3
lands as a reviewed command, that session's hand-rolled SQLite merge
is unnecessary. If the second project can wait, it should use the real
command.

## 8. Scenario drafts (move to `features/design/store-bindings.feature` at implementation)

```gherkin
Scenario: a project that gains a remote keeps its journal
  Given a directory bound by path to store "proj-ab12cd"
  When a git remote is added and the store is resolved again
  Then the resolved store is "proj-ab12cd"
  And the new binding records source "carried-forward"
  And the path binding still resolves to the same store
  And the resolution is announced, not silent

Scenario: git init above a bound subdirectory discloses, never adopts
  Given a subdirectory bound by path to store "sub-ff0011"
  When git init runs at an ancestor and the store is resolved from the subdirectory
  Then a fresh store is derived
  And the predecessor journal at the subdirectory is disclosed with its store name
  And the subdirectory's binding is not modified

Scenario: the ssh and https spellings of one remote share a store
  Given a project bound by "https://host/org/repo.git"
  When its remote is set to "git@host:org/repo" and the store is resolved
  Then the resolved store is unchanged

Scenario: a monorepo sibling can never be handed the other sibling's journal
  Given "packages/a" bound to store "a-111111"
  And "packages/b" bound to store "b-222222"
  When git init runs at their common root and the store is resolved from "packages/a"
  Then a fresh store is derived
  And the predecessor journal at "packages/a" is disclosed
  And neither predecessor binding is modified

Scenario: two raw URL forms bound to different stores fail closed
  Given "https://host/org/repo.git" bound to store "repo-early"
  And "git@host:org/repo" bound to store "repo-late"
  When the remote is set to "ssh://git@host/org/repo" and the store is resolved
  Then a fresh store is derived
  And the conflict is disclosed

Scenario: a linked worktree of a path-bound project resolves to the project's store
  Given a project without a remote bound by path to store "proj-ab12cd"
  When a linked worktree of it is created and the store is resolved from the worktree
  Then the resolved store is "proj-ab12cd"

Scenario: an already-bound project is never re-pointed by succession
  Given a project bound by git identity to store "proj"
  And a stale path binding naming store "proj-ab12cd"
  When the store is resolved
  Then the resolved store is "proj"

Scenario: doctor names a split without writing a binding
  Given a path binding to "proj-ab12cd" and a git binding to "proj"
  When doctor runs from an unrelated directory
  Then the split is reported with both node counts
  And bindings.json is unchanged

Scenario: merge preserves both journals
  Given store "proj-ab12cd" with 163 entries and "proj" with 599
  When the stores are merged with backups taken
  Then "proj" holds both sets
  And the imported and skipped-as-duplicate counts are reported
  And "proj-ab12cd" is left intact on disk
```

## 9. Node-id generation: rapidhash was considered and rejected

Owner proposal (2026-08-16): replace `randomUUID()` with a fast
portable hash — rapidhash, whose TypeScript port is MIT and bundleable
— salted with a coarse insert time, to "more or less guarantee there
is never a collision."

**Measured against the sources, this moves the wrong way on that goal
and is rejected on the numbers.** Every rapidhash entry point in
`rapidhash.h` returns `uint64_t`; there is no 128-bit output variant.
rapidhash's own quality study states the case plainly: "A function
producing 64-bit hashes should have a $p=1/2^{64}$ of generating each
output… hashing ~16.1B different keys, we should expect to see 7.03
collisions" — and its measured results match that ideal. The hash is
excellent; 64 bits is the ceiling.

`randomUUID()` yields a v4 UUID: **122 random bits**. Collision
probability over *n* ids, $p \approx n^2/2^{b+1}$:

| ids | UUIDv4 (122-bit) | rapidhash (64-bit) |
| --- | --- | --- |
| 10⁴ (this store) | 9.4 × 10⁻³⁰ | 2.7 × 10⁻¹² |
| 10⁶ | 9.4 × 10⁻²⁶ | 2.7 × 10⁻⁸ |

The swap costs 58 bits — collisions become ~3 × 10¹⁷ times likelier.
The time salt does not recover them: salting changes *which* inputs
map where, never the width of the output space. Pigeonhole, not
hash quality.

**The instinct underneath it is right, though, and worth recording.**
A content-derived id (content + `created_at`) would make the merge
*idempotent* — re-running it could not duplicate — and would
distinguish two genuinely distinct entries that share short identical
text, which is exactly D2's weakness. That is a real property random
ids do not give. It is also a far larger change than this program:
it rewrites id generation for every insert, leaves 10k+ existing rows
on the old scheme, and violates R7. Not RC material. Recorded here so
it is not re-derived from scratch later.

**What actually answers the concern** (a collision branch that never
runs is untestable dead code): keep `randomUUID`, preserve source ids
per O1, and make the collision branch *testable* rather than absent.
`node_id` is `TEXT PRIMARY KEY`, so a colliding insert raises a
constraint error — seed `dst` with a row whose id matches one in
`src` and the branch executes deterministically. Roughly five lines,
fully exercised by one scenario, at 122-bit resistance. No new
dependency. Note also that `importJson` (`flat-store.ts:1243`) already
does exactly this: `String(n['nodeId'] ?? randomUUID()…)`. Preserving
source ids is the *existing* behaviour of the import path, not a
divergence the merge would invent.

### 9.1 Getting to 128 bits, if it were needed

For the record, since it was asked: 128-bit output is easy and the
proposed routes both work.

- **Double rapidhash** (`h1 = rapid(m, S₀)`, `h2 = rapid(m, h1)`,
  concatenated) does give ~2⁻¹²⁸ against *accidental* collision: a
  full collision needs both halves to collide, and when `h1` collides
  the second pass runs over two different messages under one identical
  seed, so the halves are effectively independent. Worth knowing it
  does **not** give 128-bit *adversarial* resistance — Joux's
  multicollision result means concatenating iterated hashes buys far
  less than the sum of their widths — but there is no attacker here,
  so the construction is sound for this use.
- **xxh128 / XXH3_128** is purpose-built for it and avoids the
  hand-rolled composition.
- **`crypto.createHash('sha256').digest('hex').slice(0, 32)`** is also
  128 bits, is already used twice in `bindings.ts:208,363`, needs no
  dependency and no bundling, and in Node is native code that will
  comfortably beat a `bigint`-based pure-TS rapidhash. For a
  non-performance-critical path this is the obvious pick.

None of them are needed for `node_id`. **One of them is needed
somewhere else** — see §9.2.

### 9.2 The real collision surface is `contentFingerprint`, and it is not hypothetical

> **RESOLVED by migration 024** (Phase 3, `22fa1df`). The structural
> key described below was the pre-v24 state; `contentFingerprint` is
> now `sha256(normalized)` truncated to 128 bits for all lengths, and
> 024 rewrote every existing store's keys. This section is retained as
> the measured evidence that motivated the change.

Chasing the collision question to ground found a live defect in a
different place than either of us was looking.

`contentFingerprint` (`src/fingerprint.ts:10`) is **not a hash**. For
content over 128 chars it returns a *structural key*:

```
normalized = content.replace(/\s+/g, ' ').trim()
key        = head(64) + "\x00" + tail(64) + ":" + normalized.length
```

Its own doc comment claims a match on head, tail, and length is
"effectively impossible for genuinely different content." **Measured
against this store, that claim is false.** Querying
`~/.treecontext/stores/treecontext/treecontext.db` (10,001 nodes,
read-only) — note `length()` stops at the embedded NUL, so the byte
length via `CAST(… AS BLOB)` is the one that counts:

| measure | count |
| --- | --- |
| rows using the head/tail/length form | 9,835 |
| fingerprints shared by rows with **differing** content | **97** |
| rows sitting in one of those groups | **219** (2.2%) |

Decoded samples, all genuinely distinct content:

- 4 rows, 4 distinct texts, **all exactly 563 chars** — same tool call
  differing only at char 128: task id `bid7uolnu` vs `bl9plkhqf`,
  `"Read round-2"` vs `"Read round-3"`.
- 3 rows, 3 distinct texts, **all exactly 722 chars** — same polling
  loop, GitHub run id `31031655789` vs `31032559224`. Equal digit
  count, so equal length.
- 2 rows of raw length **1265 and 1217** that still collide, because
  the length in the key is the *whitespace-normalized* length. Runs of
  whitespace collapse, so unequal raw lengths reach equal normalized
  ones — a surface the head/tail design does not account for at all.

The pattern is structural, not unlucky: captured tool calls share a
command prefix and a result suffix and differ in a middle identifier
of fixed width. That is the single most common shape in a capture
journal, which is why it is 2.2% of rows rather than zero.

**Why it has not yet destroyed anything.** All 219 are `auto` rows,
and auto dedup is scoped by `liveAnchor` to a 300 s window *and* a
session key, so the colliding pairs simply fell outside the window —
all four members of the 563-char group are still in the store. The
guard held. The key did not.

**Where it becomes data loss, and why that is this program's problem.**
`isDuplicateInStore` (`flat-store.ts:294`) is the predicate
`mergeFromNamespace` uses, and it is what part 3 will run over every
copied row:

- auto rows → `liveAnchor`, window-scoped: a merged row carries its
  original `created_at` and session key, so two colliding auto rows
  from different stores within 300 s of each other **are** silently
  dropped;
- curated rows → `curatedHolder` (`store.ts:570`), which is
  `WHERE tree_id = ? AND fingerprint = ?` with **no window at all** —
  store-wide and permanent. A curated note colliding with any existing
  curated note is skipped outright. (Note the asymmetry: on the
  *insert* path a curated collision is reclassified `curated_dup` and
  kept — `store.ts:384`. Only import/merge drops it.)

This store currently has 121 curated rows and zero collisions among
them, so nothing has been lost yet. Merging two stores multiplies the
pairs being compared.

**Recommendation.** Replace the structural key with a real digest of
the full normalized content — `sha256(normalized)` truncated to 128
bits, per §9.1. Two properties make this safe in the right direction:
a stronger key can only ever *split* an existing fingerprint group,
never merge two, so the curated partial-unique index can only become
easier to satisfy; and the change is invisible to every reader that
treats the fingerprint as opaque.

**Cost, stated honestly.** `nodes.fingerprint` is stored and indexed,
so changing the function requires a migration that decodes and
rehashes every row — the same whole-store decode pass that migrations
021/022 deliberately split to avoid shipping "the slowest migration
ever shipped" twice. Stale auto anchors self-heal within the 300 s
window and need no handling. This is a database change and therefore
carries ruling `232b4219`'s strict cycle in its own right. **It is a
separate program from identity succession** — recorded here because
this is where the evidence surfaced, and because part 3 must not ship
on top of a dedup key with a measured 2.2% false-positive rate. See
O4.

**Status.** This section stays as measured history — the numbers above
describe the pre-v24 store and are not re-measured. The repair is
§11b (Phase 3, schema v24): `contentFingerprint` became
`sha256(normalized).hex.slice(0,32)`, the pre-024 key is frozen as
`contentFingerprintV1` for migration 023's use only, and migration 024
rewrites every decodable row.

## 10. Adversarial review of this note (2026-08-16)

Findings against §§3-5 above. A3 is the one that changed the design.

- **A3 — the ambiguity check was blind to the ambiguity it existed to
  catch.** Had this shipped as drafted, the monorepo case would have
  silently handed one sibling the other's journal — a *worse* failure
  than the defect being fixed, because succession would have written
  the wrong answer confidently instead of leaving an empty store the
  user could see. *A3's original fix (scan the bindings map under the
  successor root) was itself found unimplementable — bindings carry
  only one-way fingerprints — and superseded 2026-08-20 by §3.1's
  structural rule: adoption requires a root-identical predecessor;
  subdirectory predecessors are disclose-only (Fable review, F1).*
- **A8 — preserved ids must be the idempotence key, ahead of content.**
  With O1 (preserve source ids), a re-run's safety currently rests on
  `isDuplicateInStore`, whose content-fingerprint predicate D2 already
  says is unreliable. Check `node_id` presence in `dst` **first** and
  skip on hit; only then consult the content fingerprint. Makes re-runs
  exactly safe rather than approximately safe.
- **A10 — "the store is flat" is an observation, not a guarantee.**
  §5.1 leans on `total_nodes == leaf_nodes` in *this* store. The schema
  still carries `parent_id`/`depth`, and the copy loop hardcodes
  `parentId: null, depth: 0`. A source holding internal nodes (tree-era
  leftovers) would be silently flattened. Make it a precondition check
  (§5.2), not an assumption.
- **A4 — "no live lease" is TOCTOU as written.** Checking for the
  absence of a lease and then merging invites a hook to acquire in
  between. The merge must *take* the `drain` lease on `dst` and refuse
  if it cannot. `src` is read through one immediate transaction, so a
  concurrent writer there costs completeness, not consistency — say
  which of the two is being promised.
- **A1 — succession cost on a store whose binding cannot persist.**
  `resolveDbPath` → `resolveStoreName` runs per hook fire in a fresh
  process (`hooks/shared.ts:51`), so nothing caches. On a miss that
  *cannot be written* (symlink refusal, `unreadable`), every subsequent
  fire re-pays the full probe — ancestor walk plus URL variants — on
  top of the two `execSync` git calls already paid unconditionally,
  inside the 8s budget. Bounded (it needs a persistently unwritable
  bindings file) but real: skip the probe when the last persist failed.
- **A5 — read-only `ATTACH` needs verifying, not assuming.** §5.1
  assumes the source can be attached read-only; that requires URI
  filenames (`file:…?mode=ro`) and depends on the driver build.
  Confirm against better-sqlite3 before relying on it; if unavailable,
  the guarantee must come from the lease and the backup instead.
- **A6 — detector false positives.** `^(.*)-[0-9a-f]{6}$` matches a
  project genuinely named e.g. `my-app-abc123`. Harmless (it reports,
  it does not act) but the word "candidate" in the output is doing
  real work — keep it.
- **A7 — §5.3's skip count changes the MCP response shape** for
  `treecontext_merge_from_agent`. Additive, so acceptable, but it is a
  user-visible contract change and belongs in the CHANGELOG.
- **A11 — residual: rename-before-remote still orphans.** Scope in
  directory `A`, rename to `B`, then add the remote: the probe's
  candidate is `path:B`, which was never bound, so no succession fires.
  Unfixable without content-based project identity. Disclose in the
  detector's output rather than implying full coverage.

## 11. Proposed sequence to RC

> Not binding. The 0.1 charter is RATIFIED and its amendments require
> the sanctioned-change protocol; this is the builder's proposed
> ordering for the owner to ratify or reorder, not an edit to §2 of the
> charter.

Ordering principles, in priority order: never stack new work on an
unreviewed or non-compiling tree; **detect before repairing**, so
migrations run against measured exposure rather than guessed;
no-data-movement work before data-movement work; each database change
alone in its own phase under ruling `232b4219`. Adversarial review
gates every phase.

### Phase 0 — green and land the in-flight v2 tree

The tree does **not currently compile**: applying review finding C#1
gave `extractStatusNamespace` a required `expectedStorePath` (so a
session registering a second treecontext server over a *different*
store cannot publish a foreign namespace into this store's
annotations), and the call site at `server/ingestion.ts:493` still
passes one argument. Note the family resemblance — that finding and
this program's defect are the same failure: **work attributed to the
wrong store, silently.**

- Finish applying the A+B findings; fix the call site and any fallout.
- Suite, typecheck, lint, release-gate green.
- **Owed review:** adversarial review of chunk C + the hardening wave
  (`0125ef9..8289beb`), which was never run.
- Re-surface the pass-3 below-cap notes at close-out, per
  `rc-quality-over-deferral`.
- Push both remotes.

Nothing else can be reviewed coherently until this lands, and it is
already owed.

### Phase 1 — stop the bleeding (parts 1 + 2)

Succession in `resolveStoreName` including the §3.1 fix, plus the
split detector. No data movement, no schema change, no migration —
the lowest-risk phase in the program, and after it no *new* project
can split. The detector ships here rather than later so that the
repair phases run against measured exposure across all 65 bindings.
Charter continuity scenarios (§8) bind here. **Review gate.**

### Phase 2 — make silence loud

The phase that answers the actual complaint. A long beta missed this
because **both defects are silent by construction**: a split binding
raises no error, it just yields an empty store, and in a memory tool
absence reads as "I never wrote that down," not "the tool lost it."
The fingerprint collision is likewise invisible — a dropped row leaves
nothing behind. No beta tester will ever report either.

Fixing the two bugs does not fix that. This phase generalizes the
Phase 1 detector into a self-audit surface that makes the whole class
loud: split bindings; fingerprint-collision groups (§9.2's query);
bound-but-empty stores whose sibling identity holds data; capture
health. Read-only throughout. It must ship **before** the RC so the
closed-beta cycle (gate item 6) can finally report this class instead
of silently absorbing it. **Review gate.**

Expect this to make the beta noisier, and treat that as the system
working rather than as new breakage.

### Phase 3 — `contentFingerprint` repair (database change)

Per O4, before the merge: one whole-store decode-and-rehash migration
instead of two, and the merge then runs through a key not already
shown to merge distinct rows. Strict cycle: design review →
implementation → **review gate**.

### Phase 4 — `stores merge` and the five repairs (database change)

Part 3, on the design in §5 with §6's findings resolved. Backups
first; source stores left intact (D5). Repairs the five existing
splits, treecontext's own among them. Strict cycle, **review gate**.

### Phase 5 — the §4 gate

Mutation protocol over every seam touched in Phases 0-4; full
release-diff adversarial review (0.0.16 three-pass template); full
three-OS matrix after the last push; README + CHANGELOG accurate for
every changed surface; dogfood pin advance. Then the rc.1 bump and
tag, and the closed-beta cycle — this time with the Phase 2 detectors
live.

### What is deliberately not in this sequence

`ccr` pane fixes stay deferred under charter §3 (owner's other repo,
hands-off by ruling). the second project's journal stays with the reporting
session (§7), though it should wait for Phase 4's command rather than
hand-rolling a merge.

### The one honest alternative

If schedule pressure forces a cut, Phases 3 and 4 are the only
candidates — and only if Phase 2 ships, so users can *see* the
exposure the RC carries. That contradicts the standing
finish-known-work-before-release rule, so it is an explicit owner
decision, not a builder default. Phases 0-2 are not cuttable: Phase 0
is owed, Phase 1 stops ongoing damage, Phase 2 is what keeps the next
beta from being as blind as the last one.

## 11a. Phase 2 design — make silence loud (pre-registered 2026-08-20)

> Written before Phase 2 code per the amendment-8 pattern; the build
> agent implements exactly this. Ruled context: 1ddad164 (Phase 2 is
> first-class — the deliverable is the CLASS, and the class is
> "attributed to / merged into the wrong place, silently").

**Home: `treecontext doctor`.** It is already the diagnosis surface
with graded findings, fix lines the corpus holds to the
clears-the-finding rule, and the read-only discipline Phase 1b
extended machine-wide. No new command; the closed beta reports what
doctor shows by default.

The checks, all read-only, each disclosing its own blind spots:

1. **Split candidates** — Phase 1b's check, already landed.
2. **Fingerprint-collision groups** (§9.2's query, per bound store):
   groups sharing a fingerprint with more than one distinct content,
   reported as group count + rows affected, with the
   `length(CAST(fingerprint AS BLOB))` form so the embedded NUL cannot
   hide the head/tail keys. An unopenable store degrades to "?". The
   row is INFO until Phase 3 ships the rehash, then its fix line names
   the migration release; it must state that colliding rows are only
   at risk on import/merge paths, not in place. After Phase 3, rows
   whose fingerprint is NULL or not 32-hex (undecodable content kept
   its pre-024 value) are reported as their own "unmigrated key" line,
   never folded into the collision count — that is what keeps "reads
   zero after migration" true (§11b review, finding 10).
3. **Bound-but-empty stores** — a binding whose store holds zero
   nodes, reported with the binding's age: a store bound long ago and
   still empty is the orphaned-successor shape even when the
   name-shape heuristic cannot pair it. INFO, with the disclosure that
   emptiness alone proves nothing (a genuinely new project is empty
   too).
4. **Capture debt, current store** — dead-letter count and oldest
   unprocessed staging age, surfaced in doctor rather than only in the
   sidecar pane, so a store silently failing to drain is visible from
   the diagnosis surface everyone is told to run.

**Corpus**: one scenario per check in the doctor corpus (seeded
fixture → reported; healthy fixture → not reported), plus pins that
the collision query uses the BLOB-length form and that every check
runs without writing. **Unit pins** for the collision-group query
shape against a seeded store.

**Out of scope for Phase 2**: any repair, any write, `stores list`
changes beyond what 1b already did, and cross-store content
comparison (the merge's dedup preview belongs to Phase 4).

## 11b. Phase 3 design — the fingerprint becomes a digest (pre-registered 2026-08-20)

> The §9.2 repair, a database change under ruling 232b4219: this
> section is the design; an adversarial review of it precedes code.

**The function.** `contentFingerprint` returns
`sha256(normalized).hex.slice(0, 32)` (128 bits, §9.1's no-dependency
route) for ALL lengths — the short-content fast path retires too, so
one uniform key with one property: equal fingerprints ⟺ equal
normalized content (up to a 2⁻¹²⁸ accident). Whitespace
normalization stays — collapsing runs is the DESIGNED equivalence,
only the head/tail/length structure retires. The doc comment's
falsified "effectively impossible" claim is rewritten to state the
measured reason for the change.

**Safety property, load-bearing:** the new key is a strict refinement
— equal normalized content gives equal old AND new keys; distinct
normalized content can share an old key (measured, 2.2%) but not a
new one. Groups only ever SPLIT. Therefore the curated partial-unique
index `(tree_id, fingerprint) WHERE dedup_class='curated'` cannot
gain a violation from the rewrite.

**023 is frozen first.** `arbiter-backfill.ts` imports the live
`contentFingerprint`, so changing the function would silently rewrite
a SHIPPED ladder step — the exact thing `022_interim_heal.ts`'s
tombstone rule forbids ("a ladder position, once released to any
store, is never renumbered"). 023 is pinned to
`contentFingerprintV1`, a verbatim copy of the pre-024 body, so a
store entering at v20 and one entering at v23 climb identical rungs
and 024 is the only step that ever writes the digest key. (Design
review 2026-08-20, finding 1 — this also retires O4's "one
whole-store decode pass" claim: a store below v23 pays 023's pass AND
024's, in one exclusive batch; accepted, because frozen history
cannot be merged into a new rung.)

**Migration 024**, classified DESTRUCTIVE so the runner takes the
`VACUUM INTO` backup. **The verdict is NOT protection here** (review
finding 3): `recordCompletionVerdict` compares `nodes` COUNT(*) only,
which a value rewrite cannot change — it reads `success` whatever the
pass writes, and a `success` verdict makes the backup SWEEP-ELIGIBLE
(`isLiveRollback` is `verdict !== 'success'`). So: the migration
carries its own in-transaction self-check — every rewritten
fingerprint matches `^[0-9a-f]{32}$`, the curated unique index
recreates without conflict, and the anchor count is preserved modulo
deliberately dropped orphans — and throws (rolling the batch back)
on any failure. Undecodable-row and reclassified counts are disclosed
via `dbg('migration', …)` (023's precedent); the CHANGELOG tells
anyone wanting a durable rollback to copy the `.bak` aside before
sweeping.

The pass — order is load-bearing (review finding 4; per-row
reclassification against a live holder is order-dependent and can
violate the unique index mid-flight):

1. Snapshot `(node_id, dedup_class)` into a temp table, then
   `DROP INDEX idx_nodes_curated_fp` (023's own idiom).
2. Rewrite every decodable row's fingerprint,
   keyset-chunked. An undecodable row keeps what it has — NULL on a
   store that entered below v23 (023 leaves undecodables NULL), a
   stale old-form key on a v23 store. The ⟺ invariant is therefore
   scoped to rows carrying a 32-hex fingerprint.
3. Blanket-promote `curated_dup` → `curated`, then re-run 023's
   ROW_NUMBER earliest-wins demotion verbatim over the FINAL
   fingerprints. Correct by construction against the final state;
   earliest-wins preserved structurally. Reclassified count = rows
   whose class differs from the snapshot.
4. `dedup_anchors` (mandatory, review findings 5/6 — anchors are
   pruned on wall time at 24h, and on a sub-v23 store 023 has just
   seeded one per distinct (tree, session, fingerprint); an anchor
   left on an old key is invisible to `liveAnchor` and every
   in-window duplicate re-inserts): first DELETE anchors whose node
   is gone or whose node's fingerprint is NULL (the correlated-UPDATE
   spelling would write NULL into a NOT NULL PK column and abort the
   ladder — the reproduced 023-era failure), then rebuild the
   surviving rows from a temp-table join against `nodes`, preserving
   `last_seen`/`updated_at`. Convergence is impossible by the
   refinement property; the rebuild only avoids transient PK states.
5. Recreate `idx_nodes_curated_fp`; run the self-check; done.

**Invariants the anchor rewrite leans on** (verified in review,
finding 8 — name them so nobody "fixes" them): anchors are auto-only
(seeded, upserted, and demotion-re-anchored only for auto rows), and
an anchor's fingerprint always equals its node's (updateNode drops
anchors on rewrite). Two OTHER things called "fingerprint" are not
content fingerprints and must not be touched: `bindings.ts`'s
project-identity fingerprint and `event-processing.ts`'s pending-key
`record.fingerprint`.

**Cost, honestly** (review findings 7/11): 023's comparable pass
measured 530 ms on a 4.8k-row store; the dogfood store is now ~10.7k
rows and the sub-v23 upgrade cost is backup + two passes + VACUUM +
checkpoint under ONE exclusive lock, during which concurrent hook
`writeStaging` blocks on its 8 s budget and drops capture beyond it —
the codebase names this exact mechanism as a capture-loss cause.
Measure the end-to-end hold on a dogfood-sized fixture before
release and disclose the expected one-time capture gap in the
CHANGELOG. Note also: while 024 is pending, `{migrate:false}` opens
of a v23 store refuse with MigrationRequiredError until a writable
open migrates (doctor is unaffected — raw read-only, no ladder).

**What does NOT change:** import/merge recompute fingerprints from
content (verified — `isDuplicateInStore` callers hash fresh, never
trust a carried fingerprint), so old exports import correctly;
exports carry no fingerprint column; staging carries none; FTS
carries none; echo heal reads none. Old binaries refuse a v24 store
(forward-only ladder, G1 precedent); the insert path picks the new
function up in the same release. One debug surface degrades
(`flat-store.ts` prints `fp.slice(0,32)…` in a refusal message —
becomes the whole hash plus a lying ellipsis; print the fp and node
id instead).

**Sanctioned rewordings riding the change** (review finding 12):
`maxSupportedVersion` pin 23→24 and the `rerunFrom20`
double-run/backup-fixture consequences in `migration-021.test.ts`;
the head/tail losslessness rationale comments in
`arbiter-backfill.ts`, `flat-store.ts` (eviction tombstone), and
`store-as-arbiter.feature`/`store-as-arbiter.md` — each reworded to
keep 023's SHIPPED behavior (V1 key) honestly described; §9.2 stays
as measured history with a pointer here.

**Corpus:** the §9.2 measured shape becomes a scenario (two contents
sharing head, tail, and normalized length — task-id-in-the-middle —
no longer dedup); a migration scenario (a seeded false-collision
`curated_dup` heals to `curated`, backup + verdict recorded, counts
disclosed); doctor's Phase-2 collision check reads zero after
migration on the same fixture. **Unit pins:** fixed-width
middle-identifier contents get distinct keys; whitespace-only
variants still share one; the refinement property on a seeded
old-collision corpus; determinism.

## 11c. Phase 4 design consolidation (pre-registered 2026-08-20)

> §5 is the mechanism, §6 its review, §10 the note's own review. This
> section fixes every open disposition so the build reads settled
> paper. Rulings: 60432cf2 (part 3 in, strict cycle), owner 2026-08-20
> (all five repairs proceed, backups first, as dogfooding).

- **Command**: `treecontext stores merge <src> <dst>` with
  `--backup` (take fresh backups of BOTH stores via the shipped
  backup machinery) and `--yes` (the stores CLI's existing
  destructive-op gate). Without `--backup`, refuse unless a fresh
  backup of both already exists this calendar day; say which is
  missing.
- **O1/A8 — ids**: preserve source `node_id`s. The copy checks
  `node_id` presence in dst FIRST and skips on hit — the idempotence
  key, ahead of the content predicate (a re-run imports 0). 128-bit
  random ids make a foreign collision a non-concern; `importJson`
  already behaves this way, so this is the import path's semantics,
  not an invention.
- **F3 — namespaces**: enumerate src's namespaces
  (`ensemble_index = 0` trees), copy each into the same-named dst
  namespace, `ensureTree` creating it. Per-namespace disclosure:
  imported / skipped-as-duplicate / skipped-existing-id / src total.
- **D3 — provenance**: `_merge_source_store: <src>` stamped alongside
  the existing `_merge_label`; `_namespace` keeps the source
  namespace name as today.
- **A10 — flatness precondition**: refuse when src holds any
  non-leaf row (`total_nodes != leaf_nodes`) instead of silently
  flattening tree-era leftovers.
- **A4 — locking**: TAKE the `drain` lease on dst (refuse when held —
  not a check-then-merge TOCTOU); src is ATTACHed read-only and read
  inside the same immediate transaction, so a concurrent src writer
  costs completeness, never consistency — the disclosure states which
  is promised.
- **A5 — read-only ATTACH**: verify better-sqlite3 honors
  `file:…?mode=ro` at build time; if it does not, the lease + backups
  carry the guarantee and the code comment says so.
- **Versions**: both stores at `maxSupportedVersion` (post-024), read
  via a no-migrate version probe; refuse mismatch rather than migrate
  a store the user did not name (§5.2).
- **S9**: both names CLI-addressable and resolving inside the stores
  root; `src !== dst`.
- **--repoint**: after a successful merge, rewrite every
  bindings.json entry whose store is `<src>` to name `<dst>`
  (preserving each entry's source value), so the split pair resolves
  to one journal. Without the flag, print the repoint as the next
  step. Bindings write goes through the shared preserve-never-clobber
  save path.
- **D5**: src left intact on disk always; `stores rm` remains the
  user's explicit follow-up. The five repairs run with `--backup
  --repoint`, the second project included (ruling 2026-08-20), doctor's
  split check verified clean after each.
- **A7 — MCP surface**: `FlatStore.mergeFromNamespace` gains the skip
  counts the CLI needs; `treecontext_merge_from_agent`'s response
  carries them additively — CHANGELOG line required.
- **Corpus**: §8's merge scenario, plus: agent-lane namespaces
  survive a store merge (F3 — the loss class this program exists to
  kill); a re-run imports zero (idempotence via preserved ids); every
  refusal precondition (version mismatch, missing backup, held drain
  lease, self-merge, outside stores root, non-flat src) refuses with
  its own message; `--repoint` collapses a split pair and doctor
  reads clean. Unit pins for the namespace enumerator and the
  skip-count arithmetic.

## 12. Open decisions

Settled 2026-08-20: **F1's shape** (adoption requires a
root-identical predecessor; subdirectory predecessors disclose-only)
was accepted by the owner and is now §3/§3.1. **F9** (worktree →
primary-repo identity, §3.4) enters Phase 1's scope alongside it.

- **O1** — D1's resolution: remap lineage, preserve source ids, or
  disclose. Recommend **preserve source ids, remap only on collision**.
- **O2** — does part 1 also *repair* a detected split when the
  predecessor store is empty and the successor is not (or vice versa)?
  Recommend **no**: repair is part 3's job, under backup, with
  disclosure. Part 1 stays a resolver.
- **O3** — should `carried-forward` bindings be visible in
  `stores list`? Recommend yes, cheaply: it is the audit trail for an
  action the user did not initiate.
- **O4** — §9.2: does the `contentFingerprint` repair ship *before*
  part 3, or does part 3 ship with the measured 2.2% false-positive
  rate and disclose it? Recommend **before**: part 3's whole purpose
  is to move a journal without losing entries, and D2 plus §9.2
  together mean it would do so through a key already shown to merge
  distinct rows. Sequencing it first also means one whole-store decode
  migration rather than two.
