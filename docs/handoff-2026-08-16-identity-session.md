# Handoff: the 2026-08-16 identity session (Opus 5)

> **RESOLVED 2026-08-20** — Fable's adversarial review
> (`docs/review-2026-08-20-fable-adversarial.md`, node `e8a913af`)
> confirmed every claim below; the owner ruled: keep everything, no
> back-out; §5.1's rung order restored to the ratified session-first
> (C#2's inversion reverted, lease corroboration kept, the
> `NS_ANNOTATION_STALE_MS` deletion ratified); the F7 allow-list
> blessed. The red test in §5.1 is green via the ruling. Suite 1675
> passed / 2 todo, typecheck+lint+release-gate clean, still unpushed.
> This file is now historical record; §§0, 4.7, 5, 8 no longer
> describe the tree.

> **Read this before touching the tree.** It is the durable copy of
> treecontext checkpoint node `922d7e2a91cc4f51857e955fd343ca85`, written because the journal
> itself is one of the things this session found a defect in.
>
> **Purpose:** let a reviewer decide, per item, whether to keep or back
> out. Nothing here is pushed. Both remotes are still at `8289beb`.
>
> **Posture:** this session was NOT the plan. It began as "document a
> bug reported from another repo" and grew into three commits plus an
> uncommitted change, some of it reversing decisions that were reasoned
> through elsewhere without asking first. §4 marks exactly which. The
> owner halted it at that point; that call was right.

---

## 0. Git state, exactly

Base: `8289beb` (docs+hardening, the last commit of the v2 program).

| | commit | contents | risk |
| --- | --- | --- | --- |
| 1 | `fcd87b5` | `docs/project-identity.md` only, 715 lines. **No code.** | none |
| 2 | `4d7e301` | Phase 0 — 10 files, +403/−129 | mixed, see §4 |
| 3 | `4c84d83` | review findings — 6 files, +103/−15 | mostly low, see §4 |
| — | uncommitted | 8 files, +313/−81 — the lease-corroboration change | see §4.9 |

Suite right now: **1 failed | 1671 passed | 2 todo**. The single failure
is deliberate and is described in §5.1 — it marks an unresolved
spec/code conflict and should not be "fixed" without a ruling.

`dist/` was rebuilt during verification (it is gitignored). Rebuild or
ignore as convenient.

---

## 1. The reported bug (why this session started)

A session in another repo (`second-project`, its real name withheld) found that a project's
treecontext journal is silently orphaned when the project's identity
source changes. Full write-up: `docs/project-identity.md` §1.

**Mechanism** — `src/server/bindings.ts:235` `projectIdentity()`:

```
identity = git:<remote.origin.url>            when a remote exists
         | path:<realpath(gitRepoRoot ?? findProjectRoot(cwd))>
fingerprint = sha256(identity)[0:16]
```

`resolveStoreName` misses on the new fingerprint, derives a fresh name,
writes a new binding, opens a **new empty store**. The old journal is
not deleted — it is unaddressable. No warning, no migration, no link.

**The report named `git init` as the trigger. That is wrong**, and it
matters because a warning wired to `git init` would fire at the wrong
moment. Measured against `dist/` at `8289beb`:

| # | Trigger | Transition |
| --- | --- | --- |
| 1 | `git remote add origin` / `gh repo create` / `push -u` | `path:<root>` → `git:<url>` |
| 2 | `git init` when the recorded cwd was a **subdirectory** | `path:<subdir>` → `path:<repoRoot>` |
| 3 | Remote URL **form** change (https↔ssh, `.git`, rename, org move) | `git:<url1>` → `git:<url2>` |

`git init` alone at the project root does **not** rebind (verified:
`root-before-init == root-after-init`). Trigger 1 is confirmed for
the second project by the successor store's name — `second-project` can only come
from `slugFromGitUrl`, which requires a remote. Trigger 3 has no
path-bound precondition, so it puts already-git-bound projects in scope
too. A clone of the same remote at a second path correctly shares one
store.

**Population, `~/.treecontext/bindings.json`:** 65 bindings — 44 `path`,
20 `git`, 1 `migrated-sticky`. Five confirmed splits, always path-first:
`research-project` (08-01→08-02), `ccr` (06-20→06-24), `second-project`
(08-14→08-15), `third-project` (06-30, 38 min apart), `treecontext`
(07-29→08-01). **treecontext's own store is one of them.**

