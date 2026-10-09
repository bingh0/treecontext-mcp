# Adversarial review of the 2026-08-16 identity session (Fable 5, 2026-08-20)

> Companion to `docs/handoff-2026-08-16-identity-session.md`. Durable
> copy of treecontext node `e8a913af41984656abdd0d00d083ba0e`. Reviews
> everything the halted Opus session did (`fcd87b5`, `4d7e301`,
> `4c84d83`, the uncommitted lease work) and proposed
> (`docs/project-identity.md`), through the lens of the pre-RC identity
> program. Nothing in the tree was changed by this review.

## 1. Verdict

**Keep everything. No back-out recipe should run.** Every factual
claim in the handoff was independently verified against the sources
and the live store:

| claim | verification |
| --- | --- |
| suite 1 failed / 1671 passed / 2 todo, typecheck clean | re-run, exact match; the one red is the rung-order marker |
| fingerprint collisions 97 groups / 219 rows / 2.2% | re-measured: 98 groups / 222 rows on today's 10,323 nodes — reproduces, and grows with the store |
| `projectIdentity` mechanism, `bindings.ts:235` | matches |
| `mergeFromNamespace` does decode/FTS/anchors via shipped write path | matches (`flat-store.ts:1293`) |
| `importJson` already preserves source ids | matches (`flat-store.ts:1243`, `1261-1283`) |
| `serve` takes `ns:` lease; heartbeat is the liveness | matches (`cli.ts:1193`; renew timer heartbeats every held role) |
| ppid rung never fires on win32 | verbatim at `session-beacon.ts:143` |
| C#1 extension-direction hole and its fix | confirmed in diff and pins |

The two Phase-0 items classified **[B]** (allow-list wiring, sweep
wiring) completed constants and functions the *prior* session had
already defined with doc comments describing exactly that use. They
are closer to finishing in-flight work than to fresh unasked
decisions. The loss of confidence was process-justified — §4.7's spec
edit and §4.9's constant deletion were real authority violations, and
the handoff says so itself — but the artifacts survive adversarial
review. The documentation is trustworthy.

## 2. New findings (not in the handoff)

### F1 — BLOCKING, design §3.1: the A3 fix is unimplementable as written

`Bindings.projects` is `Record<fingerprint, {store, updatedAt,
source}>` (`bindings.ts:66`). The fingerprint is a one-way
`sha256(identity)[0:16]`; **no identity string or path is stored
anywhere in the file.** §3.1's corrected ambiguity check — "scan the
bindings file for every path-binding whose path lies at or under
`<root>` … a string prefix test per entry and needs no filesystem
access" — requires data the file does not contain. Worse, the 44
existing path bindings (the exposed population) can never be
backfilled from their hashes.

The design's own review called A3 "the finding that changed the
design"; the changed design cannot be built against the current
bindings format. Options, needing an owner/design decision before
Phase 1:

- **(a)** record the identity string in each binding going forward
  (additive field), and cover legacy bindings with a bounded
  filesystem enumeration (fingerprint `path:<dir>` for candidate
  directories under `<root>`, e.g. bounded by depth or project
  markers, skipping `node_modules` etc.);
