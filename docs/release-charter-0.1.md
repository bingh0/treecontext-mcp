# 0.1 Release Charter

**Status: RATIFIED 2026-08-12** at the visionary cold-read. Drafted
2026-08-11 from project memory and repo state (main @ 53a8c83); cold-read
corrections applied as the dated edits in-line, including four items
pulled from §3 into §2 scope. From here, 0.1-readiness is this checklist
and changes require dated amendments under the sanctioned-change
protocol.

This charter exists to stop the goal posts moving. The 0.0.x line was a
ground-up refactor of an existing tool, which reset the
feature-complete axis while the quality bar kept rising — so "how close
is 0.1" was re-derived from feel each session. From ratification
onward, 0.1-readiness is the checklist below and nothing else. Changes
to this charter follow the sanctioned-change protocol: dated amendments,
never silent edits.

## The standard (the visionary's own, restated)

0.1 marks the end of the closed beta: **all MVP features complete**,
**good feature-file/scenario coverage**, **unit tests**, **passes the
linter**, and **modest private beta testing** completed.

## 1. MVP surface inventory — what 0.1 IS

Every charter surface below exists, is spec'd by a feature corpus, and
is bound except where §2 says otherwise. This list is closed: new
surfaces are post-0.1 unless this charter is amended.

| Surface | Corpus | State |
|---|---|---|
| Auto-capture (hooks: prompts, tool events, stop) | journal-capture, hooks/* (18 sc.) | bound |
| Recall / search (lexical, role weights, temporal, windows) | journal-recall, journal-search-modes, flat-store-* (68 sc.) | bound exc. §2 |
| Agent surface (MCP tools, instructions, resume pointers) | journal-agent-surface, docs/resume-pointer-lifecycle.md | bound exc. §2 |
| Namespaces & policy | journal-namespaces, journal-policy | bound exc. §2 |
| Storage, retention valve, eviction-with-archive | journal-storage, retention-demotion, fts-dual-cap, content-codec | bound exc. §2 (durability) |
| Sidecar (blob offload) | journal-sidecar (15 sc.) | bound |
| Media references | journal-media (9 sc.) | bound |
| Install / uninstall / doctor | journal-install, ingestion-fidelity, doctor tests | bound |
| Migrations + pre-migration backups + verdicts + sweep | backup-{lifecycle,sweep,visibility} (31 sc.), design/verdict-record.md | bound |
| Stores CLI (list / rm / prune / sweep) | backup corpus + cli-stores tests | bound |
| Library embedding | journal-library (8 sc.) | bound |
| Platform support: Linux, macOS, Windows (Claude Code) | CI matrix + capture-platform-guard | done (needs CI lane, §3) |

Corpus snapshot (updated at the 2026-08-12 cold-read): 26 feature
files, 256 scenarios, 254 bound, 2 registered WIP (the dense pair, each
with a written ruling); 1229 unit/binding tests passing, lint at zero
warnings.

## 2. The gap — work remaining INSIDE 0.1 scope

The 12 WIP-registered scenarios, dispositioned:

**Durability — COMPLETE 2026-08-12 (6 of 6).** A memory tool's one
non-negotiable is not losing the journal:
1. ~~`a store that cannot get under budget says so`~~ — bound 2026-08-12
2. ~~`a crash mid-write never corrupts the store`~~ — bound 2026-08-12
   (real SIGKILLed writer process)
3. ~~`concurrent sessions do not corrupt each other`~~ — bound
   2026-08-12 (real second process; lock primitive exercised on disk)
4. ~~`frequently relied-on history evicts last`~~ — built and bound
   2026-08-12 (export-reliance ordering per the 2026-07-23 ruling)

(Previously bound: `schema changes never eat a store`, `a poison event
cannot wedge ingestion`. journal-storage has left the WIP register —
fully bound.)

**Small binds — COMPLETE 2026-08-12 (all bound; every feature except
journal-search-modes has left the WIP register):**
5. ~~journal-capture: `every capture carries the session that produced
   it`~~ — bound (real hooks + explicit ccSessionId + window COALESCE)
6. ~~journal-namespaces: `auto-capture lands in the namespace of the
   session that produced it`~~ — bound (the "per-namespace spin" was one
   option on the world's store open)
7. ~~journal-namespaces: `merged provenance is filterable and
   weightable`~~ — bound against the server with a baseline reorder
8. ~~journal-recall: slow-search hint probe~~ — bound (injected timings)
9. ~~journal-recall: index-cap knob~~ — bound through the real hook
   route, floor rejection included
10. ~~journal-agent-surface: `installing the AGENTS.md block twice
    yields one block`~~ — bound, CLI-driven
11. journal-agent-surface: `tool schemas describe only what the backend
    does` — was ALREADY bound (2026-07-26); this charter's draft
    over-counted it. Corrected 2026-08-12.

**Excluded from 0.1 — RATIFIED by ruling 2026-08-11 (two scenarios, one
class):**
12. journal-search-modes: `dense fusion is an explicit opt-in that
    fuses, never replaces` AND `a present embedding model changes
    nothing until asked` — both unbindable until a dense backend exists
    (the old binding was vacuous; adversarial review 2026-07-31 F3).
    Dense search is a post-0.1 feature; both scenarios stay WIP with
    this ruling as their reason. (The draft listed one; they are the
    same register entry and the same rationale. Corrected 2026-08-12.)

**Rulings that must land before 0.1:**
- ~~Unvalidated `--store`~~ — **RULED 2026-08-11: refuse at creation
  only**; implemented in the 0.0.16 line (see the fence amendment).

**Hygiene:**
- ~~The one lint warning~~ — fixed 2026-08-12; lint is at zero warnings.

**Pulled in at the cold-read (2026-08-12) — the visionary moved four
items from §3 into 0.1 scope. ALL FOUR COMPLETE the same day:**
- ~~**Doctor Windows hook-runnability check**~~ — DONE: hookScriptIssue()
  grades wrapper bodies per dialect; the pre-0.0.15 pinned-only .cmd
  (the shape that shipped 0.0.13/14 silently) and a vanished pinned
  interpreter are both flagged, tested on every lane.
- ~~**Delete the 5 archived-build agent configs**~~ — DONE: windsurf,
  antigravity, jetbrains, qwen, openclaw removed with a tombstone
  comment and a ratchet test naming the live six.
- ~~**Sidecar 30s drain timeout**~~ — RESOLVED by written justification
  (the "justify" arm): the value is vitest's default test budget on the
  sidecar-shutdown scenario, not a product constant; the one blowout was
  the Windows lane's first-ever execution, green ever since at ~150ms of
  phases. The dated ruling lives on the scenario's instrumentation
  comment, which remains the standing mitigation.
- ~~**`stores list` backup-size split + shell labeling**~~ — DONE,
  spec-first: stores-list.feature (2 scenarios, bound) pins the split
  SIZE/BACKUPS columns and the 'shell' label; doctor stays the
  authoritative disk-debt surface.

**Amendment 2026-08-12 (second): the pre-RC corpus audit and its
rulings.** A four-angle coverage audit of the corpus-as-spec found four
product defects, one configuration-dishonest binding, ~10 stale prose
spots, ~15 contract-worthy scenario gaps, and a ring of shipped
surfaces with no spec state at all. The visionary ruled: (1) the HTTP
transport is TOMBSTONED for 0.1 — both original consumers left with the
tree era, the library never needed it, and the transport was provably
unused (its options were dropped at the startServer call and nobody
ever noticed); (2) staging-side NAMESPACE ATTRIBUTION is BUILT for 0.1
(migration 020) — the capture-isolation scenario was passing only in a
configuration the corpus forbids; (3) scope is THE FULL AUDIT — all
defects, all staleness, all top scenario gaps, and new corpora for the
unspecced ring (bindings, config, telemetry, shielding, dump-logs,
dispatcher, backup CLI). §1 grows accordingly as those corpora land;
the RC waits for this program.

**Amendment 2026-08-12 (third): the store becomes the arbiter — the
database's final shape ships in 0.1.** After program C shipped the
lockfile model (per-namespace tool locks, a drain-owner lock) and
survived its adversarial review, a best-practices comparison against
client-server databases surfaced that the grown-up direction is the
opposite of more locks: invariants enforced IN the store, where every
consumer inherits them. The visionary ruled the lockfile-centric model
"a technical oversight on my part" — deliberately shipping a
coordination model that won't last is not worth it — and mandated that
0.1 ship, to the best of our knowledge, the FINAL SHAPE of the
database. Program G, executed before E so E's scenarios bind against
the final mechanism:

1. **Dedup moves into the store.** A stored fingerprint column; a
   unique index enforces curated (global) dedup via ON CONFLICT; the
   windowed auto-capture class (a constraint cannot express a sliding
   window) uses a BEGIN IMMEDIATE check-then-insert against a
   dedup-anchor structure. The in-memory fingerprint maps retire, and
   with them the warm-scan stall and the stale-map hazard class.
2. **The drain becomes claim-based.** Staging gains claim columns;
   batches are claimed atomically (UPDATE … RETURNING); a second drain
   is safe by construction rather than excluded by a lockfile.
3. **Roles coordinate through a lease table** (transactional
   heartbeats) instead of lockfiles; lockfiles are demoted to
   politeness or removed; doctor reports role holders with a SELECT.
4. **The final-shape pass**: every structural datum living in
   metadata_json receives an explicit column-vs-metadata ruling in the
   design note (the session-key COALESCE, _relied_count, the boundary
   keys, merge provenance) so no further reshape hides in 0.x.

Accepted and recorded: SQLite's serialized-writes ceiling (the
workload is capture-shaped, not OLTP-shaped), local-filesystem-only
WAL, and the churn cost of re-hardening territory program C hardened
days earlier. Behavioral scenarios for dedup and capture isolation
must pass UNCHANGED — the enforcement moves; the promises do not.
Ruling recorded in project memory (node c48ada70); design note in
tests/server/design/ precedes any code, per the C precedent.

**Ratified builder decisions (2026-08-12 cold-read):**
- Fetches of a CURRENT resume pointer never count as reliance — the
  session-start protocol mandates them, and a mandated fetch is ritual,
  not reliance. A superseded pointer's fetches count like any row's.
- Reliance recording is a full-policy privilege: read_only and
  contributor servers' exports record nothing.
- The dense exclusion (§2 item 12) covers both scenarios of the pair.

## 3. Explicitly deferred past 0.1

Named so deferral is a decision, not drift. Each stays in the debt
register; none blocks 0.1. (Four items that stood here in the draft —
the doctor Windows hook check, the archived-build configs, the sidecar
timeout, and the `stores list` cosmetics — were PULLED INTO §2 at the
2026-08-12 cold-read.)

- **ccr integration** — explicitly hands-off by ruling.
- **Copilot capture** — ships in 0.1 as it is today: preview, opt-in by
  name (`--experimental-capture --agent`). Graduation to verified is
  post-0.1.
- **Dense search / dense fusion** — post-0.1 feature (see §2 item 12).
- **Post-MVP eviction refinement** (copying hot entries forward before
  archiving) — named in the 2026-07-23 ruling as the shape IF reordering
  proves too weak; not 0.1.

## 4. The frozen gate — what cutting v0.1 requires

All of the following, on the release commit, no overrides (per the
standing "finish known work before release" rule):

1. §2 checklist empty: 11 scenarios bound (or re-ruled by amendment),
   dense-fusion ruling recorded, `--store` ruled, lint at zero
   unregistered.
2. Full suite green; typecheck green; release-gate green (no
   whole-feature WIP without a written ruling — already enforced).
3. Mutation protocol run on seams touched since the last release; every
   mutation killed.
4. Adversarial build review of the release diff with all CONFIRMED
   correctness findings fixed (the three-pass pattern of 0.0.16 is the
   template; polish-class findings may be deferred by ruling).
5. CI green on ALL lanes — Linux, macOS, Windows, package jobs (the
   full-matrix dispatch/tag run; resolved 2026-08-11, see the workflow).
6. One full closed-beta cycle on a 0.1 release candidate with zero
   data-loss-class reports and a verified migration from the oldest
   supported store version.
7. README and CHANGELOG accurate for every §1 surface.

## 5. Distance snapshot (2026-08-12 cold-read, main @ 3473fbe)

- Coverage / unit tests / linter: **at the bar and beyond** — zero lint
  warnings, 1229 tests, every bindable scenario bound, ratcheted.
- Private beta: 0.0.12→0.0.16 cycles shipped; the mirror-CI pipeline
  runs green per push with the full matrix on tags/dispatch.
- MVP completeness: §2 emptied 2026-08-12 morning, then REOPENED by the
  corpus audit's second amendment the same day: the audit program
  (defect fixes, namespace attribution, staleness, scenario gaps, ring
  corpora) is the remaining §2 work.
- Then the §4 gate: cut the release candidate, run the closed-beta
  cycle with zero data-loss-class reports, verify the oldest-store
  migration, and tag v0.1.

## Ratification

- [x] Visionary cold-read complete 2026-08-12; corrections applied as
      dated edits (four §3 items pulled into §2; snapshot refreshed)
- [x] Dispositions in §2/§3 confirmed; three builder decisions ratified
      (ritual exclusion, full-policy-only reliance, dense pair)
- [x] **Charter RATIFIED 2026-08-12** — from this point, 0.1-readiness
      is this checklist and amendments require the sanctioned-change
      protocol