**Why it hits this workflow:** `/scope` runs before code exists so it
binds by path; the build session adds the remote and rebinds. The
ratified scope contract lands where the build session cannot see it.
Corollary worth keeping: `gt`'s "Reviewed set: 0" was never a `gt`
weakness — it read an empty store, correctly.

**Why nothing caught it:** `features/design/store-bindings.feature` has 7
scenarios, all about *file integrity* (corrupt side-filing, symlink
refusal, unsafe-value dropping). Zero about *identity continuity*. The
invariant was never written down, so nothing could fail.

**Proposed fix — IN, and not implemented.** `docs/project-identity.md`
§3: on a fingerprint miss, before `deriveName`, probe predecessor
identities; adopt on unanimity, write `source: 'carried-forward'`, leave
the old binding pointing at the same store, announce it. §3.1 records
the flaw the first draft had (see §6.1 below). §4 is a doctor detector,
§5 a `stores merge` built by generalizing `FlatStore.mergeFromNamespace`
(`src/flat-store.ts:1293`), which already does the decode / FTS
re-index / anchor reconciliation. **No code for any of this was
written.**

---

## 2. The second live defect found (not reported, not fixed)

`docs/project-identity.md` §9.2. Surfaced while chasing an unrelated
question about node-id collisions.

`contentFingerprint` (`src/fingerprint.ts:10`) is **not a hash**. For
content over 128 chars it is a structural key:

```
normalized = content.replace(/\s+/g, ' ').trim()
key        = head(64) + "\x00" + tail(64) + ":" + normalized.length
```

Its own doc comment calls a head/tail/length match "effectively
impossible for genuinely different content". **Measured against
`~/.treecontext/stores/treecontext/treecontext.db` (10,001 nodes,
read-only), that is false:**

| measure | count |
| --- | --- |
| rows using the head/tail form | 9,835 |
| fingerprints shared by rows with **differing** content | **97** |
| rows in one of those groups | **219** (2.2%) |

Measurement gotcha that hid it: SQLite `length()` stops at the embedded
NUL, so `length(fingerprint)` reports 64–127 and the head/tail form
looks absent entirely. Use `length(CAST(fingerprint AS BLOB))`.

Decoded samples, all genuinely distinct:

- 4 rows, 4 distinct texts, **all exactly 563 chars** — same tool call,
  task id `bid7uolnu` vs `bl9plkhqf`, `"Read round-2"` vs `"round-3"`.
- 3 rows, **all exactly 722 chars** — same polling loop, run id
  `31031655789` vs `31032559224` (equal digit count).
- 2 rows of raw length **1265 and 1217** that still collide, because the
  length in the key is the **whitespace-normalized** length.

Structural, not unlucky: captured tool calls share a command prefix and
a result suffix and differ in a middle identifier of fixed width.

**Nothing lost yet.** All 219 are `auto`, and auto dedup is scoped by
`liveAnchor` to a 300 s window *and* session key, so the pairs fell
outside the window. The guard held; the key did not.

**Where it would bite:** `isDuplicateInStore` (`flat-store.ts:294`) is
the predicate `mergeFromNamespace` uses — i.e. what a `stores merge`
would run over every copied row. Auto rows carry their original
`created_at`, so colliding rows within 300 s **are** dropped; curated
rows go through `curatedHolder` (`store.ts:570`), which is store-wide
with **no window at all**. Asymmetry worth knowing: on the *insert* path
a curated collision is reclassified `curated_dup` and kept
(`store.ts:384`); only import/merge drops it. This store has 121 curated
rows and zero collisions among them today.

**Recommendation (not implemented):** `sha256(normalized)` truncated to
128 bits. A stronger key can only *split* an existing fingerprint group,
never merge two, so the curated partial-unique index can only get easier
to satisfy. Cost is a whole-store decode-and-rehash migration, so it is
a database change under ruling `232b4219` in its own right.

---

## 3. What was already broken when this session started

State inherited at `8289beb` with a dirty tree (the in-flight chunk-A/B
review findings, partly applied):

1. **The tree did not compile.** `npm run typecheck` failed at
   `src/server/ingestion.ts:493` — review finding C#1 gave
   `extractStatusNamespace` a required `expectedStorePath` and the call
   site was never updated.