- **(b)** auto-adopt only when the bound predecessor's directory *is*
  the successor root (trigger 1, and trigger 2 where `cwd` is the
  bound subdir itself); for any strict-subdirectory predecessor, fail
  closed and *disclose* ("a predecessor journal exists at packages/a;
  run doctor / stores merge to reunite") instead of adopting;
- **(c)** doctor-driven interactive backfill of identities, then (a).

(b) preserves R4 with zero schema change and costs only
auto-succession in the monorepo case — which is precisely the case A3
proved unsafe to automate.

### F2 — HIGH, design §3.2: the URL probe misses the most common predecessor form

The probe must hit the **raw** form the predecessor was bound under
(its fingerprint hashes the raw URL). §3.2 emits only two spellings of
the normalized `host/org/repo` triple — so
`https://host/org/repo.git`, the canonical GitHub clone URL, is not
among the probed forms and trigger-3 succession misses it. Emit the
cross-product: {`https://`, scp-style `git@host:`, `ssh://git@host/`}
× {`.git`, plain} (× trailing slash).

Also: §1.1 lists "repo rename, org move" under trigger 3, but
normalization cannot cover renames — a residual beyond A11 that is
currently undisclosed. The detector's output should name it.

### F3 — HIGH, design §5: the merge is single-namespace; stores are not

`mergeFromNamespace` reads `WHERE t.namespace = ? AND
ensemble_index = 0` — one namespace. After chunk C a store is
namespace-capable, and the five split predecessors may hold multiple
trees. "Generalize the row-reader" as written would copy one
namespace and **silently drop agent-lane trees** — the exact silent
data-loss class this program exists to kill. `stores merge` must
iterate the source's namespaces into same-named destination
namespaces (creating them as needed), and disclose per-namespace
counts. Absent from §5 and §6.

### F4 — MEDIUM, code (`4c84d83`): the legacy seed's src-gate is too narrow

The seed reads `_cc_session_candidates` only when `src === 'echo'`.
But the old code's dedup-echo branch accrued candidates **without
changing `src`** — a row attributed `beacon-unanimous` at insert and
then touched by a causal dedup echo carries echo-derived candidates
under `src: 'beacon-unanimous'`. Such a row still drops a disclosed
candidate on its next in-window echo — the same bug the fix claims to
close. Live exposure ≈ zero (v2 is unpushed, the window is 60 s), but
the ruling is "fix the class": gate on `src !== 'beacon-ambiguous'`
instead, and pin it.

### F5 — LOW, code: the store_path terminator is loose

`extractStatusNamespace` accepts `\` after the once-escaped match
without requiring the following `"`. A foreign path that continues
with a literal backslash character passes the guard. Exact form:
once-match must be followed by `"`; twice-match by `\"`. Contrived on
POSIX; cheap to make exact.

### F6 — LOW, hardening: STATUS_NS_RE safety depends on field order

The regex takes the *first* `namespace":"…` in the Output section.
That is safe today only because the status response serializes its
real `namespace` field before `resume_pointers` — whose previews are
journal content and can contain spoof-shaped text
(`namespace\":\"evil`). Pin it with a spoofed-preview test so a
future field reorder cannot silently open content injection.

### F7 — QUESTION, `4d7e301` [B]: excluding `outside-window` discards valid evidence

An out-of-window dedup echo still proves this session's insert call
touched this store's tree — the code comment the allow-list replaced
said exactly that, with design reasoning. Excluding it is fail-closed
and costs only slower rung-2 priming (no misroute risk), so keeping
the allow-list is fine — but this is a design-vs-review judgment that
deserves one explicit owner sentence, same class as §5.1.

### F8 — tests, uncommitted: corroboration scenarios go vacuous under session-first

If the rung ruling restores session-first, "an annotation whose
server stopped heartbeating is not honored" passes **vacuously** (the
session rung answers regardless). Rung 1 needs an isolated pin:
expired heartbeat + *no* session annotation → resolves null.

## 3. The rung order — recommendation: restore the ratified session-first

**New decisive argument, absent from both sides of the dispute:**
under pid-first, the multi-lane shape §7.8 was *built for* breaks
structurally. Two servers over one store under one claude pid write
the **same** `pid-<claudePid>.ns.json` (last writer wins), and each
holds its own live `ns:` lease — so rung 1 answers with whichever
server started last, *corroborated*, and preempts the session's
causal evidence **indefinitely**. C#2's mid-session-relaunch scenario
is rare and **self-heals** at the session's next status/insert echo
(bounded staleness). Pid-first trades a bounded, self-healing
staleness for an unbounded structural misroute in the designed-for
case — on every platform, on top of the Windows divergence already
recorded.

Note also that C#2 was not new information: §7.8's ratified text
already acknowledges the pid rung is "instant from server startup …
while the session rung needs one echo to prime" and ranked causality
first anyway. The inversion re-litigated a settled trade-off on the
strength of one scenario.

Lease corroboration stays **regardless of the ruling** — it is
orthogonal to rung order and fixes the pid-recycle hole `4c84d83`
deferred. Green-up when ruled: swap the two blocks in
`resolveHookNamespace`, revert the `hooks/shared.ts` comment and
`CHANGELOG.md:56` per the caveat `4c84d83` recorded for exactly this
outcome, restructure the scenarios per F8, and record C#2's residual
(relaunch staleness until the next echo) as a disclosed limitation.

## 4. Dispositions proposed (owner to confirm)

| item | disposition |
| --- | --- |
| `fcd87b5` design note | **keep**; revise §3.1 / §3.2 / §5 per F1–F3 before Phase 1 (paper-first, which 232b4219 requires anyway) |
| `4d7e301` Phase 0 | **keep**; F7 needs one owner sentence |
| `4c84d83` review findings | **keep**; add F4/F5/F6 pins at Phase 0 close |
| uncommitted lease work | **keep**; explicitly ratify the `NS_ANNOTATION_STALE_MS` deletion (technically right — heartbeat expiry is strictly tighter than a 24 h bound that was wrong in both directions); commit together with the rung-order restoration once ruled |
| red test | resolves via the §3 ruling, not by edit |
| fingerprint recommendation (§9.2) | verified sound: equal normalized content ⟺ equal new key, so a sha256 key is a strict refinement — groups only ever split; stale anchors self-heal in 300 s |
| Phase sequence 0–5 | stands; Phase 1 gains a small preceding design amendment (F1/F2), Phase 4's design gains F3 |