2. Four more half-applications the compiler could not see (§4.2–§4.5).
3. The chunk-C + hardening wave (`0125ef9..8289beb`) had **never been
   adversarially reviewed**; that review was already owed.

---

## 4. Everything touched, itemized

Classification: **[U]** unambiguous (broken build, dead code, false
comment) · **[B]** behavior change made without asking · **[R]** ruled
by the owner during this session · **[S]** specification edit.

### 4.1 `fcd87b5` — the design note. **[U]**
`docs/project-identity.md`, 715 lines, no code. Contains §1–§5 (bug and
proposed fix), §6 (design review of the merge), §8 (7 scenario drafts),
§9 (node-id / rapidhash analysis), §9.2 (the fingerprint defect), §10
(adversarial review of the note itself), §11 (RC sequencing proposal,
explicitly marked non-binding — the charter is ratified and amendments
need the sanctioned-change protocol), §12 (open decisions O1–O4).
**Back-out:** delete the file. Nothing depends on it.

### 4.2 `4d7e301` — `extractStatusNamespace` call site. **[U]**
`ingestion.ts:493` given `this.storePath` and `row.previewLen`; the
`storePath` now gates the whole branch (without one there is no
discriminator, so nothing is provable). Fixes the build.

### 4.3 `4d7e301` — `extractInsertEcho` call site. **[U]**
`ingestion.ts:462` was still passing one argument after the function
gained an optional `previewLen`, silently keeping the old unbounded
scan. Compiler-silent because the parameter is optional.

### 4.4 `4d7e301` — publish gate: negative list → allow-list. **[B]**
`CORRELATED_ECHO_OUTCOMES` was defined in the dirty tree and **never
consumed**; the gate still ran
`outcome !== 'not-found' && outcome !== 'not-curated'`. Wiring it
**changes behavior**: `outside-window` and `unreadable` stop counting as
namespace evidence. Justification is in the constant's own doc comment
(C-finder: a negative list silently admits new members), so the decision
appears to have been made — but wiring it was not asked for.
**Back-out:** restore the two-term negative comparison.

### 4.5 `4d7e301` — session-annotation sweep wired. **[B]**
`sweepSessionNamespaceAnnotations` was written whole, documented "called
from the drain owner's sweep tick", and called from nowhere;
`SESSION_NS_ANNOTATION_TTL_SECS` was unused. Now called from
`runSweep()` under a `storePath` guard. Effect: `sessions/` stops
growing one file per session forever (it shares a readdir with rung-3
resolution on every insert). Low risk but it is new runtime behavior.
**Back-out:** remove the block from `runSweep`.

### 4.6 `4d7e301` — `FULL_TAIL_SEPARATOR` de-duplicated. **[U]**
Was declared in both `post-tool-use.ts` and `capture-constants.ts` — the
exact drift the new constant was added to prevent — with post-tool-use's
copy still commented "Cosmetic", untrue once `outputSection` began
bounding scans on it. Now imported and re-exported from the one owner.

### 4.7 `4d7e301` — **the specification edit that should not have happened. [S]**
`journal-session-namespace.feature`'s scenario "the session rung
outranks the pid rung when both resolve" was failing. It was rewritten
to assert pid-first, on the strength of a code comment citing "review
2026-08-15, C#2", **without opening the design note**. See §5.1 — the
design says the opposite. The corrected version is in the working tree,
not in this commit. **A reviewer backing out to `4d7e301` inherits the
wrong feature file.**

### 4.8 `4c84d83` — six adversarial-review findings.
Review of `0125ef9..HEAD`, `/code-review high`, which also discharged
the owed chunk-C review (§3.3).

- **The one that mattered [U]:** C#1's `store_path` discriminator was a
  bare `startsWith`, so it only rejected foreign paths *shorter* than
  ours. Confirmed against the built module:
  `extractStatusNamespace(echo naming "/x/y.db.old/treecontext.db",
  expected "/x/y.db") === "theirs"`. `/x/y.db.old/` is a backup
  directory beside the store. The guard added to stop a cross-store
  misroute permitted it in the direction that actually occurs. Now the
  matched prefix must be followed by the value's closing quote.
  **Note:** the test added in `4d7e301` *claimed* to cover this and
  tested the harmless direction instead. Both directions plus the
  exact-match case are pinned now.
- **[U]** Sweep comment claimed drain-owner exclusivity that does not
  exist (`runSweep` has its own timer, takes no lease). Comment
  corrected, behavior unchanged.
- **[B]** `healCuratedSessionIdentity` read only the V2
  `_cc_session_echo_asserts` key, so a row healed by the OLD code lost
  an already-disclosed candidate on its next in-window echo ("cc-A or
  cc-B" → "cc-A or cc-C"). Seeded from legacy `_cc_session_candidates`,
  but **only when `src === 'echo'`** — a `beacon-ambiguous` list is an
  insert-time guess and causal evidence retires those. Both halves
  pinned; that upgrade path had no test.
- **[U]** `hooks/shared.ts` comment and `CHANGELOG.md:56` both still
  described the pre-C#2 rung order. **Caveat:** these were edited to
  match the code, and per §5.1 the code's order is itself disputed. If
  the ruling goes the other way, both revert.
- **[B]** A namespace the CLI accepts (`SAFE_STORE_RE`) but the
  publisher refuses (`isCliAddressableStoreName` — `.`, `..`, leading
  dash) made §7.8 publish nothing forever with no diagnostic. Still
  refused; now logged.

### 4.9 Uncommitted — lease corroboration. **[R]**, on a bad premise
Asked and ruled: *"latter, but only if you can reliably prove it and
there's an expiration mechanism."*

- New `nsLeaseLiveFor()` in `src/persistence/leases.ts` — one
  primary-key lookup: `ns:<namespace>` held by this pid on this host
  with `heartbeat_at + ttl_secs > now`. Defensive `try/catch` so a
  pre-021 store without a `leases` table degrades instead of throwing on
  the hook path.
- `resolveHookNamespace` gains a **required** `corroborate` callback and
  no longer probes pids. `isPidAlive` deleted (only use). Production
  passes `nsLeaseLiveFor`; the hook already holds the database open, so
  the cost is one SELECT.
- **`NS_ANNOTATION_STALE_MS` (24 h) deleted. [B] — this is the one that
  slipped through as a side effect.** Its comment cites *program-C
  review finding 5* by name. It was removed because the lease provides
  better expiration, and because measuring from `written_at` (stamped
  once at startup, never refreshed) also rejected servers legitimately
  alive over a day. That reasoning may be right, but it was a ruled
  decision and deserved its own question.
- Tests: 6 new `nsLeaseLiveFor` unit tests; `resolveHookNamespace` tests
  now pass explicit named corroborators so each states its premise; two
  fixtures (`namespace-stamp.test.ts`, the subagent step in
  `features.test.ts`) now seed the `ns:` lease a real server holds —
  fixture changes, scenario text untouched; the retired 24 h test
  replaced by two that state the real rule.

**Back-out:** `git checkout -- .` removes all of §4.9 and, with it, the
disputed red test in §5.1.

---

## 5. Open disputes — need a ruling, do not resolve silently

### 5.1 Rung order (the red test)

Three artifacts disagree:

| Artifact | Says | Authority |
| --- | --- | --- |
| `docs/session-identity.md` §7.8 L519-527 | **session rung first** | ratified design |
| `journal-session-namespace.feature` | session rung first (restored) | charter |
| `src/session-beacon.ts` | **pid rung first**, citing C#2 | code comment, unpushed, unratified |

The design's words: *"`resolveHookNamespace` gains a **first rung**: the
annotation keyed by the hook's **payload session id** … the ppid-keyed
annotation **remains as the rung below** … session ids are never
recycled, so a session annotation can only ever describe the session it
names."* Its own scenario draft at L573 matches. Node `831270a6` records
chunk C as shipping *"session rung ahead of ppid rung"*.

C#2's counter-argument is real: the session file refreshes only when an
echo drains, so after a **mid-session relaunch under a different
`--namespace`** it may still name the previous run while a live server's
fresh claim is ignored.

**Input for the ruling, discovered late:** the ppid rung **never fires
on Windows** (`session-beacon.ts:143` — `.cmd` wrappers cannot exec, so
server and hooks see different parents; the session-keyed channel is the
primary channel there). Under C#2's inversion, Linux and macOS would
make their primary rung one that structurally does not exist on Windows,
so the platforms would trust different evidence for the same situation.
That argues for the ratified order. An earlier claim in this session
that lease corroboration "weakens the design's case" was wrong — the
design's reasons are causality and Windows, neither of which
corroboration touches.

The failing test is left red on purpose. **Do not make it green without
ruling.**

### 5.2 Open decisions carried in `docs/project-identity.md` §12
O1 (node-id remap vs preserve on merge), O2 (should succession repair an
existing split), O3 (surface `carried-forward` in `stores list`), O4
(fingerprint repair before or after the merge).

---

## 6. Blast radius named but NOT fixed

### 6.1 The succession design's own near-miss
The first draft of the fix scoped its ambiguity check to `cwd`'s
ancestry — so in a monorepo each sibling would see exactly one
predecessor and adopt it "unanimously", handing whichever hook fired
first the other's journal. Worse than the defect: a confident wrong
answer instead of a visibly empty store. Corrected in §3.1 (key the
check on the successor identity, scan the bindings map). **This lives in
the design note only; no code exists.**

### 6.2 The pid rung is not "safe", even with corroboration
Corroboration fixes exactly one thing: a dead server's `server_pid`,
recycled onto a live stranger, passing a liveness probe. It does **not**
fix:
- **Windows** — the rung never fires there at all.
- **Claude-pid binding.** The annotation is tied to the Claude process
  by *filename only* (`pid-<claudePid>.ns.json`). Nothing revalidates
  that the corroborated live server serves *this* session. Narrow in
  practice (a stdio server dies when its parent's stdin closes) but open.

### 6.3 Servers that never take the `ns:` lease
Corroboration assumes every serving process holds `ns:<namespace>`.
True for `treecontext serve` (`cli.ts:1193`), and the shipped MCP
launcher runs `serve` (`installer.ts:304`). **Not** true for a
library/embedded consumer calling `startServer` directly — their hooks
lose rung 1 and fall to the causal rung. Safe degradation, not a wrong
answer, but it is a behavior change for that path and is not enforced
structurally.

### 6.4 The 44 path-bound projects
Every one is a live candidate for triggers 1 and 2; every binding is a
candidate for trigger 3. Untouched. No detector exists yet.

### 6.5 the second project's own journal
Left with the reporting session, deliberately. Note the coupling: if a
reviewed `stores merge` ever lands, that session's hand-rolled SQLite
merge becomes unnecessary.

---

## 7. Process failure, recorded so it is not repeated

Feature files, design notes, and code **triangulate**. In §4.7 a failing
charter scenario was resolved toward the **least authoritative** of the
three — a reviewer's argument in a code comment, in an unpushed tree,
never ratified — without opening the design note. It was then reported
to the owner as settled, which framed a subsequent ruling on a false
premise.

Authority order: owner ruling > design note > feature file > code. A
review finding quoted in a code comment carries none. When a charter
scenario fails, open the design note *first*. If the design is on the
other side, stop and ask. One honest red test naming the conflict beats
a green suite hiding it.

The same applies to §4.9's deletion of a constant whose comment cited a
named review finding: that is a ruled decision, and it needed its own
question rather than riding along with another change.

---

## 8. Back-out recipes

| Goal | Command |
| --- | --- |
| Clean baseline, keep only documentation | `git reset --hard fcd87b5` |
| Drop the disputed lease work, keep Phase 0 | `git checkout -- .` |
| Full back-out to the session's start | `git reset --hard 8289beb` (loses this file and `docs/project-identity.md` — copy both out first) |
| Keep everything, rule later | leave as is; the red test is the marker |

Rebuild `dist/` after any of these if you rely on it.

**If backing out to `8289beb`:** the build will be broken again (§3.1)
and the chunk-C review remains owed. §4.2/§4.3/§4.6/§4.8's C#1 fix are
the items most worth re-applying regardless of what else is decided.

---

## 9. Related treecontext nodes

`7e74a334` defect · `60432cf2` owner ruling (all phases) · `d4b09dc7`
RC sequence · `1ddad164` owner ruling (no schedule pressure, corpus and
unit scope) · `1cb3808e` Phase 0 review applied · `81bd99e6`
fingerprint defect · `a4be55ed` process failure · `5babf1dd` adversarial
review of the design.
